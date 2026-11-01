// Segredo TOTP do usuário da plataforma, cifrado pela chave mestra (spec C2, D5). Coluna = nonce(12) || cifrado(20) ||
// tag(16) = 48 bytes; a versão da mestra fica em coluna própria (`totp_mestra_versao` / `totp_pendente_mestra_versao`).
// AAD `portaria:totp:<master_usuario_id>:<ativo|pendente>`: copiar o segredo de outro usuário para a linha, ou o pendente
// para o ativo sem passar pela confirmação, falha no GCM em vez de entregar o segredo. A versão da mestra NÃO entra na
// AAD (como em chave-mestra.ts): a rotação re-cifra a mesma identidade.
import { type ChaveMestra, cifrarComAad, decifrarComAad, ErroChave } from './chave-mestra';
import { TOTP_SEGREDO_BYTES } from './totp';

const NONCE = 12;
export const TAMANHO_TOTP_CIFRADO = NONCE + TOTP_SEGREDO_BYTES + 16;

export type EstadoTotp = 'ativo' | 'pendente';

export const aadTotp = (usuarioId: string, estado: EstadoTotp) => `portaria:totp:${usuarioId}:${estado}`;

export interface TotpCifrado { cifrado: Buffer; mestraVersao: number }

export function cifrarSegredoTotp(mestra: ChaveMestra, usuarioId: string, estado: EstadoTotp, segredo: Buffer): TotpCifrado {
  if (segredo.length !== TOTP_SEGREDO_BYTES) throw new ErroChave(`segredo TOTP deve ter ${TOTP_SEGREDO_BYTES} bytes`);
  const r = cifrarComAad(mestra, aadTotp(usuarioId, estado), segredo);
  return { cifrado: Buffer.concat([r.nonce, r.cifrado]), mestraVersao: r.mestraVersao };
}

/** Lança ErroChave (sem detalhe) se a versão da mestra não bater, o tamanho for inválido ou o GCM não autenticar. */
export function decifrarSegredoTotp(mestra: ChaveMestra, usuarioId: string, estado: EstadoTotp, e: { cifrado: Uint8Array; mestraVersao: number }): Buffer {
  const b = Buffer.from(e.cifrado);
  if (b.length !== TAMANHO_TOTP_CIFRADO) throw new ErroChave('segredo TOTP cifrado com tamanho inválido');
  const claro = decifrarComAad(mestra, aadTotp(usuarioId, estado), { nonce: b.subarray(0, NONCE), cifrado: b.subarray(NONCE), mestraVersao: e.mestraVersao });
  if (claro.length !== TOTP_SEGREDO_BYTES) { claro.fill(0); throw new ErroChave('segredo TOTP com tamanho inválido'); }
  return claro;
}
