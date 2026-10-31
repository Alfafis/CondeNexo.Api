// Endpoint público dos selos diários (destino `github` da âncora, spec §4.6): o workflow do GitHub Actions lê daqui e
// commita no branch `ancoras`. Sem autenticação por desenho: o workflow não guarda segredo nenhum, e o conteúdo não
// é pessoal. O que este endpoint NÃO pode virar, e como foi evitado:
//  - Oráculo de existência de eventos: não aceita parâmetro nenhum (nem seq, nem hash, nem data). Não há pergunta que
//    alguém possa fazer sobre um evento específico; a resposta é sempre a mesma lista para todo mundo.
//  - Relógio fino da portaria: só selos DIÁRIOS (o selo manual sela a cabeça num instante qualquer e não entra), só a
//    data (sem `criado_em`, `enviado_em` ou hora), e o total do dia. A granularidade é o dia, que é a do próprio selo.
//    (Pelo mesmo motivo o /saude público deixou de devolver `ultimoSeq`: em polling, ele mostrava cada evento na hora.)
//  - Atalho para o conteúdo dos eventos: só são publicados os hashes dos eventos selados. Conferir um palpite sobre o
//    conteúdo de um deles exigiria o `hash_anterior` (hash do evento anterior, não publicado) e os uuids aleatórios do
//    evento (pessoa, operador, unidade): inviável.
// O que ele revela, e é aceito: o volume diário de eventos do condomínio inteiro (agregado de todas as unidades, sem
// identificar ninguém) e que o sistema estava no ar naquele dia.
//
// Custo: a resposta fica em cache por CACHE_PUBLICO_MS (invalidada quando nasce um selo diário), então o banco é
// consultado no máximo uma vez por janela, qualquer que seja o tráfego. O limite por IP abaixo protege CPU e banda;
// atrás da Vercel o IP pode ser forjado por quem chama a VPS direto (spec §14 nº 26), e é por isso que a proteção do
// banco é o cache, não o limite.

/** Quantos selos diários o endpoint devolve (os mais recentes). Cobre um mês de VPS fora do ar sem perder âncora. */
export const SELOS_PUBLICOS_MAX = 31;
/** Validade do cache da resposta. Bate com o `max-age` do Cache-Control. */
export const CACHE_PUBLICO_MS = 60_000;
export const FORMATO_SELOS_PUBLICOS = 'portaria-parque/selos-diarios';

export interface SeloPublico {
  /** Dia de referência, BRT ('AAAA-MM-DD'). */
  data: string;
  /** Último evento selado no dia (o maior seq registrado antes da meia-noite BRT seguinte). */
  seq: number;
  /** Hash SHA-256 (hex) do evento `seq`. */
  hash: string;
  /** Eventos registrados no dia até o seq selado. */
  totalDoDia: number;
}

export interface SelosPublicos {
  formato: typeof FORMATO_SELOS_PUBLICOS;
  versao: 1;
  /** Do mais antigo para o mais recente. */
  selos: SeloPublico[];
}

export type ResultadoLimite = { ok: true } | { ok: false; retryAfterSeg: number };

/**
 * Limite por chave (IP) em janela fixa GLOBAL: uma janela para todas as chaves, zerada inteira a cada `janelaMs`.
 * Memória limitada a `chavesMax` chaves por janela; cheia, chave nova é recusada até a janela virar (falha fechada:
 * quem enche o mapa com IPs forjados atrasa a coleta em no máximo uma janela, e o workflow tenta de novo; a resposta
 * carrega 31 dias, então um dia perdido é recuperado na coleta seguinte).
 */
export class LimiteTaxaPublico {
  private inicio = 0;
  private readonly contagem = new Map<string, number>();

  constructor(
    readonly max = 30,
    readonly janelaMs = 60_000,
    readonly chavesMax = 10_000,
  ) {}

  consumir(chave: string, agoraMs: number): ResultadoLimite {
    // Relógio voltou (ajuste de NTP) também abre janela nova: nunca fica preso numa janela "do futuro".
    if (agoraMs - this.inicio >= this.janelaMs || agoraMs < this.inicio) {
      this.inicio = agoraMs;
      this.contagem.clear();
    }
    const n = this.contagem.get(chave);
    if ((n === undefined && this.contagem.size >= this.chavesMax) || (n ?? 0) >= this.max) {
      return { ok: false, retryAfterSeg: Math.max(1, Math.ceil((this.inicio + this.janelaMs - agoraMs) / 1000)) };
    }
    this.contagem.set(chave, (n ?? 0) + 1);
    return { ok: true };
  }
}
