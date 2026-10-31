# Rotação da chave mestra e da KEK dos anexos (produção)

Runbook da CLI `rotacionar-chaves` (`src/cli/rotacionar-chaves.ts`, regras em `src/plataforma/rotacao-chaves.ts`,
testes em `test/rotacao-chaves.test.ts`). Desenho: `docs/05_arquitetura_saas.md` SAAS-04 ("Rotação") e
`docs/02_especificacao_tecnica.md` §9.2.

Motivo desta execução: `PORTARIA_CHAVE_MESTRA` (v1) e `PORTARIA_KEK` (v1, a KEK do piloto `parque`) vazaram em texto puro.
Os dois condomínios (`parque` → banco `portaria`, `aguas-rasas` → banco `portaria_ts864rv9`) têm as chaves embrulhadas pela
mestra v1, então os dois trocam de KEK. A `PORTARIA_HMAC_CPF_KEY` **não** vazou e **não** é rotacionável: só é
re-embrulhada pela mestra nova (o valor não muda).

**Rodar num terminal comum (ssh direto), nunca pelo `!` do Claude Code nem colando saída em chat:** o passo 3 mostra a
mestra nova uma vez na tela, para o cofre. Nenhum outro comando imprime chave.

## Segredos

| Segredo | Vazou? | O que acontece | `.env` no fim | Cofre no fim |
|---|---|---|---|---|
| `PORTARIA_CHAVE_MESTRA` v1 | **sim** | trocada pela v2 (passos 3 a 5); as 4 linhas de `condominio_chave` re-embrulhadas | v2 | v2 nova. v1 marcada **COMPROMETIDA**, guardada só enquanto existir backup anterior à rotação (ele só abre com a v1); depois, apagar |
| `PORTARIA_KEK` v1 (= KEK v1 do `parque`) | **sim** | KEK v2 do `parque` gerada pela CLI (passo 6); as DEKs migram para a v2 (passo 8). A v1 fica registrada **inativa** na plataforma | `PORTARIA_KEK=` e `PORTARIA_KEK_VERSAO=` **vazias** | marcar **COMPROMETIDA**; mesma regra da mestra v1 |
| KEK v1 do `aguas-rasas` | indiretamente (só existe embrulhada pela mestra v1) | trocada pela v2, como a do `parque` | — (nunca esteve no `.env`) | — |
| `PORTARIA_HMAC_CPF_KEY` (`parque`) e HMAC do `aguas-rasas` | não | nada; só re-embrulhadas pela mestra v2 | inalterada (ver "Decisão pendente") | inalterada |
| Senhas de banco, `PROVISIONADOR_TOKEN` | não (segundo o levantamento) | nada | inalteradas | — |

As KEKs v2 não vão para o `.env` nem para o cofre: existem só embrulhadas no banco `plataforma` (como a do `aguas-rasas`
já existia). A recuperação delas é **mestra v2 (cofre) + dump do `plataforma`** (backup).

## O que cada modo faz

| Comando | Papel de banco | Escreve |
|---|---|---|
| *(sem flag)* / `--dry-run` | `app_plataforma` (plataforma), `app_rw` (cada banco de condomínio) | nada. Desembrulha **todas** as linhas e confere a DEK de cada anexo com a KEK da versão dele. Código 1 se algo não abrir |
| `--mestra` | `app_migrator` no banco `plataforma` (dono da tabela: `app_plataforma` só tem `UPDATE (ativa)` em `condominio_chave` e o trigger `condominio_chave_imutavel` só aceita embrulho novo com `mestra_versao` maior) | uma transação: `LOCK TABLE condominio_chave` contra escrita, re-embrulho de todas as linhas, releitura e comparação com o claro original, `COMMIT` (ou `ROLLBACK` total). Repetir = `ja_rotacionada`. Estado misto = recusa |
| `--kek-preparar --condominio <c> --kek-versao-atual <n>` | `app_plataforma` | uma transação: KEK nova (32 bytes do CSPRNG) como `versao n+1` **ativa**, a `n` **inativa** (o índice só admite uma ativa por tipo), ida e volta. Repetir com o mesmo `n` = `ja_preparada` (não cria uma terceira versão) |
| `--kek-migrar --condominio <c> [--lote 200]` | `app_plataforma` (só lê as KEKs), `app_rw` no banco do condomínio (`UPDATE` em `documento`, que ele já tem) | em lotes (uma transação por lote): re-embrulha a DEK de cada anexo fora da versão ativa, confere a ida e volta, `COMMIT`. O arquivo cifrado não muda. Queda no meio: rodar de novo continua |

"Inativa" **não** é "descartada": a API carrega todas as versões da KEK e lê cada anexo pela versão gravada nele
(`documento.chave_versao`), então nenhum anexo fica sem chave em nenhum instante da rotação. Anexo novo usa sempre a ativa.

## 0. Pré-requisitos

- Este commit no ar. Ele muda `docker-compose.prod.yml` (serviço `rotacao-cli`, e as chaves antigas do `plataforma-cli`
  passam de `:?` para `:-`: com `:?`, esvaziar `PORTARIA_KEK` no `.env` faz **todo** `docker compose ...` falhar, inclusive
  o `up` da API), então o deploy é **manual** (o `deploy-vps.sh` sai com código 2). A API nova se comporta igual à antiga
  enquanto só existe uma versão de KEK.

  ```bash
  cd /opt/tcc-portaria
  sudo systemctl start tcc-portaria-backup.service
  TAG_ANTERIOR="$(sed -n 's/^API_TAG=//p' .env)"; echo "$TAG_ANTERIOR"     # anotar
  git fetch && git checkout --detach origin/main
  sed -i "s|^API_TAG=.*|API_TAG=$(git rev-parse --short HEAD)|" .env
  docker compose config --quiet && docker compose build && docker compose up -d --wait
  docker compose logs --since 5m api | grep saas.boot     # condominios=2 piloto=sim ambiente=hmac_cpf+kek_documentos+kek_versao
  ```

- **Backup verificado, imediatamente antes:** `sudo systemctl start tcc-portaria-backup.service`, conferir no
  `journalctl -u tcc-portaria-backup -n 30` os dumps `portaria`, `plataforma` e `condominio-portaria_ts864rv9`, a cópia
  externa (seção 8 do `docs/deploy.md`) e o restore de teste (seção 12.2) com `CONFERE`. Anotar o carimbo.
- Cópia do `.env` de agora (rollback). Ela contém as chaves vazadas: é apagada no passo 10.

  ```bash
  (umask 077; cp .env .env.antes-rotacao)
  ```

- Ninguém criando condomínio durante a janela (o provisionador é parado no passo 3).

## 1. Dry-run inicial

```bash
cd /opt/tcc-portaria
docker compose --profile rotacao run --rm -T rotacao-cli
```

Esperado: código 0, `"linhas": 4`, `"porMestraVersao": {"1": 4}`, `"porTipoVersao": {"hmac_cpf:v1:ativa": 2,
"kek_documentos:v1:ativa": 2}`, `"falhas": 0`, e os dois condomínios com `documentos.total` igual ao número de anexos
(hoje 0). Qualquer outra coisa: parar.

## 2. Parar o provisionador

Ele embrulha as chaves de condomínio novo com a mestra **do ambiente dele**: um condomínio criado depois do passo 4 e antes
do passo 5 nasceria na mestra v1 (estado misto).

```bash
docker compose stop provisionador
```

## 3. Gerar a mestra nova (só na sessão) e guardar no cofre

```bash
export PORTARIA_CHAVE_MESTRA_NOVA="$(openssl rand -base64 32)"
export PORTARIA_CHAVE_MESTRA_VERSAO_NOVA=2
# impressão digital (não é a chave): anotar junto da cópia do cofre
{ printf 'portaria:impressao:v1:'; printf '%s' "$PORTARIA_CHAVE_MESTRA_NOVA" | base64 -d; } | sha256sum | cut -c1-16
# UMA vez na tela, para copiar ao cofre; Enter limpa a tela e o scrollback
printf '%s\n' "$PORTARIA_CHAVE_MESTRA_NOVA"; read -r _; clear; printf '\033[3J'
```

No cofre: entrada nova "PORTARIA_CHAVE_MESTRA v2 (<data>)" com a impressão. Conferir na máquina do cofre com o comando da
seção 12.3 do `docs/deploy.md` (`pbpaste | node -e ...`): as duas impressões têm de bater. Não seguir sem isso.

O valor fica só na memória do shell (o `history` guarda o comando, não o valor). O `docker compose` passa a variável do
shell para o `rotacao-cli` (o shell vence o `.env`); a mestra atual vem do `.env`.

## 4. Rotacionar a mestra

```bash
docker compose --profile rotacao run --rm -T rotacao-cli                  # dry-run com a nova: "mestraNova": {"versao": 2, "situacao": "a_rotacionar", "linhasAReembrulhar": 4}
docker compose --profile rotacao run --rm -T rotacao-cli node dist/cli/rotacionar-chaves.js --mestra
```

Esperado: `"situacao": "rotacionada"`, `"linhas": 4`, `"mestraVersao": 2`. Falha = nada foi gravado (transação única):
corrigir e repetir. Repetir depois de sucesso responde `ja_rotacionada`.

A API em execução continua atendendo (as chaves dos dois condomínios já estão desembrulhadas na memória dela), mas **não
pode reiniciar com o `.env` antigo** a partir daqui (recusaria o boot): fazer o passo 5 em seguida.

## 5. `.env` (mestra v2, KEK legada vazia) e reinício

```bash
(umask 077; awk 'BEGIN { m = ENVIRON["PORTARIA_CHAVE_MESTRA_NOVA"]; v = ENVIRON["PORTARIA_CHAVE_MESTRA_VERSAO_NOVA"]; if (m == "" || v == "") exit 1 }
  /^PORTARIA_CHAVE_MESTRA=/        { print "PORTARIA_CHAVE_MESTRA=" m; n++; next }
  /^PORTARIA_CHAVE_MESTRA_VERSAO=/ { print "PORTARIA_CHAVE_MESTRA_VERSAO=" v; n++; next }
  /^PORTARIA_KEK=/                 { print "PORTARIA_KEK="; n++; next }
  /^PORTARIA_KEK_VERSAO=/          { print "PORTARIA_KEK_VERSAO="; n++; next }
  { print }
  END { if (n != 4) exit 2 }' .env > .env.novo) && mv .env.novo .env || { rm -f .env.novo; echo FALHOU; }
unset PORTARIA_CHAVE_MESTRA_NOVA PORTARIA_CHAVE_MESTRA_VERSAO_NOVA
grep -c '^PORTARIA_CHAVE_MESTRA_VERSAO=2$' .env                         # 1
grep -cE '^PORTARIA_KEK(_VERSAO)?=$' .env                               # 2
{ printf 'portaria:impressao:v1:'; sed -n 's/^PORTARIA_CHAVE_MESTRA=//p' .env | tr -d '\n' | base64 -d; } | sha256sum | cut -c1-16   # = a do passo 3
stat -c '%a' .env                                                       # 600
docker compose config --quiet && docker compose up -d --wait            # recria api e provisionador (ambiente mudou)
docker compose logs --since 5m api | grep saas.boot                     # condominios=2 piloto=sim ambiente=hmac_cpf deks_conferidas=0
docker compose --profile rotacao run --rm -T rotacao-cli                # "porMestraVersao": {"2": 4}, "falhas": 0
```

`PORTARIA_KEK`/`PORTARIA_KEK_VERSAO` saem já aqui (e não depois do passo 6) de propósito: o boot só confere as chaves
legadas que estão presentes, então vazias ele sobe; já a `PORTARIA_KEK` antiga presente depois do passo 6 **recusa** o boot
(`PORTARIA_KEK difere da KEK ativa do piloto`), e `PORTARIA_KEK_VERSAO=1` sozinha também
(`... a KEK ativa do piloto na plataforma é a v2`). Os dois casos estão em `test/rotacao-chaves.test.ts`.

## 6. KEK nova nos dois condomínios

```bash
for c in parque aguas-rasas; do
  docker compose --profile rotacao run --rm -T rotacao-cli node dist/cli/rotacionar-chaves.js \
    --kek-preparar --condominio "$c" --kek-versao-atual 1 || break
done
```

Esperado, para cada um: `"situacao": "preparada"`, `"versaoAnterior": 1`, `"versaoAtiva": 2`, `"versoesRegistradas":
[1, 2]`. A CLI recusa se a mestra nova ainda estiver exportada no shell (passo 5 não concluído) ou se alguma linha do
condomínio estiver em outra versão da mestra: a KEK nova nunca nasce embrulhada pela mestra que vazou.

Até o passo 7 a API em execução segue lendo e gravando anexos na v1 (é a que está na memória dela). Nada se perde: a v1
continua registrada e o passo 8 migra também esses.

## 7. Reiniciar a API (ANTES de migrar)

```bash
docker compose restart api && docker compose up -d --wait
docker compose logs --since 5m api | grep saas.boot                     # condominios=2 piloto=sim ambiente=hmac_cpf
```

Depois disso a API conhece a v1 e a v2 de cada condomínio e grava anexo novo na v2. **Migrar antes de reiniciar** deixa
os anexos já migrados com 500 `CHAVE_INDISPONIVEL` nessa API antiga até ela reiniciar (nenhum dado se perde; reiniciar
resolve). Esse caso também está nos testes.

## 8. Migrar as DEKs

```bash
for c in parque aguas-rasas; do
  docker compose --profile rotacao run --rm -T rotacao-cli node dist/cli/rotacionar-chaves.js --kek-migrar --condominio "$c" || break
done
```

Esperado: `"situacao": "nada_a_migrar"` (hoje, com 0 anexos) ou `"migrada"` com `"porVersao": {"2": <todos>}`. Queda no
meio: os lotes confirmados ficam na v2, o resto na v1, a API lê os dois; rodar o mesmo comando de novo continua. Código 1
com "anexo(s) fora da v2 ao final": uma API não reiniciada gravou na v1 durante a migração; fazer o passo 7 e repetir.

## 9. Verificação

```bash
docker compose --profile rotacao run --rm -T rotacao-cli
```

- código 0; `"linhas": 6`; `"porMestraVersao": {"2": 6}`; `"porTipoVersao": {"hmac_cpf:v1:ativa": 2,
  "kek_documentos:v1": 2, "kek_documentos:v2:ativa": 2}`; `"falhas": 0`; cada condomínio com `documentos.porVersao` só
  com `"2"` (ou vazio);
- `/saude` 200; login nos dois condomínios; um anexo de ocorrência novo em cada um abre na tela (prova a v2 de ponta a
  ponta) e o dry-run passa a mostrar `"porVersao": {"2": 1}`;
- trilha da plataforma: `docker compose exec -T db psql -U postgres -d plataforma -tAc "select acao, detalhes from
  plataforma_audit where acao in ('plataforma.mestraRotacionada','condominio.kekRotacionada') order by seq"` (3 linhas; só
  versões e contagens);
- **backup novo** (`sudo systemctl start tcc-portaria-backup.service`) e cópia externa: é o primeiro conjunto que abre com
  a mestra v2.

## 10. Encerramento

- Cofre: v2 da mestra conferida (passo 3); mestra v1 e `PORTARIA_KEK` v1 marcadas **COMPROMETIDA (vazada em <data>,
  trocada em <data>)**. Mantê-las só enquanto houver backup anterior à rotação (o dump `plataforma` antigo só abre com a
  mestra v1); quando o último expirar (retenção da seção 8 do `docs/deploy.md`), apagar as duas.
- `shred -u .env.antes-rotacao` (tem as chaves vazadas).
- Registrar data, carimbo do backup do passo 0 e do passo 9.

## Rollback

| Onde parou | Estado | O que fazer |
|---|---|---|
| Passo 4 falhou | nada gravado | `unset` das duas variáveis, `docker compose start provisionador`. |
| Depois do passo 4 | plataforma na mestra v2; a API em execução segue, mas reinício com o `.env` antigo recusaria | **Concluir o passo 5** (para a frente). Se depois for preciso voltar ao valor antigo, re-rotacionar para a **v3 com o valor antigo** (o trigger só aceita versão maior): com o `.env` já na v2, `export PORTARIA_CHAVE_MESTRA_NOVA="$(sed -n 's/^PORTARIA_CHAVE_MESTRA=//p' .env.antes-rotacao)" PORTARIA_CHAVE_MESTRA_VERSAO_NOVA=3`, `--mestra`, e o passo 5 de novo (`.env` com o valor antigo e `_VERSAO=3`). Sem restore e sem perder escrita, mas volta a usar a chave vazada. Último recurso: restaurar o dump `plataforma` do passo 0 **e** o `.env.antes-rotacao` (só o `plataforma`: a rotação da mestra não toca banco de condomínio; perde-se o que a plataforma gravou depois do backup). |
| Depois do passo 6 | KEK v2 ativa, v1 inativa e legível | Não há o que desfazer para ler anexos (a API lê as duas). Para voltar a gravar na v1, como `postgres`, numa transação (a ordem importa por causa do índice de ativa única): `BEGIN; UPDATE condominio_chave SET ativa = false WHERE tipo = 'kek_documentos' AND versao = 2 AND condominio_id = '<id>'; UPDATE condominio_chave SET ativa = true WHERE tipo = 'kek_documentos' AND versao = 1 AND condominio_id = '<id>'; COMMIT;` e reiniciar a API. Anexo já migrado continua legível pela v2. |
| Voltar a imagem anterior a este commit | a API antiga só conhece a KEK **ativa** | Só depois do passo 8 completo (todo anexo na ativa) ou antes do passo 6. No meio, anexo fora da ativa daria 500 `CHAVE_INDISPONIVEL` na imagem antiga. |
| Restore completo | — | Seção 9 do `docs/deploy.md`, com o `.env` (mestra) da mesma época do backup: dump anterior à rotação = mestra v1 (`.env.antes-rotacao` ou cofre); posterior = v2. Restaurar o `plataforma` **e** os bancos de condomínio do mesmo conjunto (as DEKs migradas apontam para a KEK v2, que só existe no `plataforma` novo). |

## Estado misto

`--mestra` recusa com `estado misto em condominio_chave (v1: X, v2: Y)` quando há linhas em versões diferentes da mestra.
A CLI não produz esse estado (transação única, tabela travada); ele vem de escrita externa com a mestra antiga, tipicamente
um provisionador não reiniciado criando condomínio depois do passo 4. O que fazer: não reiniciar a API; listar as linhas
fora da versão (`select condominio_id, tipo, versao, mestra_versao from condominio_chave where mestra_versao <> 2`), e
decidir à mão (condomínio em `provisionando` pode ser desfeito pela seção 16.3 do `docs/deploy.md` e refeito depois do
passo 5). Não existe modo de "completar" estado misto de propósito: quem decide é o operador.

## Decisão pendente

`PORTARIA_HMAC_CPF_KEY` continua no `.env` (o boot confere que ela é a do `parque`: `ambiente=hmac_cpf`). Ela não vazou,
mas está em texto puro no mesmo arquivo que vazou as outras duas. Esvaziá-la é seguro para o boot e para o compose
(cópia continua no cofre e embrulhada na plataforma); a contrapartida é perder a conferência do boot. Mesmo comando do
passo 5 com `/^PORTARIA_HMAC_CPF_KEY=/ { print "PORTARIA_HMAC_CPF_KEY="; n++; next }` e `n != 5`.
