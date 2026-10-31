# Deploy — CondNexo na VPS da Betech

> **Escrito no monorepo; hoje o front está em CondeNexo.Front.** Referências a `apps/web`, `apps/plataforma` e
> `@portaria/*` abaixo são históricas: esse código está no repositório CondeNexo.Front (ver seção 6) e o pacote de domínio
> vive em `src/dominio/` deste repositório. Comandos de front (`npm run dev -w ...`, build do admin, Root Directory) valem
> no Front, não aqui.

Runbook das fases 2 e 3. A fase 1 (este repositório) entregou só código e configuração, validados localmente. Nada
foi feito no servidor.

| Fase | O quê | Quem decide |
|---|---|---|
| 1 (feita) | Compose de produção, backup, âncora pelo GitHub Actions, `vercel.json`, este runbook | — |
| 2 | Inventário da VPS (só leitura), escolha do proxy, clone, `.env`, build, migrate, seed, TLS | responsável técnico + Betech |
| 3 | (histórico; hoje o front está na Cloudflare) Rewrite da Vercel ativo em `http`, âncora ligada, backup agendado, checklist | responsável técnico |

> **Topologia atual (2026-10-31).** O front saiu da Vercel: é um SPA estático na Cloudflare em
> `https://www.condenexo.com.br`, e o navegador chama a API direto em `https://api.condenexo.com.br/api/v1` (registro
> `A` "DNS only" para a VPS, nginx com TLS pelo certbot, CORS com credenciais, `TRUST_PROXY=1`). Não há proxy de `/api`.
> A migração, o nginx do `api.`, o checklist e o rollback estão em `docs/deploy-subdominio-api.md`, que vale sobre este
> documento onde os dois divergirem. O diagrama e os trechos de Vercel/rewrite abaixo são o **histórico** da fase 3, e o
> `179-197-78-78.sslip.io` fica só como transição até o checklist de `docs/deploy-subdominio-api.md` passar.

Topologia da fase 3 (histórica, com a Vercel):

```
navegador ──https──> tccgestaoacesso.vercel.app ──(rewrite /api/*)──https──> 179-197-78-78.sslip.io
                         (SPA estática)                                        proxy da VPS (nginx | Caddy | Traefik, TLS)
                                                                                   │ http, 127.0.0.1:3100
                                                                                   ▼
                                                    projeto compose "tcc-portaria": api (node, não-root) ── rede interna ── db (Postgres 17)
GitHub Actions (1x/dia) ──https──> /api/v1/auditoria/selos/publico ──> commit append-only no branch `ancoras`
```

A VPS também roda a produção do Tobe (porta 3333, clone em `/app/tobe-api`). Nada aqui mexe nele, exceto o bloco do
proxy, que é compartilhado. Esse ponto está sinalizado na seção 5.

---

## 1. Pré-requisitos

### 1.1 Autorização

- [ ] Betech autorizou o uso da VPS (já registrado) **e** o responsável pelo proxy/Tobe sabe da janela da fase 2.
- [ ] Acesso SSH com usuário próprio (não compartilhar a chave do Tobe), com `sudo` e no grupo `docker`.
- [ ] Repositório: o responsável tem permissão de admin em `ragrunge/condenexo` (ruleset e variável).
- [ ] Repositório **privado** desde 2026-10-30: a VPS busca o código por uma deploy key só de leitura (seção 2.1).

### 1.2 Inventário (fase 2, só leitura: nada de `restart`, `reload` ou edição)

```bash
uname -a; lsb_release -ds; free -h; df -h / /var/lib/docker
docker version --format '{{.Server.Version}}'; docker compose version
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker network ls; docker volume ls
sudo ss -ltnp                                   # quem escuta em 80/443, 3333, 5432 e se 3100 está livre
systemctl is-active nginx caddy traefik 2>/dev/null
sudo cat /etc/docker/daemon.json 2>/dev/null    # userland-proxy, log-driver, ipv6
sudo ufw status verbose 2>/dev/null; sudo iptables -S DOCKER-USER 2>/dev/null
command -v age git openssl
```

O que a fase 2 precisa responder com isso:

| Pergunta | Por quê |
|---|---|
| Qual processo ocupa 80/443: nginx/Caddy no host ou um container (Traefik/Caddy/nginx)? | Define o bloco da seção 5. Proxy em container **não alcança** `127.0.0.1:3100` do host (5.4) |
| Onde fica a config do proxy, e como o Tobe está declarado nela? | O bloco novo entra ao lado do Tobe, sem tocar no dele |
| Como o proxy trata `X-Forwarded-For` hoje? | (Histórico, topologia com Vercel) `TRUST_PROXY=2` só funcionava se o proxy **acrescentasse** ao XFF da Vercel; hoje é `TRUST_PROXY=1` (seção 4). Mudar isso pode afetar o Tobe |
| ACME: quem emite certificado hoje (certbot, Caddy, Traefik resolver)? | O certificado do `179-197-78-78.sslip.io` sai pelo mesmo mecanismo (seção 5, aviso do limite) |
| 3100 livre? Memória livre ≥ 1,5 GB? Disco ≥ 5 GB livres? | API 384 MiB + banco 512 MiB + build (pico ~1 GB, temporário) |
| Firewall da Hostinger sincronizado? | Só 22/80/443 precisam estar abertos. 3100 e 5432 **não** (e o compose nem os expõe fora do loopback) |
| `age` disponível? | Backup (seção 8): `sudo apt install age` |

---

## 2. Clone e `.env`

```bash
sudo mkdir -p /opt/tcc-portaria && sudo chown "$USER": /opt/tcc-portaria
git clone git@github-condnexo:ragrunge/condenexo.git /opt/tcc-portaria   # deploy key: seção 2.1
cd /opt/tcc-portaria
cp .env.producao.example .env && chmod 600 .env
```

### 2.1 Repositório privado: deploy key da VPS

O repositório é privado (2026-10-30). A VPS lê o código por uma **deploy key** só de leitura, exclusiva deste
repositório: não usa token pessoal nem a chave do Tobe, e não consegue escrever no GitHub.

```bash
# Na VPS, como o dono de /opt/tcc-portaria (stat -c %U /opt/tcc-portaria/.git)
ssh-keygen -t ed25519 -N '' -C 'vps-condnexo-deploy (somente leitura)' -f ~/.ssh/condnexo_deploy
cat >> ~/.ssh/config <<'CFG'
Host github-condnexo
  HostName github.com
  IdentityFile ~/.ssh/condnexo_deploy
  IdentitiesOnly yes
CFG
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts   # conferir com a impressão digital publicada pelo GitHub
cat ~/.ssh/condnexo_deploy.pub                              # chave PÚBLICA: pode copiar
```

No GitHub: `ragrunge/condenexo` → Settings → Deploy keys → Add deploy key, colar a chave pública, **sem** "Allow write
access". Depois, na VPS: `git -C /opt/tcc-portaria remote set-url origin git@github-condnexo:ragrunge/condenexo.git` e
`git -C /opt/tcc-portaria fetch origin main` para conferir. O apelido `github-condnexo` existe para não mexer no
`github.com` de outros projetos da VPS (Tobe): a chave nova só vale para este repositório.

Gerar os segredos **na VPS** (nunca colar valor em chat, e-mail ou outra máquina). O bloco abaixo grava direto no
`.env`, sem imprimir:

```bash
cd /opt/tcc-portaria
pw()  { openssl rand -base64 32 | tr -d '/+=\n'; }      # senhas de banco (entram em URL)
key() { openssl rand -base64 32; }                      # chaves da aplicação (32 bytes)
sed -i \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(pw)|" \
  -e "s|^APP_MIGRATOR_PASSWORD=.*|APP_MIGRATOR_PASSWORD=$(pw)|" \
  -e "s|^APP_RW_PASSWORD=.*|APP_RW_PASSWORD=$(pw)|" \
  -e "s|^PORTARIA_HMAC_CPF_KEY=.*|PORTARIA_HMAC_CPF_KEY=$(key)|" \
  -e "s|^PORTARIA_KEK=.*|PORTARIA_KEK=$(key)|" \
  -e "s|^PORTARIA_KEK_VERSAO=.*|PORTARIA_KEK_VERSAO=1|" \
  -e "s|^TRUST_PROXY=.*|TRUST_PROXY=1|" \
  -e "s|^CORS_ORIGENS=.*|CORS_ORIGENS=https://www.condenexo.com.br|" \
  -e "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" \
  .env
grep -c '=$' .env    # quantas ficaram vazias (as opcionais); nunca `cat .env`
```

**Cofre, antes de seguir:** `PORTARIA_HMAC_CPF_KEY` e `PORTARIA_KEK` precisam de uma cópia **fora da VPS** (gerenciador
de senhas do responsável). Elas não estão no dump. Sem a HMAC, a busca por CPF dos cadastros se perde, e ela não é
rotacionável. Sem a KEK, os anexos ficam ilegíveis para sempre. Copie pelo terminal da VPS para o cofre sem passar por
arquivo intermediário. As senhas de banco não precisam de cofre: o restore recria os roles a partir do `.env` novo.

O `.env` já traz `COMPOSE_FILE=docker-compose.prod.yml`: qualquer `docker compose ...` nessa pasta usa o arquivo de
produção. **Não** rode o `docker-compose.yml` de dev na VPS (Mailpit, seed com pessoas fictícias e porta do banco
publicada).

---

## 3. Build, migrate, seed

```bash
cd /opt/tcc-portaria
docker compose config --quiet && echo ok       # interpolação: falta de variável obrigatória aparece aqui
docker compose build                            # na própria VPS (amd64); ~3-5 min na primeira vez
docker compose up -d --wait                     # db -> permissoes + migrate (rodam e terminam) -> api
docker compose ps -a                            # db/api healthy; permissoes/migrate Exited (0)
curl -s http://127.0.0.1:3100/api/v1/saude      # {"data":{"status":"ok","banco":"ok",...}}
```

- `db`: o bootstrap (`db/bootstrap/00_roles.sh`) cria `app_migrator`, `app_rw` e o banco **na primeira subida do
  volume**. Mudar a senha no `.env` depois **não** muda o role (ver `db/README.md`).
- `permissoes`: acerta o dono dos volumes `documentos` e `ancoras` para o usuário `node` da API (volume restaurado de
  backup ou criado por outra imagem nasce root, e a API não-root não gravaria). Roda a cada `up`; é idempotente.
- `migrate`: roda a cada `up` e aplica só o que falta. A API só sobe depois do sucesso dele.

**Seed** (estrutura do condomínio + 4 usuários de demonstração, **todos com troca de senha obrigatória** em produção;
pessoas fictícias não entram). A senha temporária só existe no ambiente daquele processo:

```bash
read -rs -p 'Senha temporária do seed (12+ caracteres): ' SEED_SENHA_DEV; echo; export SEED_SENHA_DEV
docker compose run --rm --no-deps -e SEED_SENHA_DEV api node dist/cli/seed-dev.js
unset SEED_SENHA_DEV
```

Em seguida, entre com o síndico (`carlos.andrade`), troque a senha e crie os usuários reais. Desative os de
demonstração que não forem usados.

---

## 4. `TRUST_PROXY`: quantos saltos confiar

A API usa `req.ip` (Express `trust proxy` = número de saltos) para o limite de login por IP e para o IP gravado na
sessão e na trilha. O número é a contagem de proxies **entre o cliente e a API**, cada um acrescentando o endereço
de quem o chamou ao `X-Forwarded-For`.

| Topologia | `TRUST_PROXY` | Observação |
|---|---|---|
| navegador → nginx da VPS → API (`api.condenexo.com.br`, DNS only, sem proxy da Cloudflare) | **1** | **Atual (desde 2026-10-31).** O nginx põe o IP da conexão no XFF |
| navegador → Vercel (rewrite) → proxy da VPS → API | 2 | Antiga (substituída em 2026-10-31). **Não use mais**: sem a Vercel, 2 deixa o IP forjável |
| navegador → Cloudflare (proxy laranja) → nginx → API | 2 | Só se o proxy da Cloudflare for ligado no `api.`; é outra topologia, e `docs/deploy-subdominio-api.md` não vale |
| sem proxy (dev, `127.0.0.1:3000` direto) | `false` | Nunca em produção |

Erro para **menos** (ex.: `false`, ou 1 com um proxy a mais na frente): todo mundo aparece com o IP do salto de fora, e 30
falhas de qualquer um bloqueiam o login de todos por 15 min. Erro para **mais** (ex.: 2 sem a Vercel): o IP vira o valor
que o cliente escreveu no XFF, e o limite de login por IP é contornado.

**Custo aceito na topologia antiga (spec §14 nº 26, substituída em 2026-10-31; com 1 ele deixa de existir):** quem chamava `https://179-197-78-78.sslip.io` direto, sem passar pela Vercel, escolhia
o próprio IP pelo XFF, porque a Vercel não publica faixa fixa de IP e o proxy não tem como distinguir. Por isso o limite
por IP é auxiliar, e o controle que vale é o limite por login. Não "consertar" pondo IP de bridge em allowlist (com
o `userland-proxy` do Docker, todo cliente aparece com o IP do gateway da bridge, e a allowlist liberaria qualquer um):
o número de saltos não depende do IP de origem do socket.

---

## 5. Proxy da VPS (a fase 2 escolhe UM)

Regras comuns aos três:

- só `/api/` vai para a API; o resto do host responde 404 (o front é da Cloudflare);
- `X-Forwarded-For` **acrescentado**, nunca substituído (seção 4);
- corpo até 6 MB (anexo de ocorrência até 4 MB + multipart);
- upstream `http://127.0.0.1:3100` (proxy no host). Proxy em container: seção 5.4.

> **Aviso: limite de emissão do Let's Encrypt no sslip.io.** `sslip.io` **não** está na Public Suffix List (conferido em
> 2026-10-19). O limite de 50 certificados novos por semana por domínio registrado vale para **todos** os usuários do
> sslip.io juntos, e pode estar esgotado no dia da emissão (`too many certificates already issued for "sslip.io"`).
> Também vale o limite de 5 certificados duplicados por semana para o mesmo nome. Então:
> 1. teste primeiro contra o **staging** do Let's Encrypt (`--test-cert` no certbot, `acme_ca` de staging no Caddy,
>    `caServer` de staging no Traefik) e só depois emita o real;
> 2. não deixe o proxy em laço de reemissão (cada falha gasta tentativa e pode acionar o limite de falhas por hora);
> 3. se o limite estiver esgotado: espere a janela de 7 dias, use outra CA ACME (ZeroSSL, Buypass) com o mesmo
>    proxy, ou registre um domínio barato (o que também resolve o custo do nº 26, com `api.` no mesmo site);
> 4. confira o vencimento (90 dias) e a renovação automática do proxy, que concorre ao mesmo limite.

### 5.1 nginx (no host)

```nginx
# /etc/nginx/sites-available/tcc-portaria  (ln -s em sites-enabled; `nginx -t` antes de `systemctl reload nginx`)
# Zonas de limite de requisições: no topo do arquivo (o include de sites-enabled cai dentro de `http {}`). Nomes com
# prefixo tcc_ para não colidir com zonas do Tobe. Chave = IP da CONEXÃO (ver nota abaixo).
limit_req_zone $binary_remote_addr zone=tcc_login:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=tcc_api:10m rate=20r/s;

server {
    listen 80;
    server_name 179-197-78-78.sslip.io;
    server_tokens off;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    # nginx 1.24 (Ubuntu 24.04) não conhece `http2 on;` (só a partir da 1.25.1): http2 vai no listen.
    listen 443 ssl http2;
    server_name 179-197-78-78.sslip.io;
    server_tokens off;

    ssl_certificate     /etc/letsencrypt/live/179-197-78-78.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/179-197-78-78.sslip.io/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 6m;
    limit_req_status 429;

    # Login: 30/min por IP de conexão, rajada de 10. Mesmo proxy de /api/.
    location = /api/v1/auth/login {
        limit_req zone=tcc_login burst=10 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location /api/ {
        limit_req zone=tcc_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # ACRESCENTA o IP da conexão ao XFF. Com TRUST_PROXY=1 a API usa só o último item (o IP da conexão), então o que o
        # cliente escrever antes não vale (docs/deploy-subdominio-api.md, seção 4).
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location / { return 404; }
}
```

> **Nota sobre os limites do nginx.** A chave é o IP da **conexão** (`$binary_remote_addr`), não o XFF: ninguém a
> forja. Na topologia antiga, quem passava pela Vercel aparecia com o IP da borda dela e o balde era dividido entre todos
> os que saíam pela mesma borda; hoje cada cliente chega com o próprio IP (se um 429 do nginx aparecer para a guarita
> sem ataque, subir `rate`/`burst` do `tcc_login`). O limite da **aplicação** (seção 4, spec §5.1: par login+IP e IP)
> usa o XFF com `TRUST_PROXY=1`, que confia só no nginx; o nginx limita à parte, como rede de segurança grossa.
> O cabeçalho secreto Vercel -> nginx que este parágrafo previa deixou de fazer sentido com a saída da Vercel.

Certificado em dois passos, porque o `nginx -t` falha enquanto o bloco 443 aponta para um certificado que ainda não
existe: (1) `mkdir -p /var/www/certbot`, habilitar só o bloco 80, `nginx -t && systemctl reload nginx`;
(2) `certbot certonly --webroot -w /var/www/certbot -d 179-197-78-78.sslip.io --test-cert` (staging), depois sem
`--test-cert` (com `--force-renewal` para trocar o de staging); (3) acrescentar o bloco 443, `nginx -t`, reload. O `$proxy_add_x_forwarded_for` é por `location`: **não afeta o Tobe**.

### 5.2 Caddy (no host)

```caddy
179-197-78-78.sslip.io {
    request_body { max_size 6MB }
    handle /api/* {
        reverse_proxy 127.0.0.1:3100
    }
    handle { respond 404 }
}
```

Caddy **descarta** o XFF recebido de quem não está em `trusted_proxies`. Com `TRUST_PROXY=1` isso já basta: a API lê o
IP da conexão que o Caddy viu. A parte abaixo é o texto da época da Vercel (TRUST_PROXY=2), em que o Caddy precisava
repassar o XFF da Vercel. Duas saídas, a decidir na fase 2:

- **A (escopo global):** `{ servers { trusted_proxies static 0.0.0.0/0 ::/0 } }` no bloco global. Vale para **todos os
  sites desse listener, inclusive o Tobe**: o Tobe passaria a confiar em XFF arbitrário. Só com o aval de quem mantém
  o Tobe.
- **B (só neste site):** `reverse_proxy 127.0.0.1:3100 { header_up X-Forwarded-For "{http.request.header.X-Forwarded-For}, {http.request.remote.host}" }`.
  **Não testado aqui.** Validar com o item "IP real" da checklist (seção 10) antes de abrir para a portaria. Pedido
  sem XFF (acesso direto) sai com o primeiro item vazio, e a API o vê como IP vazio, um balde compartilhado só por
  quem burlava a Vercel.

ACME de staging para o primeiro teste: `{ acme_ca https://acme-staging-v02.api.letsencrypt.org/directory }`.

### 5.3 Traefik

Configuração dinâmica (file provider), ao lado do router do Tobe:

```yaml
http:
  routers:
    tcc-portaria:
      rule: "Host(`179-197-78-78.sslip.io`) && PathPrefix(`/api/`)"
      entryPoints: [websecure]          # o entrypoint HTTPS que já existe
      service: tcc-portaria
      middlewares: [tcc-portaria-corpo]
      tls:
        certResolver: letsencrypt       # o resolver que já existe (teste antes com caServer de staging)
  middlewares:
    tcc-portaria-corpo:
      buffering:
        maxRequestBodyBytes: 6291456
  services:
    tcc-portaria:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3100"   # Traefik no host. Em container: seção 5.4
```

Traefik também **remove** o XFF recebido, a menos que o entrypoint confie no remetente
(`entryPoints.websecure.forwardedHeaders.trustedIPs` ou `insecure: true`). É configuração **do entrypoint**, ou seja,
afeta o Tobe, como a opção A do Caddy. A fase 2 decide com quem mantém o Tobe.

### 5.4 Proxy em container (caso provável, se o Tobe já usa Traefik/Caddy em Docker)

Dentro de um container, `127.0.0.1` é o próprio container: `127.0.0.1:3100` do host **não é alcançável**. Em vez de
publicar a API em `0.0.0.0` (nunca), ligue a API à rede externa do proxy com um override, declarado no `COMPOSE_FILE`
do `.env` (um override que não entra em toda linha do `up` é desfeito no próximo `up` sem ele):

```yaml
# docker-compose.prod.proxy.yml (criar na fase 2 com o nome real da rede)
services:
  api:
    networks: [banco, borda, proxy]
networks:
  proxy:
    external: true
    name: NOME_DA_REDE_DO_PROXY     # docker network ls
```

```bash
# .env
COMPOSE_FILE=docker-compose.prod.yml:docker-compose.prod.proxy.yml
```

O upstream vira `http://tcc-portaria-api-1:3000` (ou o alias do serviço). A publicação em `127.0.0.1:3100` pode ficar,
para o `curl` de diagnóstico. `TRUST_PROXY` continua 1.

---

## 6. Front (Cloudflare; a Vercel foi abandonada em 2026-10-31)

> **Atual:** o front (repositório CondeNexo.Front) é um SPA estático servido pela Cloudflare em
> `https://www.condenexo.com.br`, com `VITE_API_URL=https://api.condenexo.com.br/api/v1` no build e o host da API no
> `connect-src` do CSP (`public/_headers`). Não existe rewrite nem proxy de `/api`: front e API são o mesmo site e
> origens diferentes, por isso o CORS com credenciais (`CORS_ORIGENS`) e a verificação de Origin (escritas e leituras autenticadas)
> (`docs/deploy-subdominio-api.md`). Com `PORTARIA_AMBIENTE=producao`, a API recusa o boot sem `CORS_ORIGENS`.
> O restante desta seção é o **histórico** da Vercel e não vale mais.

> **Desde 2026-10-31 o front é outro repositório (CondeNexo.Front).** `apps/web` e `apps/plataforma` continuam com esses
> nomes lá, mas o `vercel.json` foi para a RAIZ dele, e o projeto Vercel passa a usar Root Directory = raiz do repositório
> (sem o `installCommand` de monorepo; o `npm ci` padrão instala os dois apps pelos workspaces do próprio Front). O
> rewrite `/api` para a API desta VPS e os cabeçalhos são os mesmos. Abaixo, o texto da época do monorepo.

O `apps/web/vercel.json` tem o rewrite `/api/:caminho*` → `https://179-197-78-78.sslip.io/api/:caminho*`, **antes**
do fallback da SPA, e os headers de segurança (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
`Permissions-Policy`, COOP). O front é só cliente HTTP: não existe mais modo mock nem a variável `VITE_API_MODE`.

Variáveis de **build** (Project → Settings → Environment Variables), escopo Production:

| Variável | Valor | Observação |
|---|---|---|
| `VITE_API_URL` | `/api/v1` | é o padrão; explícita para não depender dele |
| ~~`VITE_API_MODE`~~ | — | **remover** do painel: o código não a lê mais (sobra inofensiva, mas engana quem lê) |

**Sem deploy de Preview.** Como o front só fala HTTP, um preview usaria o mesmo rewrite `/api` e leria e **escreveria no banco de
produção** (trilhas append-only: nada se desfaz). Por isso o `vercel.json` traz
`"git": { "deploymentEnabled": { "main": true, "**": false } }`: as chaves são globs (minimatch) de branch; `**` casa
qualquer branch (inclusive com `/`, como `feature/x`), e quando um branch casa mais de uma regra basta UMA ser `true`
para publicar, então `main` continua publicando e todo o resto não gera deploy. Limites, a conferir no painel
(Project → Settings → Git / Deployments):

- a Vercel lê o `vercel.json` **do commit** que vai publicar: um branch criado a partir de um commit anterior a esta
  regra ainda gera preview. Apague/rebaseie esses branches ou desligue também pelo painel;
- deploy manual (`vercel` na CLI, "Redeploy" de um preview antigo) não passa por essa regra;
- se o projeto tiver Deployment Protection ou previews de PR de fork, conferir que não há preview ativo apontando
  para a produção (Deployments → filtrar por Preview).

**Rollback do front:** **Instant Rollback** para um deploy anterior de produção. Ele **não** "volta para o mock" (o
mock não existe mais): o deploy anterior também fala com a API da VPS. Se o problema for da API, o rollback é o da
API (§11), não o do front. Um deploy de produção antigo, de antes desta mudança, ainda pode estar em `mock` se a
variável `VITE_API_MODE` não estava definida naquele build: não promova deploys anteriores à fase 3.

Para desenvolver o front sem tocar em produção: `npm run dev:pglite` (neste repositório) e
`API_PROXY_ALVO=http://127.0.0.1:3101` no ambiente de dev do Front (comando e README: ver CondeNexo.Front).

---

## 7. Âncora do selo (GitHub Actions)

O porquê e o que ela prova, e o que não prova: spec §4.6. Passos no GitHub, uma vez:

1. **Branch órfão `ancoras`**, criado num clone temporário (não no clone de trabalho):

   ```bash
   git clone https://github.com/ragrunge/condenexo.git /tmp/ancoras && cd /tmp/ancoras
   git switch --orphan ancoras
   printf '%s\n' '# Âncoras do selo diário' '' 'Arquivo append-only gravado pelo workflow ancora-selo.yml. Não editar à mão.' > README.md
   : > selos.jsonl
   git add README.md selos.jsonl && git commit -m "âncoras: início" && git push origin ancoras
   cd / && rm -rf /tmp/ancoras
   ```

2. **Proteção do branch** (Settings → Rules → Rulesets → New branch ruleset):
   - Target: `ancoras` · Enforcement: **Active** · Bypass list: **vazia** (nem admin);
   - marcar **Restrict deletions** e **Block force pushes**;
   - **não** marcar "Require a pull request", "Restrict updates" nem "Require signed commits": o workflow faz push
     direto com o `GITHUB_TOKEN`, em commit sem assinatura.

3. **Variável** (Settings → Secrets and variables → Actions → **Variables**, não Secrets):
   `ANCORA_URL = https://179-197-78-78.sslip.io/api/v1/auditoria/selos/publico`
   (ou `gh variable set ANCORA_URL --body '<url>' --repo ragrunge/condenexo`).

4. **Workflow:** `.github/workflows/ancora-selo.yml` precisa estar no `main` (o agendamento só roda a partir do branch
   padrão). O job só roda quando a variável `ANCORA_URL` existe (`if: vars.ANCORA_URL != ''`): até a fase 3 o
   agendamento é pulado sem falhar e sem abrir issue. Na fase 3, crie a variável e faça uma
   execução manual (Actions → "Âncora do selo diário" → Run workflow). Resultado esperado: commit
   `âncora: selos de ...` no branch `ancoras`.

5. **Terceiros:** peça ao orientador ou a um membro do conselho que mantenha um clone do repositório e o atualize de
   tempos em tempos (`git fetch`). É isso que fecha o limite "o dono do repositório pode desligar a proteção".

Operação:

- Falha por API fora do ar: o job falha sem gravar nada (e o GitHub manda e-mail ao dono). A coleta seguinte recupera
  até 31 dias.
- Divergência: o job falha e abre ou comenta a issue **"Âncora do selo: divergência (possível adulteração da trilha)"**.
  Não apague a issue nem o branch. Siga o roteiro do corpo da issue.
- **Repositório privado (2026-10-30):** um branch `ancoras` num repositório privado só é testemunha para quem tem
  acesso a ele. Para a âncora valer contra terceiros (o objetivo da seção 4.6 da spec), os selos devem ir para um
  repositório **público separado**, só com `selos.jsonl` (sem código). Pendente, junto com `ANCORA_URL`.
- O GitHub desativa workflow agendado de repositório público depois de 60 dias sem atividade. O aviso chega por e-mail
  e é preciso reativar.
- Conferência offline, em qualquer máquina com Node (de preferência não a VPS):

  ```bash
  git clone https://github.com/ragrunge/condenexo.git && cd condenexo
  npm ci && npm run build
  git show origin/ancoras:selos.jsonl > /tmp/selos.jsonl
  # trilha-....jsonl: Histórico -> "Exportar trilha", sem filtro
  node dist/cli/verificar-ancoras.js trilha-condnexo-AAAAMMDD-HHMM.jsonl /tmp/selos.jsonl
  # 0 confere | 1 sem âncora no intervalo exportado | 2 divergente ou trilha inconsistente
  ```

---

## 8. Backup (RNF-10)

`db/backup/backup-portaria.sh`: `pg_dump -Fc` + volumes `documentos` e `ancoras`, cifrados com a chave **pública** age,
num conjunto atômico (`portaria-<carimbo>.dump.age`, `arquivos-<carimbo>.tar.age`, `<carimbo>.sha256` e, depois da F1 do
SaaS, `plataforma-<carimbo>.dump.age`), com rotação de
30 diários e 12 mensais em `/var/backups/tcc-portaria` (fora dos volumes do Docker). Testado localmente: três execuções
seguidas com rotação, recusa de arquivo com chave privada e restore completo (seção 9).

1. **Par de chaves age, gerado FORA da VPS** (na máquina do responsável): `age-keygen -o portaria-backup.key`. A chave
   privada vai para o cofre (e uma cópia offline). Só a linha pública (`age1...`) vai para a VPS:

   ```bash
   sudo apt install age
   sudo install -d -m 755 /etc/tcc-portaria
   echo 'age1...' | sudo tee /etc/tcc-portaria/backup-age.pub >/dev/null    # a linha PÚBLICA
   sudo install -d -m 700 /var/backups/tcc-portaria
   ```

   O script recusa rodar se o arquivo tiver `AGE-SECRET-KEY`. Quem toma a VPS lê o banco vivo, mas não os backups
   antigos, que podem trazer dado já eliminado pela retenção.

2. **Agendar** (escolha um):
   - systemd: `sudo install -m 644 db/backup/tcc-portaria-backup.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now tcc-portaria-backup.timer`
   - cron: a linha de `db/backup/crontab.exemplo`.

   Primeiro teste manual: `sudo systemctl start tcc-portaria-backup.service && journalctl -u tcc-portaria-backup -n 20`.

3. **Cópia externa** (o backup só vale fora da VPS). Puxe da máquina do responsável, ou de outro servidor, para que a VPS
   não guarde credencial do destino:

   ```bash
   rsync -a --ignore-existing usuario@179.197.78.78:/var/backups/tcc-portaria/ ~/backups/tcc-portaria/
   cd ~/backups/tcc-portaria/diario && sha256sum -c ./*.sha256
   ```

   `--ignore-existing` e nenhum `--delete`: a cópia externa não apaga nada quando a VPS rotaciona (ou é adulterada).
   Para object storage, use bucket com retenção imutável (object lock).

   **Em uso (desde 2026-10-19):** chave dedicada só de leitura, presa no `authorized_keys` do root a
   `restrict,command="tar -C /var/backups/tcc-portaria -cf - diario mensal"` (o `rrsync` do Ubuntu recusa o `openrsync`
   do macOS). Na máquina do responsável, um agente do `launchd` roda às 09:00 e no login:
   `ssh -i <chave> root@179.197.78.78 backup | tar -xkf - -C ~/backups/tcc-portaria` (`-k`: nunca sobrescreve),
   confere todos os `.sha256` e avisa por notificação se a VPS não responder, se um hash divergir ou se o último dump
   tiver mais de 2 dias.

4. **Teste de restauração mensal** (spec §11): restaurar o último conjunto numa máquina isolada (seção 9), rodar a
   verificação de integridade e o `verificar-ancoras`, e registrar o resultado.

---

## 9. Restore completo (na ordem)

`pg_dump` é por banco: roles, senhas e as chaves da aplicação **não** estão nele. Ordem testada em 2026-10-19 com o
compose de produção (contagens, cabeça da cadeia, arquivos, login, integridade e privilégios do `app_rw` iguais aos da
origem):

1. **Decifrar** (na máquina com a chave privada) e conferir:
   `sha256sum -c <carimbo>.sha256 && age -d -i portaria-backup.key -o portaria.dump portaria-<carimbo>.dump.age && age -d -i portaria-backup.key -o arquivos.tar arquivos-<carimbo>.tar.age`.
   Copie os dois arquivos decifrados para o servidor novo por `scp` e apague-os ao fim.
2. **Roles e bootstrap:** clone + `.env` novo (seção 2, senhas de banco novas), com **as mesmas** `PORTARIA_KEK`,
   `PORTARIA_KEK_VERSAO` e `PORTARIA_HMAC_CPF_KEY` do cofre (passos 4 e 5 abaixo), e só o banco:
   `docker compose build && docker compose up -d --wait db` (o bootstrap cria `app_migrator`, `app_rw` e o banco vazio).
3. **Dump** (antes de qualquer `migrate`):
   `docker compose exec -T db pg_restore -U postgres -d portaria --exit-on-error --single-transaction < portaria.dump`
4. **KEK** (`PORTARIA_KEK` + `PORTARIA_KEK_VERSAO`): do cofre para o `.env`. Sem ela, os anexos restaurados são lixo.
5. **Chave HMAC** (`PORTARIA_HMAC_CPF_KEY`): do cofre para o `.env`. Sem ela, a busca por CPF não acha ninguém.
6. **Volume de documentos** (e `ancoras`):
   `docker compose run --rm --no-deps -T --entrypoint tar api -C /var/lib/portaria -xf - < arquivos.tar`
7. **Subir tudo:** `docker compose up -d --wait` (o `permissoes` acerta o dono, e o `migrate` não tem o que fazer porque a
   tabela de migrações veio no dump).
8. **Anonimizações (antes de abrir para a portaria):**
   `docker compose exec api node dist/cli/jobs.js reaplicar-anonimizacoes [--condominio <código>]`. O dump traz de volta,
   com nome, CPF e telefone, quem foi anonimizado depois da data dele; o banco `plataforma` guarda a lista (tabela
   `lgpd_anonimizacao`, só ids) e o comando anonimiza essas pessoas de novo. A saída tem só ids e contagens:
   `reaplicadas`, `inexistentes` (o backup é anterior ao cadastro: nada a fazer) e `comVinculoValido` (no banco restaurado
   a pessoa ainda tem vínculo válido: a anonimização é refeita mesmo assim, porque o pedido já foi atendido, e a
   administração encerra o vínculo). Saída com código 3: a retenção está rodando; repetir. A retenção diária repete este
   passo, mas só na hora do agendador: rodar o comando na hora fecha a janela em que o banco restaurado mostra os dados.
   **Limite:** se o banco `plataforma` também for restaurado para a mesma data, a lista volta junto; aí os pedidos
   posteriores ao dump vêm do `audit_log` do banco antigo (ação `lgpd.anonimizar`) ou do registro de pedidos da
   administração, e são refeitos pela ficha da pessoa.
9. **Depois do restore:** `docker compose exec api node dist/cli/jobs.js retencao` (o dump traz de volta o que já tinha
   vencido). Conferir a integridade (Histórico → "Verificar integridade") e o `verificar-ancoras` contra o branch `ancoras`.

---

## 10. Checklist de verificação (fase 3, antes de abrir para a portaria)

```bash
cd /opt/tcc-portaria
docker compose ps -a                                  # api/db healthy; permissoes/migrate Exited (0)
sudo ss -ltnp | grep -E ':3100|:5432'                 # 3100 SÓ em 127.0.0.1; nenhum 5432 deste projeto
docker stats --no-stream | grep tcc-portaria          # api < 384M, db < 512M
curl -s http://127.0.0.1:3100/api/v1/saude            # direto
curl -sv https://179-197-78-78.sslip.io/api/v1/saude 2>&1 | grep -E 'subject|issuer|expire|"status"'   # TLS real, sem -k
curl -s https://api.condenexo.com.br/api/v1/saude                    # direto no api. (sem rewrite)
curl -s https://api.condenexo.com.br/api/v1/auditoria/selos/publico  # {"data":{"formato":"portaria-parque/selos-diarios",...}}
curl -sI https://www.condenexo.com.br/ | grep -iE 'content-security|x-frame'   # cabeçalhos do front (Cloudflare)
```

- [ ] **Saúde:** os três `saude` respondem `ok`, e o `/saude` não traz `ultimoSeq`.
- [ ] **TLS:** certificado de produção (não o de staging), emitido para `api.condenexo.com.br` (e, na transição, para
      `179-197-78-78.sslip.io`), com renovação automática configurada.
- [ ] **Login** pelo site `https://www.condenexo.com.br`, com troca de senha do usuário de seed, sem erro de CORS no
      console (checklist completo de CORS em `docs/deploy-subdominio-api.md`, seção 6).
- [ ] **Cookie:** DevTools → Application → Cookies: `__Host-portaria_sessao` com **Secure**, **HttpOnly**,
      `SameSite=Strict`, `Path=/`, sem `Domain`.
- [ ] **IP real, não o do proxy** (sem provocar 429: nunca testar o bloqueio contra a produção, porque com
      `TRUST_PROXY` errado ele bloqueia todo mundo). Entre pelo site `https://www.condenexo.com.br` e compare o IP gravado na sessão com o
      seu IP público (`curl -s https://api.ipify.org` na sua máquina):

      ```bash
      docker compose exec -T db psql -U postgres -d portaria -Atc "select ip, criada_em from sessao order by criada_em desc limit 3"
      ```

      Tem que ser o **seu** IP. `172.x`/`127.0.0.1` indica proxy que não repassa o XFF; um IP de CDN/provedor indica
      proxy que **substitui** o XFF (Caddy/Traefik sem ajuste) ou `TRUST_PROXY` baixo; o IP que você escolheu no XFF
      (teste com `X-Forwarded-For` forjado, sem provocar 429) indica `TRUST_PROXY` alto (2 sem a Vercel). Repita por um segundo
      provedor (4G do celular) para ver dois IPs diferentes.
- [ ] **Âncora:** execução manual do workflow verde e uma linha nova em `selos.jsonl` do branch `ancoras` (no dia
      seguinte ao primeiro selo diário).
- [ ] **Backup:** um conjunto em `/var/backups/tcc-portaria/diario`, a cópia externa puxada e um restore de teste feito.
- [ ] **Tobe intacto:** o health do Tobe (3333) responde como antes e o certificado dele não mudou.

---

## 11. Atualização e rollback

**Atualizar** (nova versão do `main`):

```bash
cd /opt/tcc-portaria
git fetch && git checkout --detach origin/main
sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env      # a tag mora no .env: `up` sem variável usa a mesma
docker compose build && docker compose up -d --wait
```

A tag anterior continua em `docker images tcc-portaria-api`. Só o `api`, o `migrate` e o `permissoes` dependem de
`API_TAG`, e o `db` não é recriado.

**Deploy automático** (`.github/workflows/deploy-api.yml`): push na `main` que mexa em `a API`, `src/dominio`
ou no `package-lock.json` roda typecheck e testes e, se passarem, entra por SSH na VPS com a chave do CI. No
`authorized_keys` do root essa chave é `restrict,command="/usr/local/sbin/tcc-portaria-deploy"`: ela só executa o
`scripts/deploy/deploy-vps.sh` (instalado fora do clone, por cópia manual), que faz o passo acima sozinho:

1. recusa (código 2, job vermelho) se a `main` foi reescrita ou se o intervalo muda infra: compose, Dockerfile,
   `db/bootstrap`, `db/backup`, `scripts/deploy` ou `.env.producao.example`. Esses vão à mão, como acima;
2. backup: o cifrado (`backup-portaria.sh`) se houver chave age, senão um `pg_dump` local em
   `/var/backups/tcc-portaria/pre-deploy` (root, 600, os 3 últimos);
3. build com a tag nova; falhou, nada muda no que está rodando;
4. troca `API_TAG`, `up -d --wait` (o `migrate` roda antes da API) e confere `/saude`;
5. falhou: volta commit e tag anteriores. Migração aplicada **não** volta: o log aponta o backup do passo 2.

Configuração (uma vez, pelo dono do repositório): variáveis `DEPLOY_HOST` e `DEPLOY_KNOWN_HOSTS`; environment
`producao` com regra de branch `main` e o secret `DEPLOY_SSH_KEY`. Sem `DEPLOY_HOST` o job de deploy é pulado.
Trocar a chave: gerar outra, substituir a linha `tcc-portaria-ci` do `authorized_keys` e o secret.

**Limite do que a chave restrita protege:** ela impede que uma chave vazada vire shell, mas quem faz push na `main`
continua decidindo o código que sobe. A trava de infra evita que um push troque o compose (volume do host, privilégio)
sem passar por uma pessoa na VPS.

**Rollback da API** (sem migração nova no meio):

```bash
git checkout --detach <commit anterior>
sed -i "s|^API_TAG=.*|API_TAG=<tag anterior>|" .env
docker compose up -d --wait
```

**Migração no meio:** as migrações só andam para a frente. Voltar o código depois de aplicar uma migração exige o restore
do backup anterior a ela (seção 9). Antes de atualizar com migração nova, rode o backup à mão
(`sudo systemctl start tcc-portaria-backup.service`).

**Rollback do front:** não há mais Instant Rollback da Vercel. O front é um SPA estático na Cloudflare: o rollback é
reimplantar o build anterior (ou o commit anterior do CondeNexo.Front) na Cloudflare. Um problema de CORS ou de IP é da
API/nginx, e o rollback dele está em `docs/deploy-subdominio-api.md`, seção 7.

**Retirar tudo** (sem afetar o Tobe): `docker compose down` (mantém volumes) e remover o bloco do proxy e o `reload`.
`docker compose down -v` **apaga o banco**: só com backup conferido.

---

## 12. SaaS: linha de base (F0) e banco `plataforma` (F1)

Fases de `docs/05_arquitetura_saas.md` §5. Nenhuma delas muda o banco `portaria` nem o comportamento da API.
`<vps>` abaixo é o host SSH do operador (não versionado aqui).

### 12.1 F0: linha de base (só leitura)

Pré-requisito: a imagem em produção já tem `dist/cli/linha-de-base.js` (deploy normal do código da F0).

```bash
sudo /opt/tcc-portaria/scripts/saas/linha-de-base.sh       # ~segundos; não para a API
```

Gera `/var/backups/tcc-portaria/linha-de-base/linha-de-base-<carimbo>.tar.age` (+ `.sha256`), cifrado com a mesma
chave pública do backup. Dentro: `linha-de-base.json` (cabeça `seq`/`hash`, verificação interna, `verificar-ancoras`
contra o branch `ancoras`, contagem por tabela, última migração), `trilha.jsonl` (exportação verificável **sem nomes**)
e `selos.jsonl`. O terminal mostra só a cabeça, contagens e as conclusões. Código 4 = a cadeia ou as âncoras não
conferem: o arquivo fica como evidência, e a F1 não começa.

Levar para fora e abrir (na máquina com a chave privada):

```bash
scp '<vps>:/var/backups/tcc-portaria/linha-de-base/linha-de-base-<carimbo>.*' ~/backups/tcc-portaria/linha-de-base/
cd ~/backups/tcc-portaria/linha-de-base && shasum -a 256 -c linha-de-base-<carimbo>.sha256
age -d -i portaria-backup.key linha-de-base-<carimbo>.tar.age | tar -xOf - linha-de-base.json   # só o resumo
```

A `trilha.jsonl` tem o texto livre dos eventos (justificativa, observação): extrair só para conferir e apagar depois.

### 12.2 F0: restore de teste num banco descartável

Na máquina do responsável, nunca na VPS (a chave privada não vai para lá). Sobe um `postgres:17-alpine` descartável
em `127.0.0.1`, restaura por pipe o dump do backup diário (de **depois** da linha de base), confere a cadeia, as âncoras
e a cabeça contra a linha de base, e apaga tudo no fim. Não toca no banco `portaria` de produção.

```bash
npm ci && npm run build          # a CLI roda daqui
AGE_IDENTIDADE=~/caminho/portaria-backup.key scripts/saas/restore-teste.sh \
  ~/backups/tcc-portaria/diario/portaria-<carimbo>.dump.age \
  ~/backups/tcc-portaria/linha-de-base/linha-de-base-<carimbo>.tar.age
```

Código 0 = `CONFERE`. Registrar a data e o resultado (é também o teste mensal de restauração da seção 8).

### 12.3 F1: banco `plataforma` (deploy manual: o automático sai com código 2)

Muda compose, `Dockerfile` e `db/bootstrap` (por isso é manual). A API continua igual: só os serviços
`migrate-plataforma` e `plataforma-cli` (perfil `plataforma`, fora do `up`) usam o banco novo. Antes: F0 com
`CONFERE`.

```bash
cd /opt/tcc-portaria
sudo systemctl start tcc-portaria-backup.service                       # 1. backup antes
pw()  { openssl rand -base64 32 | tr -d '/+=\n'; }                      # 2. segredos novos, gerados aqui
key() { openssl rand -base64 32; }
grep -q '^APP_PLATAFORMA_PASSWORD=' .env || printf 'APP_PLATAFORMA_PASSWORD=%s\n' "$(pw)" >> .env
grep -q '^PORTARIA_CHAVE_MESTRA=' .env || printf 'PORTARIA_CHAVE_MESTRA=%s\nPORTARIA_CHAVE_MESTRA_VERSAO=1\n' "$(key)" >> .env
grep -cE '^(APP_PLATAFORMA_PASSWORD|PORTARIA_CHAVE_MESTRA|PORTARIA_CHAVE_MESTRA_VERSAO)=.+' .env   # 3
```

**Cofre:** `PORTARIA_CHAVE_MESTRA` vai para o cofre **antes** do passo 6, como a KEK (seção 2). Perdê-la depois da F2
é perder as chaves de todos os condomínios.

```bash
git fetch && git checkout --detach origin/main                           # 4. código e imagens
sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env
docker compose build && docker compose up -d --wait                      #    só api/migrate/permissoes mudam de tag
docker compose exec -T db sh /docker-entrypoint-initdb.d/10_plataforma.sh # 5. roles + banco (idempotente)
printf "ALTER ROLE app_plataforma LOGIN PASSWORD '%s';\n" "$(sed -n 's/^APP_PLATAFORMA_PASSWORD=//p' .env)" \
  | docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres   #    senha por stdin, sem eco
docker compose --profile plataforma run --rm migrate-plataforma          # 6. tabelas da §4.1 (a partir da F2: `docker compose run --rm migrate`)
docker compose --profile plataforma run --rm plataforma-cli \
  node dist/cli/registrar-piloto.js --codigo <slug> --nome "<nome exibido>"   # 7. piloto + chaves (v. de hoje)
```

Conferir:

- passo 3 imprime `3`; passo 5 sem erro (o aviso de "sem LOGIN" do script é esperado: a senha vem logo depois);
- passo 7: `"situacao": "registrado"`, `hmac_cpf` v1 e `kek_documentos` na versão de `PORTARIA_KEK_VERSAO`. Rodar de
  novo responde `ja_registrado` (prova que o embrulho bate com o `.env`). As `impressao` batem com as do cofre:
  `pbpaste | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(require('crypto').createHash('sha256').update('portaria:impressao:v1:').update(Buffer.from(s.trim(),'base64')).digest('hex').slice(0,16)))"`
  (com a chave copiada do cofre);
- isolamento de roles (`f|f|t|f`): `docker compose exec -T db psql -U postgres -tAc "select
  has_database_privilege('app_rw','plataforma','CONNECT'), has_database_privilege('app_plataforma','portaria','CONNECT'),
  has_database_privilege('app_plataforma','plataforma','CONNECT'), has_database_privilege('app_provisionador','portaria','CONNECT')"`;
- a API: `/saude` com `"banco":"ok"`, login na portaria e "Verificar integridade" como antes.

**Rollback da F1:** `docker compose exec -T db psql -U postgres -c 'DROP DATABASE plataforma' -c 'DROP ROLE app_plataforma' -c 'DROP ROLE app_provisionador'`
e voltar o commit/tag (seção 11). O banco `portaria` não foi tocado.

## 13. SaaS F2: API multi-banco (deploy manual: o automático sai com código 2)

Muda compose, `Dockerfile`, `db/backup`, `scripts/deploy` e `.env.producao.example`. O banco `portaria` não recebe
migração nova. Desde esta fase a API:

- lê o condomínio (banco + chaves) do banco `plataforma`, como `app_plataforma`, com a `PORTARIA_CHAVE_MESTRA`;
- recusa subir se não houver condomínio ativo, se a chave mestra não desembrulhar as chaves, se `PORTARIA_HMAC_CPF_KEY`
  / `PORTARIA_KEK` / `PORTARIA_KEK_VERSAO` (agora opcionais) estiverem no `.env` e diferirem das do piloto, ou se a KEK
  não abrir a DEK de um anexo existente;
- grava o cookie `v2.<condominio_id>.<token>` e aceita o antigo (sem prefixo) para o piloto enquanto
  `SAAS_PILOTO_PADRAO` (padrão `true`) estiver ligado; login sem código também vai para o piloto;
- o serviço `migrate` passa a migrar `plataforma` e depois cada banco de condomínio (`scripts/migrar-bancos.mjs`); o
  serviço `migrate-plataforma` saiu. O backup faz um dump por banco de condomínio (só o piloto, hoje).

Antes: F1 feita (piloto registrado) e as chaves do piloto no cofre. **Não** esvaziar as três chaves antigas do `.env`
nesta fase: a imagem anterior (rollback) ainda precisa delas.

```bash
cd /opt/tcc-portaria
sudo systemctl start tcc-portaria-backup.service                        # 1. backup antes
grep -cE '^(APP_PLATAFORMA_PASSWORD|PORTARIA_CHAVE_MESTRA|PORTARIA_CHAVE_MESTRA_VERSAO)=.+' .env   # 2. imprime 3
docker compose --profile plataforma run --rm plataforma-cli \
  node dist/cli/registrar-piloto.js --codigo <slug> --nome "<nome exibido>"     # 3. "ja_registrado" (chaves = .env)
TAG_ANTERIOR="$(sed -n 's/^API_TAG=//p' .env)"; echo "$TAG_ANTERIOR"     # 4. anotar para o rollback
git fetch && git checkout --detach origin/main                            # 5. código e imagens
sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env
docker compose build && docker compose up -d --wait                       # 6. migrate (laço) e depois a API
install -m 755 -o root -g root scripts/deploy/deploy-vps.sh /usr/local/sbin/tcc-portaria-deploy   # 7. script novo
```

Conferir:

- passo 3: `"situacao": "ja_registrado"` (com `registrado` ou erro, parar: a plataforma não está como a F1 deixou);
- passo 6: `docker compose logs migrate | grep migrar-bancos` termina em `ok (plataforma + 1 condomínio(s))`;
  `docker compose logs api | grep saas.boot` mostra `condominios=1 piloto=sim ambiente=hmac_cpf+kek_documentos+kek_versao`
  (e `deks_conferidas=1` se já houver anexo);
- `/saude` com `"banco":"ok"`; uma sessão aberta ANTES do deploy continua logada; login novo na portaria (sem código)
  funciona e o cookie novo começa com `v2.`; "Verificar integridade" como antes;
- `curl -s https://<api>/api/v1/auditoria/selos/publico | head -c 120` responde o formato v1 (o workflow da âncora segue);
- `docker compose exec api node dist/cli/jobs.js ancoras` imprime `{"condominioId":...,"enviados":...}`;
- `sudo systemctl start tcc-portaria-backup.service` e `journalctl -u tcc-portaria-backup -n 20`: dumps de `portaria` e
  `plataforma`, nenhum `condominio-*` (só há o piloto);
- verificação da cadeia antiga (05_arquitetura_saas.md §5): `linha-de-base --conferir` contra a da F0 dá `CONFERE`.

**Rollback da F2:** `git checkout --detach <commit de $TAG_ANTERIOR>`, `sed -i "s|^API_TAG=.*|API_TAG=$TAG_ANTERIOR|" .env`,
`docker compose up -d --wait` e reinstalar o `deploy-vps.sh` daquele commit. Nada a desfazer em banco (nenhuma migração
nova; o `migrate` antigo só olha o `portaria`). Efeito visível: quem entrou depois do deploy tem cookie `v2.` e precisa
entrar de novo (uma vez). O cookie antigo segue válido nos dois sentidos.

**Fim da transição** (fase seguinte, depois de o front mandar o código no login): `SAAS_PILOTO_PADRAO=false` no `.env`
e esvaziar `PORTARIA_HMAC_CPF_KEY`/`PORTARIA_KEK`/`PORTARIA_KEK_VERSAO` (a cópia do cofre continua sendo a recuperação).
Rotação da mestra ou da KEK (inclusive por vazamento): `docs/deploy-rotacao-chaves.md` (esvazia `PORTARIA_KEK`/`_VERSAO`).
Antes de desligar: o workflow `ancora-selo.yml` precisa mandar `X-Condominio: <slug>` (sem ele `/auditoria/selos/publico`
vira 404 e a coleta de âncoras para), e lembrar que, depois disso, voltar para uma imagem anterior à F2 desloga todos
os cookies `v2.` (todos entram de novo).
`/saude` passa a devolver `condominios_com_falha` (número; 0 com só o piloto). Plataforma ou piloto fora = 503.
Ambiente de desenvolvimento (`docker-compose.yml`): a API só sobe com o piloto registrado no volume (comando no topo do
compose); `npm run local` (PGlite) não muda.


## 14. LGPD (migração 0007 e `drizzle-plataforma/0001`): deploy automático serve

Só código da API, do front e migrações novas (nada de infra): o `deploy-vps.sh` faz backup, o `migrate` aplica as duas
migrações em laço (plataforma primeiro) e sobe a API. Conferir e completar à mão:

- `docker compose logs migrate | grep migrar-bancos` termina em `ok (plataforma + 1 condomínio(s))`;
- **uma vez, logo depois:** `docker compose exec api node dist/cli/jobs.js retencao`. Além da retenção do dia, ela
  copia para `lgpd_anonimizacao` (banco `plataforma`) as anonimizações feitas ANTES deste deploy, que só existiam no
  banco do condomínio. Até essa primeira execução (ou a do agendador), um restore não as reaplicaria. Saída esperada:
  `"registroExterno":"ok"`;
- desativações antigas: o backfill da 0007 usa a data da trilha (`usuario.desativar`, `veiculo.editar`) ou, sem ela, a
  data da migração. Nada vence antes de 3 anos;
- rollback da imagem: a 0007 só anda para a frente, mas é compatível com a imagem anterior (a função antiga
  `lgpd_anonimizar_pessoa` delega à nova, e o trigger mantém `desativado_em` quando a API antiga muda `ativo`). A API
  antiga não lê `menor_idade`: um menor sem CPF aparece como "(sem CPF)" para ela.

## 15. Limites de login, trilha sem login digitado e endurecimento do compose (migração 0008): deploy MANUAL

Muda `docker-compose.prod.yml`, então o `deploy-vps.sh` sai com código 2 (infra só à mão). Junto vão a API (bloqueio
por par login+IP, trilha sem o texto digitado no login), a migração 0008 e o front (campo de foto retirado).

**Compose (valores conservadores, VPS compartilhada com o Tobe):**

| Serviço | Mudança | Motivo |
|---|---|---|
| api | `cpus: 1.0`, `pids_limit: 200` (o `mem_limit: 384m` já existia) | Um núcleo no máximo: rajada de login (2 argon2 simultâneos) fica mais lenta para a portaria, não para o Tobe. O Node usa poucas dezenas de threads; 200 só segura fork bomb ou vazamento |
| db | `cap_drop: [ALL]` + `cap_add: [CHOWN, DAC_READ_SEARCH, FOWNER, SETGID, SETUID]` | Só o que o entrypoint da imagem oficial usa como root antes de descer para `postgres`. Testado no Docker Desktop com `postgres:17-alpine`: volume novo (bootstrap inteiro), reinício, volume com dono `root` (o entrypoint corrige), `pg_dump` e `psql` por `exec`. O servidor roda sem capability efetiva. Sem `SETUID`/`SETGID` o container não sobe (`failed switching to 'postgres'`); sem `DAC_READ_SEARCH` também não (`find: Permission denied`) |

**Passos na VPS** (depois do backup da seção 8):

```bash
cd /opt/tcc-portaria && git pull --ff-only
docker compose build
docker compose up -d --wait        # recria db (capabilities) e api; migrate aplica a 0008 em todos os bancos
docker compose ps -a               # db/api healthy; permissoes/migrate Exited (0)
docker compose logs migrate | grep migrar-bancos    # termina em ok (plataforma + N condomínio(s))
docker inspect tcc-portaria-db-1 --format '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}}'
docker inspect tcc-portaria-api-1 --format '{{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}'
```

O `db` é recriado (a mudança de capabilities exige): alguns segundos de API sem banco (`/saude` com `banco: erro`).
Fazer fora do horário de pico da portaria.

**nginx:** atualizar o site conforme a seção 5.1 (zonas `tcc_login`/`tcc_api`, `server_tokens off`, `limit_req` no
login e em `/api/`), `nginx -t && systemctl reload nginx`. Conferir que um login normal (pelo front em `www.condenexo.com.br`) continua 200.
**Não** testar o 429 contra a produção (seção 10).

**Migração 0008:** só alarga o CHECK de `login_limite.tipo` para aceitar `login_ip`. Não destrutiva. Rollback da
imagem sem desfazer a migração é compatível: a imagem anterior ignora as linhas `login_ip` e volta a bloquear por
login (o comportamento antigo). Desfazer a migração exige antes apagar essas linhas como `app_migrator`.

**Trilha:** a partir deste deploy, `auth.login_falha` e `auth.bloqueio` não gravam o login digitado (login existente:
só o ator; inexistente: `usuario_nome = '(login inexistente)'`). As linhas antigas continuam com o texto digitado
(dígitos mascarados): a trilha é append-only e elas só saem com a retenção da trilha.

## 16. SaaS: provisionar um condomínio novo (CLI `provisionar-condominio`)

Desenho e regras em `docs/05_arquitetura_saas.md` (SAAS-10, "Provisionamento"); código em
`src/plataforma/provisionar.ts` e `src/cli/provisionar-condominio.ts`.

### 16.1 Deploy desta versão (uma vez; MANUAL: o `deploy-vps.sh` sai com código 2)

Muda `Dockerfile` (a imagem da API passa a levar `drizzle/`, lido pela CLI), os dois compose (serviço
`provisionar-cli`, perfil `provisionar`), `db/bootstrap/10_plataforma.sh` (`app_provisionador` vira membro de
`app_migrator` só com SET) e `.env.producao.example`. Migrações novas, só *expand*: `drizzle/0010_configuracao.sql`
(tabela `configuracao`, vazia no piloto: nada muda para ele) e `drizzle-plataforma/0002_cadastro_modulos.sql`
(`condominio.cidade`, `uf`, `modulos`; o piloto fica com todos os módulos).

```bash
cd /opt/tcc-portaria
sudo systemctl start tcc-portaria-backup.service                         # 1. backup antes
TAG_ANTERIOR="$(sed -n 's/^API_TAG=//p' .env)"; echo "$TAG_ANTERIOR"      #    anotar para o rollback
git fetch && git checkout --detach origin/main                            # 2. código e imagens
sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env
docker compose build && docker compose up -d --wait                       # 3. migrate (0010 + plataforma 0002) e API
docker compose exec -T db sh /docker-entrypoint-initdb.d/10_plataforma.sh # 4. membership SET-only (idempotente)
pw() { openssl rand -base64 32 | tr -d '/+=\n'; }                         # 5. senha do provisionador, gerada aqui
grep -q '^APP_PROVISIONADOR_PASSWORD=.' .env || { sed -i '/^APP_PROVISIONADOR_PASSWORD=$/d' .env; printf 'APP_PROVISIONADOR_PASSWORD=%s\n' "$(pw)" >> .env; }
printf "ALTER ROLE app_provisionador LOGIN PASSWORD '%s';\n" "$(sed -n 's/^APP_PROVISIONADOR_PASSWORD=//p' .env)" \
  | docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres   #    por stdin, sem eco
install -m 755 -o root -g root scripts/deploy/deploy-vps.sh /usr/local/sbin/tcc-portaria-deploy   # 6. se mudou
```

Conferir:

- `docker compose logs migrate | grep migrar-bancos` termina em `ok (plataforma + 1 condomínio(s))`;
- `docker compose exec -T db psql -U postgres -tAc "select a.inherit_option, a.set_option, r.rolcanlogin, r.rolcreatedb from pg_auth_members a join pg_roles r on r.oid = a.member where a.roleid = 'app_migrator'::regrole and r.rolname = 'app_provisionador'"`
  imprime `f|t|t|t` (sem herdar, com SET, com login, CREATEDB);
- a matriz de CONNECT da seção 12.3 continua `f|f|t|f` (o provisionador **não** entra no `portaria`);
- portaria do piloto: login, "Verificar integridade" e o rótulo "Bloco" nas unidades como antes.

**Rollback:** imagem anterior (`API_TAG=$TAG_ANTERIOR`, `docker compose up -d --wait`). As duas migrações ficam: a
imagem anterior não lê `configuracao` nem as colunas novas. Para tirar o login do provisionador:
`ALTER ROLE app_provisionador NOLOGIN` (mesma via stdin).

### 16.2 Criar um condomínio em produção

1. Preparar a entrada **na VPS** (tem o nome do síndico: dado pessoal, fora do clone e fora do git), com `umask 077`.
   Exemplo com dados fictícios:

   ```bash
   umask 077; mkdir -p /root/provisionamento
   cat > /root/provisionamento/<slug>.json <<'JSON'
   { "codigo": "<slug>", "nome": "<nome exibido>", "cidade": "<cidade>", "uf": "SP", "plano": "padrao",
     "estrutura": { "agrupamento": "Torre", "blocos": ["1", "2", "3"], "andares": [0, 1, 2, 3], "finais": [1, 2, 3, 4], "ausentes": ["01"] },
     "areasComuns": ["Salão de festas", "Piscina"],
     "sindico": { "nome": "<nome do síndico>", "login": "<login>" } }
   JSON
   ```

   `codigo`: o que a portaria digita no login (3 a 31, `a-z0-9-`, começa por letra). `estrutura`: mesma regra do
   `ESTRUTURA_PADRAO` (número = andar × 10 + final; `ausentes` "01" vale para todos os blocos, "A-01" só para um).
   `areasComuns` é opcional (padrão: a lista do piloto). Exceções da grade entram depois pelo CRUD ou pela planilha.

   **Alternativa à grade: lista explícita** (desde 2026-10-23; é o que a tela do Master manda). No lugar de
   `estrutura`, `agrupamento` no nível de cima e `unidades` com cada `{ bloco, numero }`; serve para condomínio que
   não segue andar × 10 + final (cobertura, casas, numeração de 3 ou 4 dígitos):

   ```json
   { "codigo": "<slug>", "nome": "<nome exibido>", "cidade": "<cidade>", "uf": "SP",
     "agrupamento": "Bloco",
     "unidades": [ { "bloco": "A", "numero": "101" }, { "bloco": "A", "numero": "102" }, { "bloco": "B", "numero": "03" } ],
     "sindico": { "nome": "<nome do síndico>", "login": "<login>" } }
   ```

   Regras (validadas antes de tocar em qualquer banco; erro de formato = 400 na API, recusa na CLI): **exatamente um**
   de `estrutura` ou `unidades`; `agrupamento` obrigatório com `unidades` (com `estrutura`, opcional e igual ao de
   dentro); `bloco` com 1 a 3 letras ou dígitos (vira maiúsculo) e `numero` canônico, só dígitos, 2 no mínimo e sem
   zero à esquerda além da dezena (`03`, `32`, `101`; `3` e `003` são recusados), os mesmos CHECKs `unidade_bloco_ck`
   e `unidade_numero_ck` do banco; sem repetidas; de 1 a 5000 unidades (`LIMITE_UNIDADES` do domain). A retomada
   (seção 16.3) compara o CONJUNTO de unidades, então a mesma lista em outra ordem retoma, e uma lista diferente é
   recusada sem mexer em nada. `plano` é opcional nos dois formatos (padrão `padrao`).

2. Rodar (backup antes, como em toda escrita):

   ```bash
   cd /opt/tcc-portaria
   sudo systemctl start tcc-portaria-backup.service
   docker compose --profile provisionar run --rm -T provisionar-cli < /root/provisionamento/<slug>.json
   ```

   O `-T` é obrigatório (o JSON vem pelo stdin). Saída: um JSON (`"situacao": "provisionado"`, `banco`, `unidades`,
   `modulos`, impressões das duas chaves) e, **uma vez, só no terminal**, o bloco "SENHA TEMPORÁRIA DO SÍNDICO" com o
   código do condomínio, o login e a validade (72 h; troca obrigatória no primeiro login). Não redirecionar o stderr
   para arquivo. O serviço roda com `logging: none` (o `docker logs` não guarda a senha) e `--rm`. Entregar a senha ao síndico por canal fora do sistema (pergunta 8 do doc de arquitetura).

3. Conferir e limpar:

   - `docker compose exec -T db psql -U postgres -d plataforma -tAc "select status, banco from condominio where codigo = '<slug>'"` → `ativo|portaria_xxxxxxxx`;
   - em até 1 min (cache do resolvedor), o login com o código `<slug>` funciona no front; o cabeçalho mostra o nome;
   - o próximo `deploy`/`up` migra o banco novo junto (`migrar-bancos: portaria_xxxxxxxx`), e o próximo backup grava
     `condominio-portaria_xxxxxxxx-<carimbo>.dump.age` (os dois só olham `ativo`/`suspenso`/`encerrado`);
   - `shred -u /root/provisionamento/<slug>.json` depois que o síndico entrar (até lá serve para retomar ou para
     `--nova-senha-sindico`).

Rodar de novo com a mesma entrada responde `ja_provisionado` e não mexe em nada (nem gera senha). Entrada diferente
para um código existente (outro nome, cidade, UF ou plano) é recusada.

### 16.3 Falha no meio, retomada e rollback

A CLI só marca `ativo` depois da verificação final; até lá o condomínio fica `provisionando`, e a API, o laço de
migração e o backup o ignoram. Qualquer falha (rede, migração, verificação) sai com código 1 e a mensagem.

- **Retomar:** corrigir a causa e rodar o mesmo comando com o **mesmo** JSON. Cada passo confere o que já existe: o
  banco já criado é reaproveitado (precisa ter dono `app_migrator`), migrações aplicam só o que falta, configuração e
  unidades precisam bater com a entrada, e a senha do síndico é **regerada** (a anterior nunca foi mostrada).
  Resposta: `"situacao": "retomado"`.
- **Desfazer** (desistir de um provisionamento que ficou `provisionando`): como superusuário, nesta ordem.
  Nada disso existe para um condomínio `ativo` (lá é fim de contrato, SAAS-11/F7). A plataforma não tem linha de
  `plataforma_audit` dele (ela só é gravada na ativação), então as duas linhas saem sem furar a trilha.

  ```bash
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d plataforma -tAc \
    "select id, banco from condominio where codigo = '<slug>' and status = 'provisionando'"      # anotar id e banco
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'DROP DATABASE IF EXISTS "<banco>" WITH (FORCE)'
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d plataforma \
    -c "delete from condominio_chave where condominio_id = '<id>'" \
    -c "delete from condominio where id = '<id>' and status = 'provisionando'"
  ```

  Apagar as chaves é o *crypto-shredding* (SAAS-04): nada foi cifrado com elas além do que o `DROP` já levou.
- **Senha temporária vencida antes do primeiro login** (condomínio já `ativo`): o mesmo comando com
  `node dist/cli/provisionar-condominio.js --nova-senha-sindico` no fim (depois de `provisionar-cli`). Só funciona
  enquanto o síndico nunca entrou; depois disso a senha é dele.

---

## 17. Prazo de permanência (migração 0011): deploy automático serve, API ANTES do front

Só código da API, do front e uma migração nova (nada de infra). `drizzle/0011_permanencia.sql` é só *expand*: enum
`tipo_visita`, tabela `permanencia` vazia, triggers dela e `GRANT SELECT, INSERT` para o `app_rw`. Não toca
`evento_acesso`, a canonização nem o hash; nenhuma linha existente muda e não há backfill. O laço do `migrate`
(`scripts/migrar-bancos.mjs`) aplica a 0011 em **cada** banco de condomínio (piloto e provisionados); condomínio
provisionado depois já nasce com ela.

- **Ordem:** a API (e a migração) antes do front. O front novo só manda `tipoVisita` quando a portaria escolhe um
  tipo diferente do padrão; diante da API anterior (DTO estrito) essa entrada volta 400 até a API nova subir. Se a
  Vercel publicar primeiro, a janela é a do deploy da API: avisar a portaria ou segurar o deploy do front.
- **Conferir:** `docker compose logs migrate | grep migrar-bancos` termina em `ok (plataforma + N condomínio(s))`;
  em cada banco, `\dp permanencia` mostra `app_rw=ar` (SELECT e INSERT, sem UPDATE/DELETE).
- **Quem já está dentro** na hora do deploy fica sem prazo (`permanencia: null`) e mantém o alerta antigo de 8 h; o
  botão "+1h" só aparece para entradas registradas depois.
- **Rollback da imagem:** compatível. A API anterior não lê nem grava a tabela; entradas feitas por ela ficam sem
  prazo. Desfazer a 0011 (DROP) não é necessário e apagaria os prazos e as prorrogações (a trilha
  `permanencia.prorrogar` no `audit_log` fica).

---

## 18. App do Master, F5 entrega 1 (migração `drizzle-plataforma/0003`): deploy MANUAL

> **2026-10-23: o Master entra SEM segundo fator** (decisão do usuário; SAAS-08). O TOTP descrito na entrega 1 saiu do
> código e do banco pela migração `drizzle-plataforma/0004_master_sem_totp.sql`. Em produção, onde a 0003 já está
> aplicada e o Master já existe, siga **18.7**. As subseções abaixo já descrevem o fluxo sem TOTP.

Desenho em `docs/05_arquitetura_saas.md` §5.3 (SAAS-07/08). Código: `src/plataforma/` (rotas `/api/v1/plataforma/*`),
`src/cli/criar-usuario-plataforma.ts`, `src/cli/servidor-provisionador.ts` e o front `apps/plataforma` (no Front)
(outro projeto Vercel). Muda compose, Dockerfile e `.env.producao.example`: o `deploy-vps.sh` sai com código 2.

**O que muda em produção:**

- migração `drizzle-plataforma/0003_master_auth.sql`, só *expand*, aplicada pelo serviço `migrate` (laço de sempre):
  colunas novas em `master_usuario` e `master_sessao` (tabelas vazias até aqui) e o tipo `master_ip` no limite de login
  da plataforma. Nenhum banco de condomínio muda; `evento_acesso`, a cadeia e a trilha do condomínio não são tocados.
  `master_usuario.totp_mestra_versao` é NOT NULL sem default: se alguém tiver inserido Master à mão, a migração falha
  (de propósito) e o deploy para antes da API nova;
- a API ganha as rotas `/api/v1/plataforma/*` (login com e-mail e senha, sem 2FA desde 2026-10-23; sessão própria, lista de condomínios, criação,
  módulos). O login, o cookie e as guardas do condomínio continuam iguais;
- dois serviços novos no compose, **fora do `up`** (perfis): `provisionador` (perfil `provisionar`, chamado pela tela
  "Novo condomínio") e `usuario-plataforma-cli` (perfil `plataforma`, bootstrap do Master).

### 18.1 Deploy da API (uma vez)

```bash
cd /opt/tcc-portaria
sudo systemctl start tcc-portaria-backup.service                         # 1. backup antes
TAG_ANTERIOR="$(sed -n 's/^API_TAG=//p' .env)"; echo "$TAG_ANTERIOR"      #    anotar para o rollback
git fetch && git checkout --detach origin/main                            # 2. código e imagens
sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env
tok() { openssl rand -base64 48 | tr -d '/+=\n'; }                        # 3. token API <-> provisionador, gerado aqui
grep -q '^PROVISIONADOR_TOKEN=.' .env || { sed -i '/^PROVISIONADOR_TOKEN=$/d' .env; printf 'PROVISIONADOR_TOKEN=%s\n' "$(tok)" >> .env; }
grep -q '^PROVISIONADOR_URL=.' .env || { sed -i '/^PROVISIONADOR_URL=$/d' .env; printf 'PROVISIONADOR_URL=http://provisionador:3200\n' >> .env; }
docker compose build && docker compose up -d --wait                       # 4. migrate (plataforma 0003) e API
```

Conferir:

- `docker compose logs migrate | grep migrar-bancos` termina em `ok (plataforma + N condomínio(s))`;
- `docker compose exec -T db psql -U postgres -d plataforma -tAc "select count(*) from drizzle.__drizzle_migrations"` = 4;
- `curl -s -o /dev/null -w '%{http_code}\n' https://<vps>/api/v1/plataforma/auth/me` = `401` (rota no ar, sem sessão);
- a portaria do piloto entra e "Verificar integridade" dá `ok`, como antes.

`PROVISIONADOR_URL`/`PROVISIONADOR_TOKEN` vazias deixam a criação pela tela desligada (503); a CLI da seção 16 continua
valendo. Com elas preenchidas mas o serviço parado, a tela também responde 503 ("O provisionador não respondeu").

### 18.2 Bootstrap do primeiro Master (terminal comum)

> **Rodar num terminal SSH comum, NUNCA pelo `!` do Claude Code nem por ferramenta que grave a saída.** A saída traz a
> senha temporária: pelo `!` ela entraria no histórico da conversa e nos servidores do provedor do assistente. O
> serviço roda com `logging: none` e `--rm`.

```bash
cd /opt/tcc-portaria
docker compose --profile plataforma run --rm usuario-plataforma-cli --email <e-mail> --nome "<nome>"   # papel master
```

- Saída: só a senha temporária (72 h, troca obrigatória no primeiro login). Fica guardada só como argon2id.
- E-mail já cadastrado: `RECUSADO`, código 1, nada muda. Funcionário de suporte (só consulta): `--papel suporte`.
- Senha esquecida ou suspeita de vazamento: `... usuario-plataforma-cli --email <e-mail> --nova-senha` (temporária nova,
  troca obrigatória, todas as sessões dele encerradas). Fica em `plataforma_audit` (`master.reemitir_credencial`).
  `--reemitir-totp` não existe mais (erro de uso, código 2).
- Primeiro acesso: no app da plataforma, e-mail + senha temporária, e em seguida a troca de senha, que exige **no mínimo
  16 caracteres** (a do condomínio é 12). Sem segundo fator, a senha é a única barreira: gere-a e guarde-a num
  **gerenciador de senhas**, sem reutilizar em nenhum outro lugar.

### 18.3 App do Master servido em /admin (mesmo projeto Vercel; nada a criar no painel)

> Escrito no monorepo; hoje esse código está em CondeNexo.Front (antigos `apps/web` e `apps/plataforma`; a estrutura interna do Front é
> dele e pode mudar). Os passos 1 e 2 abaixo (build `build:admin` do `@portaria/plataforma`, Root Directory `apps/web`) não se
> aplicam a este repositório: ver CondeNexo.Front.

Decisão do usuário (2026-10-23, SAAS-08): **sem projeto Vercel separado**. O app do Master é servido em `/admin` do
mesmo site e do mesmo projeto do `apps/web` (Root Directory `apps/web`), como bundle separado:

1. O `build` do `apps/web` roda `vite build` do web e, em seguida, `build:admin` do `@portaria/plataforma`, que grava em
   `apps/web/dist/admin/` (`base: '/admin/'`, assets em `/admin/assets`). A ordem importa: o build do web limpa o `dist`.
2. O `apps/web/vercel.json` reescreve `/admin` e `/admin/*` (menos `/admin/assets/*`) para `/admin/index.html`, antes do
   catch-all, e põe `X-Robots-Tag: noindex` e `Cache-Control: no-store` no admin. CSP e demais cabeçalhos são os do site.
3. O service worker do web não cobre o admin (`navigateFallbackDenylist` e `globIgnores`); o app do Master não registra SW.
4. `VITE_API_URL` não é necessária: o padrão `/api/v1` cai no mesmo rewrite para a API. `CORS_ORIGENS` continua vazia.
5. URL: `https://<site>/admin/`. Previews continuam desligados (seção 6).
6. Recomendação operacional: usar o Master em um **perfil de navegador separado**, sem login de portaria (ver risco
   aceito em SAAS-08).

### 18.4 nginx: limite do login da plataforma (documentado; NÃO aplicado)

Acrescentar ao arquivo do site da seção 5.1 (zona no topo, `location` dentro do `server` 443), com `nginx -t` antes do
`reload`. Mais apertado que o do condomínio (poucos usuários, nenhum atrás do NAT de uma guarita):

```nginx
limit_req_zone $binary_remote_addr zone=tcc_plat_login:10m rate=10r/m;

    # Login do Master: 10/min por IP de conexão, rajada de 5. Regex sem diferenciar maiúsculas: o Express casa a rota
    # sem diferenciar (/API/V1/PLATAFORMA/AUTH/LOGIN chega ao mesmo handler) e um `location =` deixaria essa grafia sem limite.
    location ~* ^/api/v1/plataforma/auth/login/?$ {
        limit_req zone=tcc_plat_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
    # Criação de condomínio pela tela: CREATE DATABASE + migrações levam alguns segundos (o cliente espera até 150 s).
    location ~* ^/api/v1/plataforma/condominios/?$ {
        limit_req zone=tcc_api burst=10 nodelay;
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 150s;
    }
```

O `location = /api/v1/auth/login` da seção 5.1 tem a mesma brecha de maiúsculas (o limite da aplicação continua
valendo nos dois casos); trocar por `~*` na próxima mexida no nginx.

### 18.5 Criar condomínio pela tela

1. Backup (`sudo systemctl start tcc-portaria-backup.service`). O provisionador fica **sempre ligado** desde
   2026-10-24 (sem perfil no `docker-compose.prod.yml`, `restart: unless-stopped`; sobe com o `up -d` do deploy).
   Se alguém o parou: `docker compose up -d provisionador`.
2. No app da plataforma: Licenças → Novo condomínio. É um assistente em 4 passos (Voltar mantém o que foi
   preenchido):
   1. **Condomínio**: nome; o código é sugerido a partir do nome (editável; é o que a portaria digita no login e não
      muda depois); cidade e UF. O plano não aparece: vai `padrao`.
   2. **Unidades**: Bloco ou Torre; a lista colada (uma por linha: `A-101`, `A 101`, `Bloco A 101`, `Torre 2 - 34`,
      `A;101`) **ou** uma planilha CSV/XLSX (uma coluna `A-101` ou duas, bloco e número; cabeçalho opcional). A prévia
      agrupa por bloco e aponta linhas inválidas e repetidas, com o motivo e a opção de remover. O parser é o
      `lerListaUnidades` do domain, e a API valida de novo (formato da seção 16.2). Áreas comuns como etiquetas.
   3. **Síndico**: nome; login sugerido (`maria.souza`), editável.
   4. **Revisar e criar**: resumo, confirmação explícita ("não pode ser desfeita") e o botão Criar, que só habilita
      se `GET /api/v1/plataforma/provisionador/saude` responder `{ "disponivel": true }` (a API consulta o
      `GET /saude` do serviço, com o mesmo token e timeout de 3 s; só quem tem `condominio.criar`). Desligado: aviso
      com o comando do passo 1 e "Verificar de novo".

   A senha temporária do síndico aparece **uma vez**, com um "Copiar tudo" que monta o texto para o síndico (código,
   login, senha e `https://tccgestaoacesso.vercel.app/login`); entregar por canal fora do sistema. Ao fechar, a lista
   volta com o condomínio novo destacado.

   **Ordem de deploy desta versão (assistente, 2026-10-23):** API **antes** do front (a tela nova chama
   `GET /plataforma/provisionador/saude` e manda `unidades`; a API antiga responde 404 e 400). A imagem do serviço
   provisionador é a mesma da API: um container `provisionador` antigo ainda de pé responde 404 no `/saude`, e a tela
   mostra "desligado" até ele ser recriado (`docker compose --profile provisionar up -d provisionador`). Sem migração.
3. Sempre ligado por decisão do usuário (2026-10-24), trocando a defesa extra por comodidade. Risco aceito: quem
   invadir a API pode pedir condomínios novos enquanto ele está de pé (não lê dado, não apaga, não toca trilha; o
   CREATEDB e a senha do `app_migrator` ficam só neste container, não na API). Para voltar ao modo "ligar só para
   criar": `docker compose stop provisionador` e recolocar `profiles: [provisionar]` no compose de produção.

Falhou no meio (rede, timeout, provisionador derrubado): o condomínio fica `provisionando`, como na CLI; reenviar o
MESMO formulário retoma. Se a resposta se perdeu depois da ativação (a senha não chegou à tela), reenviar responde
`ja_provisionado` sem senha: gerar outra com a CLI (`--nova-senha-sindico`, seção 16.3). Fica em `plataforma_audit`
(`condominio.provisionar` com o Master como ator e `origem: plataforma`; `condominio.provisionar_falha`).

Timeout da Vercel: o rewrite externo tem limite de tempo de resposta do lado da Vercel; um provisionamento costuma levar
poucos segundos, mas se a Vercel cortar antes do fim, vale o parágrafo acima (retomar ou nova senha pela CLI).

### 18.6 Rollback

> Depois da 18.7 (0004 aplicada), voltar a uma imagem anterior a ela **quebra as rotas `/plataforma`** dessa imagem
> (selecionam colunas que não existem mais); a portaria não é afetada. Ver o rollback na 18.7.

- **API:** imagem anterior (`API_TAG=$TAG_ANTERIOR`, `docker compose up -d --wait`). A 0003 fica: a imagem anterior não
  lê as colunas novas nem usa as tabelas do Master. As sessões do Master deixam de valer (a imagem anterior não tem as
  rotas); a portaria não é afetada.
- **Desligar só o app do Master, sem trocar a API:** pausar o projeto Vercel `-plataforma` (Settings), esvaziar
  `PROVISIONADOR_URL`/`PROVISIONADOR_TOKEN` (`docker compose up -d api`) e desativar os usuários
  (`UPDATE master_usuario SET ativo = false`, como superusuário no banco `plataforma`): as sessões caem na próxima
  requisição.
- **Desfazer a 0003** não é necessário (só *expand*). Se exigido: com `master_usuario` vazia, como superusuário,
  `DROP COLUMN` das colunas novas, o CHECK antigo de `plataforma_login_limite` de volta e a linha da 0003 fora de
  `drizzle.__drizzle_migrations`.

### 18.7 Remover o TOTP do Master (migração `drizzle-plataforma/0004`, 2026-10-23)

Decisão do usuário (SAAS-08): login do Master só com e-mail e senha. **Risco aceito:** senha do Master vazada = acesso
total à plataforma. Compensações: senha de 16+ na troca, limite de tentativas, sessão curta (15 min / 8 h na época; 2 h / 12 h desde 2026-10-29, §22), IP na trilha da
plataforma, gerenciador de senhas.

**O que muda:** a 0004 faz `DROP` de `master_usuario.totp_cifrado`, `totp_mestra_versao`, `totp_ultimo_passo` (e dos dois
CHECKs), de `master_sessao.totp_confirmado_em` e da tabela `master_codigo_recuperacao` (nunca usada). É *contract*
direto: só a API nova roda depois. O segredo TOTP do Master existente é apagado (de propósito). **O Master existente
continua com a MESMA senha** e não precisa ser recriado; as sessões abertas continuam valendo até expirar. Nenhum banco de
condomínio muda. A imagem do `usuario-plataforma-cli` deixa de receber a chave mestra (o compose mudou, então o
`deploy-vps.sh` sai com código 2: siga os passos abaixo).

**Ordem:** o serviço `migrate` (laço `scripts/migrar-bancos.mjs`, como `app_migrator`, dono das tabelas) roda a 0004 no
banco `plataforma` ANTES de qualquer banco de condomínio, e o compose só sobe a `api` nova depois que ele termina com 0.
A API antiga (com TOTP) não funciona no schema novo, mas não chega a rodar contra ele, exceto num caso: **se o laço
falhar num banco de condomínio depois de aplicar a 0004**, a API antiga continua no ar e só as rotas `/plataforma` dela
quebram (500); a portaria segue normal. Corrigir o banco que falhou e repetir o `up`.

```bash
cd /opt/tcc-portaria
sudo systemctl start tcc-portaria-backup.service                         # 1. backup antes (o DROP não volta sem ele)
TAG_ANTERIOR="$(sed -n 's/^API_TAG=//p' .env)"; echo "$TAG_ANTERIOR"      #    anotar
git fetch && git checkout --detach origin/main                            # 2. código e imagens
sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env
docker compose build && docker compose up -d --wait                       # 3. migrate (plataforma 0004) e depois a API
```

Conferir:

- `docker compose logs migrate | grep migrar-bancos` termina em `ok (plataforma + N condomínio(s))`;
- `docker compose exec -T db psql -U postgres -d plataforma -tAc "select count(*) from drizzle.__drizzle_migrations"` = 5;
- colunas de TOTP sumiram (saída **vazia**):
  `docker compose exec -T db psql -U postgres -d plataforma -tAc "select column_name from information_schema.columns where table_name='master_usuario' and column_name like 'totp%'"`;
- `docker compose exec -T db psql -U postgres -d plataforma -tAc "select to_regclass('master_codigo_recuperacao')"` vazio;
- `docker compose exec -T db psql -U postgres -d plataforma -tAc "select count(*) from master_usuario"` = o mesmo de antes (o Master continua lá);
- `https://<site>/admin/`: a tela de login não tem mais o campo "Código do autenticador"; o Master entra com e-mail e a
  senha de sempre (o front novo sai pelo deploy da Vercel; com o front velho no ar, o login manda `codigo` e recebe 400:
  publicar o front junto, ou logo depois, da API);
- `docker compose exec -T db psql -U postgres -d plataforma -tAc "select acao, detalhes->>'ip' from plataforma_audit order by seq desc limit 3"` mostra o `auth.login` com o IP;
- a portaria do piloto entra e "Verificar integridade" dá `ok`, como antes.

**Depois:** se a senha atual do Master tem menos de 16 caracteres, ela continua valendo (a regra é só na troca). Para
aplicar já o novo mínimo: `--nova-senha` pela CLI (18.2) e trocar no primeiro acesso por uma de 16+ gerada no
gerenciador. Remover o autenticador do celular (o segredo não vale mais em lugar nenhum).

**Rollback:** voltar só a imagem (`API_TAG=$TAG_ANTERIOR`) NÃO devolve o TOTP: a imagem antiga lê colunas que a 0004
apagou e as rotas `/plataforma` dela respondem 500 (portaria intacta). Para voltar ao TOTP de verdade: restaurar o banco
`plataforma` do backup do passo 1 (perde o que a plataforma gravou depois) e subir a imagem anterior; ou, sem restaurar,
uma migração nova que recrie as colunas e um `--reemitir-totp` na CLI antiga. Preferir corrigir para frente.

---

## 19. Máscara do CPF com os 5 primeiros dígitos (migração 0012): deploy automático serve

Só código da API, do front e uma migração (nada de infra). `drizzle/0012_mascara_cpf_inicio.sql` troca o CHECK
`pessoa_documento_mascarado_ck` para aceitar os dois formatos (`***.456.789-**` e `123.45*.***-**`). Nenhuma linha
muda: as pessoas já cadastradas (7 no piloto) seguem no formato antigo e passam no CHECK novo, que o `ADD CONSTRAINT`
valida na hora. O laço do `migrate` (`scripts/migrar-bancos.mjs`) aplica a 0012 em **cada** banco de condomínio (piloto e
provisionados); condomínio provisionado depois já nasce com ela. Decisão e regra anti-reconstrução: spec §3.2 (`pessoa`)
e §14 nº 36.

- **Ordem:** a migração antes da API nova (o `migrate` já roda antes). API nova sobre o CHECK antigo recusaria todo
  cadastro novo com 500. O front pode subir antes ou depois: só mudam textos dos campos de busca.
- **Conferir:** `docker compose logs migrate | grep migrar-bancos` termina em `ok (plataforma + N condomínio(s))`; em
  cada banco, `SELECT documento_mascarado FROM pessoa WHERE documento_mascarado IS NOT NULL` continua igual ao de antes
  do deploy, e o primeiro cadastro novo sai como `123.45*.***-**`.
- **Rollback da imagem:** funciona (a API anterior só gera o formato antigo, que segue aceito), mas **quebra a regra
  anti-reconstrução**: ela corrigiria o CPF de quem já está no formato novo gravando o antigo, e cadastraria no antigo um
  CPF cuja máscara nova já existe. Se voltar a imagem, não corrigir CPF nem cadastrar pessoa até a API nova voltar.
  **Desfazer a 0012** só é possível
  enquanto não houver linha no formato novo: depois do primeiro cadastro, sem volta prática (o número não existe no banco
  para remascarar).

---

## 20. F5, entrega 2: leitura auditada do Master, "Acessos da plataforma" e `ModuloGuard`: deploy automático serve, API ANTES do front

Só código da API, do front (`apps/web` e `apps/plataforma`) e do domain. **Sem migração** (nem de condomínio nem da
plataforma), sem GRANT novo, sem variável nova, sem mudança de compose ou Dockerfile: o `deploy-vps.sh` não sai com
código 2. Desenho e decisões: `docs/05_arquitetura_saas.md` §5.4 (SAAS-09 e SAAS-19).

- **Ordem: a API antes do front.** O push na `main` publica o front na Vercel na hora. Empurrar primeiro só os commits
  da API (`git push origin <sha do último commit da API>:main`), esperar o `deploy-api.yml` terminar, conferir (abaixo)
  e só então empurrar o resto. Se o front subir antes: a portaria não quebra (sem `modulos` no `/auth/me` o front não
  esconde nada, e hoje todos os condomínios estão com todos os módulos ligados), mas a tela "Acessos da plataforma" e
  as abas do app do Master respondem 404 até a API nova subir.
- **Conferir a API:** `curl -s -o /dev/null -w '%{http_code}' https://<api>/api/v1/auditoria/acessos-plataforma` dá
  **401** (rota existe; 404 = API antiga). Logado como síndico, `GET /api/v1/auth/me` traz `modulos` com os 7 módulos.
- **Primeira leitura do Master (smoke, com chamado aberto):** no `/admin`, Licenças → "Abrir" no condomínio → aba
  Pessoas. Depois, logado como síndico daquele condomínio, a tela **Auditoria → Acessos da plataforma** mostra a
  linha `plataforma/<e-mail do Master>`, "Consulta", "Pessoas", `GET /pessoas`. É uma leitura de dado pessoal: só com
  motivo (SAAS-09, regra interna).
- **Módulos passam a valer:** desligar um módulo no modal "Módulos" do Master recusa as rotas dele com 403
  `MODULO_DESLIGADO` em até 1 min (na hora, na réplica que recebeu o PATCH). O menu da portaria se ajusta no próximo
  login ou recarga. Antes de desligar algo num condomínio real, combinar com o síndico: a tela some para todos.
- **Rollback da imagem:** compatível. A API anterior ignora `@Modulo` (nada é recusado), não tem as rotas de leitura do
  Master nem a de acessos (o front novo mostra erro nessas telas) e não manda `modulos` (o front novo não esconde
  nada). As linhas `plataforma.*` já gravadas ficam na trilha (append-only) e continuam aparecendo na "Trilha de
  alterações".

## 21. F5, entrega 3: Master gerencia os síndicos do condomínio: deploy automático serve, API ANTES do front

Só código da API, do front (`apps/web` e `apps/plataforma`) e do domain. **Sem migração** (nem de condomínio nem da
plataforma), sem GRANT novo, sem variável nova, sem mudança de compose ou Dockerfile: o `deploy-vps.sh` não sai com
código 2. Desenho e decisões: `docs/05_arquitetura_saas.md` §5.5.

- **Ordem: a API antes do front.** Empurrar primeiro só os commits da API (`git push origin <sha do último commit da
  API>:main`), esperar o `deploy-api.yml` terminar, conferir (abaixo) e só então empurrar o resto. Se o front subir antes:
  a aba "Síndicos" do `/admin` responde 404 (lista) até a API nova subir, e a tela "Acessos da plataforma" do condomínio
  continua funcionando (os campos novos `motivo`/`alvo` são opcionais no front).
- **Conferir a API:** `curl -s -o /dev/null -w '%{http_code}' -X POST https://<api>/api/v1/plataforma/condominios/00000000-0000-4000-8000-000000000000/sindicos`
  dá **401** (rota existe; 404 = API antiga).
- **Primeira ação real (com chamado aberto):** no `/admin`, Licenças → "Síndicos" no card → a ação, com o motivo citando o
  chamado e a sua senha. Depois, logado como síndico daquele condomínio, **Auditoria → Acessos da plataforma** mostra a
  linha `plataforma/<e-mail do Master>` com o tipo, o usuário afetado e o motivo. A senha temporária do síndico aparece
  uma vez: entregar por canal fora do sistema, como na criação do condomínio (§18.5).
- **Senha do Master errada na confirmação conta para o limite do login** (10 por e-mail+IP, 30 por IP em 15 min): depois
  disso o próprio login do Master naquele IP fica bloqueado até a janela passar.
- **A CLI continua:** `redefinir-senha` (operador da VPS, banco do piloto) e `provisionar-condominio --nova-senha-sindico`
  seguem valendo para quando o `/admin` não estiver disponível. O caminho normal passa a ser a tela.
- **Rollback da imagem:** compatível. A API anterior não tem as rotas de síndicos (o front novo mostra erro na aba) e
  devolve "Acessos da plataforma" sem `motivo`/`alvo` (o front mostra só o tipo). As linhas `plataforma.usuario_*` já
  gravadas ficam na trilha (append-only); na tela antiga do condomínio aparecem como "Consulta" de "Usuários do sistema",
  e o detalhe completo continua na "Trilha de alterações".

## 22. Prazos da sessão por tipo de uso e "Manter conectado" (migração 0014): deploy MANUAL, API ANTES do front

Muda `docker-compose.yml` e `docker-compose.prod.yml` (variáveis de sessão), então o `deploy-vps.sh` sai com código 2.
Junto vão a migração `drizzle/0014_sessao_manter_conectado.sql`, a API e o front (caixa "Manter conectado neste
computador" no login). Decisão do usuário de 2026-10-29 (spec §5.1, linha "Sessão").

| Quem | Sem uso | Total |
|---|---|---|
| Porteiro (sempre, mesmo marcando a caixa) e qualquer login sem a caixa | 4 h | 14 h |
| Síndico, administração e auditor com "Manter conectado" | 1 dia | 15 dias |
| Master (`/admin`) | 2 h | 12 h |

- **Variáveis:** `SESSAO_PADRAO_INATIVIDADE_MIN`, `SESSAO_PADRAO_ABSOLUTA_MIN`, `SESSAO_LONGA_INATIVIDADE_MIN`,
  `SESSAO_LONGA_ABSOLUTA_MIN`, todas opcionais (vazio = a tabela acima). As antigas `SESSAO_ABSOLUTA_MIN` e
  `SESSAO_INATIVIDADE_MIN` deixam de ser repassadas pelo compose; se chegarem à API por outro caminho, ela as ignora e
  loga `config.variavel_ignorada` (não derruba o boot). No `.env` da VPS elas ficam inertes: apagar as duas linhas.
- **Migração 0014:** `ADD COLUMN manter_conectado boolean DEFAULT false NOT NULL` em `sessao`, em cada banco de
  condomínio. Só catálogo (PostgreSQL 11+), sem reescrever a tabela: segura com a portaria em uso. Sessões abertas
  ficam `false` (prazo padrão, com o `expira_em` de 12 h já gravado): ninguém é deslogado pelo deploy.
- **Ordem: a API antes do front.** O front novo manda `manterConectado` só com a caixa marcada; a API anterior (DTO
  estrito) recusaria esse login com 400. Por isso dois pushes:

```bash
# 1) na máquina de desenvolvimento: só o commit da API (o front da Vercel é reconstruído sem mudança de tela)
git push origin <sha do commit da API>:main     # o deploy-api.yml sai com código 2 (infra): segue à mão
# 2) na VPS, como root, com backup antes (migração nova)
sudo systemctl start tcc-portaria-backup.service
cd /opt/tcc-portaria && git fetch && git checkout --detach origin/main
sed -i '/^SESSAO_ABSOLUTA_MIN=/d; /^SESSAO_INATIVIDADE_MIN=/d' .env
sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env
docker compose build api && docker compose build migrate     # um serviço por vez (dockerd 29.6.1)
docker compose up -d --wait                                  # o migrate aplica a 0014 em todos os bancos antes da API
docker compose ps -a                                         # api healthy; permissoes/migrate Exited (0)
docker compose logs migrate | grep migrar-bancos             # termina em ok (plataforma + N condomínio(s))
docker compose logs api | grep -c variavel_ignorada          # 0
# 3) de volta à máquina de desenvolvimento: o front
git push origin main
```

- **Conferir:** logado como síndico com a caixa marcada, `GET /api/v1/auth/me` traz `sessao.inatividadeMin: 1440` e
  `expiraEm` 15 dias à frente; o porteiro, mesmo marcando, `240` e 14 h. No `/admin`, o login do Master traz
  `inatividadeMin: 120`. Na trilha, `auth.login` passa a ter `manter_conectado` em `depois`.
- **Rollback da imagem:** compatível com a 0014 aplicada (a API anterior não lê a coluna e grava o default). Mas ela
  valida as sessões longas já abertas só pelo `expira_em` gravado (até 15 dias) com 30 min de inatividade: revogar
  essas sessões se o rollback for durar. O compose anterior volta a exigir/repassar as variáveis antigas (o de produção
  tinha padrão 720/30). Desfazer a 0014: `ALTER TABLE sessao DROP COLUMN manter_conectado` em cada banco, como
  `app_migrator`, só depois de voltar a imagem.

## 23. Meio de autorização "celular" (migração 0015): deploy automático serve, API ANTES do front

Migração `drizzle/0015_meio_celular.sql` (em cada banco de condomínio), API, domain e front (`apps/web`; o
`apps/plataforma` só ganha o rótulo pelo domain). Sem GRANT novo, sem variável, sem mudança de compose: o
`deploy-vps.sh` não sai com código 2. Decisão: spec §14 nº 38 (questionário com a equipe, 22/10/2026).

- **Migração 0015:** `ALTER TYPE meio_autorizacao ADD VALUE 'celular' BEFORE 'morador_presente'` (só catálogo) e troca de
  `evento_recusa_meio_ck` e `evento_morador_identificado_ck` (DROP + ADD; o ADD varre `evento_acesso` uma vez por CHECK,
  sob o lock do ALTER: segundos no tamanho do piloto). Roda na transação única do migrador; os CHECKs comparam
  `autorizado_por_tipo::text` justamente para não usar o valor novo antes do commit. Nenhum hash muda.
- **Ordem: a API antes do front.** O front novo oferece "Celular" na entrada e no filtro; a API anterior (zod com o enum
  antigo) recusaria com 400. Push dos commits da API primeiro, esperar o `deploy-api.yml`, conferir, depois o resto.
- **Conferir a API:** `GET /api/v1/eventos-acesso?meio=celular` logado como auditor dá **200** com lista (vazia no
  começo); 400 = API antiga. Depois do primeiro uso, "Auditoria → Integridade" continua válida.
- **Rollback da imagem:** compatível com a 0015 aplicada. A API anterior lê e verifica a cadeia normalmente (o meio entra
  no hash como texto), mas não conhece 'celular': o filtro `meio=celular` volta 400, o rótulo do meio sai vazio no CSV do
  relatório e na exportação do titular, a recusa por celular é recusada (400) e a correção pode tirar o autorizador de
  uma entrada por celular (o banco não impede: a correção não grava meio). Front anterior com eventos por celular: o
  chip sai vazio e o detalhe de uma **recusa** por celular quebra (`toLowerCase` de rótulo inexistente). Desfazer a
  0015 não é possível depois de usada (PostgreSQL não remove valor de enum, e os eventos são append-only).
