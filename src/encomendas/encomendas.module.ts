import { Module } from '@nestjs/common';
import { UnidadesModule } from '../unidades/unidades.module';
import { EncomendasController } from './encomendas.controller';
import { EncomendasService } from './encomendas.service';

@Module({ imports: [UnidadesModule], controllers: [EncomendasController], providers: [EncomendasService] })
export class EncomendasModule {}
