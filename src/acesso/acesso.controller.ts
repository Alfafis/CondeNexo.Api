// M2 — Controle de acesso (spec §6.3): eventos, autorizações prévias, restrições, presentes e resumo do turno.
// Permissões da MATRIZ (../dominio/rbac, fonte única). Instantes em epoch ms; datas de calendário 'AAAA-MM-DD'.
// A listagem com texto de nome (pode identificar alguém) vai por POST /eventos-acesso/busca, com o termo no corpo:
// a query string fica nos logs de proxy e da borda (mesma regra de POST /pessoas/busca).
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { erroApi } from '../comum/erros';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { Modulo } from '../tenancy/modulo.guard';
import { AutorizacoesService } from '../eventos/autorizacoes.service';
import { EventosService } from '../eventos/eventos.service';
import { NovoEventoDto, AvaliacaoEntradaDto, NovaRecusaDto, SaidaDto, ProrrogacaoDto, CorrecaoDto, ListarEventosDto, BuscaEventosDto, NovaAutorizacaoDto, VigentesDto, PrevistasDto, DaUnidadeDto, NovaRestricaoDto, VerificarDto, UltimoVeiculoDto } from './acesso.schemas';

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
