// Lista explícita de unidades (criação de condomínio pelo Master) e as sugestões de código e login.
import { describe, expect, it } from 'vitest';
import { CODIGO_CONDOMINIO, LOGIN_SINDICO, sugerirCodigoCondominio, sugerirLoginSindico } from '../../src/dominio/condominio';
import {
  agruparPorBloco, codigoUnidade, LIMITE_UNIDADES, lerLinhaUnidade, lerListaUnidades, linhasDePlanilha, matrizDeCsv,
} from '../../src/dominio/units';

const codigo = (t: string) => {
  const r = lerLinhaUnidade(t);
  return 'unidade' in r ? codigoUnidade(r.unidade) : `ERRO: ${r.motivo}`;
};

describe('lerLinhaUnidade: formatos aceitos', () => {
  it.each([
    ['A-101', 'A-101'], ['a-101', 'A-101'], ['A 101', 'A-101'], ['  b   12  ', 'B-12'], ['A/101', 'A-101'], ['A.101', 'A-101'],
    ['A;101', 'A-101'], ['A,101', 'A-101'], ['A\t101', 'A-101'], ['A – 101', 'A-101'], ['Bloco A 101', 'A-101'],
    ['bloco a - 101', 'A-101'], ['Torre 2 - 34', '2-34'], ['TORRE 10 1201', '10-1201'], ['Bloco A · AP 32', 'A-32'],
    ['A apto 101', 'A-101'], ['A-ap. 7', 'A-07'], ['B2-0032', 'B2-32'], ['T4-32', 'T4-32'], ['1 3', '1-03'],
  ])('%s -> %s', (texto, esperado) => expect(codigo(texto)).toBe(esperado));
});

describe('lerLinhaUnidade: recusas com motivo', () => {
  it.each([
    ['101', /Falta o bloco/], ['Bloco 101', /Falta o bloco/], ['B', /Falta o número/], ['A101', /Separe o bloco/], ['ABCD-1', /1 a 3 letras/],
    ['A-0', /maior que zero/], ['A-12345', /até 4/], ['A-B', /Formato não reconhecido/], ['A-101 A-102', /Formato não reconhecido/],
    ['A-101-x', /Formato não reconhecido/], ['Ç-1', /Formato não reconhecido/],
  ])('%s', (texto, motivo) => expect(codigo(texto)).toMatch(motivo));

  it('com Torre, a mensagem fala em torre', () => {
    expect(lerLinhaUnidade('101', 'Torre')).toEqual({ motivo: 'Falta a torre (ex.: A-101).' });
    expect(lerLinhaUnidade('ABCD 1', 'Torre')).toMatchObject({ motivo: expect.stringMatching(/^A torre/) });
  });
});

describe('lerListaUnidades', () => {
  it('ignora linhas em branco (sem perder a numeração), marca inválidas e repetidas (normalizadas), ordena as válidas', () => {
    const r = lerListaUnidades('﻿B-2\n\nA-101\r\n a 101 \nxyz\nA-3\nB 02\n');
    expect(r.linhas.map((l) => [l.linha, l.situacao])).toEqual([
      [1, 'ok'], [3, 'ok'], [4, 'duplicada'], [5, 'invalida'], [6, 'ok'], [7, 'duplicada'],
    ]);
    expect(r.linhas[2]!.motivo).toBe('Repetida: A-101 já está na linha 3.');
    expect(r.linhas[5]!.motivo).toBe('Repetida: B-02 já está na linha 1.');
    expect(r.linhas[3]!.motivo).toMatch(/Falta o número/);
    expect(r.unidades.map(codigoUnidade)).toEqual(['A-03', 'A-101', 'B-02']);
    expect([r.invalidas, r.duplicadas, r.acimaDoLimite]).toEqual([1, 2, false]);
  });

  it('texto vazio: nada', () => {
    expect(lerListaUnidades('  \n\n')).toEqual({ linhas: [], unidades: [], invalidas: 0, duplicadas: 0, acimaDoLimite: false });
  });

  it('acima do limite é sinalizado', () => {
    const texto = Array.from({ length: LIMITE_UNIDADES + 1 }, (_, i) => `${['A', 'B', 'C'][i % 3]}-${Math.floor(i / 3) + 1}`).join('\n');
    const r = lerListaUnidades(texto);
    expect(r.unidades).toHaveLength(LIMITE_UNIDADES + 1);
    expect(r.acimaDoLimite).toBe(true);
  });

  it('agrupa por bloco em ordem natural', () => {
    const g = agruparPorBloco(lerListaUnidades('10-1\n2-1\nB-2\nB-1\nA-1').unidades);
    expect(g.map((x) => [x.bloco, x.unidades.map((u) => u.numero)])).toEqual([['2', ['01']], ['10', ['01']], ['A', ['01']], ['B', ['01', '02']]]);
  });
});

describe('planilha', () => {
  it('CSV: separador detectado (; , tab), aspas, BOM', () => {
    expect(matrizDeCsv('﻿Bloco;Unidade\nA;101\n\n"B";"2"')).toEqual([['Bloco', 'Unidade'], ['A', '101'], [], ['B', '2']]);
    expect(matrizDeCsv('bloco,apto\nA,1')).toEqual([['bloco', 'apto'], ['A', '1']]);
    expect(matrizDeCsv('A\t1\nB\t2')).toEqual([['A', '1'], ['B', '2']]);
    expect(matrizDeCsv('"A, B",1')).toEqual([['A, B', '1']]);
  });

  it('duas colunas com cabeçalho (qualquer ordem e grafia), uma coluna, sem cabeçalho', () => {
    // Cabeçalho e linha vazia viram linha em branco: a numeração da prévia é a da planilha.
    expect(linhasDePlanilha([['Apto', 'Observação', 'Torre'], ['101', 'x', '1'], ['', '', ''], ['102', '', '1'], []])).toEqual(['', '1 101', '', '1 102']);
    expect(linhasDePlanilha([['Número', 'Bloco'], ['7', 'a']])).toEqual(['', 'a 7']);
    expect(linhasDePlanilha([['Unidade'], ['A-101'], ['B 2']])).toEqual(['', 'A-101', 'B 2']);
    expect(linhasDePlanilha([['A', '101'], ['B', '2']])).toEqual(['A 101', 'B 2']);
    expect(linhasDePlanilha([['A-101'], ['B-2']])).toEqual(['A-101', 'B-2']);
    expect(linhasDePlanilha([])).toEqual([]);
    // O resultado vai para o mesmo leitor da lista colada.
    const r = lerListaUnidades(linhasDePlanilha(matrizDeCsv('Torre;Apto\n1;101\n\n1;101\n2;x')).join('\n'));
    expect(r.linhas.map((l) => [l.linha, l.situacao])).toEqual([[2, 'ok'], [4, 'duplicada'], [5, 'invalida']]);
  });
});

describe('sugestões', () => {
  it.each([
    ['Residencial Vila Sul', 'vila-sul'], ['Condomínio Residencial do Parque', 'parque'], ['Edifício São João', 'sao-joao'],
    ['  Jardim   das Flores  ', 'jardim-flores'], ['123 Plaza', 'c-123-plaza'], ['Condomínio', 'condominio'],
    ['Parque das Árvores Centenárias do Bairro Novo Horizonte', 'parque-arvores-centenarias'], ['', ''],
  ])('código de "%s" = "%s"', (nome, esperado) => {
    const c = sugerirCodigoCondominio(nome);
    expect(c).toBe(esperado);
    if (c.length >= 3) expect(CODIGO_CONDOMINIO.test(c)).toBe(true);
  });

  it.each([
    ['Maria Souza', 'maria.souza'], ['Maria José da Souza', 'maria.souza'], ['JOÃO', 'joao'], ['  Ana  de  Ávila ', 'ana.avila'],
    ['Zé 2º Silva', 'ze.silva'], ['Fulano 123', 'fulano'], ['', ''], ['da de', ''],
  ])('login de "%s" = "%s"', (nome, esperado) => {
    const l = sugerirLoginSindico(nome);
    expect(l).toBe(esperado);
    if (l.length >= 3) expect(LOGIN_SINDICO.test(l)).toBe(true);
  });

  it('login de nome enorme cabe em 40', () => {
    const l = sugerirLoginSindico(`${'a'.repeat(30)} ${'b'.repeat(30)}`);
    expect(l).toBe('a'.repeat(30));
    expect(LOGIN_SINDICO.test(l)).toBe(true);
  });
});

describe('lerLinhaUnidade: entrada hostil (ReDoS)', () => {
  it('linha enorme de espaços é recusada na hora; a regex não é quadrática nem em linha curta de espaços', () => {
    const inicio = Date.now();
    expect(lerLinhaUnidade(`a${' '.repeat(300_000)}x`)).toEqual({ motivo: expect.stringMatching(/Linha longa demais/) });
    // Abaixo do teto (80) a regex roda, e o separador sem sobreposição não degrada.
    expect('motivo' in lerLinhaUnidade(`a${' '.repeat(60)}x`)).toBe(true);
    expect(Date.now() - inicio).toBeLessThan(200);
  });
});
