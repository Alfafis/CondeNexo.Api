// Log de aplicação (spec §9.4): JSON de uma linha, com campos em ALLOWLIST. Nada de corpo de requisição, senha,
// token, cookie, login digitado, CPF ou telefone. Quem quiser logar algo novo acrescenta o campo aqui, de propósito.
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const CAMPOS_PERMITIDOS = new Set([
  // condominio_id (SaaS, SAAS-15): o uuid, nunca o código nem o nome do condomínio.
  'request_id', 'usuario_id', 'condominio_id', 'metodo', 'rota', 'status', 'ms', 'codigo', 'codigo_pg', 'constraint', 'erro', 'motivo', 'detalhe',
]);

export type Nivel = 'info' | 'warn' | 'error';

/** Sequências de 9+ dígitos (CPF, telefone), com ou sem separador, viram asteriscos. */
export function mascararDigitos(s: string): string {
  return s.replace(/\d[\d.\-/ ]*\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? m.replace(/\d/g, '*') : m));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remove quebras de linha (log injection) e mascara dígitos (UUID passa intacto: é o identificador permitido). */
const limpar = (v: unknown) => {
  if (typeof v !== 'string') return v;
  if (UUID.test(v)) return v;
  return mascararDigitos(v.replace(/[\r\n\t]+/g, ' ')).slice(0, 300);
};

export function linhaDeLog(nivel: Nivel, evento: string, campos: Record<string, unknown> = {}): string {
  const saida: Record<string, unknown> = { em: new Date().toISOString(), nivel, evento };
  for (const [k, v] of Object.entries(campos)) if (CAMPOS_PERMITIDOS.has(k) && v !== undefined) saida[k] = limpar(v);
  return JSON.stringify(saida);
}

export const log = (nivel: Nivel, evento: string, campos?: Record<string, unknown>) => {
  const linha = linhaDeLog(nivel, evento, campos);
  if (nivel === 'error') console.error(linha); else console.log(linha);
};

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    auth?: import('../auth/tipos').AuthDaRequisicao;
  }
}

/** Middleware Express: request_id gerado aqui (nunca aceito do cliente) e uma linha por resposta. */
export function logDeRequisicao(req: Request, res: Response, next: NextFunction) {
  const inicio = process.hrtime.bigint();
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.on('finish', () => {
    // Padrão da rota (/api/v1/usuarios/:id), nunca a URL: a query pode carregar dado de busca.
    const rota = req.route?.path ? `${req.baseUrl ?? ''}${String(req.route.path)}` : '(sem rota)';
    log(res.statusCode >= 500 ? 'error' : 'info', 'http', {
      request_id: req.requestId, usuario_id: req.auth?.usuario.id, condominio_id: req.condominio?.id, metodo: req.method, rota, status: res.statusCode,
      ms: Number((process.hrtime.bigint() - inicio) / 1_000_000n),
    });
  });
  next();
}
