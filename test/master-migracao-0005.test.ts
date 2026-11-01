// Migração 0005 (2º fator de volta, OPCIONAL; sub-projeto C2, fase A1) sobre um banco `plataforma` como o de produção:
// 0000..0004 aplicadas COMO app_migrator (dono das tabelas, como no laço scripts/migrar-bancos.mjs), um Master criado
// depois da 0004 (sem TOTP) e uma sessão aberta. A 0005 tem de aplicar como app_migrator, ser só *expand*, deixar o
// Master SEM 2º fator entrando com a MESMA senha, manter a sessão, e dar a app_plataforma exatamente os GRANTs do spec
// nas tabelas novas (SELECT/INSERT, UPDATE só em `usado_em` dos códigos; nada de DELETE).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sp from '../src/plataforma/schema-plataforma';
import { masterCodigoRecuperacao, masterLoginPendente, masterSessao, masterUsuario } from '../src/plataforma/schema-plataforma';
import { comoAppPlataforma, PASTA_MIGRACOES_PLATAFORMA } from './helpers/plataforma';

const ID = '0a0a0000-0000-4000-8000-000000000005';
const SENHA = 'senha-atual-do-master-em-producao';
const TOKEN_HASH = 'c'.repeat(64);
let client: PGlite;
let ate0004 = '';

const erroDe = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return `${(e as Error).message} ${(e as { cause?: Error }).cause?.message ?? ''}`; }
  throw new Error('era esperado um erro');
};

beforeAll(async () => {
  ate0004 = mkdtempSync(join(tmpdir(), 'plataforma-0004-'));
  cpSync(PASTA_MIGRACOES_PLATAFORMA, ate0004, { recursive: true });
  const journal = JSON.parse(readFileSync(join(ate0004, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= '0004');
  expect(journal.entries.map((e) => e.tag).at(-1)).toBe('0004_master_sem_totp');
  writeFileSync(join(ate0004, 'meta/_journal.json'), JSON.stringify(journal));

  client = new PGlite();
  await client.exec(`CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_plataforma NOLOGIN;
    ALTER DATABASE postgres OWNER TO app_migrator; ALTER SCHEMA public OWNER TO app_migrator;`);
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: ate0004 });
  await client.exec('RESET ROLE');
  // O Master de hoje (criado pela CLI depois da 0004) e uma sessão aberta, gravados como app_plataforma e em SQL cru
  // (o schema do código já tem as colunas novas).
  const senhaHash = await hash(SENHA, { memoryCost: 1024, timeCost: 1, parallelism: 1 });
  await comoAppPlataforma(client, async () => {
    await client.query(`INSERT INTO master_usuario (id, nome, email, senha_hash, papel, deve_trocar_senha) VALUES ($1, 'Master Real', 'master@exemplo.test', $2, 'master', false)`, [ID, senhaHash]);
    await client.query(`INSERT INTO master_sessao (token_hash, master_usuario_id, expira_em) VALUES ($1, $2, now() + interval '1 hour')`, [TOKEN_HASH, ID]);
    // Uma sessão revogada com motivo antigo: o CHECK novo (superconjunto) a aceita.
    await client.query(`INSERT INTO master_sessao (token_hash, master_usuario_id, expira_em, revogada_em, motivo_revogacao) VALUES ($1, $2, now() + interval '1 hour', now(), 'logout')`, ['d'.repeat(64), ID]);
    await client.query(`INSERT INTO plataforma_login_limite (tipo, chave, falhas, janela_inicio) VALUES ('master_ip', $1, 2, now())`, ['e'.repeat(64)]);
  });
}, 60_000);

afterAll(async () => {
  await client?.close();
  rmSync(ate0004, { recursive: true, force: true });
});

describe('0005_master_segundo_fator sobre o banco de produção', () => {
  it('aplica como app_migrator (só a 0005), só expand: nenhum dado existente muda; o Master fica sem 2º fator', async () => {
    const tabelas = ['master_usuario', 'master_sessao', 'plataforma_login_limite'];
    const antes = await Promise.all(tabelas.map(async (t) => (await client.query(`SELECT * FROM ${t} ORDER BY 1, 2`)).rows));
    await client.exec('SET ROLE app_migrator');
    try {
      await migrate(drizzle(client), { migrationsFolder: PASTA_MIGRACOES_PLATAFORMA });
    } finally {
      await client.exec('RESET ROLE');
    }
    expect((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0]!.n).toBe(6);
    // As colunas antigas, com os mesmos valores (as novas entram nulas ou com o default).
    for (const [i, t] of tabelas.entries()) {
      const depois = (await client.query<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY 1, 2`)).rows;
      expect(depois.map((l) => Object.fromEntries(Object.keys(antes[i]![0] as object).map((k) => [k, l[k]])))).toEqual(antes[i]);
    }
    const [u] = (await client.query<Record<string, unknown>>('SELECT * FROM master_usuario WHERE id = $1', [ID])).rows;
    expect(u).toMatchObject({
      totp_cifrado: null, totp_mestra_versao: null, totp_ativado_em: null, totp_ultimo_passo: null,
      totp_pendente_cifrado: null, totp_pendente_mestra_versao: null, totp_pendente_expira_em: null, segundo_fator_falhas: 0, recuperacao_geracao: 0,
    });
    // Donos: app_migrator (como todas as outras).
    const donos = (await client.query<{ t: string; o: string }>(`SELECT tablename AS t, tableowner AS o FROM pg_tables
      WHERE tablename IN ('master_codigo_recuperacao', 'master_login_pendente') ORDER BY 1`)).rows;
    expect(donos).toEqual([{ t: 'master_codigo_recuperacao', o: 'app_migrator' }, { t: 'master_login_pendente', o: 'app_migrator' }]);
  });

  it('com o schema novo, app_plataforma lê o Master, a senha de antes confere e a sessão aberta continua válida', async () => {
    const db = drizzle(client, { schema: sp });
    const [u] = await comoAppPlataforma(client, () => db.select().from(masterUsuario).where(eq(masterUsuario.id, ID)));
    expect(await verify(u!.senhaHash, SENHA)).toBe(true);
    expect(u!.totpAtivadoEm).toBeNull();
    const [s] = await comoAppPlataforma(client, () => db.select().from(masterSessao).where(eq(masterSessao.tokenHash, TOKEN_HASH)));
    expect([s!.revogadaEm, s!.motivoRevogacao]).toEqual([null, null]);
    // Os motivos e tipos novos passam; um inventado continua recusado.
    await comoAppPlataforma(client, () => db.update(masterSessao).set({ revogadaEm: new Date(), motivoRevogacao: 'segundo_fator' }).where(eq(masterSessao.tokenHash, 'd'.repeat(64))));
    await comoAppPlataforma(client, () => client.query(`INSERT INTO plataforma_login_limite (tipo, chave, falhas, janela_inicio) VALUES ('master_codigo', $1, 1, now())`, ['f'.repeat(64)]));
    expect(await erroDe(comoAppPlataforma(client, () => client.query(`INSERT INTO plataforma_login_limite (tipo, chave, falhas, janela_inicio) VALUES ('outro', $1, 1, now())`, ['1'.repeat(64)])))).toMatch(/plataforma_login_limite_tipo_ck/);
  });

  it('app_plataforma: SELECT/INSERT/UPDATE em master_login_pendente; SELECT/INSERT e UPDATE só de usado_em em master_codigo_recuperacao; nenhum DELETE', async () => {
    const db = drizzle(client, { schema: sp });
    const agora = new Date();
    await comoAppPlataforma(client, async () => {
      await db.insert(masterLoginPendente).values({ tokenHash: '2'.repeat(64), masterUsuarioId: ID, criadoEm: agora, expiraEm: new Date(agora.getTime() + 300_000) });
      await db.update(masterLoginPendente).set({ tentativas: 1, concluidoEm: agora }).where(eq(masterLoginPendente.tokenHash, '2'.repeat(64)));
      expect(await db.select().from(masterLoginPendente)).toHaveLength(1);
      await db.update(masterUsuario).set({ recuperacaoGeracao: 1, segundoFatorFalhas: 1 }).where(eq(masterUsuario.id, ID));
      await db.insert(masterCodigoRecuperacao).values({ masterUsuarioId: ID, geracao: 1, codigoHash: '3'.repeat(64) });
      await db.update(masterCodigoRecuperacao).set({ usadoEm: agora }).where(eq(masterCodigoRecuperacao.codigoHash, '3'.repeat(64)));
      expect(await db.select().from(masterCodigoRecuperacao)).toHaveLength(1);
    });
    for (const p of [
      () => db.update(masterCodigoRecuperacao).set({ geracao: 2 }).where(eq(masterCodigoRecuperacao.codigoHash, '3'.repeat(64))),
      () => db.update(masterCodigoRecuperacao).set({ codigoHash: '4'.repeat(64) }).where(eq(masterCodigoRecuperacao.codigoHash, '3'.repeat(64))),
      () => db.delete(masterCodigoRecuperacao),
      () => db.delete(masterLoginPendente),
      () => db.delete(masterUsuario).where(eq(masterUsuario.id, ID)),
      () => client.query('TRUNCATE master_login_pendente'),
    ]) {
      expect(await erroDe(comoAppPlataforma(client, p))).toMatch(/permission denied/);
    }
  });

  it('CHECKs: trio ativo e trio pendente tudo-ou-nada, 48 bytes, versões > 0, hash de código e de token em hex de 64', async () => {
    const q = (sql: string, params: unknown[] = []) => erroDe(client.query(sql, params));
    expect(await q(`UPDATE master_usuario SET totp_cifrado = $1 WHERE id = $2`, [new Uint8Array(48), ID])).toMatch(/master_usuario_totp_ck/);
    expect(await q(`UPDATE master_usuario SET totp_cifrado = $1, totp_mestra_versao = 1, totp_ativado_em = now() WHERE id = $2`, [new Uint8Array(47), ID])).toMatch(/master_usuario_totp_ck/);
    expect(await q(`UPDATE master_usuario SET totp_cifrado = $1, totp_mestra_versao = 0, totp_ativado_em = now() WHERE id = $2`, [new Uint8Array(48), ID])).toMatch(/master_usuario_totp_ck/);
    expect(await q(`UPDATE master_usuario SET totp_pendente_cifrado = $1, totp_pendente_mestra_versao = 1 WHERE id = $2`, [new Uint8Array(48), ID])).toMatch(/master_usuario_totp_pendente_ck/);
    expect(await q(`UPDATE master_usuario SET totp_ultimo_passo = 0 WHERE id = $1`, [ID])).toMatch(/master_usuario_totp_passo_ck/);
    expect(await q(`UPDATE master_usuario SET segundo_fator_falhas = -1 WHERE id = $1`, [ID])).toMatch(/master_usuario_segundo_fator_ck/);
    expect(await q(`INSERT INTO master_codigo_recuperacao (master_usuario_id, geracao, codigo_hash) VALUES ($1, 1, 'ABC')`, [ID])).toMatch(/master_codigo_recuperacao_hash_ck/);
    expect(await q(`INSERT INTO master_login_pendente (token_hash, master_usuario_id, expira_em) VALUES ('x', $1, now() + interval '1 minute')`, [ID])).toMatch(/master_login_pendente_token_hash_ck/);
    await client.query(`UPDATE master_usuario SET totp_cifrado = $1, totp_mestra_versao = 1, totp_ativado_em = now() WHERE id = $2`, [new Uint8Array(48), ID]);
  });
});
