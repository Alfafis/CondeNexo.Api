// Envelope das chaves por condomínio (docs/05_arquitetura_saas.md SAAS-04). Cada condomínio tem a sua chave HMAC do CPF
// e a sua KEK de anexos; no banco `plataforma` elas ficam cifradas (AES-256-GCM) pela chave mestra do ambiente
// (`PORTARIA_CHAVE_MESTRA`), que nunca vai ao banco nem ao backup. Mesmo desenho do cofre dos anexos
// (documentos/cofre.ts): nonce de 12 bytes por embrulho, tag de 16 bytes no fim do cifrado, AAD que amarra o embrulho
// à identidade da chave.
//
// - AAD `portaria:chave:<condominio_id>:<tipo>:v<versao>`: trocar a linha de um condomínio pela de outro (ou a KEK pela
//   HMAC, ou a v1 pela v2) falha na autenticação do GCM em vez de entregar a chave errada.
// - `mestra_versao` NÃO entra na AAD: a mestra errada já falha no GCM, e a rotação da mestra re-embrulha a mesma
//   identidade. A versão serve para escolher a mestra (e recusar cedo, com mensagem clara, a que não bate).
// - Nada aqui imprime, loga ou devolve chave em claro fora de `desembrulhar`. A "impressão digital" é um SHA-256 com
//   rótulo, truncado: serve para conferir a cópia do cofre sem expor a chave (256 bits aleatórios não se invertem).
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TipoChave } from './schema-plataforma';

const NONCE = 12;
const TAG = 16;

export class ErroChave extends Error {}

export interface ChaveMestra {
  chave: Buffer;
  versao: number;
}

/** Identidade de uma chave de condomínio (a AAD do embrulho). */
export interface IdChave {
  condominioId: string;
  tipo: TipoChave;
  versao: number;
}

export interface Embrulho {
  chaveCifrada: Buffer;
  nonce: Buffer;
  mestraVersao: number;
}

export const aadChave = (id: IdChave) => `portaria:chave:${id.condominioId}:${id.tipo}:v${id.versao}`;

function versaoValida(v: number, nome: string): number {
  if (!Number.isInteger(v) || v < 1 || v > 32767) throw new ErroChave(`${nome} deve ser inteiro entre 1 e 32767`);
  return v;
}

/**
 * Chave em base64 do ambiente. `exata`: AES-256 exige 32 bytes (mestra e KEK). A HMAC do CPF aceita 32 a 128 (a do piloto
 * veio do ambiente, que só exige "pelo menos 32"). A mensagem cita o NOME da variável, nunca o valor.
 */
export function chaveDoAmbiente(env: NodeJS.ProcessEnv, nome: string, tamanho: { min: number; max: number }): Buffer {
  const bruto = env[nome]?.trim();
  if (!bruto) throw new ErroChave(`${nome} não definida`);
  // Mesma leitura de config/config.ts (Buffer.from base64, tolerante): a chave importada tem de ser byte a byte a que a
  // API usa hoje. Uma validação mais estrita aqui recusaria um valor que a API aceita.
  const chave = Buffer.from(bruto, 'base64');
  if (chave.length < tamanho.min || chave.length > tamanho.max) {
    throw new ErroChave(tamanho.min === tamanho.max ? `${nome} precisa ter exatamente ${tamanho.min} bytes (base64)` : `${nome} precisa ter de ${tamanho.min} a ${tamanho.max} bytes (base64)`);
  }
  return chave;
}

export function versaoDoAmbiente(env: NodeJS.ProcessEnv, nome: string): number {
  const bruto = env[nome]?.trim();
  if (!bruto) throw new ErroChave(`${nome} não definida`);
  if (!/^\d+$/.test(bruto)) throw new ErroChave(`${nome} deve ser inteiro`);
  return versaoValida(Number(bruto), nome);
}

/** `PORTARIA_CHAVE_MESTRA` (base64 de 32 bytes) e `PORTARIA_CHAVE_MESTRA_VERSAO`. */
export function carregarChaveMestra(env: NodeJS.ProcessEnv = process.env): ChaveMestra {
  return {
    chave: chaveDoAmbiente(env, 'PORTARIA_CHAVE_MESTRA', { min: 32, max: 32 }),
    versao: versaoDoAmbiente(env, 'PORTARIA_CHAVE_MESTRA_VERSAO'),
  };
}

export function embrulhar(mestra: ChaveMestra, id: IdChave, chave: Buffer): Embrulho {
  versaoValida(id.versao, 'versão da chave');
  if (chave.length < 32 || chave.length > 128) throw new ErroChave('chave do condomínio deve ter de 32 a 128 bytes');
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', mestra.chave, nonce, { authTagLength: TAG });
  c.setAAD(Buffer.from(aadChave(id), 'utf8'));
  const chaveCifrada = Buffer.concat([c.update(chave), c.final(), c.getAuthTag()]);
  return { chaveCifrada, nonce, mestraVersao: mestra.versao };
}

/** Lança ErroChave se a mestra for de outra versão ou se o GCM não autenticar (mestra errada, linha trocada, adulterada). */
export function desembrulhar(mestra: ChaveMestra, id: IdChave, e: { chaveCifrada: Uint8Array; nonce: Uint8Array; mestraVersao: number }): Buffer {
  if (e.mestraVersao !== mestra.versao) {
    throw new ErroChave(`chave embrulhada com a mestra v${e.mestraVersao}, mas o ambiente tem a v${mestra.versao}`);
  }
  const cifrado = Buffer.from(e.chaveCifrada);
  if (e.nonce.length !== NONCE || cifrado.length <= TAG) throw new ErroChave('embrulho com tamanho inválido');
  try {
    const d = createDecipheriv('aes-256-gcm', mestra.chave, Buffer.from(e.nonce), { authTagLength: TAG });
    d.setAAD(Buffer.from(aadChave(id), 'utf8'));
    d.setAuthTag(cifrado.subarray(cifrado.length - TAG));
    return Buffer.concat([d.update(cifrado.subarray(0, cifrado.length - TAG)), d.final()]);
  } catch {
    // Sem detalhe do OpenSSL: a única informação útil é "não autenticou".
    throw new ErroChave(`embrulho de ${id.tipo} v${id.versao} não autenticou (chave mestra errada ou linha adulterada)`);
  }
}

/** Igualdade em tempo constante (tamanhos diferentes = diferentes). */
export function mesmaChave(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 16 hex de SHA-256("portaria:impressao:v1:" || chave): confere a cópia do cofre sem expor a chave. */
export function impressaoDigital(chave: Buffer): string {
  return createHash('sha256').update('portaria:impressao:v1:', 'utf8').update(chave).digest('hex').slice(0, 16);
}
