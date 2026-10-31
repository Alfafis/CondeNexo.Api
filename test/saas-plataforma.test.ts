// Fase F1 do SaaS (docs/05_arquitetura_saas.md §4.1, SAAS-02/04): banco `plataforma` (PGlite próprio, migrações reais
// de drizzle-plataforma/), envelope de chaves pela chave mestra e registro do piloto com as chaves atuais.
// A API não depende de nada disto nesta fase: os outros testes rodam sem o banco da plataforma.
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErroUso, lerEntrada } from '../src/cli/registrar-piloto';
import {
  aadChave, carregarChaveMestra, type ChaveMestra, desembrulhar, embrulhar, ErroChave, impressaoDigital,
} from '../src/saas/chave-mestra';
import { BANCO_PILOTO, type EntradaPiloto, registrarPiloto } from '../src/saas/registrar-piloto';
import * as sp from '../src/saas/schema-plataforma';
import { erroDe, novoBanco } from './helpers/banco';
import { comoAppPlataforma, novoBancoPlataforma } from './helpers/plataforma';

const MESTRA: ChaveMestra = { chave: Buffer.alloc(32, 0x4d), versao: 1 };
const HMAC = Buffer.alloc(32, 0x48);
const KEK = Buffer.alloc(32, 0x4b);
const b64 = (b: Buffer) => b.toString('base64');

const entrada = (extra: Partial<EntradaPiloto> = {}): EntradaPiloto => ({
  codigo: 'piloto', nome: 'Condomínio de teste', plano: 'piloto', hmacCpf: HMAC, kek: KEK, kekVersao: 3, mestra: MESTRA, ...extra,
});

describe('envelope de chaves (SAAS-04)', () => {
  const id = { condominioId: randomUUID(), tipo: 'kek_documentos' as const, versao: 1 };

  it('ida e volta; nonce novo a cada embrulho; o cifrado não contém a chave', () => {
    const a = embrulhar(MESTRA, id, KEK);
    const b = embrulhar(MESTRA, id, KEK);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.chaveCifrada.length).toBe(32 + 16);
    expect(a.chaveCifrada.includes(KEK.subarray(0, 8))).toBe(false);
    expect(desembrulhar(MESTRA, id, a).equals(KEK)).toBe(true);
    expect(aadChave(id)).toBe(`portaria:chave:${id.condominioId}:kek_documentos:v1`);
  });

  it('AAD amarra condomínio, tipo e versão: a linha trocada não desembrulha', () => {
    const e = embrulhar(MESTRA, id, KEK);
    for (const outro of [{ ...id, condominioId: randomUUID() }, { ...id, tipo: 'hmac_cpf' as const }, { ...id, versao: 2 }]) {
      expect(() => desembrulhar(MESTRA, outro, e)).toThrow(/não autenticou/);
    }
  });

  it('mestra errada não autentica; mestra de outra versão é recusada antes, com mensagem clara', () => {
    const e = embrulhar(MESTRA, id, KEK);
    expect(() => desembrulhar({ chave: Buffer.alloc(32, 1), versao: 1 }, id, e)).toThrow(/não autenticou/);
    expect(() => desembrulhar({ ...MESTRA, versao: 2 }, id, e)).toThrow(/mestra v1, mas o ambiente tem a v2/);
    const adulterado = Buffer.from(e.chaveCifrada); adulterado[0]! ^= 1;
    expect(() => desembrulhar(MESTRA, id, { ...e, chaveCifrada: adulterado })).toThrow(ErroChave);
  });

  it('chave mestra do ambiente: 32 bytes e versão obrigatórios; erro cita o nome, nunca o valor', () => {
    const curta = b64(Buffer.alloc(16, 0x61));
    expect(() => carregarChaveMestra({})).toThrow('PORTARIA_CHAVE_MESTRA não definida');
    expect(() => carregarChaveMestra({ PORTARIA_CHAVE_MESTRA: curta, PORTARIA_CHAVE_MESTRA_VERSAO: '1' })).toThrow(/exatamente 32 bytes/);
    try { carregarChaveMestra({ PORTARIA_CHAVE_MESTRA: curta, PORTARIA_CHAVE_MESTRA_VERSAO: '1' }); } catch (e) { expect((e as Error).message).not.toContain(curta); }
    expect(() => carregarChaveMestra({ PORTARIA_CHAVE_MESTRA: b64(MESTRA.chave) })).toThrow('PORTARIA_CHAVE_MESTRA_VERSAO não definida');
    expect(() => carregarChaveMestra({ PORTARIA_CHAVE_MESTRA: b64(MESTRA.chave), PORTARIA_CHAVE_MESTRA_VERSAO: '0' })).toThrow(/entre 1 e 32767/);
    expect(carregarChaveMestra({ PORTARIA_CHAVE_MESTRA: ` ${b64(MESTRA.chave)} `, PORTARIA_CHAVE_MESTRA_VERSAO: '2' })).toEqual({ chave: MESTRA.chave, versao: 2 });
  });

  it('impressão digital: estável, curta e diferente da chave', () => {
    expect(impressaoDigital(KEK)).toMatch(/^[0-9a-f]{16}$/);
    expect(impressaoDigital(KEK)).toBe(impressaoDigital(Buffer.from(KEK)));
    expect(impressaoDigital(KEK)).not.toBe(impressaoDigital(HMAC));
  });
});

describe('banco plataforma: migrações próprias, separadas dos bancos de condomínio', () => {
  let p: Awaited<ReturnType<typeof novoBancoPlataforma>>;
  beforeAll(async () => { p = await novoBancoPlataforma(); });
  afterAll(async () => { await p.client.close(); });

  it('cria as tabelas da §4.1 aqui e nenhuma delas no banco de condomínio (e vice-versa)', async () => {
    const tabelas = (await p.client.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
    expect(tabelas).toEqual(['ancora_diaria', 'condominio', 'condominio_chave', 'condominio_contrato', 'condominio_metrica',
      'lgpd_anonimizacao', 'master_sessao', 'master_usuario', 'plataforma_audit', 'plataforma_login_limite']);
    const cond = await novoBanco();
    try {
      const r = await cond.client.query<{ c: string | null; e: string | null }>(`SELECT to_regclass('condominio_chave')::text AS c, to_regclass('evento_acesso')::text AS e`);
      expect(r.rows[0]).toEqual({ c: null, e: 'evento_acesso' });
      expect((await p.client.query<{ e: string | null }>(`SELECT to_regclass('evento_acesso')::text AS e`)).rows[0]!.e).toBeNull();
    } finally { await cond.client.close(); }
  });

  it('CHECKs: código do login, nome do banco (entra em CREATE/DROP DATABASE), status e encerramento', async () => {
    const base = { codigo: 'abc', nome: 'X', banco: 'portaria_abcd1234', plano: 'p' };
    expect(await erroDe(p.db.insert(sp.condominio).values({ ...base, codigo: 'A b' }))).toMatch(/condominio_codigo_ck/);
    expect(await erroDe(p.db.insert(sp.condominio).values({ ...base, banco: 'portaria; DROP DATABASE x' }))).toMatch(/condominio_banco_ck/);
    expect(await erroDe(p.db.insert(sp.condominio).values({ ...base, banco: 'postgres' }))).toMatch(/condominio_banco_ck/);
    expect(await erroDe(p.db.insert(sp.condominio).values({ ...base, status: 'apagado' }))).toMatch(/condominio_status_ck/);
    expect(await erroDe(p.db.insert(sp.condominio).values({ ...base, status: 'encerrado' }))).toMatch(/condominio_encerrado_ck/);
  });

  it('app_plataforma: lê e grava, nunca apaga; trilha só cresce; chave só muda `ativa`', async () => {
    const [c] = await p.db.insert(sp.condominio).values({ codigo: 'grants', nome: 'G', banco: 'portaria_grants01', plano: 'p' }).returning();
    const emb = embrulhar(MESTRA, { condominioId: c!.id, tipo: 'hmac_cpf', versao: 1 }, HMAC);
    await p.db.insert(sp.condominioChave).values({ condominioId: c!.id, tipo: 'hmac_cpf', versao: 1, ...emb, ativa: true });
    await comoAppPlataforma(p.client, async () => {
      await p.db.insert(sp.plataformaAudit).values({ acao: 'teste.grants', condominioId: c!.id });
      await p.db.update(sp.condominio).set({ status: 'ativo' }).where(eq(sp.condominio.id, c!.id));
      await p.db.update(sp.condominioChave).set({ ativa: false }).where(eq(sp.condominioChave.condominioId, c!.id));
      expect(await erroDe(p.db.delete(sp.condominio).where(eq(sp.condominio.id, c!.id)))).toMatch(/permission denied/);
      expect(await erroDe(p.db.delete(sp.plataformaAudit))).toMatch(/permission denied/);
      expect(await erroDe(p.db.update(sp.plataformaAudit).set({ acao: 'teste.outra' }))).toMatch(/permission denied/);
      expect(await erroDe(p.db.update(sp.condominioChave).set({ mestraVersao: 9 }))).toMatch(/permission denied/);
      expect(await erroDe(p.client.query('TRUNCATE plataforma_audit'))).toMatch(/permission denied/);
    });
    // Nem o dono: a trilha é append-only por trigger, e o embrulho só muda com mestra de versão maior.
    expect(await erroDe(p.db.update(sp.plataformaAudit).set({ acao: 'teste.dono' }))).toMatch(/append-only/);
    expect(await erroDe(p.db.delete(sp.plataformaAudit))).toMatch(/append-only/);
    expect(await erroDe(p.db.update(sp.condominioChave).set({ versao: 2 }))).toMatch(/só ativa muda/);
    expect(await erroDe(p.db.update(sp.condominioChave).set({ nonce: Buffer.alloc(12, 1) }))).toMatch(/só ativa muda/);
    const nova = embrulhar({ chave: Buffer.alloc(32, 0x4e), versao: 2 }, { condominioId: c!.id, tipo: 'hmac_cpf', versao: 1 }, HMAC);
    await p.db.update(sp.condominioChave).set(nova).where(eq(sp.condominioChave.condominioId, c!.id)); // rotação da mestra
  });
});

describe('registro do piloto (F1): chaves atuais como versão de hoje, sem tocar no banco portaria', () => {
  let p: Awaited<ReturnType<typeof novoBancoPlataforma>>;
  beforeAll(async () => { p = await novoBancoPlataforma(); });
  afterAll(async () => { await p.client.close(); });
  const contar = async () => (await p.client.query<{ c: number; k: number; a: number }>(
    `SELECT (SELECT count(*)::int FROM condominio) c, (SELECT count(*)::int FROM condominio_chave) k, (SELECT count(*)::int FROM plataforma_audit) a`)).rows[0]!;

  it('como app_plataforma: piloto ativo em `portaria`; HMAC v1 e KEK na versão do ambiente; trilha sem chave', async () => {
    const r = await comoAppPlataforma(p.client, () => registrarPiloto(p.db, entrada()));
    expect(r).toMatchObject({ situacao: 'registrado', codigo: 'piloto', banco: BANCO_PILOTO });
    expect(r.chaves).toEqual([
      { tipo: 'hmac_cpf', versao: 1, mestraVersao: 1, impressao: impressaoDigital(HMAC) },
      { tipo: 'kek_documentos', versao: 3, mestraVersao: 1, impressao: impressaoDigital(KEK) },
    ]);
    const [c] = await p.db.select().from(sp.condominio);
    expect(c).toMatchObject({ id: r.condominioId, banco: 'portaria', status: 'ativo', plano: 'piloto' });
    const chaves = await p.db.select().from(sp.condominioChave);
    for (const k of chaves) {
      const claro = desembrulhar(MESTRA, { condominioId: c!.id, tipo: k.tipo as sp.TipoChave, versao: k.versao }, k);
      expect(claro.equals(k.tipo === 'hmac_cpf' ? HMAC : KEK)).toBe(true);
    }
    const [a] = await p.db.select().from(sp.plataformaAudit);
    expect(a).toMatchObject({ acao: 'condominio.registrarPiloto', condominioId: c!.id, masterUsuarioId: null });
    const tudo = JSON.stringify({ r, a });
    for (const k of [HMAC, KEK, MESTRA.chave]) { expect(tudo).not.toContain(b64(k)); expect(tudo).not.toContain(k.toString('hex')); }
    expect(await contar()).toEqual({ c: 1, k: 2, a: 1 });
  });

  it('de novo com as mesmas chaves: nada muda', async () => {
    const r = await registrarPiloto(p.db, entrada());
    expect(r.situacao).toBe('ja_registrado');
    expect(await contar()).toEqual({ c: 1, k: 2, a: 1 });
  });

  it('recusa sem gravar: chave diferente, versão da KEK diferente, outro código, outra mestra, chaves repetidas', async () => {
    const casos: [Partial<EntradaPiloto>, RegExp][] = [
      [{ kek: Buffer.alloc(32, 0x4c) }, /kek_documentos registrada é diferente/],
      [{ hmacCpf: Buffer.alloc(40, 0x49) }, /hmac_cpf registrada é diferente/],
      [{ kekVersao: 4 }, /é a v3, o ambiente informa a v4/],
      [{ codigo: 'outro' }, /já está registrado com outro código \(piloto\)/],
      [{ mestra: { chave: Buffer.alloc(32, 1), versao: 1 } }, /não autenticou/],
      [{ mestra: { chave: MESTRA.chave, versao: 2 } }, /mestra v1, mas o ambiente tem a v2/],
      [{ mestra: { chave: KEK, versao: 1 } }, /precisam ser diferentes/],
      [{ codigo: 'X' }, /código do condomínio/],
    ];
    for (const [extra, msg] of casos) await expect(registrarPiloto(p.db, entrada(extra))).rejects.toThrow(msg);
    expect(await contar()).toEqual({ c: 1, k: 2, a: 1 });
  });

  it('código já usado por outro condomínio é recusado', async () => {
    const outro = await novoBancoPlataforma();
    try {
      await outro.db.insert(sp.condominio).values({ codigo: 'piloto', nome: 'Outro', banco: 'portaria_outro001', plano: 'p' });
      await expect(registrarPiloto(outro.db, entrada())).rejects.toThrow(/já pertence a outro condomínio/);
      expect((await outro.db.execute(sql`SELECT count(*)::int AS n FROM condominio_chave`)).rows[0]).toEqual({ n: 0 });
    } finally { await outro.client.close(); }
  });

  it('CLI: argumentos e ambiente validados; mensagens citam nomes, nunca valores; só aceita o banco plataforma', () => {
    const env = {
      DATABASE_URL_PLATAFORMA: 'postgres://app_plataforma:s3nha@db:5432/plataforma',
      PORTARIA_CHAVE_MESTRA: b64(MESTRA.chave), PORTARIA_CHAVE_MESTRA_VERSAO: '1',
      PORTARIA_HMAC_CPF_KEY: b64(HMAC), PORTARIA_KEK: b64(KEK), PORTARIA_KEK_VERSAO: '3',
    };
    const args = ['--codigo', 'piloto', '--nome', 'Condomínio de teste'];
    const ok = lerEntrada(args, env);
    expect(ok.entrada).toMatchObject({ codigo: 'piloto', plano: 'piloto', kekVersao: 3 });
    expect(ok.entrada.kek.equals(KEK)).toBe(true);
    expect(() => lerEntrada(['--codigo', 'piloto'], env)).toThrow(ErroUso);
    expect(() => lerEntrada([...args, '--banco', 'x'], env)).toThrow(ErroUso);
    expect(() => lerEntrada(args, { ...env, DATABASE_URL_PLATAFORMA: 'postgres://app_rw:x@db:5432/portaria' })).toThrow(/apontar para o banco plataforma/);
    expect(() => lerEntrada(args, { ...env, DATABASE_URL_PLATAFORMA: 'postgres://app_plataforma:@db:5432/plataforma' })).toThrow(/sem senha/);
    for (const k of ['PORTARIA_CHAVE_MESTRA', 'PORTARIA_KEK', 'PORTARIA_HMAC_CPF_KEY', 'PORTARIA_KEK_VERSAO'] as const) {
      expect(() => lerEntrada(args, { ...env, [k]: '' })).toThrow(`${k} não definida`);
    }
    const kekCurta = b64(Buffer.alloc(31, 0x4b));
    try { lerEntrada(args, { ...env, PORTARIA_KEK: kekCurta }); expect.unreachable(); } catch (e) {
      expect((e as Error).message).toMatch(/PORTARIA_KEK precisa ter exatamente 32 bytes/);
      expect((e as Error).message).not.toContain(kekCurta);
    }
  });
});
