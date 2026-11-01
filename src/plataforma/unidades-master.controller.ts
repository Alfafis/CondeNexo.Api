// Escrita do Master em UNIDADES (Fase C1, spec 2026-11-01-fase-c-escrita-master-design): criar, editar, desativar e
// reativar, exatamente o que o síndico faz em unidades.controller.ts, pelo MESMO UnidadesService e com o MESMO schema
// do corpo (importado, não copiado). Toda rota passa pelo ponto único (AcessoPlataformaService.escrever: limite por minuto,
// situação do condomínio, usuário técnico como ator, linha `condominio.escrever` na trilha da plataforma, resposta
// minimizada). Sem senha nem motivo (decisão fechada do dono do produto). As regras de sempre valem igual: bloco e número
// normalizados, unidade duplicada 409, unidade já referenciada não muda de número 422, já ativa/inativa 409.
import { Body, Controller, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { UnidadeDto } from '../unidades/unidades.controller';
import { type UnidadeApi, UnidadesService } from '../unidades/unidades.service';
import { AcessoPlataformaService } from './acesso-plataforma.service';
import { Master, PlataformaAcao } from './decorators';
import type { AuthMaster } from './tipos';

type Unidade = z.infer<typeof UnidadeDto>;

@Controller('plataforma/condominios/:id/unidades')
@PlataformaAcao('condominio.unidades')
export class UnidadesMasterController {
  constructor(@Inject(AcessoPlataformaService) private readonly acesso: AcessoPlataformaService) {}

  @Post()
  @HttpCode(201)
  criar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Body(new ZodPipe(UnidadeDto)) b: Unidade): Promise<UnidadeApi> {
    return this.acesso.escrever(m, req, id, { entidade: 'unidade', operacao: 'criar', classe: 'comum' },
      async (s, ctx) => (await s(UnidadesService)).criar(ctx, b));
  }

  @Patch(':unidadeId')
  editar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('unidadeId', uuidParam) unidadeId: string,
    @Body(new ZodPipe(UnidadeDto)) b: Unidade): Promise<UnidadeApi> {
    return this.acesso.escrever(m, req, id, { entidade: 'unidade', operacao: 'editar', registroId: unidadeId, classe: 'comum' },
      async (s, ctx) => (await s(UnidadesService)).editar(ctx, unidadeId, b));
  }

  @Post(':unidadeId/desativar')
  @HttpCode(200)
  desativar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('unidadeId', uuidParam) unidadeId: string): Promise<UnidadeApi> {
    return this.acesso.escrever(m, req, id, { entidade: 'unidade', operacao: 'desativar', registroId: unidadeId, classe: 'comum' },
      async (s, ctx) => (await s(UnidadesService)).desativar(ctx, unidadeId));
  }

  @Post(':unidadeId/reativar')
  @HttpCode(200)
  reativar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('unidadeId', uuidParam) unidadeId: string): Promise<UnidadeApi> {
    return this.acesso.escrever(m, req, id, { entidade: 'unidade', operacao: 'reativar', registroId: unidadeId, classe: 'comum' },
      async (s, ctx) => (await s(UnidadesService)).reativar(ctx, unidadeId));
  }
}
