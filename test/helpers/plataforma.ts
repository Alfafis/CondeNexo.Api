// Banco `plataforma` de teste: PGlite PRÓPRIO (outro banco, como em produção) com as migrações reais de drizzle-plataforma/.
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as sp from '../../src/saas/schema-plataforma';

export const PASTA_MIGRACOES_PLATAFORMA = fileURLToPath(new URL('../../drizzle-plataforma', import.meta.url));

export async function novoBancoPlataforma() {
  const client = new PGlite();
  // Bootstrap (em produção: db/bootstrap/10_plataforma.sh). No PGlite os roles não fazem login; SET ROLE aplica os GRANTs.
  await client.exec('CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_plataforma NOLOGIN;');
  const db = drizzle(client, { schema: sp });
  await migrate(db, { migrationsFolder: PASTA_MIGRACOES_PLATAFORMA });
  return { client, db };
}

/** Executa `fn` como app_plataforma (SET ROLE) e volta ao superusuário, mesmo em erro. */
export async function comoAppPlataforma<T>(client: PGlite, fn: () => Promise<T>): Promise<T> {
  await client.exec('SET ROLE app_plataforma');
  try { return await fn(); } finally { await client.exec('RESET ROLE'); }
}
