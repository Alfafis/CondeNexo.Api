// Página de uma listagem por cursor (skill rest-api: req-pagination). O controller devolve `Pagina` e o
// EnvelopeInterceptor a serializa como { data: [...], pagination: { cursor, hasNextPage } }.
import { z } from 'zod';
import { erroApi } from './erros';

export class Pagina<T> {
  constructor(readonly itens: T[], readonly proximoCursor: string | null) {}
}

export const LIMITE_PADRAO = 50;
export const LIMITE_MAX = 100;

/** Query de listagem: `?limite=1..100&cursor=...`. Parâmetro desconhecido é 400 (strictObject). */
export const PaginacaoDto = z.strictObject({
  limite: z.coerce.number().int().min(1).max(LIMITE_MAX).default(LIMITE_PADRAO),
  cursor: z.string().min(1).max(500).optional(),
});
export type Paginacao = z.infer<typeof PaginacaoDto>;

/** Cursor opaco (base64url de JSON). O conteúdo é a chave de ordenação do último item, não um offset. */
export const codificarCursor = (chave: unknown) => Buffer.from(JSON.stringify(chave), 'utf8').toString('base64url');

export function decodificarCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let bruto: unknown;
  try { bruto = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { bruto = undefined; }
  const r = schema.safeParse(bruto);
  if (!r.success) throw erroApi(400, 'CURSOR_INVALIDO', 'Cursor de paginação inválido.', [{ field: 'cursor', message: 'cursor inválido' }]);
  return r.data;
}
