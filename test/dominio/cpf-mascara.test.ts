// Máscara do CPF nos dois formatos (decisão de 2026-10-24) e detecção do formato de uma máscara gravada.
import { describe, expect, it } from 'vitest';
import { DIGITOS_VISIVEIS_CPF, formatoDaMascara, mascararCpf } from '../../src/dominio/cpf';

describe('mascararCpf', () => {
  it("padrão 'inicio': 5 primeiros dígitos visíveis, com ou sem pontuação", () => {
    expect(mascararCpf('52998224725')).toBe('529.98*.***-**');
    expect(mascararCpf('529.982.247-25')).toBe('529.98*.***-**');
    expect(mascararCpf('529.982.247-25', 'inicio')).toBe('529.98*.***-**');
  });
  it("'meio' (formato antigo): 6 do meio", () => {
    expect(mascararCpf('529.982.247-25', 'meio')).toBe('***.982.247-**');
  });
  it('os dois formatos juntos revelam os 9 primeiros (por isso nunca podem coexistir para o mesmo CPF)', () => {
    const ini = mascararCpf('52998224725').replace(/\D/g, '');
    const meio = mascararCpf('52998224725', 'meio').replace(/\D/g, '');
    expect(ini + meio.slice(2)).toBe('529982247');
  });
  it('nenhum formato deixa ver os verificadores nem mais dígitos que o previsto', () => {
    for (const f of ['inicio', 'meio'] as const) {
      const m = mascararCpf('12345678909', f);
      expect(m.replace(/\D/g, '')).toHaveLength(DIGITOS_VISIVEIS_CPF[f]);
      expect(m.endsWith('-**')).toBe(true);
      expect(m).toHaveLength(14);
    }
  });
  it('exige 11 dígitos', () => {
    for (const x of ['', '123', '1234567890', '123456789012']) expect(() => mascararCpf(x)).toThrow('11 dígitos');
    expect(() => mascararCpf('12345678909', 'fim' as never)).toThrow('formato');
  });
});

describe('formatoDaMascara', () => {
  it('detecta os dois formatos', () => {
    expect(formatoDaMascara('529.98*.***-**')).toBe('inicio');
    expect(formatoDaMascara('***.982.247-**')).toBe('meio');
    expect(formatoDaMascara(mascararCpf('12345678909'))).toBe('inicio');
    expect(formatoDaMascara(mascararCpf('12345678909', 'meio'))).toBe('meio');
  });
  it('null para ausente, rótulos e qualquer texto fora dos formatos (inclusive CPF completo)', () => {
    for (const x of [null, undefined, '', '(sem CPF)', '(anonimizado)', '529.982.247-25', '52998224725', '***.***.***-**', '529.98*.***-25', '529.982.***-**']) {
      expect(formatoDaMascara(x)).toBeNull();
    }
  });
});
