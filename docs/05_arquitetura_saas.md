# CondNexo como SaaS multi-condomínio — Arquitetura

> **Escrito no monorepo; hoje o front está em CondeNexo.Front.** Onde este documento diz `apps/web` ou `apps/plataforma`,
> leia "código do Front (antigo apps/web)" / "código do Front (antigo apps/plataforma)"; `@portaria/domain` virou `src/dominio/` neste repositório. O
> workflow `testes-web.yml` citado no histórico não existe aqui (workflows desta API: `testes-api.yml`,
> `testes-postgres.yml`, `deploy-api.yml`, `ancora-selo.yml`). Texto histórico mantido como foi escrito.

> **Status:** v0.2 (2026-10-22). v0.1 era só proposta; na v0.2 o usuário respondeu às perguntas 1, 2, 3 e 5 da
> seção 10 (SaaS agora, repositório público, banco por condomínio, VPS compartilhada), e F0/F1 foram implementadas
> (código e migrações, sem deploy). Nada muda em produção sem os passos manuais de `docs/deploy.md`, seção 12.
> **F2 (2026-10-22):** implementada no código (API multi-banco, sem deploy); o que entrou, o que divergiu e o que ficou
> para depois está em §5.1. Deploy manual: `docs/deploy.md`, seção 13.
> **v0.3 (2026-10-22):** decisões novas do usuário: "Master vê tudo" com registro na trilha do condomínio (SAAS-09
> reescrita; a versão anterior fica marcada como substituída), módulos por condomínio (SAAS-19) e a referência de UX do
> app do Master (§6.2). Provisionamento de condomínio novo implementado (CLI `provisionar-condominio`, SAAS-10 e §5.2;
> passo a passo em `docs/deploy.md`, seção 16).
> **v0.4 (2026-10-23): F5, entrega 1 implementada** (código, sem deploy): app do Master (`apps/plataforma`), login do
> Master com senha + TOTP, sessão e cookie próprios, lista de condomínios, criação pela tela via serviço provisionador e
> módulos. O que entrou e as decisões tomadas onde o doc deixava margem: §5.3. Deploy manual: `docs/deploy.md`, seção 18.
> A entrega 2 (SAAS-09, "Master vê tudo" auditado) e o `ModuloGuard` (SAAS-19) ficam para depois.
> **v0.5 (2026-10-23): login do Master SEM segundo fator** (decisão do usuário, risco aceito): o TOTP da entrega 1 saiu
> (migração `drizzle-plataforma/0004_master_sem_totp.sql`); login só com e-mail e senha. Compensações e risco em SAAS-08
> e no início da §5.3. Deploy: `docs/deploy.md`, seção 18.
> **v0.6 (2026-10-24): F5, entrega 2 implementada** (código, sem deploy): leitura auditada dos dados do condomínio pelo
> Master (SAAS-09), tela "Acessos da plataforma" do síndico e do auditor, e `ModuloGuard` (SAAS-19). Sem migração. O que
> entrou e as decisões tomadas onde o doc deixava margem: §5.4. Deploy: `docs/deploy.md`, seção 20.
> Complementa `01_requisitos.md` (v0.3) e `02_especificacao_tecnica.md` (v0.1); não os altera.
> O condomínio real do estudo de caso é chamado aqui de **condomínio-piloto**.

## 0. Resumo

O sistema hoje é single-tenant por construção: uma cabeça de cadeia (`id = 1`), uma chave HMAC, uma KEK, uma
estrutura de unidades no código e um banco. Transformá-lo em SaaS para vários condomínios, com um dono da plataforma
("Master"), exige decidir isolamento, identidade, chaves, trilha e operação.

| # | Decisão | Posição levada ao usuário | Esta proposta |
|---|---|---|---|
| SAAS-01 | Isolamento | Banco único + `condominio_id` + RLS | **Diverge: um banco Postgres por condomínio** no mesmo cluster, mais um banco de plataforma. RLS fica documentado como alternativa (apêndice A) |
| SAAS-02 | Trilha por condomínio | Cadeia, selo, âncora, retenção por tenant | Mantida. Com banco por condomínio, a cadeia do piloto **não é tocada** |
| SAAS-03 | Master e LGPD | Operador, sem dado pessoal, break-glass | **Mudou em 2026-10-22 (SAAS-09):** o Master vê os dados sem aprovação do síndico; todo acesso a dado pessoal fica na trilha do condomínio e numa tela do síndico. O pool da plataforma continua **sem CONNECT** nos bancos de condomínio |
| SAAS-04 | Chaves por condomínio | HMAC e KEK por tenant, envelope | Mantida. Ressalva: a chave HMAC do CPF **não é rotacionável** (o CPF não é guardado) |
| SAAS-05 | Login | Global vs por condomínio | **Por condomínio**, com "código do condomínio" na tela de login. Subdomínio fica para quando houver domínio próprio |
| SAAS-06 | Estrutura de unidades | Cadastrável por condomínio | Mantida. `ESTRUTURA_PADRAO` vira só gerador do onboarding |
| SAAS-07 a 19 | Master fora do RBAC, sessão separada (em /admin, mesma origem desde 2026-10-23; sem 2FA desde 2026-10-23), onboarding, fim de contrato, backup/restore, jobs, limites, observabilidade, migração em N bancos, infraestrutura, fuso, módulos por condomínio | — | Seção 3 |

Calendário: a recomendação era entregar o TCC antes; **o usuário decidiu fazer o SaaS agora, junto do TCC** (seção 10,
pergunta 1), com as salvaguardas registradas lá.

---

## 1. Estado atual verificado (o que o desenho precisa respeitar)

| Fato | Onde |
|---|---|
| Cabeça da cadeia é linha única (`CHECK id = 1`) e o trigger a trava com `FOR UPDATE` | `src/db/schema.ts:480-486`; `drizzle/0001_regras_imutabilidade.sql:171` |
| O serviço de selo e a auditoria leem a cabeça por `id = 1` | `src/selo/selo.module.ts:85,108,232`; `src/auditoria/auditoria.controller.ts:61` |
| Gênese = SHA-256 de `"genesis"`, igual no banco e no domain | `0001_regras_imutabilidade.sql:22-25`; `src/dominio/hashChain.ts:47` |
| Serialização canônica v1 **não contém** identificador de condomínio; `formato_hash` já versiona o formato | `0001_regras_imutabilidade.sql:55-84`; `hashChain.ts:11,58` |
| Unicidades globais: login, unidade, CPF (HMAC), placa, área comum, ponto de acesso, seq e hash do evento, número de encomenda e de ocorrência (identity), selo diário por data | `schema.ts:64,72,80,106,221,330,404,433,492,539,623` |
| Funções `SECURITY DEFINER` (donas: `app_migrator`) fazem as exceções controladas do append-only | `0001:92,388,413,432`; `0004_lgpd_selo_ancora.sql:63,88,123`; `0005_unidade_bloco.sql:44` |
| Append-only por trigger que só libera o dono da tabela com marcador `portaria.operacao` | `0001:202-219`; versão atual em `0004:39-60` |
| `app_rw` sem DELETE, sem UPDATE nas trilhas, sem CREATE; tabela nova sem GRANT falha fechada | `0001:454-484`; `db/bootstrap/00_roles.sh` |
| A API conecta como `app_rw`; migrações como `app_migrator` | `docker-compose.prod.yml:84,105` |
| Um pool, um `Db` global injetado em 24 arquivos; 103 consultas fora de transação e 42 transações | `src/database/database.module.ts:22-31` (contagem por `grep` em `src`) |
| Decisão explícita de **não** usar AsyncLocalStorage: contexto passado à mão | `src/auth/tipos.ts:17` |
| Sessão: token opaco em cookie `__Host-`, `SameSite=Strict`, sem `Domain` | `src/auth/cookie.ts:1-12`; `src/auth/guards.ts:24-33` |
| Login procurado por `lower(login)` em toda a tabela | `src/auth/auth.service.ts:86` |
| HMAC do CPF com chave única do ambiente; o CPF em claro não é guardado | `src/db/cpf.ts:1-27` |
| Anexos: DEK por arquivo cifrada por KEK única do ambiente; AAD amarra id e versão | `src/documentos/cofre.ts:1-12,64-65`; `src/config/config.ts:120-124` |
| Estrutura de unidades e agrupamento ("Bloco"/"Torre") vêm do código, como provider global | `src/dominio/units.ts:34`; `src/config/config.module.ts:12` |
| Agendador interno com fuso BRT fixo e trava por advisory lock de nome fixo | `src/jobs/agendador.ts:24,56-77`; `src/jobs/trava.ts:23` |
| Endpoint público de selos sem parâmetro, com `totalDoDia` | `src/selo/publico.ts:1-35` |
| Testes da API rodam no PGlite **como superusuário** (só alguns trechos usam `SET ROLE app_rw`) | `test/helpers/app.ts:77-91`; `test/helpers/banco.ts:84-87` |
| Backup: um `pg_dump -Fc` do banco `portaria`, cifrado com age | `db/backup/backup-portaria.sh:60-63` |
| Front como SPA estático na Cloudflare (`https://www.condenexo.com.br`) chamando a API direto em `https://api.condenexo.com.br/api/v1`, com CORS com credenciais (desde 2026-10-31; antes, Vercel com rewrite `/api/*`, mesma origem) | `docs/deploy-subdominio-api.md`; `CORS_ORIGENS` em `src/config/config.ts` |
| Matriz RBAC com quatro papéis de condomínio | `src/dominio/rbac.ts:22-67` |

## 2. Premissas

| # | Premissa | Se estiver errada |
|---|---|---|
| P1 | Dezenas de condomínios nos primeiros anos, não milhares | Banco por condomínio pesa em conexões e migrações acima de ~100–200 bancos no mesmo cluster. Revisitar SAAS-01; o caminho para RLS existe (apêndice A), mas é uma migração grande |
| P2 | Cada condomínio é independente: nenhuma funcionalidade cruza dados de dois condomínios (ex.: administradora vendo vários) | Usuário multi-condomínio vira entidade da plataforma. O desenho não bloqueia (seção 3, SAAS-05), mas a primeira versão não o oferece |
| P3 | Um único processo de API atende todos os condomínios | Se a API for comprometida, todos os condomínios caem juntos. Isso vale para qualquer um dos três modelos de isolamento; só servidores separados mudam isso |
| P4 | O condomínio é o controlador e o dono do SaaS é o operador (LGPD, art. 5º, VI e VII, e art. 39), formalizado em contrato | Se o SaaS decidir finalidades (ex.: usar dado agregado para outro produto), vira controlador e precisa de base legal própria |
| P5 | Todos os condomínios estão no fuso de Brasília na primeira versão | Selo diário e relatórios cortariam o dia na hora errada (SAAS-18) |
| P6 | ~~Não existe domínio próprio~~ Desde 2026-10-31 há domínio próprio: front em `www.condenexo.com.br` (Cloudflare) e API em `api.condenexo.com.br`; o `sslip.io` fica só como transição (antes: API em `sslip.io`, front em `vercel.app`) | Com domínio, subdomínio por condomínio vira opção de login melhor (SAAS-05) |

---

## 3. Decisões

### SAAS-01 — Isolamento: um banco por condomínio, no mesmo cluster

**Contexto.** O requisito é que um erro na API não vaze dado entre condomínios. O sistema tem regras de integridade
no banco (triggers, `SECURITY DEFINER`, cadeia de hash com cabeça única) que hoje assumem um condomínio só.

**Alternativas.**

| Critério | Banco único + RLS | Schema por condomínio | **Banco por condomínio** |
|---|---|---|---|
| Vazamento por `WHERE` esquecido | Bloqueado pela política | Bloqueado (`search_path`) | Impossível: o dado não está na conexão |
| Vazamento por chave estrangeira | **Possível**: checagem de FK ignora RLS (doc. do Postgres, "Row Security Policies"). Exige FK composta `(condominio_id, id)` em ~50 FKs | Não | Não |
| Vazamento por função `SECURITY DEFINER` | **Possível**: a dona (`app_migrator`) ignora RLS. As 8 funções precisam filtrar por tenant à mão | Possível se a função qualificar o schema errado | Não: a função só enxerga o próprio banco |
| Vazamento por contexto errado na requisição | Possível (`app.condominio_id` errado) | Possível (`search_path` errado em conexão reaproveitada) | Possível (pool errado), mas a sessão é validada no banco escolhido (SAAS-05) |
| Quem consegue forjar o contexto | Qualquer SQL de `app_rw` pode chamar `set_config`: RLS por GUC protege de bug, não de injeção | Idem com `SET search_path` | Trocar de banco exige outra conexão: SQL injetado não muda de banco |
| Mudança no schema atual | Todas as 26 tabelas, ~12 unicidades, ~50 FKs, cabeça da cadeia, 8 funções, triggers de selo | Migrações viram N, schema qualificado | **Nenhuma** nas tabelas existentes |
| Cadeia do piloto | Cabeça vira por tenant; risco de errar a migração da tabela append-only | Copiar para schema novo | **Intocada** |
| Backup, restore e exclusão de um condomínio | Difícil: restore parcial em tabela append-only; exclusão exige função nova que fure o append-only | Médio | `pg_dump -d`, `pg_restore` num banco novo, `DROP DATABASE` |
| Migração de schema | 1 vez | N vezes | N vezes (laço com portão de versão, SAAS-16) |
| Conexões | 1 pool | 1 pool, cuidado com `search_path` | 1 pool por banco ativo (pequeno, com timeout de ocioso) |
| Consulta entre condomínios (métricas do Master) | Uma consulta | Uma por schema | Uma por banco, em laço (aceitável para dezenas) |
| Escala | Milhares | Centenas | Centenas (limite prático: conexões e tempo de migração) |

**Decisão.** Um banco por condomínio (`portaria_<id curto>`) no cluster Postgres existente, mais um banco
`plataforma` para o que é do SaaS. O banco atual `portaria` vira o banco do condomínio-piloto **sem renomear nada
dentro dele**.

**Por que diverge da posição 1.** As duas cumprem "bug na API não vaza", mas o RLS só cumpre com trabalho extra em
três pontos fáceis de errar (FK, `SECURITY DEFINER`, contexto forjável por qualquer SQL), e a migração da produção
mexeria na tabela append-only e na cabeça da cadeia. O banco por condomínio deixa intocadas as tabelas, as funções e a
cadeia existentes, e resolve de graça backup, restore, exportação e exclusão de um condomínio, que são requisitos de
operador LGPD (SAAS-11, SAAS-12). O custo (migrar N bancos, um pool por banco) é operacional e cabe na escala da
premissa P1.

**Consequências.**
- A API precisa escolher o banco por requisição (SAAS-03b). É o mesmo trabalho que o RLS exigiria para definir o
  contexto: nos dois modelos, todo acesso a dado precisa saber o condomínio.
- Postgres: `max_connections` e memória do container precisam caber em "pools ativos × máximo por pool". Pool por
  condomínio com `max: 3` e `idleTimeoutMillis: 30000`; teto global de conexões na API.
- Revisitar ao passar de ~100 condomínios ou ao surgir funcionalidade que cruze condomínios.

### SAAS-02 — Banco de plataforma e roles

**Decisão.**
- Banco `plataforma` (dono `app_migrator`), acessado pela API com o role novo **`app_plataforma`**: SELECT/INSERT/UPDATE
  só nas tabelas da plataforma, sem DELETE, e **sem CONNECT nos bancos de condomínio**.
- `app_rw` continua sendo o role da API nos bancos de condomínio, com os mesmos GRANTs de hoje, e **sem CONNECT em
  `plataforma`**. A leitura que a parte de condomínio precisa da plataforma (resolver código → banco, chaves embrulhadas)
  é feita pelo pool `app_plataforma`, num serviço único (`ResolvedorCondominio`) e só com colunas não pessoais.
- `app_migrator` ganha `CREATEDB` **ou** a criação de banco fica num role `app_provisionador` usado só pela CLI de
  onboarding (recomendado: CLI, nunca a API; ver SAAS-10).
- Ninguém tem `BYPASSRLS` (não há RLS neste modelo, mas o atributo continua desligado, que é o padrão).

**Consequência.** O pool que atende as rotas do Master não consegue abrir conexão no banco de um condomínio.
(Na v0.2 isso garantia pelo banco que "o Master não vê dado pessoal". Desde 2026-10-22 o Master vê, por um ponto
único que lê pelo pool `app_rw` do condomínio e grava a trilha dele antes de responder: SAAS-09. O isolamento de roles
continua valendo para todo o resto do código da plataforma.)
- `app_provisionador` (implementado em 2026-10-22, SAAS-10): `CREATEDB`, `NOLOGIN` até o deploy da seção 16, e membro
  de `app_migrator` **só com SET** (`WITH INHERIT FALSE, SET TRUE`, Postgres 16+). O SET é o que o Postgres exige para
  `CREATE DATABASE ... OWNER app_migrator`; sem INHERIT ele não ganha o CONNECT nem os objetos do `app_migrator` ao
  logar (não entra no `portaria`, na `plataforma` nem no banco que acabou de criar). Ressalva honesta: com a senha dele,
  `SET ROLE app_migrator` a partir do banco `postgres` permite o que o dono pode fora de um banco, inclusive
  `DROP DATABASE` de um condomínio: o mesmo alcance da senha do `app_migrator`, que mora no mesmo `.env` (R14).

### SAAS-03 — Contexto do condomínio na requisição

**Contexto.** Os 24 serviços injetam um `Db` global. O projeto decidiu passar contexto à mão e não usar
AsyncLocalStorage (`auth/tipos.ts:17`).

**Decisão.** Usar **durable providers** do NestJS 11 (`ContextIdStrategy`), o padrão do framework para
multi-tenant: um subárvore de injeção por condomínio, criado na primeira requisição dele e reaproveitado depois. O
provider `DB` passa a ser `durable` e resolve o `Db` do condomínio a partir do identificador que a estratégia extrai da
requisição. Os serviços continuam com `this.db`, sem reescrever as 145 chamadas.

- De onde vem o condomínio:
  1. Requisição autenticada: prefixo do cookie de sessão (`v2.<condominio_id>.<token>`). O prefixo **não é confiável
     sozinho**: só escolhe o banco. A sessão é validada nesse banco pelo hash do token; prefixo trocado = sessão
     inexistente = 401.
  2. Login e rotas públicas de condomínio: cabeçalho `X-Condominio: <codigo>` enviado pelo front.
  3. Nenhum dos dois: subárvore "sem condomínio", cujo `DB` **lança erro ao primeiro uso** (falha fechada). Rotas que
     não são de condomínio (`/saude`, `/plataforma/*`, `/auditoria/selos/publico`) não injetam `DB`.
- Jobs (singleton) não têm requisição: obtêm a instância do condomínio com
  `ContextIdFactory.create()` + `moduleRef.registerRequestByContextId({ condominioId }, id)` + `moduleRef.resolve(...)`.
- `PLATAFORMA_DB` (pool `app_plataforma`) só pode ser importado pelo módulo `plataforma` e pelo `ResolvedorCondominio`.
  Um teste de arquitetura (grep nos imports) falha se outro módulo importar.

**Alternativas.** (a) Passar o executor explicitamente (`ctx.db`) em toda chamada: mais fiel à decisão do
`tipos.ts:17`, mas são 145 pontos de mudança em código já testado, cada um uma chance de usar o banco errado.
(b) AsyncLocalStorage com um `Db` proxy: menos linhas que (a), mas o contexto vira implícito e um `await` fora da
cadeia perde o condomínio. Os durable providers mantêm a garantia que motivou a decisão original (nenhuma instância de
serviço mistura condomínios) sem estado implícito por requisição.

**Consequências.** Guardas globais que dependem de `SessaoService` passam a ser resolvidas por condomínio (suportado
pelo Nest). Caches em memória que hoje são globais (`LimiteTaxaPublico`, cache de selos públicos, `ESTRUTURA`) precisam
ser revistos um a um: o que é por condomínio fica na subárvore; o que é global fica fora dela.

### SAAS-04 — Chaves por condomínio (envelope)

**Contexto.** Com uma chave HMAC só, o mesmo CPF gera o mesmo `documento_busca` em todos os condomínios: quem tiver
leitura em dois bancos correlaciona a pessoa. Com uma KEK só, comprometer um condomínio é comprometer todos os anexos.

**Decisão.**
- Banco `plataforma`, tabela `condominio_chave`: por condomínio, uma chave HMAC do CPF e uma KEK de documentos, cada
  uma com 32 bytes aleatórios, **cifradas (AES-256-GCM) pela chave mestra** `PORTARIA_CHAVE_MESTRA` do ambiente, com
  AAD `portaria:chave:<condominio_id>:<tipo>:v<versao>`. A chave mestra nunca vai ao banco nem ao backup.
- A API desembrulha na primeira requisição do condomínio e mantém em memória no subárvore dele.
- Subchave do `login_limite` (hoje HKDF da chave HMAC global, `limite-login.service.ts:41`) passa a derivar da chave
  HMAC do condomínio para o limite por login e de uma chave da plataforma para o limite por IP (SAAS-14).
- **Piloto:** importa `PORTARIA_HMAC_CPF_KEY` e `PORTARIA_KEK` atuais como versão 1 das chaves dele, com a mesma
  `chave_versao` de hoje. Nenhum `documento_busca` nem DEK é recalculado.

**Rotação.**
| Chave | Rotação | Custo |
|---|---|---|
| Mestra | Re-embrulhar as linhas de `condominio_chave` (2 por condomínio) | P, sem janela |
| KEK do condomínio | Versão nova; re-embrulhar as DEKs de `documento` (coluna `chave_versao` já existe) | P a M por condomínio |
| HMAC do CPF | **Não rotacionável**: o CPF em claro não existe para recalcular. Só por recadastro | — |

**Consequências.**
- A chave HMAC fica protegida só pela mestra. Vazamento da mestra + dump = força bruta de CPF possível, como hoje com a
  chave global. Guardar a mestra fora da VPS em cofre (pergunta 6).
- *Crypto-shredding* na exclusão (SAAS-11): apagar as chaves do condomínio torna os anexos ilegíveis e o HMAC
  inútil. Limite honesto: backups antigos do banco `plataforma` ainda contêm a chave embrulhada até expirarem.

### SAAS-05 — Login por condomínio

**Alternativas.**
| Opção | Prós | Contras |
|---|---|---|
| Login global (e-mail único na plataforma) | Um campo a menos; suporta pessoa em vários condomínios | Porteiro nem sempre tem e-mail; colisão de logins simples (`porteiro1`); precisa de tabela global de identidade, que vira dado pessoal cruzando condomínios |
| Subdomínio (`<codigo>.dominio`) | Isolamento de cookie por origem; UX boa | Exige domínio próprio, certificado curinga e o front servido em curinga. O domínio próprio existe desde 2026-10-31 (P6) |
| **Código do condomínio no login** | Funciona com a infraestrutura de hoje; unicidade de login continua por banco (`schema.ts:106` não muda) | Um campo a mais na primeira vez |

**Decisão.** Código do condomínio (slug curto, ex. `parque`) no formulário de login, lembrado no navegador da portaria
como **preferência de UI** (não é sessão nem dado pessoal; regra do `react-storage` no `CLAUDE.md` do projeto). O
cookie de sessão leva o prefixo `v2.<condominio_id>.` (SAAS-03). Mensagem de erro única para "código inexistente",
"usuário inexistente" e "senha errada" (mesmo princípio de `auth.service.ts:56-57`), com o mesmo custo de argon2.

**Transição do piloto.** Durante uma janela igual à expiração absoluta da sessão, cookie sem prefixo e login sem código
são resolvidos para o piloto. Depois, recusados.

**Não bloqueia:** subdomínio depois (o código vira o subdomínio) e conta multi-condomínio depois (identidade na
plataforma apontando para usuários em N bancos).

### SAAS-06 — Estrutura de unidades cadastrável

**Decisão.**
- Tabela nova de linha única `configuracao` em cada banco de condomínio: nome exibido, `agrupamento` (`Bloco`/`Torre`),
  fuso (SAAS-18). Substitui o provider `ESTRUTURA` (`config.module.ts:12`) na subárvore do condomínio.
- `ESTRUTURA_PADRAO` (`units.ts:34`) sai do caminho de produção e vira exemplo/gerador: o onboarding recebe uma
  `ConfigEstrutura` (blocos, andares, finais, ausentes), mostra a prévia e insere as unidades pelo `gerarUnidades`
  existente (`units.ts:139`). Exceções seguem pelo CRUD e pela planilha, como hoje.
- `recriar-estrutura` passa a receber o condomínio e a estrutura (arquivo JSON), e continua dependendo de
  `unidade_descartar_estrutura` (`0005:44`), que já se recusa a apagar unidade usada. Como cada banco é um condomínio,
  a função não muda.
- Áreas comuns e pontos de acesso: o onboarding cria "Portaria social" e a lista que o síndico informar.

### SAAS-07 — Master fora do RBAC de condomínio

**Decisão.** O Master **não** é um quinto valor do enum `papel` (`schema.ts:30`) nem entra em `MATRIZ`
(`rbac.ts:24`). Tem tabela, sessão, guarda, matriz e prefixo de rota próprios:
- `master_usuario`, `master_sessao` no banco `plataforma`; papéis da plataforma `master` (tudo) e, se houver
  funcionários, `suporte` (sem financeiro). Matriz `MATRIZ_PLATAFORMA` em `src/dominio/rbac-plataforma.ts`.
- Rotas em `/api/v1/plataforma/*`, decorator `@Plataforma(acao)`. A guarda de condomínio recusa sessão de plataforma e
  vice-versa: cookies com nomes diferentes, validados em tabelas de bancos diferentes.
- Ações da plataforma registradas em `plataforma_audit` (append-only, mesmo trigger de `0001:202`), sem dado pessoal
  de morador.

### SAAS-08 — Sessão do Master: servido em /admin (mesma origem), sem 2FA (revisado em 2026-10-23)

> **Revisão de 2026-10-23 (decisão do usuário): sem segundo fator.** O login do Master passa a ser só e-mail + senha; o
> TOTP implementado na entrega 1 (§5.3) foi removido do código e do banco (migração `0004_master_sem_totp`: saem
> `master_usuario.totp_cifrado`, `totp_mestra_versao`, `totp_ultimo_passo` e seus CHECKs,
> `master_sessao.totp_confirmado_em` e a tabela `master_codigo_recuperacao`, que nunca foi usada).
> - **Risco aceito:** senha do Master vazada (phishing, reuso, malware, ombro) = **acesso total à plataforma**: criar
>   condomínio, mudar módulos e, com a entrega 2 (SAAS-09), ler o dado pessoal de todos os condomínios. Não há segundo
>   obstáculo entre a senha e a conta.
> - **Compensações:** senha do Master com **no mínimo 16 caracteres** na troca (`SENHA_MIN_MASTER` em
>   `src/dominio/rbac-plataforma`; a do condomínio continua 12), mesma lista de senhas comuns e sem o e-mail;
>   **limite de tentativas** mantido (par e-mail+IP e IP bloqueiam; e-mail sozinho atrasa); **sessão curta** (15 min de
>   inatividade, 8 h no máximo); **trilha da plataforma com o IP** em `auth.login`, `auth.login_falha`, `auth.bloqueio`,
>   `auth.logout` e `auth.trocar_senha(_falha)`; mensagem única sem enumeração e o mesmo custo de argon2 para e-mail
>   inexistente; senha temporária da CLI com troca obrigatória; recomendação operacional de **gerenciador de senhas**
>   (senha única, gerada, nunca reutilizada) e de perfil de navegador separado.
> - O Master que já existia em produção continua com a **mesma senha** (a migração só apaga o segredo TOTP).
> - Voltar a ter 2FA (TOTP ou WebAuthn) é uma migração *expand* nova com bootstrap pela CLI; nada desta revisão impede.
>
> O texto abaixo é a decisão original; os itens de TOTP e códigos de recuperação estão substituídos por esta revisão.

**Decisão (original).**
- **Mesma origem, servido em `/admin` (revisado em 2026-10-23, decisão do usuário):** o front do Master deixa de ter
  projeto Vercel próprio e passa a ser servido em `/admin` do mesmo projeto da portaria, com o mesmo rewrite `/api`.
  *Atualização de 2026-10-31:* a Vercel foi abandonada. O `/admin` é servido pelo mesmo SPA estático da Cloudflare em
  `www.condenexo.com.br`, e não há mais rewrite: o navegador chama `api.condenexo.com.br` direto (CORS com credenciais).
  O cookie do Master segue host-only no host da API, com `Path=/api/v1/plataforma`.
  Bundles continuam separados (`apps/plataforma` é seu próprio workspace, sem código de sessão em comum com `apps/web`).
  *Decisão original (descartada):* outro projeto Vercel (`<nome>-plataforma.vercel.app`), para ter pote de cookies
  próprio.
- **Risco aceito:** um XSS em qualquer tela da portaria, num navegador onde o Master esteja logado, consegue chamar
  `/api/v1/plataforma/*` com o cookie do Master (HttpOnly impede ler o cookie, não impede usá-lo).
- **Mitigações:** CSP estrita `script-src 'self'`; bundles separados; cookie com `Path=/api/v1/plataforma`; sessão de
  15 min de inatividade e 8 h no máximo; ~~TOTP~~ (removido em 2026-10-23, ver revisão acima); e recomendação operacional de usar o Master em um perfil de navegador
  separado, sem login de portaria.
- Cookie `__Host-portaria_plataforma`, `SameSite=Strict`, inatividade de 15 min e máximo de 8 h (2 h e 12 h desde 2026-10-29, decisão do usuário). (Implementado em
  2026-10-23 como `__Secure-portaria_plataforma` com `Path=/api/v1/plataforma`: o prefixo `__Host-` exige `Path=/`; ver §5.3.)
- ~~**TOTP obrigatório** (RFC 6238, implementável com `node:crypto` sem dependência nova), segredo cifrado pela chave
  mestra, 10 códigos de recuperação com hash argon2id. WebAuthn fica para depois.~~ **Substituído em 2026-10-23:** sem
  2FA (revisão acima).
- Limite de tentativas próprio, no banco `plataforma`.

**Alternativa descartada (original).** Mesma SPA com rota `/plataforma`: sessão do Master no mesmo pote de cookies da
portaria. Hoje o cookie é isolado por `Path`, mas a origem é a mesma (ver risco aceito acima).

### SAAS-09 — Master e LGPD: acesso direto e auditado ("Master vê tudo")

> **Implementado em 2026-10-24 (F5, entrega 2; §5.4).** Rotas, ponto único, trilha e tela do síndico como abaixo;
> decisões onde o texto deixava margem (status gravado, ordem das gravações, encerrado/excluído, o que fica de fora) na §5.4.
>
> **Revisado em 2026-10-26 (§5.5): o Master deixa de "só ler" numa exceção.** Decisão do usuário: o Master gerencia os
> usuários de papel `sindico` de um condomínio (adicionar, trocar, nova senha temporária, desativar e reativar), sempre
> com motivo escrito, a senha do Master de novo e a trilha do condomínio na mesma transação da mudança. Nada além disso:
> os outros usuários e todo o resto do dado do condomínio continuam só leitura.

> **Decisão do usuário em 2026-10-22.** Substitui o acesso de suporte com aprovação do síndico (break-glass) da v0.2,
> que fica abaixo, marcado como substituído. O usuário foi informado da mitigação e não objetou.

**Contexto.** O condomínio é o controlador; o SaaS, operador (P4). O operador trata dado só por instrução do
controlador (art. 39). A instrução passa a vir do contrato, não de uma aprovação caso a caso.

**Decisão.**
- O Master gerencia: condomínios (cadastro, plano, status, módulos), usuário síndico inicial, chaves (rotação), saúde
  e métricas agregadas. Dados que a plataforma trata como **controladora** (razão social, CNPJ, contato do contrato,
  faturamento) ficam no banco `plataforma`, com base legal de execução de contrato (art. 7º, V). Sem mudança.
- **O Master pode ver os dados de qualquer condomínio sem aprovação do síndico.** Leitura só, na primeira versão;
  escrita em dado de condomínio continua com o síndico, com **uma exceção desde 2026-10-26 (§5.5): os usuários síndicos**
  (adicionar, trocar, nova senha temporária, desativar, reativar) pela aba "Síndicos" do app do Master, com motivo,
  reautenticação e a linha `plataforma.usuario_*` na trilha do condomínio. A nova senha do síndico deixa de ser só pela
  CLI: a CLI (`redefinir-senha`, `provisionar-condominio --nova-senha-sindico`) continua para o operador da VPS, e a tela
  passa a ser o caminho normal.
- **Mitigação adotada:**
  1. Todo acesso do Master a dado pessoal de um condomínio grava uma linha no `audit_log` **daquele condomínio** (a
     trilha é do controlador): `usuario_id` e `usuario_papel` nulos (o Master não é usuário do condomínio, SAAS-07),
     `usuario_nome = 'plataforma/<master>'` (o e-mail do `master_usuario`), `acao = 'plataforma.ler'` (ou
     `plataforma.exportar` em download), `entidade` e `registro_id` do recurso, `depois = { rota, metodo, status,
     master_usuario_id }`, sem corpo de resposta. E uma linha em `plataforma_audit` (sem dado de morador).
  2. **Antes de devolver o dado e na mesma requisição.** Falhou a gravação da trilha: 503 e o dado não sai.
  3. **Ponto único.** As rotas do Master sobre dado de condomínio ficam em `/api/v1/plataforma/condominios/:id/...`;
     um `AcessoPlataformaService` resolve a subárvore durável do condomínio (como os jobs, `contextoDoJob`), grava a
     trilha e só então chama os serviços existentes (que leem pelo pool `app_rw` daquele banco). Teste de arquitetura:
     só esse serviço obtém subárvore de condomínio a partir de `/plataforma/*`.
  4. O síndico vê esses registros na tela **"Acessos da plataforma"** (filtro do `audit_log` por `plataforma.*`:
     quando, quem, o quê), sem poder apagar (append-only). Item do relatório mensal ao conselho.
- **Não muda:** sessão do Master separada (em /admin, mesma origem, desde 2026-10-23; sem 2FA desde 2026-10-23) (SAAS-08), Master fora do RBAC de condomínio (SAAS-07),
  `app_plataforma` sem CONNECT nos bancos de condomínio (SAAS-02), métricas em `condominio_metrica` (SAAS-15).
- **Sai do plano:** tabelas `acesso_suporte` e `suporte_codigo`, coluna `usuario_sistema.origem`,
  `sessao.acesso_suporte_id`, rota `POST /auth/suporte`, aprovação na tela do síndico e a pergunta 4 (seção 10).

**LGPD.**
- O acesso do Master é tratamento pelo **operador** e precisa estar previsto no **contrato com cada condomínio**:
  finalidades (suporte, operação, obrigação legal), que o acesso não depende de aprovação caso a caso, que todo acesso
  fica registrado na trilha do condomínio e visível ao síndico, quem na empresa tem papel `master` (lista nominal), e o
  prazo de guarda desses registros (o da trilha). Sem essa cláusula, o acesso não tem instrução do controlador.
- Necessidade (art. 6º, III): poder ver não autoriza olhar sem motivo. Regra interna: acesso só com chamado ou
  incidente; acesso sem chamado é tratado como incidente interno. A trilha visível ao síndico é o controle externo.
- Conta do Master comprometida passa a alcançar o dado pessoal de **todos** os condomínios (R7): sem 2FA desde
  2026-10-23 (SAAS-08: senha de 16+, limite de tentativas, sessão curta, trilha com IP),
  app em /admin com cookie de caminho restrito (mesma origem, risco aceito em SAAS-08), poucos usuários `master`, revisão dos acessos por condomínio (relatório na F5).
- Se um cliente exigir aprovação prévia: o desenho anterior volta como opção por condomínio, sem mudar o resto.

**Versão anterior (v0.2) — SUBSTITUÍDA em 2026-10-22:**

> **Contexto.** O condomínio é o controlador; o SaaS, operador (P4). O operador trata dado só por instrução do
> controlador (art. 39).
>
> **Decisão.**
> - O Master gerencia: condomínios (cadastro, plano, status), usuário síndico inicial, chaves (rotação), saúde e métricas
>   **agregadas sem dado pessoal** (contagem de eventos por dia, tamanho do banco, último selo, falhas de job).
> - Dados que a plataforma trata como **controladora** (relação comercial): razão social, CNPJ, contato do responsável
>   pelo contrato, faturamento. Ficam no banco `plataforma`, com base legal de execução de contrato (art. 7º, V).
> - **Acesso de suporte**, quando for preciso ver dado do condomínio:
>   1. Master abre o pedido com motivo (mínimo 15 caracteres, mesmo critério de `JUST` em `schema.ts:25`) e prazo
>      (máximo 4 h).
>   2. O síndico aprova na tela dele. O pedido e a aprovação são gravados **no banco do condomínio** (tabela
>      `acesso_suporte`) e no `audit_log` dele: a trilha é do controlador.
>   3. A API cria no banco do condomínio uma sessão para um usuário técnico de origem `suporte`, com papel `auditor`
>      (somente leitura, `rbac.ts`), entregue ao front do condomínio por código de uso único (60 s, hash no banco) que o
>      navegador do Master troca por cookie. O Master nunca recebe senha de ninguém.
>   4. Toda requisição dessa sessão vira linha no `audit_log` (`suporte.requisicao`: rota, método, status; sem corpo).
>   5. Expira sozinho; o síndico encerra a qualquer momento.
>   - **Emergência sem síndico disponível** (ex.: síndico bloqueado): pergunta 4. Recomendação: aprovação por outro
>     usuário `sindico` ativo ou, sem nenhum, só com ciência registrada e e-mail imediato ao contato do contrato, prazo
>     de 1 h, marcado como "sem aprovação" no relatório.
> - Escrita pelo suporte (corrigir cadastro a pedido): fora da primeira versão. O síndico faz, com o suporte olhando.
>
> **Por que usuário técnico com papel `auditor` em vez de papel novo.** Reaproveita sessão, RBAC, `audit_log` e as
> checagens existentes (`evento_operador_papel_ck` já proíbe `auditor` de registrar evento, `schema.ts:472`). Um papel
> novo mexeria no enum, na matriz e nas telas.

### SAAS-10 — Onboarding de condomínio (provisionamento)

**Implementado em 2026-10-22** (CLI; a tela do Master é da F5): `src/plataforma/provisionar.ts` e
`src/cli/provisionar-condominio.ts`; passo a passo em `docs/deploy.md`, seção 16; estado em §5.2.

1. Entrada: JSON pelo stdin (código, nome, cidade/UF, plano, estrutura de unidades, áreas comuns, nome e login do
   síndico). Validada inteira antes de tocar em banco (inclusive `gerarUnidades`).
2. Plataforma (`app_plataforma`): linha em `condominio` com status `provisionando`, banco `portaria_<8 aleatórios>`,
   módulos padrão (SAAS-19) e as duas chaves (HMAC do CPF e KEK, 32 bytes aleatórios cada) embrulhadas pela mestra,
   numa transação.
3. Cluster (`app_provisionador`, banco `postgres`): `CREATE DATABASE ... OWNER app_migrator TEMPLATE template0` e,
   como dono (SET ROLE), `REVOKE ALL ... FROM PUBLIC` e `GRANT CONNECT` a `app_migrator` e `app_rw`: os GRANTs do
   piloto.
4. Migrações do condomínio (`app_migrator`), a mesma pasta do laço de deploy. A cabeça da cadeia nasce na gênese.
5. Dados (`app_rw`, uma transação): `configuracao` (agrupamento), unidades, "Portaria social", áreas comuns e o
   síndico com senha temporária (72 h, troca obrigatória), com `audit_log` de ator nulo e nome
   `Plataforma (provisionamento)`.
6. Verificação (migrações todas, unidades, configuração, síndico, cabeça da cadeia, matriz de CONNECT) e só então
   `provisionando → ativo` + `plataforma_audit` `condominio.provisionar`.
7. A senha temporária aparece **uma vez**, só no stderr do terminal; o stdout leva ids, banco e impressões das chaves.
   Entrega ao síndico fora do sistema (pergunta 8).

**Retomável:** falhou no meio, o condomínio fica `provisionando` (a API não o atende; migração e backup o ignoram) e
rodar de novo com a mesma entrada continua: cada passo confere o que existe (banco com dono `app_migrator`, estrutura
igual à da entrada) e a senha do síndico é regerada (a anterior nunca foi mostrada). Já `ativo` com a mesma entrada:
`ja_provisionado`, nada muda. `--nova-senha-sindico` gera outra temporária para o síndico que ainda não entrou.
**Rollback** de um provisionamento abandonado (`DROP DATABASE`, apagar as duas chaves e a linha `provisionando`):
`docs/deploy.md` §16.3. Ativo não tem rollback: é fim de contrato (SAAS-11).

(2026-10-23, F5 entrega 1: a tela do Master cria condomínio sem quebrar a regra abaixo. A API repassa o pedido ao
**serviço provisionador**, um container à parte com o mesmo `provisionar()` da CLI, ligado só sob demanda; §5.3.)

A API não cria banco: `CREATEDB` num processo exposto à internet amplia o estrago de uma invasão. Onboarding é raro e
pode ser manual nas primeiras dezenas.

### SAAS-11 — Fim de contrato: exportação e exclusão

**Decisão.** Estados `ativo → suspenso → encerrado → excluido`.
- `suspenso` (inadimplência): login recusado com mensagem própria; jobs de selo e retenção **continuam** (a trilha não
  pode ter buraco nem dado vencido retido).
- `encerrado`: exportação completa entregue ao controlador. Conteúdo: dump lógico por tabela em JSON/CSV, a
  exportação verificável da cadeia (já existe, spec §4.7) com os selos, e os anexos **decifrados** num pacote cifrado
  com a chave pública que o síndico informar (age). O controlador fica com a obrigação de guarda dos 3 anos (seção 7
  dos requisitos).
- `excluido`, depois de prazo contratual (sugestão: 30 dias após a entrega): `DROP DATABASE`, apagar o volume de
  anexos do condomínio, apagar as chaves (`condominio_chave`). Registro em `plataforma_audit` só com id, datas e
  hash do pacote exportado. Backups expiram pela rotação normal (SAAS-12).
- Duas pessoas para excluir (Master + confirmação por código enviado ao contato do contrato), porque é irreversível.

Com banco por condomínio, nada disso fura o append-only: o banco inteiro sai, não linhas.

### SAAS-12 — Backup e restore de um condomínio

**Decisão.**
- `backup-portaria.sh` passa a fazer um `pg_dump -Fc` por banco (laço sobre os condomínios ativos + `plataforma`),
  cifrado com age. Volume de anexos separado por condomínio (`/documentos/<condominio_id>/`), arquivado por condomínio.
- Restore de **um** condomínio: `pg_restore` num banco novo, conferir a cadeia contra a âncora, trocar o apontamento em
  `condominio.banco` e manter o antigo renomeado até a conferência. Os outros condomínios não param.
- A ressalva já registrada vale por condomínio: restore desfaz anonimizações posteriores ao dump; o procedimento de
  `db/README.md` (reaplicar os pedidos) é executado no banco restaurado.
- Retenção dos backups com prazo fixo (sugestão 35 dias) declarada no contrato: é o limite do *crypto-shredding*.

### SAAS-13 — Jobs por condomínio

**Decisão.** O ciclo do agendador (`agendador.ts:56`) itera os condomínios `ativo` e `suspenso` e, para cada um,
roda selo, âncoras e retenção na subárvore dele (SAAS-03).
- Trava por condomínio: `portaria:job:<nome>:<condominio_id>` (`trava.ts:23` hoje usa só o nome).
- Falha isolada: erro num condomínio é registrado e o laço segue. Métrica de "condomínio com job atrasado" para o
  Master.
- Espalhar no tempo: no máximo N condomínios em paralelo (sugestão 2), para não consumir todas as conexões.
- As funções `SECURITY DEFINER` de retenção não mudam: rodam no banco do condomínio.

### SAAS-14 — Limites por condomínio

- Login: limite por login no banco do condomínio (como hoje); **limite por IP global**, no banco `plataforma`, para
  que o atacante não ganhe 30 tentativas por condomínio.
- Taxa de requisições por condomínio (janela em memória, um processo): impede que um cliente degrade os outros.
- Cotas do plano, conferidas na API: unidades, usuários ativos, armazenamento de anexos (soma de `tamanho_bytes` em
  `documento`). Estourar cota bloqueia criação, nunca registro de evento de acesso (a portaria não pode parar).

### SAAS-15 — Observabilidade sem dado pessoal

- Campo `condominio_id` (uuid, não o código) entra na *allowlist* de `comum/log.ts`; o resto da allowlist não muda.
- Métricas para o Master saem de funções de agregação no banco do condomínio executadas pelo job (contagens, último
  selo, tamanho), copiadas para `condominio_metrica` no banco `plataforma`. O Master lê só essa tabela.
- `/saude` continua sem dado de condomínio; um `/plataforma/saude` autenticado mostra o estado por condomínio.

### SAAS-16 — Migrações de schema em N bancos

**Decisão.**
- `scripts/deploy/deploy-vps.sh` roda `drizzle-kit migrate` em `plataforma` e depois em cada banco de condomínio, em
  série. Falhou um: para, não sobe a API nova.
- Toda migração em duas etapas (*expand/contract*): a versão N da API funciona com o schema N-1 e N. Assim um deploy
  interrompido no meio do laço não derruba ninguém.
- Na subida, a API confere em cada banco a última migração aplicada (`drizzle.__drizzle_migrations`); condomínio
  defasado recebe 503 só para ele, com alerta ao Master.
- Pastas de migração separadas: `drizzle/` (condomínio, como hoje) e `drizzle-plataforma/`.

### SAAS-17 — Infraestrutura

- A VPS é compartilhada com outro sistema de produção (ADR de 2026-10-19). A recomendação era VPS dedicada antes do
  segundo condomínio real; **o usuário decidiu continuar na VPS compartilhada, inclusive com vários clientes**
  (seção 10, pergunta 5, 2026-10-22). O operador responde por segurança (art. 46) perante cada controlador, então a
  decisão vale **com as mitigações obrigatórias M1 a M9 da seção 10**, que viram condição de F6 e F8.
- Postgres: subir memória e `max_connections` de acordo com "condomínios ativos × 3 + plataforma + jobs". Com 30
  condomínios (pergunta 3) são até ~100 conexões e o `mem_limit` do banco sai de 512 MiB: conferir a RAM livre da VPS
  com o outro sistema no ar antes de subir (M1).
- Confirmar o país do datacenter da VPS (transferência internacional, seção 7).

### SAAS-18 — Fuso por condomínio (sem implementar)

`configuracao.fuso` com `CHECK (fuso = 'America/Sao_Paulo')` na primeira versão. O código continua com BRT fixo
(`agendador.ts:24`, `comum/datas.ts`); a coluna só garante que o schema não bloqueia. Liberar outro fuso é trocar o
CHECK e o cálculo de dia, e reverificar o selo diário.

### SAAS-19 — Módulos por condomínio (decisão de 2026-10-22)

> **Recusa de rota implementada em 2026-10-24 (F5, entrega 2; §5.4):** `@Modulo`, `ModuloGuard`, `modulos` em
> `/auth/me`, login e `/catalogo`, e o front escondendo menu, rotas, atalhos e seções. O "Hoje" abaixo é de 2026-10-22.

**Contexto.** O produto concorrente que o cliente usa mostra "Licenças" e, por condomínio, "Configurações → módulos".

**Decisão.**
- Coluna `condominio.modulos text[]` no banco `plataforma` (migração `drizzle-plataforma/0002`), com CHECK de
  pertencimento à lista e default com **todos os módulos ligados**. Lista única em `src/dominio/modulos`
  (`MODULOS`), repetida literalmente em `schema-plataforma.ts` e na migração (a imagem `migrate` não leva o domain);
  `test/saas-provisionar.test.ts` confere as três.
- Módulos, a partir das features existentes:

  | Módulo | Rotas da API | Telas |
  |---|---|---|
  | `encomendas` | `/encomendas/*` | Encomendas |
  | `ocorrencias` | `/ocorrencias/*` (com anexos) | Ocorrências |
  | `autorizacoes_previas` | `/autorizacoes-previas/*` | Autorizações prévias (portaria) |
  | `importacao` | `/importacoes/*` | Importação de planilha |
  | `veiculos` | `/veiculos/*` | Veículos |
  | `funcionarios` | `/funcionarios/*` | Funcionários e escala |
  | `relatorios` | `/relatorios/*` | Relatórios |

- **Núcleo, nunca desligável:** autenticação, usuários, unidades e catálogo, pessoas, vínculos, eventos de acesso,
  presentes e turnos, restrições (a portaria confere restrição em toda entrada, RF-16), trilha e selo, LGPD (obrigação
  legal do controlador).
- `text[]` com CHECK, não `jsonb`: o banco recusa nome errado. Módulo novo exige migração da plataforma, que decide
  quem o recebe (por padrão, nasce desligado nos condomínios existentes: decisão comercial).
- **Recusa de rota (desenho; implementação na F5, junto da tela de ligar/desligar):** decorator `@Modulo('<nome>')`
  no controller e `ModuloGuard` global durável, depois da `SessaoGuard` e da `PapelGuard`. Lê os módulos do condomínio
  da requisição (o resolvedor passa a carregar `modulos` no cache da tabela `condominio`, renovado a cada 1 min:
  desligar vale em até 1 min, sem reiniciar) e responde **403 `MODULO_DESLIGADO`** ("Este módulo não está contratado
  para este condomínio."). 403 e não 404: não revela nada que o usuário do condomínio não saiba. `/auth/me` e
  `/catalogo` passam a levar `modulos` para o front esconder menu e atalhos. Teste de arquitetura: todo controller tem
  `@Modulo` ou está na lista do núcleo. Jobs não olham módulo (selo e retenção continuam). Desligar não apaga dado:
  religar devolve tudo, e o dado segue sujeito à retenção e aos direitos do titular.
- **Hoje:** a coluna existe e o provisionamento a preenche; **nada é bloqueado** (todos ligados em todos).

---

## 4. Modelo de dados

### 4.1 Banco `plataforma` (novo)

```sql
CREATE TABLE condominio (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo        text NOT NULL,                 -- slug do login
  nome          text NOT NULL,
  banco         text NOT NULL,                 -- nome do banco Postgres
  status        text NOT NULL DEFAULT 'provisionando',
  plano         text NOT NULL,
  ancora_id     uuid NOT NULL DEFAULT gen_random_uuid(), -- folha da âncora pública (§4.3), não revela o código
  criado_em     timestamptz(3) NOT NULL DEFAULT now(),
  encerrado_em  timestamptz(3),
  cidade        text,                          -- 2026-10-22 (plataforma/0002): nulos só no piloto
  uf            text,                          -- CHECK: sigla de UF; (cidade IS NULL) = (uf IS NULL)
  modulos       text[] NOT NULL DEFAULT ARRAY['encomendas', ...], -- SAAS-19; CHECK modulos <@ lista
  CONSTRAINT condominio_codigo_uq UNIQUE (codigo),
  CONSTRAINT condominio_banco_uq  UNIQUE (banco),
  CONSTRAINT condominio_codigo_ck CHECK (codigo ~ '^[a-z][a-z0-9-]{2,30}$'),
  CONSTRAINT condominio_banco_ck  CHECK (banco ~ '^portaria(_[a-z0-9]{8})?$'),
  CONSTRAINT condominio_status_ck CHECK (status IN ('provisionando','ativo','suspenso','encerrado','excluido'))
);

-- Dados do cliente (a plataforma é controladora destes): contrato, não morador.
CREATE TABLE condominio_contrato (
  condominio_id     uuid PRIMARY KEY REFERENCES condominio(id),
  razao_social      text NOT NULL,
  cnpj              text NOT NULL,
  contato_nome      text NOT NULL,
  contato_email     text NOT NULL,
  limites           jsonb NOT NULL DEFAULT '{}'  -- cotas do plano (SAAS-14)
);

CREATE TABLE condominio_chave (
  condominio_id   uuid NOT NULL REFERENCES condominio(id),
  tipo            text NOT NULL CHECK (tipo IN ('hmac_cpf','kek_documentos')),
  versao          smallint NOT NULL CHECK (versao > 0),
  chave_cifrada   bytea NOT NULL,             -- AES-256-GCM pela chave mestra (+ tag)
  nonce           bytea NOT NULL CHECK (length(nonce) = 12),
  mestra_versao   smallint NOT NULL,
  ativa           boolean NOT NULL,
  criada_em       timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (condominio_id, tipo, versao)
);
CREATE UNIQUE INDEX condominio_chave_ativa_uq ON condominio_chave (condominio_id, tipo) WHERE ativa;

CREATE TABLE master_usuario (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome             text NOT NULL,
  email            text NOT NULL,
  senha_hash       text NOT NULL CHECK (senha_hash LIKE '$argon2id$%'),
  totp_cifrado     bytea NOT NULL,            -- removida na 0004 (2026-10-23, sem 2FA; SAAS-08)
  papel            text NOT NULL CHECK (papel IN ('master','suporte')),
  ativo            boolean NOT NULL DEFAULT true,
  criado_em        timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX master_usuario_email_uq ON master_usuario (lower(email));

-- master_codigo_recuperacao: nunca usada; removida na 0004 (2026-10-23, sem 2FA; SAAS-08)
CREATE TABLE master_codigo_recuperacao (master_usuario_id uuid REFERENCES master_usuario(id),
  codigo_hash text NOT NULL, usado_em timestamptz(3), PRIMARY KEY (master_usuario_id, codigo_hash));

CREATE TABLE master_sessao (  -- mesmo desenho de `sessao` (schema.ts:114-135), outra tabela
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE,
  master_usuario_id uuid NOT NULL REFERENCES master_usuario(id),
  criada_em timestamptz(3) NOT NULL DEFAULT now(), ultimo_uso_em timestamptz(3) NOT NULL DEFAULT now(),
  expira_em timestamptz(3) NOT NULL, revogada_em timestamptz(3), totp_confirmado_em timestamptz(3), ip inet
);  -- totp_confirmado_em: removida na 0004 (2026-10-23)

-- plataforma_login_limite: mesmo desenho de login_limite (schema.ts:140-153), limite global por IP (SAAS-14) e do Master

CREATE TABLE plataforma_audit (       -- append-only (trigger igual a trilha_bloqueia_alteracao)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  em timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  master_usuario_id uuid REFERENCES master_usuario(id),
  acao text NOT NULL, condominio_id uuid REFERENCES condominio(id),
  detalhes jsonb                       -- nunca dado de morador
);

CREATE TABLE condominio_metrica (     -- preenchida pelo job (SAAS-15)
  condominio_id uuid REFERENCES condominio(id), dia date, eventos int, tamanho_bytes bigint,
  ultimo_selo date, jobs_atrasados int, PRIMARY KEY (condominio_id, dia)
);

CREATE TABLE ancora_diaria (          -- âncora pública agregada (§4.3)
  data date PRIMARY KEY, raiz text NOT NULL CHECK (raiz ~ '^[0-9a-f]{64}$'),
  folhas jsonb NOT NULL,              -- [{ancora_id, seq, hash}] ordenado por ancora_id; sem contagem
  criada_em timestamptz(3) NOT NULL DEFAULT now()
);

-- Roles (como implementado na F1: drizzle-plataforma/0000 e db/bootstrap/10_plataforma.sh)
GRANT CONNECT ON DATABASE plataforma TO app_migrator, app_plataforma;   -- bootstrap; REVOKE ALL FROM PUBLIC
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_plataforma;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_plataforma;         -- todas as tabelas, não só condominio/chave
GRANT INSERT, UPDATE ON condominio, condominio_contrato, master_usuario, master_sessao,
  plataforma_login_limite, condominio_metrica, ancora_diaria TO app_plataforma;
GRANT INSERT ON plataforma_audit, condominio_chave, master_codigo_recuperacao TO app_plataforma;
GRANT UPDATE (ativa) ON condominio_chave TO app_plataforma;
GRANT UPDATE (usado_em) ON master_codigo_recuperacao TO app_plataforma;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_plataforma;
REVOKE UPDATE ON plataforma_audit FROM app_plataforma;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_plataforma;
-- sem DELETE em nada; exclusão de condomínio pela CLI (SAAS-11). Sem ALTER DEFAULT PRIVILEGES: tabela nova sem GRANT
-- falha fechada. Triggers: plataforma_audit append-only (inclusive TRUNCATE) e condominio_chave com identidade imutável
-- (só `ativa` muda, ou o embrulho com mestra de versão maior).
-- app_provisionador nasce NOLOGIN CREATEDB, sem CONNECT em plataforma nem nos condomínios (ganha LOGIN com a CLI da F5).
```

### 4.2 Bancos de condomínio (migração `0007`, só *expand*)

> **Atualização de 2026-10-22.** A numeração andou: `0007` virou a migração de LGPD/retenção. Desta tabela, só
> `configuracao` entrou (`drizzle/0010_configuracao.sql`, com o provisionamento), sem `nome_exibicao` (o nome fica na
> plataforma, de onde o front já o lê) e com GRANT `SELECT, INSERT` ao `app_rw` (sem UPDATE até a tela). O piloto fica
> sem a linha e a API usa o agrupamento padrão. As linhas de `acesso_suporte`, `suporte_codigo`,
> `usuario_sistema.origem` e `sessao.acesso_suporte_id` **saíram do plano** com a nova SAAS-09. Fica para a F4:
> `selo_cadeia.ancora_publica_em`.

Nenhuma tabela existente perde coluna, unicidade ou FK. Mudanças (plano original):

| Objeto | Mudança | Motivo |
|---|---|---|
| `configuracao` (nova, linha única `id = 1`) | `nome_exibicao`, `agrupamento` (`Bloco`/`Torre`), `fuso` (CHECK fixo) | SAAS-06, SAAS-18 |
| `usuario_sistema.origem` | `text NOT NULL DEFAULT 'local' CHECK (origem IN ('local','suporte'))`. Usuário `suporte` não entra por senha e não aparece na gestão de usuários | SAAS-09 |
| `acesso_suporte` (nova, append-only com transição) | `id`, `master_usuario_id` (uuid **sem FK**: outro banco), `master_nome`, `motivo`, `solicitado_em`, `expira_em`, `aprovado_por_id` (FK `usuario_sistema`), `aprovado_em`, `encerrado_em`, `sem_aprovacao boolean` | SAAS-09 |
| `sessao.acesso_suporte_id` | FK opcional; `CHECK` de que sessão de usuário `suporte` tem acesso vinculado | SAAS-09 |
| `suporte_codigo` (nova) | Código de uso único: `codigo_hash`, `acesso_suporte_id`, `expira_em`, `usado_em` | SAAS-09 |
| `selo_cadeia.ancora_publica_em` | Registro de inclusão do selo na raiz pública do dia | §4.3 |
| GRANTs | `INSERT` em `acesso_suporte`, `suporte_codigo`; `UPDATE` só nas colunas de transição | Padrão da `0001` |

O que **continua** como está, porque cada banco é um condomínio: cabeça da cadeia `id = 1`, gênese, serialização
canônica v1, `seq` e numeração de encomenda/ocorrência por identity, todas as unicidades da tabela da seção 1, todas
as funções `SECURITY DEFINER` e os triggers.

**Considerado e descartado:** gênese por condomínio (`sha256('genesis:' || id)`) para amarrar a cadeia ao
condomínio. Copiar a cadeia inteira de um condomínio para outro já é detectado pela âncora de cada um (§4.3), e a
mudança exigiria parametrizar `0001` e o verificador do domain (`hashChain.ts:47`).

### 4.3 Âncora pública com vários condomínios

**Problema.** Publicar `seq`, `hash` e `totalDoDia` por condomínio (`publico.ts:26-35`) revela o volume diário de
cada cliente e quem são os clientes. Para um condomínio só isso foi aceito; para vários, é informação comercial de
terceiros.

**Decisão.**
- Por dia, uma **raiz de Merkle** sobre as folhas `sha256(ancora_id || data || seq || hash)` dos selos diários de todos
  os condomínios, em ordem de `ancora_id`. O endpoint público passa a devolver só `{data, raiz}` (formato v2); o
  workflow `ancora-selo.yml` grava em arquivo novo (`raizes.jsonl`).
- Cada condomínio recebe, junto com o selo, a prova de inclusão (caminho de Merkle), guardada no banco dele e
  disponível na exportação verificável. A verificação offline confere: cadeia → selo → folha → raiz publicada.
- **Piloto:** o arquivo atual `selos.jsonl` do branch `ancoras` é congelado no dia da troca (último commit com
  mensagem de fechamento) e continua conferível com `verificar-ancoras`. Nada é reescrito.
- E-mail ao síndico e ao conselho (destino `email`, já implementado) passa a ser a âncora **controlada pelo cliente**;
  recomendado como obrigatório a partir do segundo condomínio, porque o GitHub e a VPS são do operador (pergunta 7).

---

## 5. Plano de migração a partir da produção

Princípio: o banco `portaria` do piloto não sofre nenhuma escrita de migração que toque as tabelas existentes. Toda
fase tem rollback por *redeploy* da imagem anterior.

| Fase | O quê | Rollback | Janela | Tamanho |
|---|---|---|---|---|
| F0 | **Linha de base.** Exportação verificável completa da cadeia do piloto + cabeça (`seq`, `hash`) + contagem por tabela + `verificar-ancoras` contra o branch `ancoras`, guardados fora da VPS. Backup age testado com restore num banco descartável. Testes de caracterização do que vai mudar (login, sessão, selo público, agendador) | — | Não | P |
| F1 | Banco `plataforma`, roles `app_plataforma`/`app_provisionador`, tabelas da §4.1. Piloto registrado com `banco = 'portaria'`. Chaves atuais importadas embrulhadas pela chave mestra (versão 1). **API inalterada** | `DROP DATABASE plataforma`; remover roles | Não | M |
| F2 | API multi-banco: `ResolvedorCondominio`, durable providers, `PLATAFORMA_DB`, chaves vindas da plataforma (fallback para o ambiente desligado ao fim da fase), cookie `v2.` com aceitação do formato antigo para o piloto, login com código (opcional para o piloto), agendador por condomínio, laço de migração e de backup. Produção continua com um condomínio | Imagem anterior: o schema do piloto não mudou, as sessões antigas continuam válidas | Reinício da API (segundos; RNF-05 cobre com formulário) | G |
| F3 | Migração `0007` (§4.2) em `portaria` (2026-10-22: `configuracao` entrou na `0010`; o suporte saiu, SAAS-09) | Migração reversa (só `DROP` de colunas e tabelas novas, vazias) | Não (tabelas pequenas, `ADD COLUMN` com default constante não reescreve linha) | P |
| F4 | Âncora agregada (§4.3): selos públicos v2, workflow novo, prova de inclusão, congelamento do `selos.jsonl` | Reativar o endpoint v1 (o código fica até o fim da fase) | Não | M |
| F5 | Plataforma: API `/plataforma/*`, front separado na Vercel, ~~TOTP~~ (sem 2FA desde 2026-10-23), onboarding (CLI: **feito em 2026-10-22**, §5.2), acesso do Master auditado (SAAS-09), módulos (SAAS-19), métricas | Desligar o projeto Vercel e as rotas (flag) | Não | G |
| F6 | **Condomínio de teste** em produção (`demo`, dados fictícios do seed) para smoke de isolamento: sessão de um não abre o outro, jobs dos dois rodam, backup e restore de um só | Excluir `demo` (SAAS-11) | Não | P |
| F7 | Fim de contrato: exportação completa, exclusão com duas pessoas, rotação de chave | — | Não | M |
| F8 | Primeiro cliente real (depois das mitigações M1 a M9 da seção 10, do contrato de operador e da revisão de segurança) | — | — | — |

### 5.1 Estado da F2 (2026-10-22, código; deploy em `docs/deploy.md` §13)

**Entrou:** `ResolvedorCondominio` (`src/tenancy/resolvedor.ts`, cache da tabela `condominio`, chaves desembrulhadas por
condomínio, conferências de boot), durable providers (`src/tenancy/contexto.ts`, `database.module.ts`: `CONDOMINIO`, `DB`,
`PG_POOL` duráveis; `REGISTRO_BANCOS` com um pool `app_rw` por banco), `PLATAFORMA_DB` não exportado, chaves só da
plataforma (sem fallback para o ambiente; as do ambiente, se presentes, são conferidas no boot), KEK conferida contra
uma DEK existente, cookie `v2.<condominio_id>.<token>` com o antigo aceito para o piloto, login com `X-Condominio`
(sem código = piloto; código desconhecido indistinguível de login inexistente num condomínio que existe), `suspenso`
recusa login só depois da senha certa (e conta como falha), agendador e CLI `jobs.js` por condomínio (subárvore durável, trava `portaria:job:<nome>:<condominio_id>`, falha
isolada), anexos em `<raiz>/<condominio_id>/` (piloto na raiz), âncora e endpoint público v1 só do piloto, laço de
migração (`scripts/migrar-bancos.mjs`) e de backup por banco, `condominio_id` no log. Testes:
`test/saas-isolamento.test.ts` (itens 1 a 5, 7 e 8 da §6.1, com dois PGlites) e `test/postgres-real/saas-multibanco.test.ts`
(item 6 e travas com Postgres real).

**Onde divergiu ou o doc deixava margem:**
- Guardas globais declaradas `scope: REQUEST, durable: true` em `app.module.ts`: o Nest decide se um enhancer global é
  por requisição pelo `scope` declarado, não pela árvore; sem isso a `SessaoGuard` nunca é construída. A `PapelGuard`
  também, para continuar depois da autenticação (o Nest roda os estáticos antes dos por requisição).
- `FiltroExcecao` continua estático e não injeta `DB` (filtro global durável não é suportado pelo Nest): grava o
  `acesso.negado` no banco do condomínio resolvido pelo middleware, via `REGISTRO_BANCOS`.
- O condomínio é resolvido num middleware Express assíncrono antes do roteamento (a `ContextIdStrategy` é síncrona e
  só lê `req.condominio`). No `POST /auth/login` o cookie é ignorado: só `X-Condominio` ou o piloto.
- Pool por condomínio com `max: 10` (o de hoje), não 3: produção tem um condomínio; baixar na F6.
- Transição como flag (`SAAS_PILOTO_PADRAO`, padrão `true`), não por prazo: desligar à mão quando o front mandar o código.
- Login sem condomínio: o mesmo algoritmo de `login_limite` (por login e por IP, mesmos parâmetros, mesmo atraso e
  mesmo 429), em memória por processo (`auth/login-sem-condominio.ts`), até o limite global na plataforma (SAAS-14).
- `/saude`: 200 com plataforma e piloto bons; outro condomínio com defeito só conta em `condominios_com_falha` (sem id
  nem código), para não derrubar todos pelo healthcheck. Resultado em cache por 5 s. O agendador também isola por
  condomínio quem não resolve (chave ou plataforma). O boot continua estrito: chave que não desembrulha recusa a subida.
- O laço de migração migra `portaria` sempre (piloto, mesmo antes de registrado) e os bancos `ativo`/`suspenso`/
  `encerrado`; `provisionando` fica para a CLI de onboarding (F5).

**Ficou para depois:** portão de versão por banco na subida (503 só para o condomínio defasado, SAAS-16); AAD da DEK
com o condomínio (§6.1, só DEKs novas); limite global por IP e taxa por
condomínio (SAAS-14); ~~`ESTRUTURA` por condomínio~~ (feito no provisionamento, §5.2); tar de anexos por condomínio
(SAAS-12); sessão de plataforma × rota de condomínio (§6.1 item 6, primeira parte: F5).

**Código do condomínio no front (§6.2, 2026-10-22):** campo "Código do condomínio" no login (opcional, rótulo
visível, `autocomplete=off`, trim + minúsculas, formato validado com a mesma regra da API, agora em
`src/dominio/condominio` e importada pelo `resolvedor.ts` e pelo `registrar-piloto.ts`). `X-Condominio` só no
`POST /auth/login` (nas outras rotas o middleware dá precedência ao cabeçalho sobre o prefixo do cookie, então enviá-lo
fora do login só poderia atrapalhar). Vazio: sem cabeçalho (piloto). Erro continua único ("Usuário ou senha
inválidos."); o front só recusa formato, nunca existência. Preferência: o código **devolvido pela API** depois de um
login com sucesso vai para o `localStorage` (só ele); assim um erro de digitação nunca é lembrado e quem ainda entra sem
código passa a ter o do piloto pré-preenchido, o que prepara o desligamento da flag. Nenhum código fixo no bundle.
Contrato: `POST /auth/login` e `GET /auth/me` ganharam `condominio: { codigo, nome }` (aditivo; o OpenAPI documenta o
`data` como envelope genérico, então não muda); o `nome` entra no cache do resolvedor e no `CondominioResolvido`, lido na
1ª resolução (renomear vale após reiniciar a API). O layout mostra esse nome no cabeçalho, com o texto antigo de
reserva. O servidor de e2e registra o piloto com o código `parque`, como na produção. Testes: `apps/web/src/test/
login-condominio.test.tsx`, `apps/web/e2e/27-api-codigo-condominio.spec.ts` e o caso novo em `test/saas-isolamento.test.ts`.

**Checklist do fim da transição** (`SAAS_PILOTO_PADRAO=false`):
- o leitor de âncoras (`ancora-selo.yml`) chama `/auditoria/selos/publico` sem `X-Condominio`: com a flag desligada
  isso vira 404 e a coleta para. Antes de desligar, o workflow passa a mandar o código do piloto (ou a F4 já trocou o
  endpoint pelo agregado);
- o front manda o código no login (§6.2, feito): quem nunca entrou com o código neste navegador precisa digitá-lo;
  conferir antes que as portarias já têm o campo preenchido (basta um login com sucesso depois do deploy do front);
- rollback para uma imagem anterior à F2 desloga todo mundo que tem cookie `v2.` (a imagem velha não reconhece o
  formato): planejar a janela como "todos entram de novo".

**Verificação da cadeia antiga** (fim de F2, F3 e F4): no banco `portaria`, `verificarCadeia` sobre a exportação nova
deve dar `ok`, a cabeça deve ser igual ou posterior à de F0 com os mesmos hashes nos `seq` comuns, e
`verificar-ancoras` deve conferir todo o `selos.jsonl`. Como nenhuma migração toca `evento_acesso`, `selo_cadeia` ou
`evento_acesso_cadeia` (exceto a coluna nova de `selo_cadeia` em F3, que não entra no hash: o selo não é encadeado),
uma divergência indica bug, não efeito esperado.

**Ordem que não pode inverter:** F1 antes de F2 (a API nova lê chaves da plataforma); F2 antes de F5 (rotas do Master
dependem do resolvedor); F4 antes do segundo condomínio (senão o endpoint v1 publicaria volume de dois clientes); F7 e
SAAS-17 antes de F8.

### 5.2 Provisionamento de condomínio novo (2026-10-22, código; deploy em `docs/deploy.md` §16)

O doc punha o onboarding na F5 (CLI) com a `configuracao` na F3. Foi feito agora o que um segundo condomínio precisa
para existir, sem a tela do Master: SAAS-10 (passos e retomada), `configuracao` (§4.2) e `condominio.cidade/uf/modulos`.

**Entrou:**
- Migrações: `drizzle/0010_configuracao.sql` (condomínio) e `drizzle-plataforma/0002_cadastro_modulos.sql`
  (plataforma), só *expand*, aplicadas pelo laço de deploy em todos os bancos.
- Estrutura por condomínio: as unidades já vinham do banco; o que era fixo no código era só o agrupamento
  ("Bloco"/"Torre"). O `ResolvedorCondominio` lê a `configuracao` do banco do condomínio na 1ª resolução (falha não
  fica em cache) e o provider `ESTRUTURA` virou durável, por condomínio (`database.module.ts`). Sem a linha (piloto):
  `ESTRUTURA_PADRAO.agrupamento`, como antes. `ESTRUTURA_PADRAO` continua só no seed e no `recriar-estrutura` do piloto.
- `app_provisionador` com LOGIN (senha por stdin, como a do `app_plataforma`) e membro de `app_migrator` só com SET
  (bootstrap `10_plataforma.sh`; ressalva em SAAS-02 e R14).
- Compose: serviço `provisionar-cli` (perfil `provisionar`, imagem da API, rede interna, raiz só leitura, 192 MiB).
  A imagem da API passa a levar `drizzle/` (só SQL), lida pela CLI.
- Laço de migração e backup: **conferido** que pegam o condomínio novo assim que ele fica `ativo`
  (`migrar-bancos.mjs`: `ativo`/`suspenso`/`encerrado`; `backup-portaria.sh`: o mesmo filtro), e que ignoram
  `provisionando`. Anexos: a pasta `<raiz>/<condominio_id>/` nasce no primeiro anexo (`mkdir` recursivo do cofre).
- A API passa a atender o condomínio novo sem reiniciar: código desconhecido recarrega o cache em até 5 s; status
  novo de um código já em cache, em até 1 min.
- Testes: `test/saas-provisionar.test.ts` (PGlite: fluxo, login com o código, troca de senha, estrutura própria,
  isolamento contra o piloto, idempotência, retomada, recusas), `test/postgres-real/saas-provisionar.test.ts`
  (roles reais: CREATE DATABASE pelo provisionador, CONNECT, login pela API, isolamento, retomada) e o smoke da CLI
  compilada no `testes-postgres.yml`.

**Onde divergiu ou o doc deixava margem:**
- "Master cadastra → CLI provisiona" virou um passo só: a CLI cadastra a linha da plataforma (não há tela do Master).
- `condominio_contrato` (razão social, CNPJ, contato) **não** é preenchido pela CLI: é cadastro comercial da F5.
- O audit de início fica só na trilha do condomínio; `plataforma_audit` ganha a linha na ativação. Assim um
  provisionamento abandonado sai inteiro da plataforma (as linhas dele não ficam presas à trilha append-only).
- Senha do síndico regerada em toda retomada (a anterior nunca foi entregue) e `--nova-senha-sindico` para a
  temporária que venceu sem uso: o desenho não previa o caso de 72 h passarem antes do primeiro login.

**Ficou para depois:** tela do Master (cadastro, contrato, módulos, UX em §6.2); `ModuloGuard` (SAAS-19); UPDATE da
`configuracao` por tela; `recriar-estrutura` por condomínio com JSON (SAAS-06); acesso do Master auditado (SAAS-09).

### 5.3 F5, entrega 1: app do Master (2026-10-23, código; deploy em `docs/deploy.md` §18)

> **Revisão de 2026-10-23: TOTP removido** (decisão do usuário; risco e compensações em SAAS-08). Mudou:
> - Migração `drizzle-plataforma/0004_master_sem_totp.sql` (*contract* direto): `DROP` de `master_usuario.totp_cifrado`,
>   `totp_mestra_versao`, `totp_ultimo_passo`, dos CHECKs `master_usuario_totp_ck`/`_totp_passo_ck`, de
>   `master_sessao.totp_confirmado_em` e da tabela `master_codigo_recuperacao`. Seguro porque o `migrate` termina antes
>   da `api` nova subir; se o laço falhar depois dela (num banco de condomínio), a API velha fica no ar e só as rotas
>   `/plataforma` dela quebram (500), as de condomínio não.
> - `POST /plataforma/auth/login` recebe só `{ email, senha }` (DTO estrito: `codigo` agora é 400). Mensagem única
>   "E-mail ou senha inválidos.". Saíram `src/plataforma/totp.ts`, `segredo-totp.ts`, o anti-replay e
>   `test/master-totp.test.ts`; o serviço de login não injeta mais a chave mestra (o limite de tentativas ainda usa).
> - Troca de senha do Master: mínimo 16 (`SENHA_MIN_MASTER`); `problemasDaSenha(..., { minimo })` mantém 12 para o
>   condomínio.
> - CLI `criar-usuario-plataforma`: só senha temporária; `--reemitir-totp` saiu (vira erro de uso), `--nova-senha` fica;
>   o serviço `usuario-plataforma-cli` não recebe mais a chave mestra.
> - `apps/plataforma`: login sem o campo "Código do autenticador"; troca de senha avisa o mínimo de 16.
>
> Os itens abaixo que falam de TOTP, anti-replay, `totp_confirmado_em` e `--reemitir-totp` descrevem a entrega 1 como
> foi feita e estão substituídos por esta revisão.

**Entrou:**
- **Banco `plataforma`, migração `drizzle-plataforma/0003_master_auth.sql`** (só *expand*; as tabelas da §4.1 já
  existiam vazias): `master_usuario` ganha `totp_mestra_versao`, `totp_ultimo_passo` (anti-replay), `deve_trocar_senha`,
  `senha_temporaria_expira_em`, `ultimo_acesso` e CHECKs (formato do e-mail, tamanho do segredo cifrado, temporária só com
  troca pendente); `master_sessao` ganha `motivo_revogacao` e índice por usuário; `plataforma_login_limite` ganha o tipo
  `master_ip`. Sem GRANT novo (os da 0000 são por tabela) e sem DELETE para `app_plataforma`.
- **API, módulo `src/plataforma/`** (só o pool `app_plataforma` e a chave mestra; teste de arquitetura: nenhum arquivo dali
  injeta `DB`/`CONDOMINIO`/`PG_POOL`/`REGISTRO_BANCOS`): `POST /plataforma/auth/login`, `GET /plataforma/auth/me`,
  `POST /plataforma/auth/logout`, `POST /plataforma/auth/trocar-senha`, `GET /plataforma/condominios`,
  `POST /plataforma/condominios`, `PATCH /plataforma/condominios/:id/modulos`. Guarda global estática `PlataformaGuard` +
  decorators `@PlataformaPublica/@PlataformaAutenticada/@PlataformaAcao` (matriz `MATRIZ_PLATAFORMA` em
  `src/dominio/rbac-plataforma`: `master` tudo, `suporte` só lista). As guardas de condomínio passam a ignorar a
  política `{ tipo: 'plataforma' }` (duas linhas em `auth/guards.ts`; o fluxo de auth do condomínio não mudou), e o
  middleware de condomínio não resolve condomínio nenhum em `/api/v1/plataforma/*` (`plataforma.ts`).
- **Trilha da plataforma** (`plataforma_audit`, append-only desde a 0000): `auth.login`, `auth.login_falha` (com o motivo;
  o e-mail digitado nunca), `auth.bloqueio`, `auth.logout`, `auth.trocar_senha(_falha)`, `acesso.negado`,
  `condominio.provisionar` (ator = Master, `origem: plataforma`, na MESMA transação da ativação), `condominio.provisionar_falha`,
  `condominio.modulos` (antes/depois, na mesma transação do UPDATE), `master.criar`, `master.reemitir_credencial` (CLI).
- **CLI `criar-usuario-plataforma`** (bootstrap): cria com senha temporária e segredo TOTP, recusa e-mail repetido,
  `--reemitir-totp` e `--nova-senha`; serviço `usuario-plataforma-cli` (perfil `plataforma`, `logging: none`).
- **Serviço provisionador** (`src/cli/servidor-provisionador.ts`, serviço `provisionador`, perfil `provisionar`).
- **Front `apps/plataforma`**: login, troca obrigatória, "Licenças" (cards, busca, filtro por situação), novo
  condomínio (prévia das unidades com o `gerarUnidades` do domain; senha do síndico uma vez, "Já copiei, fechar"),
  módulos. `vercel.json` próprio (rewrite para a mesma API, CSP estrita, `noindex`, previews desligados).
- **Testes:** `test/master-totp.test.ts` (vetores das RFCs 4226/6238, janela, replay, segredo cifrado),
  `test/master-api.test.ts` (login, erros indistinguíveis, replay, bloqueio, cookies cruzados nos dois sentidos,
  inatividade, troca obrigatória, criação com provisionamento real sobre PGlite, senha uma vez e fora dos logs, módulos,
  papel suporte), `test/master-cli.test.ts` (CLI como `app_plataforma`, serviço provisionador: token, 400/413/422/500,
  um pedido por vez), testes do front e o e2e `apps/plataforma/e2e` (Playwright sobre a API em PGlite). CI:
  `testes-web.yml` (no monorepo; build, testes e e2e do `apps/plataforma`, hoje no Front) e `testes-postgres.yml` (smoke da CLI e do provisionador
  com roles reais).

**Decisões onde o doc deixava margem (menor risco):**
- **Login em UM passo** (e-mail + senha + código no mesmo envio). Em dois passos, "senha certa, agora o código" confirma
  a senha a quem não tem o celular, e o meio do caminho exige uma pré-sessão (outro token, outra tabela, outra rota).
  Toda falha (e-mail inexistente, inativo, senha errada, código errado ou reutilizado) dá a mesma resposta, com o mesmo
  argon2 (fictício para inexistente) e o mesmo limite. A senha temporária vencida só é revelada a quem acerta senha e código.
- **TOTP** com `node:crypto` (sem dependência nova): SHA1, 6 dígitos, 30 s, janela ±1. **Anti-replay** por
  `totp_ultimo_passo`: só um passo MAIOR que o último aceito vale, gravado num `UPDATE ... WHERE totp_ultimo_passo < passo`
  atômico na transação que cria a sessão (dois logins simultâneos com o mesmo código: um vence).
- **Segredo TOTP cifrado** com AES-256-GCM pela chave mestra (mesmo padrão do envelope das chaves e do cofre dos
  anexos), AAD `portaria:totp:<master_usuario_id>`, coluna = nonce || cifrado || tag, versão da mestra em coluna própria.
  Rotação da mestra: re-cifrar as linhas (como `condominio_chave`).
- **Sessão:** inatividade 15 min e máximo 8 h (SAAS-08; 2 h e 12 h desde 2026-10-29), token de 256 bits, só o SHA-256 no banco, `totp_confirmado_em`
  obrigatório para valer. Troca de senha revoga as outras sessões; reemissão de credencial pela CLI revoga todas.
- **Cookie** `__Secure-portaria_plataforma` (dev/e2e: `portaria_plataforma`), `HttpOnly`, `Secure`, `SameSite=Strict`,
  **`Path=/api/v1/plataforma`**, sem `Domain`. O doc previa `__Host-`, que exige `Path=/`; o caminho restrito foi
  preferido porque o navegador nem envia o cookie da plataforma às rotas de condomínio. Com o `.vercel.app` na Public
  Suffix List (topologia antiga), nenhum subdomínio vizinho conseguia plantar cookie para o host, que é o que o `__Host-`
  evitaria. Desde 2026-10-31 o host é `api.condenexo.com.br`, em domínio próprio: outros subdomínios do mesmo site
  entram no risco aceito de `docs/02_especificacao_tecnica.md` §14 nº 26 (mitigado pela verificação de Origin). A guarda
  de cada lado só lê o próprio nome, e os tokens estão em tabelas de bancos diferentes: cookie cruzado = 401 (testado
  nos dois sentidos, inclusive trocando o valor de nome).
- **Limite de tentativas:** o algoritmo da 0008 do condomínio (par login+IP bloqueia, IP bloqueia, login sozinho só
  atrasa), na tabela da plataforma, com chaves HMAC de subchave HKDF da chave mestra. Os mesmos números de `config.login`.
- **E-mail é o login** do Master (a coluna `email` da 0000; SAAS-09 já previa o e-mail como identificação na trilha).
- **Criação de condomínio pela tela sem dar `CREATEDB` à API.** O pedido pedia "reutilizar `provisionar.ts`" e o doc
  dizia "a API não cria banco". As duas coisas cabem num **serviço provisionador**: container separado, só na rede
  interna, ligado à mão (perfil) enquanto há onboarding, que roda o mesmo `provisionar()` da CLI e aceita uma única
  operação autenticada por token (`PROVISIONADOR_TOKEN`, tempo constante). A API não recebe as senhas de
  `app_provisionador` nem de `app_migrator` (dono de todos os bancos e das trilhas): invadir a API dá, no máximo, a
  capacidade de pedir um condomínio novo enquanto o serviço está ligado, e isso fica na trilha da plataforma. Alternativa
  descartada: dar as duas senhas à API (uma RCE viraria adulteração de trilha e `DROP DATABASE`).
- **Senha do síndico** volta uma vez na resposta do POST (`Cache-Control: no-store`), não é logada nem vai à trilha; no
  front, não passa pelo React Query (o `useMutation` guardaria o resultado no cache de mutações) e some ao fechar o modal.
  Reenviar a mesma entrada responde `ja_provisionado` sem senha (a CLI `--nova-senha-sindico` gera outra).
- **Módulos:** PATCH com a lista inteira (normalizada na ordem de `MODULOS`); sem mudança, sem linha na trilha;
  condomínio encerrado/excluído recusa. A recusa de rota no condomínio (`ModuloGuard`) continua para depois.
- **Códigos de recuperação** (`master_codigo_recuperacao`, SAAS-08) **não** entraram: a recuperação nesta entrega é a CLI
  `--reemitir-totp` na VPS (exige shell, que é o controle certo para poucos Masters). *(2026-10-23: a tabela saiu na
  0004; a recuperação é só `--nova-senha`.)*

**Ficou para depois:** ~~entrega 2 (SAAS-09: leitura auditada dos dados do condomínio, tela "Acessos da plataforma");
`ModuloGuard` e `modulos` em `/auth/me`~~ (feitos na entrega 2, §5.4); contrato (`condominio_contrato`) e tipo do condomínio na tela; métricas
(`condominio_metrica`); 2FA (TOTP ou WebAuthn), se a decisão de 2026-10-23 for revista; limite global por IP para os logins de condomínio (SAAS-14).


### 5.4 F5, entrega 2: Master lê os dados do condomínio, auditado, e `ModuloGuard` (2026-10-24, código; deploy em `docs/deploy.md` §20)

**Sem migração.** O `audit_log` já aceita a linha da plataforma: o CHECK `audit_log_acao_ck` aceita `plataforma.ler` e
`plataforma.exportar`, e o `audit_log_usuario_ck` aceita `usuario_id`/`usuario_papel` nulos juntos. Continua
append-only (nada de UPDATE/DELETE novo) e a cadeia de `evento_acesso` não é tocada. O `app_rw` já tem `INSERT` no
`audit_log` e `SELECT` no que é lido: **nenhum GRANT novo**, nada a cobrir no `testes-postgres.yml`. O índice parcial para
o filtro `plataforma.%` ficou de fora: a tela filtra por período (índice `audit_log_em_ix`) e são poucas linhas por
condomínio. Se a trilha crescer a ponto de pesar, vira uma `drizzle/0013` *expand* (`CREATE INDEX CONCURRENTLY ... WHERE
acao LIKE 'plataforma.%'`).

**Entrou (API):**
- **Leitura do Master**, `src/plataforma/leitura-master.controller.ts`, em `GET /api/v1/plataforma/condominios/:id/...`
  com a ação `condominio.ler` (só papel `master`; o contrato lista nominalmente quem tem esse papel):
  `catalogo`, `unidades`, `unidades/:ref`, `unidades/:unidadeId/autorizadores`, `usuarios`, `pessoas`,
  `pessoas/:pessoaId`, `vinculos`, `vinculos/:vinculoId`, `funcionarios`, `funcionarios/:pessoaId`, `eventos-acesso`,
  `eventos-acesso/:eventoId`, `eventos-acesso/:eventoId/correcoes`, `acessos/presentes`, `autorizacoes-previas/hoje`,
  `autorizacoes-previas?unidadeId=`, `restricoes/pendentes`, `restricoes?unidadeId=`, `encomendas`, `encomendas/resumo`,
  `encomendas/:encomendaId`, `ocorrencias`, `ocorrencias/:ocorrenciaId`, `ocorrencias/:ocorrenciaId/historico`,
  `relatorios/resumo` (`plataforma.ler`); `ocorrencias/:ocorrenciaId/anexos/:documentoId` e `relatorios/resumo/csv` como
  `plataforma.exportar`. O JSONL verificável (`POST auditoria/exportacoes`) saiu do Master em 2026-10-30 (ver abaixo). Os serviços são os do síndico, com a
  **mesma view**, minimizada na saída desde 2026-10-30 (ver "Minimização do dado de terceiros" abaixo; o teste compara,
  rota a rota, o corpo do Master com o do síndico passado pela minimização).
- **Ponto único**, `AcessoPlataformaService` (`src/plataforma/acesso-plataforma.service.ts`): resolve o condomínio, obtém a
  subárvore durável dele (`contextoDoJob`, como os jobs), chama o serviço, grava a linha no `audit_log` do condomínio e
  a linha em `plataforma_audit`, e só então devolve. Teste de arquitetura: em `src/plataforma`, só ele cita
  `contextoDoJob`/`ModuleRef`/`DB`; fora dele, só o agendador monta subárvore sem requisição; e todo handler do controller
  de leitura passa por ele. O pool lido é o `app_rw` daquele banco; o `app_plataforma` continua sem CONNECT nos bancos
  de condomínio.
- **Linha no `audit_log` do condomínio:** `usuario_id`/`usuario_papel` nulos, `usuario_nome = plataforma/<e-mail>` (sem a
  máscara de dígitos do nome informado: o e-mail do operador é a identificação que o síndico precisa ver), `acao`
  `plataforma.ler` ou `plataforma.exportar`, `entidade` (tabela lida), `registro_id` (quando a rota é de um registro e
  o id é uuid), `ip` do Master e `depois = { rota, metodo, status, master_usuario_id }`. A rota é o **padrão** sem o
  prefixo (`/pessoas/:pessoaId`), nunca a URL: query string e corpo (filtros, nome buscado) não vão para a trilha.
- **Linha em `plataforma_audit`:** `condominio.ler`/`condominio.exportar`, o condomínio e `{ entidade, rota, metodo, status,
  ip }`, sem dado de morador nem id de registro do condomínio.
- **Tela do condomínio:** `GET /api/v1/auditoria/acessos-plataforma?de&ate&cursor&limite` (ação nova
  `auditoria.acessos_plataforma`: síndico e auditor; a administração não), `acao LIKE 'plataforma.%'`, mais recentes
  primeiro, devolvendo só quando, quem, tipo, entidade, registro, rota, método e status (o `master_usuario_id` não sai).
- **`ModuloGuard`** (`src/tenancy/modulo.guard.ts`): `@Modulo('<nome>')` nos controllers `encomendas`, `ocorrencias`,
  `importacoes`, `veiculos`, `funcionarios` e `relatorios`, e nos 6 handlers de autorização prévia do `AcessoController`
  (o resto dele, eventos e restrições, é núcleo). Guarda global durável registrada **depois** da `SessaoGuard` e da
  `PapelGuard`: sem sessão continua 401, sem papel continua o 403 do RBAC. Módulo desligado: **403 `MODULO_DESLIGADO`**,
  "Este módulo não está contratado para este condomínio.", gravado como `acesso.negado` (ação `modulo.<nome>`). Os
  módulos vêm do cache do `ResolvedorCondominio` (agora com a coluna `modulos`), renovado a cada 1 min; o PATCH do
  Master invalida o cache do próprio processo na hora (outras réplicas, em até 1 min). `/auth/me`, o login e `/catalogo`
  levam `modulos`. Teste de arquitetura: a lista de controllers do AppModule é exatamente núcleo + os seis com `@Modulo`.
- **Refatorações sem mudança de comportamento:** `PessoasService.ficha(papel, id)` (era o `Contexto` inteiro, só para o
  papel); `OcorrenciasService.lerAnexo` separado de `conteudo` (que segue gravando `documento.ler`);
  `AuditoriaRotasService.gerarExportacao` separado de `exportar` (que segue gravando `auditoria.exportar`); os DTOs de
  listagem passaram a ser exportados para o controller do Master validar a query igual.

**Entrou (front):**
- `apps/web`: `modulos` no `UsuarioSessao` (login/me; lista ausente = API anterior = nada se esconde); menu, rotas
  (`RequireRole`), F3/F4, cartões e atalhos do Painel, meios "Autorização prévia" e "Escala" da entrada, seções
  "Veículos" e "Autorizações prévias" da unidade somem com o módulo desligado; seção opcional que receba
  `MODULO_DESLIGADO` vira vazia em vez de derrubar a tela. Tela **"Acessos da plataforma"** (`/acessos-plataforma`,
  grupo Auditoria do menu): período (padrão 30 dias), paginada, sem ação de apagar.
- `apps/plataforma`: "Abrir" em cada card de Licenças (só `master`, situação ativo/suspenso/encerrado) leva a
  `/admin/condominios/:id`, com o aviso fixo **"Cada consulta fica registrada na trilha do condomínio e o síndico vê."**
  e abas Cadastro, Unidades, Pessoas, Usuários, Acessos, Encomendas, Ocorrências e Relatórios. A aba inicial (Cadastro)
  só mostra o cadastro da plataforma: abrir a tela não grava nada na trilha. Cada aba busca só quando aberta, sem
  polling, sem refetch no foco e sem retry automático (cada tentativa seria outra linha na trilha do síndico).

**Decisões onde o doc deixava margem (menor risco):**
- **A linha é gravada depois da leitura e antes da resposta**, para levar o status verdadeiro (200, 404...). O dado só
  sai depois das duas gravações; falhou qualquer uma, **503 `TRILHA_INDISPONIVEL`** e nada é mostrado. Leitura que falha
  (registro inexistente, 404) também fica na trilha, com o status: tentar ler é acesso.
- **Ordem das gravações:** primeiro o `audit_log` do condomínio (o controle externo, que o síndico vê), depois o
  `plataforma_audit`. São bancos diferentes, sem transação comum: se a segunda falhar, a do condomínio fica (o síndico
  vê a tentativa) e o Master recebe 503.
- **Uma linha por requisição:** lista paginada = 1 linha (não uma por item); "Carregar mais" = outra requisição, outra linha.
- **Condomínio encerrado: leitura permitida** enquanto o banco existir (suporte e exportação de fim de contrato,
  SAAS-11). **Excluído ou desconhecido: 404.** `provisionando`: 409 `CONDOMINIO_PROVISIONANDO` (não há dado ainda).
- **Leitura do Master não é bloqueada por módulo desligado:** o dado continua existindo; o `ModuloGuard` ignora rotas da
  plataforma (testado).
- **Visão do síndico:** a ficha da pessoa é lida com o papel `sindico` (o motivo da desativação aparece, como para o
  síndico). Nada a mais que o síndico.
- **Fora da leitura do Master, de propósito:** escrita de qualquer tipo; a **exportação LGPD do titular** (leva CPF e
  telefone em claro e é resposta do controlador ao titular); a trilha de alterações, a verificação de integridade e os
  selos (não servem ao suporte; entram se houver pedido); a busca por nome/CPF (`POST /pessoas/busca`): o termo é dado
  pessoal e a lista paginada atende ao suporte.
- **`suporte` não lê**: só `master` tem `condominio.ler`.
- **IP do Master no `audit_log` do condomínio:** gravado, como em toda linha da trilha; a tela não o mostra.
- **Menu da portaria** reflete os módulos do login/`/auth/me`: quem já está logado continua vendo o item até recarregar
  ou entrar de novo, mas a API já recusa em até 1 min. O aviso do modal de módulos diz isso.

**Minimização do dado de terceiros (2026-10-30).** O Master é operador (art. 39) e deve ver o mínimo (art. 6º, III). As
views continuam as do síndico, mas a resposta de toda rota de leitura do Master passa por `src/plataforma/minimizacao.ts`,
aplicada no ponto único (`AcessoPlataformaService.ler`, antes da trilha: se falhar, a linha leva o status do erro e nada
sai). A rota do síndico não muda. Regras por nome de campo, iguais em qualquer view:
- **Nome de pessoa** (morador, visitante, prestador, funcionário, destinatário, quem retirou, quem autorizou ou pediu):
  `mascararNome` de `src/dominio/nome`, formato do protótipo, "Ana R******" (primeiro nome + inicial do último
  sobrenome, sem contar da/de/dos/e; 6 asteriscos fixos, sem revelar o tamanho; uma palavra só fica como está;
  "Pessoa anonimizada" e marcadores entre parênteses ficam). Campos: `pessoaNome*`, `autorizadoPorNome*` (exceto
  "Área comum/Sem solicitante — cadastrada por <usuário>"), `destinatario`, `retiradaPorNome`, `solicitadaPorNome`,
  `solicitanteNome` e `nome` de objeto de pessoa (com `documentoMascarado` ou `pessoaId`).
- **Texto livre oculto**, trocado por "(texto livre oculto na leitura da plataforma)": `descricao` e `envolvidos` da
  ocorrência, `motivo` da restrição, `justificativa` e `observacao` do evento e da correção, `descricao`/`observacao` da
  conferência do vínculo, `desativacaoMotivo`. Vazio e nulo ficam (o Master sabe se havia texto). **Por que omitir e não
  truncar nem manter:** texto livre cita qualquer pessoa ("a pedido de Ana Ribeiro"); truncar ainda vaza o começo, e
  procurar nomes no texto não é confiável. O suporte trabalha com tipo, situação, datas, unidade e quem registrou; o
  conteúdo, quando preciso, vem do síndico.
- **Placa:** 3 primeiros caracteres + "****" (dado pessoal ligado ao morador; o suporte não precisa dela inteira).
- **Nome de usuário do sistema fica** (`operadorNome`, `abertaPorNome`, `recebidaPorNome`, `cadastradaPorNome`, lista de
  Usuários e Síndicos, operador no CSV de relatórios): é quem age em nome do controlador, na função; o Master gerencia os
  síndicos pelo nome (§5.5) e o suporte precisa saber quem registrou o quê. Efeito colateral aceito: o síndico ou porteiro
  que também é morador aparece com nome completo como usuário e mascarado como pessoa.
- **Falha fechada:** a minimização percorre objeto simples, array e `Pagina`; Buffer (anexo) e Date passam; qualquer outra
  classe na resposta é erro (500), para view nova não sair sem minimização.
- **Fora da minimização, de propósito:** o **anexo** de ocorrência (arquivo, `plataforma.exportar`; não há como mascarar uma
  imagem).
- **Sem JSONL para o Master (2026-10-30):** a linha `evento` do JSONL é o registro com hash; mascarar o texto livre ou a placa
  dela quebraria a verificação, que é o propósito do arquivo. Como o app do Master não usava a rota, ela saiu (404). A
  conferência offline da trilha é do condomínio, pela exportação do síndico (Histórico).

**Riscos remanescentes:**
- Conta do Master comprometida lê os dados de todos os condomínios (R7, sem 2FA desde 2026-10-23): a trilha mostra a
  leitura ao síndico depois do fato, não a impede. Mitigação de processo: contrato, poucos `master`, revisão periódica.
- Linha órfã em `plataforma_audit` não acontece, mas linha do condomínio sem a da plataforma sim (falha entre as duas).
- O cache de módulos é por processo: com mais de uma réplica, desligar vale em até 1 min nas outras.

---

### 5.5 F5, entrega 3: Master gerencia os síndicos do condomínio (2026-10-26, código; deploy em `docs/deploy.md` §21)

**Decisão do usuário (2026-10-26).** O Master age **só sobre usuários de papel `sindico`** de um condomínio, pela aba
"Síndicos" do app do Master (`/admin/condominios/:id?aba=sindicos`; atalho "Síndicos" no card de Licenças):
1. **Adicionar síndico:** nome + login (mesmas regras do provisionamento, `LOGIN_SINDICO`; sugestão a partir do nome);
   senha temporária gerada pela API, mostrada uma vez.
2. **Trocar síndico:** cria o novo e desativa o antigo **na mesma transação**, revogando as sessões do antigo.
3. **Nova senha do síndico:** temporária de 72 h, troca obrigatória, sessões revogadas, limite de login do alvo zerado
   (mesmo efeito da tela de Usuários e da CLI). Síndico desativado: recusado (reativar antes).
4. **Desativar / reativar** um síndico existente.

Revisa o "Master só lê" do SAAS-09 com esta exceção. Os outros papéis (administração, porteiro, auditor) e todo o resto
do dado do condomínio continuam só leitura para o Master.

**Sem migração.** O CHECK `audit_log_acao_ck` (`^[a-z][a-zA-Z_]*\.[a-z][a-zA-Z_]*$`) aceita `plataforma.usuario_criar`,
`plataforma.usuario_trocar`, `plataforma.usuario_redefinir_senha`, `plataforma.usuario_desativar` e
`plataforma.usuario_reativar`; o `plataforma_audit_acao_ck` aceita `condominio.sindico_*` e `auth.reautenticar_falha`; o
`audit_log_usuario_ck` aceita `usuario_id`/`usuario_papel` nulos juntos. As escritas são as que a tela de Usuários do
síndico já faz no `usuario_sistema` e na `sessao` com o `app_rw` (INSERT/UPDATE): **nenhum GRANT novo**. O `audit_log`
continua append-only e a cadeia de `evento_acesso` não é tocada.

**Entrou (API):**
- Rotas em `src/plataforma/sindicos-master.controller.ts`, ação nova **`condominio.sindicos`** em
  `src/dominio/rbac-plataforma` (só `master`; `suporte` recebe 403 `SEM_PERMISSAO`, gravado como `acesso.negado`
  na trilha da plataforma):
  - `POST /api/v1/plataforma/condominios/:id/sindicos` `{ nome, login, motivo, senhaMaster }` → 201
    `{ usuario, senhaTemporaria, expiraEm }`;
  - `POST .../sindicos/:usuarioId/trocar` `{ nome, login, motivo, senhaMaster }` → 201
    `{ usuario, substituido, senhaTemporaria, expiraEm }`;
  - `POST .../sindicos/:usuarioId/redefinir-senha` `{ motivo, senhaMaster }` → 200 `{ usuario, senhaTemporaria, expiraEm }`;
  - `POST .../sindicos/:usuarioId/desativar` e `.../reativar` `{ motivo, senhaMaster }` → 200 `{ usuario }`.
  - A lista é a leitura auditada `GET .../sindicos` (`plataforma.ler`, no controller de leitura): só `papel = sindico`,
    sem paginação, a mesma view de gestão (`colunasGestao`, sem nada de senha).
- **Corpo estrito** (`z.strictObject`): não existe campo de senha do síndico. A senha do síndico é **sempre gerada pela
  API e temporária**; campo extra é 400. `motivo` com 15 a 500 caracteres (o critério `JUST`, `MIN_JUSTIFICATIVA`).
- **Ponto único mantido:** `AcessoPlataformaService.alterarSindico` (mesmo arquivo da leitura). Ordem:
  1. **reautenticação** (`AuthMasterService.reautenticar`): argon2 da senha do Master sob o **mesmo limite do login**
     (chaves `master`, `master_ip` e `ip`; reserva antes de verificar; atraso graduado). Errada: **403
     `SENHA_MASTER_INCORRETA`** com erro no campo `senhaMaster` (403 e não 401: a sessão continua válida e o app não a
     trata como expirada), linha `auth.reautenticar_falha` em `plataforma_audit` (ação tentada, condomínio, IP; nunca o
     texto digitado) e `auth.bloqueio` ao atingir o máximo. Bloqueado: 429 `LOGIN_BLOQUEADO` sem argon2. A falha **conta
     para o login**: 10 senhas erradas no mesmo IP bloqueiam também o login do Master naquele IP (testado);
  2. **situação do condomínio:** `ativo` e `suspenso` aceitam; `encerrado` 409 `CONDOMINIO_ENCERRADO` (contrato
     encerrado: só leitura até a exclusão); `provisionando` 409 `CONDOMINIO_PROVISIONANDO`; `excluido`/desconhecido 404;
  3. subárvore do condomínio (`contextoDoJob`) e `UsuariosService.sindicoPelaPlataforma` (método novo do serviço de
     usuários existente; o ator não é usuário do condomínio, então não passa pelo `revalidarAtor`).
- **Transação no banco do condomínio:** trava **todos** os síndicos (`FOR UPDATE`, ordem por id: serializa ações
  concorrentes sobre síndicos e protege a regra do último ativo), confere o alvo e aplica a mudança, grava a(s) linha(s)
  `plataforma.usuario_*` no `audit_log` **nesta transação** e grava a linha de `plataforma_audit` **antes do COMMIT**.
- **Linha no `audit_log` do condomínio:** `usuario_id`/`usuario_papel` nulos, `usuario_nome = plataforma/<e-mail>`,
  `entidade = 'usuario_sistema'`, `registro_id` do usuário afetado, `ip` do Master e `depois = { motivo, rota, metodo,
  master_usuario_id, usuario: { nome, login, papel }, ...o que mudou }` (ex.: `ativo: { antes, depois }`,
  `deve_trocar_senha`, `senha_temporaria_expira_em`, `sessoes_revogadas`). **Nunca hash nem senha** (o snapshot da
  auditoria ainda remove qualquer chave de senha; testado). A troca grava **duas linhas** `plataforma.usuario_trocar`, uma
  por usuário afetado (`troca: 'entrou'`, com `substitui_usuario_id`; `troca: 'saiu'`, com `substituido_por_usuario_id`),
  para que o histórico de cada usuário (índice `entidade, registro_id`) mostre a troca.
- **Linha em `plataforma_audit`:** `condominio.sindico_criar|trocar|redefinir_senha|desativar|reativar`, o condomínio e
  `{ usuario_id, rota, metodo, ip }`. **Sem o motivo nem nome/login:** o motivo é texto livre que pode citar morador, e a
  plataforma não tem a redação LGPD da trilha do condomínio; o `usuario_id` liga as duas linhas.
- **Recusas:** usuário que não é `sindico` 422 `USUARIO_NAO_SINDICO` (inexistente 404); desativar o **último síndico
  ativo** 422 `ULTIMO_SINDICO_ATIVO` ("use Trocar"); trocar síndico já desativado 422 `SINDICO_DESATIVADO`; nova senha de
  desativado 422 `USUARIO_DESATIVADO`; desativar desativado / reativar ativo 422 (`USUARIO_JA_DESATIVADO` /
  `USUARIO_JA_ATIVO`; sem linha de "nada mudou" na trilha); reativar anonimizado pela retenção 409
  `USUARIO_ANONIMIZADO`; login repetido (sem diferença de maiúsculas) 409 `LOGIN_EXISTENTE` no campo `login`.
- **"Acessos da plataforma"** (`GET /auditoria/acessos-plataforma`): o filtro continua `acao LIKE 'plataforma.%'`, então as
  ações novas entram; a resposta ganhou `motivo`, `alvo` ("Nome (login)") e `troca` (nulos nas leituras).
- Teste de arquitetura atualizado (`test/master-leitura.test.ts`): em `src/plataforma`, só o `AcessoPlataformaService` obtém
  subárvore; todo handler do controller de síndicos chama `alterarSindico`; a reautenticação vem antes de resolver o
  condomínio; só o ponto único chama `sindicoPelaPlataforma`.

**Entrou (front):**
- `apps/plataforma`: aba **"Síndicos"** (segunda aba, depois de Cadastro; abre direto por `?aba=sindicos`): tabela com nome,
  login, situação e último acesso; "Adicionar síndico" e, por linha, "Trocar", "Nova senha", "Desativar" (desabilitado
  quando é o único ativo, com o texto "use Trocar") e "Reativar". Cada ação abre um diálogo com o efeito em texto claro
  ("perde o acesso na hora"), motivo e "Sua senha (confirmação)"; erros por campo como no resto do app, foco no primeiro
  erro, senha do Master apagada depois de qualquer erro. A senha temporária sai no mesmo `SenhaSindicoModal` da criação
  (uma vez, copiar, some ao fechar), **sem `useMutation`** (o resultado não vai para o MutationCache) e sem reler a
  lista: ela é atualizada com o que a resposta devolve (cada releitura seria outra linha na trilha do síndico). Depois
  da ação, o foco vai para a confirmação. Condomínio encerrado: a lista aparece sem botões.
- `apps/web`: "Acessos da plataforma" mostra o tipo da ação ("Síndico adicionado", "Troca de síndico", "Nova senha de
  síndico", "Síndico desativado", "Síndico reativado"), o usuário afetado ("Entrou:"/"Saiu:" na troca) e o motivo.

**Decisões onde o pedido deixava margem (menor risco):**
- **Ordem das gravações:** mudança + `audit_log` do condomínio numa transação; `plataforma_audit` gravada dentro dela,
  antes do COMMIT. Falhou qualquer das duas: rollback, **503 `TRILHA_INDISPONIVEL`** ("Nada foi alterado") e nada
  muda (testado para as duas falhas). A única janela que sobra é o COMMIT do condomínio falhar depois da linha da
  plataforma gravada: a plataforma registraria uma ação que não aconteceu (sobra registro, nunca falta). A ordem inversa
  (condomínio primeiro, plataforma depois, como na leitura) deixaria a mudança feita sem a linha da plataforma e o
  Master com 503 sem a senha temporária.
- **Reautenticação primeiro**, antes de resolver o condomínio: com a senha errada, nada do condomínio é tocado. A falha
  fica só em `plataforma_audit` (não no `audit_log` do condomínio): nada mudou lá.
- **Suspenso aceita escrita** (o pedido recusava excluído, provisionando e encerrado): trocar ou destravar o síndico de um
  condomínio suspenso faz parte de resolver a suspensão. O login de condomínio suspenso continua recusado pela API.
- **Concorrência:** o lock de todos os síndicos serializa Master contra Master. Master contra a tela de Usuários do
  próprio condomínio pode dar deadlock (ordens de lock diferentes): o Postgres aborta uma das duas, o filtro global
  responde 409 `CONFLITO_CONCORRENTE` e nenhum estado fica sem síndico ativo.
- **Rótulo do usuário afetado** (`alvo`) vem do `depois` da linha, gravado no momento da ação (nome e login daquele
  momento, com a máscara de dígitos da trilha).

**Riscos remanescentes:**
- **R7 agravado:** conta Master vazada pode criar síndico (ou trocar o atual, ou gerar nova senha) em qualquer condomínio
  e entrar como ele, alcançando escrita no dado do condomínio. Mitigação: reautenticação no próprio pedido (sessão
  roubada não basta; tentativas contam no limite do login), motivo obrigatório, trilha do condomínio na mesma transação e
  visível ao síndico e ao auditor em "Acessos da plataforma", e o síndico trocado perde o acesso na hora (percebe). Sem
  2FA (SAAS-08), quem tem a senha do Master passa pela reautenticação: o controle continua sendo depois do fato.
- Não há aviso ativo (e-mail) ao síndico quando o Master age: ele vê na tela "Acessos da plataforma". Fica para quando
  houver canal de e-mail.
- Linha de `plataforma_audit` de uma ação cujo COMMIT falhou (janela acima).

## 6. Impacto

### 6.1 API (`a API`)

- `database.module.ts`: `DB` vira provider durable resolvido por condomínio; novo `PLATAFORMA_DB`; registro de pools
  com teto global e fechamento por ociosidade.
- Novo módulo `plataforma` (controllers `/plataforma/*`, guarda `@Plataforma`, sessão do Master (sem 2FA desde 2026-10-23), condomínios,
  acesso do Master auditado com `AcessoPlataformaService` (SAAS-09), módulos com `ModuloGuard` (SAAS-19), métricas) e
  CLI `provisionar-condominio` (**feita**, §5.2), `excluir-condominio`, `rotacionar-chave`.
- `auth`: cookie `v2.<condominio_id>.<token>`; login com código; `SessaoService.validar` no banco escolhido. (A rota
  `POST /auth/suporte` e o usuário `origem = 'suporte'` saíram com a SAAS-09 de 2026-10-22.)
- `config`: `PORTARIA_HMAC_CPF_KEY` e `PORTARIA_KEK` saem do ambiente da API ao fim da F2; entra
  `PORTARIA_CHAVE_MESTRA` (+ versão) e `DATABASE_URL_PLATAFORMA`. `ESTRUTURA` vem de `configuracao` (feito, §5.2).
- `documentos/cofre.ts`: KEK vem do condomínio; diretório `<dir>/<condominio_id>/`; AAD inclui o condomínio
  (`portaria:dek:<condominio_id>:<id>:v<versao>`) **só nas DEKs novas**, com versão de formato para ler as antigas.
- `jobs`: laço por condomínio, trava por condomínio, paralelismo limitado.
- `selo`: endpoint público v2 (raiz do dia), prova de inclusão.
- `comum/log.ts`: `condominio_id` na allowlist.

**Testes obrigatórios de isolamento** (falham o CI):
1. Para **cada rota** de `docs/api/openapi.json` com parâmetro de id: criar o recurso no condomínio B, chamar com
   sessão de A → 404 (nunca 200 nem 403, que confirmaria a existência).
2. Cookie de A com prefixo trocado para B → 401; sem prefixo depois da janela de transição → 401.
3. Login com código de A e usuário de B (mesmo login nos dois) → credenciais inválidas; tempo de resposta na mesma faixa.
4. Busca por CPF: o mesmo CPF cadastrado em A e B gera `documento_busca` diferente.
5. Anexo de A com DEK desembrulhada pela KEK de B → falha de autenticação do GCM.
6. Sessão de plataforma em rota de condomínio → 401, e vice-versa; pool `app_plataforma` tentando conectar em banco de
   condomínio → erro de permissão (teste com Postgres real, `test:pg`).
7. Teste de arquitetura: só `plataforma/` e `ResolvedorCondominio` importam `PLATAFORMA_DB`; nenhum serviço de
   condomínio guarda estado em campo estático.
8. Agendador com dois condomínios: falha forçada em A não impede o selo de B.

**Ressalva de teste já existente:** a API nos testes roda no PGlite como superusuário (`test/helpers/app.ts:77-91`).
Para os testes de isolamento, cada condomínio é uma instância PGlite própria (isolamento real), e os testes de
permissão de role ficam no `test:pg`.

### 6.2 Front (`apps/web`)

- Login: campo "Código do condomínio", lembrado como preferência; cabeçalho `X-Condominio` só no login. **Feito (F2, §5.1).**
- Layout: nome do condomínio no cabeçalho (**feito**, de login/`/auth/me`, não de `configuracao`); rótulos de agrupamento já vêm da API (`/catalogo`).
- ~~Tela do síndico: aprovar/encerrar acesso de suporte; rota `/suporte?codigo=`~~ (saíram com a SAAS-09 de
  2026-10-22). No lugar: tela **"Acessos da plataforma"** para o síndico (e o auditor), lista do `audit_log` com
  `acao` `plataforma.*`: quando, quem (`plataforma/<master>`), recurso e rota; filtro por período; sem ação de apagar.
- Menu e atalhos escondem módulo desligado (SAAS-19), a partir de `modulos` em `/auth/me`.
- **App novo** `apps/plataforma` (Vite, mesmas bibliotecas, mesmo CSP), projeto Vercel separado.

**App do Master: referência de UX (F5, decisão de 2026-10-22; não implementar antes da F5).** Inspirado no produto
concorrente que o cliente usa:
- Tela inicial **"Licenças"**: um card por condomínio com nome, tipo (residencial/comercial/misto: coluna nova na
  plataforma na F5), número de moradores (contagem agregada vinda de `condominio_metrica`, não do banco do condomínio
  em tempo real), cidade/UF e situação (`ativo`, `suspenso`, ...). Busca por nome ou código; filtro por situação.
- Por condomínio, abas: **Unidades** (estrutura e contagens), **Dados cadastrais** (cadastro da plataforma e
  `condominio_contrato`), **Relatórios** (os do condomínio, pelo ponto único auditado da SAAS-09) e **Módulos**
  (ligar/desligar, SAAS-19, com registro em `plataforma_audit`).
- Toda tela que mostra dado pessoal do condomínio passa pela SAAS-09 (linha na trilha do condomínio) e mostra ao
  Master o aviso "este acesso fica registrado e visível ao síndico".

### 6.3 Deploy e CI

- `docker-compose.prod.yml`: volume de anexos com subpasta por condomínio; memória do Postgres revista; variáveis da
  §6.1. Segredos novos gerados na VPS (padrão do `docs/deploy.md`).
- `deploy-vps.sh`: laço de migração com portão (SAAS-16); o `command=` restrito da chave de deploy precisa conhecer o
  novo script.
- `db/bootstrap/00_roles.sh`: roles `app_plataforma` e `app_provisionador`.
- Backup em laço (SAAS-12); `crontab.exemplo`/timer inalterados.
- CI (`deploy-api.yml`, `testes-web.yml`): jobs dos testes de isolamento e do `test:pg` com dois bancos; e2e com dois
  condomínios.
- `ancora-selo.yml`: formato v2 em arquivo novo.

---

## 7. Impacto em requisitos e LGPD (para `01_requisitos.md` v0.4 — não editado aqui)

**Seção 1 e 2 (contexto e escopo):** o produto passa a atender vários condomínios; o condomínio-piloto é o primeiro
cliente. Fora do escopo da v0.4: usuário em vários condomínios, subdomínio, fuso diferente de Brasília, escrita pelo
suporte.

**Seção 3 (atores):** novos atores "Administrador da plataforma (Master)" e "Suporte da plataforma", ambos do operador.
Desde 2026-10-22 o Master lê dado de condomínio sem aprovação, com registro na trilha do condomínio (SAAS-09).

**Seção 4 (requisitos funcionais), IDs novos:**
- RF-39 Cadastrar condomínio (Master), com plano e status.
- RF-40 Configurar estrutura de blocos e unidades no onboarding (substitui a estrutura fixa citada em RF-01).
- RF-41 ~~Solicitar, aprovar, encerrar e auditar acesso de suporte~~ (2026-10-22) Registrar todo acesso do Master a
  dado do condomínio na trilha do condomínio e mostrá-lo ao síndico ("Acessos da plataforma").
- RF-44 Ligar e desligar módulos por condomínio (SAAS-19).
- RF-42 Exportar todos os dados do condomínio e excluí-los no fim do contrato.
- RF-43 Painel de saúde da plataforma com métricas agregadas sem dado pessoal.

**Seção 5 (regras de negócio):**
- RN-12 (2026-10-22) O Master acessa dado de condomínio sem aprovação caso a caso, só leitura, e todo acesso a dado
  pessoal fica na trilha do condomínio, visível ao síndico (SAAS-09). Substitui "só por acesso de suporte aprovado".
- RN-13 Login e cadastro são por condomínio: o mesmo login ou CPF em dois condomínios são registros independentes, sem
  correlação.

**Seção 6 (não funcionais):**
- RNF-02 alterado: ~~2FA obrigatório para usuários da plataforma desde a primeira versão~~ (2026-10-23, decisão do
  usuário: sem 2FA; senha do Master com 16+ caracteres, limite de tentativas, sessão curta, trilha com IP; SAAS-08).
  Continua opcional para condomínio.
- RNF-13 Isolamento entre condomínios: banco separado; teste de isolamento por rota no CI.
- RNF-14 Exportação completa e exclusão verificável no fim do contrato, em prazo contratual.
- RNF-01 e RNF-10 precisam citar cadeia e backup **por condomínio**.

**Seção 7 (LGPD):**
- Explicitar a relação controlador (condomínio) / operador (empresa do SaaS), com contrato de operação (art. 39) que
  defina instruções, suboperadores, segurança, incidente e devolução/eliminação.
- Lista de suboperadores: hospedagem da VPS, Cloudflare (DNS e hospedagem do SPA estático; a API fica em "DNS only", sem passar o tráfego por ela) e, até 2026-10-31, Vercel (o rewrite passava o tráfego da API, inclusive dado pessoal),
  GitHub (só hashes e raízes, sem dado pessoal), provedor de e-mail se ligado.
- Transferência internacional (art. 33): a Vercel (até 2026-10-31), a Cloudflare e o GitHub estão fora do Brasil; o país do datacenter da VPS precisa
  ser confirmado. Hoje isso já existe para o piloto e não está na seção 7.
- Dados que a empresa do SaaS trata como **controladora**: cadastro comercial do cliente e contato do responsável pelo
  contrato (execução de contrato, art. 7º, V).
- Incidente: o operador comunica o controlador no prazo do contrato; o controlador comunica a ANPD e os titulares
  (art. 48; prazo do regulamento de comunicação de incidente da ANPD a validar juridicamente).
- Fim do contrato: devolução ao controlador e eliminação pelo operador (art. 16), com o prazo de backups declarado.
- Acesso do Master (SAAS-09, 2026-10-22): o Master é o **operador** acessando dado do controlador. O contrato com cada
  condomínio precisa prever o acesso sem aprovação caso a caso, as finalidades, a lista de quem tem papel `master`, o
  registro na trilha do condomínio e a tela do síndico. Sem essa cláusula o acesso não tem instrução do controlador.
- Chave de busca do CPF por condomínio: impede correlacionar a mesma pessoa entre clientes.

**Seção 8 (implantação):** onboarding de condomínio (SAAS-10) antes da etapa de treinamento.

**Seção 11 (riscos):** riscos da seção 9 deste documento.

**Seção 12 (casos de uso):** UC33 Cadastrar (provisionar) condomínio, UC34 Consultar dado de condomínio como Master
(auditado), UC35 Consultar acessos da plataforma (síndico), UC36 Encerrar contrato, UC37 Ligar/desligar módulo.

**Seção 14:** entrada da v0.4 com as decisões SAAS-01 a SAAS-18.

`02_especificacao_tecnica.md` também precisa de revisão (§1 arquitetura, §3.4 tabelas auxiliares, §4.6 selo e
âncora, §5 autenticação, §9.2 chaves, §12 estrutura do projeto e uma §14 com as decisões novas).

---

## 8. Ganchos para o PWA offline (fase seguinte)

Só o que este desenho precisa garantir para não bloquear:

1. **Id gerado no cliente.** `evento_acesso.id` já é uuid com default no banco (`schema.ts:403`, `pk()` com `defaultRandom`); a API passa a aceitar
   id enviado pelo cliente (uuid v4 ou v7). Ele é a chave de idempotência: reenvio com o mesmo id devolve o evento já
   gravado se o conteúdo for igual, e 409 se for diferente. Nenhuma tabela nova de idempotência.
2. **Quem encadeia é o servidor.** O dispositivo nunca calcula `seq` nem `hash`. O evento offline entra na cadeia do
   condomínio na hora em que chega, com `registrado_em` do servidor e `ocorrido_em` do dispositivo. O schema já admite
   `ocorrido_em < registrado_em` (`evento_retroativo_tempo_ck`, `schema.ts:470`).
3. **Formato do hash versionado.** O evento offline precisa de campos novos no hash (dispositivo, relógio do
   dispositivo, "restrição conferida contra cache de"), o que é um formato de hash novo (o 3: o 2 já é o veículo da
   entrada, migração 0013). O banco e o domain já versionam (`jsonCanonico` em `hashChain.ts` despacha por `v` e recusa
   formato desconhecido); v1 e v2 já convivem na mesma cadeia.
4. **Dispositivo pertence a um condomínio.** Tabela `dispositivo` no banco do condomínio, com credencial própria
   revogável. O prefixo de condomínio da sessão (SAAS-03) vale para o dispositivo.
5. **Fila local guarda dado pessoal.** IndexedDB no posto da portaria, cifrado com chave entregue pela sessão e
   descartada no logout. Entra na seção 7 como risco.
6. **Restrição (RF-16) offline usa cópia antiga.** O evento registra a data da cópia; a conferência ao sincronizar
   abre ocorrência se a pessoa estava restrita. Decisão de produto da fase do PWA.

Nada disso exige mudança agora, exceto não criar unicidade ou trigger que impeça id vindo do cliente.

---

## 9. Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | Subárvore de injeção errada (bug no `ContextIdStrategy`) entrega o banco de outro condomínio | Sessão sempre validada no banco escolhido; testes 1–3 da §6.1; o `DB` sem condomínio falha fechado |
| R2 | Estado global em memória sobrevive entre condomínios (cache, mapa estático) | Teste de arquitetura; revisão dos singletons atuais (`LimiteTaxaPublico`, cache de selos, `ESTRUTURA`) na F2 |
| R3 | Deploy interrompido no meio do laço de migração | *Expand/contract*; portão de versão por banco (SAAS-16) |
| R4 | Esgotamento de conexões com muitos condomínios | Pool pequeno com timeout; teto global; revisitar SAAS-01 acima de ~100 |
| R5 | Perda da chave mestra = perda de todos os anexos e da busca por CPF de todos os condomínios | Cópia da chave mestra fora da VPS, em cofre, com procedimento de recuperação testado (pergunta 6) |
| R6 | Vazamento da chave mestra + dump = força bruta de CPF | Mestra fora do backup; acesso restrito; rotação da mestra é barata |
| R7 | Master comprometido: desde 2026-10-22 alcança o dado pessoal de **todos** os condomínios (SAAS-09); **agravado em 2026-10-26 (§5.5): pode criar síndico (ou trocar, ou gerar nova senha) em qualquer condomínio e entrar como ele** | Origem separada, ~~TOTP~~ (sem 2FA desde 2026-10-23: senha 16+, limite de tentativas, sessão curta, trilha com IP, gerenciador de senhas; SAAS-08), poucos usuários `master`, ponto único que grava a trilha de cada condomínio antes de responder, tela do síndico, revisão de acessos. A aprovação do síndico saiu. Na gestão de síndicos: reautenticação no próprio pedido (sessão roubada não basta), motivo obrigatório, trilha do condomínio na mesma transação e visível ao síndico em "Acessos da plataforma"; o síndico substituído perde o acesso na hora e percebe |
| R8 | API comprometida = todos os condomínios | Inerente a um processo (P3). Reduz o alcance: `app_rw` sem DELETE, trilha append-only, âncora fora do servidor |
| R9 | VPS compartilhada com sistema de terceiros, mantida com vários clientes (decisão de 2026-10-22) | Mitigações M1 a M9 (seção 10); gatilhos de saída para VPS dedicada (M9) |
| R10 | Âncora controlada pelo operador não protege o cliente contra o operador | E-mail ao síndico obrigatório; raiz pública em repositório com proteção de branch |
| R11 | Mudança grande perto da entrega acadêmica (decidido fazer agora) | Tag da versão avaliada antes da F2, F0 e testes de caracterização antes de mudar, rollback por fase (seção 10, pergunta 1) |
| R12 | Repositório público com código de produto comercial (decidido manter) | Mitigações P1 a P6 (seção 10, pergunta 2) |
| R13 | Master olha dado sem necessidade (art. 6º, III) ou sem cláusula contratual (art. 39) | Cláusula no contrato de cada condomínio antes da F8; acesso só com chamado; registro visível ao controlador |
| R14 | Senha do `app_provisionador` vazada: com `SET ROLE app_migrator` no banco `postgres`, pode `DROP DATABASE` de condomínio | Mesmo alcance da senha do `app_migrator`, que já está no mesmo `.env`; LOGIN só enquanto houver provisionamento a fazer (`ALTER ROLE ... NOLOGIN` entre um cliente e outro, se o ritmo for baixo); backup diário |
| R15 | Provisionamento interrompido deixa banco e chaves de um condomínio que não existe para a API | Status `provisionando` ignorado por API, migração e backup; retomada idempotente; rollback em `docs/deploy.md` §16.3 |
| R16 | Serviço provisionador ligado e API invadida: o invasor pede condomínios novos (com o token, que a API tem) | Serviço desligado fora do onboarding (perfil); uma operação só (criar), nada de excluir ou mexer em condomínio existente; um pedido por vez; trilha `condominio.provisionar` com o Master como ator |
| R17 | Resposta do POST perdida depois da ativação (timeout da Vercel ou rede): a senha do síndico não chega ao Master | Retomada responde `ja_provisionado` sem senha; nova senha pela CLI `--nova-senha-sindico` (`docs/deploy.md` §18.5) |
| R18 | Saída da CLI `criar-usuario-plataforma` (senha temporária; o segredo TOTP saiu em 2026-10-23) capturada por ferramenta que grava o terminal | Runbook manda rodar em terminal comum, nunca pelo `!` do Claude Code; `logging: none`; reemissão pela CLI revoga sessões |

---

## 10. Perguntas e decisões

### 10.1 Respondidas pelo usuário em 2026-10-22

**1. Antes ou depois do TCC? → Agora, junto do TCC.** A recomendação era "depois". Muda: as fases começam já, com o
piloto em produção e o artefato acadêmico no mesmo repositório. Risco residual (R11): uma fase com defeito atinge o
sistema que será avaliado, perto da entrega. Salvaguardas obrigatórias:
- **Tag da versão avaliada** (ex. `tcc-entrega`) no `main` antes de começar a F2; o texto do TCC e a demonstração
  citam essa tag. A produção pode seguir adiante; a versão avaliada continua reconstruível.
- **F0 antes de qualquer mudança** (linha de base cifrada fora da VPS, restore de teste, testes de caracterização) e
  a verificação da cadeia antiga ao fim de F2, F3 e F4 (seção 5). Feito na v0.2: `scripts/saas/`, CLI `linha-de-base`,
  `test/saas-caracterizacao.test.ts`.
- **Uma fase por vez**, com o rollback da tabela da seção 5 testado antes. Nenhuma fase grande (F2, F5) nas duas
  semanas anteriores à entrega ou à banca.

**2. Repositório e licença → continua público, no mesmo repositório.** A recomendação era decidir (e sugeria avaliar
um privado). Muda: código, desenho de segurança e runbooks do produto ficam públicos. A segurança já não depende de
segredo do código, mas o repositório passa a ser também a vitrine de ataque de todos os clientes. Risco residual
(R12): vazamento de segredo ou endereço num commit, reconhecimento facilitado, cópia por concorrente e, ainda sem
resposta, **propriedade do código e licença** (autor acadêmico × empresa do SaaS), que fica como pergunta 2b.
Mitigações obrigatórias:
- **P1.** Nenhum segredo, endereço interno, IP, nome de host da VPS, nome de cliente, contato de contrato ou nome real de
  pessoa em arquivo versionado (código, doc, teste, seed, migração). Documento usa placeholder (`<vps>`, `<slug>`).
  Os documentos que já citam o endereço da VPS precisam ser revisados antes da F6.
- **P2.** Varredura de segredo em todo push (secret scanning com push protection do GitHub, gratuito em repositório
  público) ligada antes da F2.
- **P3.** Proteção do `main` (checks obrigatórios, sem force-push): push no `main` faz deploy (`docs/deploy.md` §11).
- **P4.** Dado de cliente nunca em fixture, seed ou issue; incidente tratado em canal privado (security advisory
  privado do GitHub), não em issue pública.
- **P5.** Revisão de segurança antes do primeiro cliente real (já em F8), olhando também o histórico do git.
- **P6.** Pergunta 2b (propriedade e licença) respondida antes do primeiro contrato (F8).

**3. Banco por condomínio ou RLS? → Banco por condomínio, até ~30 condomínios em 2 anos.** Coincide com a
recomendação. Confirma SAAS-01 e a premissa P1 (dezenas). O limite de revisão (~100 condomínios) fica longe; o custo
que aparece antes é memória e conexões do Postgres na VPS compartilhada (SAAS-17, M1).

**5. VPS dedicada? → Não: continua na VPS de hoje, compartilhada com o outro sistema, inclusive com vários
clientes.** (A resposta veio como 4ª decisão; ela responde à pergunta 5. A pergunta 4 continua em aberto.) A
recomendação era VPS dedicada antes do segundo cliente real. Muda: SAAS-17 e F8 deixam de exigir VPS dedicada e
passam a exigir as mitigações abaixo. Risco residual (R9): quem compromete o outro sistema ou tem root na VPS alcança
os volumes, o `.env` (com a chave mestra a partir da F2) e o banco de **todos** os condomínios; os dois sistemas
disputam memória, CPU, disco e rede; o operador responde por isso perante cada controlador (art. 46). Mitigações
obrigatórias (condição de F6 e F8; as marcadas "já" existem para o piloto):
- **M1.** Limites por container em todos os serviços da Portaria: `mem_limit` (já), `cpus` e `pids_limit`; Postgres com
  `max_connections`, `shared_buffers` e `mem_limit` dimensionados para os condomínios ativos, conferindo a RAM livre
  com o outro sistema no ar.
- **M2.** Rede docker isolada: projeto com nome próprio (já), banco em rede `internal` sem porta publicada (já), API só
  em `127.0.0.1` (já), nenhuma rede compartilhada com o outro sistema.
- **M3.** `limit_req` e `limit_conn` no nginx **só no `server` da Portaria** (nada global no `http {}`, que afetaria o
  outro sistema), além do limite por condomínio da API (SAAS-14).
- **M4.** Nenhum segredo, endereço interno ou nome de host em documento (mesma regra da P1).
- **M5.** Chave mestra fora do backup e com cópia em cofre (já é a regra da KEK); lista de quem tem root/shell na VPS,
  SSH só por chave, e acesso revisto a cada cliente novo.
- **M6.** Disco: alerta de uso e retenção dos backups por condomínio com prazo fixo (SAAS-12); logs com rotação (já).
- **M7.** Revisão de segurança (`/security-review` e OWASP) e os testes de isolamento da §6.1 no CI antes do
  primeiro cliente real.
- **M8.** Contrato de operador declara a hospedagem compartilhada e quem administra a VPS como suboperador, e o país do
  datacenter (seção 7).
- **M9.** Gatilhos de saída para VPS dedicada, revistos a cada cliente novo: um sistema degradar o outro (OOM, CPU,
  disco), passar de 10 condomínios ativos, ou um contrato exigir.

**Decisões de 2026-10-22 (segunda leva):**
- **"Master vê tudo"** (SAAS-09 reescrita): o Master vê os dados dos condomínios sem aprovação do síndico. Mitigação
  adotada, informada ao usuário, sem objeção: registro de todo acesso a dado pessoal na trilha do condomínio, com ator
  `plataforma/<master>`, e tela "Acessos da plataforma" para o síndico. Riscos R7 e R13; cláusula contratual
  obrigatória (seção 7).
- **Módulos por condomínio** (SAAS-19): coluna na plataforma desde já, todos ligados por padrão; tela e bloqueio na F5.
- **UX do app do Master** (§6.2): lista "Licenças" em cards, busca, filtro por situação, abas por condomínio.

### 10.2 Em aberto

2b. **Propriedade do código e licença** (sobra da pergunta 2): quem é dono do código e sob qual licença, antes do
    primeiro contrato.
4. ~~**Acesso de suporte sem síndico disponível**~~ — sem objeto desde 2026-10-22: o Master acessa sem aprovação,
   com registro (SAAS-09).
6. **Guarda da chave mestra:** onde fica a cópia fora da VPS (gerenciador de senhas da empresa, cofre de nuvem, papel
   em envelope lacrado) e quem tem acesso? (A F1 já cria a chave: até a resposta, vale o cofre do responsável, como a
   KEK.)
7. **Âncora por e-mail obrigatória** a partir do segundo condomínio (exige SMTP em produção, que hoje não há)?
8. **Entrega da senha temporária do síndico** no onboarding: por e-mail, por mensagem ou presencial?
9. **Prazos contratuais:** dias entre `encerrado` e `excluido` (sugestão 30) e retenção dos backups (sugestão 35).
10. **Domínio próprio:** existe plano de registrar? Mudaria SAAS-05 para subdomínio e tiraria a dependência do
    `sslip.io`.
11. **Planos e cotas:** quais limites por plano (unidades, usuários, armazenamento)? Cobrança fica fora do sistema?
12. **Fuso:** algum cliente previsto fora do horário de Brasília?

---

## 11. Estimativa por fase

| Fase | Tamanho | Observação |
|---|---|---|
| F0 Linha de base | P | Sem mudança de comportamento |
| F1 Banco de plataforma e chaves | M | Envelope de chaves com testes |
| F2 API multi-banco | **G** | Maior risco: resolvedor, sessão, login, jobs, backup, testes de isolamento |
| F3 Migração `0007` | P | Só *expand* |
| F4 Âncora agregada | M | Merkle, prova de inclusão, workflow |
| F5 Plataforma (API + front + onboarding + suporte; TOTP removido em 2026-10-23) | **G** | App novo |
| F6 Condomínio de teste em produção | P | Smoke de isolamento |
| F7 Fim de contrato | M | Exportação completa e exclusão |
| Revisão de requisitos/spec (v0.4) | M | Documento, sem código |

---

## Apêndice A — Se a decisão for banco único com RLS

Para o caso de a pergunta 3 ser respondida com RLS. O que **muda** em relação ao corpo do documento:

**A.1 Colunas, unicidades e FKs.**
- `condominio_id uuid NOT NULL` em todas as tabelas de condomínio. Backfill sem `UPDATE` (as trilhas bloqueiam
  `UPDATE` por trigger, `0001:202`): `ALTER TABLE x ADD COLUMN condominio_id uuid NOT NULL DEFAULT '<id do piloto>'`
  (no Postgres 11+ não reescreve a tabela nem dispara trigger) e, em seguida,
  `ALTER COLUMN condominio_id SET DEFAULT app_condominio()`.
- Todas as unicidades da seção 1 ganham `condominio_id` na frente (`unidade`, `usuario_login_uq`,
  `pessoa_documento_busca_uq`, `veiculo_placa_ativa_uq`, `evento_seq_uq`, `selo_cadeia_diario_uq`, ...).
- `evento_acesso_cadeia`: PK passa a `condominio_id`, sai o `CHECK id = 1`; o trigger trava a linha do condomínio.
- Numeração de encomenda e ocorrência por condomínio: identity global vira contador por condomínio (tabela
  `contador` com `UPDATE ... RETURNING`), senão o número revela o volume dos outros clientes.
- **FKs compostas**: `UNIQUE (condominio_id, id)` em cada tabela referenciada e
  `FOREIGN KEY (condominio_id, pessoa_id) REFERENCES pessoa (condominio_id, id)` em cada FK (~50), criadas com
  `NOT VALID` e depois `VALIDATE CONSTRAINT`. Sem isso, a checagem de FK, que ignora RLS, deixa um evento de A
  apontar para a pessoa de B.

**A.2 Contexto e políticas.**
```sql
CREATE FUNCTION app_condominio() RETURNS uuid LANGUAGE sql STABLE AS $$
  -- Depois de um SET LOCAL, a variável volta como '' (não NULL) nas transações seguintes da mesma conexão.
  SELECT nullif(current_setting('app.condominio_id', true), '')::uuid
$$;

ALTER TABLE pessoa ENABLE ROW LEVEL SECURITY;
CREATE POLICY pessoa_condominio ON pessoa TO app_rw
  USING (condominio_id = app_condominio())
  WITH CHECK (condominio_id = app_condominio());
-- Idem para cada tabela. Sem contexto: app_condominio() é NULL, a comparação é NULL, nenhuma linha passa
-- e o INSERT falha no NOT NULL do default. Falha fechada.
```
- A API abre **uma transação por requisição** e faz `SELECT set_config('app.condominio_id', $1, true)` como primeiro
  comando. As 103 consultas que hoje rodam fora de transação (`this.db.select...`) passam a rodar dentro dela; sem
  isso, `SET` de sessão vazaria entre requisições pela conexão reaproveitada do pool.
- `app_rw` continua `NOBYPASSRLS` (padrão do `CREATE ROLE` em `00_roles.sh`). Não usar `FORCE ROW LEVEL SECURITY`
  com a dona `app_migrator`, que precisa enxergar tudo nas migrações.
- Limite a declarar: qualquer SQL executado como `app_rw` pode chamar `set_config` com outro condomínio. RLS por GUC
  protege de bug de consulta, não de injeção de SQL.

**A.3 Funções `SECURITY DEFINER` e triggers.** A dona ignora RLS. Cada uma das 8 funções e o trigger da cadeia
precisam:
- ler o condomínio de `app_condominio()` e falhar se for NULL;
- filtrar **toda** consulta interna por ele (ex.: em `evento_acesso_antes_inserir`, a busca do evento referido,
  `0001:104`, e a da pessoa sem CPF, `0001:165`; em `retencao_descartar_audit`, o `DELETE` de `0004:75`, que hoje
  apaga a trilha vencida inteira);
- conferir `NEW.condominio_id = app_condominio()` nos triggers (a política `WITH CHECK` é aplicada depois dos
  triggers `BEFORE`, mas as consultas do trigger rodam antes, como dona).
- Teste no CI que lista `pg_proc` com `prosecdef` e falha se o corpo não chamar `app_condominio()`.
- `unidade_descartar_estrutura` (`0005:44`) faz `LOCK TABLE unidade` e `DELETE FROM unidade` sem filtro: no modelo
  compartilhado, travaria e apagaria a estrutura de todos. Precisa ser reescrita por condomínio.

**A.4 Migração da produção.** A cadeia do piloto continua válida porque `condominio_id` não entra na serialização
canônica v1 (`0001:55-84`), mas a migração toca a tabela append-only, a cabeça da cadeia e todas as funções numa
janela de manutenção, com rollback por restore. Tamanho: **G** só para o schema, antes da API.

**A.5 O que o RLS não dá** e precisaria de solução própria: restore de um condomínio (não há como repor linhas de uma
tabela append-only sem afetar os outros), exclusão no fim do contrato (função nova que fura o append-only por
condomínio) e backup por condomínio (`pg_dump` com filtro não existe; seria exportação lógica).
