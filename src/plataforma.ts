// Configuração HTTP compartilhada por main.ts e pelos testes (o que é testado é o que roda).
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config/config';
import { logDeRequisicao } from './comum/log';
import { aplicarEstrategiaCondominio, middlewareCondominio } from './saas/contexto';
import { ResolvedorCondominio } from './saas/resolvedor';

/** Prefixo global da API (usado também pelo gerador de OpenAPI, para montar as URLs dos servidores). */
export const PREFIXO_GLOBAL = 'api/v1';

const PREFIXO_PLATAFORMA = `/${PREFIXO_GLOBAL}/plataforma`;
/** `/api/v1/plataforma` e abaixo, sem diferenciar maiúsculas (como o roteamento do Express). */
export const ehRotaPlataforma = (caminho: string) => {
  const c = caminho.toLowerCase();
  return c === PREFIXO_PLATAFORMA || c.startsWith(`${PREFIXO_PLATAFORMA}/`);
};

export function configurarApp(app: NestExpressApplication, config: Config) {
  app.setGlobalPrefix(PREFIXO_GLOBAL);
  // trust proxy: só com proxy de verdade na frente (TRUST_PROXY=n saltos). Sem proxy, X-Forwarded-For seria
  // entrada do cliente e o limite de login por IP viraria opcional para quem forja o cabeçalho.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  // JSON até 1 MB: a planilha de importação (RF-11) chega a ~3000 linhas. O resto da API manda corpos de poucos KB.
  app.useBodyParser('json', { limit: '1mb' });
  app.use(logDeRequisicao);
  // SaaS (F2, SAAS-03): o condomínio da requisição é resolvido ANTES do roteamento do Nest, e a estratégia de contexto
  // o usa para escolher a subárvore de injeção (o banco e as chaves dele). Ver saas/contexto.ts.
  aplicarEstrategiaCondominio();
  // Rotas do Master (/plataforma/*, src/master): SEM condomínio, sempre. Nem cabeçalho X-Condominio nem cookie de
  // condomínio escolhem banco ali: a requisição cai na subárvore "sem condomínio" (DB de condomínio falha fechado) e um
  // 403 da plataforma nunca vai parar na trilha de um condomínio (FiltroExcecao). O Express casa rota sem diferenciar
  // maiúsculas: a comparação também não diferencia.
  const condominio = middlewareCondominio(app.get(ResolvedorCondominio), config, `/${PREFIXO_GLOBAL}/auth/login`);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (ehRotaPlataforma(req.path)) {
      req.condominio = null;
      req.condominioStatus = null;
      return next();
    }
    return condominio(req, res, next);
  });
  app.use((_req: Request, res: Response, next: NextFunction) => {
    // Respostas da API carregam dado pessoal e, na redefinição, a senha temporária: nada em cache.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // CORS só para as origens exatas listadas (dev com front em outra porta). Produção: mesma origem via rewrite,
  // lista vazia, CORS desligado. Nunca refletir Origin: com credentials, isso anularia o SameSite.
  if (config.corsOrigens.length) {
    app.enableCors({ origin: config.corsOrigens, credentials: true, methods: ['GET', 'POST', 'PATCH'], allowedHeaders: ['Content-Type', 'X-Condominio'] });
  }
  app.enableShutdownHooks();
}
