import { Module } from '@nestjs/common';
import { TravaJobs } from '../jobs/trava';
import { CONDOMINIO, type CondominioResolvido } from '../tenancy/condominio';
import { AncoraSemDestino, ENVIO_ANCORA, type EnvioAncora, EnvioAncoraReal } from './ancora';
import { LimiteTaxaPublico } from './publico';
import { SeloController } from './selo.controller';
import { SeloService } from './selo.service';

@Module({
  controllers: [SeloController],
  providers: [
    SeloService, TravaJobs, EnvioAncoraReal,
    // Âncora por condomínio (F2): o piloto usa os destinos configurados; os demais ficam sem destino (selo pendente)
    // até a âncora agregada da F4. Sem isso, o selo de outro condomínio iria para o e-mail e o arquivo do piloto.
    {
      provide: ENVIO_ANCORA, inject: [CONDOMINIO, EnvioAncoraReal],
      useFactory: (c: CondominioResolvido | null, real: EnvioAncoraReal): EnvioAncora => (c?.piloto ? real : new AncoraSemDestino()),
    },
    // Factory: um limite por instância da aplicação (useValue seria um objeto só, dividido entre apps de teste).
    { provide: LimiteTaxaPublico, useFactory: () => new LimiteTaxaPublico() },
  ],
  exports: [SeloService, TravaJobs],
})
export class SeloModule {}
