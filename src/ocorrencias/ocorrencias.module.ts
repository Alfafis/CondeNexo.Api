import { Module } from '@nestjs/common';
import { CofreDocumentos } from '../documentos/cofre';
import { OcorrenciasController } from './ocorrencias.controller';
import { OcorrenciasService } from './ocorrencias.service';

@Module({ controllers: [OcorrenciasController], providers: [OcorrenciasService, CofreDocumentos] })
export class OcorrenciasModule {}
