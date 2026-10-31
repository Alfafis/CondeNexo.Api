import { z } from 'zod';

export const NovoVeiculoDto = z.strictObject({ unidadeId: z.uuid({ message: 'unidade inválida' }), placa: z.string().max(10), modelo: z.string().max(60), cor: z.string().max(30) });
export const EdicaoVeiculoDto = z.strictObject({ placa: z.string().max(10).optional(), modelo: z.string().max(60).optional(), cor: z.string().max(30).optional(), ativo: z.boolean().optional() });
