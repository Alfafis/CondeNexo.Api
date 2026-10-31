// Vínculos (spec §6.2, RF-03 a RF-07). Leitura: vinculo.ver (SI, AD, AU); criação: vinculo.criar; conferência, decisão,
// regularização e encerramento: vinculo.decidir (SI, AD; RN-03: porteiro não aprova). Autorizadores: unidade.ver (a
// portaria precisa deles no registro de acesso).
import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post, Query } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { ehDiaValido } from '../comum/datas';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { DB, type Db } from '../database/database.module';
import { statusVinculo, tipoComprovante, tipoVinculo, vinculoUnidade } from '../db/schema';
import { UnidadesModule } from '../unidades/unidades.module';
import { VinculosService } from './vinculos.service';

const Dia = z.string().refine(ehDiaValido, { message: 'data inválida (AAAA-MM-DD)' });
const ContagemDto = z.strictObject({ status: z.enum(statusVinculo.enumValues) });
export const ListarVinculosDto = PaginacaoDto.extend({
  /** `status=pendente` ou `status=aprovado,rejeitado`. */
  status: z.string().max(80).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(statusVinculo.enumValues)).min(1).max(5)).optional(),
  unidadeId: z.uuid().optional(),
  pessoaId: z.uuid().optional(),
  ordem: z.enum(['recentes', 'decisao', 'prazo']).default('recentes'),
});
const NovoVinculoDto = z.strictObject({
  pessoaId: z.uuid({ message: 'pessoa inválida' }),
  unidadeId: z.uuid({ message: 'unidade inválida' }),
  tipo: z.enum(tipoVinculo.enumValues),
  vigenciaInicio: Dia.nullable().default(null),
  vigenciaFim: Dia.nullable().default(null),
});
const ConferenciaDto = z.strictObject({
  tipo: z.enum(tipoComprovante.enumValues),
  descricao: z.string().max(200).optional(),
  observacao: z.string().max(400).optional(),
  data: Dia.optional(),
});
/** POST sem corpo chega como `undefined`: vale como `{}` (os campos têm padrão; o serviço responde 422 legível). */
const corpo = <T extends z.ZodType>(s: T) => z.preprocess((x) => x ?? {}, s);
const RejeicaoDto = corpo(z.strictObject({ justificativa: z.string().max(500).default('') }));
const RegularizacaoDto = corpo(z.strictObject({ vigenciaFim: Dia.nullable().optional() }));
const EncerramentoDto = corpo(z.strictObject({ motivo: z.string().max(500).default(''), data: Dia.optional() }));

@Controller()
export class VinculosController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VinculosService) private readonly vinculos: VinculosService,
  ) {}

  /** `{ status, total }`. Varre a tabela de vínculos pelo status: ela cresce com os moradores (centenas a poucos milhares), não com os acessos. */
  @Get('vinculos/contagem')
  @Acao('vinculo.ver')
  async contagem(@Query(new ZodPipe(ContagemDto)) q: z.infer<typeof ContagemDto>) {
    const [r] = await this.db.select({ total: count() }).from(vinculoUnidade).where(eq(vinculoUnidade.status, q.status));
    return { status: q.status, total: Number(r?.total ?? 0) };
  }

  @Get('vinculos')
  @Acao('vinculo.ver')
  listar(@Query(new ZodPipe(ListarVinculosDto)) q: z.infer<typeof ListarVinculosDto>) {
    return this.vinculos.listar(q);
  }

  @Get('vinculos/:id')
  @Acao('vinculo.ver')
  obter(@Param('id', uuidParam) id: string) {
    return this.vinculos.obter(id);
  }

  @Post('vinculos')
  @Acao('vinculo.criar')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovoVinculoDto)) b: z.infer<typeof NovoVinculoDto>) {
    return this.vinculos.criar(ctx, b);
  }

  /** RF-05: 201, a conferência é um registro novo (a anterior fica no audit_log). */
  @Post('vinculos/:id/conferencias')
  @Acao('vinculo.decidir')
  conferir(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(ConferenciaDto)) b: z.infer<typeof ConferenciaDto>) {
    return this.vinculos.conferir(ctx, id, b);
  }

  @Post('vinculos/:id/aprovar')
  @Acao('vinculo.decidir')
  @HttpCode(200)
  aprovar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.vinculos.aprovar(ctx, id);
  }

  @Post('vinculos/:id/rejeitar')
  @Acao('vinculo.decidir')
  @HttpCode(200)
  rejeitar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(RejeicaoDto)) b: z.infer<typeof RejeicaoDto>) {
    return this.vinculos.rejeitar(ctx, id, b.justificativa);
  }

  @Post('vinculos/:id/regularizar')
  @Acao('vinculo.decidir')
  @HttpCode(200)
  regularizar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(RegularizacaoDto)) b: z.infer<typeof RegularizacaoDto>) {
    return this.vinculos.regularizar(ctx, id, b);
  }

  @Post('vinculos/:id/encerrar')
  @Acao('vinculo.decidir')
  @HttpCode(200)
  encerrar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(EncerramentoDto)) b: z.infer<typeof EncerramentoDto>) {
    return this.vinculos.encerrar(ctx, id, b);
  }

  /** Moradores com vínculo válido na unidade (autorizam visita e retirada de encomenda). */
  @Get('unidades/:id/autorizadores')
  @Acao('unidade.ver')
  autorizadores(@Param('id', uuidParam) id: string) {
    return this.vinculos.autorizadores(id);
  }
}

@Module({ imports: [UnidadesModule], controllers: [VinculosController], providers: [VinculosService] })
export class VinculosModule {}
