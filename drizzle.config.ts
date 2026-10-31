// drizzle-kit: gera as migrações SQL a partir de src/db/schema.ts. Não precisa de banco para `generate`.
// O que o Drizzle não expressa vai em migração "custom" (npm run db:custom -- --name=<nome>), editada à mão.
// `migrate` usa DATABASE_URL_MIGRATOR (role app_migrator, dono do schema). Nunca rode migração como app_rw.
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL_MIGRATOR;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  ...(url ? { dbCredentials: { url } } : {}),
});
