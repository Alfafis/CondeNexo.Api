// Configuração HTTP compartilhada por main.ts e pelos testes (o que é testado é o que roda).
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config/config';
import { logDeRequisicao } from './comum/log';
import { middlewareOrigem, recusarFormularioUrlencoded } from './comum/origem';
import { aplicarEstrategiaCondominio, middlewareCondominio } from './tenancy/contexto';
import { ResolvedorCondominio } from './tenancy/resolvedor';

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
  // o usa para escolher a subárvore de injeção (o banco e as chaves dele). Ver tenancy/contexto.ts.
  aplicarEstrategiaCondominio();
  // Rotas do Master (/plataforma/*, src/plataforma): SEM condomínio, sempre. Nem cabeçalho X-Condominio nem cookie de
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
  // CORS só para as origens exatas listadas. Produção: o front (https://www.condenexo.com.br) chama a API em
  // https://api.condenexo.com.br, mesmo site (o SameSite=Strict do cookie continua valendo) mas outra origem: CORS com
  // credenciais para a origem exata do front. Lista vazia = CORS desligado. Nunca refletir Origin: com credentials,
  // qualquer site leria as respostas autenticadas.
  // Superfície mínima, conferida no CondeNexo.Front: métodos e cabeçalhos que ele de fato envia; expostos só os que ele
  // lê fora da lista segura do CORS (Retry-After do 429; Content-Disposition, nome do anexo baixado). maxAge: o
  // navegador guarda o preflight por 10 min (Chrome limita a 2 h; Firefox a 24 h) em vez de refazê-lo a cada chamada.
  if (config.corsOrigens.length) {
    app.enableCors({
      origin: config.corsOrigens,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH'],
      // X-Motivo-Token: o motivo vigente da leitura do Master (plataforma/motivo-leitura.ts).
      allowedHeaders: ['Content-Type', 'X-Condominio', 'X-Motivo-Token'],
      exposedHeaders: ['Retry-After', 'Content-Disposition'],
      maxAge: 600,
    });
  }
  // Depois do CORS (o preflight já foi respondido; OPTIONS também é isento por método) e antes de tudo que o Nest
  // registra no init (parsers padrão, guards, rotas): POST/PATCH/... com Origin de fora morre aqui, sem tocar no limite
  // de login nem na trilha. Ver comum/origem.ts.
  app.use(middlewareOrigem(config));
  app.use(recusarFormularioUrlencoded);
  app.enableShutdownHooks();
}
