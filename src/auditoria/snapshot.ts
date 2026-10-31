// Snapshot do audit_log (spec §3.3): chaves em snake_case (nomes de coluna do banco, que é o que
// `lgpd_redigir_audit_pessoa` remove: nome, telefone, documento_mascarado, empresa, servico) e sem segredo nem
// documento em claro. O nome da pessoa PODE aparecer (é redigível); senha, hash, token e HMAC do CPF nunca.
import { mascararDigitos } from '../comum/log';

/** Removidas em qualquer nível. Segredo não se mascara: some. */
const CHAVES_PROIBIDAS = new Set([
  'senha', 'senha_hash', 'senha_atual', 'nova_senha', 'senha_temporaria', 'token', 'token_hash', 'documento_busca', 'cookie',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const paraSnakeCase = (k: string) => k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);

export function mascararTelefone(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length >= 4 ? `(**) *****-${d.slice(-4)}` : '***';
}

function limpar(v: unknown, chave: string): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return '[binario]';
  if (Array.isArray(v)) return v.map((x) => limpar(x, chave));
  if (typeof v === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const sk = paraSnakeCase(k);
      if (CHAVES_PROIBIDAS.has(sk) || x === undefined) continue;
      saida[sk] = limpar(x, sk);
    }
    return saida;
  }
  if (typeof v !== 'string') return v;
  if (chave === 'telefone') return mascararTelefone(v);
  if (chave === 'documento_mascarado') return v; // já mascarado na origem (123.45*.***-** ou o antigo ***.456.789-**)
  if (UUID.test(v) || chave === 'id' || chave.endsWith('_id')) return v;
  return mascararDigitos(v);
}

/** Converte uma linha (camelCase do Drizzle) ou objeto qualquer no snapshot gravável. */
export function snapshot(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  const r = limpar(v, '');
  return typeof r === 'object' && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : { valor: r };
}
