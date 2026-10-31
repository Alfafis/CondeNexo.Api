// CSV do relatório (RF-31): injeção de fórmula (OWASP CSV Injection) e escape do separador.
import { describe, expect, it } from 'vitest';
import { celula, csvRelatorio, type ResumoRelatorio } from '../../src/dominio/relatorio';

describe('CSV do relatório: injeção de fórmula', () => {
  it.each(['=1+1', '+1', '-1', '@SOMA(A1)', '\t=1+1', '\r=1+1'])('texto que começa com %j recebe apóstrofo', (v) => {
    expect(celula(v).replace(/^"/, '').startsWith(`'${v[0]}`)).toBe(true);
  });

  it('CR e quebra de linha vão entre aspas (não quebram a linha do CSV); aspas são dobradas', () => {
    expect(celula('\r=1')).toBe(`"'\r=1"`);
    expect(celula('a\nb')).toBe('"a\nb"');
    expect(celula('a;"b"')).toBe('"a;""b"""');
  });

  it('texto comum e números ficam como estão', () => {
    expect(celula('Interfone')).toBe('Interfone');
    expect(celula('João - porteiro')).toBe('João - porteiro');
    expect(celula(-3)).toBe('-3');
    expect(celula(12)).toBe('12');
  });

  it('nome de operador malicioso sai neutralizado no arquivo inteiro', () => {
    const r: ResumoRelatorio = {
      periodo: { de: Date.UTC(2026, 9, 1, 3), ate: Date.UTC(2026, 9, 2, 3) },
      acessosPorDia: [], acessosPorMeio: [], encomendasPorIdade: [],
      excecoesPorPorteiro: [{ operadorId: 'x', operador: '\t=HYPERLINK("http://exemplo.invalid")', total: 1 }],
      cadastroCompleto: { unidadesCompletas: 0, total: 0 },
      totais: { entradas: 0, negados: 0, recusados: 0, retroativos: 0, excecoes: 1 },
    };
    const { conteudo } = csvRelatorio(r, {}, '2026-10-02');
    expect(conteudo).toContain(`Exceções por responsável;"'\t=HYPERLINK(""http://exemplo.invalid"")";1`);
    for (const linha of conteudo.split('\r\n')) for (const c of linha.split(';')) expect(c).not.toMatch(/^[=+@\t\r]/);
  });
});
