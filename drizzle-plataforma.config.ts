// drizzle-kit do banco `plataforma` (SaaS, docs/05_arquitetura_saas.md SAAS-02 e SAAS-16): schema e pasta de migrações
// PRÓPRIOS, separados dos bancos de condomínio (drizzle.config.ts / drizzle/). Mesmo papel: só app_migrator migra.
//   npx drizzle-kit generate --config drizzle-plataforma.config.ts            (gera a partir de src/saas/schema-plataforma.ts)
//   DATABASE_URL_MIGRATOR=postgres://app_migrator:...@.../plataforma npx drizzle-kit migrate --config drizzle-plataforma.config.ts
// A URL é a mesma variável do drizzle.config.ts, apontando para o banco `plataforma` (no compose, o serviço
// `migrate-plataforma` monta essa URL). Nunca rode com a URL do banco `portaria`: a migração criaria as tabelas lá.
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL_MIGRATOR;
if (url && !/\/plataforma(\?|$)/.test(url)) throw new Error('drizzle-plataforma.config.ts: DATABASE_URL_MIGRATOR não aponta para o banco plataforma');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/saas/schema-plataforma.ts',
  out: './drizzle-plataforma',
  strict: true,
  verbose: true,
  ...(url ? { dbCredentials: { url } } : {}),
});
