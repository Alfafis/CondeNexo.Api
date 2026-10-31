// App do Nest só para ler metadados (gerador de OpenAPI): AppModule real, mas sem banco, sem .env e sem abrir porta.
// Plataforma, registro de bancos e chave mestra são stubs vazios: nada é consultado na construção (os providers de
// banco de condomínio são duráveis e só nascem numa requisição), e o app nunca recebe requisição nem init.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { CONFIG } from '../../src/config/config';
import { RELOGIO, relogioDoSistema } from '../../src/comum/relogio';
import { configDeTeste } from '../helpers/app';
import { comSaas } from '../helpers/saas';

export async function appSemBanco(): Promise<INestApplication> {
  const mod = await comSaas(Test.createTestingModule({ imports: [AppModule] }), {
    plataforma: {} as never,
    registro: { db: () => { throw new Error('sem banco'); }, pool: () => null, fechar: async () => undefined },
  })
    .overrideProvider(CONFIG).useValue(configDeTeste())
    .overrideProvider(RELOGIO).useValue(relogioDoSistema)
    .compile();
  return mod.createNestApplication({ logger: false });
}
