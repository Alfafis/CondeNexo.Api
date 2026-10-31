import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { Modulo } from '../tenancy/modulo.guard';
import { AnaliseDto, ConfirmacaoDto } from './importacao.schemas';
import { ImportacaoService } from './importacao.service';

@Modulo('importacao')
@Controller('importacoes')
export class ImportacaoController {
  constructor(@Inject(ImportacaoService) private readonly importacao: ImportacaoService) {}

  @Post()
  @Acao('importacao.executar')
  analisar(@Ctx() ctx: Contexto, @Body(new ZodPipe(AnaliseDto)) b: z.infer<typeof AnaliseDto>) { return this.importacao.analisar(ctx, b); }

  @Post(':id/confirmar')
  @Acao('importacao.executar')
  @HttpCode(200)
  confirmar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(ConfirmacaoDto)) b: z.infer<typeof ConfirmacaoDto>) {
    return this.importacao.confirmar(ctx, id, b.linhas);
  }
}
