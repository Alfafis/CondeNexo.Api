import { Module } from '@nestjs/common';
import { ImportacaoController } from './importacao.controller';
import { ImportacaoService } from './importacao.service';

@Module({ controllers: [ImportacaoController], providers: [ImportacaoService] })
export class ImportacaoModule {}
