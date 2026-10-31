// LGPD (spec §6.7, §9.1, §9.3): exportação do titular (SI/AD), anonimização a pedido (SI) e retenção sob demanda (SI).
import { Controller, Get, HttpCode, Inject, Module, Param, Post } from '@nestjs/common';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { erroApi } from '../comum/erros';
import { uuidParam } from '../comum/zod.pipe';
import { CofreDocumentos } from '../documentos/cofre';
import { AcessoModule } from '../eventos/acesso.module';
import { TravaJobs } from '../jobs/trava';
import { SeloModule } from '../selo/selo.module';
import { LgpdService } from './lgpd.service';
import { RetencaoService } from './retencao.service';

@Controller('lgpd')
export class LgpdController {
  constructor(
    @Inject(LgpdService) private readonly lgpd: LgpdService,
    @Inject(RetencaoService) private readonly retencao: RetencaoService,
    @Inject(TravaJobs) private readonly trava: TravaJobs,
  ) {}

  /** JSON do titular (art. 18, II), no envelope `{ nomeArquivo, conteudo, quantidade }` das outras exportações. */
  @Get('pessoas/:id/exportacao')
  @Acao('lgpd.exportar')
  exportar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) { return this.lgpd.exportar(ctx, id); }

  @Post('pessoas/:id/anonimizar')
  @Acao('lgpd.anonimizar')
  @HttpCode(200)
  anonimizar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) { return this.lgpd.anonimizar(ctx, id); }

  /** Roda a retenção agora (a mesma rotina do agendador). 409 se outra execução estiver em andamento. */
  @Post('retencao')
  @Acao('lgpd.retencao')
  @HttpCode(200)
  async aplicar(@Ctx() ctx: Contexto) {
    const r = await this.trava.tentar('retencao', () => this.retencao.aplicar({ ator: ctx.ator, ip: ctx.ip }));
    if (!r.obtida) throw erroApi(409, 'RETENCAO_EM_ANDAMENTO', 'A retenção já está rodando. Aguarde alguns instantes.');
    return r.valor;
  }

  @Get('retencao')
  @Acao('lgpd.retencao')
  ultima() { return this.retencao.ultima(); }
}

@Module({
  imports: [AcessoModule, SeloModule],
  controllers: [LgpdController],
  providers: [LgpdService, RetencaoService, CofreDocumentos],
  exports: [LgpdService, RetencaoService],
})
export class LgpdModule {}
