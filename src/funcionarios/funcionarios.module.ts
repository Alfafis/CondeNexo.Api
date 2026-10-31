import { Module } from '@nestjs/common';
import { PessoasModule } from '../pessoas/pessoas.module';
import { FuncionariosController } from './funcionarios.controller';
import { FuncionariosService } from './funcionarios.service';

@Module({ imports: [PessoasModule], controllers: [FuncionariosController], providers: [FuncionariosService] })
export class FuncionariosModule {}
