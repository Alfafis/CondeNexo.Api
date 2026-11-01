// Códigos de recuperação do 2º fator (spec C2, D7): 10 por geração, 80 bits cada (16 caracteres base32 em
// `XXXX-XXXX-XXXX-XXXX`). No banco só `sha256("portaria:recuperacao:v1:" || normalizado)` em hex, como o token de sessão.
// Alta entropia dispensa argon2; sem HMAC da mestra de propósito: os códigos continuam valendo se o segredo TOTP não abrir
// (mestra trocada errado, relógio fora). O claro só existe na resposta que os gera.
import { createHash, randomBytes } from 'node:crypto';
import { base32 } from './totp';

export const CODIGOS_POR_GERACAO = 10;
const BYTES = 10; // 80 bits = 16 caracteres base32

/** Maiúsculas, sem espaços nem hífens; 16 caracteres do alfabeto base32, ou null. */
export function normalizarCodigoRecuperacao(bruto: string): string | null {
  const n = bruto.replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(n) ? n : null;
}

export const hashCodigoRecuperacao = (normalizado: string) =>
  createHash('sha256').update(`portaria:recuperacao:v1:${normalizado}`, 'utf8').digest('hex');

/** Uma geração: os códigos para mostrar (uma vez) e os hashes para gravar. Sem repetidos. */
export function gerarCodigosRecuperacao(): { codigos: string[]; hashes: string[] } {
  const vistos = new Set<string>();
  while (vistos.size < CODIGOS_POR_GERACAO) vistos.add(base32(randomBytes(BYTES)));
  const normais = [...vistos];
  return { codigos: normais.map((c) => c.match(/.{4}/g)!.join('-')), hashes: normais.map(hashCodigoRecuperacao) };
}
