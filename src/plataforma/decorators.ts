// Política das rotas /plataforma (app do Master, SAAS-07). Toda rota de controller deste módulo usa EXATAMENTE um destes
// decorators: eles gravam `{ tipo: 'plataforma' }` em POLITICA (as guardas de condomínio deixam passar) e a política
// própria em POLITICA_MASTER (lida só pela PlataformaGuard). Rota com `plataforma` sem política própria: negada.
import { applyDecorators, createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AcaoPlataforma } from '../dominio/rbac-plataforma';
import type { Request } from 'express';
import { POLITICA, type Politica } from '../auth/decorators';
import { erroApi } from '../comum/erros';
import type { AuthMaster } from './tipos';

export const POLITICA_MASTER = 'portaria:politica_master';

export type PoliticaMaster =
  | { tipo: 'publico' }
  | { tipo: 'autenticado'; permiteTrocaPendente: boolean }
  | { tipo: 'acao'; acao: AcaoPlataforma };

const marcar = (p: PoliticaMaster) =>
  applyDecorators(SetMetadata(POLITICA, { tipo: 'plataforma' } satisfies Politica), SetMetadata(POLITICA_MASTER, p));

/** Sem sessão: só o login. */
export const PlataformaPublica = () => marcar({ tipo: 'publico' });
/** Qualquer usuário da plataforma logado; `permiteTrocaPendente` só em me, logout e trocar-senha. */
export const PlataformaAutenticada = (o: { permiteTrocaPendente?: boolean } = {}) =>
  marcar({ tipo: 'autenticado', permiteTrocaPendente: !!o.permiteTrocaPendente });
/** Ação da MATRIZ_PLATAFORMA (../dominio/rbac-plataforma). */
export const PlataformaAcao = (acao: AcaoPlataforma) => marcar({ tipo: 'acao', acao });

/**
 * Marca as rotas que exigem `X-Motivo-Token` (o motivo vigente da leitura, motivo-leitura.ts). Só documenta o cabeçalho no
 * OpenAPI: quem EXIGE é o AcessoPlataformaService.ler, por onde toda leitura passa (teste de arquitetura).
 */
export const MOTIVO_LEITURA = 'portaria:motivo_leitura';
export const ExigeMotivoLeitura = () => SetMetadata(MOTIVO_LEITURA, true);

/** Sessão do Master validada pela PlataformaGuard; só em rota não pública. */
export const Master = createParamDecorator((_: unknown, c: ExecutionContext): AuthMaster => {
  const req = c.switchToHttp().getRequest<Request>();
  if (!req.master) throw erroApi(401, 'NAO_AUTENTICADO', 'Entre na plataforma para continuar.');
  return req.master;
});
