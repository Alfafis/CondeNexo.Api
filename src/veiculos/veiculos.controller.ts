import { Body, Controller, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { Modulo } from '../tenancy/modulo.guard';
import { NovoVeiculoDto, EdicaoVeiculoDto } from './veiculos.schemas';
import { VeiculosService } from './veiculos.service';

@Modulo('veiculos')
@Controller('veiculos')
export class VeiculosController {
  constructor(@Inject(VeiculosService) private readonly veiculos: VeiculosService) {}

  @Post()
  @Acao('veiculo.cadastrar')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovoVeiculoDto)) b: z.infer<typeof NovoVeiculoDto>) { return this.veiculos.criar(ctx, b); }

  @Patch(':id')
  @Acao('veiculo.cadastrar')
  editar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(EdicaoVeiculoDto)) b: z.infer<typeof EdicaoVeiculoDto>) {
    return this.veiculos.editar(ctx, id, b);
  }
}
