import { z } from 'zod';

const MAX_LINHAS = 3000;

export const Linha = z.strictObject({
  linha: z.number().int().min(0).max(1_000_000),
  bloco: z.string().max(20), unidade: z.string().max(20), nome: z.string().max(150),
  documento: z.string().max(30), telefone: z.string().max(30), tipo: z.string().max(40).optional(),
});
export type LinhaPlanilha = z.infer<typeof Linha>;
export const AnaliseDto = z.strictObject({ arquivo: z.string().trim().min(1).max(200), linhas: z.array(Linha).min(1).max(MAX_LINHAS) });
export const ConfirmacaoDto = z.strictObject({ linhas: z.array(Linha).min(1).max(MAX_LINHAS) });
