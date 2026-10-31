import { DIAS_ENCOMENDA_ATRASADA } from '../dominio/rules';
import { z } from 'zod';
import { PaginacaoDto } from '../comum/pagina';

const Texto = (max: number) => z.string().max(max);

export const ReceberDto = z.strictObject({
  unidadeId: z.uuid({ message: 'unidade inválida' }),
  destinatario: Texto(120),
  transportadora: Texto(60).optional().default(''),
  codigoRastreio: Texto(60).optional().default(''),
  /** RF-23: a tela só manda depois da conferência; sem ela, 422 (o CHECK do banco exige true). */
  unidadeConfirmada: z.boolean(),
});
export const EntregarDto = z.strictObject({ pessoaId: z.uuid({ message: 'pessoa inválida' }) });
export const AutorizarDto = z.strictObject({ pessoaId: z.uuid(), solicitadaPorPessoaId: z.uuid() });
export const ListarEncomendasDto = PaginacaoDto.extend({
  status: z.enum(['aguardando', 'entregue']).optional(),
  unidadeId: z.uuid().optional(),
  /** RF-26: só as aguardando há mais de N dias (a regra `encomendaAtrasada` do domain: diasDesde > N). */
  atrasadasDias: z.coerce.number().int().min(0).max(365).optional(),
});
export const ResumoEncomendasDto = z.strictObject({ dias: z.coerce.number().int().min(0).max(365).default(DIAS_ENCOMENDA_ATRASADA) });
export const CursorEncomendas = z.object({ t: z.string().datetime(), id: z.uuid() });
