import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { DIAS_ENCOMENDA_ATRASADA } from '../dominio/rules';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { Modulo } from '../tenancy/modulo.guard';
import { AutorizarDto, EntregarDto, ListarEncomendasDto, ReceberDto, ResumoEncomendasDto } from './encomendas.schemas';
import { EncomendasService } from './encomendas.service';

@Modulo('encomendas')
@Controller('encomendas')
export class EncomendasController {
  constructor(@Inject(EncomendasService) private readonly s: EncomendasService) {}

  @Get()
  @Acao('encomenda.ver')
  listar(@Query(new ZodPipe(ListarEncomendasDto)) q: z.infer<typeof ListarEncomendasDto>) {
    return this.s.listar(q);
  }

  /** Contagens das abas e do painel: aguardando, atrasadas (há mais de `dias`, padrão 7) e entregues. */
  @Get('resumo')
  @Acao('encomenda.ver')
  resumo(@Query(new ZodPipe(ResumoEncomendasDto)) q: z.infer<typeof ResumoEncomendasDto>) {
    return this.s.resumo(q.dias);
  }

  /** RF-26: aguardando há mais de N dias (padrão 7), paginado. Atalho de GET /encomendas?atrasadasDias=N. */
  @Get('atrasadas')
  @Acao('encomenda.ver')
  atrasadas(@Query(new ZodPipe(PaginacaoDto.extend({ dias: z.coerce.number().int().min(0).max(365).default(DIAS_ENCOMENDA_ATRASADA) })))
    q: { limite: number; cursor?: string; dias: number }) {
    return this.s.listar({ limite: q.limite, cursor: q.cursor, atrasadasDias: q.dias });
  }

  @Get(':id')
  @Acao('encomenda.ver')
  obter(@Param('id', uuidParam) id: string) {
    return this.s.obter(id);
  }

  @Post()
  @Acao('encomenda.operar')
  receber(@Ctx() ctx: Contexto, @Body(new ZodPipe(ReceberDto)) b: z.infer<typeof ReceberDto>) {
    return this.s.receber(ctx, b);
  }

  /** RF-25: transição (a encomenda passa a retirada); 200 com a encomenda. */
  @Post(':id/retirada')
  @Acao('encomenda.operar')
  @HttpCode(200)
  entregar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(EntregarDto)) b: z.infer<typeof EntregarDto>) {
    return this.s.entregar(ctx, id, b.pessoaId);
  }

  @Post(':id/autorizacoes-retirada')
  @Acao('encomenda.autorizar_retirada')
  autorizar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(AutorizarDto)) b: z.infer<typeof AutorizarDto>) {
    return this.s.autorizarRetirada(ctx, id, b);
  }
}
