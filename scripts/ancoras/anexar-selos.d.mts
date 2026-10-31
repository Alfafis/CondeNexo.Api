// Tipos do anexar-selos.mjs (o script roda sem build no runner do GitHub; os testes da API o importam em TypeScript).
export const FORMATO: 'portaria-parque/selos-diarios';
export interface SeloAncorado { data: string; seq: number; hash: string; totalDoDia: number }
export interface Divergencia { tipo: string; data?: string; [k: string]: unknown }
export class ErroResposta extends Error {}
export class ErroArquivo extends Error {}
export function diaBrt(agora: Date): string;
export function validarResposta(texto: string, agora?: Date): SeloAncorado[];
export function lerArquivo(texto: string): SeloAncorado[];
export function mesclar(ancorados: SeloAncorado[], recebidos: SeloAncorado[]): { novos: SeloAncorado[]; divergencias: Divergencia[] };
export function linhaJsonl(s: SeloAncorado, ancoradoEm: string, execucao?: string | null): string;
export function relatorio(divergencias: Divergencia[], contexto: { execucao: string | null; agora: string }): string;
export function principal(argv: string[], agora?: Date): { codigo: 0 | 2; novos: SeloAncorado[]; divergencias: Divergencia[] };
