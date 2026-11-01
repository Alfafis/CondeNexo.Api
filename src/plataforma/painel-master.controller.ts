// Painel do app do Master (Fase A, spec 2026-10-31). Duas rotas separadas para a autorização ficar toda na guarda
// `PlataformaAcao`: /painel para quem lista condomínios (master e suporte); /painel/revelacoes para quem lê (só master).
// /painel/leituras saiu na Fase B (2026-11-01): a leitura não grava mais trilha, o bloco virou "Revelações".
// Fora do LeituraMasterController de propósito: aquele passa todo handler pelo ponto único, e aqui só há agregados.
import { Controller, Get, Inject } from '@nestjs/common';
import { PlataformaAcao } from './decorators';
import { PainelMasterService, type PainelPlataforma, type RevelacoesMaster } from './painel-master.service';

@Controller('plataforma/painel')
export class PainelMasterController {
  constructor(@Inject(PainelMasterService) private readonly painel: PainelMasterService) {}

  @Get()
  @PlataformaAcao('condominio.listar')
  obter(): Promise<PainelPlataforma> {
    return this.painel.painel(); // no-store: global (configurar-app)
  }

  @Get('revelacoes')
  @PlataformaAcao('condominio.ler')
  revelacoes(): Promise<RevelacoesMaster> {
    return this.painel.revelacoes();
  }
}
