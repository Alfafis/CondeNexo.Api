# db

Infraestrutura do banco do CondNexo (PostgreSQL 16+; no ambiente Docker, `postgres:17-alpine`). O schema e as migrações ficam em `a API`:

| O quê | Onde |
|---|---|
| Schema (Drizzle) | `src/db/schema.ts` |
| Migração gerada (tabelas, enums, FKs, CHECKs, índices) | `drizzle/0000_init.sql` |
| Migração manual (hash, triggers, máquinas de estado, LGPD, GRANT/REVOKE) | `drizzle/0001_regras_imutabilidade.sql` |
| RF-05: conferência do comprovante no vínculo (gerada + trigger do vínculo, manual) | `drizzle/0002_conferencia_comprovante.sql` |
| Verificador independente da cadeia | `src/db/cadeia.ts` |
| CPF: máscara e HMAC | `src/db/cpf.ts` |
| Seed de estrutura (unidades de `ESTRUTURA_PADRAO`, portaria social) | `src/db/seed.ts` |
| Bootstrap de roles (superusuário) | `db/bootstrap/00_roles.sh` |
| Ambiente Docker (db, migrate, api) | `docker-compose.yml` e `.env.example` na raiz do repositório |

Decisões e justificativas: `docs/02_especificacao_tecnica.md`, seções 3, 4, 9.1 e 14 (itens 16 a 24).

## Roles

| Role | Quem usa | Pode |
|---|---|---|
| `postgres` (superusuário) | só o bootstrap | criar roles e o banco |
| `app_migrator` | `drizzle-kit migrate` | dono do banco, do schema e das funções SECURITY DEFINER |
| `app_rw` | a API NestJS | SELECT; INSERT/UPDATE em cadastros; só INSERT nas trilhas; **nenhum DELETE/TRUNCATE** |

Os roles são do cluster, então ficam **fora** das migrações. A migração `0001` falha se `app_rw` não
existir: sem bootstrap, nada é aplicado pela metade. Não há `ALTER DEFAULT PRIVILEGES`. Tabela nova
precisa de GRANT explícito numa migração, e sem ele a API recebe `permission denied` (falha fechada).

## Variáveis de ambiente

Modelo em `.env.example` (raiz do repositório). O `.env` fica na raiz, contém segredos e **não é distribuído**.

| Variável | Uso |
|---|---|
| `POSTGRES_PASSWORD`, `APP_MIGRATOR_PASSWORD`, `APP_RW_PASSWORD` | bootstrap e docker compose |
| `DB_HOST_PORT` | porta do Postgres no host (padrão 5432; mude se já houver um Postgres local) |
| `DATABASE_URL_MIGRATOR` | `drizzle-kit migrate` (como `app_migrator`); no compose é montada a partir da senha, com host `db` |
| `DATABASE_URL` | a API (como `app_rw`); idem |
| `PORTARIA_HMAC_CPF_KEY` | chave do HMAC-SHA256 do CPF (`pessoa.documento_busca`), 32+ bytes em base64 |
| `PORTARIA_KEK`, `PORTARIA_KEK_VERSAO` | KEK dos documentos (AES-256-GCM com DEK por arquivo, spec §9.2) |
| `PG_TEST_URL` | testes contra Postgres real (superusuário); não vai no `.env`, é passada na linha de comando |

Gerar segredos com `openssl rand -base64 32`. Para as senhas de banco, que entram em URL, remover `/+=` (`| tr -d '/+=\n'`). **A chave HMAC do CPF não é rotacionável:** o CPF não é
guardado, então não há como recalcular `documento_busca` com uma chave nova. Perder a chave significa
perder a busca por CPF dos cadastros existentes, e vazá-la junto com o banco torna o CPF recuperável por
força bruta. Guarde-a fora do servidor do banco, com backup separado do dump.

## Como aplicar (Docker)

PATH do Docker Desktop no macOS (a CLI não está no PATH por padrão):

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
```

Tudo roda da raiz do repositório (`05_Sistema/app`):

```bash
cp .env.example .env                 # preencher (ver "Variáveis de ambiente"); .env tem segredos
docker compose up -d --build         # db -> migrate (roda e termina) -> api
docker compose ps                    # db e api "healthy"; migrate "Exited (0)" é o esperado
curl http://127.0.0.1:3000/api/v1/saude
docker compose logs migrate          # saída do drizzle-kit migrate
docker compose down                  # derruba; o volume pgdata (os dados) permanece
docker compose down -v               # derruba E apaga o volume: zera o banco
```

- O bootstrap (`db/bootstrap/00_roles.sh`) roda **só na primeira subida do volume**. Mudou senha no `.env`
  com o volume já criado? Ou `down -v` (perde os dados), ou `ALTER ROLE ... PASSWORD` à mão.
- O script precisa de `chmod +x`: o entrypoint do Postgres executa os `.sh` executáveis com `/bin/sh` (busybox no Alpine)
  e apenas faz `source` dos demais.
- `migrate` usa `app_migrator`; a API usa `app_rw` e nunca roda migração. Migração nova: gerar o SQL (ver abaixo)
  e `docker compose up -d --build migrate` (o `api` depende dele concluir com sucesso).
- Sem Docker: `DATABASE_URL_MIGRATOR=postgres://app_migrator:SENHA@127.0.0.1:5432/portaria npm run db:migrate`,
  depois do bootstrap manual: `POSTGRES_USER=postgres APP_MIGRATOR_PASSWORD=... APP_RW_PASSWORD=... sh db/bootstrap/00_roles.sh`.
- Dentro do contêiner `db`, conexões por `127.0.0.1` são `trust` (padrão da imagem). Para provar privilégios de verdade,
  conecte pela rede (outro contêiner, ou a porta publicada do host).

O seed de estrutura (`seedEstrutura`) é idempotente e deve ser chamado pela API, ou por um script, como
`app_migrator`. Usuários não têm seed: o primeiro síndico é criado por procedimento manual (RN-05).

## Mudar o schema

1. Editar `src/db/schema.ts` e rodar `npm run db:generate -- --name=<nome>`. O SQL gerado é revisado e versionado.
2. O que o Drizzle não expressa (trigger, função, GRANT) vai numa migração manual: `npm run db:custom -- --name=<nome>`, depois editar o `.sql` criado.
   - Separe cada comando com o marcador de breakpoint do Drizzle (veja `0001`).
   - **Nunca** escreva o marcador dentro de comentário ou de corpo de função: o migrator corta o arquivo ali.
3. Toda tabela nova precisa de GRANT explícito para `app_rw` na migração manual.
4. Mudar os campos canônicos do hash exige `formato_hash` novo, porque os eventos antigos continuam no formato deles (spec §4.3). Hoje há o 1 (sem veículo) e o 2 (entrada com veículo, 0013), escolhido pelo trigger a partir da placa.
5. `npm run db:check` confere a consistência do histórico; `npm test` aplica tudo num PGlite.

Observação de instalação (npm 12): `drizzle-orm` também está em `devDependencies` da raiz. Sem isso, o
npm o deixa só em `node_modules`, e o `drizzle-kit`, que fica na raiz, não o encontra
("Please install latest version of drizzle-orm").

## Testes

```bash
npm test          # PGlite (Postgres 18 em WASM), sem Docker
```

Cada arquivo de teste sobe um PGlite, cria os roles, aplica as **migrações reais** pelo migrator do
Drizzle e roda os casos. O PGlite executa como superusuário, mas `SET ROLE app_rw` aplica os privilégios
normalmente, então os testes de GRANT/REVOKE também rodam nele.

| Arquivo | Cobre |
|---|---|
| `test/cadeia.test.ts` | cadeia válida pelo verificador TS; canônico do banco = canônico do TS, byte a byte; campos do servidor; rollback sem lacuna; adulteração e remoção detectadas; descarte de prefixo com selo |
| `test/imutabilidade.test.ts` | UPDATE/DELETE/TRUNCATE bloqueados pelo trigger (até para o dono); privilégios do `app_rw`; selo; redação LGPD do `audit_log` |
| `test/regras.test.ts` | CHECKs e máquinas de estado: RN-01, RF-17, RF-35, sem CPF, destino, saída/correção, pessoa, vínculo, autorização, restrição, encomenda, ocorrência |
| `test/cpf.test.ts` | máscara e HMAC |
| `test/postgres-real/postgres.test.ts` | **só com Postgres real**: 200 inserções em 10 conexões e duas transações concorrentes com rollback (seq contínuo, cadeia válida); login real como `app_rw`; dono sem bypass do trigger |

O PGlite tem uma conexão só e serializa as consultas. Por isso o teste de paralelismo dele não exercita
a trava da cabeça da cadeia, e a prova de concorrência é o teste em Postgres real.

### Testes contra Postgres real

```bash
docker compose up -d db                       # da raiz
set -a; . ./.env; set +a                      # carrega a senha sem imprimi-la
PG_TEST_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${DB_HOST_PORT:-5432}/postgres" \
  npm run test:pg
```

O teste cria um banco descartável (`portaria_teste_<timestamp>`) com dono `app_migrator`, aplica as
migrações como `app_migrator`, conecta como `app_rw` com login e senha próprios, e no fim apaga o banco.
Sem `PG_TEST_URL`, a suíte é pulada (`describe.skipIf`).

**Roles são do cluster.** O `test:pg` cria um banco descartável, mas reaproveita os roles `app_migrator`/`app_rw`. Se o `app_rw` já existe (Postgres do compose), o teste exige `APP_RW_PASSWORD` no ambiente e **não** altera a senha. Só define uma senha de teste quando é ele quem cria o role (cluster vazio). Rodar com `set -a; . ./.env; set +a` antes, para carregar a senha sem imprimi-la.

(Alternativa sem efeito colateral: apontar `PG_TEST_URL` para um Postgres descartável.)

## Backup (RNF-10)

Script de produção: `db/backup/backup-portaria.sh` (pg_dump `-Fc` + volumes, cifrado com chave pública age, 30 diários
e 12 mensais), com timer systemd e crontab de exemplo na mesma pasta. Restore completo, na ordem, em
`docs/deploy.md` §9.

`pg_dump`/`pg_restore` são **por banco**: `CREATE ROLE`, senhas e `GRANT` de cluster **não viajam no dump**.
A restauração em servidor novo é, nesta ordem:

1. rodar o bootstrap (`db/bootstrap/00_roles.sh`), que cria `app_migrator`, `app_rw` e o banco;
2. `pg_restore` como `app_migrator`;
3. conferir os privilégios: `app_rw` sem UPDATE/DELETE em `evento_acesso` e `audit_log` (os `test:pg` cobrem isso).

A chave `PORTARIA_HMAC_CPF_KEY` também não está no dump. Sem ela, a busca por CPF dos cadastros restaurados não funciona.
O backup da chave é separado, e obrigatório.

O que mais fica fora do dump, cada um com o seu backup (2026-10-18):

| Item | Onde | Sem ele |
|---|---|---|
| `PORTARIA_KEK` (e a versão) | `.env` / cofre do provedor | os anexos cifrados do volume `documentos` ficam ilegíveis para sempre |
| Volume `documentos` | Docker | o banco aponta para arquivos que não existem (a retenção conta "registro sem arquivo") |
| Volume `ancoras` | Docker | só a cópia local da âncora; a prova está no branch `ancoras` do GitHub (e nos e-mails, se esse destino estiver ligado) |
| Branch `ancoras` (GitHub) | repositório, protegido contra force-push e deleção | sem ele, uma reescrita completa da trilha não é detectável (spec §4.6) |

Restore e retenção: um dump antigo restaurado traz de volta eventos e cadastros que a retenção já tinha eliminado. Depois
do restore, rodar `docker compose exec api node dist/cli/jobs.js retencao` antes de abrir para uso. Os documentos
eliminados não voltam (o arquivo foi apagado do volume), mas o registro restaurado ainda os teria como ativos: a varredura
os conta como "registro sem arquivo".

Restore e anonimização (migração 0007 e `drizzle-plataforma/0001`): toda anonimização (a pedido ou por retenção) é
registrada, só com ids, na tabela `lgpd_anonimizacao` do banco `plataforma`, fora do banco do condomínio. Depois de um
restore, `docker compose exec api node dist/cli/jobs.js reaplicar-anonimizacoes [--condominio <código>]` refaz no banco
restaurado as que ele desfez (a retenção diária também faz isso, como primeiro passo). Limite: se o banco `plataforma`
for restaurado JUNTO, para a mesma data, o registro também volta, e os pedidos posteriores ao dump precisam ser
reaplicados à mão (lista no `audit_log` do banco antigo, ação `lgpd.anonimizar`, ou no registro de pedidos da
administração). Ver `docs/deploy.md`, seção 9.

