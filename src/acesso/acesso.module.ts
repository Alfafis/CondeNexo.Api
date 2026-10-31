import { Module } from '@nestjs/common';
import { UnidadesModule } from '../unidades/unidades.module';
import { AutorizacoesService } from '../eventos/autorizacoes.service';
import { EventosService } from '../eventos/eventos.service';
import { AcessoController } from './acesso.controller';

@Module({
  imports: [UnidadesModule],
  controllers: [AcessoController],
  providers: [EventosService, AutorizacoesService],
  exports: [EventosService],
})
export class AcessoModule {}
