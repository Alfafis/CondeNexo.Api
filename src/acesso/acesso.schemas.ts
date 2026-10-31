import { z } from 'zod';
import { ehDiaValido } from '../comum/datas';
import { PaginacaoDto } from '../comum/pagina';
import { MEIOS_COM_MORADOR } from '../dominio/rules';
import { meioAutorizacao, tipoEvento, tipoVisita } from '../db/schema';

const Instante = z.number().int().min(0).max(8_640_000_000_000);
const Dia = z.string().refine(ehDiaValido, { message: 'data inválida (AAAA-MM-DD)' });
const Texto = (max: number) => z.string().max(max);
const Hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'hora inválida (HH:MM)' });
/** POST sem corpo chega como `undefined`: vale como `{}`. */
const corpo = <T extends z.ZodType>(s: T) => z.preprocess((x) => x ?? {}, s);

export const NovoEventoDto = z.strictObject({
  pessoaId: z.uuid({ message: 'pessoa inválida' }),
  unidadeDestinoId: z.uuid().nullable().default(null),
  areaComumId: z.uuid().nullable().optional(),
  autorizadoPorTipo: z.enum(meioAutorizacao.enumValues).nullable().optional(),
  autorizadoPorPessoaId: z.uuid().nullable().optional(),
  autorizacaoPreviaId: z.uuid().nullable().optional(),
  justificativa: Texto(500).nullable().optional(),
  retroativo: z.boolean().optional(),
  ocorridoEm: Instante.nullable().optional(),
  observacao: Texto(500).nullable().optional(),
  formularioContingencia: Texto(60).nullable().optional(),
  /** Prazo de permanência (só visitante/prestador; padrão visita / serviço). Ignorado para morador e funcionário. */
  tipoVisita: z.enum(tipoVisita.enumValues).nullable().optional(),
  /**
   * Veículo com que a pessoa chegou (ausente ou null = a pé). Placa obrigatória (antiga ou Mercosul, com ou sem hífen;
   * gravada em maiúsculas sem hífen, 422 PLACA_INVALIDA fora do padrão); modelo e cor opcionais. Entra no hash.
   */
  veiculo: z.strictObject({
    placa: Texto(10),
    modelo: Texto(60).nullable().optional(),
    cor: Texto(30).nullable().optional(),
  }).nullable().optional(),
});
/** Rascunho da entrada (avaliação): os mesmos campos e formatos do registro, sem veículo, observação e formulário. */
export const AvaliacaoEntradaDto = NovoEventoDto.pick({
  pessoaId: true, unidadeDestinoId: true, areaComumId: true, autorizadoPorTipo: true, autorizadoPorPessoaId: true,
  autorizacaoPreviaId: true, justificativa: true, retroativo: true, ocorridoEm: true, tipoVisita: true,
});
export const NovaRecusaDto = z.strictObject({
  pessoaId: z.uuid(), unidadeDestinoId: z.uuid(), meio: z.enum(MEIOS_COM_MORADOR), moradorPessoaId: z.uuid(),
  observacao: Texto(500).nullable().optional(), retroativo: z.boolean().optional(), ocorridoEm: Instante.nullable().optional(),
  formularioContingencia: Texto(60).nullable().optional(),
});
export const SaidaDto = corpo(z.strictObject({
  observacao: Texto(500).nullable().optional(), retroativo: z.boolean().optional(), ocorridoEm: Instante.nullable().optional(),
  formularioContingencia: Texto(60).nullable().optional(),
}));
/** "+1h" fixo: sem parâmetro (o tamanho e os limites são regra do domain). */
export const ProrrogacaoDto = corpo(z.strictObject({}));
export const CorrecaoDto = z.strictObject({
  justificativa: Texto(500),
  observacao: Texto(500).nullable().optional(),
  valores: z.strictObject({
    unidadeDestinoId: z.uuid().nullable().optional(),
    ocorridoEm: Instante.optional(),
    pessoaId: z.uuid().optional(),
    autorizadoPorPessoaId: z.uuid().nullable().optional(),
  }).optional(),
});

const Booleano = z.enum(['true', 'false']).transform((v) => v === 'true');
const ListaTipos = z.string().max(80).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(tipoEvento.enumValues)).max(5));
/** Filtros por id, período e marcação (GET). Sem texto livre na URL. */
const FiltrosQuery = {
  eventoId: z.uuid().optional(),
  de: z.coerce.number().pipe(Instante).optional(),
  ate: z.coerce.number().pipe(Instante).optional(),
  unidadeId: z.uuid().optional(),
  pessoaId: z.uuid().optional(),
  operadorId: z.uuid().optional(),
  tipo: z.enum(tipoEvento.enumValues).optional(),
  meio: z.enum(meioAutorizacao.enumValues).optional(),
  somenteExcecoes: Booleano.optional(),
  somenteRetroativos: Booleano.optional(),
  excluirTipos: ListaTipos.optional(),
};
export const ListarEventosDto = PaginacaoDto.extend(FiltrosQuery);
/**
 * Mesmos filtros no corpo, mais o nome e a placa (texto). Placa é dado pessoal e, como o nome, não vai em URL/query
 * string (cai em log): por isso NÃO está em `FiltrosQuery`. A leitura do Master usa `ListarEventosDto` (query) e mascara
 * a placa na resposta; um filtro de placa ali permitiria confirmar uma placa inteira por tentativa.
 */
export const FiltrosCorpo = z.strictObject({
  eventoId: z.uuid().optional(), de: Instante.optional(), ate: Instante.optional(), unidadeId: z.uuid().optional(),
  pessoaId: z.uuid().optional(), pessoa: Texto(100).optional(), placa: Texto(10).optional(), operadorId: z.uuid().optional(),
  tipo: z.enum(tipoEvento.enumValues).optional(), meio: z.enum(meioAutorizacao.enumValues).optional(),
  somenteExcecoes: z.boolean().optional(), somenteRetroativos: z.boolean().optional(),
  excluirTipos: z.array(z.enum(tipoEvento.enumValues)).max(5).optional(),
});
export const BuscaEventosDto = FiltrosCorpo.extend({
  limite: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
});

export const NovaAutorizacaoDto = z.strictObject({
  unidadeId: z.uuid().nullable().default(null),
  areaComumId: z.uuid().nullable().optional(),
  pessoaId: z.uuid(),
  validaDe: Dia.optional(),
  validaAte: Dia.nullable(),
  diasSemana: z.array(z.number().int().min(0).max(6)).max(7).nullable().default(null),
  horaInicio: Hora.nullable().default(null),
  horaFim: Hora.nullable().default(null),
  solicitadaPorPessoaId: z.uuid().nullable().default(null),
  justificativa: Texto(500).nullable().optional(),
});
export const VigentesDto = z.strictObject({ pessoaId: z.uuid(), unidadeId: z.uuid().optional(), areaComumId: z.uuid().optional() });
export const PrevistasDto = z.strictObject({ horas: z.coerce.number().int().min(1).max(24).default(12) });
export const DaUnidadeDto = z.strictObject({ unidadeId: z.uuid() });
export const NovaRestricaoDto = z.strictObject({
  pessoaId: z.uuid(), unidadeId: z.uuid().nullable().default(null), motivo: Texto(300), validaAte: Dia.nullable(),
  solicitadaPorPessoaId: z.uuid().nullable().default(null), paraTodoCondominio: z.boolean().optional(),
});
export const VerificarDto = z.strictObject({ pessoaId: z.uuid(), unidadeId: z.uuid().optional() });
export const UltimoVeiculoDto = z.strictObject({ pessoaId: z.uuid() });
