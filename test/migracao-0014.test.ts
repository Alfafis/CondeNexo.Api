// Migração 0014 ("Manter conectado") sobre um banco de condomínio como o de produção: 0000..0013 aplicadas como
// app_migrator e uma sessão já aberta. A 0014 tem de aplicar como app_migrator, deixar a sessão existente com o prazo
// padrão (manter_conectado = false) e a coluna nova tem de servir ao app_rw (INSERT/SELECT), sem UPDATE dela.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comoAppRw, erroDe, PASTA_MIGRACOES, SENHA_FALSA } from './helpers/banco';

let client: PGlite;
let ate0013 = '';
let usuarioId = '';

beforeAll(async () => {
  ate0013 = mkdtempSync(join(tmpdir(), 'condominio-0013-'));
  cpSync(PASTA_MIGRACOES, ate0013, { recursive: true });
  const journal = JSON.parse(readFileSync(join(ate0013, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= '0013');
  expect(journal.entries.map((e) => e.tag).at(-1)).toBe('0013_veiculo_evento');
  writeFileSync(join(ate0013, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(ate0013, '0014_sessao_manter_conectado.sql'));

  client = new PGlite();
  await client.exec(`CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;
    ALTER DATABASE postgres OWNER TO app_migrator; ALTER SCHEMA public OWNER TO app_migrator;`);
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: ate0013 });
  await client.exec('RESET ROLE');

  usuarioId = (await client.query<{ id: string }>(
    `INSERT INTO usuario_sistema (nome, login, papel, senha_hash) VALUES ('Rita', 'rita', 'sindico', $1) RETURNING id`, [SENHA_FALSA])).rows[0]!.id;
  await comoAppRw(client, () => client.query(
    `INSERT INTO sessao (token_hash, usuario_id, expira_em) VALUES ($1, $2, now() + interval '12 hours')`, ['a'.repeat(64), usuarioId]));
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (ate0013) rmSync(ate0013, { recursive: true, force: true });
});

describe('0014_sessao_manter_conectado sobre o banco de produção', () => {
  it('aplica como app_migrator; a sessão já aberta fica com o prazo padrão', async () => {
    await client.exec('SET ROLE app_migrator');
    try {
      await migrate(drizzle(client), { migrationsFolder: PASTA_MIGRACOES });
    } finally {
      await client.exec('RESET ROLE');
    }
    const r = await client.query<{ manter_conectado: boolean }>(`SELECT manter_conectado FROM sessao WHERE token_hash = $1`, ['a'.repeat(64)]);
    expect(r.rows).toEqual([{ manter_conectado: false }]);
  });

  it('app_rw grava e lê a coluna (GRANT da tabela), mas não a altera depois', async () => {
    await comoAppRw(client, async () => {
      await client.query(`INSERT INTO sessao (token_hash, usuario_id, expira_em, manter_conectado) VALUES ($1, $2, now() + interval '15 days', true)`,
        ['b'.repeat(64), usuarioId]);
      const r = await client.query<{ manter_conectado: boolean }>(`SELECT manter_conectado FROM sessao WHERE token_hash = $1`, ['b'.repeat(64)]);
      expect(r.rows).toEqual([{ manter_conectado: true }]);
    });
    // PGlite roda como superusuário (o SET ROLE vale): o UPDATE da coluna não foi concedido
    const erro = await comoAppRw(client, () => erroDe(client.query(`UPDATE sessao SET manter_conectado = true WHERE token_hash = $1`, ['a'.repeat(64)])));
    expect(erro).toMatch(/permission denied/);
  });
});
