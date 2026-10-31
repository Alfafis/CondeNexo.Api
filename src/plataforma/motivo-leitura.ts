// Motivo obrigatório na leitura do Master (spec 2026-10-31, Fase B). Antes de ler os dados de um condomínio, o Master
// informa a finalidade (categoria) e um texto; a API devolve um token que vale 30 min, só para AQUELA sessão e AQUELE
// condomínio, e que vai em `X-Motivo-Token` em toda leitura (AcessoPlataformaService.ler).
//
// Sem estado no servidor e sem migração: o token é `v1.<payload base64url>.<HMAC-SHA256 base64url>`, com o HMAC sobre
// `v1.<payload>` e a subchave HKDF da chave mestra de rótulo próprio (mesmo mecanismo do limite-master.service.ts).
// Assinado, NÃO cifrado: o texto viaja legível no navegador do próprio Master (aceito no spec: é o texto que ele digitou).
// O texto livre vai para o audit_log do condomínio e NUNCA para plataforma_audit (sem redação LGPD lá; ver
// acesso-plataforma.service.ts).
//
// Logout/revogação: a sessão é validada a cada requisição pela PlataformaGuard (revogada = 401 antes de chegar aqui), e o
// token só vale com `sessaoId` igual ao da sessão atual. Token de uma sessão revogada não serve em outra.
// Rotação da chave mestra: a subchave muda e os tokens em voo deixam de valer (403, o Master informa o motivo de novo).
import { Inject, Injectable } from '@nestjs/common';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RELOGIO, type Relogio } from '../comum/relogio';
import type { ChaveMestra } from './chave-mestra';
import { CHAVE_MESTRA } from './plataforma-db';

/** As finalidades do acesso do Master (docs/05_arquitetura_saas.md). */
export const CATEGORIAS_MOTIVO = ['suporte', 'incidente', 'obrigacao_legal', 'operacao'] as const;
export type CategoriaMotivo = (typeof CATEGORIAS_MOTIVO)[number];

export const VALIDADE_MOTIVO_MIN = 30;
export const CABECALHO_MOTIVO = 'x-motivo-token';
const VERSAO = 'v1';
/** Texto de até 500 caracteres (até 2 KB em UTF-8) em base64url fica bem abaixo disto. */
const TAMANHO_MAX = 4096;

export interface MotivoLeitura { categoria: CategoriaMotivo; texto: string }

const Payload = z.strictObject({
  sessaoId: z.string(),
  condominioId: z.string(),
  categoria: z.enum(CATEGORIAS_MOTIVO),
  texto: z.string(),
  expiraEm: z.number().int(),
});

@Injectable()
export class MotivoLeituraService {
  private readonly subchave: Buffer;

  constructor(
    @Inject(CHAVE_MESTRA) mestra: ChaveMestra,
    @Inject(RELOGIO) private readonly relogio: Relogio,
  ) {
    this.subchave = Buffer.from(hkdfSync('sha256', mestra.chave, Buffer.alloc(0), 'portaria/plataforma/motivo/v1', 32));
  }

  private assinar(assinado: string) {
    return createHmac('sha256', this.subchave).update(assinado, 'utf8').digest('base64url');
  }

  emitir(sessaoId: string, condominioId: string, m: MotivoLeitura): { token: string; expiraEm: Date } {
    const expiraEm = new Date(this.relogio.agora().getTime() + VALIDADE_MOTIVO_MIN * 60_000);
    const payload = Buffer.from(JSON.stringify({
      sessaoId, condominioId: condominioId.toLowerCase(), categoria: m.categoria, texto: m.texto, expiraEm: expiraEm.getTime(),
    }), 'utf8').toString('base64url');
    const assinado = `${VERSAO}.${payload}`;
    return { token: `${assinado}.${this.assinar(assinado)}`, expiraEm };
  }

  /** O motivo, se o token vale para esta sessão e este condomínio agora; senão null (a causa não sai daqui). */
  validar(token: unknown, sessaoId: string, condominioId: string): MotivoLeitura | null {
    if (typeof token !== 'string' || token.length > TAMANHO_MAX) return null;
    const partes = token.split('.');
    if (partes.length !== 3 || partes[0] !== VERSAO) return null;
    // Compara a assinatura em texto (base64url canônico): sem maleabilidade de codificação e em tempo constante.
    const esperada = Buffer.from(this.assinar(`${VERSAO}.${partes[1]}`), 'utf8');
    const recebida = Buffer.from(partes[2]!, 'utf8');
    if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;
    let p: z.infer<typeof Payload>;
    try {
      const r = Payload.safeParse(JSON.parse(Buffer.from(partes[1]!, 'base64url').toString('utf8')));
      if (!r.success) return null;
      p = r.data;
    } catch {
      return null;
    }
    if (p.expiraEm <= this.relogio.agora().getTime()) return null;
    if (p.sessaoId !== sessaoId || p.condominioId !== condominioId.toLowerCase()) return null;
    return { categoria: p.categoria, texto: p.texto };
  }
}
