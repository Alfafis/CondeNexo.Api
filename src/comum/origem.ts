// Verificação de Origin nos métodos que mudam estado (docs/deploy-subdominio-api.md, "Verificação de Origin").
//
// Por quê: o cookie de sessão é SameSite=Strict, que só barra requisição vinda de OUTRO site. Front (www.) e API (api.)
// são o mesmo site, então qualquer subdomínio de condenexo.com.br (XSS ou takeover em blog., status., ...) consegue
// disparar um <form method=POST> urlencoded/multipart contra a API: não há preflight de CORS e o cookie vai junto. O
// CORS impede a LEITURA da resposta, não o EFEITO. Este middleware recusa o efeito.
//
// Roda como middleware Express, antes do roteamento do Nest: a recusa acontece antes de guard, pipe, controller, do
// limite de login e da trilha (o 403 é escrito aqui, não passa pelo FiltroExcecao, que gravaria `acesso.negado`).
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config/config';
import { respostaErro } from './erros';
import { log } from './log';

/**
 * Métodos sem efeito de escrita: isentos no middleware (OPTIONS é o preflight e nunca é verificado). GET/HEAD
 * autenticados são verificados depois, pela GuardaOrigemLeitura (src/comum/origem.guard.ts), porque leitura auditada
 * grava trilha.
 */
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METODOS_LEITURA = new Set(['GET', 'HEAD']);

export const CODIGO_ORIGEM_NAO_PERMITIDA = 'ORIGEM_NAO_PERMITIDA';
export const MENSAGEM_ORIGEM_NAO_PERMITIDA = 'Origem da requisição não permitida.';

/** host:porta da Origin (minúsculo, porta padrão omitida, como o URL normaliza); null se não for uma origem http(s). */
function hostDaOrigem(origem: string): string | null {
  try {
    const u = new URL(origem);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host;
  } catch {
    return null;
  }
}

/**
 * Por que recusar, ou null para deixar passar. Regras:
 * - Origin presente e CORS_ORIGENS definido: só a origem EXATA de uma da lista (sem normalizar: apex, http, sufixo e
 *   `null` caem fora).
 * - Origin presente e CORS_ORIGENS vazio (dev/e2e: o front fala com a API na mesma origem pelo proxy do Vite, que não
 *   reescreve o Host com alvo local): o host:porta da Origin tem de ser igual ao cabeçalho Host. Só o Host bruto, nunca
 *   X-Forwarded-Host (com trust proxy ligado nos testes ele seria forjável e não é necessário em nenhum cenário atual).
 * - Origin ausente: cliente não-navegador (curl, integração), passa. Exceto se o navegador disse, por Sec-Fetch-Site,
 *   que a requisição veio de outra origem do mesmo site ou de outro site.
 * `incluirLeitura`: aplica as mesmas regras a GET/HEAD (rota autenticada; ver origem.guard.ts). Num GET o navegador só
 * manda Origin em fetch/XHR CORS (o front em www. sempre manda, e está na lista); <img>, <script> e link de outro
 * subdomínio chegam sem Origin e com Sec-Fetch-Site: same-site. URL digitada (none) e curl (sem cabeçalho) passam.
 */
export function motivoDeRecusa(req: Pick<Request, 'method' | 'headers'>, corsOrigens: readonly string[], incluirLeitura = false): string | null {
  if (req.method === 'OPTIONS') return null;
  if (!incluirLeitura && METODOS_LEITURA.has(req.method)) return null;
  const origem = req.headers.origin;
  if (origem === undefined) {
    const site = req.headers['sec-fetch-site'];
    return site === 'same-site' || site === 'cross-site' ? 'sec_fetch_site' : null;
  }
  if (corsOrigens.length) return corsOrigens.includes(origem) ? null : 'origem_fora_da_lista';
  const host = req.headers.host?.toLowerCase();
  const hostOrigem = hostDaOrigem(origem);
  return host && hostOrigem && hostOrigem === host ? null : 'origem_de_outro_host';
}

/** Origin recusada vai ao log (o log mascara dígitos e corta o tamanho); a lista permitida nunca vai à resposta. */
export function logarRecusa(req: Request, motivo: string) {
  log('warn', 'origem.recusada', { request_id: req.requestId, metodo: req.method, rota: req.path, motivo, detalhe: req.headers.origin });
}

export function middlewareOrigem(config: Pick<Config, 'corsOrigens'>) {
  const lista = [...config.corsOrigens];
  return (req: Request, res: Response, next: NextFunction) => {
    const motivo = motivoDeRecusa(req, lista);
    if (!motivo) return next();
    logarRecusa(req, motivo);
    res.status(403).json(respostaErro(403, { codigo: CODIGO_ORIGEM_NAO_PERMITIDA, mensagem: MENSAGEM_ORIGEM_NAO_PERMITIDA }, req.originalUrl ?? req.url));
  };
}

/**
 * Defesa em profundidade: a API só fala JSON e multipart (anexos). Corpo `application/x-www-form-urlencoded` é o formato
 * do <form> HTML sem preflight: recusado com 415 nos métodos que mudam estado, antes do parser e do roteamento. Fica
 * aqui (e não em `bodyParser: false` no NestFactory) para valer igual em main.ts e nos testes, que montam o app por
 * configurarApp.
 */
export function recusarFormularioUrlencoded(req: Request, res: Response, next: NextFunction) {
  if (METODOS_SEGUROS.has(req.method) || !req.is('application/x-www-form-urlencoded')) return next();
  res.status(415).json(respostaErro(415, { codigo: 'TIPO_NAO_SUPORTADO', mensagem: 'Envie o corpo em JSON (ou multipart/form-data nos anexos).' }, req.originalUrl ?? req.url));
}
