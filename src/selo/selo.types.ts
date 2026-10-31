import { seloCadeia } from '../db/schema';

export type LinhaSelo = typeof seloCadeia.$inferSelect;
export type TipoSelo = 'diario' | 'manual';

export interface SeloView {
  id: string; data: string; tipo: TipoSelo; ultimoSeq: number; ultimoHash: string; criadoEm: number;
  enviadoPara: string | null; enviadoEm: number | null;
}
export type StatusAncora = 'enviada' | 'pendente' | 'sem_destino';
