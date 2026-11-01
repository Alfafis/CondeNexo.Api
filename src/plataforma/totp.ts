// TOTP (RFC 6238 sobre HOTP, RFC 4226) do 2º fator da plataforma, com node:crypto e sem dependência: HMAC-SHA1, 6 dígitos,
// passo de 30 s, T0 = 0, janela de ±1 passo (aceita o anterior, o atual e o seguinte). O passo vem do Relogio injetável
// (os testes avançam o relógio). Não alargar a janela como remendo de relógio: cada passo a mais soma códigos válidos ao
// ataque (spec C2, "TOTP e relógio").
//
// Nada aqui loga ou devolve o segredo além de `base32` (que só a resposta de enrolamento usa, uma vez).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PASSO_S = 30;
export const TOTP_DIGITOS = 6;
/** Tamanho do segredo (RFC 4226 recomenda 160 bits para SHA1). */
export const TOTP_SEGREDO_BYTES = 20;
export const TOTP_JANELA = 1;
export const TOTP_EMISSOR = 'CondeNexo';

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 RFC 4648, sem padding (20 bytes = 32 caracteres). */
export function base32(b: Uint8Array): string {
  let bits = 0;
  let valor = 0;
  let s = '';
  for (const byte of b) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      s += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) s += ALFABETO[(valor << (5 - bits)) & 31];
  return s;
}

/** Inverso de base32 (maiúsculas ou minúsculas, sem padding). Caractere fora do alfabeto: Error sem ecoar o texto. */
export function deBase32(s: string): Buffer {
  const limpo = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let valor = 0;
  const out: number[] = [];
  for (const ch of limpo) {
    const i = ALFABETO.indexOf(ch);
    if (i < 0) throw new Error('base32 inválido');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const gerarSegredoTotp = () => randomBytes(TOTP_SEGREDO_BYTES);

/** Passo TOTP do instante (floor(unix / 30)). */
export const passoDe = (agora: Date) => Math.floor(agora.getTime() / 1000 / TOTP_PASSO_S);

/** HOTP(segredo, passo) com 6 dígitos (truncamento dinâmico da RFC 4226). */
export function codigoTotp(segredo: Uint8Array, passo: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const h = createHmac('sha1', segredo).update(contador).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 10 ** TOTP_DIGITOS).padStart(TOTP_DIGITOS, '0');
}

export interface TotpAceito {
  passo: number;
  /** Em que deslocamento da janela o código bateu (-1, 0 ou 1): vai para a trilha para enxergar deriva do relógio. */
  desvio: -1 | 0 | 1;
}

/**
 * Confere `codigo` (6 dígitos, já normalizado) contra os passos atual-1, atual e atual+1. Compara os três candidatos
 * em tempo constante e sem sair cedo. Se mais de um bater (colisão, ~3 em 10^6), fica o MAIOR passo (o anti-replay
 * só aceita passo maior que o último). null: nenhum bateu.
 */
export function verificarTotp(segredo: Uint8Array, codigo: string, passoAtual: number): TotpAceito | null {
  const recebido = Buffer.from(codigo.padEnd(TOTP_DIGITOS, 'x').slice(0, TOTP_DIGITOS), 'utf8');
  const formatoOk = /^\d{6}$/.test(codigo);
  let aceito: TotpAceito | null = null;
  for (let d = -TOTP_JANELA; d <= TOTP_JANELA; d++) {
    const passo = passoAtual + d;
    if (passo < 1) continue;
    const bate = timingSafeEqual(Buffer.from(codigoTotp(segredo, passo), 'utf8'), recebido);
    if (bate && formatoOk) aceito = { passo, desvio: d as -1 | 0 | 1 };
  }
  return aceito;
}

/** URI do QR: o e-mail no rótulo é cosmético (trocar o e-mail depois não invalida nada). */
export function otpauthUri(email: string, segredo: Uint8Array): string {
  const rotulo = encodeURIComponent(`${TOTP_EMISSOR}:${email}`);
  return `otpauth://totp/${rotulo}?secret=${base32(segredo)}&issuer=${encodeURIComponent(TOTP_EMISSOR)}&algorithm=SHA1&digits=${TOTP_DIGITOS}&period=${TOTP_PASSO_S}`;
}
