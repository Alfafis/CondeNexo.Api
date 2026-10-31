// Conferência OFFLINE da trilha exportada contra o arquivo de âncoras do GitHub (selos.jsonl do branch `ancoras`),
// spec §4.6. É a conferência com valor de prova: não pergunta nada ao servidor (que pode estar adulterado), só lê dois
// arquivos. Usa o MESMO código de verificação de cadeia do domain (verificarCadeia) e o mesmo leitor da exportação.
//
// Passos: (1) a exportação é coerente por dentro (cada hash recalculado a partir da âncora de início do manifesto);
// (2) cada dia ancorado cujo seq está na exportação (ou é a âncora de início) tem o MESMO hash nos dois arquivos.
// Uma cadeia reescrita e recalculada passa no passo 1 e cai no passo 2: o hash ancorado no GitHub em D é anterior à
// reescrita e o atacante não alcança o branch.
import { lerExportacaoJsonl } from '../dominio/exportacao';
import { verificarCadeia } from '../dominio/hashChain';

export interface DiaAncorado { data: string; seq: number; hash: string; totalDoDia: number }

export type ConclusaoAncoras = 'confere' | 'divergente' | 'trilha_invalida' | 'sem_ancora_no_intervalo';

export interface ResultadoAncoras {
  conclusao: ConclusaoAncoras;
  trilha: { valido: boolean; verificados: number; primeiroSeq: number | null; ultimoSeq: number | null; motivo?: string; primeiroSeqInvalido?: number };
  conferidas: Array<{ data: string; seq: number }>;
  divergentes: Array<{ data: string; seq: number; hashAncorado: string; hashNaTrilha: string }>;
  /** Dias ancorados cujo seq não está no intervalo exportado (exportar um período maior para conferi-los). */
  foraDoIntervalo: number;
}

const HASH = /^[0-9a-f]{64}$/;

/** Lê o selos.jsonl (uma linha JSON por dia ancorado). Linha fora do formato = erro: o arquivo é a prova. */
export function lerAncoras(conteudo: string): DiaAncorado[] {
  return conteudo.split('\n').filter((l) => l.trim()).map((l, i) => {
    let o: Record<string, unknown>;
    try { o = JSON.parse(l) as Record<string, unknown>; } catch { throw new Error(`selos.jsonl, linha ${i + 1}: não é JSON`); }
    const { data, seq, hash, totalDoDia } = o;
    if (typeof data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isSafeInteger(seq) || (seq as number) < 0
      || typeof hash !== 'string' || !HASH.test(hash) || !Number.isSafeInteger(totalDoDia)) {
      throw new Error(`selos.jsonl, linha ${i + 1}: fora do formato (data, seq, hash, totalDoDia)`);
    }
    return { data, seq: seq as number, hash, totalDoDia: totalDoDia as number };
  });
}

export async function conferirAncoras(exportacao: string, ancoras: string): Promise<ResultadoAncoras> {
  const { manifesto, eventos } = lerExportacaoJsonl(exportacao);
  if (manifesto.modo === 'evento_isolado' || manifesto.consecutivos === false) {
    throw new Error('a conferência com as âncoras exige a exportação da TRILHA, sem filtro (eventos consecutivos)');
  }
  const dias = lerAncoras(ancoras);
  const v = await verificarCadeia(eventos, manifesto.ancora);
  const seqs = eventos.map((e) => e.seq);
  const trilha = {
    valido: v.valido, verificados: v.verificados,
    primeiroSeq: seqs.length ? Math.min(...seqs) : null, ultimoSeq: seqs.length ? Math.max(...seqs) : null,
    ...(v.valido ? {} : { motivo: v.motivo, primeiroSeqInvalido: v.primeiroSeqInvalido }),
  };
  // Hash conhecido por seq: os eventos exportados e a âncora de início do manifesto (o evento anterior ao primeiro,
  // ou a gênese no seq 0).
  const hashDoSeq = new Map<number, string>(eventos.map((e) => [e.seq, e.hash]));
  hashDoSeq.set(manifesto.ancora.seq, manifesto.ancora.hash);
  const conferidas: ResultadoAncoras['conferidas'] = [];
  const divergentes: ResultadoAncoras['divergentes'] = [];
  let foraDoIntervalo = 0;
  for (const d of dias) {
    const h = hashDoSeq.get(d.seq);
    if (h === undefined) { foraDoIntervalo++; continue; }
    if (h === d.hash) conferidas.push({ data: d.data, seq: d.seq });
    else divergentes.push({ data: d.data, seq: d.seq, hashAncorado: d.hash, hashNaTrilha: h });
  }
  const conclusao: ConclusaoAncoras = divergentes.length ? 'divergente' : !v.valido ? 'trilha_invalida' : conferidas.length ? 'confere' : 'sem_ancora_no_intervalo';
  return { conclusao, trilha, conferidas, divergentes, foraDoIntervalo };
}
