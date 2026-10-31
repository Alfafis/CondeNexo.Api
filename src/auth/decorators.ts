// Política de acesso por rota. Toda rota precisa de EXATAMENTE uma: @Publico(), @Autenticado() ou @Acao('...').
// Rota sem política é negada (falha fechada) e o erro de programação vai para o log.
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Acao as AcaoRbac } from '../dominio/rbac';
import type { Request } from 'express';
import { erroApi } from '../comum/erros';
import type { Contexto } from './tipos';

export const POLITICA = 'portaria:politica';

export type Politica =
  | { tipo: 'publico' }
  /**
   * Rota da PLATAFORMA (/plataforma/*, app do Master; src/plataforma/). As guardas de condomínio não a atendem: quem
   * autentica e autoriza é a PlataformaGuard, com cookie, sessão e tabela próprios (SAAS-07). Só os decorators de
   * src/plataforma/decorators.ts gravam este tipo.
   */
  | { tipo: 'plataforma' }
  | { tipo: 'autenticado'; permiteTrocaPendente: boolean }
  | { tipo: 'acao'; acao: AcaoRbac };

/** Sem sessão: /saude e /auth/login. */
export const Publico = () => SetMetadata(POLITICA, { tipo: 'publico' } satisfies Politica);

/**
 * Qualquer usuário logado. `permiteTrocaPendente`: a rota também atende quem ainda deve trocar a senha
 * (só me, logout e trocar-senha).
 */
export const Autenticado = (o: { permiteTrocaPendente?: boolean } = {}) =>
  SetMetadata(POLITICA, { tipo: 'autenticado', permiteTrocaPendente: !!o.permiteTrocaPendente } satisfies Politica);

/** Ação da matriz RBAC (../dominio/rbac, fonte única): o PapelGuard decide com `pode(papel, acao)`. */
export const Acao = (acao: AcaoRbac) => SetMetadata(POLITICA, { tipo: 'acao', acao } satisfies Politica);

/** IP como o Express o calcula (respeita TRUST_PROXY). */
export const ipDe = (req: Request): string | null => req.ip ?? req.socket.remoteAddress ?? null;

/** Contexto do usuário logado; só em rota não pública. */
export const Ctx = createParamDecorator((_: unknown, c: ExecutionContext): Contexto => {
  const req = c.switchToHttp().getRequest<Request>();
  if (!req.auth) throw erroApi(401, 'NAO_AUTENTICADO', 'Entre no sistema para continuar.');
  return { ator: req.auth.usuario, sessaoId: req.auth.sessaoId, ip: ipDe(req) };
});
