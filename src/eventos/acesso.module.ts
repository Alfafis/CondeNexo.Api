// M2 — Controle de acesso (spec §6.3): eventos, autorizações prévias, restrições, presentes e resumo do turno.
// Permissões da MATRIZ (../dominio/rbac, fonte única). Instantes em epoch ms; datas de calendário 'AAAA-MM-DD'.
// A listagem com texto de nome (pode identificar alguém) vai por POST /eventos-acesso/busca, com o termo no corpo:
// a query string fica nos logs de proxy e da borda (mesma regra de POST /pessoas/busca).
import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { ehDiaValido } from '../comum/datas';
import { erroApi } from '../comum/erros';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { MEIOS_COM_MORADOR } from '../dominio/rules';
import { meioAutorizacao, tipoEvento, tipoVisita } from '../db/schema';
import { UnidadesModule } from '../unidades/unidades.module';
import { AutorizacoesService } from './autorizacoes.service';
import { EventosService } from './eventos.service';
import { Modulo } from '../saas/modulo.guard';

const Instante = z.number().int().min(0).max(8_640_000_000_000);
const Dia = z.string().refine(ehDiaValido, { message: 'data inválida (AAAA-MM-DD)' });
const Texto = (max: number) => z.string().max(max);
const Hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'hora inválida (HH:MM)' });
/** POST sem corpo chega como `undefined`: vale como `{}`. */
const corpo = <T extends z.ZodType>(s: T) => z.preprocess((x) => x ?? {}, s);

const NovoEventoDto = z.strictObject({
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
const AvaliacaoEntradaDto = NovoEventoDto.pick({
  pessoaId: true, unidadeDestinoId: true, areaComumId: true, autorizadoPorTipo: true, autorizadoPorPessoaId: true,
  autorizacaoPreviaId: true, justificativa: true, retroativo: true, ocorridoEm: true, tipoVisita: true,
});
const NovaRecusaDto = z.strictObject({
  pessoaId: z.uuid(), unidadeDestinoId: z.uuid(), meio: z.enum(MEIOS_COM_MORADOR), moradorPessoaId: z.uuid(),
  observacao: Texto(500).nullable().optional(), retroativo: z.boolean().optional(), ocorridoEm: Instante.nullable().optional(),
  formularioContingencia: Texto(60).nullable().optional(),
});
const SaidaDto = corpo(z.strictObject({
  observacao: Texto(500).nullable().optional(), retroativo: z.boolean().optional(), ocorridoEm: Instante.nullable().optional(),
  formularioContingencia: Texto(60).nullable().optional(),
}));
/** "+1h" fixo: sem parâmetro (o tamanho e os limites são regra do domain). */
const ProrrogacaoDto = corpo(z.strictObject({}));
const CorrecaoDto = z.strictObject({
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
const BuscaEventosDto = FiltrosCorpo.extend({
  limite: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
});

const NovaAutorizacaoDto = z.strictObject({
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
const VigentesDto = z.strictObject({ pessoaId: z.uuid(), unidadeId: z.uuid().optional(), areaComumId: z.uuid().optional() });
const PrevistasDto = z.strictObject({ horas: z.coerce.number().int().min(1).max(24).default(12) });
export const DaUnidadeDto = z.strictObject({ unidadeId: z.uuid() });
const NovaRestricaoDto = z.strictObject({
  pessoaId: z.uuid(), unidadeId: z.uuid().nullable().default(null), motivo: Texto(300), validaAte: Dia.nullable(),
  solicitadaPorPessoaId: z.uuid().nullable().default(null), paraTodoCondominio: z.boolean().optional(),
});
const VerificarDto = z.strictObject({ pessoaId: z.uuid(), unidadeId: z.uuid().optional() });
const UltimoVeiculoDto = z.strictObject({ pessoaId: z.uuid() });

@Controller()
export class AcessoController {
  constructor(
    @Inject(EventosService) private readonly eventos: EventosService,
    @Inject(AutorizacoesService) private readonly autorizacoes: AutorizacoesService,
  ) {}

  // ----- Eventos (RF-12, RF-13, RF-16, RF-17, RF-19, RF-35, RN-04) ----------------------------------------------------

  @Post('eventos-acesso')
  @Acao('evento.registrar')
  entrada(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovoEventoDto)) b: z.infer<typeof NovoEventoDto>) {
    return this.eventos.criarEntrada(ctx, b);
  }

  /**
   * Avalia o rascunho de uma entrada sem gravar (200): a tela de entrada monta meios, autorizações, escala e prazo e
   * habilita "Confirmar" pelo que a API responde, não por regra própria. O registro (POST /eventos-acesso) decide de novo.
   */
  @Post('eventos-acesso/avaliacao')
  @Acao('evento.registrar')
  @HttpCode(200)
  avaliar(@Ctx() ctx: Contexto, @Body(new ZodPipe(AvaliacaoEntradaDto)) b: z.infer<typeof AvaliacaoEntradaDto>) {
    return this.eventos.avaliarEntrada(ctx, b);
  }

  /** UC02 A4: recusa do morador (evento "recusado"). */
  @Post('eventos-acesso/recusas')
  @Acao('evento.registrar')
  recusa(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovaRecusaDto)) b: z.infer<typeof NovaRecusaDto>) {
    return this.eventos.registrarRecusa(ctx, b);
  }

  /** 201: a saída é um evento novo (a entrada não muda). */
  @Post('eventos-acesso/:id/saida')
  @Acao('evento.registrar')
  saida(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(SaidaDto)) b: z.infer<typeof SaidaDto>) {
    return this.eventos.registrarSaida(ctx, id, b);
  }

  /** Prorrogação "+1h" do prazo de permanência (tabela à parte: o evento e a cadeia não mudam). 201: linha nova. */
  @Post('eventos-acesso/:id/permanencia/prorrogacoes')
  @Acao('evento.registrar')
  prorrogar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(ProrrogacaoDto)) _b: z.infer<typeof ProrrogacaoDto>) {
    return this.eventos.prorrogarPermanencia(ctx, id);
  }

  @Post('eventos-acesso/:id/correcoes')
  @Acao('evento.corrigir')
  corrigir(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(CorrecaoDto)) b: z.infer<typeof CorrecaoDto>) {
    return this.eventos.corrigir(ctx, id, b);
  }

  @Get('eventos-acesso')
  @Acao('evento.ver')
  listar(@Query(new ZodPipe(ListarEventosDto)) q: z.infer<typeof ListarEventosDto>) {
    return this.eventos.listar(q);
  }

  /** Mesma listagem, com o nome da pessoa (texto) no corpo. 200: é consulta, não cria nada. */
  @Post('eventos-acesso/busca')
  @Acao('evento.ver')
  @HttpCode(200)
  buscar(@Body(new ZodPipe(BuscaEventosDto)) b: z.infer<typeof BuscaEventosDto>) {
    return this.eventos.listar(b);
  }

  @Get('eventos-acesso/:id')
  @Acao('evento.ver')
  obter(@Param('id', uuidParam) id: string) {
    return this.eventos.obter(id);
  }

  @Get('eventos-acesso/:id/correcoes')
  @Acao('evento.ver')
  correcoes(@Param('id', uuidParam) id: string) {
    return this.eventos.correcoesDe(id);
  }

  /** RF-20: quem está dentro (entradas sem saída), paginado por seq. */
  @Get('acessos/presentes')
  @Acao('evento.ver')
  presentes(@Query(new ZodPipe(PaginacaoDto)) q: z.infer<typeof PaginacaoDto>) {
    return this.eventos.presentes(q);
  }

  /**
   * Veículo da última entrada com veículo da pessoa, para o porteiro repetir na entrada ("mesmo veículo da última
   * visita"). Só quem registra entrada. `{ veiculo: null }` se não houver (ou se o cadastro foi anonimizado).
   */
  @Get('acessos/ultimo-veiculo')
  @Acao('evento.registrar')
  ultimoVeiculo(@Query(new ZodPipe(UltimoVeiculoDto)) q: z.infer<typeof UltimoVeiculoDto>) {
    return this.eventos.ultimoVeiculo(q.pessoaId);
  }

  /** RF-29: passagem de turno. */
  @Get('turnos/resumo')
  @Acao('turno.ver')
  turno() {
    return this.eventos.resumoTurno();
  }

  // ----- Autorizações prévias (RF-14, RN-07, RF-36) ---------------------------------------------------------------------
  // Módulo `autorizacoes_previas` (SAAS-19), por handler: o resto deste controller (eventos, restrições) é núcleo.

  @Post('autorizacoes-previas')
  @Modulo('autorizacoes_previas')
  @Acao('autorizacao.criar')
  criarAutorizacao(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovaAutorizacaoDto)) b: z.infer<typeof NovaAutorizacaoDto>) {
    return this.autorizacoes.criarAutorizacao(ctx, b);
  }

  @Post('autorizacoes-previas/:id/revogar')
  @Modulo('autorizacoes_previas')
  @Acao('autorizacao.criar')
  @HttpCode(204)
  async revogarAutorizacao(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    await this.autorizacoes.revogarAutorizacao(ctx, id);
  }

  @Get('autorizacoes-previas/vigentes')
  @Modulo('autorizacoes_previas')
  @Acao('autorizacao.criar')
  vigentes(@Query(new ZodPipe(VigentesDto)) q: z.infer<typeof VigentesDto>) {
    if (!!q.unidadeId === !!q.areaComumId) throw erroApi(400, 'DADOS_INVALIDOS', 'Informe a unidade OU a área comum.', [{ field: 'unidadeId', message: 'unidade ou área comum' }]);
    return this.autorizacoes.vigentes(q.pessoaId, q);
  }

  @Get('autorizacoes-previas/hoje')
  @Modulo('autorizacoes_previas')
  @Acao('unidade.ver')
  autorizacoesHoje() {
    return this.autorizacoes.hoje();
  }

  /** Previstos nas próximas `horas` h (1 a 24, padrão 12), de quem ainda não está dentro. Mesma permissão de `hoje`. Sem CPF/telefone. */
  @Get('autorizacoes-previas/previstas')
  @Modulo('autorizacoes_previas')
  @Acao('unidade.ver')
  previstas(@Query(new ZodPipe(PrevistasDto)) q: z.infer<typeof PrevistasDto>) {
    return this.autorizacoes.previstas(q.horas);
  }

  /** Detalhe da unidade: autorizações não revogadas e não vencidas. */
  @Get('autorizacoes-previas')
  @Modulo('autorizacoes_previas')
  @Acao('unidade.ver')
  autorizacoesDaUnidade(@Query(new ZodPipe(DaUnidadeDto)) q: z.infer<typeof DaUnidadeDto>) {
    return this.autorizacoes.autorizacoesDaUnidade(q.unidadeId);
  }

  // ----- Restrições (RF-15, RF-16, RN-06) -------------------------------------------------------------------------------

  /** RF-16: checagem antes do registro. Sem unidade: só as de condomínio (funcionário em escala). */
  @Get('restricoes/verificar')
  @Acao('unidade.ver')
  verificar(@Query(new ZodPipe(VerificarDto)) q: z.infer<typeof VerificarDto>) {
    return this.autorizacoes.verificar(q.pessoaId, q.unidadeId ?? null);
  }

  @Post('restricoes')
  @Acao('restricao.criar')
  criarRestricao(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovaRestricaoDto)) b: z.infer<typeof NovaRestricaoDto>) {
    return this.autorizacoes.criarRestricao(ctx, b);
  }

  @Post('restricoes/:id/aprovar')
  @Acao('restricao.aprovar')
  @HttpCode(200)
  aprovar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.autorizacoes.aprovar(ctx, id);
  }

  @Post('restricoes/:id/revogar')
  @Acao('unidade.editar')
  @HttpCode(204)
  async revogarRestricao(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    await this.autorizacoes.revogarRestricao(ctx, id);
  }

  @Get('restricoes/pendentes')
  @Acao('unidade.ver')
  pendentes() {
    return this.autorizacoes.pendentes();
  }

  /** Detalhe da unidade: restrições com origem nela, vigentes. */
  @Get('restricoes')
  @Acao('unidade.ver')
  restricoesDaUnidade(@Query(new ZodPipe(DaUnidadeDto)) q: z.infer<typeof DaUnidadeDto>) {
    return this.autorizacoes.restricoesDaUnidade(q.unidadeId);
  }
}

@Module({
  imports: [UnidadesModule],
  controllers: [AcessoController],
  providers: [EventosService, AutorizacoesService],
  exports: [EventosService],
})
export class AcessoModule {}
