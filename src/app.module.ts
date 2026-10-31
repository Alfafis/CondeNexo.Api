import { Module, Scope } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditoriaModule } from './auditoria/auditoria.service';
import { AuthModule } from './auth/auth.module';
import { PapelGuard, SessaoGuard } from './auth/guards';
import { EnvelopeInterceptor } from './comum/envelope.interceptor';
import { FiltroExcecao } from './comum/filtro-excecao';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { SaudeController, SaudeService } from './saude/saude.controller';
import { PessoasModule } from './pessoas/pessoas.module';
import { UnidadesModule } from './unidades/unidades.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { VinculosModule } from './vinculos/vinculos.controller';
import { FuncionariosModule } from './funcionarios/funcionarios.module';
import { ImportacaoModule } from './importacao/importacao.module';
import { VeiculosModule } from './veiculos/veiculos.module';
import { AcessoModule } from './eventos/acesso.module';
import { AuditoriaRotasModule } from './auditoria/auditoria.controller';
import { RelatoriosModule } from './relatorios/relatorios.module';
import { EncomendasModule } from './encomendas/encomendas.module';
import { OcorrenciasModule } from './ocorrencias/ocorrencias.module';
import { SeloModule } from './selo/selo.module';
import { LgpdModule } from './lgpd/lgpd.module';
import { JobsModule } from './jobs/agendador';
import { MasterModule } from './master/master.module';
import { ModuloGuard } from './saas/modulo.guard';
import { ParametrosModule } from './parametros/parametros.controller';

@Module({
  imports: [ConfigModule, DatabaseModule, AuditoriaModule, AuthModule, UsuariosModule, UnidadesModule, PessoasModule, VinculosModule,
    FuncionariosModule, VeiculosModule, ImportacaoModule, AcessoModule, AuditoriaRotasModule, RelatoriosModule, EncomendasModule, OcorrenciasModule,
    SeloModule, LgpdModule, JobsModule, MasterModule, ParametrosModule],
  controllers: [SaudeController],
  providers: [
    SaudeService,
    // Ordem importa: autenticação antes de autorização. Os dois respeitam @Publico() (o /saude continua aberto).
    // SessaoGuard depende do banco do condomínio (SessaoService -> DB): é durável, uma instância por condomínio. O escopo
    // tem de estar DECLARADO aqui: o Nest decide se um enhancer global é por requisição pelo `scope` do provider, não
    // pela árvore de dependências, e sem isso a guarda viraria um objeto nunca construído (SaaS, F2).
    // PapelGuard não depende de banco, mas também é declarado durável: o Nest roda os enhancers globais estáticos ANTES
    // dos por requisição, e a autorização não pode rodar antes da autenticação.
    { provide: APP_GUARD, useClass: SessaoGuard, scope: Scope.REQUEST, durable: true },
    { provide: APP_GUARD, useClass: PapelGuard, scope: Scope.REQUEST, durable: true },
    // Módulos por condomínio (SAAS-19): depois da autenticação e da autorização, também durável para manter a ordem.
    { provide: APP_GUARD, useClass: ModuloGuard, scope: Scope.REQUEST, durable: true },
    { provide: APP_FILTER, useClass: FiltroExcecao },
    // Todo 2xx com corpo sai como { data } (ou { data, pagination }); 204 sem corpo.
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
  ],
})
export class AppModule {}
