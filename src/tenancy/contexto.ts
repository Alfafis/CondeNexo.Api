// Contexto do condomínio na requisição (docs/05_arquitetura_saas.md SAAS-03, fase F2): durable providers do NestJS.
//
// 1. Middleware (`middlewareCondominio`, async): descobre o condomínio da requisição e grava `req.condominio`.
//      - login (`POST /auth/login`): cabeçalho `X-Condominio: <código>`; sem ele, o piloto (transição, SAAS-05).
//        O cookie é ignorado no login: um cookie velho de outro condomínio não pode escolher onde a pessoa entra.
//      - demais rotas: `X-Condominio` se vier; senão o prefixo do cookie (`v2.<condominio_id>.<token>`); senão
//        (cookie antigo, sem prefixo, ou sem cookie) o piloto, durante a transição.
//      Código ou id desconhecido, condomínio fora de ativo/suspenso, ou transição desligada: `null` (sem condomínio).
//      O prefixo do cookie só ESCOLHE o banco; quem autentica é a sessão, validada nesse banco (guards.ts).
// 2. Estratégia (`estrategiaCondominio`, ContextIdStrategy): cada condomínio tem UMA subárvore de injeção durável,
//    criada na primeira requisição (ou job) dele e reaproveitada depois. Os providers `CONDOMINIO`, `DB` e `PG_POOL`
//    (database.module.ts) são duráveis; os serviços que dependem deles também viram duráveis, uma instância por
//    condomínio, e seguem usando `this.db` sem saber de condomínio. Sem condomínio: a subárvore "sem condomínio",
//    cujo `DB` lança no primeiro uso (falha fechada).
// 3. Jobs (singleton, sem requisição): `contextoDoJob` devolve a MESMA subárvore que as requisições do condomínio usam.
import type { ContextId, ContextIdStrategy, HostComponentInfo } from '@nestjs/core';
import { ContextIdFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { interpretarCookie, lerCookieSessao } from '../auth/cookie';
import { log } from '../comum/log';
import type { Config } from '../config/config';
import type { CondominioResolvido, StatusAtendido } from './condominio';
import type { ResolvedorCondominio, Resolucao } from './resolvedor';

declare module 'express-serve-static-core' {
  interface Request {
    /** Condomínio desta requisição (middlewareCondominio). `null`: nenhum; `undefined`: o middleware não rodou. */
    condominio?: CondominioResolvido | null;
    condominioStatus?: StatusAtendido | null;
  }
}

/** Valor de `REQUEST` na subárvore durável (o Nest entrega o payload, não a requisição). */
export interface PayloadCondominio {
  condominio: CondominioResolvido | null;
}

/** Cabeçalho do código do condomínio (login e rotas públicas de condomínio). */
export const CABECALHO_CONDOMINIO = 'x-condominio';

// ----- Estratégia de contexto -----------------------------------------------------------------------------------

export class EstrategiaCondominio implements ContextIdStrategy {
  private readonly arvores = new Map<string, ContextId>();
  private readonly semCondominio: ContextId = ContextIdFactory.create();

  /** A subárvore durável do condomínio (a mesma para requisições e jobs); `null` = subárvore "sem condomínio". */
  arvore(c: CondominioResolvido | null): ContextId {
    if (!c) return this.semCondominio;
    let id = this.arvores.get(c.id);
    if (!id) {
      id = ContextIdFactory.create();
      this.arvores.set(c.id, id);
    }
    return id;
  }

  attach(contextId: ContextId, req: Request) {
    // Só o que o middleware gravou. Nada da requisição bruta (cabeçalho, cookie) decide a subárvore aqui.
    const condominio = req.condominio ?? null;
    const arvore = this.arvore(condominio);
    return {
      resolve: (info: HostComponentInfo) => (info.isTreeDurable ? arvore : contextId),
      payload: { condominio } satisfies PayloadCondominio,
    };
  }
}

/** Uma por processo: o `ContextIdFactory` do Nest guarda a estratégia num campo estático. */
export const estrategiaCondominio = new EstrategiaCondominio();

export function aplicarEstrategiaCondominio() {
  ContextIdFactory.apply(estrategiaCondominio);
}

/** O que um job precisa do Nest (ModuleRef ou o próprio app): registrar o payload e resolver na subárvore. */
export interface ResolvedorDeInstancias {
  registerRequestByContextId<T = unknown>(request: T, contextId: ContextId): void;
  resolve<T>(token: unknown, contextId?: ContextId, options?: { strict?: boolean }): Promise<T>;
}

/** Subárvore do condomínio para um job: registra o payload e devolve o contextId para `moduleRef.resolve`. */
export function contextoDoJob(moduleRef: ResolvedorDeInstancias, c: CondominioResolvido): ContextId {
  const id = estrategiaCondominio.arvore(c);
  moduleRef.registerRequestByContextId({ condominio: c } satisfies PayloadCondominio, id);
  return id;
}

// ----- Middleware ----------------------------------------------------------------------------------------------

export async function resolverRequisicao(req: Request, resolvedor: ResolvedorCondominio, config: Config, rotaLogin: string): Promise<Resolucao | null> {
  const codigo = req.get(CABECALHO_CONDOMINIO);
  if (codigo !== undefined) return resolvedor.porCodigoDoLogin(codigo);
  // O Express casa rota sem diferenciar maiúsculas e com barra final opcional: a comparação aqui tem de ser igual.
  const caminho = req.path.toLowerCase().replace(/\/+$/, '');
  if (req.method !== 'POST' || caminho !== rotaLogin.toLowerCase()) {
    const cookie = interpretarCookie(lerCookieSessao(req, config));
    if (cookie?.formato === 'v2') return resolvedor.porIdDoCookie(cookie.condominioId);
  }
  return config.saas.pilotoPadrao ? resolvedor.piloto() : null;
}

export function middlewareCondominio(resolvedor: ResolvedorCondominio, config: Config, rotaLogin: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    resolverRequisicao(req, resolvedor, config, rotaLogin).then(
      (r) => {
        req.condominio = r?.condominio ?? null;
        req.condominioStatus = r?.status ?? null;
        next();
      },
      () => {
        // Falha ao resolver (plataforma fora e condomínio ainda não em cache): sem condomínio, falha fechada.
        log('error', 'saas.resolucao_falhou', { request_id: req.requestId });
        req.condominio = null;
        req.condominioStatus = null;
        next();
      },
    );
  };
}
