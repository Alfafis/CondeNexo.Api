// Datas de calendário no fuso do condomínio. O domain (../dominio/time) trabalha em BRT fixo (UTC-3, sem horário
// de verão desde 2019); a API usa a mesma regra para que "hoje" seja o mesmo dia no domain, na API e no banco.
const BRT_MS = 3 * 3600 * 1000;

/** "AAAA-MM-DD" do dia em BRT do instante (comparável com colunas `date` do banco). */
export const diaBrt = (instante: Date): string => new Date(instante.getTime() - BRT_MS).toISOString().slice(0, 10);

/** 'AAAA-MM-DD' que existe no calendário (rejeita 2026-02-30). */
export const ehDiaValido = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Início do dia BRT de 'AAAA-MM-DD' (o número que o domain usa para datas de calendário). */
export const inicioDoDiaBrt = (dia: string): Date => new Date(new Date(`${dia}T00:00:00.000Z`).getTime() + BRT_MS);

/** 'AAAA-MM-DD' somado de `n` dias. */
export const somarDias = (dia: string, n: number): string =>
  new Date(new Date(`${dia}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
