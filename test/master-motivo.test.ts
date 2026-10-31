// Motivo obrigatório na leitura do Master (spec 2026-10-31, Fase B): POST /plataforma/condominios/:id/motivo emite um
// token assinado (30 min, esta sessão, este condomínio) que toda leitura exige em X-Motivo-Token. Sem ele (ou vencido, de
// outra sessão, de outro condomínio, adulterado): 403 MOTIVO_NECESSARIO, a mesma mensagem, e nada é lido nem gravado.
// O texto do motivo vai para o audit_log do condomínio e NUNCA para plataforma_audit (só a categoria).
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { nomeCookieMaster } from '../src/plataforma/cookie-master';
import { MotivoLeituraService } from '../src/plataforma/motivo-leitura';
import { criarUsuario } from '../src/plataforma/usuario-plataforma';
import { masterUsuario, plataformaAudit } from '../src/plataforma/schema-plataforma';
import { type ApiDeTeste, novaApi, novoIp } from './helpers/app';

const P = '/api/v1/plataforma';
const SENHA_M = 'senha-do-master-bem-longa-1';
const EMAIL = 'master.motivo@exemplo.test';
/** Texto distinto, procurado em toda a plataforma_audit e nos logs. */
const TEXTO = 'Chamado 9182: síndico pediu conferência das unidades';

let api: ApiDeTeste;
let master: string;
let masterId: string;
let suporte: string;
const saida: string[] = [];

async function entrar(email: string) {
  const r = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', novoIp()).send({ email, senha: SENHA_M });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!.split(';')[0]!;
}
async function novoMaster(email: string, papel: 'master' | 'suporte') {
  const c = await criarUsuario(api.plataforma.db, {
    hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
  }, { email, nome: `Operador ${papel}`, papel });
  await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
  return { cookie: await entrar(email), id: c.id };
}

const emitir = (corpo: object, cookie = master, cond = api.pilotoId) => api.http().post(`${P}/condominios/${cond}/motivo`).set('Cookie', cookie).send(corpo);
const token = async (cookie = master, cond = api.pilotoId, texto = TEXTO) => {
  const r = await emitir({ categoria: 'incidente', texto }, cookie, cond);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data.token as string;
};
const ler = (t: string | null, cookie = master, cond = api.pilotoId, rota = '/unidades') => {
  const r = api.http().get(`${P}/condominios/${cond}${rota}`).set('Cookie', cookie);
  return t === null ? r : r.set('X-Motivo-Token', t);
};
const trilhaP = () => api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.masterUsuarioId, masterId)).orderBy(plataformaAudit.seq);
const trilhaC = () => api.db.select().from(s.auditLog).where(eq(s.auditLog.usuarioNome, `plataforma/${EMAIL}`)).orderBy(s.auditLog.seq);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { saida.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { saida.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { saida.push(a.map(String).join(' ')); });
  api = await novaApi({}, { demo: true });
  ({ cookie: master, id: masterId } = await novoMaster(EMAIL, 'master'));
  suporte = (await novoMaster('suporte.motivo@exemplo.test', 'suporte')).cookie;
}, 120_000);

afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

describe('emissão do motivo', () => {
  it('200 com { token, expiraEm } (agora + 30 min), Cache-Control no-store e uma linha condominio.motivo só com a categoria', async () => {
    const antes = (await trilhaP()).length;
    const r = await emitir({ categoria: 'obrigacao_legal', texto: `   ${TEXTO}   ` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Object.keys(r.body.data).sort()).toEqual(['expiraEm', 'token']);
    expect(r.body.data.token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(new Date(r.body.data.expiraEm).getTime()).toBe(api.relogio.agora().getTime() + 30 * 60_000);
    const novas = (await trilhaP()).slice(antes);
    expect(novas.map((l) => [l.acao, l.condominioId])).toEqual([['condominio.motivo', api.pilotoId]]);
    expect(novas[0]!.detalhes).toMatchObject({ categoria: 'obrigacao_legal', rota: '/motivo', metodo: 'POST' });
    expect(JSON.stringify(novas[0]!.detalhes)).not.toContain('9182');
  });

  it.each([
    ['categoria inválida', { categoria: 'curiosidade', texto: TEXTO }],
    ['sem categoria', { texto: TEXTO }],
    ['texto curto (depois do trim)', { categoria: 'suporte', texto: '   curto demais   ' }],
    ['texto com 501 caracteres', { categoria: 'suporte', texto: 'x'.repeat(501) }],
    ['texto não é string', { categoria: 'suporte', texto: 123456789012345 }],
    ['campo desconhecido', { categoria: 'suporte', texto: TEXTO, sessaoId: 'x' }],
  ])('%s: 400 DADOS_INVALIDOS e nenhuma linha', async (_, corpo) => {
    const antes = (await trilhaP()).length;
    const r = await emitir(corpo);
    expect([r.status, r.body.code]).toEqual([400, 'DADOS_INVALIDOS']);
    expect(r.body.data).toBeUndefined();
    expect((await trilhaP()).length).toBe(antes);
  });

  it('texto de exatamente 500 caracteres passa', async () => {
    expect((await emitir({ categoria: 'operacao', texto: 'y'.repeat(500) })).status).toBe(200);
  });

  it('suporte não emite (403 SEM_PERMISSAO da guarda); sem sessão 401', async () => {
    const r = await emitir({ categoria: 'suporte', texto: TEXTO }, suporte);
    expect([r.status, r.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    expect(r.body.data).toBeUndefined();
    expect((await api.http().post(`${P}/condominios/${api.pilotoId}/motivo`).send({ categoria: 'suporte', texto: TEXTO })).status).toBe(401);
  });

  it('falha na plataforma_audit: 503 TRILHA_INDISPONIVEL e o token não sai', async () => {
    const espiao = vi.spyOn(api.plataforma.db, 'insert').mockImplementationOnce(() => { throw new Error('plataforma fora'); });
    const r = await emitir({ categoria: 'suporte', texto: TEXTO });
    espiao.mockRestore();
    expect([r.status, r.body.code]).toEqual([503, 'TRILHA_INDISPONIVEL']);
    expect(JSON.stringify(r.body)).not.toMatch(/v1\./);
  });
});

describe('leitura exige o motivo vigente: 403 MOTIVO_NECESSARIO, mensagem única, nada lido nem gravado', () => {
  const recusada = async (r: import('supertest').Response, rotulo: string) => {
    expect([r.status, r.body.code], `${rotulo} ${JSON.stringify(r.body)}`).toEqual([403, 'MOTIVO_NECESSARIO']);
    expect(r.body.data).toBeUndefined();
    return r.body.message as string;
  };

  it('com token válido: 200', async () => {
    expect((await ler(await token())).status).toBe(200);
  });

  it('sem token, vazio, lixo, versão desconhecida, adulterado, vencido, de outro condomínio, de outra sessão: a mesma recusa', async () => {
    const t = await token();
    const [versao, payload, assinatura] = t.split('.') as [string, string, string];
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const comPayload = (mudar: Record<string, unknown>) => `${versao}.${Buffer.from(JSON.stringify({ ...p, ...mudar })).toString('base64url')}.${assinatura}`;
    const outraAssinatura = `${versao}.${payload}.${assinatura.slice(0, -2)}${assinatura.endsWith('AA') ? 'BB' : 'AA'}`;

    const outraSessao = await entrar(EMAIL); // o mesmo Master, outra sessão
    const doDemo = await token(master, api.demo!.id);

    const antesC = (await trilhaC()).length;
    const antesP = (await trilhaP()).length;
    const mensagens = new Set<string>();
    const casos: [string, import('supertest').Test][] = [
      ['sem token', ler(null)],
      ['vazio', ler('')],
      ['lixo', ler('abc')],
      ['versão v2', ler(t.replace(/^v1\./, 'v2.'))],
      ['payload trocado (outra categoria)', ler(comPayload({ categoria: 'suporte' }))],
      ['payload trocado (prazo maior)', ler(comPayload({ expiraEm: Date.now() + 86_400_000 * 365 }))],
      ['payload trocado (outro condomínio)', ler(comPayload({ condominioId: api.demo!.id }), master, api.demo!.id)],
      ['assinatura trocada', ler(outraAssinatura)],
      ['assinatura de outra mensagem', ler(`${versao}.${payload}.${doDemo.split('.')[2]}`)],
      ['token de outro condomínio', ler(doDemo)],
      ['token do piloto na rota do demo', ler(t, master, api.demo!.id)],
      ['token de outra sessão', ler(t, outraSessao)],
    ];
    for (const [rotulo, req] of casos) mensagens.add(await recusada(await req, rotulo));
    expect(mensagens.size).toBe(1);

    // Vencido (30 min): ainda vale aos 29, não aos 30.
    api.relogio.avancarMin(29);
    expect((await ler(t)).status).toBe(200);
    const antesVenc = [(await trilhaC()).length, (await trilhaP()).length];
    api.relogio.avancarMin(1);
    mensagens.add(await recusada(await ler(t), 'vencido'));
    expect(mensagens.size).toBe(1);
    expect([(await trilhaC()).length, (await trilhaP()).length]).toEqual(antesVenc);
    // Fora a leitura válida dos 29 min, nenhuma recusa gravou linha em nenhuma das duas trilhas.
    expect((await trilhaC()).length).toBe(antesC + 1);
    expect((await trilhaP()).length).toBe(antesP + 1);
  });

  it('logout: o cookie antigo dá 401 e o token dele não vale numa sessão nova', async () => {
    const sessao = await entrar(EMAIL);
    const t = await token(sessao);
    expect((await ler(t, sessao)).status).toBe(200);
    expect((await api.http().post(`${P}/auth/logout`).set('Cookie', sessao)).status).toBe(204);
    expect((await ler(t, sessao)).status).toBe(401);
    const nova = await entrar(EMAIL);
    expect((await ler(t, nova)).body.code).toBe('MOTIVO_NECESSARIO');
  });

  it('a recusa vale também para exportação (anexo/CSV): mesmo ponto único', async () => {
    expect((await ler(null, master, api.pilotoId, '/relatorios/resumo/csv')).body.code).toBe('MOTIVO_NECESSARIO');
    expect((await ler(await token(), master, api.pilotoId, '/relatorios/resumo/csv')).status).toBe(200);
  });

  it('suporte com um token de master continua barrado pela guarda (403 SEM_PERMISSAO)', async () => {
    expect((await ler(await token(), suporte)).body.code).toBe('SEM_PERMISSAO');
  });
});

describe('trilhas: o texto no audit_log do condomínio, só a categoria na plataforma_audit', () => {
  it('leitura e exportação levam o motivo; o texto nunca aparece em plataforma_audit nem nos logs', async () => {
    const antesC = (await trilhaC()).length;
    const antesP = (await trilhaP()).length;
    const t = await token();
    expect((await ler(t)).status).toBe(200);
    expect((await ler(t, master, api.pilotoId, '/relatorios/resumo/csv')).status).toBe(200);

    const novasC = (await trilhaC()).slice(antesC);
    expect(novasC.map((l) => l.acao)).toEqual(['plataforma.ler', 'plataforma.exportar']);
    for (const l of novasC) expect((l.depois as { motivo: unknown }).motivo).toEqual({ categoria: 'incidente', texto: TEXTO });

    const novasP = (await trilhaP()).slice(antesP);
    expect(novasP.map((l) => l.acao)).toEqual(['condominio.motivo', 'condominio.ler', 'condominio.exportar']);
    for (const l of novasP) expect((l.detalhes as { categoria: string }).categoria).toBe('incidente');

    // Em TODA a plataforma_audit (de todos os testes deste arquivo), nem o texto nem um pedaço dele.
    const todas = JSON.stringify((await api.plataforma.db.select().from(plataformaAudit)).map((l) => l.detalhes));
    for (const trecho of [TEXTO, '9182', 'conferência', 'curto demais', 'y'.repeat(50)]) expect(todas).not.toContain(trecho);
    // Nem o texto nem o token nos logs (o log é por allowlist: corpo e cabeçalho não entram).
    const logs = saida.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain('9182');
    expect(logs).not.toContain(t.split('.')[2]!);
  });

  it('falha no audit_log do condomínio: 503 e nada sai (como antes)', async () => {
    const t = await token();
    const { AuditoriaService } = await import('../src/auditoria/auditoria.service');
    const espiao = vi.spyOn(api.app.get(AuditoriaService), 'registrarPlataforma').mockRejectedValueOnce(Object.assign(new Error('x'), { code: '53100' }));
    const r = await ler(t);
    espiao.mockRestore();
    expect([r.status, r.body.code]).toEqual([503, 'TRILHA_INDISPONIVEL']);
    expect(r.body.data).toBeUndefined();
  });
});

describe('MotivoLeituraService (sem banco)', () => {
  const relogio = { agora: () => new Date('2026-10-31T12:00:00.000Z') };
  const sessao = '11111111-1111-4111-8111-111111111111';
  const cond = '22222222-2222-4222-8222-222222222222';
  const svc = (chave = randomBytes(32)) => new MotivoLeituraService({ chave, versao: 1 }, relogio);

  it('outra chave mestra (rotação) invalida o token; a mesma valida; id em maiúsculas é o mesmo condomínio', () => {
    const chave = randomBytes(32);
    const { token: t } = svc(chave).emitir(sessao, cond, { categoria: 'operacao', texto: TEXTO });
    expect(svc(chave).validar(t, sessao, cond)).toEqual({ categoria: 'operacao', texto: TEXTO });
    expect(svc(chave).validar(t, sessao, cond.toUpperCase())).toEqual({ categoria: 'operacao', texto: TEXTO });
    expect(svc().validar(t, sessao, cond)).toBeNull();
  });

  it('não string, lista (cabeçalho repetido) e grande demais: null', () => {
    const s1 = svc();
    const { token: t } = s1.emitir(sessao, cond, { categoria: 'operacao', texto: TEXTO });
    for (const v of [undefined, null, 42, [t, t], `${t}${'a'.repeat(5000)}`, `${t}.x`]) expect(s1.validar(v, sessao, cond)).toBeNull();
  });
});
