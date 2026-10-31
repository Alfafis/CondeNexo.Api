// Cookie de sessão do Master (SAAS-08), DISTINTO do cookie de condomínio em nome e caminho:
//  - nome `__Secure-portaria_plataforma` (com Secure) ou `portaria_plataforma` (http://localhost, dev e e2e);
//  - Path=/api/v1/plataforma: o navegador nem envia este cookie às rotas de condomínio. O prefixo `__Host-` (que o doc
//    previa) exige Path=/, então foi trocado por `__Secure-` + Path restrito (decisão registrada no doc, §5.3). Sem
//    Domain: o cookie é só do host do front da plataforma (o rewrite da Vercel o entrega à API);
//  - HttpOnly, Secure, SameSite=Strict, como o de condomínio.
// A PlataformaGuard só lê ESTE nome, e a SessaoGuard do condomínio só lê o dela: um cookie nunca autentica no outro lado
// (e os tokens ficam em tabelas de bancos diferentes: `master_sessao` x `sessao`).
import type { CookieOptions, Request, Response } from 'express';
import type { Config } from '../config/config';

export const CAMINHO_COOKIE_MASTER = '/api/v1/plataforma';

export const nomeCookieMaster = (secure: boolean) => (secure ? '__Secure-portaria_plataforma' : 'portaria_plataforma');

const opcoes = (config: Config): CookieOptions => ({
  httpOnly: true, secure: config.cookie.secure, sameSite: 'strict', path: CAMINHO_COOKIE_MASTER,
});

export function gravarCookieMaster(res: Response, config: Config, token: string, expiraEm: Date) {
  res.cookie(nomeCookieMaster(config.cookie.secure), token, { ...opcoes(config), expires: expiraEm });
}

export function limparCookieMaster(res: Response, config: Config) {
  res.clearCookie(nomeCookieMaster(config.cookie.secure), opcoes(config));
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Só o cookie do Master, só no formato emitido (base64url de 32 bytes). Qualquer outra coisa: null. */
export function lerCookieMaster(req: Request, config: Config): string | null {
  const cabecalho = req.headers.cookie;
  if (!cabecalho) return null;
  const nome = nomeCookieMaster(config.cookie.secure);
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0 || parte.slice(0, i).trim() !== nome) continue;
    const valor = parte.slice(i + 1).trim();
    return TOKEN.test(valor) ? valor : null;
  }
  return null;
}
