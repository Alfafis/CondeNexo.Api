// Leitura dos dados de um condomínio pelo app do Master (SAAS-09, F5 entrega 2): "tudo que o síndico vê", só leitura,
// com as MESMAS views que o síndico recebe (os serviços são os de sempre, na subárvore do condomínio), MINIMIZADAS na
// saída: nome de terceiro mascarado, texto livre oculto, placa mascarada (minimizacao.ts). Cada rota passa pelo
// AcessoPlataformaService.ler, que resolve o condomínio e minimiza. Desde 2026-11-01 (Fase B) sem motivo e sem trilha;
// o valor completo de um registro é o "Revelar" (revelar-master.controller.ts), esse sim registrado.
//
// Fora daqui, de propósito:
//  - escrita de qualquer tipo (a única exceção é a gestão de síndicos, §5.5, em sindicos-master.controller.ts, com
//    reautenticação e motivo; a CLI de nova senha continua para o operador da VPS);
//  - exportação LGPD do titular (GET /lgpd/pessoas/:id/exportacao): leva CPF e telefone em claro (art. 18, II) e é
//    resposta do CONTROLADOR ao titular. O Master vê só o que vem mascarado;
//  - a trilha de alterações e a verificação de integridade (auditoria/*): não fazem parte do que o síndico consulta no
//    dia a dia e não servem ao suporte; ficam para quando houver pedido.
import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { ListarEncomendasDto, ResumoEncomendasDto } from '../encomendas/encomendas.schemas';
import { EncomendasService } from '../encomendas/encomendas.service';
import { DaUnidadeDto, ListarEventosDto } from '../acesso/acesso.schemas';
import { AutorizacoesService } from '../eventos/autorizacoes.service';
import { EventosService } from '../eventos/eventos.service';
import { FuncionariosService } from '../funcionarios/funcionarios.service';
import { ListarOcorrenciasDto } from '../ocorrencias/ocorrencias.schemas';
import { OcorrenciasService } from '../ocorrencias/ocorrencias.service';
import { ListarPessoasDto } from '../pessoas/pessoas.module';
import { PessoasService } from '../pessoas/pessoas.service';
import { FiltroRelatorioDto } from '../relatorios/relatorios.schemas';
import { RelatoriosService } from '../relatorios/relatorios.service';
import { ResolvedorCondominio } from '../tenancy/resolvedor';
import { ListarUnidadesDto } from '../unidades/unidades.controller';
import { UnidadesService } from '../unidades/unidades.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { ListarVinculosDto } from '../vinculos/vinculos.controller';
import { VinculosService } from '../vinculos/vinculos.service';
import { AcessoPlataformaService, type Servicos } from './acesso-plataforma.service';
import { PlataformaAcao } from './decorators';

/** O síndico: a visão de partida do Master (SAAS-09, "nada a mais que o síndico"), depois minimizada. */
const VISAO = 'sindico' as const;

/** uuid ou código legível ("A-32"), como em GET /unidades/:ref. */
const refParam = new ZodPipe(z.string().trim().min(1).max(40));

@Controller('plataforma/condominios/:id')
@PlataformaAcao('condominio.ler')
export class LeituraMasterController {
  constructor(
    @Inject(AcessoPlataformaService) private readonly acesso: AcessoPlataformaService,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
  ) {}

  private ler<T>(id: string, fn: (s: Servicos) => Promise<T>) {
    return this.acesso.ler(id, fn);
  }

  // ----- Unidades e catálogo ----------------------------------------------------------------------------------------

  @Get('catalogo')
  catalogo(@Param('id', uuidParam) id: string) {
    // Como GET /catalogo do condomínio: o catálogo e os módulos ligados.
    return this.ler(id, async (s) => ({ ...(await (await s(UnidadesService)).catalogo()), modulos: await this.resolvedor.modulosDe(id) }));
  }

  @Get('unidades')
  unidades(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(ListarUnidadesDto)) q: z.infer<typeof ListarUnidadesDto>) {
    return this.ler(id, async (s) => (await s(UnidadesService)).listar(q));
  }

  @Get('unidades/:ref')
  unidade(@Param('id', uuidParam) id: string, @Param('ref', refParam) ref: string) {
    return this.ler(id, async (s) => (await s(UnidadesService)).detalhe(ref));
  }

  @Get('unidades/:unidadeId/autorizadores')
  autorizadores(@Param('id', uuidParam) id: string, @Param('unidadeId', uuidParam) unidadeId: string) {
    return this.ler(id, async (s) => (await s(VinculosService)).autorizadores(unidadeId));
  }

  // ----- Usuários (sem hash nem nada de senha: a mesma view da tela Usuários) ---------------------------------------

  @Get('usuarios')
  usuarios(@Param('id', uuidParam) id: string, @Query(new ZodPipe(PaginacaoDto)) q: z.infer<typeof PaginacaoDto>) {
    return this.ler(id, async (s) => (await s(UsuariosService)).listar(q));
  }

  /** Só os síndicos (ativos e desativados), sem paginação: a aba "Síndicos" do app do Master. */
  @Get('sindicos')
  sindicos(@Param('id', uuidParam) id: string) {
    return this.ler(id, async (s) => (await s(UsuariosService)).sindicos());
  }

  // ----- Pessoas, vínculos, funcionários ----------------------------------------------------------------------------

  @Get('pessoas')
  pessoas(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(ListarPessoasDto)) q: z.infer<typeof ListarPessoasDto>) {
    return this.ler(id, async (s) => (await s(PessoasService)).listar(VISAO, q));
  }

  @Get('pessoas/:pessoaId')
  pessoa(@Param('id', uuidParam) id: string, @Param('pessoaId', uuidParam) pessoaId: string) {
    return this.ler(id, async (s) => (await s(PessoasService)).ficha(VISAO, pessoaId));
  }

  @Get('vinculos')
  vinculos(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(ListarVinculosDto)) q: z.infer<typeof ListarVinculosDto>) {
    return this.ler(id, async (s) => (await s(VinculosService)).listar(q));
  }

  @Get('vinculos/:vinculoId')
  vinculo(@Param('id', uuidParam) id: string, @Param('vinculoId', uuidParam) vinculoId: string) {
    return this.ler(id, async (s) => (await s(VinculosService)).obter(vinculoId));
  }

  @Get('funcionarios')
  funcionarios(@Param('id', uuidParam) id: string, @Query(new ZodPipe(PaginacaoDto)) q: z.infer<typeof PaginacaoDto>) {
    return this.ler(id, async (s) => (await s(FuncionariosService)).listar(q));
  }

  @Get('funcionarios/:pessoaId')
  funcionario(@Param('id', uuidParam) id: string, @Param('pessoaId', uuidParam) pessoaId: string) {
    return this.ler(id, async (s) => (await s(FuncionariosService)).obter(pessoaId));
  }

  // ----- Eventos de acesso, presentes, exportação ----------------------------------------------------------------------

  @Get('eventos-acesso')
  eventos(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(ListarEventosDto)) q: z.infer<typeof ListarEventosDto>) {
    return this.ler(id, async (s) => (await s(EventosService)).listar(q));
  }

  @Get('eventos-acesso/:eventoId')
  evento(@Param('id', uuidParam) id: string, @Param('eventoId', uuidParam) eventoId: string) {
    return this.ler(id, async (s) => (await s(EventosService)).obter(eventoId));
  }

  @Get('eventos-acesso/:eventoId/correcoes')
  correcoes(@Param('id', uuidParam) id: string, @Param('eventoId', uuidParam) eventoId: string) {
    return this.ler(id, async (s) => (await s(EventosService)).correcoesDe(eventoId));
  }

  @Get('acessos/presentes')
  presentes(@Param('id', uuidParam) id: string, @Query(new ZodPipe(PaginacaoDto)) q: z.infer<typeof PaginacaoDto>) {
    return this.ler(id, async (s) => (await s(EventosService)).presentes(q));
  }

  // Sem exportação JSONL para o Master (2026-10-30): a linha `evento` leva o texto livre e a placa sob o hash e não
  // pode ser minimizada sem quebrar a verificação. A conferência offline é do condomínio (tela Histórico do síndico).


  // ----- Autorizações prévias e restrições -----------------------------------------------------------------------------

  @Get('autorizacoes-previas/hoje')
  autorizacoesHoje(@Param('id', uuidParam) id: string) {
    return this.ler(id, async (s) => (await s(AutorizacoesService)).hoje());
  }

  @Get('autorizacoes-previas')
  autorizacoesDaUnidade(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(DaUnidadeDto)) q: z.infer<typeof DaUnidadeDto>) {
    return this.ler(id, async (s) => (await s(AutorizacoesService)).autorizacoesDaUnidade(q.unidadeId));
  }

  @Get('restricoes/pendentes')
  restricoesPendentes(@Param('id', uuidParam) id: string) {
    return this.ler(id, async (s) => (await s(AutorizacoesService)).pendentes());
  }

  @Get('restricoes')
  restricoesDaUnidade(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(DaUnidadeDto)) q: z.infer<typeof DaUnidadeDto>) {
    return this.ler(id, async (s) => (await s(AutorizacoesService)).restricoesDaUnidade(q.unidadeId));
  }

  // ----- Encomendas e ocorrências ------------------------------------------------------------------------------------

  @Get('encomendas')
  encomendas(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(ListarEncomendasDto)) q: z.infer<typeof ListarEncomendasDto>) {
    return this.ler(id, async (s) => (await s(EncomendasService)).listar(q));
  }

  @Get('encomendas/resumo')
  encomendasResumo(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(ResumoEncomendasDto)) q: z.infer<typeof ResumoEncomendasDto>) {
    return this.ler(id, async (s) => (await s(EncomendasService)).resumo(q.dias));
  }

  @Get('encomendas/:encomendaId')
  encomenda(@Param('id', uuidParam) id: string, @Param('encomendaId', uuidParam) encomendaId: string) {
    return this.ler(id, async (s) => (await s(EncomendasService)).obter(encomendaId));
  }

  @Get('ocorrencias')
  ocorrencias(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(ListarOcorrenciasDto)) q: z.infer<typeof ListarOcorrenciasDto>) {
    return this.ler(id, async (s) => (await s(OcorrenciasService)).listar(q));
  }

  @Get('ocorrencias/:ocorrenciaId')
  ocorrencia(@Param('id', uuidParam) id: string, @Param('ocorrenciaId', uuidParam) ocorrenciaId: string) {
    return this.ler(id, async (s) => (await s(OcorrenciasService)).obter(ocorrenciaId));
  }

  @Get('ocorrencias/:ocorrenciaId/historico')
  ocorrenciaHistorico(@Param('id', uuidParam) id: string, @Param('ocorrenciaId', uuidParam) ocorrenciaId: string) {
    return this.ler(id, async (s) => (await s(OcorrenciasService)).historico(ocorrenciaId));
  }

  /** Anexo decifrado, como download (os mesmos cabeçalhos da rota do condomínio). */
  @Get('ocorrencias/:ocorrenciaId/anexos/:documentoId')
  async anexo(@Param('id', uuidParam) id: string, @Param('ocorrenciaId', uuidParam) ocorrenciaId: string,
    @Param('documentoId', uuidParam) documentoId: string, @Res() res: Response) {
    const a = await this.ler(id, async (s) => (await s(OcorrenciasService)).lerAnexo(ocorrenciaId, documentoId));
    res.status(200);
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Length', String(a.conteudo.length));
    res.setHeader('Content-Disposition', `attachment; filename="${a.nome}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(a.conteudo);
  }

  // ----- Relatórios ----------------------------------------------------------------------------------------------------

  @Get('relatorios/resumo')
  relatorio(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(FiltroRelatorioDto)) q: z.infer<typeof FiltroRelatorioDto>) {
    return this.ler(id, async (s) => (await s(RelatoriosService)).resumo(q));
  }

  /** `{ nomeArquivo, conteudo, quantidade }`, como GET /relatorios/resumo/csv. */
  @Get('relatorios/resumo/csv')
  relatorioCsv(@Param('id', uuidParam) id: string,
    @Query(new ZodPipe(FiltroRelatorioDto)) q: z.infer<typeof FiltroRelatorioDto>) {
    return this.ler(id, async (s) => (await s(RelatoriosService)).csv(q));
  }
}
