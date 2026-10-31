import { z } from 'zod';

const EscalaDto = z.strictObject({ diasSemana: z.array(z.number()).max(7), horaInicio: z.string().max(5), horaFim: z.string().max(5) });
export const NovoFuncionarioDto = z.strictObject({
  nome: z.string().max(150), documento: z.string().max(20), telefone: z.string().max(20),
  funcao: z.string().max(80), escala: EscalaDto, ativo: z.boolean().optional(),
});
export const EdicaoFuncionarioDto = z.strictObject({ funcao: z.string().max(80).optional(), escala: EscalaDto.optional(), ativo: z.boolean().optional() });
export const CursorFuncionarios = z.strictObject({ n: z.string().max(400), id: z.uuid() });
