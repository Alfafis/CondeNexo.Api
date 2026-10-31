import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { CONFIG, type Config } from './config/config';
import { configurarApp } from './plataforma';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configurarApp(app, app.get<Config>(CONFIG));
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

bootstrap().catch((erro) => {
  // Só a mensagem: erro de config é nosso texto; erro de conexão do pg não traz a senha na mensagem.
  console.error(erro instanceof Error ? `${erro.name}: ${erro.message}` : erro);
  process.exit(1);
});
