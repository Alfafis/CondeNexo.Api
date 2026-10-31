import { Module } from '@nestjs/common';
import { UnidadesModule } from '../unidades/unidades.module';
import { VeiculosController } from './veiculos.controller';
import { VeiculosService } from './veiculos.service';

@Module({ imports: [UnidadesModule], controllers: [VeiculosController], providers: [VeiculosService] })
export class VeiculosModule {}
