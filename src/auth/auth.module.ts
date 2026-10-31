import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EsperaLogin, LoginSemCondominio } from './login-sem-condominio';
import { LimiteLoginService } from './limite-login.service';
import { SenhaService } from './senha.service';
import { SessaoService } from './sessao.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService, SenhaService, SessaoService, LimiteLoginService, EsperaLogin,
    // Login sem condomínio resolvido (código inexistente): o mesmo limite e atraso do caminho com banco, em memória
    // (login-sem-condominio.ts). O global por IP na plataforma é a SAAS-14 (F5).
    LoginSemCondominio,
  ],
  // EsperaLogin também sai para o app do Master (src/master): um ponto só de espera do atraso crescente.
  exports: [SenhaService, SessaoService, LimiteLoginService, EsperaLogin],
})
export class AuthModule {}
