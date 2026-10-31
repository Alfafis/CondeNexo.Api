// Exportação verificável da trilha de acessos (RF-32, spec §4.7): JSONL com manifesto (versão 3), uma linha por evento no
// formato canônico (o mesmo que entra no hash) e um resumo. FONTE ÚNICA do formato: usada pelo front (verificador) e pela
// API (src/auditoria). Os nomes vão à parte, em "exibicao", e não entram no hash.
// Manifesto v3 (0013): o evento pode estar no formato de hash 1 (sem veículo) ou 2 (entrada com veículo, `camposVeiculo`
// no fim). Saíram `formatoHash` (um só) e entrou `formatosHash` (os que o arquivo pode ter); `ordemCampos` segue sendo a
// ordem da v1. O nome do formato (`portaria-parque/trilha-jsonl`) não muda.
import { CAMPOS_CANONICOS_V1, CAMPOS_VEICULO_V2, CHAVES_CORRECAO_V1, FORMATOS_HASH, codigoEvento, hashGenese, type EventoExportado } from './hashChain';

/** Nomes resolvidos de um evento, só para leitura humana (fora do hash). */
export interface ExibicaoEvento {
  codigo: string;
  pessoa: string | null;
  unidade: string | null;
  areaComum: string | null;
  operador: string | null;
}

export interface EntradaExportacao {
  /** Eventos no formato canônico, em qualquer ordem (são ordenados por seq aqui). */
  eventos: readonly EventoExportado[];
  exibicao: (e: EventoExportado) => Omit<ExibicaoEvento, 'codigo'>;
  /** Filtros aplicados (vão para o manifesto como informados; sem texto livre que identifique alguém). */
  filtros: Record<string, unknown>;
  /** Exportação de um único evento (RF-32: evento isolado). */
  isolado: boolean;
  geradoPor: string;
  /** Nome do condomínio da sessão (vai só no manifesto, fora do hash). */
  condominio?: string | null;
  /** Instante de geração já formatado. */
  geradoEm: string;
  /** Carimbo AAAAMMDD-HHMM (horário de São Paulo) para o nome do arquivo. */
  carimbo: string;
  observacao: string;
}

export interface PacoteJsonl { nomeArquivo: string; conteudo: string; quantidade: number }

export const ALGORITMO_EXPORTACAO = 'hash = hex(SHA-256(UTF-8(hash_anterior + canonico))). canonico = JSON compacto (sem espaços) de {"v":<v do evento>, ...campos na ordem de ordemCampos} e, se v = 2, em seguida os campos de camposVeiculo (nessa ordem), com null explícito, instantes em ISO 8601 UTC com milissegundos (Date.toISOString) e correcao_valores como objeto só com as chaves presentes, na ordem de chavesCorrecao. v = 1: evento sem veículo; v = 2: entrada com veículo (placa obrigatória). É a mesma serialização do banco (evento_acesso_canonico).';

const INSTRUCOES_ISOLADO = [
  '1. Monte o JSON canônico da linha de tipo "evento" (campo "evento", sem hash_anterior e hash, na ordem de ordemCampos e, se v = 2, de camposVeiculo), calcule SHA-256(hash_anterior + canonico) e compare com "hash": isto confere que o conteúdo deste evento não foi alterado.',
  '2. A verificação de um único evento confere apenas o hash dele. Ela não prova, sozinha, que o evento pertence à cadeia nem que nada foi removido antes ou depois.',
  '3. A ligação com a cadeia se confere pelo "hash_anterior": ele deve ser igual ao "hash" do evento de seq anterior na trilha completa (ou ao hashGenese, se for o seq 1), ou ser comparado com a âncora recebida por fonte externa independente.',
  'Qualquer divergência indica que o registro foi alterado depois de gravado.',
];
const INSTRUCOES_TRILHA = [
  '1. Para cada linha de tipo "evento", calcule SHA-256(hash_anterior + canonico) e compare com "hash".',
  '2. Para eventos consecutivos (seq, seq+1), confirme que "hash_anterior" do seguinte é igual ao "hash" do anterior; o primeiro deve ter hash_anterior igual a ancora.hash.',
  '3. Exportação filtrada (consecutivos = false) só permite conferir cada evento isoladamente (passo 1).',
  '4. Compare o hash dos eventos selados com a âncora guardada por fonte externa independente (selos.jsonl do branch ancoras no GitHub, ou o e-mail ao síndico/conselho; ver verificar-ancoras). Sem âncora externa o arquivo prova apenas consistência interna.',
  'Qualquer divergência indica que o registro (ou um anterior) foi alterado depois de gravado.',
];

/** Monta o arquivo JSONL (manifesto v3 + eventos + resumo). */
export async function montarExportacaoJsonl(i: EntradaExportacao): Promise<PacoteJsonl> {
  const evs = [...i.eventos].sort((a, b) => a.seq - b.seq);
  const g = await hashGenese();
  const primeiro = evs[0];
  // Âncora de início: seq e hash do evento imediatamente anterior ao primeiro exportado (gênese se for o seq 1)
  const ancora = primeiro ? { seq: primeiro.seq - 1, hash: primeiro.hash_anterior } : { seq: 0, hash: g };
  const consecutivos = evs.every((e, k) => k === 0 || e.seq === evs[k - 1].seq + 1);
  const manifesto = {
    tipo: 'manifesto', formato: 'portaria-parque/trilha-jsonl', versao: 3, formatosHash: [...FORMATOS_HASH], sistema: 'CondNexo',
    condominio: i.condominio ?? null, geradoPor: i.geradoPor, geradoEm: i.geradoEm,
    quantidade: evs.length, filtros: i.filtros, modo: i.isolado ? 'evento_isolado' : 'trilha', consecutivos,
    algoritmo: ALGORITMO_EXPORTACAO,
    ordemCampos: ['v', ...CAMPOS_CANONICOS_V1], camposVeiculo: CAMPOS_VEICULO_V2, chavesCorrecao: CHAVES_CORRECAO_V1,
    hashGenese: g, genese: 'SHA-256 da string "genesis"', ancora,
    instrucoesVerificacao: i.isolado ? INSTRUCOES_ISOLADO : INSTRUCOES_TRILHA,
    observacao: i.observacao,
  };
  const linhas = [JSON.stringify(manifesto)];
  for (const e of evs) {
    linhas.push(JSON.stringify({ tipo: 'evento', seq: e.seq, evento: e, exibicao: { codigo: codigoEvento(e.seq), ...i.exibicao(e) } }));
  }
  const ultimo = evs[evs.length - 1];
  linhas.push(JSON.stringify({ tipo: 'resumo', quantidade: evs.length, ultimoSeq: ultimo?.seq ?? null, ultimoHash: ultimo?.hash ?? null }));
  const nomeArquivo = i.isolado && evs[0] ? `evento-${codigoEvento(evs[0].seq)}-${i.carimbo}.jsonl` : `trilha-condnexo-${i.carimbo}.jsonl`;
  return { nomeArquivo, conteudo: linhas.join('\n') + '\n', quantidade: evs.length };
}

/** Lê um JSONL exportado e devolve manifesto, eventos e resumo (para o verificador e os testes). */
export function lerExportacaoJsonl(conteudo: string): {
  manifesto: Record<string, unknown> & { ancora: { seq: number; hash: string } };
  eventos: EventoExportado[];
  resumo: Record<string, unknown>;
} {
  const linhas = conteudo.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const manifesto = linhas.find((l) => l.tipo === 'manifesto') as ReturnType<typeof lerExportacaoJsonl>['manifesto'] | undefined;
  const resumo = linhas.find((l) => l.tipo === 'resumo');
  if (!manifesto || !resumo) throw new Error('arquivo sem manifesto ou resumo');
  return { manifesto, eventos: linhas.filter((l) => l.tipo === 'evento').map((l) => l.evento as EventoExportado), resumo };
}
