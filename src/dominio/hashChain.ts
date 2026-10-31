// Cadeia de hash da trilha de acessos (RF-32, RF-37, RNF-01; spec §4.3 e §4.7). FONTE ÚNICA da serialização:
// usada pelo front, pela API (src/db/cadeia.ts) e pelo verificador da exportação.
// Reproduz byte a byte `evento_acesso_canonico(e)` do banco (migrações 0001 e 0013):
//   hash = hex( SHA-256( UTF-8( hash_anterior || canonico ) ) )
//   canonico = JSON compacto, chaves na ordem de CAMPOS_CANONICOS_V1 (precedidas de "v"), null explícito,
//              instantes ISO 8601 UTC com ms (Date.toISOString), correcao_valores como objeto em ordem fixa.
// Formatos (coluna `formato_hash`, chave "v"):
//   1 = evento SEM veículo (todos os eventos até a 0013 e, depois dela, todo evento sem placa);
//   2 = entrada COM veículo: os campos da v1 e, no fim, CAMPOS_VEICULO_V2 (veiculo_placa, veiculo_modelo, veiculo_cor).
// O formato é função do conteúdo (placa preenchida <=> v2; CHECK evento_veiculo_formato_ck no banco), então um evento v1
// continua sendo serializado exatamente como antes e quem só conhece a v1 segue verificando os eventos sem veículo.
// SHA-256 por WebCrypto (globalThis.crypto.subtle): funciona no navegador (localhost/HTTPS) e no Node 22.
import type { EventoAcesso, ValoresCorrecao } from './types';

/** Formato base da serialização canônica (`formato_hash` de todo evento sem veículo). */
export const FORMATO_HASH = 1;
/** Formato da entrada com veículo (0013): v1 + CAMPOS_VEICULO_V2 no fim. */
export const FORMATO_HASH_VEICULO = 2;
/** Formatos que este verificador sabe serializar. */
export const FORMATOS_HASH = [FORMATO_HASH, FORMATO_HASH_VEICULO] as const;
/** Formato que o trigger grava: 2 se a entrada tem placa, senão 1. */
export const formatoHashDe = (veiculoPlaca: string | null | undefined) => (veiculoPlaca ? FORMATO_HASH_VEICULO : FORMATO_HASH);

/** Ordem dos campos na serialização canônica v1 (a chave "v" vem antes de todos). */
export const CAMPOS_CANONICOS_V1 = [
  'seq', 'id', 'tipo', 'categoria_pessoa', 'pessoa_id', 'unidade_destino_id', 'area_comum_id', 'ponto_acesso_id',
  'autorizado_por_tipo', 'autorizado_por_pessoa_id', 'autorizacao_previa_id', 'justificativa', 'restricao_id',
  'operador_id', 'operador_papel', 'ocorrido_em', 'registrado_em', 'retroativo', 'formulario_contingencia',
  'refere_evento_id', 'corrige_evento_id', 'correcao_valores', 'empresa', 'servico', 'observacao',
] as const;

/** Campos acrescentados no fim pela v2 (entrada com veículo). */
export const CAMPOS_VEICULO_V2 = ['veiculo_placa', 'veiculo_modelo', 'veiculo_cor'] as const;
export const CAMPOS_CANONICOS_V2 = [...CAMPOS_CANONICOS_V1, ...CAMPOS_VEICULO_V2] as const;

/** Ordem das chaves de correcao_valores (só as presentes entram). Chave nova entra no fim. */
export const CHAVES_CORRECAO_V1 = ['unidade_destino_id', 'ocorrido_em', 'pessoa_id', 'autorizado_por_pessoa_id'] as const;

type CampoCanonico = (typeof CAMPOS_CANONICOS_V1)[number];

/** Evento no formato de exportação verificável: snake_case, ids como texto, instantes em ISO 8601 UTC com ms. */
export type EventoExportado = {
  [K in Exclude<CampoCanonico, 'seq' | 'retroativo' | 'correcao_valores'>]: string | null;
} & {
  /** Só na v2 (a v1 não tem veículo; numa linha v1 as chaves ficam ausentes). Placa sem hífen, como no banco. */
  veiculo_placa?: string | null;
  veiculo_modelo?: string | null;
  veiculo_cor?: string | null;
} & {
  v: number;
  seq: number;
  retroativo: boolean;
  correcao_valores: Record<string, string | null> | null;
  hash_anterior: string;
  hash: string;
};

export async function sha256Hex(texto: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto (crypto.subtle) indisponível: abra o app em localhost ou HTTPS.');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

let genese: Promise<string> | null = null;
/** Hash de gênese: SHA-256 hex da string "genesis" (hash_anterior do seq 1; mesmo valor gravado pela migração). */
export const hashGenese = () => (genese ??= sha256Hex('genesis'));

function canonCorrecao(v: Record<string, string | null> | null): Record<string, string | null> | null {
  if (v === null) return null;
  const out: Record<string, string | null> = {};
  for (const k of CHAVES_CORRECAO_V1) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k] ?? null;
  return out;
}

const temVeiculo = (e: EventoExportado) => e.veiculo_placa != null || e.veiculo_modelo != null || e.veiculo_cor != null;

/**
 * JSON canônico do formato do evento (`e.v`): compacto, chaves na ordem fixa, null explícito.
 * Recusa (lança) o que o banco nunca grava: formato desconhecido, v1 com veículo, v2 sem placa. O verificador trata
 * a recusa como conteúdo alterado.
 */
export function jsonCanonico(e: EventoExportado): string {
  let campos: readonly string[];
  if (e.v === FORMATO_HASH) {
    if (temVeiculo(e)) throw new Error('formato de hash 1 não tem veículo');
    campos = CAMPOS_CANONICOS_V1;
  } else if (e.v === FORMATO_HASH_VEICULO) {
    if (!e.veiculo_placa) throw new Error('formato de hash 2 exige a placa do veículo');
    campos = CAMPOS_CANONICOS_V2;
  } else {
    throw new Error(`formato de hash não suportado: v=${e.v}`);
  }
  const obj: Record<string, unknown> = { v: e.v };
  const valores = e as unknown as Record<string, unknown>;
  for (const c of campos) obj[c] = c === 'correcao_valores' ? canonCorrecao(e.correcao_valores) : (valores[c] ?? null);
  return JSON.stringify(obj);
}

/** JSON canônico v1 (só aceita evento v1). Mantido para quem conferia a v1; o geral é `jsonCanonico`. */
export function jsonCanonicoV1(e: EventoExportado): string {
  if (e.v !== FORMATO_HASH) throw new Error(`formato de hash não suportado: v=${e.v}`);
  return jsonCanonico(e);
}

/** Hash de um evento exportado: SHA-256(hash_anterior + JSON canônico do formato dele). */
export const calcularHashExportado = async (e: EventoExportado) => sha256Hex(e.hash_anterior + jsonCanonico(e));

const iso = (ms: number) => new Date(ms).toISOString();

/** correcao_valores (camelCase, epoch) -> objeto do banco (snake_case, ISO), só com as chaves presentes. */
export function correcaoParaExportacao(v: Partial<ValoresCorrecao> | null): Record<string, string | null> | null {
  if (v === null) return null;
  const out: Record<string, string | null> = {};
  if ('unidadeDestinoId' in v) out.unidade_destino_id = v.unidadeDestinoId ?? null;
  if ('ocorridoEm' in v) out.ocorrido_em = v.ocorridoEm === undefined ? null : iso(v.ocorridoEm);
  if ('pessoaId' in v) out.pessoa_id = v.pessoaId ?? null;
  if ('autorizadoPorPessoaId' in v) out.autorizado_por_pessoa_id = v.autorizadoPorPessoaId ?? null;
  return out;
}

/** Evento do domínio (camelCase, epoch ms) -> formato de exportação/hash. */
export function paraExportado(e: Omit<EventoAcesso, 'hash'> & { hash?: string }): EventoExportado {
  return {
    v: e.formatoHash, seq: e.seq, id: e.id, tipo: e.tipo, categoria_pessoa: e.categoriaPessoa, pessoa_id: e.pessoaId,
    unidade_destino_id: e.unidadeDestinoId, area_comum_id: e.areaComumId, ponto_acesso_id: e.pontoAcessoId,
    autorizado_por_tipo: e.autorizadoPorTipo, autorizado_por_pessoa_id: e.autorizadoPorPessoaId,
    autorizacao_previa_id: e.autorizacaoPreviaId, justificativa: e.justificativa, restricao_id: e.restricaoId,
    operador_id: e.operadorId, operador_papel: e.operadorPapel, ocorrido_em: iso(e.ocorridoEm),
    registrado_em: iso(e.registradoEm), retroativo: e.retroativo, formulario_contingencia: e.formularioContingencia,
    refere_evento_id: e.refereEventoId, corrige_evento_id: e.corrigeEventoId,
    correcao_valores: correcaoParaExportacao(e.correcaoValores),
    empresa: e.empresa, servico: e.servico, observacao: e.observacao,
    ...camposVeiculo(e.formatoHash, e.veiculoPlaca, e.veiculoModelo, e.veiculoCor),
    hash_anterior: e.hashAnterior, hash: e.hash ?? '',
  };
}

/**
 * Chaves de veículo do formato de exportação: presentes na v2 (ou se, fora da regra, houver veículo num v1, para o
 * verificador recusar). Num v1 normal ficam ausentes: a linha exportada é a mesma de antes da 0013.
 */
export function camposVeiculo(v: number, placa: string | null | undefined, modelo: string | null | undefined, cor: string | null | undefined) {
  return v !== FORMATO_HASH || placa != null || modelo != null || cor != null
    ? { veiculo_placa: placa ?? null, veiculo_modelo: modelo ?? null, veiculo_cor: cor ?? null }
    : {};
}

/** Hash de um evento do domínio (a API usa isto; o banco calcula o mesmo valor no trigger). */
export const calcularHash = (ev: Omit<EventoAcesso, 'hash'>) => calcularHashExportado(paraExportado(ev));

/** Ponto de partida da verificação: gênese (seq 0) ou o selo/âncora do evento anterior ao primeiro verificado. */
export interface Ancora { seq: number; hash: string }

export interface ResultadoVerificacao {
  valido: boolean;
  verificados: number;
  ultimoSeq: number;
  ultimoHash: string;
  primeiroSeqInvalido?: number;
  primeiroEventoIdInvalido?: string;
  /**
   * lacuna_de_seq: falta evento (inclusive no fim, contra a cabeça da cadeia); hash_anterior_incoerente: encadeamento
   * quebrado; hash_divergente: conteúdo alterado; selo_divergente: a cadeia é coerente por dentro, mas não bate com o
   * selo diário (recalculada inteira depois de adulterada).
   */
  motivo?: 'lacuna_de_seq' | 'hash_anterior_incoerente' | 'hash_divergente' | 'selo_divergente';
}
/** Nome usado pela UI. */
export type ResultadoIntegridade = ResultadoVerificacao;

/**
 * Percorre os eventos em ordem de seq, recalcula cada hash e aponta o primeiro registro adulterado.
 * `ancora`: padrão gênese (seq 0). Depois de um descarte por retenção, use o selo do último seq descartado; numa
 * exportação parcial, o hash do evento imediatamente anterior ao primeiro exportado.
 */
export async function verificarCadeia(eventos: readonly EventoExportado[], ancora?: Ancora): Promise<ResultadoVerificacao> {
  const inicio = ancora ?? { seq: 0, hash: await hashGenese() };
  const ordenados = [...eventos].sort((a, b) => a.seq - b.seq);
  let seqAnterior = inicio.seq;
  let hashAnterior = inicio.hash;
  let verificados = 0;
  for (const e of ordenados) {
    const falha = (motivo: ResultadoVerificacao['motivo']): ResultadoVerificacao => ({
      valido: false, verificados, ultimoSeq: seqAnterior, ultimoHash: hashAnterior,
      primeiroSeqInvalido: e.seq, primeiroEventoIdInvalido: e.id ?? undefined, motivo,
    });
    if (e.seq !== seqAnterior + 1) return falha('lacuna_de_seq');
    if (e.hash_anterior !== hashAnterior) return falha('hash_anterior_incoerente');
    // Serialização recusada (formato desconhecido, v1 com veículo, v2 sem placa) = conteúdo que o banco não grava.
    const h = await calcularHashExportado(e).catch(() => null);
    if (h !== e.hash) return falha('hash_divergente');
    seqAnterior = e.seq;
    hashAnterior = e.hash;
    verificados++;
  }
  return { valido: true, verificados, ultimoSeq: seqAnterior, ultimoHash: hashAnterior };
}

/** Verifica a cadeia de eventos do domínio: converte para o formato canônico e aplica `verificarCadeia`. */
export const verificarCadeiaEventos = (eventos: readonly EventoAcesso[], ancora?: Ancora) =>
  verificarCadeia(eventos.map(paraExportado), ancora);

/** Código de exibição do evento, derivado de `seq` (não é gravado nem entra no hash). */
export const codigoEvento = (seq: number) => `EV-${String(seq).padStart(6, '0')}`;
