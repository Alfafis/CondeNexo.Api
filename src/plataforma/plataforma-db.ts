// Conexão da API com o banco `plataforma` (docs/05_arquitetura_saas.md SAAS-02/03, fase F2), como `app_plataforma`,
// e a chave mestra que desembrulha as chaves dos condomínios (SAAS-04).
//
// `PLATAFORMA_DB` NÃO é exportado para o resto da API: só o DatabaseModule o declara, e só o ResolvedorCondominio o
// injeta (teste de arquitetura em test/saas-isolamento.test.ts). Assim nenhum serviço de condomínio lê a plataforma, e
// o pool `app_plataforma` não alcança banco de condomínio (não tem CONNECT lá; provado no test:pg).
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { carregarChaveMestra, ErroChave } from './chave-mestra';
import * as sp from './schema-plataforma';

export const PLATAFORMA_DB = Symbol('PLATAFORMA_DB');
export const PLATAFORMA_POOL = Symbol('PLATAFORMA_POOL');
export const CHAVE_MESTRA = Symbol('CHAVE_MESTRA');

export type DbPlataforma = PgDatabase<PgQueryResultHKT, typeof sp>;

/** `DATABASE_URL_PLATAFORMA` validada: banco `plataforma`, com senha. A mensagem cita o nome, nunca o valor. */
export function urlPlataforma(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL_PLATAFORMA?.trim();
  if (!url) throw new ErroChave('DATABASE_URL_PLATAFORMA não definida');
  let u: URL;
  try { u = new URL(url); } catch { throw new ErroChave('DATABASE_URL_PLATAFORMA inválida'); }
  if (u.pathname !== '/plataforma') throw new ErroChave('DATABASE_URL_PLATAFORMA precisa apontar para o banco plataforma');
  if (!u.password) throw new ErroChave('DATABASE_URL_PLATAFORMA sem senha (APP_PLATAFORMA_PASSWORD vazia no .env?)');
  return url;
}

/** Pool pequeno: a plataforma é lida no boot, a cada renovação do cache de condomínios e pelo /saude. */
export function poolPlataforma(env: NodeJS.ProcessEnv): Pool {
  return new Pool({ connectionString: urlPlataforma(env), max: 3, keepAlive: true, connectionTimeoutMillis: 5000 });
}

export const dbPlataforma = (pool: Pool): DbPlataforma => drizzle(pool, { schema: sp }) as unknown as DbPlataforma;

export const chaveMestraDoAmbiente = () => carregarChaveMestra(process.env);
