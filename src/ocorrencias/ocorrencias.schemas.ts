import { z } from 'zod';
import { PaginacaoDto } from '../comum/pagina';
import { statusOcorrencia, tipoOcorrencia } from '../db/schema';

const MAX_EVENTOS = 20;

const EventoIds = z.array(z.uuid({ message: 'evento inválido' })).max(MAX_EVENTOS);
export const NovaDto = z.strictObject({
  tipo: z.enum(tipoOcorrencia.enumValues),
  descricao: z.string().max(4000),
  unidadeId: z.uuid().nullable().default(null),
  envolvidos: z.string().max(500).optional().default(''),
  eventoIds: EventoIds.optional().default([]),
});
export const StatusDto = z.strictObject({ status: z.enum(['em_andamento', 'encerrada']) });
export const VincularDto = z.strictObject({ eventoIds: EventoIds.min(1) });
const ListaStatus = z.string().max(40).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(statusOcorrencia.enumValues)).max(3));
export const ListarOcorrenciasDto = PaginacaoDto.extend({
  status: ListaStatus.optional(),
  tipo: z.enum(tipoOcorrencia.enumValues).optional(),
  unidadeId: z.uuid().optional(),
});
export const CursorOcorrencias = z.object({ t: z.string().datetime(), id: z.uuid() });
