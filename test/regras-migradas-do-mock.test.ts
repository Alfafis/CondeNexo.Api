// Regras de negócio cobertas pela API real (RF/RN). Cada `it` diz a regra. HTTP real + PGlite + migrações, como os outros.
// Relógio da API: sábado 17/10/2026 09:00 BRT (12:00Z). O banco carimba registrado_em com o relógio REAL (o trigger):
// fora da contingência, ocorrido_em = registrado_em (posterior ao relógio da API); por isso os relatórios com evento
// "de agora" vão até amanhã pelo relógio real.
import { and, count, eq } from 'drizzle-orm';
import { lerExportacaoJsonl } from '../src/dominio/exportacao';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { documentoBusca } from '../src/db/cpf';
import { cpfComDv, seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
const JUST = 'Morador não atende o interfone, entrega urgente';
const AGORA = new Date('2026-10-17T12:00:00.000Z'); // sábado 09:00 BRT
const HORA = 3_600_000;
const NENHUM = '00000000-0000-4000-8000-000000000000';
const CPF_ANA = cpfComDv('529982247');
let base = 400_000_000;
const novoCpf = () => cpfComDv(String(++base));

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
  for (const nome of ['Ana Ribeiro', 'Lúcia Ribeiro', 'Carla Mendes', 'Rafael Mendes', 'Marcos Pereira', 'Bruno Teixeira',
    'Juliana Costa', 'Marta Siqueira', 'Técnico Enel — Diego Santos']) {
    ids[nome] = (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  }
  for (const c of ['D-32', 'G-11', 'I-13', 'B-24', 'A-11', 'A-12', 'A-13']) {
    const m = /^([A-Z0-9]+)-(\d+)$/.exec(c)!;
    ids[c] = (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, m[1]!), eq(s.unidade.numero, m[2]!))))[0]!.id;
  }
  ids.salao = (await api.db.select().from(s.areaComum).where(eq(s.areaComum.nome, 'Salão de festas')))[0]!.id;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const patch = (papel: PapelTeste, url: string, corpo: object) => api.http().patch(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const entrar = (corpo: object) => post('porteiro', '/eventos-acesso', corpo);
const interfone = (pessoa: string, unidade: string, autorizador: string, extra: object = {}) =>
  ({ pessoaId: ids[pessoa], unidadeDestinoId: ids[unidade], autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids[autorizador], ...extra });
const sair = (entradaId: string) => post('porteiro', `/eventos-acesso/${entradaId}/saida`);
const idsDe = (r: { body: { data: { id: string }[] } }) => r.body.data.map((x) => x.id);
/** Muda o relógio da API e entra de novo (pular mais de 30 min derrubaria a sessão por inatividade). */
const relogar = async () => { for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie; };
const comRelogio = async <T>(d: Date, fn: () => Promise<T>) => {
  const antes = api.relogio.atual; api.relogio.atual = d;
  await relogar();
  try { return await fn(); } finally { api.relogio.atual = antes; await relogar(); }
};
/** Fim do período dos relatórios: amanhã pelo relógio REAL (o banco carimba com ele, depois do relógio da API). */
const amanhaReal = () => new Date(Date.now() + 86_400_000 - 3 * HORA).toISOString().slice(0, 10);
/** Pessoa nova com CPF e telefone (cadastro completo, aprovável). */
const novaPessoa = async (nome: string, categoria = 'visitante') => {
  const r = await post('administracao', '/pessoas', { nome, documento: novoCpf(), telefone: '11912345678', categoria });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
};

describe('encomendas e vínculo legado (RN-08, RN-09)', () => {
  it('RN-08/RN-09: legado no prazo de regularização retira encomenda da própria unidade (migrado do teste do mock)', async () => {
    const e = await post('porteiro', '/encomendas', { unidadeId: ids['D-32'], destinatario: 'Lúcia Ribeiro', unidadeConfirmada: true });
    expect(e.status).toBe(201);
    const r = await post('porteiro', `/encomendas/${e.body.data.id}/retirada`, { pessoaId: ids['Lúcia Ribeiro'] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ retiradaPorPessoaId: ids['Lúcia Ribeiro'], retiradaAutorizacaoId: null });
    expect(r.body.data.retiradaEm).toBe(AGORA.getTime());
    expect((await trilha(api, 'encomenda.entregar')).at(-1)!.registroId).toBe(e.body.data.id);
  });
});

describe('categoria efetiva na entrada (RN-01, RN-02)', () => {
  it('RN-01: pendente na própria unidade não entra sem autorizador (Rafael Mendes, G-11) (migrado do teste do mock)', async () => {
    const r = await entrar({ pessoaId: ids['Rafael Mendes'], unidadeDestinoId: ids['G-11'] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('AUTORIZADO_POR_OBRIGATORIO');
  });

  it('RN-02: "morador" com vínculo só pendente na unidade entra como visitante, com autorizador (migrado do teste do mock)', async () => {
    // Cadastro como morador, vínculo pedido (pendente) e ainda não aprovado: a categoria efetiva é visitante.
    const pessoaId = await novaPessoa('Morador Ainda Pendente', 'morador');
    const v = await post('administracao', '/vinculos', { pessoaId, unidadeId: ids['G-11'], tipo: 'dependente' });
    expect(v.body.data).toMatchObject({ status: 'pendente' });
    expect((await entrar({ pessoaId, unidadeDestinoId: ids['G-11'] })).body.code).toBe('AUTORIZADO_POR_OBRIGATORIO');
    const ok = await entrar({ pessoaId, unidadeDestinoId: ids['G-11'], autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Carla Mendes'] });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ categoriaPessoa: 'visitante', autorizadoPorPessoaId: ids['Carla Mendes'] });
    await sair(ok.body.data.id);
  });
});

describe('exportação verificável (RF-32)', () => {
  it('RF-32: geradoEm do manifesto no fuso de São Paulo (-03:00) e carimbo do arquivo em BRT (migrado do teste do mock)', async () => {
    const r = await post('auditor', '/auditoria/exportacoes', {});
    expect(r.status).toBe(200);
    const { manifesto } = lerExportacaoJsonl(r.body.data.conteudo);
    expect(manifesto.geradoEm).toBe('2026-10-17T09:00:00.000-03:00');
    expect(r.body.data.nomeArquivo).toBe('trilha-condnexo-20261017-0900.jsonl');
  });
});

describe('importação: deduplicação com o banco (RF-11, RN-09)', () => {
  it('RF-11: mesmo CPF com outro nome não duplica a pessoa (vira vínculo legado dela); sem CPF, mesmo nome em OUTRA unidade é pessoa nova (migrado do teste do mock)', async () => {
    const linhas = [
      // CPF da Ana Ribeiro (D-32), com o nome escrito diferente, em outra unidade: casa pelo HMAC do CPF
      { linha: 2, bloco: 'B', unidade: '24', nome: 'Ana R. Silva', documento: CPF_ANA, telefone: '', tipo: 'Proprietário' },
      // Sem CPF e com o nome de quem mora na D-32: não casa só pelo nome (só na MESMA unidade)
      { linha: 3, bloco: 'A', unidade: '11', nome: 'Ana Ribeiro', documento: '', telefone: '', tipo: 'Dependente' },
    ];
    const hmacAna = documentoBusca(CPF_ANA, CHAVE_HMAC_TESTE);
    const [{ n: antes }] = await api.db.select({ n: count() }).from(s.pessoa) as [{ n: number }];
    const a = await post('administracao', '/importacoes', { arquivo: 'migrados.csv', linhas });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ importaveis: 2, rejeitadas: 0 });
    const c = await post('administracao', `/importacoes/${a.body.data.id}/confirmar`, { linhas });
    expect(c.body.data).toMatchObject({ importados: 2, reaproveitados: 0 });
    const [{ n: depois }] = await api.db.select({ n: count() }).from(s.pessoa) as [{ n: number }];
    expect(Number(depois)).toBe(Number(antes) + 1); // só a "Ana Ribeiro" sem CPF é nova

    const comCpf = await api.db.select().from(s.pessoa).where(eq(s.pessoa.documentoBusca, hmacAna));
    expect(comCpf).toHaveLength(1);
    expect(comCpf[0]).toMatchObject({ id: ids['Ana Ribeiro'], nome: 'Ana Ribeiro' }); // o nome da planilha não sobrescreve
    const [vB24] = await api.db.select().from(s.vinculoUnidade)
      .where(and(eq(s.vinculoUnidade.pessoaId, ids['Ana Ribeiro']!), eq(s.vinculoUnidade.unidadeId, ids['B-24']!)));
    expect(vB24).toMatchObject({ status: 'legado', tipo: 'proprietario' });

    const anas = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro'));
    expect(anas).toHaveLength(2);
    const nova = anas.find((p) => p.id !== ids['Ana Ribeiro'])!;
    expect(nova).toMatchObject({ semCpf: true, documentoBusca: null, categoria: 'morador' });
    const [vA11] = await api.db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.pessoaId, nova.id));
    expect(vA11).toMatchObject({ unidadeId: ids['A-11'], status: 'legado', tipo: 'dependente' });
  });
});

describe('restrições e autorizações no detalhe da unidade (RF-14, RF-15, RN-07)', () => {
  it('RF-15: restrição vencida some de GET /restricoes?unidadeId; a que vence hoje ainda vale (migrado do teste do mock)', async () => {
    const r = await post('porteiro', '/restricoes', {
      pessoaId: ids['Marcos Pereira'], unidadeId: ids['D-32'], motivo: 'Morador pediu para barrar', validaAte: '2026-10-17', solicitadaPorPessoaId: ids['Ana Ribeiro'],
    });
    expect(r.status).toBe(201);
    expect(idsDe(await get('porteiro', `/restricoes?unidadeId=${ids['D-32']}`))).toContain(r.body.data.id);
    await comRelogio(new Date('2026-10-18T12:00:00.000Z'), async () => {
      expect(idsDe(await get('porteiro', `/restricoes?unidadeId=${ids['D-32']}`))).not.toContain(r.body.data.id);
    });
  });

  it('RN-07: autorização revogada some da unidade e de /hoje; a vencida some da unidade (migrado do teste do mock)', async () => {
    const nova = (validaAte: string) => post('porteiro', '/autorizacoes-previas', {
      unidadeId: ids['D-32'], pessoaId: ids['Bruno Teixeira'], validaAte, solicitadaPorPessoaId: ids['Ana Ribeiro'],
    });
    const a = await nova('2026-10-20');
    expect(a.status).toBe(201);
    const daUnidade = async () => idsDe(await get('porteiro', `/autorizacoes-previas?unidadeId=${ids['D-32']}`));
    const deHoje = async () => idsDe(await get('porteiro', '/autorizacoes-previas/hoje'));
    expect(await daUnidade()).toContain(a.body.data.id);
    expect(await deHoje()).toContain(a.body.data.id);
    expect((await post('porteiro', `/autorizacoes-previas/${a.body.data.id}/revogar`)).status).toBe(204);
    expect(await daUnidade()).not.toContain(a.body.data.id);
    expect(await deHoje()).not.toContain(a.body.data.id);

    const vence = await nova('2026-10-17');
    expect(await daUnidade()).toContain(vence.body.data.id);
    await comRelogio(new Date('2026-10-18T12:00:00.000Z'), async () => {
      expect(await daUnidade()).not.toContain(vence.body.data.id);
    });
  });
});

describe('trilha de alterações (RN-11)', () => {
  it('RN-11: pessoa.criar, veiculo.criar, vinculo.aprovar, vinculo.rejeitar, restricao.criar, restricao.aprovar e usuario.reativar vão para o audit_log (migrado do teste do mock)', async () => {
    const ultimo = async (acao: string) => (await trilha(api, acao)).at(-1);

    const pessoaId = await novaPessoa('Proprietária da Trilha');
    expect(await ultimo('pessoa.criar')).toMatchObject({ registroId: pessoaId, entidade: 'pessoa', usuarioId: api.usuarios['paula.nogueira']!.id });

    const ve = await post('administracao', '/veiculos', { unidadeId: ids['A-12'], placa: 'TRL1A23', modelo: 'Onix', cor: 'azul' });
    expect(ve.status).toBe(201);
    expect(await ultimo('veiculo.criar')).toMatchObject({ registroId: ve.body.data.id, entidade: 'veiculo' });

    const v1 = await post('administracao', '/vinculos', { pessoaId, unidadeId: ids['A-12'], tipo: 'proprietario' });
    await post('administracao', `/vinculos/${v1.body.data.id}/conferencias`, { tipo: 'escritura' });
    expect((await post('administracao', `/vinculos/${v1.body.data.id}/aprovar`)).body.data.status).toBe('aprovado');
    expect(await ultimo('vinculo.aprovar')).toMatchObject({ registroId: v1.body.data.id, entidade: 'vinculo_unidade', depois: { status: 'aprovado' } });

    const outra = await novaPessoa('Pedido Rejeitado da Trilha');
    const v2 = await post('administracao', '/vinculos', { pessoaId: outra, unidadeId: ids['A-12'], tipo: 'proprietario' });
    const rej = await post('administracao', `/vinculos/${v2.body.data.id}/rejeitar`, { justificativa: 'Documento apresentado não confere com a matrícula' });
    expect(rej.body.data.status).toBe('rejeitado');
    expect(await ultimo('vinculo.rejeitar')).toMatchObject({ registroId: v2.body.data.id, depois: { status: 'rejeitado' } });

    const rc = await post('porteiro', '/restricoes', { pessoaId: outra, unidadeId: null, motivo: 'Tentou entrar sem autorização', validaAte: '2026-12-31', paraTodoCondominio: true });
    expect(rc.status).toBe(201);
    expect(await ultimo('restricao.criar')).toMatchObject({ registroId: rc.body.data.id, entidade: 'restricao', usuarioPapel: 'porteiro' });
    expect((await post('sindico', `/restricoes/${rc.body.data.id}/aprovar`)).status).toBe(200);
    expect(await ultimo('restricao.aprovar')).toMatchObject({ registroId: rc.body.data.id, usuarioPapel: 'sindico' });

    const u = await post('administracao', '/usuarios', { nome: 'Porteiro da Trilha', login: 'porteiro.trilha', papel: 'porteiro' });
    const uid = u.body.data.usuario.id as string;
    expect((await post('administracao', `/usuarios/${uid}/desativar`)).status).toBe(200);
    expect((await post('administracao', `/usuarios/${uid}/reativar`)).body.data).toMatchObject({ ativo: true });
    expect(await ultimo('usuario.reativar')).toMatchObject({ registroId: uid, entidade: 'usuario_sistema' });
  });
});

describe('contingência e correção de eventos (RNF-05, RN-04)', () => {
  let entradaId: string;

  it('RNF-05: recusa retroativa sem formulário é 422; entrada não retroativa descarta o formulário enviado (migrado do teste do mock)', async () => {
    const recusa = await post('porteiro', '/eventos-acesso/recusas', {
      pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['D-32'], meio: 'interfone', moradorPessoaId: ids['Ana Ribeiro'],
      retroativo: true, ocorridoEm: AGORA.getTime() - 600_000,
    });
    expect(recusa.status).toBe(422);
    expect(recusa.body.code).toBe('FORMULARIO_OBRIGATORIO');
    const r = await entrar(interfone('Bruno Teixeira', 'D-32', 'Ana Ribeiro', { formularioContingencia: 'F-99' }));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ retroativo: false });
    entradaId = r.body.data.id;
    const [linha] = await api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.id, entradaId));
    expect(linha!.formularioContingencia).toBeNull();
    await sair(entradaId);
  });

  it('RN-04: correção com unidade nula (não funcionário) 422; unidade, pessoa e autorizador inexistentes 404 (migrado do teste do mock)', async () => {
    const corrigir = (valores: object) => post('administracao', `/eventos-acesso/${entradaId}/correcoes`, { justificativa: JUST, valores });
    const semUnidade = await corrigir({ unidadeDestinoId: null });
    expect([semUnidade.status, semUnidade.body.code]).toEqual([422, 'UNIDADE_OBRIGATORIA']);
    const unidade = await corrigir({ unidadeDestinoId: NENHUM });
    expect([unidade.status, unidade.body.code]).toEqual([404, 'UNIDADE_NAO_ENCONTRADA']);
    const pessoa = await corrigir({ pessoaId: NENHUM });
    expect([pessoa.status, pessoa.body.code]).toEqual([404, 'PESSOA_NAO_ENCONTRADA']);
    const autorizador = await corrigir({ autorizadoPorPessoaId: NENHUM });
    expect([autorizador.status, autorizador.body.code]).toEqual([404, 'PESSOA_NAO_ENCONTRADA']);
    // Nenhuma das tentativas gravou correção
    expect((await get('auditor', `/eventos-acesso/${entradaId}/correcoes`)).body.data).toHaveLength(0);
  });

  it('RF-30/RN-04: o relatório conta a entrada no dia da data CORRIGIDA, não no do registro (migrado do teste do mock)', async () => {
    const fim = amanhaReal();
    const antes = (await get('auditor', `/relatorios/resumo?de=2026-10-17&ate=${fim}`)).body.data.totais.entradas;
    const c = await post('administracao', `/eventos-acesso/${entradaId}/correcoes`, {
      justificativa: JUST, valores: { ocorridoEm: new Date('2026-10-05T15:00:00.000Z').getTime() },
    });
    expect(c.status).toBe(201);
    const dia = (await get('auditor', '/relatorios/resumo?de=2026-10-05&ate=2026-10-05')).body.data;
    expect(dia.acessosPorDia).toEqual([{ dia: new Date('2026-10-05T03:00:00.000Z').getTime(), entradas: 1 }]);
    expect(dia.totais.entradas).toBe(1);
    expect((await get('auditor', `/relatorios/resumo?de=2026-10-17&ate=${fim}`)).body.data.totais.entradas).toBe(antes - 1);
  });
});

describe('validações de cadastro (RF-14, RF-15, RF-36, RF-03)', () => {
  it('RF-15: restrição com validade no passado é 422 VALIDADE_INVALIDA; validade hoje vale (migrado do teste do mock)', async () => {
    const restricao = (validaAte: string) => post('porteiro', '/restricoes', {
      pessoaId: ids['Técnico Enel — Diego Santos'], unidadeId: ids['I-13'], motivo: 'Comportamento inadequado', validaAte, solicitadaPorPessoaId: ids['Marta Siqueira'],
    });
    const passado = await restricao('2026-10-16');
    expect([passado.status, passado.body.code]).toEqual([422, 'VALIDADE_INVALIDA']);
    expect((await restricao('2026-10-17')).status).toBe(201);
  });

  it('RN-07: autorização com início depois do fim é 422 PERIODO_INVALIDO (migrado do teste do mock)', async () => {
    const r = await post('porteiro', '/autorizacoes-previas', {
      unidadeId: ids['D-32'], pessoaId: ids['Bruno Teixeira'], validaDe: '2026-10-25', validaAte: '2026-10-20', solicitadaPorPessoaId: ids['Ana Ribeiro'],
    });
    expect([r.status, r.body.code]).toEqual([422, 'PERIODO_INVALIDO']);
  });

  it('RF-36: autorização de área comum com morador solicitante é 422 AREA_COMUM_SEM_SOLICITANTE (migrado do teste do mock)', async () => {
    const r = await post('administracao', '/autorizacoes-previas', {
      unidadeId: null, areaComumId: ids.salao, pessoaId: ids['Juliana Costa'], validaAte: '2026-10-20', solicitadaPorPessoaId: ids['Ana Ribeiro'],
    });
    expect([r.status, r.body.code]).toEqual([422, 'AREA_COMUM_SEM_SOLICITANTE']);
  });

  it('RF-03: vínculo novo em unidade desativada é 422 UNIDADE_INATIVA (migrado do teste do mock)', async () => {
    const pessoaId = await novaPessoa('Pedido em Unidade Desativada');
    expect((await post('administracao', `/unidades/${ids['A-13']}/desativar`)).status).toBe(200);
    try {
      const r = await post('administracao', '/vinculos', { pessoaId, unidadeId: ids['A-13'], tipo: 'proprietario' });
      expect([r.status, r.body.code]).toEqual([422, 'UNIDADE_INATIVA']);
    } finally { await post('administracao', `/unidades/${ids['A-13']}/reativar`); }
  });
});

describe('relatório: período padrão e filtro por categoria (RF-30)', () => {
  it('RF-30: sem de/ate o período é os últimos 30 dias até hoje (migrado do teste do mock)', async () => {
    const r = (await get('auditor', '/relatorios/resumo')).body.data;
    expect(r.acessosPorDia).toHaveLength(30);
    expect(r.acessosPorDia[0].dia).toBe(new Date('2026-09-18T03:00:00.000Z').getTime());
    expect(r.acessosPorDia.at(-1).dia).toBe(new Date('2026-10-17T03:00:00.000Z').getTime());
    expect(r.periodo.de).toBe(new Date('2026-09-18T03:00:00.000Z').getTime());
  });

  it('RF-30: filtro categoria=prestador conta só as entradas de prestador (migrado do teste do mock)', async () => {
    const e = await entrar({ pessoaId: ids['Juliana Costa'], unidadeDestinoId: ids['I-13'], autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
    expect(e.status).toBe(201);
    await sair(e.body.data.id);
    const fim = amanhaReal();
    const todos = (await get('auditor', `/relatorios/resumo?de=2026-10-17&ate=${fim}`)).body.data;
    const prest = (await get('auditor', `/relatorios/resumo?de=2026-10-17&ate=${fim}&categoria=prestador`)).body.data;
    const [{ n }] = await api.db.select({ n: count() }).from(s.eventoAcesso)
      .where(and(eq(s.eventoAcesso.tipo, 'entrada'), eq(s.eventoAcesso.categoriaPessoa, 'prestador'))) as [{ n: number }];
    expect(prest.totais.entradas).toBe(Number(n));
    expect(prest.totais.entradas).toBeGreaterThanOrEqual(1);
    expect(prest.totais.entradas).toBeLessThan(todos.totais.entradas);
  });
});

describe('permissões (RN-03, spec §5.2)', () => {
  it('RN-03: porteiro não aprova vínculo (403) (migrado do teste do mock)', async () => {
    const [v] = await api.db.select().from(s.vinculoUnidade)
      .where(and(eq(s.vinculoUnidade.pessoaId, ids['Rafael Mendes']!), eq(s.vinculoUnidade.unidadeId, ids['G-11']!)));
    expect((await post('porteiro', `/vinculos/${v!.id}/aprovar`)).status).toBe(403);
    const [depois] = await api.db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.id, v!.id));
    expect(depois!.status).toBe('pendente');
  });

  it('spec §5.2: ninguém altera o próprio papel (422 AUTO_ALTERACAO_PAPEL) (migrado do teste do mock)', async () => {
    const r = await patch('administracao', `/usuarios/${api.usuarios['paula.nogueira']!.id}`, { papel: 'auditor' });
    expect([r.status, r.body.code]).toEqual([422, 'AUTO_ALTERACAO_PAPEL']);
  });
});
