# Contexto de build = raiz do repositório (docker-compose.yml). Estágios:
#   deps     todas as dependências da API (dev incluídas)
#   build    tsc -> dist (CommonJS); o domínio (regras, RBAC, hash) mora em src/dominio e compila junto
#   migrate  drizzle-kit + migrações dos dois tipos de banco + o laço scripts/migrar-bancos.mjs (serviço "migrate")
#   dev      build + tsc-watch: recompila e reinicia a API a cada mudança em src/ (docker compose watch)
#   prod     só dependencies de produção
#   runtime  imagem final da API, usuário não-root
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src src
# Migrações do condomínio: a CLI provisionar-condominio migra o banco novo (dist/cli -> ../../drizzle).
COPY drizzle drizzle
RUN npm run build

# Desenvolvimento com reload: parte do `build` (dependências de dev, dist/package.json CommonJS já
# gravado) e deixa o tsc-watch recompilando src/ -> dist/ e reiniciando o node a cada sucesso. Os arquivos chegam
# pelo `develop.watch` do compose (sync), não por bind mount: no macOS o bind mount perde eventos de arquivo e
# misturaria o node_modules do host (darwin) com o do container (musl, binário do argon2).
FROM build AS dev
WORKDIR /app
ENV TZ=UTC
EXPOSE 3000
CMD ["npx", "tsc-watch", "-p", "tsconfig.build.json", "--noClear", "--onSuccess", "node dist/main.js"]

FROM deps AS migrate
WORKDIR /app
COPY drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src/db/schema.ts ./src/db/schema.ts
# Banco plataforma do SaaS: config, migrações e schema próprios.
COPY drizzle-plataforma.config.ts ./
COPY drizzle-plataforma ./drizzle-plataforma
COPY src/saas/schema-plataforma.ts ./src/saas/schema-plataforma.ts
# SaaS (F2, SAAS-16): plataforma e depois cada banco de condomínio, em série (MIGRATOR_URL_BASE sem nome de banco).
COPY scripts/migrar-bancos.mjs ./scripts/migrar-bancos.mjs
USER node
CMD ["node", "scripts/migrar-bancos.mjs"]

FROM node:22-alpine AS prod
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --from=prod --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Migrações do banco de condomínio (só SQL e meta/), lidas pela CLI provisionar-condominio. A API não as aplica: o
# serviço `migrate` continua sendo quem migra no deploy.
COPY --chown=node:node drizzle ./drizzle
# Pasta dos anexos cifrados (volume `documentos` do compose): criada aqui com dono node, para o volume novo herdar.
# Idem para o arquivo append-only da âncora do selo (volume `ancoras`).
RUN mkdir -p /var/lib/portaria/documentos /var/lib/portaria/ancoras \
  && chown node:node /var/lib/portaria/documentos /var/lib/portaria/ancoras \
  && chmod 700 /var/lib/portaria/documentos && chmod 750 /var/lib/portaria/ancoras
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
