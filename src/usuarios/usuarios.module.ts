import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';

@Module({ imports: [AuthModule], controllers: [UsuariosController], providers: [UsuariosService] })
export class UsuariosModule {}
