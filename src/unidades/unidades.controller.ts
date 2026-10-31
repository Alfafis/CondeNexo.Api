// Rotas de unidades (spec §6.2, RF-01) e catálogo leve. Permissões da MATRIZ (../dominio/rbac):
// GET unidade.ver (todos); escrita unidade.editar (SI, AD). Catálogo: qualquer usuário logado (o Layout precisa dele).
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Autenticado, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { CONDOMINIO, type CondominioResolvido } from '../tenancy/condominio';
import { ResolvedorCondominio } from '../tenancy/resolvedor';
import { UnidadesService } from './unidades.service';

export const ListarUnidadesDto = PaginacaoDto.extend({ bloco: z.string().trim().regex(/^[A-Za-z0-9]{1,3}$/).optional() });

/** Corpo de criar/editar. A estrutura (bloco de 1 a 3 letras/dígitos, número de até 4 dígitos) é normalizada e
 *  validada no serviço com a regra do domain e responde 422 UNIDADE_INVALIDA; aqui só o tipo. */
const UnidadeDto = z.strictObject({ bloco: z.string().max(10), numero: z.string().max(10) });

/** uuid ou código legível ("A-32"). */
const refParam = new ZodPipe(z.string().trim().min(1).max(40));

@Controller()
export class UnidadesController {
  constructor(
    @Inject(UnidadesService) private readonly unidades: UnidadesService,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
  ) {}

  /** Catálogo leve e os módulos ligados do condomínio (SAAS-19), renovados a cada recarga do catálogo no front. */
  @Get('catalogo')
  @Autenticado()
  async catalogo() {
    const [c, modulos] = await Promise.all([this.unidades.catalogo(), this.condominio ? this.resolvedor.modulosDe(this.condominio.id) : []]);
    return { ...c, modulos };
  }

  @Get('unidades')
  @Acao('unidade.ver')
  listar(@Query(new ZodPipe(ListarUnidadesDto)) q: z.infer<typeof ListarUnidadesDto>) {
    return this.unidades.listar(q);
  }

  @Get('unidades/:ref')
  @Acao('unidade.ver')
  detalhe(@Param('ref', refParam) ref: string) {
    return this.unidades.detalhe(ref);
  }

  @Post('unidades')
  @Acao('unidade.editar')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(UnidadeDto)) body: z.infer<typeof UnidadeDto>) {
    return this.unidades.criar(ctx, body);
  }

  @Patch('unidades/:id')
  @Acao('unidade.editar')
  editar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(UnidadeDto)) body: z.infer<typeof UnidadeDto>) {
    return this.unidades.editar(ctx, id, body);
  }

  @Post('unidades/:id/desativar')
  @Acao('unidade.editar')
  @HttpCode(200)
  desativar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.unidades.desativar(ctx, id);
  }

  @Post('unidades/:id/reativar')
  @Acao('unidade.editar')
  @HttpCode(200)
  reativar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.unidades.reativar(ctx, id);
  }
}
