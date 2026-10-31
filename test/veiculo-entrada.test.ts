// Veículo na ENTRADA (migração 0013, decisão do usuário de 2026-10-26) pela API real: placa, modelo e cor no próprio
// evento, formato de hash 2 só quando há placa (o resto continua formato 1), saída herdando o veículo da entrada,
// "mesmo veículo da última visita", busca pela placa de quem está dentro, CHECKs do banco, exportação do titular e a
// integridade (inclusive a adulteração da placa, feita como superusuário, sem o trigger append-only).
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lerExportacaoJsonl } from '../src/dominio/exportacao';
import { verificarCadeia } from '../src/dominio/hashChain';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste } from './helpers/app';
import { CHAVE_HMAC_TESTE, erroDe } from './helpers/banco';

const V1 = '/api/v1';
const JUST = 'Morador não atende o interfone, entrega urgente';

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const pessoaId = async (nome: string) => (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
let d32 = '';
let marcos = '';
let bruno = '';
let juliana = '';
const entrada = (pid: string, extra: object = {}) => post('porteiro', '/eventos-acesso', {
  pessoaId: pid, unidadeDestinoId: d32, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST, ...extra,
});
const totalEventos = async () => (await api.db.select({ id: s.eventoAcesso.id }).from(s.eventoAcesso)).length;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of ['sindico', 'administracao', 'porteiro', 'auditor'] as PapelTeste[]) cookies[p] = (await api.como(p)).cookie;
  [d32] = (await api.db.select({ id: s.unidade.id }).from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32')))).map((u) => u.id);
  [marcos, bruno, juliana] = await Promise.all(['Marcos Pereira', 'Bruno Teixeira', 'Juliana Costa'].map(pessoaId));
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

describe('POST /eventos-acesso com veículo', () => {
  let entradaMarcos = '';

  it('com veículo: placa normalizada (maiúsculas, sem hífen), modelo e cor aparados, formato de hash 2', async () => {
    const r = await entrada(marcos, { veiculo: { placa: 'abc-1d23', modelo: '  Onix ', cor: 'Prata' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      formatoHash: 2, veiculoPlaca: 'ABC1D23', veiculoModelo: 'Onix', veiculoCor: 'Prata',
      veiculo: { placa: 'ABC1D23', modelo: 'Onix', cor: 'Prata' },
    });
    entradaMarcos = r.body.data.id;
  });

  it('a pé (sem o campo, ou null): formato 1, veículo nulo; modelo/cor vazios viram nulo', async () => {
    const a = await entrada(bruno);
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ formatoHash: 1, veiculoPlaca: null, veiculoModelo: null, veiculoCor: null, veiculo: null });
    await post('porteiro', `/eventos-acesso/${a.body.data.id}/saida`);
    const b = await entrada(bruno, { veiculo: null });
    expect(b.body.data).toMatchObject({ formatoHash: 1, veiculo: null });
    await post('porteiro', `/eventos-acesso/${b.body.data.id}/saida`);
    const c = await entrada(bruno, { veiculo: { placa: 'XYZ1234', modelo: '  ', cor: '' } });
    expect(c.body.data).toMatchObject({ formatoHash: 2, veiculo: { placa: 'XYZ1234', modelo: null, cor: null } });
    await post('porteiro', `/eventos-acesso/${c.body.data.id}/saida`);
  });

  it('placa fora do padrão: 422 PLACA_INVALIDA e nada gravado; sem placa ou com campo estranho: 400', async () => {
    const antes = await totalEventos();
    for (const placa of ['AB12345', 'ABCD123', 'ABC12', 'ABC1D2345', '1234567', '']) {
      const r = await entrada(juliana, { veiculo: { placa } });
      expect([r.status, r.body.code], placa).toEqual([422, 'PLACA_INVALIDA']);
    }
    expect((await entrada(juliana, { veiculo: { modelo: 'Onix' } })).status).toBe(400);
    expect((await entrada(juliana, { veiculo: { placa: 'ABC1234', ano: 2020 } })).status).toBe(400);
    expect((await entrada(juliana, { veiculo: { placa: 'ABC1234', modelo: 'x'.repeat(61) } })).status).toBe(400);
    expect(await totalEventos()).toBe(antes);
  });

  it('recusa não aceita veículo (DTO estrito): 400', async () => {
    const r = await post('porteiro', '/eventos-acesso/recusas', {
      pessoaId: juliana, unidadeDestinoId: d32, meio: 'interfone', moradorPessoaId: juliana, veiculo: { placa: 'ABC1234' },
    });
    expect(r.status).toBe(400);
  });

  it('presentes e detalhe mostram o veículo; a saída herda o da entrada sem gravá-lo (formato 1)', async () => {
    const pres = (await get('porteiro', '/acessos/presentes')).body.data as { id: string; veiculo: unknown }[];
    expect(pres.find((e) => e.id === entradaMarcos)?.veiculo).toEqual({ placa: 'ABC1D23', modelo: 'Onix', cor: 'Prata' });
    const sai = await post('porteiro', `/eventos-acesso/${entradaMarcos}/saida`);
    expect(sai.status).toBe(201);
    expect(sai.body.data).toMatchObject({ formatoHash: 1, veiculoPlaca: null, veiculo: { placa: 'ABC1D23', modelo: 'Onix', cor: 'Prata' } });
    const det = (await get('auditor', `/eventos-acesso/${sai.body.data.id}`)).body.data;
    expect(det.veiculo).toEqual({ placa: 'ABC1D23', modelo: 'Onix', cor: 'Prata' });
    const ent = (await get('auditor', `/eventos-acesso/${entradaMarcos}`)).body.data;
    expect(ent).toMatchObject({ dentro: false, veiculo: { placa: 'ABC1D23' } });
  });
});

describe('GET /acessos/ultimo-veiculo', () => {
  it('devolve o veículo da última entrada COM veículo (entrada a pé depois não apaga a sugestão)', async () => {
    const r = await get('porteiro', `/acessos/ultimo-veiculo?pessoaId=${bruno}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ veiculo: { placa: 'XYZ1234', modelo: null, cor: null } });
    expect((await get('porteiro', `/acessos/ultimo-veiculo?pessoaId=${juliana}`)).body.data).toEqual({ veiculo: null });
  });

  it('só quem registra entrada (auditor: 403); pessoa inexistente: 404', async () => {
    expect((await get('auditor', `/acessos/ultimo-veiculo?pessoaId=${bruno}`)).status).toBe(403);
    expect((await get('porteiro', '/acessos/ultimo-veiculo?pessoaId=00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('busca pela placa de quem está dentro (RF-34)', () => {
  it('acha o visitante presente pela placa (parcial) e para de achar depois da saída', async () => {
    const e = await entrada(juliana, { veiculo: { placa: 'QRS4T56', modelo: 'Moto', cor: 'Vermelha' } });
    expect(e.status).toBe(201);
    const nomes = async (q: string) => ((await post('porteiro', '/pessoas/busca', { q })).body.data.pessoas as { nome: string }[]).map((p) => p.nome);
    expect(await nomes('qrs-4t5')).toContain('Juliana Costa');
    const topo = (await post('porteiro', '/busca', { q: 'QRS4T56' })).body.data as { pessoas: { nome: string }[] };
    expect(topo.pessoas.map((p) => p.nome)).toContain('Juliana Costa');
    await post('porteiro', `/eventos-acesso/${e.body.data.id}/saida`);
    expect(await nomes('QRS4T56')).not.toContain('Juliana Costa');
  });
});

describe('exportação do titular', () => {
  it('as entradas da pessoa trazem o veículo (placa com hífen); as a pé, null', async () => {
    const c = JSON.parse((await get('administracao', `/lgpd/pessoas/${bruno}/exportacao`)).body.data.conteudo) as { eventos: { tipo: string; veiculo: unknown }[] };
    const entradas = c.eventos.filter((e) => e.tipo === 'entrada');
    expect(entradas.map((e) => e.veiculo)).toEqual(expect.arrayContaining([null, { placa: 'XYZ-1234', modelo: null, cor: null }]));
  });
});

describe('CHECKs do banco (0013)', () => {
  const base = async () => ({
    tipo: 'entrada' as const, categoriaPessoa: 'visitante' as const, pessoaId: bruno, unidadeDestinoId: d32,
    pontoAcessoId: (await api.db.select().from(s.pontoAcesso))[0]!.id, autorizadoPorTipo: 'excecao_porteiro' as const, justificativa: JUST,
    operadorId: (await api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.papel, 'porteiro')))[0]!.id, operadorPapel: 'porteiro' as const,
  });

  it('placa fora de ^[A-Z0-9]{7}$, modelo/cor sem placa, veículo fora da entrada: recusados', async () => {
    const b = await base();
    expect(await erroDe(api.db.insert(s.eventoAcesso).values({ ...b, veiculoPlaca: 'abc1234' }))).toMatch(/evento_veiculo_placa_ck/);
    expect(await erroDe(api.db.insert(s.eventoAcesso).values({ ...b, veiculoPlaca: 'ABC-123' }))).toMatch(/evento_veiculo_placa_ck/);
    expect(await erroDe(api.db.insert(s.eventoAcesso).values({ ...b, veiculoModelo: 'Onix' }))).toMatch(/evento_veiculo_detalhe_ck/);
    expect(await erroDe(api.db.insert(s.eventoAcesso).values({ ...b, veiculoPlaca: 'ABC1234', veiculoCor: '  ' }))).toMatch(/evento_veiculo_detalhe_ck/);
    expect(await erroDe(api.db.insert(s.eventoAcesso).values({ ...b, tipo: 'recusado', autorizadoPorTipo: 'interfone',
      autorizadoPorPessoaId: bruno, justificativa: null, veiculoPlaca: 'ABC1234' }))).toMatch(/evento_veiculo_so_entrada_ck/);
  });
});

describe('filtro por placa no histórico (POST /eventos-acesso/busca)', () => {
  const busca = async (corpo: object) => (await post('auditor', '/eventos-acesso/busca', { limite: 100, ...corpo })).body.data as { id: string; tipo: string; refereEventoId?: string }[];

  it('acha a entrada de visitante que já saiu, por parte da placa, e a saída correspondente; ignora placa curta', async () => {
    const e = await entrada(juliana, { veiculo: { placa: 'klm-8n90' } });
    const entId = e.body.data.id as string;
    const sd = await post('porteiro', `/eventos-acesso/${entId}/saida`);
    const outra = await entrada(bruno, { veiculo: { placa: 'ZZZ9Z99' } });
    for (const q of ['klm-8n', '8N90', ' KLM8N90 ']) {
      const ids = (await busca({ placa: q })).map((x) => x.id);
      expect(ids.sort(), q).toEqual([entId, sd.body.data.id].sort());
    }
    expect((await busca({ placa: 'klm8n' })).map((x) => x.id)).not.toContain(outra.body.data.id);
    // "AB" (curta) não filtra: volta a trilha toda, inclusive a entrada de outra placa
    expect((await busca({ placa: 'AB' })).map((x) => x.id)).toContain(outra.body.data.id);
    // combina com os demais filtros
    expect(await busca({ placa: 'KLM8N90', tipo: 'saida' })).toHaveLength(1);
  });

  it('placa não existe na query string: GET ignora/recusa o parâmetro e a exportação aceita o filtro no corpo', async () => {
    expect((await get('auditor', '/eventos-acesso?placa=KLM8N90')).status).toBe(400);
    const p = (await post('auditor', '/auditoria/exportacoes', { placa: 'KLM8N90' })).body.data;
    expect(lerExportacaoJsonl(p.conteudo).eventos.length).toBe(2);
  });
});

describe('integridade com eventos de formato 1 e 2', () => {
  it('a verificação no banco e a exportação JSONL (manifesto v3) conferem a cadeia mista', async () => {
    const r = await get('auditor', '/auditoria/integridade');
    expect(r.body.data).toMatchObject({ valido: true });
    const p = (await post('auditor', '/auditoria/exportacoes', {})).body.data;
    const { manifesto, eventos } = lerExportacaoJsonl(p.conteudo);
    expect(new Set(eventos.map((e) => e.v))).toEqual(new Set([1, 2]));
    // A linha v1 não ganhou as chaves de veículo (igual à de antes da 0013); a v2 as tem
    expect(eventos.find((e) => e.v === 1)).not.toHaveProperty('veiculo_placa');
    expect(eventos.find((e) => e.v === 2)).toMatchObject({ veiculo_placa: expect.stringMatching(/^[A-Z0-9]{7}$/) });
    expect(await verificarCadeia(eventos, manifesto.ancora)).toMatchObject({ valido: true, verificados: eventos.length });
  });

  it('adulterar a placa, ou rebaixar o evento para o formato 1 sem veículo, aparece como hash_divergente', async () => {
    const [v2] = await api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.formatoHash, 2)).limit(1);
    const semTrigger = (sql: string) => api.client.exec(
      `ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel; ${sql}; ALTER TABLE evento_acesso ENABLE TRIGGER evento_acesso_imutavel;`);
    await semTrigger(`UPDATE evento_acesso SET veiculo_placa = 'ZZZ9Z99' WHERE id = '${v2!.id}'`);
    expect((await get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: false, motivo: 'hash_divergente', primeiroSeqInvalido: v2!.seq });
    await semTrigger(`UPDATE evento_acesso SET formato_hash = 1, veiculo_placa = NULL, veiculo_modelo = NULL, veiculo_cor = NULL WHERE id = '${v2!.id}'`);
    expect((await get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: false, motivo: 'hash_divergente', primeiroSeqInvalido: v2!.seq });
  });
});
