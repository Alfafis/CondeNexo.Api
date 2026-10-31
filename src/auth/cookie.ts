// Cookie de sessão: HttpOnly; Secure; SameSite=Strict; Path=/ (spec §5.1). SameSite=Strict é a proteção de CSRF
// inteira deste desenho: só vale com front e API no MESMO site (ver spec §14, deploy). Com Secure, o nome leva o
// prefixo __Host- (o navegador recusa o cookie se faltar Secure, se Path não for / ou se houver Domain).
import type { CookieOptions, Request, Response } from 'express';
import type { Config } from '../config/config';

const opcoes = (config: Config): CookieOptions => ({
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: 'strict',
  path: '/',
});

/**
 * SaaS (F2, SAAS-03): o valor é `v2.<condominio_id>.<token>`. O prefixo só escolhe o banco do condomínio; a sessão é
 * validada nesse banco pelo hash do token, então prefixo trocado = sessão inexistente = 401. O token puro de antes da
 * F2 (formato `legado`) continua aceito para o piloto durante a transição (SAAS_PILOTO_PADRAO).
 */
export function gravarCookieSessao(res: Response, config: Config, condominioId: string, token: string, expiraEm: Date) {
  res.cookie(config.cookie.nome, valorCookieV2(condominioId, token), { ...opcoes(config), expires: expiraEm });
}

export function limparCookieSessao(res: Response, config: Config) {
  res.clearCookie(config.cookie.nome, opcoes(config));
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const COOKIE_V2 = new RegExp(`^v2\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const COOKIE_LEGADO = /^[A-Za-z0-9_-]{43}$/;

export type CookieSessao =
  | { formato: 'v2'; condominioId: string; token: string }
  | { formato: 'legado'; token: string };

/** `v2.<condominio_id>.<token>` ou o token puro de antes da F2. Qualquer outra coisa: null. */
export function interpretarCookie(valor: string | null): CookieSessao | null {
  if (!valor) return null;
  const m = COOKIE_V2.exec(valor);
  if (m) return { formato: 'v2', condominioId: m[1]!, token: m[2]! };
  return COOKIE_LEGADO.test(valor) ? { formato: 'legado', token: valor } : null;
}

export const valorCookieV2 = (condominioId: string, token: string) => `v2.${condominioId}.${token}`;

/** Lê só o cookie de sessão do cabeçalho Cookie (sem parser genérico: um nome, um valor). */
export function lerCookieSessao(req: Request, config: Config): string | null {
  const cabecalho = req.headers.cookie;
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0 || parte.slice(0, i).trim() !== config.cookie.nome) continue;
    const valor = parte.slice(i + 1).trim();
    return valor || null; // o token é base64url: não precisa de decodeURIComponent
  }
  return null;
}
