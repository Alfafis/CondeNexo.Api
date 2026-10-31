// Erros da API. Internamente a exceção carrega { codigo, mensagem, detalhes? }; o FiltroExcecao serializa no
// envelope da skill rest-api (req-error-format): { statusCode, error, code, message, details?, timestamp, path }.
import { STATUS_CODES } from 'node:http';
import { ForbiddenException, HttpException } from '@nestjs/common';

export interface CorpoErro {
  codigo: string;
  mensagem: string;
  detalhes?: unknown;
}

/** Corpo de erro na resposta HTTP. `path` sem query string: a query pode carregar dado pessoal (busca por CPF). */
export interface RespostaErro {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  details?: unknown;
  timestamp: string;
  path: string | null;
}

export function respostaErro(status: number, corpo: CorpoErro, url: string | undefined, agora = new Date()): RespostaErro {
  return {
    statusCode: status,
    error: STATUS_CODES[status] ?? 'Error',
    code: corpo.codigo,
    message: corpo.mensagem,
    ...(corpo.detalhes === undefined ? {} : { details: corpo.detalhes }),
    timestamp: agora.toISOString(),
    path: url ? url.split('?')[0]! : null,
  };
}

export const erroApi = (status: number, codigo: string, mensagem: string, detalhes?: unknown) =>
  new HttpException(detalhes === undefined ? { codigo, mensagem } : { codigo, mensagem, detalhes }, status);

/**
 * 403 com a ação RBAC tentada. O filtro global grava `acesso.negado` para TODO 403 (spec §5.2), DEPOIS do rollback
 * da transação em que a negação aconteceu: gravar dentro dela perderia o registro.
 */
export class AcessoNegado extends ForbiddenException {
  constructor(readonly acaoTentada: string, mensagem = 'Seu perfil não tem permissão para esta ação.', codigo = 'SEM_PERMISSAO') {
    super({ codigo, mensagem });
  }
}

/** Código SQLSTATE do Postgres. O Drizzle embrulha o erro do driver em `cause`. */
export function codigoPg(erro: unknown): string | undefined {
  const e = erro as { code?: unknown; cause?: { code?: unknown } } | null;
  const c = e?.cause?.code ?? e?.code;
  return typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) ? c : undefined;
}

export function constraintPg(erro: unknown): string | undefined {
  const e = erro as { constraint?: unknown; cause?: { constraint?: unknown } } | null;
  const c = e?.cause?.constraint ?? e?.constraint;
  return typeof c === 'string' ? c : undefined;
}
