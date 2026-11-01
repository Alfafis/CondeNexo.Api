// "Revelar" do app do Master (Fase B, 2026-11-01): POST /plataforma/condominios/:id/<entidade>/:registroId/revelar devolve
// o valor completo dos campos que a leitura minimiza, UM registro por vez. Uma linha `condominio.revelar` em
// plataforma_audit (sem valor), NADA no audit_log do condomínio, 503 sem valor se a trilha falha, 429 com Retry-After
// acima do limite (sem ler nem gravar), só `master`, mesma regra de situação da leitura. E o stub de compatibilidade de
// POST .../motivo (removido na Fase C1: 404). Varredura: nenhum valor revelado nas trilhas nem nos logs.
import { hash } from '@node-rs/argon2';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { nomeCookieMaster } from '../src/plataforma/cookie-master';
import { criarUsuario } from '../src/plataforma/usuario-plataforma';
import { condominio, masterUsuario, plataformaAudit } from '../src/plataforma/schema-plataforma';
import { ResolvedorCondominio } from '../src/tenancy/resolvedor';
import { semearDadosE2e, USUARIOS_E2E } from './e2e/dados';
import { type ApiDeTeste, configDeTeste, novaApi, novoIp } from './helpers/app';
import { CHAVE_HMAC_TESTE, SENHA_FALSA } from './helpers/banco';
import { DEMO } from './helpers/saas';

const P = '/api/v1/plataforma';
const SENHA_M = 'senha-do-master-bem-longa-1';
const EMAIL = 'master.revelar@exemplo.test';
/** Baixo de propósito, para o 429 sem 60 requisições. */
const LIMITE = 6;

let api: ApiDeTeste;
let master: string;
let masterId: string;
let suporte: string;
const saida: string[] = [];
const ids: Record<string, string> = {};
const claro: Record<string, string> = {};

async function novoMaster(email: string, papel: 'master' | 'suporte') {
  const c = await criarUsuario(api.plataforma.db, {
    hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
  }, { email, nome: `Operador ${papel}`, papel });
  await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
  const r = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', novoIp()).send({ email, senha: SENHA_M });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { cookie: (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!.split(';')[0]!, id: c.id };
}

const revelar = (entidade: string, id: string, cookie = master, cond = api.pilotoId) =>
  api.http().post(`${P}/condominios/${cond}/${entidade}/${id}/revelar`).set('Cookie', cookie).send({});
const trilhaP = () => api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'condominio.revelar')).orderBy(plataformaAudit.seq);
const contagemCondominio = async () => [(await api.db.select().from(s.auditLog)).length, (await api.demo!.db.select().from(s.auditLog)).length];
/** Abre uma janela nova do limite (fixa, de 60 s). */
const novaJanela = () => api.relogio.avancarMin(2);

beforeAll(async () => {
  for (const f of ['log', 'error', 'warn'] as const) vi.spyOn(console, f).mockImplementation((...a: unknown[]) => { saida.push(a.map(String).join(' ')); });
  api = await novaApi({ plataforma: { ...configDeTeste().plataforma, revelarPorMinuto: LIMITE } }, { demo: true });
  api.relogio.atual = new Date();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  await seedPessoasDev(api.demo!.db, { chaveHmac: DEMO.hmac, agora: api.relogio.agora() });
  await api.db.insert(s.usuarioSistema).values(USUARIOS_E2E.map((u) => ({ ...u, senhaHash: SENHA_FALSA, deveTrocarSenha: false })));
  await semearDadosE2e(api.app);
  const um = async <T>(q: Promise<T[]>) => (await q)[0]!;
  const ana = await um(api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro')));
  ids.pessoa = ana.id;
  claro.nome = ana.nome;
  claro.telefone = ana.telefone!;
  const v = await um(api.db.select().from(s.veiculo).where(eq(s.veiculo.placa, 'FKR2C41')));
  ids.veiculo = v.id;
  claro.placa = v.placa;
  const o = await um(api.db.select().from(s.ocorrencia).where(and(ne(s.ocorrencia.descricao, ''), ne(s.ocorrencia.status, 'encerrada'))).limit(1));
  ids.ocorrencia = o.id;
  claro.descricao = o.descricao;
  const e = await um(api.db.select().from(s.encomenda).limit(1));
  ids.encomenda = e.id;
  claro.destinatario = e.destinatario;
  ({ cookie: master, id: masterId } = await novoMaster(EMAIL, 'master'));
  suporte = (await novoMaster('suporte.revelar@exemplo.test', 'suporte')).cookie;
}, 120_000);

afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });
beforeEach(() => novaJanela());

describe('valor completo, um registro por vez', () => {
  it('pessoa: nome e telefone completos, a máscara do CPF (não armazenado), sem HMAC', async () => {
    const r = await revelar('pessoas', ids.pessoa!);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(['desativacaoMotivo', 'documentoMascarado', 'id', 'nome', 'telefone']);
    expect(r.body.data).toMatchObject({ id: ids.pessoa, nome: claro.nome, telefone: claro.telefone });
    expect(r.body.data.documentoMascarado).toMatch(/\*/);
    expect(JSON.stringify(r.body)).not.toMatch(/documentoBusca|documento_busca|[0-9a-f]{64}/);
    // A leitura continua mascarada (o Revelar não muda a lista nem a ficha).
    const ficha = await api.http().get(`${P}/condominios/${api.pilotoId}/pessoas/${ids.pessoa}`).set('Cookie', master);
    expect(ficha.body.data.pessoa.nome).toBe('Ana R******');
    expect(JSON.stringify(ficha.body)).not.toContain(claro.telefone);
  });

  it('veículo, ocorrência e encomenda: só os campos escondidos', async () => {
    const v = await revelar('veiculos', ids.veiculo!);
    expect(v.body.data).toEqual({ id: ids.veiculo, placa: claro.placa });
    const o = await revelar('ocorrencias', ids.ocorrencia!);
    expect(Object.keys(o.body.data).sort()).toEqual(['descricao', 'envolvidos', 'id']);
    expect(o.body.data.descricao).toBe(claro.descricao);
    const e = await revelar('encomendas', ids.encomenda!);
    expect(Object.keys(e.body.data).sort()).toEqual(['destinatario', 'id', 'retiradaPorNome']);
    expect(e.body.data.destinatario).toBe(claro.destinatario);
  });

  it('o demo responde com o dado do demo; id de outro condomínio é 404', async () => {
    const [anaDemo] = await api.demo!.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro'));
    expect((await revelar('pessoas', anaDemo!.id, master, api.demo!.id)).body.data.id).toBe(anaDemo!.id);
    if (anaDemo!.id !== ids.pessoa) expect((await revelar('pessoas', ids.pessoa!, master, api.demo!.id)).status).toBe(404);
  });
});

describe('trilha: uma linha condominio.revelar, sem valor; nada no audit_log do condomínio', () => {
  it('uma linha por revelação, com entidade, id do registro, rota, status e IP; nunca o valor', async () => {
    const antesC = await contagemCondominio();
    const antesP = (await trilhaP()).length;
    for (const [ent, id] of [['pessoas', ids.pessoa], ['veiculos', ids.veiculo], ['ocorrencias', ids.ocorrencia], ['encomendas', ids.encomenda]] as const) {
      expect((await revelar(ent, id!)).status).toBe(200);
    }
    const novas = (await trilhaP()).slice(antesP);
    expect(novas.map((l) => [l.acao, l.condominioId, l.masterUsuarioId])).toEqual(Array(4).fill(['condominio.revelar', api.pilotoId, masterId]));
    expect(novas.map((l) => l.detalhes)).toEqual([
      { entidade: 'pessoa', registro_id: ids.pessoa, rota: '/pessoas/:pessoaId/revelar', metodo: 'POST', status: 200, ip: expect.any(String) },
      { entidade: 'veiculo', registro_id: ids.veiculo, rota: '/veiculos/:veiculoId/revelar', metodo: 'POST', status: 200, ip: expect.any(String) },
      { entidade: 'ocorrencia', registro_id: ids.ocorrencia, rota: '/ocorrencias/:ocorrenciaId/revelar', metodo: 'POST', status: 200, ip: expect.any(String) },
      { entidade: 'encomenda', registro_id: ids.encomenda, rota: '/encomendas/:encomendaId/revelar', metodo: 'POST', status: 200, ip: expect.any(String) },
    ]);
    // O síndico não vê: nada no audit_log de nenhum condomínio.
    expect(await contagemCondominio()).toEqual(antesC);
  });

  it('registro inexistente: 404 e a tentativa fica na trilha com o status', async () => {
    const outro = '00000000-0000-4000-8000-000000000321';
    const r = await revelar('pessoas', outro);
    expect([r.status, r.body.code]).toEqual([404, 'PESSOA_NAO_ENCONTRADA']);
    const [l] = (await trilhaP()).slice(-1);
    expect(l!.detalhes).toMatchObject({ entidade: 'pessoa', registro_id: outro, status: 404 });
  });

  it('falhou a gravação: 503 TRILHA_INDISPONIVEL e o valor não sai', async () => {
    const espiao = vi.spyOn(api.plataforma.db, 'insert').mockImplementationOnce(() => { throw new Error('plataforma fora'); });
    const r = await revelar('pessoas', ids.pessoa!);
    espiao.mockRestore();
    expect([r.status, r.body.code]).toEqual([503, 'TRILHA_INDISPONIVEL']);
    expect(r.body.data).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(claro.telefone!);
    expect(JSON.stringify(r.body)).not.toContain(claro.nome!);
  });
});

describe('limite por usuário (PLATAFORMA_REVELAR_POR_MINUTO)', () => {
  it(`${LIMITE} passam; a seguinte: 429 REVELACOES_EXCEDIDAS com Retry-After, sem ler nem gravar; janela nova volta a passar`, async () => {
    for (let i = 0; i < LIMITE; i++) expect((await revelar('veiculos', ids.veiculo!)).status).toBe(200);
    const antes = (await trilhaP()).length;
    const r = await revelar('pessoas', ids.pessoa!);
    expect([r.status, r.body.code]).toEqual([429, 'REVELACOES_EXCEDIDAS']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(r.body.data).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(claro.telefone!);
    expect((await trilhaP()).length).toBe(antes);
    // Condomínio inexistente também é barrado pelo limite antes de qualquer coisa.
    expect((await revelar('pessoas', ids.pessoa!, master, '00000000-0000-4000-8000-000000000999')).status).toBe(429);
    novaJanela();
    expect((await revelar('pessoas', ids.pessoa!)).status).toBe(200);
  });
});

describe('quem revela e onde', () => {
  it('suporte 403 (guarda); sem sessão 401; sessão de condomínio não abre', async () => {
    const antes = (await trilhaP()).length;
    const r = await revelar('pessoas', ids.pessoa!, suporte);
    expect([r.status, r.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    expect(r.body.data).toBeUndefined();
    expect((await api.http().post(`${P}/condominios/${api.pilotoId}/pessoas/${ids.pessoa}/revelar`).send({})).status).toBe(401);
    const sindico = (await api.como('sindico')).cookie;
    expect((await revelar('pessoas', ids.pessoa!, sindico)).status).toBe(401);
    expect((await trilhaP()).length).toBe(antes);
  });

  it('situação: desconhecido 404; provisionando 409; suspenso e encerrado revelam; excluído 404', async () => {
    expect((await revelar('pessoas', ids.pessoa!, master, '00000000-0000-4000-8000-000000000999')).status).toBe(404);
    const [anaDemo] = await api.demo!.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro'));
    const resolvedor = api.app.get(ResolvedorCondominio);
    const status = async (st: 'provisionando' | 'ativo' | 'suspenso' | 'encerrado' | 'excluido') => {
      await api.plataforma.db.update(condominio).set({ status: st, encerradoEm: ['encerrado', 'excluido'].includes(st) ? new Date() : null }).where(eq(condominio.id, api.demo!.id));
      resolvedor.invalidar();
    };
    const rv = () => revelar('pessoas', anaDemo!.id, master, api.demo!.id);
    try {
      await status('provisionando');
      expect((await rv()).body.code).toBe('CONDOMINIO_PROVISIONANDO');
      await status('suspenso');
      expect((await rv()).status).toBe(200);
      await status('encerrado');
      expect((await rv()).status).toBe(200);
      await status('excluido');
      expect((await rv()).status).toBe(404);
    } finally {
      await status('ativo');
    }
  });

  it('GET na rota do Revelar não existe (é POST)', async () => {
    expect((await api.http().get(`${P}/condominios/${api.pilotoId}/pessoas/${ids.pessoa}/revelar`).set('Cookie', master)).status).toBe(404);
  });
});

describe('POST .../motivo (stub da Fase B) saiu na Fase C1', () => {
  it('404 para master e nada gravado no audit_log do condomínio', async () => {
    const antesC = await contagemCondominio();
    const r = await api.http().post(`${P}/condominios/${api.pilotoId}/motivo`).set('Cookie', master).send({ categoria: 'suporte', texto: 'Chamado 9182: síndico pediu conferência' });
    expect(r.status).toBe(404);
    expect(await contagemCondominio()).toEqual(antesC);
  });
});

describe('varredura: nenhum valor revelado nas trilhas nem nos logs', () => {
  it('plataforma_audit, audit_log e a saída do processo sem telefone, nome completo, placa ou texto livre', async () => {
    const valores = [claro.telefone!, claro.nome!, claro.placa!, claro.descricao!, claro.destinatario!].filter((v) => v.length >= 5);
    const p = JSON.stringify(await api.plataforma.db.select().from(plataformaAudit));
    const c = JSON.stringify(await api.db.select().from(s.auditLog).where(eq(s.auditLog.usuarioNome, `plataforma/${EMAIL}`)));
    const logs = saida.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const v of valores) {
      expect(p, v).not.toContain(v);
      expect(c, v).not.toContain(v);
      expect(logs, v).not.toContain(v);
    }
  });
});
