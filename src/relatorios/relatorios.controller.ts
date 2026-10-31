import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Acao } from '../auth/decorators';
import { ZodPipe } from '../comum/zod.pipe';
import { Modulo } from '../tenancy/modulo.guard';
import { FiltroRelatorioDto, type Filtro } from './relatorios.schemas';
import { RelatoriosService } from './relatorios.service';

@Modulo('relatorios')
@Controller('relatorios')
export class RelatoriosController {
  constructor(@Inject(RelatoriosService) private readonly servico: RelatoriosService) {}

  @Get('resumo')
  @Acao('relatorio.ver')
  resumo(@Query(new ZodPipe(FiltroRelatorioDto)) q: Filtro) { return this.servico.resumo(q); }

  /** `{ nomeArquivo, conteudo, quantidade }` (UTF-8 com BOM, separador ";"). */
  @Get('resumo/csv')
  @Acao('relatorio.ver')
  csv(@Query(new ZodPipe(FiltroRelatorioDto)) q: Filtro) { return this.servico.csv(q); }
}
