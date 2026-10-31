import { z } from 'zod';
import { ehDiaValido } from '../comum/datas';
import { categoriaPessoa, meioAutorizacao } from '../db/schema';

const Dia = z.string().refine(ehDiaValido, { message: 'data inválida (AAAA-MM-DD)' });
export const FiltroRelatorioDto = z.strictObject({
  de: Dia.optional(), ate: Dia.optional(), unidadeId: z.uuid().optional(),
  categoria: z.enum(categoriaPessoa.enumValues).optional(), meio: z.enum(meioAutorizacao.enumValues).optional(),
});
export type Filtro = z.infer<typeof FiltroRelatorioDto>;
