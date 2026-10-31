# API em `api.condenexo.com.br` (front em `www.condenexo.com.br`)

O front saiu da Vercel e agora é servido pela Cloudflare em `https://www.condenexo.com.br`. O proxy `/api` era um
rewrite da Vercel e deixou de existir, então o front passa a chamar a API direto em `https://api.condenexo.com.br`
(variável de build `VITE_API_URL=https://api.condenexo.com.br/api/v1`, e o `connect-src` do CSP em
`public/_headers` do CondeNexo.Front já lista esse host).

`www.` e `api.` são o **mesmo site** (`condenexo.com.br`), mas **origens diferentes**. Consequências:

- os cookies `SameSite=Strict` continuam indo nas chamadas `fetch`/XHR com `credentials` (é uma requisição same-site);
- os cookies são host-only (sem `Domain`): ficam presos a `api.condenexo.com.br`, o front nunca os vê;
- o navegador só entrega a resposta ao front se a API mandar `Access-Control-Allow-Origin` com a origem **exata** do
  front e `Access-Control-Allow-Credentials: true`. Isso é o `CORS_ORIGENS` (validado em `src/config/config.ts`:
  origem exata, sem curinga, sem barra) e o `enableCors` de `src/configurar-app.ts`, que também expõe `Retry-After`
  (o front lê no 429) e `Content-Disposition` (nome do anexo baixado) e guarda o preflight por 10 min (`Max-Age: 600`).

Tudo abaixo é para o dono executar. Nada aqui foi aplicado na VPS nem na Cloudflare. Os comandos seguem o padrão de
`docs/deploy.md` §5.1 (nginx no host, API em `127.0.0.1:3100`). Proxy em container: mesma configuração, com o upstream
da §5.4 no lugar de `127.0.0.1:3100`.

## Pré-requisito no repositório: `docker-compose.prod.yml`

Hoje o compose de produção **fixa** `CORS_ORIGENS: ""` no serviço `api`. Com isso, o valor do `.env` é ignorado e a API
sobe com CORS desligado, e o front quebra com erro de CORS mesmo com tudo certo na VPS. Antes da troca, esse trecho
precisa virar (commit na `main`; o deploy automático recusa mudança de compose, então vai à mão como em
`docs/deploy.md` §11):

```yaml
      # Front em https://www.condenexo.com.br chama a API em https://api.condenexo.com.br: CORS com credenciais para a
      # origem exata do front (docs/deploy-subdominio-api.md).
      CORS_ORIGENS: ${CORS_ORIGENS:?defina CORS_ORIGENS no .env (https://www.condenexo.com.br)}
      # Saltos de proxy confiáveis: 1 = só o nginx da VPS (docs/deploy-subdominio-api.md).
      TRUST_PROXY: ${TRUST_PROXY:?defina TRUST_PROXY no .env (1 com o nginx da VPS na frente)}
```

## 1. DNS na Cloudflare

Na zona `condenexo.com.br`:

| Tipo | Nome | Conteúdo | Proxy |
|---|---|---|---|
| `A` | `api` | `179.197.78.78` | **DNS only** (nuvem cinza) |

DNS only é obrigatório nesta configuração: com o proxy laranja, a Cloudflare vira um salto a mais (o `TRUST_PROXY` e os
limites do nginx abaixo ficariam errados) e o desafio HTTP do certbot passaria por ela. Se um dia ligar o proxy, é outra
topologia (ver `docs/deploy.md` §4) e este documento não vale.

Se a zona tiver registro `CAA`, ele precisa permitir `letsencrypt.org`, senão a emissão falha.

Conferir antes de seguir (tem que voltar o IP da VPS, não um IP da Cloudflare):

```bash
dig +short api.condenexo.com.br A        # 179.197.78.78
```

## 2. nginx

Arquivo novo, separado do site do sslip.io: `/etc/nginx/sites-available/condenexo-api` (link em `sites-enabled`).

Duas diferenças em relação à §5.1, e as duas importam:

- **Preflight fora do limite de taxa.** A chave do `limit_req` passa por um `map` que zera para `OPTIONS`; o nginx não
  conta requisição com chave vazia. Sem isso, cada chamada do front gasta duas fichas do balde e o preflight do login
  bate no `tcc_login` (30/min) junto com as tentativas reais. O preflight também não pode passar por `auth_basic` nem
  nada parecido: ele nunca leva cookie nem credencial.
- **O nginx não mexe em CORS.** Nenhum `add_header Access-Control-*`, nenhum `if ($request_method = OPTIONS) { return 204; }`.
  A API responde o preflight e põe os cabeçalhos; se o nginx também puser, o navegador vê `Access-Control-Allow-Origin`
  duplicado e recusa a resposta.

Zonas com nomes novos (`tcc_apisub_*`) para não colidir com as do arquivo da §5.1.

```nginx
# /etc/nginx/sites-available/condenexo-api  (ln -s em sites-enabled; `nginx -t` antes de `systemctl reload nginx`)
# Chave dos limites = IP da CONEXÃO, vazia no preflight (OPTIONS): o nginx não limita requisição com chave vazia.
map $request_method $tcc_apisub_chave {
    OPTIONS "";
    default $binary_remote_addr;
}
limit_req_zone $tcc_apisub_chave zone=tcc_apisub_login:10m rate=30r/m;
limit_req_zone $tcc_apisub_chave zone=tcc_apisub_plat_login:10m rate=10r/m;
limit_req_zone $tcc_apisub_chave zone=tcc_apisub_api:10m rate=20r/s;

server {
    listen 80;
    server_name api.condenexo.com.br;
    server_tokens off;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name api.condenexo.com.br;
    server_tokens off;

    ssl_certificate     /etc/letsencrypt/live/api.condenexo.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.condenexo.com.br/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 6m;
    limit_req_status 429;

    # Sem proxy na frente (DNS only): o XFF que chega é do cliente e não vale nada. O nginx SUBSTITUI pelo IP da
    # conexão, e a API (TRUST_PROXY=1) usa exatamente esse valor. NÃO pôr add_header Access-Control-* aqui.

    # Login do condomínio: 30/min por IP, rajada de 10. Regex sem diferenciar maiúsculas: o Express casa a rota sem
    # diferenciar, e um `location =` deixaria /API/V1/AUTH/LOGIN sem limite (docs/deploy.md §18.4).
    location ~* ^/api/v1/auth/login/?$ {
        limit_req zone=tcc_apisub_login burst=10 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Login do Master: 10/min por IP, rajada de 5.
    location ~* ^/api/v1/plataforma/auth/login/?$ {
        limit_req zone=tcc_apisub_plat_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Criação de condomínio pela tela: CREATE DATABASE + migrações (o cliente espera até 150 s).
    location ~* ^/api/v1/plataforma/condominios/?$ {
        limit_req zone=tcc_apisub_api burst=10 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 150s;
    }

    location /api/ {
        limit_req zone=tcc_apisub_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location / { return 404; }
}
```

Um 429 gerado **pelo nginx** sai sem cabeçalhos de CORS, então no navegador ele aparece como erro de rede, não como
429 legível. É aceito: o nginx é a rede de segurança grossa; o 429 que o front trata (com `Retry-After`) é o da API.

Os baldes deste arquivo são separados dos do site do sslip.io. Quem usa os dois hosts ganha o dobro de fichas no nginx
(o limite de login da aplicação, que é por banco, não muda). Depois do checklist da seção 6 passar, nada legítimo usa
mais o sslip.io: troque o `location /api/` de lá por `return 404;` (ou remova o site) para fechar essa porta.

## 3. Certificado

Igual à §5.1, em três passos, porque o `nginx -t` falha enquanto o bloco 443 aponta para um certificado que não existe:

```bash
# (1) só o bloco 80 habilitado (comente o server 443 no arquivo acima)
mkdir -p /var/www/certbot
nginx -t && systemctl reload nginx

# (2) staging primeiro (não gasta o limite do Let's Encrypt), depois o real
certbot certonly --webroot -w /var/www/certbot -d api.condenexo.com.br --test-cert
certbot certonly --webroot -w /var/www/certbot -d api.condenexo.com.br --force-renewal

# (3) descomente o bloco 443
nginx -t && systemctl reload nginx

# renovação automática
systemctl list-timers | grep certbot
certbot renew --dry-run
```

O `--force-renewal` do segundo comando troca o certificado de staging pelo de produção. Domínio próprio não tem o
problema de limite compartilhado do sslip.io (§5 de `docs/deploy.md`), mas o limite de 5 duplicados por semana vale:
não deixe em laço.

## 4. Ambiente da API

No `.env` da VPS (com o compose já ajustado, ver o pré-requisito):

```bash
CORS_ORIGENS=https://www.condenexo.com.br
TRUST_PROXY=1
```

Depois: `docker compose up -d --wait` (recria só a `api`).

`CORS_ORIGENS` é a origem exata do front, sem barra no fim. Não acrescente `https://condenexo.com.br` nem outro
subdomínio "por garantia": cada origem listada lê as respostas autenticadas. Se o apex servir o front também, o certo é
o apex redirecionar para `www.`, não entrar na lista.

### Por que `TRUST_PROXY=1`

A API faz `app.set('trust proxy', config.trustProxy)` (`src/configurar-app.ts:23`), e `TRUST_PROXY` só aceita `false`
ou 1 a 3 (`src/config/config.ts:265-269`). Com o número N, o Express pula N saltos a partir da conexão e `req.ip` vira
esse item do `X-Forwarded-For`. É esse `req.ip` que entra no limite de login por IP e por par login+IP
(`src/auth/limite-login.service.ts`, spec §5.1 e §14 nº 27), no IP gravado na sessão e na trilha.

O caminho agora é navegador → nginx da VPS → API: **um** salto. O nginx põe o IP da conexão no XFF; a API, com 1,
confia só nele, e o IP passa a ser o real do cliente. Isso também fecha o custo aceito na spec §14 nº 26 (atrás da
Vercel, quem chamava a VPS direto escolhia o próprio IP): sem salto intermediário, ninguém escolhe.

O valor antigo, 2, ficou **perigoso** agora: a API pularia o nginx e leria o item que o cliente escreveu. Com o
`$proxy_add_x_forwarded_for` da §5.1, quem manda `X-Forwarded-For: 1.2.3.4` aparece como `1.2.3.4`, e trocando o valor
a cada tentativa ganha 10 palpites novos por login a cada pedido, sem nunca bater no bloqueio por IP. `false` também
está errado: todo mundo apareceria com o IP do gateway da bridge do Docker e 30 falhas de qualquer um bloqueariam o
login de todos.

Com `TRUST_PROXY=1` o site antigo do sslip.io (que acrescenta ao XFF) também fica correto: o último item é o IP da
conexão.

## 5. Ordem da troca

1. Compose ajustado na `main` e puxado na VPS (pré-requisito).
2. DNS (seção 1), conferido com `dig`.
3. nginx bloco 80, certificado, bloco 443 (seções 2 e 3).
4. `.env` e `docker compose up -d --wait` (seção 4).
5. Checklist (seção 6) com `curl`.
6. Build do front na Cloudflare com `VITE_API_URL=https://api.condenexo.com.br/api/v1` (repositório CondeNexo.Front) e
   login pelo navegador.

Os passos 2 a 5 não quebram nada que funcione hoje: o front já está quebrado e o sslip.io continua igual.

## 6. Checklist de verificação

```bash
API=https://api.condenexo.com.br/api/v1
FRONT=https://www.condenexo.com.br

# TLS real (sem -k), emitido para api.condenexo.com.br, não o de staging
curl -sv "$API/saude" 2>&1 | grep -E 'subject|issuer|expire|"status"'

# Redirect 80 -> 443
curl -sI http://api.condenexo.com.br/api/v1/saude | grep -iE '^HTTP|^location'

# Preflight com a origem do front: 204, ACAO exato UMA vez, credenciais, métodos, cabeçalhos, Max-Age
curl -si -X OPTIONS "$API/auth/login" \
  -H "Origin: $FRONT" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-condominio' | grep -iE '^HTTP|^access-control|^vary'
#   HTTP/2 204
#   access-control-allow-origin: https://www.condenexo.com.br
#   access-control-allow-credentials: true
#   access-control-allow-methods: GET,POST,PATCH
#   access-control-allow-headers: Content-Type,X-Condominio
#   access-control-max-age: 600
#   vary: Origin, ...

# Cabeçalho duplicado = nginx pondo CORS por conta própria. Tem que dar 1.
curl -si -X OPTIONS "$API/auth/login" -H "Origin: $FRONT" -H 'Access-Control-Request-Method: POST' \
  | grep -ic '^access-control-allow-origin'

# Origem estranha: SEM access-control-allow-origin
curl -si -X OPTIONS "$API/auth/login" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' \
  | grep -i '^access-control-allow-origin' || echo 'ok: sem ACAO'

# Preflight não entra no limite do nginx: 60 seguidos ao login, todos 204 (nenhum 429). Não é tentativa de login.
for i in $(seq 1 60); do
  curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$API/auth/login" -H "Origin: $FRONT" -H 'Access-Control-Request-Method: POST'
done | sort | uniq -c

# Resposta comum: ACAO, Retry-After e Content-Disposition expostos, no-store, nosniff, HSTS
curl -si "$API/saude" -H "Origin: $FRONT" \
  | grep -iE '^access-control|^cache-control|^x-content-type|^strict-transport|^x-powered-by|^server'
#   sem x-powered-by; server sem versão (server_tokens off)
```

Login (uma vez, com um usuário real; a senha vem do teclado, não fica no histórico do shell):

```bash
read -r -p 'login: ' L; read -r -s -p 'senha: ' S; echo
printf '{"login":"%s","senha":"%s"}' "$L" "$S" | curl -si -X POST "$API/auth/login" \
  -H "Origin: $FRONT" -H 'Content-Type: application/json' -H 'X-Condominio: <código do condomínio>' --data-binary @- \
  | grep -iE '^HTTP|^set-cookie|^access-control-allow-origin'
unset S
#   HTTP/2 200
#   set-cookie: __Host-portaria_sessao=...; Path=/; HttpOnly; Secure; SameSite=Strict   (sem Domain)
#   access-control-allow-origin: https://www.condenexo.com.br
```

Não teste o bloqueio (429) contra a produção.

No navegador, em `https://www.condenexo.com.br`:

- [ ] login funciona e a tela carrega dados (DevTools → Network: chamadas a `api.condenexo.com.br`, um `OPTIONS` antes
      dos POST/PATCH com JSON, e por 10 min as seguintes ao mesmo endereço sem novo preflight);
- [ ] DevTools → Application → Cookies → `https://api.condenexo.com.br`: `__Host-portaria_sessao` com Secure, HttpOnly,
      `SameSite=Strict`, `Path=/`, sem `Domain`. No `/admin`, `__Secure-portaria_plataforma` com
      `Path=/api/v1/plataforma`;
- [ ] download de anexo de ocorrência sai com o nome certo (é o `Content-Disposition` exposto);
- [ ] **IP real:** compare o IP da sessão nova com o seu (`curl -s https://api.ipify.org`), como no item "IP real" de
      `docs/deploy.md` §10. `172.x`/`127.0.0.1` = `TRUST_PROXY` ou XFF errado. Repita pelo 4G.
- [ ] sem erro de CORS no console.

Por fim, o `location /api/` do site sslip.io vira `return 404;` (seção 2).

## 7. Rollback

Não há para onde voltar no front (a Vercel saiu), então rollback aqui é desfazer a peça que deu problema:

- **CORS errado / API recusando a origem:** corrija `CORS_ORIGENS` no `.env` e `docker compose up -d --wait`. Para
  desligar o CORS de vez, `CORS_ORIGENS=` vazio (o front para de funcionar, mas nada fica exposto).
- **nginx:** `rm /etc/nginx/sites-enabled/condenexo-api && nginx -t && systemctl reload nginx`. O site do sslip.io não
  foi tocado (só se você já fez o último passo do checklist; aí desfaça esse `return 404`).
- **DNS:** apagar o registro `api` na Cloudflare.
- **`TRUST_PROXY`:** não volte para 2. Sem a Vercel, 2 deixa o IP forjável (seção 4). Se o IP gravado estiver errado,
  o problema é o XFF do nginx, não o número.
- **Código da API:** rollback normal (`docs/deploy.md` §11). Sem migração nesta mudança.

## Verificação de Origin

Fecha o CSRF same-site descrito em "Riscos aceitos" abaixo. Duas peças, com as mesmas regras:

- **Escritas** (todo método fora de `GET`, `HEAD` e `OPTIONS`): middleware Express (`src/comum/origem.ts`, registrado em
  `src/configurar-app.ts` depois do CORS e antes de guard e rota).
- **Leituras** (`GET`/`HEAD`) de toda rota que não é `@Publico()`: guarda global estática (`src/comum/origem.guard.ts`),
  que roda antes da sessão e de qualquer gravação. Motivo: leitura auditada grava trilha (`documento.ler`,
  `lgpd.exportar`, `plataforma.ler`/`plataforma.exportar` do Master), e um `<img>` ou link num subdomínio do mesmo
  site levaria o cookie. `/saude` e o selo público (`@Publico()`) não passam por ela. `OPTIONS` (preflight) nunca é
  verificado.

Regras:

- `Origin` presente e `CORS_ORIGENS` definido: passa só a origem **exata** da lista. Outro subdomínio, apex, `http://`,
  sufixo (`www.condenexo.com.br.evil.com`), barra final, maiúsculas e `null` são recusados.
- `Origin` presente e `CORS_ORIGENS` vazio (só dev/e2e, mesma origem pelo proxy do Vite): passa se o host:porta da
  Origin for igual ao cabeçalho `Host` (o bruto; `X-Forwarded-Host` é ignorado).
- `Origin` ausente: passa (curl, integração, URL digitada, `Sec-Fetch-Site: none` ou `same-origin`), exceto com
  `Sec-Fetch-Site: same-site` ou `cross-site` (navegador vindo de outra origem).

`CORS_ORIGENS` é obrigatória no boot com `PORTARIA_AMBIENTE=producao`: vazia, a API não sobe (`ErroConfig`).

Recusa: `403` no envelope padrão, `code` `ORIGEM_NAO_PERMITIDA`, `message` "Origem da requisição não permitida." (sem
listar as origens aceitas). Acontece antes do login e da sessão: não conta no limite de tentativas, não grava
`auth.login_falha`, `acesso.negado` nem linha de leitura na trilha; vai só ao log (`origem.recusada`). Além disso, corpo
`application/x-www-form-urlencoded` (o do `<form>` HTML) nas escritas dá `415 TIPO_NAO_SUPORTADO`: a API só aceita
JSON e `multipart/form-data` (anexos).

Efeito colateral: o front em dev com `API_PROXY_ALVO` apontando para a produção manda `Origin: http://localhost:5173`,
que não está em `CORS_ORIGENS`; os POST/PATCH (inclusive o login) passam a dar 403. É o comportamento certo.

Prova (não precisa de credencial: a recusa vem antes da senha ser lida):

```bash
API=https://api.condenexo.com.br/api/v1
# Origem indevida: 403 ORIGEM_NAO_PERMITIDA
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/login" -H 'Origin: https://blog.condenexo.com.br' \
  -H 'Content-Type: application/json' --data '{"login":"x","senha":"x"}'
#   403
# Origem do front: segue o fluxo normal (401 de credencial inválida), nunca 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/login" -H 'Origin: https://www.condenexo.com.br' \
  -H 'Content-Type: application/json' --data '{"login":"x","senha":"x"}'
#   401
```

O segundo curl é uma tentativa de login inválida de verdade: conta no limite do IP e grava `auth.login_falha`. Rode uma vez.

## Riscos aceitos

> Desde a "Verificação de Origin" acima, a requisição com cookie disparada de outro subdomínio (POST/PATCH de
> formulário, `<img>` ou link para leitura autenticada) é recusada com 403, e o corpo urlencoded com 415. O texto abaixo
> é o risco de antes; continua valendo para XSS em `www.` (que é a origem permitida) e como motivo para a higiene de DNS.

`SameSite=Strict` protege contra requisição vinda de **outro site**. Com front e API no mesmo site, qualquer
subdomínio de `condenexo.com.br` também é "mesmo site": uma página em `qualquercoisa.condenexo.com.br` faz o navegador
mandar o cookie da API junto. O CORS ainda impede essa página de **ler** a resposta (ela não está em `CORS_ORIGENS`),
mas não impede de **disparar** um POST de formulário ou um `fetch` sem preflight. Sem a verificação de Origin, corpo
`application/x-www-form-urlencoded` e `multipart/form-data` (anexos) passariam sem preflight. Na prática, XSS ou takeover de
subdomínio (um CNAME esquecido apontando para serviço desativado) em qualquer subdomínio viraria vetor de CSRF contra a API,
e XSS em `www.` lê tudo, como sempre leu.

Mitigação:

- não hospedar conteúdo de terceiros nem conteúdo enviado por usuário em subdomínios de `condenexo.com.br`
  (blog, status page, landing de ferramenta externa: domínio separado);
- revisar os registros DNS da zona de tempos em tempos e apagar os que apontam para serviço que não existe mais;
- manter o CSP do front (`public/_headers` do CondeNexo.Front) estrito: `script-src 'self'`, `connect-src` só com a
  própria origem e a API.
