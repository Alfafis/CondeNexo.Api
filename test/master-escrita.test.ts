// Escrita do Master nos dados de um condomínio (Fase C1, spec 2026-11-01-fase-c-escrita-master-design): unidades pelo
// MESMO serviço do síndico, pelo ponto único (AcessoPlataformaService.escrever), sem senha nem motivo. Confere: efeito e
// erro de regra iguais aos do síndico; ator = usuário técnico do condomínio (`@plataforma`, invisível ao condomínio);
// linha `condominio.escrever` em plataforma_audit com o status real; situação e módulo; papel; limites (por minuto, em
// memória; diários, duráveis); trilha do síndico sem nada do Master; integridade da cadeia intacta; sem PII.
import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditoriaService } from '../src/auditoria/auditoria.service';
import { MENSAGEM_CREDENCIAIS } from '../src/auth/auth.service';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { AcessoPlataformaService } from '../src/plataforma/acesso-plataforma.service';
import { nomeCookieMaster } from '../src/plataforma/cookie-master';
import { condominio, masterUsuario, plataformaAudit } from '../src/plataforma/schema-plataforma';
import type { AuthMaster } from '../src/plataforma/tipos';
import { criarUsuario } from '../src/plataforma/usuario-plataforma';
import { ResolvedorCondominio } from '../src/tenancy/resolvedor';
import { LOGIN_TECNICO_PLATAFORMA, NOME_TECNICO_PLATAFORMA, UsuariosService } from '../src/usuarios/usuarios.service';
import { type ApiDeTeste, configDeTeste, LOGINS, novaApi, novoIp } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';
import { DEMO } from './helpers/saas';

const V1 = '/api/v1';
const P = `${V1}/plataforma`;
const SENHA_M = 'senha-do-master-bem-longa-1';
const EMAIL = 'master.escrita@exemplo.test';
/** Limite por minuto baixo SÓ neste arquivo (o padrão de produção é 30); cada teste começa numa janela nova. */
const POR_MINUTO = 8;
const CREDENCIAIS_DIA = 2;

let api: ApiDeTeste;
let master: string;
let masterId: string;
let suporte: string;
const saida: string[] = [];
const ids: Record<string, string> = {};

async function novoMaster(email: string, papel: 'master' | 'suporte') {
  const c = await criarUsuario(api.plataforma.db, {
    hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
  }, { email, nome: `Operador ${papel}`, papel });
  await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
  const r = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', novoIp()).send({ email, senha: SENHA_M });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { cookie: (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!.split(';')[0]!, id: c.id };
}

const em = (cond = api.pilotoId) => `${P}/condominios/${cond}/unidades`;
const criar = (corpo: object, cookie = master, cond = api.pilotoId) => api.http().post(em(cond)).set('Cookie', cookie).send(corpo);
const editar = (id: string, corpo: object, cookie = master, cond = api.pilotoId) => api.http().patch(`${em(cond)}/${id}`).set('Cookie', cookie).send(corpo);
const alternar = (id: string, acao: 'desativar' | 'reativar', cookie = master, cond = api.pilotoId) =>
  api.http().post(`${em(cond)}/${id}/${acao}`).set('Cookie', cookie).send({});
const escritasP = () => api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'condominio.escrever')).orderBy(plataformaAudit.seq);
const unidade = async (id: string, db = api.db) => (await db.select().from(s.unidade).where(eq(s.unidade.id, id)))[0]!;
const tecnico = async (db = api.db) => (await db.select().from(s.usuarioSistema).where(sql`lower(${s.usuarioSistema.login}) = ${LOGIN_TECNICO_PLATAFORMA}`));
const novaJanela = () => api.relogio.avancarMin(2);

/** Chamada direta ao ponto único (classes e módulo que nenhuma rota da C1 usa). */
const reqFalsa = () => {
  const cab: Record<string, string> = {};
  return { req: { method: 'POST', baseUrl: '', route: { path: '/x' }, requestId: 'teste', res: { setHeader: (k: string, v: string) => { cab[k] = v; } } } as unknown as Request, cab };
};
const authM = (): AuthMaster => ({ sessaoId: '00000000-0000-4000-8000-000000000001', expiraEm: new Date(Date.now() + 3600_000), ip: '203.0.113.9',
  usuario: { id: masterId, nome: 'Operador master', email: EMAIL, papel: 'master', deveTrocarSenha: false } });

beforeAll(async () => {
  for (const f of ['log', 'error', 'warn'] as const) vi.spyOn(console, f).mockImplementation((...a: unknown[]) => { saida.push(a.map(String).join(' ')); });
  api = await novaApi({ plataforma: { ...configDeTeste().plataforma, escritasPorMinuto: POR_MINUTO, credenciaisPorDia: CREDENCIAIS_DIA } }, { demo: true });
  api.relogio.atual = new Date(); // as janelas diárias contam pelo `em` real de plataforma_audit
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  await seedPessoasDev(api.demo!.db, { chaveHmac: DEMO.hmac, agora: api.relogio.agora() });
  const [v] = await api.db.select().from(s.vinculoUnidade).limit(1);
  ids.referenciada = v!.unidadeId;
  ({ cookie: master, id: masterId } = await novoMaster(EMAIL, 'master'));
  suporte = (await novoMaster('suporte.escrita@exemplo.test', 'suporte')).cookie;
}, 120_000);

beforeEach(() => novaJanela());

afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

describe('unidades: o mesmo efeito e a mesma trilha do síndico, com o técnico da plataforma como ator', () => {
  it('criar: 201, normalizado como no síndico; audit_log com o técnico e o e-mail do Master; condominio.escrever com o id criado', async () => {
    expect(await tecnico()).toHaveLength(0); // nasce na primeira escrita
    const r = await criar({ bloco: 'q', numero: '7' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ bloco: 'Q', numero: '07', ativo: true });
    ids.nova = r.body.data.id;
    const [t] = await tecnico();
    expect(t).toMatchObject({ nome: NOME_TECNICO_PLATAFORMA, papel: 'administracao', ativo: true, deveTrocarSenha: false, senhaTemporariaExpiraEm: null });
    expect(t!.senhaHash).toMatch(/^\$argon2id\$/);
    const [l] = await api.db.select().from(s.auditLog).where(and(eq(s.auditLog.acao, 'unidade.criar'), eq(s.auditLog.registroId, ids.nova!)));
    expect(l).toMatchObject({ usuarioId: t!.id, usuarioPapel: 'administracao', usuarioNome: `plataforma/${EMAIL}`, entidade: 'unidade' });
    const [criacaoTecnico] = await api.db.select().from(s.auditLog).where(eq(s.auditLog.acao, 'plataforma.tecnico_criar'));
    expect(criacaoTecnico).toMatchObject({ usuarioId: null, registroId: t!.id, usuarioNome: `plataforma/${EMAIL}` });
    const [p] = (await escritasP()).slice(-1);
    expect(p).toMatchObject({ masterUsuarioId: masterId, condominioId: api.pilotoId });
    expect(p!.detalhes).toEqual({ entidade: 'unidade', operacao: 'criar', registro_id: ids.nova, rota: '/unidades', metodo: 'POST', status: 201, ip: expect.any(String) });
  });

  it('editar, desativar e reativar: estado final e linhas do audit_log iguais às do síndico', async () => {
    const e = await editar(ids.nova!, { bloco: 'Q', numero: '8' });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body.data).toMatchObject({ id: ids.nova, bloco: 'Q', numero: '08' });
    expect((await alternar(ids.nova!, 'desativar')).body.data.ativo).toBe(false);
    expect((await unidade(ids.nova!)).ativo).toBe(false);
    expect((await alternar(ids.nova!, 'reativar')).body.data.ativo).toBe(true);
    const [t] = await tecnico();
    const linhas = await api.db.select().from(s.auditLog).where(eq(s.auditLog.registroId, ids.nova!)).orderBy(s.auditLog.seq);
    expect(linhas.map((l) => [l.acao, l.usuarioId])).toEqual([['unidade.criar', t!.id], ['unidade.editar', t!.id], ['unidade.desativar', t!.id], ['unidade.reativar', t!.id]]);
    expect(linhas[1]!.antes).toMatchObject({ numero: '07' });
    expect(linhas[1]!.depois).toMatchObject({ numero: '08' });
    expect((await escritasP()).slice(-3).map((l) => (l.detalhes as { operacao: string; status: number; rota: string })).map((d) => [d.operacao, d.status, d.rota]))
      .toEqual([['editar', 200, '/unidades/:unidadeId'], ['desativar', 200, '/unidades/:unidadeId/desativar'], ['reativar', 200, '/unidades/:unidadeId/reativar']]);
  });

  it('PATCH sem mudança: devolve o registro sem trilha no condomínio (o serviço retorna `antes`), uma linha na plataforma', async () => {
    const antes = (await api.db.select().from(s.auditLog)).length;
    const r = await editar(ids.nova!, { bloco: 'Q', numero: '08' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: ids.nova, bloco: 'Q', numero: '08', ativo: true });
    expect((await api.db.select().from(s.auditLog)).length).toBe(antes);
  });

  it('erros de regra iguais aos do síndico, e a tentativa fica na plataforma com o status', async () => {
    const sindico = (await api.como('sindico')).cookie;
    const doSindico = await api.http().post(`${V1}/unidades`).set('Cookie', sindico).send({ bloco: 'Q', numero: '8' });
    const doMaster = await criar({ bloco: 'Q', numero: '8' });
    expect([doMaster.status, doMaster.body.code, doMaster.body.message]).toEqual([doSindico.status, doSindico.body.code, doSindico.body.message]);
    expect(doMaster.body.code).toBe('UNIDADE_DUPLICADA');
    const ref = await editar(ids.referenciada!, { bloco: 'Q', numero: '99' });
    expect([ref.status, ref.body.code]).toEqual([422, 'UNIDADE_REFERENCIADA']);
    expect((await criar({ bloco: '????', numero: 'x' })).body.code).toBe('UNIDADE_INVALIDA');
    expect((await alternar(ids.nova!, 'reativar')).body.code).toBe('UNIDADE_JA_ATIVA');
    expect((await alternar('00000000-0000-4000-8000-000000000777', 'desativar')).status).toBe(404);
    expect((await criar({ bloco: 'Q', numero: '9', extra: 1 })).status).toBe(400); // o mesmo schema estrito do síndico
    const ultimas = (await escritasP()).slice(-5).map((l) => (l.detalhes as { status: number; registro_id: string | null }));
    expect(ultimas.map((d) => d.status)).toEqual([409, 422, 422, 409, 404]);
    expect(ultimas[0]!.registro_id).toBeNull(); // criação que falhou: não há id
  });

  it('falha no audit_log do condomínio: rollback (nada muda) e o erro sai', async () => {
    const espiao = vi.spyOn(api.app.get(AuditoriaService), 'registrar').mockRejectedValueOnce(new Error('audit fora'));
    try {
      const r = await editar(ids.nova!, { bloco: 'Q', numero: '10' });
      expect(r.status).toBe(500);
    } finally { espiao.mockRestore(); }
    expect((await unidade(ids.nova!)).numero).toBe('08');
    expect((await escritasP()).slice(-1)[0]!.detalhes).toMatchObject({ operacao: 'editar', status: 500 });
  });

  it('falha em plataforma_audit numa escrita comum: 200, mudança feita, log de erro (sem dado)', async () => {
    saida.length = 0;
    const espiao = vi.spyOn(api.plataforma.db, 'insert').mockImplementationOnce(() => { throw new Error('plataforma fora'); });
    try {
      const r = await editar(ids.nova!, { bloco: 'Q', numero: '11' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } finally { espiao.mockRestore(); }
    expect((await unidade(ids.nova!)).numero).toBe('11');
    expect(saida.join('\n')).toContain('plataforma.falha_trilha_escrita');
  });
});

describe('situação, módulo e papel', () => {
  const status = async (st: 'provisionando' | 'ativo' | 'suspenso' | 'encerrado' | 'excluido') => {
    await api.plataforma.db.update(condominio).set({ status: st, encerradoEm: ['encerrado', 'excluido'].includes(st) ? new Date() : null }).where(eq(condominio.id, api.demo!.id));
    api.app.get(ResolvedorCondominio).invalidar();
  };

  it('ativo e suspenso escrevem; encerrado 409; provisionando 409; excluído e desconhecido 404', async () => {
    try {
      await status('suspenso');
      const r = await criar({ bloco: 'S', numero: '1' }, master, api.demo!.id);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await status('encerrado');
      expect((await alternar(r.body.data.id, 'desativar', master, api.demo!.id)).body.code).toBe('CONDOMINIO_ENCERRADO');
      await status('provisionando');
      expect((await criar({ bloco: 'S', numero: '2' }, master, api.demo!.id)).body.code).toBe('CONDOMINIO_PROVISIONANDO');
      await status('excluido');
      expect((await criar({ bloco: 'S', numero: '2' }, master, api.demo!.id)).status).toBe(404);
      expect((await criar({ bloco: 'S', numero: '2' }, master, '00000000-0000-4000-8000-000000000999')).status).toBe(404);
      await status('ativo');
      expect((await criar({ bloco: 'S', numero: '2' }, master, api.demo!.id)).status).toBe(201);
      // Um técnico por banco: o do demo é outro usuário, no banco do demo.
      const [tp] = await tecnico();
      const [td] = await tecnico(api.demo!.db);
      expect(td!.id).not.toBe(tp!.id);
    } finally { await status('ativo'); }
  });

  it('módulo desligado: 409 MODULO_DESLIGADO na escrita (o serviço nem é chamado); unidades são núcleo e não dependem de módulo', async () => {
    const [c] = await api.plataforma.db.select().from(condominio).where(eq(condominio.id, api.pilotoId));
    await api.plataforma.db.update(condominio).set({ modulos: [] }).where(eq(condominio.id, api.pilotoId));
    api.app.get(ResolvedorCondominio).invalidar();
    try {
      const fn = vi.fn();
      const { req } = reqFalsa();
      await expect(api.app.get(AcessoPlataformaService).escrever(authM(), req, api.pilotoId, { entidade: 'unidade', operacao: 'x', modulo: 'veiculos', classe: 'comum' }, fn))
        .rejects.toMatchObject({ response: expect.objectContaining({ codigo: 'MODULO_DESLIGADO' }) });
      expect(fn).not.toHaveBeenCalled();
      expect((await criar({ bloco: 'M', numero: '1' })).status).toBe(201);
    } finally {
      await api.plataforma.db.update(condominio).set({ modulos: c!.modulos }).where(eq(condominio.id, api.pilotoId));
      api.app.get(ResolvedorCondominio).invalidar();
    }
  });

  it('suporte 403 em toda rota de escrita (acesso.negado na plataforma); sem sessão 401; sessão de condomínio não abre', async () => {
    for (const r of [criar({ bloco: 'Z', numero: '1' }, suporte), editar(ids.nova!, { bloco: 'Z', numero: '1' }, suporte), alternar(ids.nova!, 'desativar', suporte), alternar(ids.nova!, 'reativar', suporte)]) {
      expect((await r).status).toBe(403);
    }
    const [neg] = (await api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'acesso.negado'))).slice(-1);
    expect((neg!.detalhes as { acao: string }).acao).toBe('condominio.unidades');
    expect((await api.http().post(em()).send({ bloco: 'Z', numero: '1' })).status).toBe(401);
    const sindico = (await api.como('sindico')).cookie;
    expect((await api.http().post(em()).set('Cookie', sindico).send({ bloco: 'Z', numero: '1' })).status).toBe(401);
    expect((await unidade(ids.nova!)).ativo).toBe(true);
  });
});

describe('usuário técnico: invisível ao condomínio', () => {
  it('duas primeiras escritas concorrentes num condomínio novo: uma linha só', async () => {
    const svc = await api.servico<UsuariosService>(UsuariosService, api.demo!.id);
    const [a, b] = await Promise.all([svc.garantirTecnicoPlataforma(EMAIL, null), svc.garantirTecnicoPlataforma(EMAIL, null)]);
    expect(a).toBe(b);
    expect(await tecnico(api.demo!.db)).toHaveLength(1);
  });

  it('fora de GET /usuarios (síndico e Master) e dos síndicos; 404 em desativar, reativar, papel e nova senha', async () => {
    const [t] = await tecnico();
    const sindico = (await api.como('sindico')).cookie;
    const lista = await api.http().get(`${V1}/usuarios?limite=100`).set('Cookie', sindico);
    expect(lista.status).toBe(200);
    expect(lista.body.data.map((u: { id: string }) => u.id)).not.toContain(t!.id);
    const doMaster = await api.http().get(`${P}/condominios/${api.pilotoId}/usuarios?limite=100`).set('Cookie', master);
    expect(JSON.stringify(doMaster.body)).not.toContain(t!.id);
    const sindicos = await api.http().get(`${P}/condominios/${api.pilotoId}/sindicos`).set('Cookie', master);
    expect(sindicos.body.data.map((u: { login: string }) => u.login)).toEqual([LOGINS.sindico]);
    for (const [m, rota, corpo] of [['post', 'desativar', {}], ['post', 'reativar', {}], ['post', 'redefinir-senha', {}]] as const) {
      const r = await api.http()[m](`${V1}/usuarios/${t!.id}/${rota}`).set('Cookie', sindico).send(corpo);
      expect([r.status, r.body.code], rota).toEqual([404, 'USUARIO_NAO_ENCONTRADO']);
    }
    const papel = await api.http().patch(`${V1}/usuarios/${t!.id}`).set('Cookie', sindico).send({ papel: 'porteiro' });
    expect([papel.status, papel.body.code]).toEqual([404, 'USUARIO_NAO_ENCONTRADO']);
    // Pela gestão de síndicos do Master também não: 404 (nem "não é síndico", que confirmaria que existe).
    const trocar = await api.http().post(`${P}/condominios/${api.pilotoId}/sindicos/${t!.id}/redefinir-senha`).set('Cookie', master).set('X-Forwarded-For', novoIp())
      .send({ motivo: 'Chamado 1: teste do usuário técnico da plataforma', senhaMaster: SENHA_M });
    expect([trocar.status, trocar.body.code]).toEqual([404, 'USUARIO_NAO_ENCONTRADO']);
    expect((await tecnico())[0]).toMatchObject({ ativo: true, papel: 'administracao', senhaHash: t!.senhaHash });
  });

  it('login com @plataforma: a mesma resposta e a mesma trilha de login inexistente', async () => {
    const inexistente = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: 'ninguem.aqui', senha: 'qualquer-senha-longa' });
    const tecnicoR = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: ' @Plataforma ', senha: 'qualquer-senha-longa' });
    expect([tecnicoR.status, tecnicoR.body.code, tecnicoR.body.message]).toEqual([inexistente.status, inexistente.body.code, inexistente.body.message]);
    expect(tecnicoR.body.message).toBe(MENSAGEM_CREDENCIAIS);
    const [l] = (await api.db.select().from(s.auditLog).where(eq(s.auditLog.acao, 'auth.login_falha')).orderBy(s.auditLog.seq)).slice(-1);
    expect(l).toMatchObject({ usuarioId: null, depois: { motivo: 'login_inexistente' } });
  });
});

describe('trilha do síndico: nada do Master desde o corte', () => {
  it('alterações e acessos da plataforma (síndico e auditor) sem linha do técnico nem plataforma.*; usuário real "plataforma/x" continua', async () => {
    const [t] = await tecnico();
    const [porteiro] = await api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.login, LOGINS.porteiro));
    await api.db.insert(s.auditLog).values({ usuarioId: porteiro!.id, usuarioPapel: 'porteiro', usuarioNome: 'plataforma/x', acao: 'unidade.editar', entidade: 'unidade', registroId: ids.nova! });
    for (const papel of ['sindico', 'auditor'] as const) {
      const c = (await api.como(papel)).cookie;
      const alt = await api.http().get(`${V1}/auditoria/alteracoes?limite=100`).set('Cookie', c);
      expect(alt.status).toBe(200);
      expect(alt.body.data.some((x: { usuarioId: string | null }) => x.usuarioId === t!.id)).toBe(false);
      expect(alt.body.data.some((x: { acao: string }) => x.acao.startsWith('plataforma.'))).toBe(false);
      expect(JSON.stringify(alt.body)).not.toContain(EMAIL);
      expect(alt.body.data.some((x: { usuarioNome: string }) => x.usuarioNome === 'plataforma/x')).toBe(true);
      // Filtro por usuário: pedir o id do técnico não traz nada.
      expect((await api.http().get(`${V1}/auditoria/alteracoes?usuarioId=${t!.id}`).set('Cookie', c)).body.data).toEqual([]);
      const ac = await api.http().get(`${V1}/auditoria/acessos-plataforma?limite=100`).set('Cookie', c);
      expect(ac.status).toBe(200);
      expect(ac.body.data).toEqual([]);
    }
    // O dado continua gravado: só a consulta filtra.
    expect((await api.db.select().from(s.auditLog).where(eq(s.auditLog.usuarioId, t!.id))).length).toBeGreaterThan(5);
  });

  it('integridade: nenhum evento de acesso novo e a cadeia continua válida', async () => {
    const eventos = (await api.db.select().from(s.eventoAcesso)).length;
    const r = await api.http().get(`${V1}/auditoria/integridade`).set('Cookie', (await api.como('auditor')).cookie);
    expect(r.status).toBe(200);
    expect(r.body.data.valido).toBe(true);
    expect((await api.db.select().from(s.eventoAcesso)).length).toBe(eventos);
    expect(eventos).toBe(0); // nenhuma escrita do Master cria evento
  });
});

describe('limites', () => {
  it(`por minuto: ${POR_MINUTO} tentativas (com erro inclusive) passam; a seguinte 429 com Retry-After, sem ler nem gravar`, async () => {
    for (let i = 0; i < POR_MINUTO; i++) expect((await alternar(ids.nova!, 'reativar')).body.code).toBe('UNIDADE_JA_ATIVA');
    const antes = [(await escritasP()).length, (await api.db.select().from(s.auditLog)).length];
    const r = await alternar(ids.nova!, 'desativar');
    expect([r.status, r.body.code]).toEqual([429, 'ESCRITAS_EXCEDIDAS']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect([(await escritasP()).length, (await api.db.select().from(s.auditLog)).length]).toEqual(antes);
    expect((await unidade(ids.nova!)).ativo).toBe(true);
    novaJanela();
    expect((await alternar(ids.nova!, 'desativar')).status).toBe(200);
    expect((await alternar(ids.nova!, 'reativar')).status).toBe(200);
  });

  it('destrutivas desligadas por padrão (0): 409 ACAO_DESLIGADA, nada gravado, serviço não chamado', async () => {
    const fn = vi.fn();
    const antes = (await api.plataforma.db.select().from(plataformaAudit)).length;
    await expect(api.app.get(AcessoPlataformaService).escrever(authM(), reqFalsa().req, api.pilotoId, { entidade: 'unidade', operacao: 'x', classe: 'destrutiva' }, fn))
      .rejects.toMatchObject({ response: expect.objectContaining({ codigo: 'ACAO_DESLIGADA' }) });
    expect(fn).not.toHaveBeenCalled();
    expect((await api.plataforma.db.select().from(plataformaAudit)).length).toBe(antes);
  });

  it('credenciais: linha prévia antes do serviço; acima do diário 429 com Retry-After; o limite é durável (vem do banco)', async () => {
    const acesso = api.app.get(AcessoPlataformaService);
    const previas = () => api.plataforma.db.select().from(plataformaAudit).where(and(eq(plataformaAudit.acao, 'condominio.credencial'), eq(plataformaAudit.masterUsuarioId, masterId)));
    // Uma linha de "ontem à noite" (de outro processo, antes de um reinício): conta, porque o limite lê o banco.
    await api.plataforma.db.insert(plataformaAudit).values({ masterUsuarioId: masterId, acao: 'condominio.credencial', condominioId: api.pilotoId, detalhes: {}, em: new Date(Date.now() - 3600_000) });
    let viuPrevia = false;
    const fn = vi.fn(async () => { viuPrevia = (await previas()).length === CREDENCIAIS_DIA; return { id: ids.nova! }; });
    await acesso.escrever(authM(), reqFalsa().req, api.pilotoId, { entidade: 'unidade', operacao: 'x', registroId: ids.nova!, classe: 'credencial' }, fn);
    expect(viuPrevia).toBe(true);
    const { req, cab } = reqFalsa();
    const fn2 = vi.fn();
    await expect(acesso.escrever(authM(), req, api.pilotoId, { entidade: 'unidade', operacao: 'x', classe: 'credencial' }, fn2))
      .rejects.toMatchObject({ response: expect.objectContaining({ codigo: 'LIMITE_DIARIO_EXCEDIDO' }) });
    expect(fn2).not.toHaveBeenCalled();
    // Até a linha mais antiga sair da janela de 24 h: ~23 h.
    expect(Number(cab['Retry-After'])).toBeGreaterThan(22 * 3600);
    expect(Number(cab['Retry-After'])).toBeLessThanOrEqual(24 * 3600);
    expect((await previas()).length).toBe(CREDENCIAIS_DIA);
    expect((await previas()).at(-1)!.detalhes).toEqual({ entidade: 'unidade', operacao: 'x', registro_id: ids.nova, ip: '203.0.113.9' });
  });

  it('falha ao gravar a linha prévia: 503 e nada acontece', async () => {
    const fn = vi.fn();
    const espiao = vi.spyOn(api.plataforma.db, 'transaction').mockRejectedValueOnce(new Error('plataforma fora'));
    try {
      await expect(api.app.get(AcessoPlataformaService).escrever({ ...authM(), usuario: { ...authM().usuario, id: '00000000-0000-4000-8000-0000000000aa' } }, reqFalsa().req, api.pilotoId,
        { entidade: 'unidade', operacao: 'x', classe: 'credencial' }, fn)).rejects.toMatchObject({ response: expect.objectContaining({ codigo: 'TRILHA_INDISPONIVEL' }) });
    } finally { espiao.mockRestore(); }
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('varredura: sem PII nem texto digitado na trilha da plataforma e nos logs', () => {
  it('condominio.escrever só com as chaves previstas; logs sem e-mail do Master, bloco digitado nem nomes', async () => {
    const linhas = await api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'condominio.escrever'));
    expect(linhas.length).toBeGreaterThan(10);
    for (const l of linhas) expect(Object.keys(l.detalhes as object).sort()).toEqual(['entidade', 'ip', 'metodo', 'operacao', 'registro_id', 'rota', 'status']);
    const pessoas = await api.db.select({ nome: s.pessoa.nome, telefone: s.pessoa.telefone }).from(s.pessoa).limit(5);
    const texto = JSON.stringify(linhas) + saida.join('\n');
    for (const p of pessoas) {
      expect(texto).not.toContain(p.nome);
      if (p.telefone) expect(texto).not.toContain(p.telefone);
    }
    expect(saida.join('\n')).not.toContain(EMAIL);
    expect(texto).not.toContain('????'); // corpo inválido digitado
  });
});
