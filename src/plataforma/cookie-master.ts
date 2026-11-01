// Cookie de sessão do Master (SAAS-08), DISTINTO do cookie de condomínio em nome e caminho:
//  - nome `__Secure-portaria_plataforma` (com Secure) ou `portaria_plataforma` (http://localhost, dev e e2e);
//  - Path=/api/v1/plataforma: o navegador nem envia este cookie às rotas de condomínio. O prefixo `__Host-` (que o doc
//    previa) exige Path=/, então foi trocado por `__Secure-` + Path restrito (decisão registrada no doc, §5.3). Sem
//    Domain: o cookie é host-only do host da API (api.condenexo.com.br em produção), que o front chama com credenciais;
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
  return lerCookie(req, nomeCookieMaster(config.cookie.secure));
}

function lerCookie(req: Request, nome: string): string | null {
  const cabecalho = req.headers.cookie;
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0 || parte.slice(0, i).trim() !== nome) continue;
    const valor = parte.slice(i + 1).trim();
    return TOKEN.test(valor) ? valor : null;
  }
  return null;
}

// Cookie do DESAFIO do login em duas etapas (spec C2, D1): outro nome, caminho só do login (o navegador não o manda a
// nenhuma outra rota), 5 min. Nunca autentica rota: a PlataformaGuard só lê o cookie de sessão, e o token do desafio vive
// em `master_login_pendente`, não em `master_sessao`.
export const CAMINHO_COOKIE_DESAFIO = '/api/v1/plataforma/auth/login';
export const nomeCookieDesafio = (secure: boolean) => (secure ? '__Secure-portaria_plataforma_2fa' : 'portaria_plataforma_2fa');

const opcoesDesafio = (config: Config): CookieOptions => ({
  httpOnly: true, secure: config.cookie.secure, sameSite: 'strict', path: CAMINHO_COOKIE_DESAFIO,
});

export function gravarCookieDesafio(res: Response, config: Config, token: string, ttlMs: number) {
  res.cookie(nomeCookieDesafio(config.cookie.secure), token, { ...opcoesDesafio(config), maxAge: ttlMs });
}

export function limparCookieDesafio(res: Response, config: Config) {
  res.clearCookie(nomeCookieDesafio(config.cookie.secure), opcoesDesafio(config));
}

export function lerCookieDesafio(req: Request, config: Config): string | null {
  return lerCookie(req, nomeCookieDesafio(config.cookie.secure));
}
