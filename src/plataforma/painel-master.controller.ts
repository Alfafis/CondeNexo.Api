// Painel do app do Master (Fase A, spec 2026-10-31). Duas rotas separadas para a autorização ficar toda na guarda
// `PlataformaAcao`: /painel para quem lista condomínios (master e suporte); /painel/leituras para quem lê (só master).
// Fora do LeituraMasterController de propósito: aquele exige `this.ler` (motivo) em todo handler, e aqui só há agregados.
import { Controller, Get, Inject } from '@nestjs/common';
import { PlataformaAcao } from './decorators';
import { type LeiturasMaster, PainelMasterService, type PainelPlataforma } from './painel-master.service';

@Controller('plataforma/painel')
export class PainelMasterController {
  constructor(@Inject(PainelMasterService) private readonly painel: PainelMasterService) {}

  @Get()
  @PlataformaAcao('condominio.listar')
  obter(): Promise<PainelPlataforma> {
    return this.painel.painel(); // no-store: global (configurar-app)
  }

  @Get('leituras')
  @PlataformaAcao('condominio.ler')
  leituras(): Promise<LeiturasMaster> {
    return this.painel.leituras();
  }
}
