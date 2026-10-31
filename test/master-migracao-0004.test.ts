// Migração 0004 (login do Master sem TOTP, 2026-10-23) sobre um banco `plataforma` como o de produção: 0000..0003 já
// aplicadas COMO app_migrator (dono das tabelas, como no laço scripts/migrar-bancos.mjs) e um Master criado pela CLI
// antiga, com segredo TOTP cifrado e uma sessão aberta. A 0004 tem de aplicar como app_migrator, apagar só o que era do
// TOTP e deixar o Master entrar com a MESMA senha.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sp from '../src/saas/schema-plataforma';
import { masterSessao, masterUsuario } from '../src/saas/schema-plataforma';
import { comoAppPlataforma, PASTA_MIGRACOES_PLATAFORMA } from './helpers/plataforma';

const ID = '0a0a0000-0000-4000-8000-000000000001';
const SENHA = 'senha-atual-do-master-em-producao';
let client: PGlite;
let ate0003 = '';

beforeAll(async () => {
  // Pasta com as migrações até a 0003 (o estado de produção antes deste deploy).
  ate0003 = mkdtempSync(join(tmpdir(), 'plataforma-0003-'));
  cpSync(PASTA_MIGRACOES_PLATAFORMA, ate0003, { recursive: true });
  const journal = JSON.parse(readFileSync(join(ate0003, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= '0003');
  expect(journal.entries.map((e) => e.tag).at(-1)).toBe('0003_master_auth');
  writeFileSync(join(ate0003, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(ate0003, '0004_master_sem_totp.sql'));

  client = new PGlite();
  // Como db/bootstrap/10_plataforma.sh: app_migrator é dono do banco (e por isso das tabelas que cria).
  await client.exec(`CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_plataforma NOLOGIN;
    ALTER DATABASE postgres OWNER TO app_migrator; ALTER SCHEMA public OWNER TO app_migrator;`);
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: ate0003 });
  await client.exec('RESET ROLE');
  // O Master que a CLI antiga criou (segredo e versão da mestra como ela gravaria) e uma sessão aberta com o 2º fator.
  const senhaHash = await hash(SENHA, { memoryCost: 1024, timeCost: 1, parallelism: 1 });
  await comoAppPlataforma(client, async () => {
    await client.query(`INSERT INTO master_usuario (id, nome, email, senha_hash, totp_cifrado, totp_mestra_versao, totp_ultimo_passo,
      papel, deve_trocar_senha) VALUES ($1, 'Master Real', 'master@exemplo.test', $2, $3, 1, 12345, 'master', false)`, [ID, senhaHash, new Uint8Array(48)]);
    await client.query(`INSERT INTO master_sessao (token_hash, master_usuario_id, expira_em, totp_confirmado_em)
      VALUES ($1, $2, now() + interval '1 hour', now())`, ['b'.repeat(64), ID]);
  });
}, 60_000);

afterAll(async () => {
  await client?.close();
  rmSync(ate0003, { recursive: true, force: true });
});

describe('0004_master_sem_totp sobre o banco de produção', () => {
  it('aplica como app_migrator (só a 0004) e apaga só o que era do TOTP', async () => {
    const antes = (await client.query<Record<string, unknown>>('SELECT id, nome, email, senha_hash, papel, ativo, deve_trocar_senha FROM master_usuario')).rows;
    await client.exec('SET ROLE app_migrator');
    try {
      await migrate(drizzle(client), { migrationsFolder: PASTA_MIGRACOES_PLATAFORMA });
    } finally {
      await client.exec('RESET ROLE');
    }
    const aplicadas = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    expect(aplicadas.rows[0]!.n).toBe(5);
    // A conferência do runbook (docs/deploy.md §18.7): vazia.
    const totp = await client.query(`select column_name from information_schema.columns where table_name='master_usuario' and column_name like 'totp%'`);
    expect(totp.rows).toEqual([]);
    const sessao = await client.query(`select column_name from information_schema.columns where table_name='master_sessao' and column_name like 'totp%'`);
    expect(sessao.rows).toEqual([]);
    expect((await client.query<{ t: string | null }>(`select to_regclass('master_codigo_recuperacao')::text AS t`)).rows[0]!.t).toBeNull();
    const ck = await client.query(`select conname from pg_constraint where conname like 'master_usuario_totp%'`);
    expect(ck.rows).toEqual([]);
    // O Master continua igual, com a mesma senha.
    expect((await client.query('SELECT id, nome, email, senha_hash, papel, ativo, deve_trocar_senha FROM master_usuario')).rows).toEqual(antes);
  });

  it('com o schema novo, app_plataforma lê o Master e a sessão, a senha de antes confere e a sessão aberta continua lá', async () => {
    const db = drizzle(client, { schema: sp });
    const [u] = await comoAppPlataforma(client, () => db.select().from(masterUsuario).where(eq(masterUsuario.id, ID)));
    expect(await verify(u!.senhaHash, SENHA)).toBe(true);
    const [s] = await comoAppPlataforma(client, () => db.select().from(masterSessao).where(eq(masterSessao.masterUsuarioId, ID)));
    expect(s!.revogadaEm).toBeNull();
    // Os GRANTs da 0000 continuam valendo para o que ficou (UPDATE em master_usuario; sem DELETE).
    await comoAppPlataforma(client, () => db.update(masterUsuario).set({ ultimoAcesso: new Date() }).where(eq(masterUsuario.id, ID)));
    await expect(comoAppPlataforma(client, () => db.delete(masterUsuario).where(eq(masterUsuario.id, ID)))).rejects.toThrow();
  });
});
