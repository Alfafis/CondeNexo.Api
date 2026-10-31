// Validade da senha temporária (spec §5.1): 72 h a partir do cadastro ou da redefinição. Login com a temporária
// vencida é recusado (só com a senha certa revela o motivo), conta no limite e não cria sessão; a sessão aberta antes
// perde o acesso no prazo; a troca zera o prazo e a redefinição o renova. Mais o backfill da migração 0006.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SENHA_TEMPORARIA_VALIDADE_MS } from '../src/dominio/rules';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PADROES_LOGIN } from '../src/config/config';
import * as s from '../src/db/schema';
import { type ApiDeTeste, novaApi, novoIp, trilha } from './helpers/app';
import { comoAppRw, erroDe, PASTA_MIGRACOES, SENHA_FALSA } from './helpers/banco';

const MIN_72H = SENHA_TEMPORARIA_VALIDADE_MS / 60_000;

describe('senha temporária: validade de 72 h', () => {
  let api: ApiDeTeste;
  let adm: string;
  beforeEach(async () => { api = await novaApi(); adm = (await api.como('administracao')).cookie; });
  afterEach(async () => { await api.app.close(); await api.client.close(); });

  const criar = async (login: string) => {
    const r = await api.http().post('/api/v1/usuarios').set('Cookie', adm).send({ nome: 'Marina Couto', login, papel: 'porteiro' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as { usuario: { id: string; senhaTemporariaExpiraEm: number }; senhaTemporaria: string };
  };
  const login = (l: string, senha: string, ip = novoIp()) =>
    api.http().post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ login: l, senha });
  const sessoesDe = async (id: string) =>
    (await api.db.select({ n: count() }).from(s.sessao).where(eq(s.sessao.usuarioId, id)))[0]!.n;
  const prazoNoBanco = async (id: string) =>
    (await api.db.select({ e: s.usuarioSistema.senhaTemporariaExpiraEm }).from(s.usuarioSistema).where(eq(s.usuarioSistema.id, id)))[0]!.e;

  it('criar grava e devolve o prazo; a lista o mostra só na gestão (login e /auth/me não)', async () => {
    const t0 = api.relogio.agora().getTime();
    const c = await criar('marina.couto');
    expect(c.usuario.senhaTemporariaExpiraEm).toBe(t0 + SENHA_TEMPORARIA_VALIDADE_MS);
    expect((await prazoNoBanco(c.usuario.id))?.getTime()).toBe(t0 + SENHA_TEMPORARIA_VALIDADE_MS);
    const lista = await api.http().get('/api/v1/usuarios').set('Cookie', adm);
    const linha = lista.body.data.find((u: { id: string }) => u.id === c.usuario.id);
    expect(linha).toMatchObject({ deveTrocarSenha: true, senhaTemporariaExpiraEm: t0 + SENHA_TEMPORARIA_VALIDADE_MS });
    expect(lista.body.data.find((u: { login: string }) => u.login === 'joao.lima')).toMatchObject({ senhaTemporariaExpiraEm: null });

    const entrou = await login('marina.couto', c.senhaTemporaria);
    expect(entrou.status).toBe(200);
    expect(entrou.body.data.usuario).not.toHaveProperty('senhaTemporariaExpiraEm');
    const me = await api.http().get('/api/v1/auth/me').set('Cookie', entrou.headers['set-cookie']![0]!.split(';')[0]!);
    expect(me.status).toBe(200);
    expect(me.body.data.usuario).not.toHaveProperty('senhaTemporariaExpiraEm');
  });

  it('vence após 72 h: senha certa recusada com código próprio, sem sessão, com motivo na trilha; senha errada segue genérica', async () => {
    const c = await criar('marina.couto');
    api.relogio.avancarMin(MIN_72H - 1);
    const antes = await login('marina.couto', c.senhaTemporaria);
    expect(antes.status).toBe(200); // ainda dentro do prazo
    expect(await sessoesDe(c.usuario.id)).toBe(1);

    api.relogio.avancarMin(1); // exatamente no prazo: vencida
    const errada = await login('marina.couto', 'nao-e-a-senha-certa');
    expect(errada.status).toBe(401);
    expect(errada.body.code).toBe('CREDENCIAIS_INVALIDAS'); // não revela que a conta tem temporária vencida
    const r = await login('marina.couto', c.senhaTemporaria);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'SENHA_TEMPORARIA_EXPIRADA', message: 'Senha temporária vencida. Peça a redefinição à administração.' });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(await sessoesDe(c.usuario.id)).toBe(1); // nenhuma sessão nova
    const falha = (await trilha(api, 'auth.login_falha')).at(-1)!;
    expect(falha).toMatchObject({ usuarioId: c.usuario.id, entidade: 'sessao' });
    expect(falha.depois).toEqual({ motivo: 'senha_temporaria_expirada' }); // sem o texto digitado
  });

  it('conta no limite de login: 10 tentativas com a vencida bloqueiam; a redefinição desbloqueia e renova o prazo', async () => {
    const c = await criar('marina.couto');
    api.relogio.avancarMin(MIN_72H);
    const ip = novoIp();
    for (let i = 0; i < PADROES_LOGIN.maxFalhasLogin; i++) {
      expect((await login('marina.couto', c.senhaTemporaria, ip)).body.code).toBe('SENHA_TEMPORARIA_EXPIRADA');
    }
    const bloqueado = await login('marina.couto', c.senhaTemporaria, ip);
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.code).toBe('LOGIN_BLOQUEADO');

    const agora = api.relogio.agora().getTime();
    const red = await api.http().post(`/api/v1/usuarios/${c.usuario.id}/redefinir-senha`).set('Cookie', (await api.como('administracao')).cookie);
    expect(red.status).toBe(200);
    expect(red.body.data.usuario).toMatchObject({ deveTrocarSenha: true, senhaTemporariaExpiraEm: agora + SENHA_TEMPORARIA_VALIDADE_MS });
    expect((await prazoNoBanco(c.usuario.id))?.getTime()).toBe(agora + SENHA_TEMPORARIA_VALIDADE_MS);
    expect((await login('marina.couto', c.senhaTemporaria, ip)).body.code).toBe('CREDENCIAIS_INVALIDAS'); // a antiga morreu
    expect((await login('marina.couto', red.body.data.senhaTemporaria, ip)).status).toBe(200); // o par foi desbloqueado
  });

  it('a troca de senha zera o prazo (NULL) e a conta deixa de vencer', async () => {
    const c = await criar('marina.couto');
    const s1 = await api.entrar('marina.couto', c.senhaTemporaria);
    const ok = await api.http().post('/api/v1/auth/trocar-senha').set('Cookie', s1.cookie)
      .send({ senhaAtual: c.senhaTemporaria, novaSenha: 'uma senha nova e longa' });
    expect(ok.status).toBe(200);
    expect(await prazoNoBanco(c.usuario.id)).toBeNull();
    const lista = await api.http().get('/api/v1/usuarios').set('Cookie', adm);
    expect(lista.body.data.find((u: { id: string }) => u.id === c.usuario.id)).toMatchObject({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null });
    api.relogio.avancarMin(MIN_72H + 60);
    expect((await login('marina.couto', 'uma senha nova e longa')).status).toBe(200);
  });

  it('sessão aberta com troca pendente perde as 3 rotas quando a temporária vence (e a vencida não serve para trocar)', async () => {
    const c = await criar('marina.couto');
    api.relogio.avancarMin(MIN_72H - 10);
    const s1 = await api.entrar('marina.couto', c.senhaTemporaria);
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', s1.cookie)).status).toBe(200);
    api.relogio.avancarMin(15); // passou do prazo, dentro da inatividade (30 min) e da sessão absoluta (12 h)
    const me = await api.http().get('/api/v1/auth/me').set('Cookie', s1.cookie);
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('SESSAO_INVALIDA');
    const troca = await api.http().post('/api/v1/auth/trocar-senha').set('Cookie', s1.cookie)
      .send({ senhaAtual: c.senhaTemporaria, novaSenha: 'uma senha nova e longa' });
    expect(troca.status).toBe(401);
    expect((await api.http().post('/api/v1/auth/logout').set('Cookie', s1.cookie)).status).toBe(401);
    expect(await prazoNoBanco(c.usuario.id)).not.toBeNull(); // nada foi trocado
    // Quem não tem troca pendente não é afetado pelo prazo (só pela sessão)
    const adm2 = await api.como('sindico');
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', adm2.cookie)).status).toBe(200);
  });
});

describe('migração 0006: backfill do prazo, CHECK e permissão do app_rw', () => {
  const temporarias: string[] = [];
  afterAll(() => { for (const p of temporarias) rmSync(p, { recursive: true, force: true }); });

  /** Pasta de migrações só até a 0005 (journal truncado): o banco de produção antes desta mudança. */
  function migracoesAte0005(): string {
    const dir = mkdtempSync(join(tmpdir(), 'migracoes-0005-'));
    temporarias.push(dir);
    cpSync(PASTA_MIGRACOES, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx <= 5);
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
    return dir;
  }

  it('troca pendente recebe senha_alterada_em (ou criado_em) + 72 h; sem troca pendente fica NULL', async () => {
    const client = new PGlite();
    try {
      await client.exec('CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;');
      const db = drizzle(client, { schema: s });
      await migrate(db, { migrationsFolder: migracoesAte0005() });
      // Como o seed de produção grava: deve_trocar_senha=true, senha_alterada_em NULL.
      await client.query(`INSERT INTO usuario_sistema (nome, login, senha_hash, papel, deve_trocar_senha, senha_alterada_em, criado_em) VALUES
        ('Semeado', 'semeado', $1, 'sindico', true, NULL, '2026-10-19T09:00:00Z'),
        ('Redefinido', 'redefinido', $1, 'porteiro', true, '2026-10-18T15:30:00Z', '2026-10-01T09:00:00Z'),
        ('Trocou', 'trocou', $1, 'auditor', false, '2026-10-18T15:30:00Z', '2026-10-01T09:00:00Z')`, [SENHA_FALSA]);

      await migrate(db, { migrationsFolder: PASTA_MIGRACOES });
      const linhas = await db.select({ login: s.usuarioSistema.login, e: s.usuarioSistema.senhaTemporariaExpiraEm }).from(s.usuarioSistema);
      const prazo = Object.fromEntries(linhas.map((l) => [l.login, l.e?.toISOString() ?? null]));
      expect(prazo).toEqual({
        semeado: '2026-10-22T09:00:00.000Z',
        redefinido: '2026-10-21T15:30:00.000Z',
        trocou: null,
      });

      // CHECK: sem troca pendente, sem prazo.
      expect(await erroDe(db.update(s.usuarioSistema).set({ senhaTemporariaExpiraEm: new Date() }).where(eq(s.usuarioSistema.login, 'trocou'))))
        .toMatch(/usuario_senha_temporaria_ck/);
      expect(await erroDe(db.update(s.usuarioSistema).set({ deveTrocarSenha: false }).where(eq(s.usuarioSistema.login, 'semeado'))))
        .toMatch(/usuario_senha_temporaria_ck/);
      // O app_rw (a API) grava e zera a coluna nova com os GRANTs que já existiam.
      await comoAppRw(client, () => db.update(s.usuarioSistema)
        .set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(s.usuarioSistema.login, 'semeado')));
      await comoAppRw(client, () => db.update(s.usuarioSistema)
        .set({ deveTrocarSenha: true, senhaTemporariaExpiraEm: new Date('2026-10-25T00:00:00Z') }).where(eq(s.usuarioSistema.login, 'trocou')));
    } finally {
      await client.close();
    }
  });
});
