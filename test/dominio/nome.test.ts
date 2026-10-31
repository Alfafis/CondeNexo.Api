import { describe, expect, it } from 'vitest';
import { ASTERISCOS_NOME, mascararNome, NOME_ANONIMIZADO, NOME_MASCARADO, nomeFalado } from '../../src/dominio/nome';

// Nomes fictícios (repositório público).
describe('mascararNome (leitura do Master, formato do protótipo)', () => {
  it('primeiro nome + inicial do último sobrenome + 6 asteriscos', () => {
    expect(mascararNome('Ana Ribeiro')).toBe('Ana R******');
    expect(mascararNome('Paulo Henrique Duarte Mendes')).toBe('Paulo M******');
    expect(ASTERISCOS_NOME).toHaveLength(6);
  });

  it('o tamanho do sobrenome não aparece', () => {
    expect(mascararNome('Ana Li')).toBe('Ana L******');
    expect(mascararNome('Ana Albuquerque')).toBe('Ana A******');
  });

  it('preposições e conjunção não contam como sobrenome', () => {
    expect(mascararNome('Maria da Silva')).toBe('Maria S******');
    expect(mascararNome('João dos Santos')).toBe('João S******');
    expect(mascararNome('Lúcia de Souza e Melo')).toBe('Lúcia M******');
    expect(mascararNome('Carla Mendes da')).toBe('Carla M******');
    expect(mascararNome('Pedro DE Assis')).toBe('Pedro A******');
  });

  it('acento, minúscula, hífen e apóstrofo: a inicial é a primeira letra, em maiúscula', () => {
    expect(mascararNome('Helena Ávila')).toBe('Helena Á******');
    expect(mascararNome('rodrigo alves')).toBe('rodrigo A******');
    expect(mascararNome('Bruno Souza-Lima')).toBe('Bruno S******');
    expect(mascararNome("Tiago D'Ávila")).toBe('Tiago D******');
  });

  it('espaços sobrando não mudam o resultado', () => {
    expect(mascararNome('  Ana   Ribeiro  ')).toBe('Ana R******');
  });

  it('uma palavra só fica como está (já é só o primeiro nome)', () => {
    expect(mascararNome('Thiago')).toBe('Thiago');
    expect(mascararNome('Maria da')).toBe('Maria');
  });

  it('vazio, anonimizado e marcadores do sistema ficam como estão', () => {
    expect(mascararNome('')).toBe('');
    expect(mascararNome('   ')).toBe('');
    expect(mascararNome(NOME_ANONIMIZADO)).toBe(NOME_ANONIMIZADO);
    expect(mascararNome('(pessoa removida)')).toBe('(pessoa removida)');
    expect(mascararNome('(pessoa)')).toBe('(pessoa)');
    expect(mascararNome('?')).toBe('?');
  });

  it('idempotente', () => {
    for (const n of ['Ana Ribeiro', 'Maria da Silva', 'Thiago', 'Helena Ávila']) expect(mascararNome(mascararNome(n))).toBe(mascararNome(n));
  });

  it('o resultado nunca contém o sobrenome inteiro', () => {
    for (const n of ['Ana Ribeiro', 'Paulo Henrique Duarte Mendes', 'Maria da Conceição dos Santos']) {
      const m = mascararNome(n);
      expect(NOME_MASCARADO.test(m), m).toBe(true);
      for (const p of n.split(' ').slice(1).filter((x) => x.length > 2)) expect(m).not.toContain(p);
    }
  });
});

describe('nomeFalado (rótulo para leitor de tela)', () => {
  it('troca os asteriscos por ponto; outro texto sai igual', () => {
    expect(nomeFalado('Ana R******')).toBe('Ana R.');
    expect(nomeFalado('Thiago')).toBe('Thiago');
    expect(nomeFalado('(pessoa removida)')).toBe('(pessoa removida)');
  });
});
