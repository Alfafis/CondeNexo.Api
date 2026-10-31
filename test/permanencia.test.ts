// Tempo de permanência (prazo por tipo de visita e prorrogação "+1h", spec §14 2026-10-23) pela API real (HTTP + PGlite +
// migrações). A tabela `permanencia` fica fora da cadeia de hash: o teste confere também que a cadeia segue íntegra.
// Relógio da API fixo (sábado 17/10/2026 09:00 BRT); o banco carimba ocorrido_em com o relógio real, depois dele.
import { and, count, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verificarCadeia } from '../src/dominio/hashChain';
import { MAX_PRORROGACOES } from '../src/dominio/rules';
import { paraExportacao } from '../src/db/cadeia';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
const MIN = 60_000;
const HORA = 60 * MIN;

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
  for (const nome of ['Ana Ribeiro', 'Paulo Ribeiro', 'Marcos Pereira', 'Bruno Teixeira', 'Juliana Costa', 'Rafael Mendes']) {
    ids[nome] = (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  }
  ids['D-32'] = (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32'))))[0]!.id;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const interfone = (pessoa: string, extra: object = {}) =>
  ({ pessoaId: ids[pessoa], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Ana Ribeiro'], ...extra });
const prorrogar = (papel: PapelTeste, entradaId: string) => post(papel, `/eventos-acesso/${entradaId}/permanencia/prorrogacoes`);
const linhas = (entradaId: string) => api.db.select().from(s.permanencia).where(eq(s.permanencia.eventoEntradaId, entradaId)).orderBy(s.permanencia.ordem);
const eventos = async () => Number((await api.db.select({ n: count() }).from(s.eventoAcesso))[0]!.n);

describe('prazo gravado na entrada (mesma transação do evento)', () => {
  let entregaId: string;

  it('visitante com tipo "entrega": 30 min a partir da hora gravada da entrada; a resposta já traz o prazo', async () => {
    const r = await post('porteiro', '/eventos-acesso', interfone('Marcos Pereira', { tipoVisita: 'entrega' }));
    expect(r.status).toBe(201);
    const ev = r.body.data;
    entregaId = ev.id;
    expect(ev.permanencia).toEqual({ tipoVisita: 'entrega', prazoAte: ev.ocorridoEm + 30 * MIN, prorrogacoes: 0 });
    const [l] = await linhas(ev.id);
    expect(l).toMatchObject({ ordem: 0, motivo: 'entrada', tipoVisita: 'entrega', definidoPorId: expect.any(String) });
    expect(l!.prazoAte.getTime()).toBe(ev.ocorridoEm + 30 * MIN);
  });

  it('sem tipo: visitante = visita (4 h), prestador = serviço (8 h); morador não tem prazo (tipo ignorado)', async () => {
    const vis = (await post('porteiro', '/eventos-acesso', interfone('Bruno Teixeira'))).body.data;
    expect(vis.permanencia).toEqual({ tipoVisita: 'visita', prazoAte: vis.ocorridoEm + 4 * HORA, prorrogacoes: 0 });
    const pre = (await post('porteiro', '/eventos-acesso', interfone('Juliana Costa'))).body.data;
    expect(pre.permanencia).toEqual({ tipoVisita: 'servico', prazoAte: pre.ocorridoEm + 8 * HORA, prorrogacoes: 0 });
    const mor = await post('porteiro', '/eventos-acesso', { pessoaId: ids['Paulo Ribeiro'], unidadeDestinoId: ids['D-32'], tipoVisita: 'entrega' });
    expect(mor.status).toBe(201);
    expect(mor.body.data).toMatchObject({ categoriaPessoa: 'morador', permanencia: null });
    expect(await linhas(mor.body.data.id)).toHaveLength(0);
    ids.morador = mor.body.data.id;
    ids.visita = vis.id;
  });

  it('tipo de visita inválido é 400', async () => {
    const r = await post('porteiro', '/eventos-acesso', interfone('Bruno Teixeira', { tipoVisita: 'mudanca' }));
    expect(r.status).toBe(400);
  });

  it('presentes devolve tipo, prazo e nº de prorrogações (nulo para quem não tem prazo)', async () => {
    const r = await get('porteiro', '/acessos/presentes?limite=50');
    expect(r.status).toBe(200);
    const porId = new Map<string, { permanencia: unknown }>(r.body.data.map((e: { id: string; permanencia: unknown }) => [e.id, e]));
    expect(porId.get(entregaId)!.permanencia).toMatchObject({ tipoVisita: 'entrega', prorrogacoes: 0 });
    expect(porId.get(ids.morador!)!.permanencia).toBeNull();
  });

  it('falha ao gravar o prazo desfaz o evento (nada de entrada sem prazo)', async () => {
    await api.client.exec(`CREATE FUNCTION falha_teste() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$;
      CREATE TRIGGER falha_teste BEFORE INSERT ON permanencia FOR EACH ROW EXECUTE FUNCTION falha_teste();`);
    try {
      const antes = await eventos();
      const r = await post('porteiro', '/eventos-acesso', interfone('Rafael Mendes'));
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await eventos()).toBe(antes);
    } finally {
      await api.client.exec('DROP TRIGGER falha_teste ON permanencia; DROP FUNCTION falha_teste();');
    }
  });

  describe('prorrogação "+1h"', () => {
    it('auditor 403; porteiro prorroga +1h a partir do prazo vigente, com trilha permanencia.prorrogar', async () => {
      expect((await prorrogar('auditor', entregaId)).status).toBe(403);
      const [l0] = await linhas(entregaId);
      const r = await prorrogar('porteiro', entregaId);
      expect(r.status).toBe(201);
      expect(r.body.data).toEqual({ eventoId: entregaId, tipoVisita: 'entrega', prazoAte: l0!.prazoAte.getTime() + HORA, prorrogacoes: 1 });
      const [a] = await api.db.select().from(s.auditLog).where(eq(s.auditLog.acao, 'permanencia.prorrogar')).orderBy(desc(s.auditLog.seq)).limit(1);
      expect(a).toMatchObject({ entidade: 'permanencia', usuarioPapel: 'porteiro' });
      expect((a!.depois as Record<string, unknown>).evento_entrada_id).toBe(entregaId);
      expect((a!.depois as Record<string, unknown>).ordem).toBe(1);
    });

    it(`limite de ${MAX_PRORROGACOES} prorrogações (422 PRORROGACAO_LIMITE)`, async () => {
      for (let i = 2; i <= MAX_PRORROGACOES; i++) expect((await prorrogar('porteiro', entregaId)).body.data.prorrogacoes).toBe(i);
      const r = await prorrogar('porteiro', entregaId);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PRORROGACAO_LIMITE');
      expect(await linhas(entregaId)).toHaveLength(MAX_PRORROGACOES + 1);
    });

    it('depois da saída: 422 PESSOA_JA_SAIU; sem prazo (morador): 422; entrada inexistente: 404', async () => {
      expect((await post('porteiro', `/eventos-acesso/${ids.visita}/saida`)).status).toBe(201);
      const r = await prorrogar('porteiro', ids.visita!);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PESSOA_JA_SAIU');
      expect((await prorrogar('porteiro', ids.morador!)).body.code).toBe('SEM_PRAZO_PERMANENCIA');
      expect((await prorrogar('porteiro', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });

    it('corpo com campo desconhecido é 400 (o "+1h" não tem parâmetro)', async () => {
      expect((await post('porteiro', `/eventos-acesso/${entregaId}/permanencia/prorrogacoes`, { minutos: 600 })).status).toBe(400);
    });
  });

  it('a cadeia de hash continua íntegra (a permanência não entra nela)', async () => {
    const todos = await api.db.select().from(s.eventoAcesso).orderBy(s.eventoAcesso.seq);
    expect(await verificarCadeia(todos.map(paraExportacao))).toMatchObject({ valido: true, verificados: todos.length });
  });
});
