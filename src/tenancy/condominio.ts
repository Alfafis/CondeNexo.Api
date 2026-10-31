// Condomínio resolvido para uma requisição ou um job (docs/05_arquitetura_saas.md SAAS-03/04, fase F2). É o que a
// subárvore de injeção de um condomínio recebe: o banco dele, as chaves dele (desembrulhadas da plataforma pela chave
// mestra) e a pasta dos anexos dele. Nada aqui é dado pessoal; as chaves nunca vão a log nem a resposta.
import { join } from 'node:path';
import type { Agrupamento } from '../dominio/units';

/** Token do provider durável com o condomínio da subárvore (`null` na subárvore "sem condomínio"). */
export const CONDOMINIO = Symbol('CONDOMINIO');

/** Status em que o condomínio é atendido: `suspenso` recusa login, mas sessões, selo e retenção continuam (SAAS-11). */
export const STATUS_ATENDIDOS = ['ativo', 'suspenso'] as const;
export type StatusAtendido = (typeof STATUS_ATENDIDOS)[number];

export interface ChavesCondominio {
  /** HMAC do CPF (`documento_busca`) e raiz da subchave do limite de login. */
  hmacCpf: Buffer;
  /** KEK ATIVA dos anexos e a versão dela (gravada em `documento.chave_versao` e na AAD da DEK de anexo novo). */
  kek: Buffer;
  kekVersao: number;
  /**
   * Todas as versões da KEK registradas para o condomínio (a ativa e as anteriores), por versão. O anexo é lido pela
   * versão gravada nele: durante a rotação (cli/rotacionar-chaves), anexo ainda na versão antiga e anexo já migrado
   * são legíveis ao mesmo tempo. Anexo novo sempre usa a ativa.
   */
  keks: ReadonlyMap<number, Buffer>;
}

export interface CondominioResolvido {
  id: string;
  codigo: string;
  /**
   * Nome exibido (cabeçalho do front, via /auth/me). Lido na 1ª resolução do condomínio: renomear vale depois de
   * reiniciar a API, como a rotação de chave (resolvedor.ts).
   */
  nome: string;
  /** Nome do banco Postgres (`portaria` no piloto). */
  banco: string;
  /** O piloto é o banco `portaria` de antes do SaaS: mantém a pasta de anexos e o endpoint público v1. */
  piloto: boolean;
  /**
   * "Bloco"/"Torre" da tabela `configuracao` do banco do condomínio (provisionamento); sem a linha (piloto),
   * `ESTRUTURA_PADRAO.agrupamento`. Lido na 1ª resolução, como o nome.
   */
  agrupamento: Agrupamento;
  chaves: ChavesCondominio;
}

/**
 * Pasta dos anexos cifrados do condomínio. O piloto continua na raiz do volume (os arquivos de produção não se mexem);
 * os demais usam `<raiz>/<condominio_id>/`. A varredura de órfãos da retenção só lista `<uuid>.bin`/`<uuid>.tmp` na
 * própria pasta, então a do piloto não enxerga as subpastas dos outros, e cada condomínio só limpa a sua.
 */
export function pastaDocumentos(raiz: string, c: Pick<CondominioResolvido, 'id' | 'piloto'>): string {
  return c.piloto ? raiz : join(raiz, c.id);
}

/** Chaves do condomínio da subárvore. Sem condomínio (subárvore de falha fechada): lança, nunca cai numa chave padrão. */
export function chavesDe(c: CondominioResolvido | null): ChavesCondominio {
  if (!c) throw new Error('chave de condomínio pedida sem condomínio resolvido');
  return c.chaves;
}
