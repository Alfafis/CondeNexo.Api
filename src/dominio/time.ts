// Utilitários de tempo. O condomínio fica em São Paulo (UTC-3, sem horário de verão desde 2019),
// então usamos deslocamento fixo em vez de Intl, o que mantém o resultado idêntico no navegador e nos testes.
const BRT_MS = 3 * 3600 * 1000;
export const HORA = 3600 * 1000;
export const DIA = 24 * HORA;

/** Cria um instante (epoch ms) a partir de data/hora local de São Paulo. */
export function brt(ano: number, mes: number, dia: number, hh = 0, mm = 0, ss = 0): number {
  return Date.UTC(ano, mes - 1, dia, hh, mm, ss) + BRT_MS;
}

interface Partes { ano: number; mes: number; dia: number; hh: number; mm: number; ss: number; dow: number }

/** Decompõe um instante em partes no fuso de São Paulo. dow: 0 = domingo ... 6 = sábado. */
export function partes(ts: number): Partes {
  const d = new Date(ts - BRT_MS);
  return {
    ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(), dow: d.getUTCDay(),
  };
}

const p2 = (n: number) => String(n).padStart(2, '0');

export const fmtData = (ts: number) => { const p = partes(ts); return `${p2(p.dia)}/${p2(p.mes)}/${p.ano}`; };
export const fmtDataCurta = (ts: number) => { const p = partes(ts); return `${p2(p.dia)}/${p2(p.mes)}`; };
export const fmtHora = (ts: number) => { const p = partes(ts); return `${p2(p.hh)}:${p2(p.mm)}`; };
export const fmtHoraSeg = (ts: number) => { const p = partes(ts); return `${p2(p.hh)}:${p2(p.mm)}:${p2(p.ss)}`; };
export const fmtDataHora = (ts: number) => `${fmtData(ts)} ${fmtHora(ts)}`;
/** Valor para <input type="date"> */
export const toInputDate = (ts: number) => { const p = partes(ts); return `${p.ano}-${p2(p.mes)}-${p2(p.dia)}`; };
export const toInputTime = (ts: number) => fmtHora(ts);
/** Lê "YYYY-MM-DD" (+ "HH:MM" opcional) como horário de São Paulo. Retorna null se inválido. */
export function fromInput(data: string, hora = '00:00'): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  const h = /^(\d{2}):(\d{2})$/.exec(hora);
  if (!m || !h) return null;
  return brt(+m[1], +m[2], +m[3], +h[1], +h[2]);
}
/** Início do dia (00:00 BRT) do instante. */
export const inicioDoDia = (ts: number) => { const p = partes(ts); return brt(p.ano, p.mes, p.dia); };
/** Fim do dia (23:59:59.999 BRT). */
export const fimDoDia = (ts: number) => inicioDoDia(ts) + DIA - 1;
export const minutosDoDia = (ts: number) => { const p = partes(ts); return p.hh * 60 + p.mm; };
export const hhmmParaMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
export const DIAS_SEMANA_ABREV = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** O mesmo instante `n` anos antes, no calendário de São Paulo (29/02 vira 28/02), como `now() - interval 'n years'`. */
export function menosAnos(ts: number, n: number): number {
  const p = partes(ts);
  const ultimoDia = new Date(Date.UTC(p.ano - n, p.mes, 0)).getUTCDate();
  return brt(p.ano - n, p.mes, Math.min(p.dia, ultimoDia), p.hh, p.mm, p.ss) + (ts % 1000);
}

/** "3h 20min" a partir de milissegundos. */
export function fmtDuracao(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${p2(m)}min` : `${m}min`;
}

/** Hora atual (epoch ms). As telas usam esta função; nos testes, `vi.setSystemTime` controla o valor. */
export const agora = () => Date.now();
