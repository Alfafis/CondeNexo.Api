import { describe, expect, it } from 'vitest';
import {
  acharUnidadePorTexto, andarDoNumero, chaveBloco, codigoUnidade, compararBlocos, doAgrupamento, nesteAgrupamento, gerarUnidades, leiturasDoCodigo, normalizarBloco, normalizarNumero,
  parseCodigoUnidade, rotuloUnidade, validarEstruturaUnidade, type ConfigEstrutura,
} from '../../src/dominio/units';
import {
  cadastroCompleto, descreverJanela, elegivelRetencao, escalaVigente, estadoAutorizacaoPrevia, legadoVencido, proximaJanelaAutorizacao, meiosAceitos,
  meioComMorador, MEIOS_COM_MORADOR, pessoaDesativada, podeEntregarEncomenda, restricoesVigentes, validarDesativacaoPessoa, SENHA_TEMPORARIA_VALIDADE_MS, senhaTemporariaVencida, validarAutorizacaoEntrada, validarConferencia, validarDecisaoVinculo, validarEscala, vinculoValido,
} from '../../src/dominio/rules';
import { brt, HORA, menosAnos } from '../../src/dominio/time';
import { MATRIZ } from '../../src/dominio/rbac';
import type { AutorizacaoPrevia, Funcionario, Pessoa, VinculoUnidade } from '../../src/dominio/types';
import { calcularHashExportado, codigoEvento, hashGenese, jsonCanonico, jsonCanonicoV1, verificarCadeia, type EventoExportado } from '../../src/dominio/hashChain';
import { normalizarPlaca } from '../../src/dominio/cpf';

describe('unidades', () => {
  it('estrutura padrão: 9 blocos (A a I) x 18 unidades = 162 (térreo só com 03 e 04, provisório)', () => {
    const us = gerarUnidades();
    expect(us.length).toBe(162);
    expect(new Set(us.map((u) => u.bloco))).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']));
    expect(us.filter((u) => u.bloco === 'A').map((u) => u.numero)).toEqual([
      '03', '04', '11', '12', '13', '14', '21', '22', '23', '24', '31', '32', '33', '34', '41', '42', '43', '44',
    ]);
    const codigos = new Set(us.map(codigoUnidade));
    expect(codigos.size).toBe(162);
    expect(codigos.has('D-32')).toBe(true);
    expect(codigos.has('A-01')).toBe(false);
    expect(codigos.has('A-51')).toBe(false);
    expect(codigos.has('J-11')).toBe(false);
  });

  it('configuração: ausente geral ou por bloco, agrupamento e ordem natural dos blocos', () => {
    const base: ConfigEstrutura = { agrupamento: 'Torre', blocos: ['10', '2', 'b', 'A'], andares: [0, 1], finais: [1, 2], ausentes: [] };
    expect(gerarUnidades(base).map(codigoUnidade)).toEqual([
      '2-01', '2-02', '2-11', '2-12', '10-01', '10-02', '10-11', '10-12', 'A-01', 'A-02', 'A-11', 'A-12', 'B-01', 'B-02', 'B-11', 'B-12',
    ]);
    const com = gerarUnidades({ ...base, ausentes: ['1', 'B-12'] }).map(codigoUnidade);
    expect(com).toHaveLength(16 - 4 - 1);
    expect(com).not.toContain('A-01');
    expect(com).not.toContain('B-12');
    expect(com).toContain('A-12');
    expect(() => gerarUnidades({ ...base, ausentes: ['A-99'] })).toThrow(/ausente/);
    expect(() => gerarUnidades({ ...base, blocos: ['A', 'a'] })).toThrow(/repetido/);
    expect(() => gerarUnidades({ ...base, blocos: ['ABCD'] })).toThrow(/formato/);
    expect(() => gerarUnidades({ ...base, andares: [10] })).toThrow(/andar/);
    expect(() => gerarUnidades({ ...base, finais: [0] })).toThrow(/final/);
    expect(['B10', 'C', 'B2', '10', 'A', '2'].sort(compararBlocos)).toEqual(['2', '10', 'A', 'B2', 'B10', 'C']);
    expect(chaveBloco('B2')).toBe('B002');
  });

  it('código "A-32" e rótulo pelo agrupamento configurado', () => {
    expect(codigoUnidade({ bloco: 'A', numero: '32' })).toBe('A-32');
    expect(rotuloUnidade({ bloco: 'A', numero: '32' }, 'Bloco')).toBe('BLOCO A · AP 32');
    expect(rotuloUnidade({ bloco: '4', numero: '03' }, 'Torre', false)).toBe('Torre 4 · AP 03');
  });

  it('número normalizado com 2 dígitos no mínimo: "3" e "03" são a mesma unidade', () => {
    expect(normalizarNumero('3')).toBe('03');
    expect(normalizarNumero(' 03 ')).toBe('03');
    expect(normalizarNumero('032')).toBe('32');
    expect(normalizarNumero('101')).toBe('101');
    expect(normalizarNumero('0')).toBe('00');
    expect(normalizarNumero('3a')).toBe('3a');
    expect(normalizarBloco(' b2 ')).toBe('B2');
    expect(validarEstruturaUnidade('A', '03')).toBeNull();
    expect(validarEstruturaUnidade('B2', '101')).toBeNull();
    expect(validarEstruturaUnidade('a', '03')).not.toBeNull(); // espera valor já normalizado
    expect(validarEstruturaUnidade('ABCD', '11')).not.toBeNull();
    expect(validarEstruturaUnidade('', '11')).not.toBeNull();
    expect(validarEstruturaUnidade('A', '3')).not.toBeNull();
    expect(validarEstruturaUnidade('A', '00')).not.toBeNull();
    expect(validarEstruturaUnidade('A', '3a')).not.toBeNull();
    expect(validarEstruturaUnidade('A', '10000')).not.toBeNull();
    expect(validarEstruturaUnidade('#', '11', 'Torre')).toMatch(/^A torre deve/);
    expect(validarEstruturaUnidade('#', '11')).toMatch(/^O bloco deve/);
    expect([doAgrupamento('Bloco'), nesteAgrupamento('Torre')]).toEqual(['do bloco', 'nesta torre']);
  });

  it('busca por texto: separador obrigatório, maiúsculas, compatibilidade com "T4-32" e "Bloco A 32"', () => {
    expect(parseCodigoUnidade('A-32')).toEqual({ bloco: 'A', numero: '32' });
    expect(parseCodigoUnidade('a 32')).toEqual({ bloco: 'A', numero: '32' });
    expect(parseCodigoUnidade('A/32')).toEqual({ bloco: 'A', numero: '32' });
    expect(parseCodigoUnidade('4-32')).toEqual({ bloco: '4', numero: '32' });
    expect(parseCodigoUnidade('b2-3')).toEqual({ bloco: 'B2', numero: '03' });
    expect(parseCodigoUnidade('Bloco A 32')).toEqual({ bloco: 'A', numero: '32' });
    expect(parseCodigoUnidade('BLOCO A · AP 32')).toEqual({ bloco: 'A', numero: '32' });
    expect(parseCodigoUnidade('Torre 4 · AP 32')).toEqual({ bloco: '4', numero: '32' });
    expect(leiturasDoCodigo('T4-32')).toEqual([{ bloco: 'T4', numero: '32' }, { bloco: '4', numero: '32' }]);
    expect(parseCodigoUnidade('432')).toBeNull();
    expect(parseCodigoUnidade('A32')).toBeNull();
    expect(parseCodigoUnidade('A-0')).toBeNull();
    expect(parseCodigoUnidade('Ana')).toBeNull();
    const lista = [
      { id: 'uuid-a', bloco: 'D', numero: '32', ativo: true }, { id: 'uuid-b', bloco: 'A', numero: '03', ativo: true },
      { id: 'uuid-c', bloco: '4', numero: '32', ativo: true },
    ];
    expect(acharUnidadePorTexto(lista, 'd-32')?.id).toBe('uuid-a');
    expect(acharUnidadePorTexto(lista, 'A-3')?.id).toBe('uuid-b');
    expect(acharUnidadePorTexto(lista, 'T4-32')?.id).toBe('uuid-c');
    expect(acharUnidadePorTexto([...lista, { id: 'uuid-t', bloco: 'T4', numero: '32', ativo: true }], 'T4-32')?.id).toBe('uuid-t');
    expect(acharUnidadePorTexto(lista, 'D-33')).toBeUndefined();
    expect(andarDoNumero('32')).toBe(3);
    expect(andarDoNumero('03')).toBe(0);
    expect(andarDoNumero('101')).toBe(1);
  });

  it('código do evento deriva de seq', () => {
    expect(codigoEvento(42)).toBe('EV-000042');
  });
});

describe('regras puras', () => {
  const ap: AutorizacaoPrevia = {
    id: 'a', unidadeId: 'T4-32', pessoaId: 'p', validaDe: brt(2026, 9, 1), validaAte: brt(2026, 11, 30, 23, 59), diasSemana: [1, 2, 3, 4, 5],
    horaInicio: '08:00', horaFim: '18:00', cadastradaPorId: 'u', cadastradaEm: 0, solicitadaPorPessoaId: 'm', areaComumId: null,
    semSolicitante: false, justificativa: null, revogadaEm: null, revogadaPorId: null,
  };
  it('autorização prévia: validade, dia da semana e horário', () => {
    expect(estadoAutorizacaoPrevia(ap, brt(2026, 10, 9, 14, 32))).toBe('valida'); // sexta
    expect(estadoAutorizacaoPrevia(ap, brt(2026, 10, 10, 14, 32))).toBe('fora_da_janela'); // sábado
    expect(estadoAutorizacaoPrevia(ap, brt(2026, 10, 9, 19, 0))).toBe('fora_da_janela');
    expect(estadoAutorizacaoPrevia(ap, brt(2026, 12, 1, 10, 0))).toBe('expirada');
    expect(estadoAutorizacaoPrevia({ ...ap, revogadaEm: 1 }, brt(2026, 10, 9, 14, 32))).toBe('revogada');
    expect(descreverJanela(ap)).toBe('seg a sex, 8h–18h');
  });

  it('próxima janela da autorização prévia (horizonte)', () => {
    const H12 = 12 * HORA;
    const sexta = (hh: number, mm = 0) => brt(2026, 10, 9, hh, mm);
    // janela diária seg-sex 8h-18h; sexta 14:32 -> em curso (inicio no passado, fim 18:00:59.999)
    expect(proximaJanelaAutorizacao(ap, sexta(14, 32), H12)).toEqual({ inicio: sexta(8), fim: sexta(18) + 59_999 });
    // sexta 19:00 -> próxima janela só na segunda 8h: fora de 12 h (19:00 + 12 h = 07:00 de sábado)
    expect(proximaJanelaAutorizacao(ap, sexta(19), H12)).toBeNull();
    // quinta 22:00 -> sexta 8h entra no horizonte (até 10:00)
    const quinta22 = brt(2026, 10, 8, 22);
    expect(proximaJanelaAutorizacao(ap, quinta22, H12)).toEqual({ inicio: sexta(8), fim: sexta(18) + 59_999 });
    // sábado 20:00: segunda 8h fica fora do horizonte de 12 h, mas dentro de 24 h não (segunda 8h = +36 h)
    expect(proximaJanelaAutorizacao(ap, brt(2026, 10, 10, 20), 24 * HORA)).toBeNull();
    // dia da semana fora: autorização só às quartas, hoje é sexta
    expect(proximaJanelaAutorizacao({ ...ap, diasSemana: [3] }, sexta(9), H12)).toBeNull();
    // sem janela de horário: o dia inteiro vale; sem dias: todos
    const diaTodo = { ...ap, diasSemana: null, horaInicio: null, horaFim: null };
    expect(proximaJanelaAutorizacao(diaTodo, sexta(23), H12)).toEqual({ inicio: brt(2026, 10, 9), fim: brt(2026, 10, 10) - 1 });
    // janela diária: se hoje já passou, a de amanhã entra no horizonte
    const diaria = { ...ap, diasSemana: null, horaInicio: '06:00', horaFim: '10:00' };
    expect(proximaJanelaAutorizacao(diaria, sexta(20), H12)).toEqual({ inicio: brt(2026, 10, 10, 6), fim: brt(2026, 10, 10, 10) + 59_999 });
    // validaAte no meio do horizonte recorta o fim; validaAte antes do início da janela exclui
    const ate = brt(2026, 10, 9, 16, 0);
    expect(proximaJanelaAutorizacao({ ...ap, validaAte: ate }, sexta(14), H12)).toEqual({ inicio: sexta(8), fim: ate });
    expect(proximaJanelaAutorizacao({ ...ap, validaAte: brt(2026, 10, 9, 7) }, sexta(6), H12)).toBeNull();
    // validaDe no futuro dentro do horizonte recorta o início
    const de = brt(2026, 10, 9, 12);
    expect(proximaJanelaAutorizacao({ ...ap, validaDe: de }, sexta(6), H12)).toEqual({ inicio: de, fim: sexta(18) + 59_999 });
    // validaDe depois do horizonte
    expect(proximaJanelaAutorizacao({ ...ap, validaDe: brt(2026, 10, 12) }, sexta(6), H12)).toBeNull();
    // revogada
    expect(proximaJanelaAutorizacao({ ...ap, revogadaEm: 1 }, sexta(14), H12)).toBeNull();
    // virada de meia-noite (horaFim < horaInicio) não é suportada
    expect(proximaJanelaAutorizacao({ ...ap, diasSemana: null, horaInicio: '22:00', horaFim: '02:00' }, sexta(21), H12)).toBeNull();
    // coerente com estadoAutorizacaoPrevia: 'valida' agora <=> janela em curso
    expect(estadoAutorizacaoPrevia(ap, sexta(18, 0) + 59_999)).toBe('valida');
    expect(proximaJanelaAutorizacao(ap, sexta(18, 0) + 59_999, 0)).not.toBeNull();
    expect(estadoAutorizacaoPrevia(ap, sexta(18, 1))).toBe('fora_da_janela');
    expect(proximaJanelaAutorizacao(ap, sexta(18, 1), 0)).toBeNull();
  });

  const v = (x: Partial<VinculoUnidade>): VinculoUnidade => ({
    id: 'v', pessoaId: 'p', unidadeId: 'T4-32', tipo: 'proprietario', status: 'aprovado', vigenciaInicio: null, vigenciaFim: null,
    prazoRegularizacao: null, conferencia: null, solicitadoPor: '', solicitadoEm: 0, registradoPorId: 'u', encerradoEm: null, ...x,
  });
  it('vínculo válido = aprovado ou legado dentro do prazo', () => {
    const hoje = brt(2026, 10, 9, 14, 32);
    expect(vinculoValido(v({}), hoje)).toBe(true);
    expect(vinculoValido(v({ status: 'pendente' }), hoje)).toBe(false);
    expect(vinculoValido(v({ status: 'rejeitado' }), hoje)).toBe(false);
    expect(vinculoValido(v({ status: 'legado', prazoRegularizacao: brt(2027, 3, 31) }), hoje)).toBe(true);
    expect(vinculoValido(v({ status: 'legado', prazoRegularizacao: brt(2026, 9, 30) }), hoje)).toBe(false);
    expect(vinculoValido(v({ vigenciaFim: brt(2026, 10, 8) }), hoje)).toBe(false);
  });

  it('meio "escala" só aparece para funcionário', () => {
    expect(meiosAceitos('funcionario')).toContain('escala');
    expect(meiosAceitos('prestador')).not.toContain('escala');
    expect(meiosAceitos('visitante')).not.toContain('escala');
  });

  it('meio "celular" (WhatsApp ou ligação): mesma regra do interfone, morador identificado e com vínculo válido', () => {
    expect(meiosAceitos('visitante')).toEqual(['interfone', 'celular', 'morador_presente', 'autorizacao_previa', 'excecao_porteiro']);
    expect(meiosAceitos('prestador', 'area_comum')).not.toContain('celular');
    expect(MEIOS_COM_MORADOR).toEqual(['interfone', 'celular', 'morador_presente']);
    expect(meioComMorador('celular')).toBe(true);
    expect(meioComMorador('excecao_porteiro')).toBe(false);
    expect(meioComMorador(null)).toBe(false);
    const ctx = { quando: brt(2026, 10, 9, 10), moradoresValidosIds: new Set(['ana']), autorizacoes: [] };
    const base = { categoriaPessoa: 'visitante' as const, unidadeDestinoId: 'u', autorizadoPorTipo: 'celular' as const };
    expect(validarAutorizacaoEntrada(base, ctx)?.code).toBe('AUTORIZADO_POR_SEM_IDENTIFICACAO');
    expect(validarAutorizacaoEntrada({ ...base, autorizadoPorPessoaId: 'outro' }, ctx)?.code).toBe('AUTORIZADOR_SEM_VINCULO');
    expect(validarAutorizacaoEntrada({ ...base, autorizadoPorPessoaId: 'ana' }, ctx)).toBeNull();
    expect(validarAutorizacaoEntrada({ ...base, autorizadoPorPessoaId: 'ana', semCpf: true }, ctx)?.code).toBe('SEM_CPF_SO_EXCECAO');
  });

  it('decisão de vínculo', () => {
    const c = { tipoDocumento: 'escritura' as const, data: 0, conferidoPorId: 'u' };
    expect(validarDecisaoVinculo('aprovar', '', null)?.code).toBe('CONFERENCIA_OBRIGATORIA');
    expect(validarDecisaoVinculo('aprovar', '', c)).toBeNull();
    expect(validarDecisaoVinculo('rejeitar', '', c)?.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
  });

  it('conferência do comprovante (RF-05)', () => {
    const hoje = brt(2026, 10, 9, 14, 32);
    const ok = { tipo: 'contrato_locacao', data: brt(2026, 10, 9) };
    expect(validarConferencia(ok, hoje)).toBeNull();
    expect(validarConferencia({ ...ok, tipo: 'rg' }, hoje)?.code).toBe('TIPO_COMPROVANTE_INVALIDO');
    expect(validarConferencia({ ...ok, tipo: 'outro' }, hoje)?.code).toBe('DESCRICAO_OBRIGATORIA');
    expect(validarConferencia({ ...ok, tipo: 'outro', descricao: 'Formal de partilha' }, hoje)).toBeNull();
    expect(validarConferencia({ ...ok, observacao: 'x'.repeat(201) }, hoje)?.code).toBe('OBSERVACAO_LONGA');
    expect(validarConferencia({ ...ok, observacao: 'CPF 529.982.247-25' }, hoje)?.code).toBe('DADO_PESSOAL_NA_CONFERENCIA');
    expect(validarConferencia({ ...ok, observacao: '(11) 98765-4321' }, hoje)?.code).toBe('DADO_PESSOAL_NA_CONFERENCIA');
    expect(validarConferencia({ ...ok, observacao: 'Recebido por e-mail em 01/10/2026' }, hoje)).toBeNull();
    expect(validarConferencia({ ...ok, data: brt(2026, 10, 10) }, hoje)?.code).toBe('DATA_FUTURA');
  });

  it('restrição de condomínio pendente não vigora', () => {
    const r = { id: 'r', escopo: 'condominio' as const, unidadeId: 'T1-11', pessoaId: 'p', motivo: 'm', validaAte: brt(2026, 12, 31), cadastradaPorId: 'u', cadastradaEm: 0, solicitadaPorPessoaId: null, aprovadaPorId: null, aprovadaEm: null, revogadaEm: null, revogadaPorId: null };
    expect(restricoesVigentes([r], 'p', 'I-11', brt(2026, 10, 9))).toHaveLength(0);
    expect(restricoesVigentes([{ ...r, aprovadaEm: 1 }], 'p', 'I-11', brt(2026, 10, 9))).toHaveLength(1);
  });

  it('RF-36: área comum só para prestador, por autorização prévia ou exceção', () => {
    expect(meiosAceitos('prestador', 'area_comum')).toEqual(['autorizacao_previa', 'excecao_porteiro']);
    const ctx = { quando: brt(2026, 10, 9, 10), moradoresValidosIds: new Set<string>(), autorizacoes: [] };
    const just = 'Manutenção da bomba da piscina';
    expect(validarAutorizacaoEntrada({ categoriaPessoa: 'visitante', areaComumId: 'a', autorizadoPorTipo: 'excecao_porteiro', justificativa: just }, ctx)?.code)
      .toBe('AREA_COMUM_SO_PRESTADOR');
    expect(validarAutorizacaoEntrada({ categoriaPessoa: 'prestador', areaComumId: 'a', autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: 'm' }, ctx)?.code)
      .toBe('MEIO_INVALIDO_PARA_TIPO');
    expect(validarAutorizacaoEntrada({ categoriaPessoa: 'prestador', areaComumId: 'a', unidadeDestinoId: 'u' }, ctx)?.code).toBe('DESTINO_DUPLO');
    expect(validarAutorizacaoEntrada({ categoriaPessoa: 'prestador', areaComumId: 'a', autorizadoPorTipo: 'excecao_porteiro', justificativa: just }, ctx)).toBeNull();
  });

  it('RN-08: entrega por vínculo válido ou por autorização de retirada', () => {
    const hoje = brt(2026, 10, 9, 14, 32);
    expect(podeEntregarEncomenda([v({})], 'p', 'T4-32', hoje)).toEqual({ ok: true, por: 'vinculo' });
    expect(podeEntregarEncomenda([], 'p', 'T4-32', hoje, true)).toEqual({ ok: true, por: 'autorizacao' });
    expect(podeEntregarEncomenda([], 'p', 'T4-32', hoje, false, 'T4-32')).toMatchObject({ ok: false });
  });

  it('cadastro completo e legado vencido', () => {
    const p = { semCpf: false, documentoBusca: 'h', telefone: '11912345678', anonimizadaEm: null };
    expect(cadastroCompleto(p)).toBe(true);
    expect(cadastroCompleto({ ...p, telefone: '1234' })).toBe(false);
    expect(cadastroCompleto({ ...p, semCpf: true })).toBe(false);
    expect(cadastroCompleto({ ...p, anonimizadaEm: 1 })).toBe(false);
    const hoje = brt(2026, 10, 9);
    expect(legadoVencido(v({ status: 'legado', prazoRegularizacao: brt(2026, 9, 30) }), hoje)).toBe(true);
    expect(legadoVencido(v({ status: 'legado', prazoRegularizacao: brt(2027, 3, 31) }), hoje)).toBe(false);
  });
});

describe('retenção (RNF-09)', () => {
  const v = (x: Partial<VinculoUnidade>): VinculoUnidade => ({
    id: 'v', pessoaId: 'p', unidadeId: 'u', tipo: 'proprietario', status: 'aprovado', vigenciaInicio: null, vigenciaFim: null,
    prazoRegularizacao: null, conferencia: null, solicitadoPor: '', solicitadoEm: 0, registradoPorId: 'u', encerradoEm: null, ...x,
  });
  const hoje = brt(2026, 10, 9, 14, 32);
  const pessoa = (categoria: Pessoa['categoria'], criadoEm = brt(2020, 1, 1)) => ({ categoria, anonimizadaEm: null, criadoEm });
  it('3 anos de calendário', () => {
    expect(menosAnos(hoje, 3)).toBe(brt(2023, 10, 9, 14, 32));
    expect(menosAnos(brt(2028, 2, 29), 3)).toBe(brt(2025, 2, 28));
  });
  it('visitante/prestador pelo último acesso; morador pelo fim do último vínculo', () => {
    expect(elegivelRetencao(pessoa('visitante'), [], brt(2023, 1, 1), hoje)).toBe(true);
    expect(elegivelRetencao(pessoa('visitante'), [], brt(2024, 1, 1), hoje)).toBe(false);
    expect(elegivelRetencao(pessoa('prestador'), [], null, hoje)).toBe(true); // nunca entrou: conta do cadastro
    const enc = (fim: number) => v({ status: 'encerrado', encerradoEm: fim });
    expect(elegivelRetencao(pessoa('morador'), [enc(brt(2023, 6, 30))], null, hoje)).toBe(true);
    expect(elegivelRetencao(pessoa('morador'), [enc(brt(2023, 6, 30)), enc(brt(2024, 1, 1))], null, hoje)).toBe(false);
    expect(elegivelRetencao(pessoa('morador'), [enc(brt(2023, 6, 30)), v({ status: 'aprovado' })], null, hoje)).toBe(false);
    expect(elegivelRetencao(pessoa('funcionario'), [], null, hoje)).toBe(false);
    expect(elegivelRetencao({ ...pessoa('visitante'), anonimizadaEm: 1 }, [], null, hoje)).toBe(false);
  });
});

describe('escalaVigente (RF-09)', () => {
  it('validarEscala: dias, formato e início diferente do fim (inclusive turno que atravessa a meia-noite)', () => {
    expect(validarEscala({ diasSemana: [1, 2], horaInicio: '22:00', horaFim: '06:00' })).toBeNull();
    expect(validarEscala({ diasSemana: [], horaInicio: '08:00', horaFim: '18:00' })).not.toBeNull();
    expect(validarEscala({ diasSemana: [7], horaInicio: '08:00', horaFim: '18:00' })).not.toBeNull();
    expect(validarEscala({ diasSemana: [1], horaInicio: '08:00', horaFim: '08:00' })).not.toBeNull();
    expect(validarEscala({ diasSemana: [1], horaInicio: '8h', horaFim: '18:00' })).not.toBeNull();
  });
  const f = (dias: number[], horaInicio: string, horaFim: string): Funcionario => ({ pessoaId: 'p', funcao: 'Zelador', escala: { diasSemana: dias, horaInicio, horaFim }, ativo: true });
  it('escala diurna: só no dia e dentro do horário', () => {
    const diurna = f([1, 2, 3, 4, 5], '08:00', '18:00');
    expect(escalaVigente(diurna, brt(2026, 10, 9, 10, 0))).toBe(true); // sexta
    expect(escalaVigente(diurna, brt(2026, 10, 9, 19, 0))).toBe(false);
    expect(escalaVigente(diurna, brt(2026, 10, 10, 10, 0))).toBe(false); // sábado
  });
  it('escala que atravessa a meia-noite vale no dia do início do turno', () => {
    const noturna = f([1, 2, 3, 4, 5], '22:00', '06:00'); // seg a sex à noite
    expect(escalaVigente(noturna, brt(2026, 10, 9, 23, 0))).toBe(true); // sex 23h (início sexta)
    expect(escalaVigente(noturna, brt(2026, 10, 10, 3, 0))).toBe(true); // sáb 3h: ainda é o turno de sexta
    expect(escalaVigente(noturna, brt(2026, 10, 10, 23, 0))).toBe(false); // sáb 23h: sábado não está na escala
    expect(escalaVigente(noturna, brt(2026, 10, 12, 3, 0))).toBe(false); // seg 3h: seria turno de domingo
    expect(escalaVigente(noturna, brt(2026, 10, 12, 23, 0))).toBe(true); // seg 23h
    expect(escalaVigente(noturna, brt(2026, 10, 9, 3, 0))).toBe(true); // sex 3h: turno de quinta
    expect(escalaVigente(noturna, brt(2026, 10, 9, 12, 0))).toBe(false); // meio-dia fora do turno
  });
  it('funcionário inativo ou ausente nunca tem escala vigente', () => {
    expect(escalaVigente({ ...f([5], '22:00', '06:00'), ativo: false }, brt(2026, 10, 9, 23, 0))).toBe(false);
    expect(escalaVigente(undefined, brt(2026, 10, 9, 23, 0))).toBe(false);
  });
});

describe('senha temporária (spec §5.1)', () => {
  const t0 = brt(2026, 10, 19, 10, 0);
  it('vale 72 h e vence no instante exato do prazo', () => {
    expect(SENHA_TEMPORARIA_VALIDADE_MS).toBe(72 * HORA);
    const u = { deveTrocarSenha: true, senhaTemporariaExpiraEm: t0 + SENHA_TEMPORARIA_VALIDADE_MS };
    expect(senhaTemporariaVencida(u, t0 + SENHA_TEMPORARIA_VALIDADE_MS - 1)).toBe(false);
    expect(senhaTemporariaVencida(u, t0 + SENHA_TEMPORARIA_VALIDADE_MS)).toBe(true);
  });
  it('sem troca pendente nunca vence; troca pendente sem prazo conta como vencida (falha fechada)', () => {
    expect(senhaTemporariaVencida({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }, t0)).toBe(false);
    expect(senhaTemporariaVencida({}, t0)).toBe(false);
    expect(senhaTemporariaVencida({ deveTrocarSenha: true, senhaTemporariaExpiraEm: null }, t0)).toBe(true);
  });
});

describe('verificarCadeia (RF-37)', () => {
  /** Cadeia de `n` eventos válida a partir da gênese (mesma serialização do trigger do banco). */
  async function cadeia(n: number): Promise<EventoExportado[]> {
    const evs: EventoExportado[] = [];
    let anterior = await hashGenese();
    for (let seq = 1; seq <= n; seq++) {
      const e: EventoExportado = {
        v: 1, seq, id: `00000000-0000-4000-8000-00000000000${seq}`, tipo: 'entrada', categoria_pessoa: 'visitante',
        pessoa_id: 'p1', unidade_destino_id: 'u1', area_comum_id: null, ponto_acesso_id: 'pa', autorizado_por_tipo: 'interfone',
        autorizado_por_pessoa_id: 'm1', autorizacao_previa_id: null, justificativa: null, restricao_id: null, operador_id: 'o1',
        operador_papel: 'porteiro', ocorrido_em: new Date(brt(2026, 10, 17, 9, seq)).toISOString(),
        registrado_em: new Date(brt(2026, 10, 17, 9, seq)).toISOString(), retroativo: false, formulario_contingencia: null,
        refere_evento_id: null, corrige_evento_id: null, correcao_valores: null, empresa: null, servico: null, observacao: null,
        hash_anterior: anterior, hash: '',
      };
      e.hash = await calcularHashExportado(e);
      anterior = e.hash;
      evs.push(e);
    }
    return evs;
  }

  it('hash_anterior adulterado (com o hash recalculado) é hash_anterior_incoerente no seq dele (migrado do teste do mock)', async () => {
    const evs = await cadeia(3);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: 3 });
    // O hash do próprio evento confere (recalculado), mas o encadeamento com o anterior está quebrado
    const adulterado = { ...evs[1]!, hash_anterior: 'f'.repeat(64) };
    adulterado.hash = await calcularHashExportado(adulterado);
    const r = await verificarCadeia([evs[0]!, adulterado, evs[2]!]);
    expect(r).toMatchObject({ valido: false, motivo: 'hash_anterior_incoerente', primeiroSeqInvalido: 2, verificados: 1, ultimoSeq: 1, ultimoHash: evs[0]!.hash });
  });

  /** Refaz o hash do evento k e encadeia os seguintes (o que um verificador honesto calcularia). */
  async function reencadear(evs: EventoExportado[]) {
    let anterior = await hashGenese();
    for (const e of evs) { e.hash_anterior = anterior; e.hash = await calcularHashExportado(e); anterior = e.hash; }
    return evs;
  }

  it('formato 2 (entrada com veículo): v1 + veiculo_placa, veiculo_modelo, veiculo_cor no fim; a v1 não muda', async () => {
    const [e1] = await cadeia(1);
    const v1 = jsonCanonico(e1!);
    expect(v1).toBe(jsonCanonicoV1(e1!));
    expect(v1).not.toContain('veiculo');
    const v2 = jsonCanonico({ ...e1!, v: 2, veiculo_placa: 'ABC1D23', veiculo_modelo: null, veiculo_cor: 'Prata' });
    expect(v2).toBe(`{"v":2${v1.slice('{"v":1'.length, -1)},"veiculo_placa":"ABC1D23","veiculo_modelo":null,"veiculo_cor":"Prata"}`);
    expect(() => jsonCanonicoV1({ ...e1!, v: 2, veiculo_placa: 'ABC1D23' })).toThrow(/não suportado/);
    // cadeia mista verifica
    const evs = await cadeia(3);
    Object.assign(evs[1]!, { v: 2, veiculo_placa: 'ABC1234', veiculo_modelo: 'Onix', veiculo_cor: null });
    await reencadear(evs);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: 3 });
  });

  it('recusa o que o banco nunca grava (v1 com veículo, v2 sem placa, formato desconhecido) como hash_divergente', async () => {
    for (const mudar of [
      (e: EventoExportado) => Object.assign(e, { veiculo_placa: 'ABC1234' }), // v1 com veículo
      (e: EventoExportado) => Object.assign(e, { veiculo_modelo: 'Onix' }),
      (e: EventoExportado) => Object.assign(e, { v: 2 }), // v2 sem placa
      (e: EventoExportado) => Object.assign(e, { v: 3, veiculo_placa: 'ABC1234' }),
    ]) {
      const evs = await cadeia(2);
      mudar(evs[1]!);
      evs[1]!.hash = await calcularHashExportado({ ...evs[1]!, v: 1, veiculo_placa: null, veiculo_modelo: null, veiculo_cor: null });
      expect(await verificarCadeia(evs)).toMatchObject({ valido: false, motivo: 'hash_divergente', primeiroSeqInvalido: 2 });
    }
  });
});

describe('normalizarPlaca (veículo do morador e da entrada)', () => {
  it('antiga e Mercosul, com hífen, espaço ou minúscula; null fora do padrão', () => {
    expect(['abc1234', 'ABC-1234', ' abc 1d23 ', 'ABC1D23'].map(normalizarPlaca)).toEqual(['ABC1234', 'ABC1234', 'ABC1D23', 'ABC1D23']);
    expect(['', null, undefined, 'AB12345', 'ABCD123', 'ABC12', '1234567', 'ABC1D2Z', 'ABC1D234'].map(normalizarPlaca)).toEqual(Array(9).fill(null));
  });
});

describe('desativação do cadastro (RF-02)', () => {
  const livre = { vinculoValido: false, dentro: false, funcionarioAtivo: false };
  const ativa = { anonimizada: false, desativada: false };
  it('só síndico e administração desativam', () => {
    expect(MATRIZ['pessoa.desativar']).toEqual(['sindico', 'administracao']);
  });
  it('ordem: estado (409) -> motivo (422) -> dentro -> vínculo -> funcionário', () => {
    expect(validarDesativacaoPessoa({ anonimizada: true, desativada: true }, '', livre)?.code).toBe('PESSOA_ANONIMIZADA');
    expect(validarDesativacaoPessoa({ anonimizada: false, desativada: true }, '', livre)?.code).toBe('PESSOA_JA_DESATIVADA');
    expect(validarDesativacaoPessoa(ativa, '  14 caracteres  '.slice(0, 16), { ...livre, dentro: true })?.code).toBe('MOTIVO_OBRIGATORIO');
    const m = 'Não frequenta mais';
    expect(validarDesativacaoPessoa(ativa, m, { vinculoValido: true, dentro: true, funcionarioAtivo: true })?.code).toBe('PESSOA_DENTRO');
    expect(validarDesativacaoPessoa(ativa, m, { ...livre, vinculoValido: true, funcionarioAtivo: true })?.code).toBe('PESSOA_COM_VINCULO_VALIDO');
    expect(validarDesativacaoPessoa(ativa, m, { ...livre, funcionarioAtivo: true })?.code).toBe('FUNCIONARIO_ATIVO');
    expect(validarDesativacaoPessoa(ativa, m, livre)).toBeNull();
  });
  it('pessoaDesativada: nulo ou ausente é ativo', () => {
    expect(pessoaDesativada({})).toBe(false);
    expect(pessoaDesativada({ desativadaEm: null })).toBe(false);
    expect(pessoaDesativada({ desativadaEm: 1 })).toBe(true);
  });
});

import { mascaraCpf, mascaraPlaca, mascaraTelefone } from '../../src/dominio/cpf';

describe('máscaras de entrada', () => {
  it('CPF: progressivo, com ou sem pontuação, limitado a 11 dígitos', () => {
    expect(['', '1', '123', '1234', '123456', '1234567', '123456789', '1234567890', '12345678909'].map(mascaraCpf))
      .toEqual(['', '1', '123', '123.4', '123.456', '123.456.7', '123.456.789', '123.456.789-0', '123.456.789-09']);
    expect(mascaraCpf('123.456.789-09')).toBe('123.456.789-09');
    expect(mascaraCpf(' 123 456 789 09 99')).toBe('123.456.789-09');
    expect(mascaraCpf('abc12x')).toBe('12');
    expect(mascaraCpf(null)).toBe('');
    expect(mascaraCpf(mascaraCpf('12345678909'))).toBe('123.456.789-09');
  });
  it('telefone: fixo (10) e celular (11), progressivo', () => {
    expect(mascaraTelefone('1')).toBe('(1');
    expect(mascaraTelefone('11')).toBe('(11');
    expect(mascaraTelefone('113')).toBe('(11) 3');
    expect(mascaraTelefone('1134567')).toBe('(11) 3456-7');
    expect(mascaraTelefone('1134567890')).toBe('(11) 3456-7890');
    expect(mascaraTelefone('119')).toBe('(11) 9');
    expect(mascaraTelefone('119876')).toBe('(11) 9876');
    expect(mascaraTelefone('1198765')).toBe('(11) 98765');
    expect(mascaraTelefone('11987654')).toBe('(11) 98765-4');
    expect(mascaraTelefone('11987654321')).toBe('(11) 98765-4321');
    expect(mascaraTelefone('119876543219999')).toBe('(11) 98765-4321');
    expect(mascaraTelefone('(11) 98765-4321')).toBe('(11) 98765-4321');
    expect(mascaraTelefone('+55 11 98765-4321')).toBe('(11) 98765-4321');
    expect(mascaraTelefone('')).toBe('');
    expect(mascaraTelefone(mascaraTelefone('1134567890'))).toBe('(11) 3456-7890');
  });
  it('placa: hífen depois das 3 letras (antiga e Mercosul, como na exibição), maiúsculas, 7 caracteres', () => {
    expect(mascaraPlaca('abc')).toBe('ABC');
    expect(mascaraPlaca('abc1')).toBe('ABC-1');
    expect(mascaraPlaca('abc12')).toBe('ABC-12');
    expect(mascaraPlaca('abc1234')).toBe('ABC-1234');
    expect(mascaraPlaca('ABC-1234')).toBe('ABC-1234');
    expect(mascaraPlaca('abc1d23')).toBe('ABC-1D23');
    expect(mascaraPlaca('ABC-1D23')).toBe('ABC-1D23');
    expect(mascaraPlaca('abc1234999')).toBe('ABC-1234');
    expect(mascaraPlaca('  ab-c 1.2')).toBe('ABC-12');
    expect(mascaraPlaca(mascaraPlaca('abc1234'))).toBe('ABC-1234');
  });
});
