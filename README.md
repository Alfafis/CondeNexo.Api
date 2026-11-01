# CondeNexo.Api

API do **CondeNexo**, SaaS de controle de acesso para condomínios: portaria, pessoas e vínculos, encomendas, ocorrências,
trilha de auditoria à prova de adulteração e conformidade com a LGPD. Cada condomínio tem o seu banco; uma plataforma
central (o "Master") provisiona e administra os condomínios clientes.

A API é a **dona de todas as regras de negócio**. O [CondeNexo.Front](https://github.com/Alfafis/CondeNexo.Front) não
decide nada: consome o contrato OpenAPI daqui (`docs/api/openapi.json`) e gera os tipos a partir dele.

## O que o produto faz

| Área | O que entrega |
|---|---|
| Portaria | Entrada, recusa, saída e correção de acessos; autorizações prévias, restrições e passagem de turno |
| Cadastro | Unidades, pessoas, vínculos (moradores, locatários, prestadores), funcionários, veículos, importação por planilha |
| Encomendas e ocorrências | Recebimento, fila, retirada com regra de quem pode retirar; ocorrências com anexos cifrados |
| Auditoria | Trilha append-only com hash chain, selo diário ancorado fora do servidor, verificação de integridade e exportação |
| LGPD | Exportação, anonimização e retenção por prazo; texto livre mascarado na trilha |
| Acesso | Papéis do condomínio (síndico, administração, porteiro, auditor) e módulos contratados por condomínio |
| Plataforma (Master) | Cadastro e provisionamento de condomínios, licenças, síndicos, painel de controle e trilha própria. Ler dados de um condomínio exige **motivo** registrado e vale 30 minutos |

## Como funciona

- **NestJS 11 + Drizzle ORM + PostgreSQL 17.** Um banco por condomínio (`portaria_*`) mais o banco `plataforma`, com roles
  separados (`app_rw` nunca migra; `app_plataforma` não enxerga os bancos dos condomínios).
- **Autorização em duas camadas.** Cada rota declara uma política (`@Publico`, `@Autenticado`, `@Acao`), senão é negada. As
  matrizes de papéis vivem em `src/dominio/` e o Front só recebe a lista de permissões da sessão.
- **Contrato gerado do código.** Entrada (Zod) e saída (tipo de retorno de cada handler) vão para o OpenAPI; os testes
  falham se o arquivo ficar desatualizado.
- **Segurança por padrão.** Senhas argon2id, sessão em cookie HttpOnly/SameSite=Strict, verificação de `Origin` nas
  escritas, limite de login, chaves derivadas por HKDF, anexos cifrados com AES-256-GCM e trilha que falha fechada.

Mapa de pastas:

```
src/dominio/     regras puras (RBAC, vínculo válido, hash chain, exportação, unidades), sem framework
src/plataforma/  Master: condomínios, licenças, síndicos, painel, motivo de leitura, provisionador
src/tenancy/     resolução do condomínio da requisição e guarda de módulo contratado
src/auth/        login, sessão, troca de senha, guards
src/<módulo>/    eventos, pessoas, vinculos, encomendas, ocorrencias, unidades, usuarios, relatorios, lgpd...
src/auditoria/   registro na trilha, integridade, exportação
src/cli/         provisionamento, rotação de chaves, jobs (selo, retenção, âncoras), seeds
drizzle/         migrações dos bancos de condomínio     drizzle-plataforma/   migrações do banco plataforma
test/            Vitest sobre PGlite (Postgres em WASM) com as migrações reais
```

## Começo rápido

Requer Node 22 (`.nvmrc`).

```bash
npm ci
npm run typecheck
npm test                  # suíte inteira sobre PGlite, sem Docker
npm run build             # tsc -> dist/
npm run e2e:servidor      # API de teste em memória (porta 3101) para o Front e o Playwright
docker compose up --build --watch   # ambiente completo com Postgres (cp .env.example .env antes)
```

Depois de mudar rota, schema Zod ou tipo de resposta, regenere o contrato e as coleções:

```bash
npm run openapi && npm run colecoes
```

O Front copia esse contrato com `npm run gerar:contrato`. Detalhes, variáveis de ambiente, padrões de auditoria e
decisões de build: [`docs/desenvolvimento.md`](docs/desenvolvimento.md).

## Publicação

O deploy é feito na VPS por `scripts/deploy/deploy-vps.sh` (backup, build, migração, `/saude` e rollback da imagem),
a partir da `origin/main` deste repositório. Publique a **API antes do Front**. O workflow `deploy-api.yml` só dispara o
deploy quando `DEPLOY_HOST` está configurado; hoje o deploy é manual. Passo a passo e runbooks:
[`docs/deploy.md`](docs/deploy.md), [`docs/deploy-subdominio-api.md`](docs/deploy-subdominio-api.md) e
[`docs/deploy-rotacao-chaves.md`](docs/deploy-rotacao-chaves.md).

## Documentação

- [`docs/05_arquitetura_saas.md`](docs/05_arquitetura_saas.md): multi-tenant, provisionamento, isolamento e LGPD
- [`docs/02_especificacao_tecnica.md`](docs/02_especificacao_tecnica.md): regras, modelo de dados e trilha
- [`docs/api/`](docs/api/README.md): OpenAPI, Swagger local e coleções Bruno/Postman
- [`db/README.md`](db/README.md): roles, bootstrap e backup do banco

## CI

`testes-api.yml` (typecheck, testes, scripts, build), `testes-postgres.yml` (Postgres 17 real), `ancora-selo.yml` (âncora
pública do selo) e `deploy-api.yml`.

## Licença

Proprietária (ver `LICENSE`).
