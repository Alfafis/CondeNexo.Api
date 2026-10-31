import { describe, expect, it } from 'vitest';
import {
  AVISO_VENCIMENTO_MIN, descreverPermanencia, estadoPermanencia, MAX_PRORROGACOES, PERMANENCIA_MAXIMA_MS, permanenciaExcedida,
  prazoInicial, proximaProrrogacao, temPrazoPermanencia, tipoVisitaPadrao,
} from '../../src/dominio/rules';
import { brt, HORA } from '../../src/dominio/time';
import { ROTULO_TIPO_VISITA, TIPOS_VISITA } from '../../src/dominio/types';

const MIN = 60_000;
const entrada = brt(2026, 10, 23, 9, 0);

describe('permanência: prazo por tipo de visita', () => {
  it('só visitante e prestador têm prazo; padrão visita / serviço', () => {
    expect(temPrazoPermanencia('visitante')).toBe(true);
    expect(temPrazoPermanencia('prestador')).toBe(true);
    expect(temPrazoPermanencia('morador')).toBe(false);
    expect(temPrazoPermanencia('funcionario')).toBe(false);
    expect(tipoVisitaPadrao('visitante')).toBe('visita');
    expect(tipoVisitaPadrao('prestador')).toBe('servico');
  });

  it('rótulos de todos os tipos', () => {
    expect(TIPOS_VISITA.map((t) => ROTULO_TIPO_VISITA[t])).toEqual(['Visita', 'Entregador', 'Motorista de app', 'Serviço']);
  });

  it('prazos padrão: entrega 30 min, app 15 min, visita 4 h, serviço 8 h', () => {
    expect(prazoInicial('entrega', entrada)).toBe(entrada + 30 * MIN);
    expect(prazoInicial('transporte_app', entrada)).toBe(entrada + 15 * MIN);
    expect(prazoInicial('visita', entrada)).toBe(entrada + 4 * HORA);
    expect(prazoInicial('servico', entrada)).toBe(entrada + 8 * HORA);
  });

  it('serviço com janela: até a hora fim do dia da entrada; janela já passada ou outro tipo: padrão', () => {
    expect(prazoInicial('servico', entrada, '17:30')).toBe(brt(2026, 10, 23, 17, 30));
    expect(prazoInicial('servico', entrada, '17:30:00')).toBe(brt(2026, 10, 23, 17, 30));
    expect(prazoInicial('servico', entrada, '08:00')).toBe(entrada + 8 * HORA);
    expect(prazoInicial('visita', entrada, '17:30')).toBe(entrada + 4 * HORA);
    // Nunca passa do teto de 12 h
    expect(prazoInicial('servico', brt(2026, 10, 23, 6, 0), '23:00')).toBe(brt(2026, 10, 23, 6, 0) + PERMANENCIA_MAXIMA_MS);
  });

  it('estado: no prazo, vence em ≤ 15 min, expirado', () => {
    const prazo = entrada + HORA;
    expect(estadoPermanencia(prazo, prazo - (AVISO_VENCIMENTO_MIN + 1) * MIN)).toBe('no_prazo');
    expect(estadoPermanencia(prazo, prazo - AVISO_VENCIMENTO_MIN * MIN)).toBe('vence_em_breve');
    expect(estadoPermanencia(prazo, prazo)).toBe('vence_em_breve');
    expect(estadoPermanencia(prazo, prazo + 1)).toBe('expirado');
  });

  it('texto: "Até HH:MM", "Vence em X" (arredonda para cima) e "Expirado há X"', () => {
    const prazo = brt(2026, 10, 23, 15, 30);
    expect(descreverPermanencia(prazo, prazo - HORA)).toBe('Até 15:30');
    expect(descreverPermanencia(prazo, prazo - 12 * MIN - 10_000)).toBe('Vence em 13min');
    expect(descreverPermanencia(prazo, prazo + 65 * MIN)).toBe('Expirado há 1h 05min');
  });

  it('prorrogação: +1h do prazo vigente; vencido conta de agora', () => {
    const p = { entradaEm: entrada, prazoAte: entrada + 30 * MIN, prorrogacoes: 0 };
    expect(proximaProrrogacao(p, entrada + 10 * MIN)).toEqual({ ok: true, prazoAte: entrada + 90 * MIN });
    expect(proximaProrrogacao(p, entrada + 2 * HORA)).toEqual({ ok: true, prazoAte: entrada + 3 * HORA });
  });

  it('prorrogação: no máximo 4 e nunca além de 12 h desde a entrada (o último "+1h" é cortado no teto)', () => {
    const base = { entradaEm: entrada, prazoAte: entrada + HORA, prorrogacoes: MAX_PRORROGACOES };
    const r = proximaProrrogacao(base, entrada);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro.code).toBe('PRORROGACAO_LIMITE');
    expect(proximaProrrogacao({ entradaEm: entrada, prazoAte: entrada + 11.5 * HORA, prorrogacoes: 1 }, entrada))
      .toEqual({ ok: true, prazoAte: entrada + 12 * HORA });
    const noTeto = proximaProrrogacao({ entradaEm: entrada, prazoAte: entrada + 12 * HORA, prorrogacoes: 1 }, entrada);
    expect(noTeto.ok).toBe(false);
    // Vencido e já depois do teto (lançamento retroativo antigo): nada a prorrogar
    expect(proximaProrrogacao({ entradaEm: entrada, prazoAte: entrada + HORA, prorrogacoes: 0 }, entrada + 13 * HORA).ok).toBe(false);
  });

  it('permanenciaExcedida (8 h fixas) continua para quem não tem prazo gravado', () => {
    expect(permanenciaExcedida(entrada, entrada + 8 * HORA)).toBe(false);
    expect(permanenciaExcedida(entrada, entrada + 8 * HORA + 1)).toBe(true);
  });
});
