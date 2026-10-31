import { Module } from '@nestjs/common';
import { UnidadesController } from './unidades.controller';
import { UnidadesService } from './unidades.service';

/** Exporta o serviço: os próximos módulos usam `paraNovoUso` (unidade inativa barra novos usos). */
@Module({ controllers: [UnidadesController], providers: [UnidadesService], exports: [UnidadesService] })
export class UnidadesModule {}
