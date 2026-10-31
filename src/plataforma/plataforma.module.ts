// App do Master (docs/05_arquitetura_saas.md SAAS-07/08/09). Tudo aqui é estático (singleton): depende só do banco
// plataforma, da chave mestra e da configuração, nunca de DB/CONDOMINIO (que são por condomínio). As rotas /plataforma
// passam pelo middleware de condomínio SEM condomínio (plataforma.ts). A ÚNICA exceção é o AcessoPlataformaService
// (F5 entrega 2, leitura auditada dos dados de um condomínio; §5.5, gestão de síndicos): ele obtém a subárvore do
// condomínio, como os jobs.
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AcessoPlataformaService } from './acesso-plataforma.service';
import { LeituraMasterController } from './leitura-master.controller';
import { AuthMasterService } from './auth-master.service';
import { CondominiosMasterService } from './condominios-master.service';
import { LimiteMasterService } from './limite-master.service';
import { AuthMasterController, CondominiosMasterController, ParametrosMasterController, ProvisionadorMasterController } from './master.controller';
import { PlataformaGuard } from './plataforma.guard';
import { PROVISIONADOR, provisionadorDoAmbiente } from './provisionador';
import { SessaoMasterService } from './sessao-master.service';
import { SindicosMasterController } from './sindicos-master.controller';

@Module({
  imports: [AuthModule],
  controllers: [AuthMasterController, CondominiosMasterController, ParametrosMasterController, ProvisionadorMasterController, LeituraMasterController, SindicosMasterController],
  providers: [
    AuthMasterService, SessaoMasterService, LimiteMasterService, CondominiosMasterService, AcessoPlataformaService,
    { provide: PROVISIONADOR, useFactory: () => provisionadorDoAmbiente(process.env) },
    // Global e estática: roda antes das guardas duráveis de condomínio e só age em rota `{ tipo: 'plataforma' }`.
    { provide: APP_GUARD, useClass: PlataformaGuard },
  ],
})
export class PlataformaModule {}
