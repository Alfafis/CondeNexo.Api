// Registro de acesso (RF-12, RF-13, RF-16, RF-17, RF-35, RN-01, RN-04, RN-07, RN-11, UC02 A4), autorizações prévias e
// restrições (RF-14, RF-15, RN-06), presentes, turno e relatórios pela API real (HTTP + PGlite + migrações).
// Relógio da API: sábado 17/10/2026 09:00 BRT (12:00Z), fixo. O banco carimba registrado_em com o relógio real (o
// trigger), que é posterior: fora da contingência, ocorrido_em = registrado_em; no retroativo, o instante informado.
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verificarCadeia } from '../src/dominio/hashChain';
import * as s from '../src/db/schema';
import { paraExportacao } from '../src/db/cadeia';
import { cpfComDv, seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
const JUST = 'Morador não atende o interfone, entrega urgente';
const AGORA = new Date('2026-10-17T12:00:00.000Z'); // sábado 09:00 BRT
const HORA = 3_600_000;
let base = 300_000_000;
const novoCpf = () => cpfComDv(String(++base));

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
  for (const nome of ['Ana Ribeiro', 'Paulo Ribeiro', 'Lúcia Ribeiro', 'Carla Mendes', 'Rafael Mendes', 'Marcos Pereira', 'Bruno Teixeira',
    'Juliana Costa', 'Cláudia Rocha', 'Marta Siqueira', 'Helena Duarte']) {
    ids[nome] = (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  }
  for (const c of ['D-32', 'G-11', 'I-13', 'B-24', 'A-11']) {
    const m = /^([A-Z0-9]+)-(\d+)$/.exec(c)!;
    ids[c] = (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, m[1]!), eq(s.unidade.numero, m[2]!))))[0]!.id;
  }
  ids.salao = (await api.db.select().from(s.areaComum).where(eq(s.areaComum.nome, 'Salão de festas')))[0]!.id;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const entrar = (papel: PapelTeste, corpo: object) => post(papel, '/eventos-acesso', corpo);
const interfone = (pessoa: string, unidade: string, autorizador: string, extra: object = {}) =>
  ({ pessoaId: ids[pessoa], unidadeDestinoId: ids[unidade], autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids[autorizador], ...extra });
const sair = (papel: PapelTeste, entradaId: string, corpo?: object) => post(papel, `/eventos-acesso/${entradaId}/saida`, corpo);
const negados = async () => Number((await api.db.select({ n: count() }).from(s.eventoAcesso).where(eq(s.eventoAcesso.tipo, 'negado')))[0]!.n);
/** Muda o relógio da API e entra de novo (pular mais de 30 min derrubaria a sessão por inatividade). */
const relogar = async () => { for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie; };
const comRelogio = async <T>(d: Date, fn: () => Promise<T>) => {
  const antes = api.relogio.atual; api.relogio.atual = d;
  await relogar();
  try { return await fn(); } finally { api.relogio.atual = antes; await relogar(); }
};
/** Fim do período dos relatórios: amanhã pelo relógio REAL (o banco carimba com ele, depois do relógio da API). */
const amanhaReal = () => new Date(Date.now() + 86_400_000 - 3 * HORA).toISOString().slice(0, 10);

describe('entrada, saída e presentes (RF-12, RF-13, RF-19, RF-20)', () => {
  let entradaId: string;
  it('visitante por interfone: 201 com a view (nomes por id, papel do operador, hash do trigger)', async () => {
    const r = await entrar('porteiro', interfone('Marcos Pereira', 'D-32', 'Ana Ribeiro', { observacao: 'Visita' }));
    expect(r.status).toBe(201);
    const ev = r.body.data;
    entradaId = ev.id;
    expect(ev).toMatchObject({
      tipo: 'entrada', categoriaPessoa: 'visitante', pessoaNome: 'Marcos Pereira', unidadeRotulo: 'D-32', autorizadoPorTipo: 'interfone',
      autorizadoPorNome: 'Ana Ribeiro', operadorNome: 'João Lima', operadorPapel: 'porteiro', dentro: true, retroativo: false, observacao: 'Visita',
      pontoAcessoNome: 'Portaria social', formatoHash: 1, codigo: `EV-${String(ev.seq).padStart(6, '0')}`,
    });
    expect(ev.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.ocorridoEm).toBe(ev.registradoEm); // fora da contingência o relógio é o do servidor
    // O evento guarda só ids (sem nome copiado)
    const [linha] = await api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.id, entradaId));
    expect(linha!.autorizadoPorPessoaId).toBe(ids['Ana Ribeiro']);
  });

  it('não registra se a pessoa já está dentro (409); presentes mostra; a saída é evento novo e a dupla é 409', async () => {
    expect((await entrar('porteiro', interfone('Marcos Pereira', 'D-32', 'Ana Ribeiro'))).body.code).toBe('JA_ESTA_DENTRO');
    const p = await get('porteiro', '/acessos/presentes');
    expect(p.body.data.map((e: { id: string }) => e.id)).toContain(entradaId);
    const sd = await sair('porteiro', entradaId);
    expect(sd.status).toBe(201);
    expect(sd.body.data).toMatchObject({ tipo: 'saida', refereEventoId: entradaId, pessoaNome: 'Marcos Pereira', entradaCodigo: expect.stringMatching(/^EV-/) });
    expect((await sair('porteiro', entradaId)).body.code).toBe('SAIDA_JA_REGISTRADA');
    const det = await get('auditor', `/eventos-acesso/${entradaId}`);
    expect(det.body.data).toMatchObject({ dentro: false, saida: { id: sd.body.data.id } });
    expect((await get('porteiro', '/acessos/presentes')).body.data.map((e: { id: string }) => e.id)).not.toContain(entradaId);
    expect((await sair('porteiro', sd.body.data.id)).body.code).toBe('ENTRADA_NAO_ENCONTRADA');
  });

  it('unidade desativada barra a entrada (UNIDADE_INATIVA); pessoa inexistente 404', async () => {
    await post('administracao', `/unidades/${ids['A-11']}/desativar`);
    try {
      const r = await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['A-11'], autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
      expect(r.body.code).toBe('UNIDADE_INATIVA');
    } finally { await post('administracao', `/unidades/${ids['A-11']}/reativar`); }
    expect((await entrar('porteiro', { pessoaId: '00000000-0000-4000-8000-000000000000', unidadeDestinoId: ids['D-32'] })).status).toBe(404);
  });
});

describe('autorização da entrada (RN-01, RF-17, RN-02)', () => {
  it('RN-01: sem meio, interfone sem morador e autorizador sem vínculo válido (visitante ou pendente) são 422', async () => {
    expect((await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'] })).body.code).toBe('AUTORIZADO_POR_OBRIGATORIO');
    expect((await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'interfone' })).body.code)
      .toBe('AUTORIZADO_POR_SEM_IDENTIFICACAO');
    expect((await entrar('porteiro', interfone('Bruno Teixeira', 'D-32', 'Marcos Pereira'))).body.code).toBe('AUTORIZADOR_SEM_VINCULO');
    expect((await entrar('porteiro', interfone('Bruno Teixeira', 'G-11', 'Rafael Mendes'))).body.code).toBe('AUTORIZADOR_SEM_VINCULO');
    expect((await entrar('porteiro', interfone('Bruno Teixeira', 'G-11', 'Ana Ribeiro'))).body.code).toBe('AUTORIZADOR_SEM_VINCULO'); // outra unidade
  });

  it('legado no prazo autoriza; morador na própria unidade entra sem autorizador; "morador" em outra unidade entra como visitante', async () => {
    const lucia = await entrar('porteiro', interfone('Bruno Teixeira', 'D-32', 'Lúcia Ribeiro'));
    expect(lucia.status).toBe(201);
    await sair('porteiro', lucia.body.data.id);
    const propria = await entrar('porteiro', { pessoaId: ids['Paulo Ribeiro'], unidadeDestinoId: ids['D-32'] });
    expect(propria.body.data).toMatchObject({ categoriaPessoa: 'morador', autorizadoPorTipo: null, autorizadoPorPessoaId: null });
    await sair('porteiro', propria.body.data.id);
    expect((await entrar('porteiro', { pessoaId: ids['Paulo Ribeiro'], unidadeDestinoId: ids['G-11'] })).body.code).toBe('AUTORIZADO_POR_OBRIGATORIO');
    const outra = await entrar('porteiro', interfone('Paulo Ribeiro', 'G-11', 'Carla Mendes'));
    expect(outra.body.data).toMatchObject({ categoriaPessoa: 'visitante', autorizadoPorNome: 'Carla Mendes' });
    await sair('porteiro', outra.body.data.id);
  });

  it('RF-17: exceção exige 15+ caracteres e não guarda autorizador; sem CPF só entra por exceção; prestador leva empresa e serviço', async () => {
    const curta = await entrar('porteiro', { pessoaId: ids['Cláudia Rocha'], unidadeDestinoId: ids['I-13'], autorizadoPorTipo: 'excecao_porteiro', justificativa: 'curta' });
    expect(curta.body.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    expect((await entrar('porteiro', interfone('Cláudia Rocha', 'I-13', 'Marta Siqueira'))).body.code).toBe('SEM_CPF_SO_EXCECAO');
    const ok = await entrar('porteiro', { pessoaId: ids['Cláudia Rocha'], unidadeDestinoId: ids['I-13'], autorizadoPorTipo: 'excecao_porteiro',
      justificativa: `  ${JUST}  `, autorizadoPorPessoaId: ids['Marta Siqueira'] });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ categoriaPessoa: 'prestador', empresa: 'Autônoma', servico: 'Diarista', justificativa: JUST, autorizadoPorPessoaId: null });
    await sair('porteiro', ok.body.data.id);
  });
});

describe('escala de funcionário (RF-09), consultada pela própria API', () => {
  let diurno: string;
  let noturno: string;
  beforeAll(async () => {
    const criar = async (nome: string, escala: object) => (await post('administracao', '/funcionarios',
      { nome, documento: novoCpf(), telefone: '11955551234', funcao: 'Zelador', escala })).body.data.pessoaId as string;
    diurno = await criar('Func Diurno', { diasSemana: [6], horaInicio: '08:00', horaFim: '10:00' });
    noturno = await criar('Func Noturno', { diasSemana: [5], horaInicio: '22:00', horaFim: '06:00' });
  });

  it('em escala entra sem unidade; fora do horário 422; turno noturno vale na madrugada seguinte', async () => {
    const r = await entrar('porteiro', { pessoaId: diurno, unidadeDestinoId: null, autorizadoPorTipo: 'escala' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ categoriaPessoa: 'funcionario', autorizadoPorTipo: 'escala', unidadeDestinoId: null, unidadeRotulo: null });
    await sair('porteiro', r.body.data.id);
    await comRelogio(new Date('2026-10-17T14:30:00.000Z'), async () => { // sábado 11:30 BRT
      expect((await entrar('porteiro', { pessoaId: diurno, unidadeDestinoId: null, autorizadoPorTipo: 'escala' })).body.code).toBe('ESCALA_FORA_DO_HORARIO');
    });
    expect((await entrar('porteiro', { pessoaId: noturno, unidadeDestinoId: null, autorizadoPorTipo: 'escala' })).body.code).toBe('ESCALA_FORA_DO_HORARIO');
    await comRelogio(new Date('2026-10-17T05:00:00.000Z'), async () => { // sábado 02:00 BRT: turno de sexta
      const n = await entrar('porteiro', { pessoaId: noturno, unidadeDestinoId: null, autorizadoPorTipo: 'escala' });
      expect(n.status).toBe(201);
      await sair('porteiro', n.body.data.id);
    });
    // Escala não vale para quem não é funcionário
    expect((await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'escala' })).body.code).toBe('MEIO_INVALIDO_PARA_TIPO');
  });
});

describe('autorização prévia (RF-14, RN-07, RF-36)', () => {
  const nova = (papel: PapelTeste, extra: object) => post(papel, '/autorizacoes-previas', {
    unidadeId: ids['D-32'], pessoaId: ids['Bruno Teixeira'], validaAte: '2026-10-20', diasSemana: [6], horaInicio: '08:00', horaFim: '10:00',
    solicitadaPorPessoaId: ids['Ana Ribeiro'], ...extra,
  });

  it('com solicitante: exige vínculo válido; vale na janela; o autorizador do evento é o solicitante; trilha', async () => {
    expect((await nova('porteiro', { solicitadaPorPessoaId: ids['Marcos Pereira'] })).body.code).toBe('SOLICITANTE_SEM_VINCULO');
    expect((await nova('porteiro', { validaAte: null })).body.code).toBe('VALIDADE_OBRIGATORIA');
    expect((await nova('porteiro', { validaAte: '2026-10-16' })).body.code).toBe('VALIDADE_INVALIDA');
    expect((await nova('porteiro', { horaFim: null })).body.code).toBe('JANELA_INCOMPLETA');
    expect((await nova('auditor', {})).status).toBe(403);
    const a = await nova('porteiro', {});
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ estado: 'valida', solicitadaPorNome: 'Ana Ribeiro', cadastradaPorNome: 'João Lima (Porteiro)', unidadeRotulo: 'D-32', semSolicitante: false });
    expect((await trilha(api, 'autorizacao.criar')).at(-1)!.registroId).toBe(a.body.data.id);
    const vig = await get('porteiro', `/autorizacoes-previas/vigentes?pessoaId=${ids['Bruno Teixeira']}&unidadeId=${ids['D-32']}`);
    expect(vig.body.data.map((x: { id: string }) => x.id)).toContain(a.body.data.id);
    const hoje = await get('porteiro', '/autorizacoes-previas/hoje');
    expect(hoje.body.data.map((x: { id: string }) => x.id)).toContain(a.body.data.id);
    // Lançamento retroativo de 10 min atrás: o "utilizada hoje" usa o dia do relógio da API (o banco carimba com o real)
    const r = await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'autorizacao_previa',
      autorizacaoPreviaId: a.body.data.id, retroativo: true, ocorridoEm: AGORA.getTime() - 600_000, formularioContingencia: 'F-7' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ autorizadoPorPessoaId: ids['Ana Ribeiro'], autorizadoPorNome: 'Ana Ribeiro', autorizacaoSemSolicitante: false });
    await sair('porteiro', r.body.data.id);
    const usada = (await get('porteiro', '/autorizacoes-previas/hoje')).body.data.find((x: { id: string }) => x.id === a.body.data.id);
    expect(usada.utilizadaEm).toBe(AGORA.getTime() - 600_000);
    // Fora da janela (11:30 BRT) a mesma autorização não vale
    await comRelogio(new Date('2026-10-17T14:30:00.000Z'), async () => {
      const f = await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'autorizacao_previa', autorizacaoPreviaId: a.body.data.id });
      expect(f.body.code).toBe('AUTORIZACAO_PREVIA_INVALIDA');
    });
    // Revogar: uma vez; a segunda é 409
    expect((await post('porteiro', `/autorizacoes-previas/${a.body.data.id}/revogar`)).status).toBe(204);
    expect((await post('porteiro', `/autorizacoes-previas/${a.body.data.id}/revogar`)).body.code).toBe('AUTORIZACAO_JA_REVOGADA');
    expect((await trilha(api, 'autorizacao.revogar')).at(-1)!.antes).toMatchObject({ revogada_em: null });
  });

  it('sem solicitante: exige justificativa e conta como exceção de quem cadastrou (RF-31)', async () => {
    expect((await nova('administracao', { solicitadaPorPessoaId: null, justificativa: 'curta' })).body.code).toBe('SOLICITANTE_OU_JUSTIFICATIVA');
    const a = await nova('administracao', { pessoaId: ids['Marcos Pereira'], solicitadaPorPessoaId: null, justificativa: 'Entrega de móveis combinada com a administração' });
    expect(a.body.data).toMatchObject({ semSolicitante: true, solicitadaPorNome: null });
    const r = await entrar('porteiro', { pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'autorizacao_previa', autorizacaoPreviaId: a.body.data.id });
    expect(r.body.data).toMatchObject({ autorizacaoSemSolicitante: true, autorizadoPorNome: 'Sem solicitante — cadastrada por Paula Nogueira' });
    const exc = await post('auditor', '/eventos-acesso/busca', { somenteExcecoes: true, pessoaId: ids['Marcos Pereira'] });
    expect(exc.body.data.map((e: { id: string }) => e.id)).toContain(r.body.data.id);
    const rel = await get('auditor', `/relatorios/resumo?de=2026-10-17&ate=${amanhaReal()}`);
    expect(rel.body.data.excecoesPorPorteiro).toEqual(expect.arrayContaining([expect.objectContaining({ operador: 'Paula Nogueira' })]));
    await sair('porteiro', r.body.data.id);
  });

  it('área comum: só SI/AD criam, só para prestador, sem solicitante; a entrada é por ela ou por exceção', async () => {
    const area = { unidadeId: null, areaComumId: ids.salao, pessoaId: ids['Juliana Costa'], solicitadaPorPessoaId: null, diasSemana: null, horaInicio: null, horaFim: null };
    expect((await nova('porteiro', area)).status).toBe(403);
    expect((await trilha(api, 'acesso.negado')).at(-1)!.depois).toMatchObject({ acao: 'autorizacao.area_comum' });
    expect((await nova('administracao', { ...area, pessoaId: ids['Bruno Teixeira'] })).body.code).toBe('AREA_COMUM_SO_PRESTADOR');
    const a = await nova('administracao', area);
    expect(a.body.data).toMatchObject({ unidadeRotulo: 'Salão de festas', semSolicitante: false });
    const viaInterfone = await entrar('porteiro', { pessoaId: ids['Juliana Costa'], unidadeDestinoId: null, areaComumId: ids.salao, autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Ana Ribeiro'] });
    expect(viaInterfone.body.code).toBe('MEIO_INVALIDO_PARA_TIPO');
    expect((await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: null, areaComumId: ids.salao, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST })).body.code)
      .toBe('AREA_COMUM_SO_PRESTADOR');
    const r = await entrar('porteiro', { pessoaId: ids['Juliana Costa'], unidadeDestinoId: null, areaComumId: ids.salao, autorizadoPorTipo: 'autorizacao_previa', autorizacaoPreviaId: a.body.data.id });
    expect(r.body.data).toMatchObject({ areaComumNome: 'Salão de festas', unidadeRotulo: 'Salão de festas', autorizadoPorNome: 'Área comum — cadastrada por Paula Nogueira', empresa: 'Autônoma' });
    // Área comum não conta como exceção
    expect((await post('auditor', '/eventos-acesso/busca', { somenteExcecoes: true, pessoaId: ids['Juliana Costa'] })).body.data).toHaveLength(0);
    expect((await post('porteiro', `/autorizacoes-previas/${a.body.data.id}/revogar`)).status).toBe(403);
    await sair('porteiro', r.body.data.id);
  });
});

describe('previstos nas próximas horas (autorizações prévias, porteiro)', () => {
  // Relógio da API: sábado 09:00 BRT.
  const nova = (extra: object) => post('porteiro', '/autorizacoes-previas', {
    unidadeId: ids['D-32'], validaAte: '2026-10-20', solicitadaPorPessoaId: ids['Ana Ribeiro'], diasSemana: null, ...extra,
  });
  const previstas = async (qs = '', papel: PapelTeste = 'porteiro') => (await get(papel, `/autorizacoes-previas/previstas${qs}`)).body.data as
    { autorizacaoId: string; nome: string; categoria: string; destino: { tipo: string; rotulo: string }; inicio: number; fim: number }[];
  const brt = (h: number, m = 0) => Date.UTC(2026, 9, 17, h + 3, m);

  it('lista quem ainda não está dentro, por início; recorta pelo horizonte; sem CPF/telefone; 400 fora de 1..24', async () => {
    const tarde = await nova({ pessoaId: ids['Helena Duarte'], horaInicio: '11:00', horaFim: '12:00' });
    const noite = await nova({ pessoaId: ids['Marta Siqueira'], horaInicio: '19:00', horaFim: '20:00' });
    const agoraVale = await nova({ pessoaId: ids['Marcos Pereira'], horaInicio: '06:00', horaFim: '09:30' });
    const segunda = await nova({ pessoaId: ids['Bruno Teixeira'], diasSemana: [1], horaInicio: '08:00', horaFim: '10:00' });
    const revogada = await nova({ pessoaId: ids['Cláudia Rocha'], horaInicio: '10:00', horaFim: '11:00' });
    expect((await post('porteiro', `/autorizacoes-previas/${revogada.body.data.id}/revogar`)).status).toBe(204);
    const area = await post('administracao', '/autorizacoes-previas', {
      unidadeId: null, areaComumId: ids.salao, pessoaId: ids['Juliana Costa'], validaAte: '2026-10-20', solicitadaPorPessoaId: null,
      diasSemana: null, horaInicio: '10:00', horaFim: '11:00',
    });
    const meus = new Set([tarde, noite, agoraVale, segunda, revogada, area].map((r) => r.body.data.id as string));
    const lista = async (qs = '') => (await previstas(qs)).filter((x) => meus.has(x.autorizacaoId));

    const l12 = await lista();
    expect(l12.map((x) => x.nome)).toEqual(['Marcos Pereira', 'Juliana Costa', 'Helena Duarte', 'Marta Siqueira']);
    expect(l12.map((x) => x.inicio)).toEqual([brt(6), brt(10), brt(11), brt(19)]);
    expect(l12[0]).toMatchObject({ fim: brt(9, 30) + 59_999, destino: { tipo: 'unidade', rotulo: 'D-32' } });
    expect(l12[1]).toMatchObject({ destino: { tipo: 'area_comum', rotulo: 'Salão de festas' }, categoria: 'prestador' });
    expect(Object.keys(l12[0]!).sort()).toEqual(['autorizacaoId', 'categoria', 'destino', 'fim', 'inicio', 'nome', 'pessoaId']);
    // O limite do horizonte é inclusivo (Juliana começa às 10:00 = agora + 1 h)
    expect((await lista('?horas=1')).map((x) => x.nome)).toEqual(['Marcos Pereira', 'Juliana Costa']);
    expect((await lista('?horas=2')).map((x) => x.nome)).toEqual(['Marcos Pereira', 'Juliana Costa', 'Helena Duarte']);
    expect((await lista('?horas=24')).map((x) => x.nome)).toEqual(['Marcos Pereira', 'Juliana Costa', 'Helena Duarte', 'Marta Siqueira']);
    expect((await previstas('', 'auditor')).length).toBeGreaterThan(0);
    for (const h of ['0', '25', 'x', '1.5']) expect((await get('porteiro', `/autorizacoes-previas/previstas?horas=${h}`)).status, h).toBe(400);

    // Quem está dentro sai da lista; depois da saída, volta.
    const e = await entrar('porteiro', { pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'autorizacao_previa', autorizacaoPreviaId: agoraVale.body.data.id });
    expect(e.status).toBe(201);
    expect((await lista('?horas=1')).map((x) => x.nome)).toEqual(['Juliana Costa']);
    await sair('porteiro', e.body.data.id);
    expect((await lista('?horas=1')).map((x) => x.nome)).toEqual(['Marcos Pereira', 'Juliana Costa']);
  });
});

describe('restrição (RF-15, RF-16, RN-06)', () => {
  let restricaoId: string;
  it('de unidade: porteiro cadastra com solicitante; verificar mostra; a entrada grava UM negado e responde 422 com o id', async () => {
    const base = { pessoaId: ids['Bruno Teixeira'], unidadeId: ids['D-32'], motivo: 'Morador não autoriza', validaAte: '2026-12-31' };
    expect((await post('porteiro', '/restricoes', { ...base, solicitadaPorPessoaId: null })).body.code).toBe('SOLICITANTE_OBRIGATORIO');
    expect((await post('porteiro', '/restricoes', { ...base, solicitadaPorPessoaId: ids['Carla Mendes'] })).body.code).toBe('SOLICITANTE_SEM_VINCULO');
    const r = await post('porteiro', '/restricoes', { ...base, solicitadaPorPessoaId: ids['Ana Ribeiro'] });
    expect(r.status).toBe(201);
    restricaoId = r.body.data.id;
    expect(r.body.data).toMatchObject({ escopo: 'unidade', pendente: false, solicitadaPorNome: 'Ana Ribeiro', unidadeCodigo: 'D-32' });
    const v = await get('porteiro', `/restricoes/verificar?pessoaId=${ids['Bruno Teixeira']}&unidadeId=${ids['D-32']}`);
    expect(v.body.data).toMatchObject({ restrita: true, alertas: [{ id: restricaoId, motivo: 'Morador não autoriza' }] });
    expect((await get('porteiro', `/restricoes/verificar?pessoaId=${ids['Bruno Teixeira']}&unidadeId=${ids['G-11']}`)).body.data.restrita).toBe(false);

    const antes = await negados();
    const e = await entrar('porteiro', interfone('Bruno Teixeira', 'D-32', 'Ana Ribeiro'));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('PESSOA_EM_RESTRICAO');
    expect(e.body.details).toMatchObject({ eventoId: expect.any(String), codigo: expect.stringMatching(/^EV-/), restricoes: [{ id: restricaoId }] });
    expect(await negados()).toBe(antes + 1); // gravado (commitado) uma vez, mesmo com o 422
    const neg = await get('auditor', `/eventos-acesso/${e.body.details.eventoId}`);
    expect(neg.body.data).toMatchObject({ tipo: 'negado', restricaoId, autorizadoPorTipo: null, dentro: false });
    // Sem meio (a tela grava o negado detectado antes): o mesmo caminho, sem exigir autorização
    const semMeio = await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: null });
    expect(semMeio.body.code).toBe('PESSOA_EM_RESTRICAO');
    expect(await negados()).toBe(antes + 2);
    // A restrição de unidade não vale em outra unidade
    const outra = await entrar('porteiro', interfone('Bruno Teixeira', 'G-11', 'Carla Mendes'));
    expect(outra.status).toBe(201);
    await sair('porteiro', outra.body.data.id);
  });

  it('revogar: porteiro 403; SI/AD uma vez (a segunda é 409); depois a entrada passa', async () => {
    expect((await post('porteiro', `/restricoes/${restricaoId}/revogar`)).status).toBe(403);
    expect((await post('administracao', `/restricoes/${restricaoId}/revogar`)).status).toBe(204);
    expect((await post('administracao', `/restricoes/${restricaoId}/revogar`)).body.code).toBe('RESTRICAO_JA_REVOGADA');
    const ok = await entrar('porteiro', interfone('Bruno Teixeira', 'D-32', 'Ana Ribeiro'));
    expect(ok.status).toBe(201);
    await sair('porteiro', ok.body.data.id);
  });

  it('de condomínio: nasce pendente (não barra); só o síndico aprova, uma vez; aprovada barra até funcionário sem unidade', async () => {
    const func = (await post('administracao', '/funcionarios', { nome: 'Func Restrito', documento: novoCpf(), telefone: '11955554321', funcao: 'Jardineiro',
      escala: { diasSemana: [6], horaInicio: '08:00', horaFim: '10:00' } })).body.data.pessoaId as string;
    const r = await post('porteiro', '/restricoes', { pessoaId: func, unidadeId: null, motivo: 'Afastado pela administração', validaAte: '2026-12-31', solicitadaPorPessoaId: null, paraTodoCondominio: true });
    expect(r.body.data).toMatchObject({ escopo: 'condominio', pendente: true });
    expect((await get('porteiro', '/restricoes/pendentes')).body.data.map((x: { id: string }) => x.id)).toContain(r.body.data.id);
    expect((await get('porteiro', '/turnos/resumo')).body.data.restricoesPendentes).toBeGreaterThanOrEqual(1);
    const livre = await entrar('porteiro', { pessoaId: func, unidadeDestinoId: null, autorizadoPorTipo: 'escala' });
    expect(livre.status).toBe(201); // pendente não barra
    await sair('porteiro', livre.body.data.id);
    expect((await post('administracao', `/restricoes/${r.body.data.id}/aprovar`)).status).toBe(403);
    const ap = await post('sindico', `/restricoes/${r.body.data.id}/aprovar`);
    expect(ap.body.data).toMatchObject({ pendente: false, aprovadaPorNome: 'Carlos Andrade' });
    expect((await post('sindico', `/restricoes/${r.body.data.id}/aprovar`)).body.code).toBe('RESTRICAO_JA_APROVADA');
    expect((await get('porteiro', `/restricoes/verificar?pessoaId=${func}`)).body.data.restrita).toBe(true);
    const barrado = await entrar('porteiro', { pessoaId: func, unidadeDestinoId: null, autorizadoPorTipo: 'escala' });
    expect(barrado.body.code).toBe('PESSOA_EM_RESTRICAO');
    expect(barrado.body.message).toContain('no condomínio');
  });
});

describe('retroativo (RF-35, UC08) e recusa (UC02 A4)', () => {
  const t = (h: number) => AGORA.getTime() - h * HORA;
  it('retroativo exige formulário e hora passada; auditor 403; a saída retroativa fica entre a entrada e agora', async () => {
    const corpo = { ...interfone('Marcos Pereira', 'B-24', 'Helena Duarte'), retroativo: true, ocorridoEm: t(5) };
    expect((await entrar('porteiro', { ...corpo, formularioContingencia: ' ' })).body.code).toBe('FORMULARIO_OBRIGATORIO');
    expect((await entrar('porteiro', { ...corpo, ocorridoEm: AGORA.getTime() + HORA, formularioContingencia: 'F-1' })).body.code).toBe('DATA_INCONSISTENTE');
    expect((await entrar('auditor', { ...corpo, formularioContingencia: 'F-1' })).status).toBe(403);
    // Não retroativo com hora fora da tolerância (5 min)
    expect((await entrar('porteiro', { ...interfone('Marcos Pereira', 'B-24', 'Helena Duarte'), ocorridoEm: t(1) })).body.code).toBe('DATA_INCONSISTENTE');
    const r = await entrar('porteiro', { ...corpo, formularioContingencia: 'F-0042' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ retroativo: true, ocorridoEm: t(5), formularioContingencia: 'F-0042' });
    expect(r.body.data.registradoEm).toBeGreaterThan(r.body.data.ocorridoEm);
    expect((await sair('porteiro', r.body.data.id, { retroativo: true, ocorridoEm: t(6), formularioContingencia: 'F-0043' })).body.code).toBe('DATA_INCONSISTENTE');
    expect((await sair('porteiro', r.body.data.id, { retroativo: true, ocorridoEm: t(4) })).body.code).toBe('FORMULARIO_OBRIGATORIO');
    const sd = await sair('porteiro', r.body.data.id, { retroativo: true, ocorridoEm: t(4), formularioContingencia: 'F-0043', observacao: 'anotado' });
    expect(sd.body.data).toMatchObject({ tipo: 'saida', retroativo: true, ocorridoEm: t(4), formularioContingencia: 'F-0043' });
    const so = await post('auditor', '/eventos-acesso/busca', { somenteRetroativos: true, pessoaId: ids['Marcos Pereira'] });
    expect(so.body.data.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining([r.body.data.id, sd.body.data.id]));
  });

  it('recusa: morador com vínculo válido, por interfone ou presente; vira evento "recusado" sem entrada', async () => {
    const corpo = { pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['I-13'], meio: 'interfone', moradorPessoaId: ids['Marta Siqueira'] };
    expect((await post('porteiro', '/eventos-acesso/recusas', { ...corpo, moradorPessoaId: ids['Ana Ribeiro'] })).body.code).toBe('AUTORIZADOR_SEM_VINCULO');
    expect((await post('porteiro', '/eventos-acesso/recusas', { ...corpo, meio: 'excecao_porteiro' })).status).toBe(400);
    const r = await post('porteiro', '/eventos-acesso/recusas', corpo);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ tipo: 'recusado', autorizadoPorTipo: 'interfone', autorizadoPorNome: 'Marta Siqueira', dentro: false });
    expect((await get('porteiro', '/acessos/presentes')).body.data.map((e: { id: string }) => e.id)).not.toContain(r.body.data.id);
  });
});

describe('meio "celular" (WhatsApp ou ligação, questionário de 22/10/2026): a regra do interfone', () => {
  it('exige o morador, com vínculo válido; não é exceção; filtra por meio=celular; vale para a recusa; a correção não tira o autorizador', async () => {
    const pessoaId = (await post('administracao', '/pessoas', { nome: 'Vera Celular', categoria: 'visitante', documento: novoCpf(), telefone: '11912340001' })).body.data.id as string;
    const corpo = { pessoaId, unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'celular' };
    expect((await entrar('porteiro', corpo)).body.code).toBe('AUTORIZADO_POR_SEM_IDENTIFICACAO');
    expect((await entrar('porteiro', { ...corpo, autorizadoPorPessoaId: ids['Marta Siqueira'] })).body.code).toBe('AUTORIZADOR_SEM_VINCULO');
    expect((await entrar('porteiro', { ...corpo, unidadeDestinoId: null, areaComumId: ids.salao, autorizadoPorPessoaId: ids['Ana Ribeiro'] })).body.code)
      .toBe('AREA_COMUM_SO_PRESTADOR');
    const e = await entrar('porteiro', { ...corpo, autorizadoPorPessoaId: ids['Ana Ribeiro'] });
    expect(e.status).toBe(201);
    expect(e.body.data).toMatchObject({ tipo: 'entrada', autorizadoPorTipo: 'celular', autorizadoPorNome: 'Ana Ribeiro', justificativa: null });
    // Não é exceção (RF-31): fora do filtro de exceções
    const exc = await post('auditor', '/eventos-acesso/busca', { somenteExcecoes: true, pessoaId });
    expect(exc.body.data).toHaveLength(0);
    const so = await get('auditor', '/eventos-acesso?meio=celular&limite=100');
    expect(so.body.data.map((x: { id: string }) => x.id)).toContain(e.body.data.id);
    expect(so.body.data.every((x: { autorizadoPorTipo: string }) => x.autorizadoPorTipo === 'celular')).toBe(true);
    expect((await post('administracao', `/eventos-acesso/${e.body.data.id}/correcoes`, { justificativa: JUST, valores: { autorizadoPorPessoaId: null } })).body.code)
      .toBe('AUTORIZADOR_OBRIGATORIO');
    expect((await sair('porteiro', e.body.data.id)).status).toBe(201);
    const r = await post('porteiro', '/eventos-acesso/recusas', { pessoaId, unidadeDestinoId: ids['D-32'], meio: 'celular', moradorPessoaId: ids['Ana Ribeiro'] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ tipo: 'recusado', autorizadoPorTipo: 'celular', autorizadoPorNome: 'Ana Ribeiro' });
  });

  it('o banco exige o morador mesmo sem a API (evento_morador_identificado_ck)', async () => {
    const [ev] = await api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.autorizadoPorTipo, 'celular')).limit(1);
    const { id: _id, seq: _s, hash: _h, hashAnterior: _ha, registradoEm: _r, formatoHash: _f, ...resto } = ev!;
    await expect(api.db.insert(s.eventoAcesso).values({ ...resto, autorizadoPorPessoaId: null })).rejects.toMatchObject({ cause: { constraint: 'evento_morador_identificado_ck' } });
  });
});

describe('correção (RN-04): evento novo, valores efetivos, sem corrigir correção', () => {
  it('porteiro 403; justificativa; os valores efetivos aparecem no original e nos filtros; o acumulado segue', async () => {
    const e = await entrar('porteiro', interfone('Juliana Costa', 'D-32', 'Ana Ribeiro'));
    const id = e.body.data.id as string;
    await sair('porteiro', id);
    expect((await post('porteiro', `/eventos-acesso/${id}/correcoes`, { justificativa: JUST })).status).toBe(403);
    expect((await post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: 'curta' })).body.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    const c1 = await post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: 'Unidade digitada errada pelo porteiro', valores: { unidadeDestinoId: ids['B-24'] } });
    expect(c1.status).toBe(201);
    expect(c1.body.data).toMatchObject({ tipo: 'correcao', corrigeEventoId: id, valoresCorrigidos: { unidadeDestinoId: ids['B-24'] } });
    expect((await post('administracao', `/eventos-acesso/${c1.body.data.id}/correcoes`, { justificativa: JUST })).body.code).toBe('CORRECAO_DE_CORRECAO');
    const orig = (await get('auditor', `/eventos-acesso/${id}`)).body.data;
    expect(orig).toMatchObject({ unidadeDestinoId: ids['B-24'], unidadeRotulo: 'B-24', valoresOriginais: { unidadeDestinoId: ids['D-32'] },
      correcao: { id: c1.body.data.id, justificativa: 'Unidade digitada errada pelo porteiro', operadorNome: 'Paula Nogueira' } });
    // Filtro pela unidade EFETIVA: aparece na B-24, não na D-32
    const naNova = await get('auditor', `/eventos-acesso?unidadeId=${ids['B-24']}&tipo=entrada&limite=100`);
    expect(naNova.body.data.map((x: { id: string }) => x.id)).toContain(id);
    const naVelha = await get('auditor', `/eventos-acesso?unidadeId=${ids['D-32']}&tipo=entrada&limite=100`);
    expect(naVelha.body.data.map((x: { id: string }) => x.id)).not.toContain(id);
    // Segunda correção (hora) acumula a unidade; a anotação sem valores também carrega o acumulado
    const hora = AGORA.getTime() - 2 * HORA;
    expect((await post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: JUST, valores: { ocorridoEm: AGORA.getTime() + HORA * 1e4 } })).body.code).toBe('DATA_INCONSISTENTE');
    const c2 = await post('sindico', `/eventos-acesso/${id}/correcoes`, { justificativa: 'Hora real informada pelo morador', valores: { ocorridoEm: hora } });
    expect(c2.body.data.valoresCorrigidos).toEqual({ unidadeDestinoId: ids['B-24'], ocorridoEm: hora });
    const c3 = await post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: 'Anotação: confirmado com a portaria', observacao: 'ok' });
    expect(c3.body.data.valoresCorrigidos).toEqual({ unidadeDestinoId: ids['B-24'], ocorridoEm: hora });
    const fim = (await get('auditor', `/eventos-acesso/${id}`)).body.data;
    expect(fim).toMatchObject({ ocorridoEm: hora, unidadeDestinoId: ids['B-24'], correcao: { id: c3.body.data.id } });
    const lista = await get('auditor', `/eventos-acesso/${id}/correcoes`);
    expect(lista.body.data.map((x: { id: string }) => x.id)).toEqual([c1.body.data.id, c2.body.data.id, c3.body.data.id]);
    // Corrigir pessoa e autorizador: os nomes originais e corrigidos vêm resolvidos
    const c4 = await post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: JUST, valores: { pessoaId: ids['Bruno Teixeira'], autorizadoPorPessoaId: ids['Helena Duarte'] } });
    expect(c4.body.data).toMatchObject({ pessoaNomeCorrigida: 'Bruno Teixeira', autorizadoPorNomeCorrigido: 'Helena Duarte' });
    const p = (await get('auditor', `/eventos-acesso/${id}`)).body.data;
    expect(p).toMatchObject({ pessoaNome: 'Bruno Teixeira', pessoaNomeOriginal: 'Juliana Costa', autorizadoPorNome: 'Helena Duarte', autorizadoPorNomeOriginal: 'Ana Ribeiro' });
    expect((await post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: JUST, valores: { autorizadoPorPessoaId: null } })).body.code).toBe('AUTORIZADOR_OBRIGATORIO');
  });
});

describe('listagem, filtros e paginação (RF-19)', () => {
  it('percorre por cursor sem repetir, do mais novo ao mais antigo; filtros; texto do nome só no corpo do POST', async () => {
    const vistos: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const r = await get('auditor', `/eventos-acesso?limite=7${cursor ? `&cursor=${cursor}` : ''}`);
      vistos.push(...r.body.data.map((e: { seq: number }) => e.seq));
      cursor = r.body.pagination.cursor;
      if (!r.body.pagination.hasNextPage) break;
    }
    const [{ n }] = await api.db.select({ n: count() }).from(s.eventoAcesso) as [{ n: number }];
    expect(vistos).toHaveLength(Number(n));
    expect([...vistos].sort((a, b) => b - a)).toEqual(vistos);
    expect(new Set(vistos).size).toBe(vistos.length);
    const so = await get('auditor', '/eventos-acesso?tipo=negado&limite=100');
    expect(so.body.data.every((e: { tipo: string }) => e.tipo === 'negado')).toBe(true);
    const semSaidas = await get('auditor', '/eventos-acesso?excluirTipos=saida,correcao&limite=100');
    expect(semSaidas.body.data.some((e: { tipo: string }) => e.tipo === 'saida' || e.tipo === 'correcao')).toBe(false);
    const meio = await get('auditor', '/eventos-acesso?meio=escala&limite=100');
    expect(meio.body.data.length).toBeGreaterThan(0);
    expect(meio.body.data.every((e: { autorizadoPorTipo: string }) => e.autorizadoPorTipo === 'escala')).toBe(true);
    const op = await get('auditor', `/eventos-acesso?operadorId=${api.usuarios['paula.nogueira']!.id}&limite=100`);
    expect(op.body.data.every((e: { operadorNome: string }) => e.operadorNome === 'Paula Nogueira')).toBe(true);
    // Nome sem acento, parcial, pelo corpo
    const nome = await post('porteiro', '/eventos-acesso/busca', { pessoa: 'CLAUDIA roc', limite: 100 });
    expect(nome.status).toBe(200);
    expect(nome.body.data.length).toBeGreaterThan(0);
    expect(nome.body.data.every((e: { pessoaNome: string }) => e.pessoaNome === 'Cláudia Rocha')).toBe(true);
    expect((await get('auditor', '/eventos-acesso?pessoa=Ana')).status).toBe(400); // texto na URL é recusado
    expect((await get('auditor', '/eventos-acesso?cursor=xyz')).body.code).toBe('CURSOR_INVALIDO');
  });
});

describe('turno (RF-29) e relatórios (RF-30, RF-31)', () => {
  it('resumo do turno: porteiro vê, auditor não; conta quem está dentro e as exceções de hoje', async () => {
    expect((await get('auditor', '/turnos/resumo')).status).toBe(403);
    const dentroAntes = (await get('porteiro', '/turnos/resumo')).body.data;
    const e = await entrar('porteiro', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['I-13'], autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
    const depois = (await get('porteiro', '/turnos/resumo')).body.data;
    expect(depois).toMatchObject({ pessoasDentro: dentroAntes.pessoasDentro + 1, excecoesHoje: dentroAntes.excecoesHoje + 1, encomendasPendentes: 0, ocorrenciasAbertas: 0 });
    await sair('porteiro', e.body.data.id);
  });

  it('relatório: totais pelos valores efetivos, filtros, período; CSV com BOM e ";"; porteiro 403', async () => {
    expect((await get('porteiro', '/relatorios/resumo')).status).toBe(403);
    expect((await get('auditor', '/relatorios/resumo?de=2026-10-18&ate=2026-10-01')).body.code).toBe('PERIODO_INVALIDO');
    expect((await get('auditor', '/relatorios/resumo?de=2025-01-01&ate=2026-10-17')).body.code).toBe('PERIODO_LONGO');
    // O banco carimba com o relógio real (posterior ao da API): o período vai até o fim de amanhã para pegar tudo
    const r = await get('auditor', '/relatorios/resumo?de=2026-10-01&ate=2027-12-31');
    expect(r.status).toBe(422); // 457 dias
    const fim = amanhaReal();
    const res = (await get('auditor', `/relatorios/resumo?de=2026-10-17&ate=${fim}`)).body.data;
    const [{ n: entradas }] = await api.db.select({ n: count() }).from(s.eventoAcesso).where(eq(s.eventoAcesso.tipo, 'entrada')) as [{ n: number }];
    expect(res.totais.entradas).toBe(Number(entradas));
    expect(res.totais.negados).toBe(await negados());
    expect(res.totais.recusados).toBeGreaterThanOrEqual(1);
    expect(res.totais.retroativos).toBeGreaterThanOrEqual(1);
    expect(res.acessosPorDia.reduce((a: number, d: { entradas: number }) => a + d.entradas, 0)).toBe(res.totais.entradas);
    expect(res.acessosPorMeio.map((m: { meio: string }) => m.meio)).toEqual(expect.arrayContaining(['interfone', 'celular', 'excecao_porteiro', 'escala', 'autorizacao_previa']));
    expect(res.cadastroCompleto.total).toBe(162);
    const porMeio = (await get('auditor', `/relatorios/resumo?de=2026-10-17&ate=${fim}&meio=escala`)).body.data;
    expect(porMeio.totais.entradas).toBe(res.acessosPorMeio.find((m: { meio: string }) => m.meio === 'escala').total);
    expect(porMeio.totais.negados).toBe(0);
    const csv = (await get('administracao', `/relatorios/resumo/csv?de=2026-10-17&ate=${fim}&unidadeId=${ids['D-32']}`)).body.data;
    expect(csv.nomeArquivo).toMatch(/^relatorio-condenexo-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.conteudo.startsWith('﻿Seção;Item;Total\r\n')).toBe(true);
    expect(csv.conteudo).toContain('Filtro;Unidade;D-32');
  });
});

describe('RBAC por papel (403 e acesso.negado na trilha)', () => {
  it('auditor não registra; porteiro não corrige, não aprova restrição, não exporta nem verifica', async () => {
    const casos: [PapelTeste, 'get' | 'post', string, object?][] = [
      ['auditor', 'post', '/eventos-acesso', interfone('Bruno Teixeira', 'D-32', 'Ana Ribeiro')],
      ['auditor', 'post', '/eventos-acesso/recusas', { pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'], meio: 'interfone', moradorPessoaId: ids['Ana Ribeiro'] }],
      ['auditor', 'post', '/restricoes', { pessoaId: ids['Bruno Teixeira'], unidadeId: ids['D-32'], motivo: 'x', validaAte: '2026-12-31', solicitadaPorPessoaId: ids['Ana Ribeiro'] }],
      ['porteiro', 'get', '/auditoria/integridade'],
      ['porteiro', 'post', '/auditoria/exportacoes', {}],
      ['porteiro', 'get', '/auditoria/alteracoes'],
      ['porteiro', 'get', '/funcionarios'],
      ['administracao', 'post', `/restricoes/${'00000000-0000-4000-8000-000000000000'}/aprovar`],
      ['auditor', 'get', '/autorizacoes-previas/vigentes'],
    ];
    for (const [papel, m, url, corpo] of casos) {
      const r = m === 'get' ? await get(papel, url) : await post(papel, url, corpo);
      expect(r.status, `${papel} ${m} ${url}`).toBe(403);
    }
    expect((await trilha(api, 'acesso.negado')).length).toBeGreaterThanOrEqual(casos.length);
  });
});

describe('a trilha continua íntegra depois de todo o fluxo', () => {
  it('a cadeia gravada pelo trigger verifica com o domain; integridade pela rota', async () => {
    const evs = (await api.db.select().from(s.eventoAcesso).orderBy(s.eventoAcesso.seq)).map(paraExportacao);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: evs.length });
    const r = await get('auditor', '/auditoria/integridade');
    expect(r.body.data).toMatchObject({ valido: true, verificados: evs.length, ultimoSeq: evs.at(-1)!.seq, selosConferidos: 0 });
  });
});
