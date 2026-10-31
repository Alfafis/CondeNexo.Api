import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { Modulo } from '../tenancy/modulo.guard';
import { NovoFuncionarioDto, EdicaoFuncionarioDto } from './funcionarios.schemas';
import { FuncionariosService } from './funcionarios.service';

@Modulo('funcionarios')
@Controller('funcionarios')
export class FuncionariosController {
  constructor(@Inject(FuncionariosService) private readonly funcionarios: FuncionariosService) {}

  @Get()
  @Acao('funcionario.ver')
  listar(@Query(new ZodPipe(PaginacaoDto)) q: z.infer<typeof PaginacaoDto>) { return this.funcionarios.listar(q); }

  @Get(':pessoaId')
  @Acao('funcionario.ver')
  obter(@Param('pessoaId', uuidParam) id: string) { return this.funcionarios.obter(id); }

  /** Só função, escala e se está em escala agora: o que a tela de entrada precisa para o meio "Escala". */
  @Get(':pessoaId/escala')
  @Acao('evento.registrar')
  async escala(@Param('pessoaId', uuidParam) id: string) {
    const f = await this.funcionarios.obter(id);
    return { pessoaId: f.pessoaId, funcao: f.funcao, escala: f.escala, ativo: f.ativo, emEscalaAgora: f.emEscalaAgora };
  }

  @Post()
  @Acao('funcionario.gerenciar')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovoFuncionarioDto)) b: z.infer<typeof NovoFuncionarioDto>) { return this.funcionarios.criar(ctx, b); }

  @Patch(':pessoaId')
  @Acao('funcionario.gerenciar')
  editar(@Ctx() ctx: Contexto, @Param('pessoaId', uuidParam) id: string, @Body(new ZodPipe(EdicaoFuncionarioDto)) b: z.infer<typeof EdicaoFuncionarioDto>) {
    return this.funcionarios.editar(ctx, id, b);
  }
}
