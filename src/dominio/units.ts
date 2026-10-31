// Unidades (RF-01). A unidade tem id uuid; o código "A-32" é derivado de bloco e número e NÃO é chave.
// A lista real vem do banco (CRUD de unidades); aqui ficam a estrutura inicial do condomínio (seed, declarativa) e
// utilitários puros. O nome do agrupamento ("Bloco" ou "Torre") é configuração: muda só o rótulo, nunca o dado.
import type { Unidade } from './types';

export interface EstruturaUnidade { bloco: string; numero: string }

/** Como o condomínio chama o agrupamento de apartamentos. Muda o rótulo ("BLOCO A · AP 32"), não o código ("A-32"). */
export type Agrupamento = 'Bloco' | 'Torre';
export const AGRUPAMENTOS: readonly Agrupamento[] = ['Bloco', 'Torre'];
const FEMININO: Record<Agrupamento, boolean> = { Bloco: false, Torre: true };

/** Concordância nos textos da UI: "do bloco"/"da torre", "neste bloco"/"nesta torre", "O bloco"/"A torre". */
export const doAgrupamento = (a: Agrupamento) => `${FEMININO[a] ? 'da' : 'do'} ${a.toLowerCase()}`;
export const nesteAgrupamento = (a: Agrupamento) => `${FEMININO[a] ? 'nesta' : 'neste'} ${a.toLowerCase()}`;
export const oAgrupamento = (a: Agrupamento) => `${FEMININO[a] ? 'A' : 'O'} ${a.toLowerCase()}`;

/**
 * Estrutura inicial, declarativa (lida pelo seed da API). Número = andar * 10 + final, com 2 dígitos
 * ("03", "32"). `ausentes` tira da grade: "01" vale para todos os blocos; "A-01", só para aquele bloco.
 * Exceções que fogem da grade (cobertura, unidade desmembrada) entram pelo CRUD de unidades ou pela planilha.
 */
export interface ConfigEstrutura {
  agrupamento: Agrupamento;
  blocos: readonly string[];
  /** 0 = térreo; de 0 a 9 (o número tem 2 dígitos). */
  andares: readonly number[];
  /** Final do apartamento no andar, de 1 a 9. */
  finais: readonly number[];
  ausentes: readonly string[];
}

/** Condomínio do estudo de caso: 9 blocos (A a I), térreo e 4 andares, 4 apartamentos por andar. */
export const ESTRUTURA_PADRAO: ConfigEstrutura = {
  agrupamento: 'Bloco',
  blocos: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
  andares: [0, 1, 2, 3, 4],
  finais: [1, 2, 3, 4],
  // PROVISÓRIO (falta o síndico confirmar): o térreo só teria 03 e 04. Se tiver 01 e 02, troque por [].
  ausentes: ['01', '02'],
};

/** Formato do bloco depois de normalizado (mesmo CHECK `unidade_bloco_ck` do banco). */
export const FORMATO_BLOCO = /^[A-Z0-9]{1,3}$/;
/** Número canônico: só dígitos, mínimo 2, sem zero à esquerda além do da casa da dezena ("03", "32", "101"). */
export const FORMATO_NUMERO = /^(0[1-9]|[1-9][0-9]{1,3})$/;

/** " a " -> "A". */
export const normalizarBloco = (b: string) => b.trim().toUpperCase();

/** "3" -> "03", "032" -> "32", "101" -> "101". Texto que não é só dígitos volta só sem espaços (a validação recusa). */
export function normalizarNumero(n: string): string {
  const t = n.trim();
  return /^[0-9]+$/.test(t) ? t.replace(/^0+(?=[0-9])/, '').padStart(2, '0') : t;
}

/** "A-32" */
export const codigoUnidade = (u: EstruturaUnidade) => `${u.bloco}-${u.numero}`;

/** "BLOCO A · AP 32" (ou "Bloco A · AP 32"). */
export function rotuloUnidade(u: EstruturaUnidade, agrupamento: Agrupamento, caixaAlta = true): string {
  const r = `${agrupamento} ${u.bloco} · AP ${u.numero}`;
  return caixaAlta ? r.toUpperCase() : r;
}

// Bloco e número com separador OBRIGATÓRIO ("A-32", "a 32", "A/32", "4.32", "Bloco A · AP 32"): sem separador,
// "432" seria 4-32 ou 43-2, e "A32" seria A-32 ou A3-2. Prefixo "Bloco"/"Torre" e "AP" opcionais (colar o rótulo).
const CODIGO = /^(?:(?:bloco|torre)\s+)?([a-z0-9]{1,3})(?:\s*[-./·]\s*|\s+)(?:ap(?:to)?\.?\s*)?([0-9]{1,4})$/i;

/**
 * Leituras possíveis de um código digitado, da mais literal para a de compatibilidade (sem checar existência):
 * "A-32" -> [A-32]; "T4-32" -> [T4-32, 4-32] (o "T" do código antigo de torre, se não houver bloco "T4").
 */
export function leiturasDoCodigo(texto: string): EstruturaUnidade[] {
  const m = CODIGO.exec(texto.trim());
  if (!m) return [];
  const bloco = normalizarBloco(m[1]!);
  const numero = normalizarNumero(m[2]!);
  if (!FORMATO_NUMERO.test(numero)) return [];
  const legado = /^T([0-9]{1,2})$/.exec(bloco);
  return legado ? [{ bloco, numero }, { bloco: legado[1]!, numero }] : [{ bloco, numero }];
}

/**
 * Célula de bloco da planilha de importação: "A", "bloco a", "Torre 4", "4" e o antigo "T4" -> blocos possíveis,
 * normalizados, o literal primeiro ("T4" -> ["T4", "4"]).
 */
export function leiturasDoBloco(celula: string): string[] {
  const b = normalizarBloco(celula.replace(/^\s*(?:bloco|torre)\b\s*/i, ''));
  const legado = /^T([0-9]{1,2})$/.exec(b);
  return legado ? [b, legado[1]!] : [b];
}

/** Primeira leitura de `leiturasDoCodigo` ({ bloco, numero } normalizados), ou null. */
export const parseCodigoUnidade = (texto: string): EstruturaUnidade | null => leiturasDoCodigo(texto)[0] ?? null;

/** Procura a unidade de um texto livre ("A-32", "a 32") numa lista vinda do banco. */
export function acharUnidadePorTexto<U extends EstruturaUnidade>(unidades: readonly U[], texto: string): U | undefined {
  for (const p of leiturasDoCodigo(texto)) {
    const u = unidades.find((x) => x.bloco === p.bloco && x.numero === p.numero);
    if (u) return u;
  }
  return undefined;
}

/** Andar do apartamento: "32" -> 3; "03" -> 0 (térreo); "101" -> 1 (três ou mais dígitos: tudo menos os dois últimos). */
export const andarDoNumero = (n: string) => Number(n.length <= 2 ? n[0] : n.slice(0, -2));

/**
 * Mesmas regras dos CHECKs de `unidade`, sobre os valores JÁ normalizados (`normalizarBloco`/`normalizarNumero`).
 * O banco aceita também "00" (para não quebrar dado antigo na migração); o cadastro novo, não.
 */
export function validarEstruturaUnidade(bloco: string, numero: string, agrupamento: Agrupamento = 'Bloco'): string | null {
  if (!FORMATO_BLOCO.test(bloco)) return `${oAgrupamento(agrupamento)} deve ter de 1 a 3 letras ou dígitos (ex.: A, 4, B2).`;
  if (!FORMATO_NUMERO.test(numero)) return 'O número do apartamento deve ter só dígitos (até 4) e ser maior que zero.';
  return null;
}

/**
 * Chave de ordenação natural do bloco: cada sequência de dígitos com 3 casas ("2" -> "002", "B10" -> "B010"), comparada
 * por código de caractere. Assim "2" vem antes de "10", "A" antes de "B", "B2" antes de "B10", e dígitos antes de letras.
 * A API ordena no SQL com a mesma chave (`chaveBlocoSql`, COLLATE "C").
 */
export const chaveBloco = (b: string) => b.replace(/[0-9]+/g, (d) => d.padStart(3, '0'));

const comparar = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Ordena por bloco (natural) e número (numérico). */
export const compararUnidades = (a: EstruturaUnidade, b: EstruturaUnidade) =>
  comparar(chaveBloco(a.bloco), chaveBloco(b.bloco)) || Number(a.numero) - Number(b.numero) || comparar(a.numero, b.numero);

/** Ordena só os blocos (botões do seletor). */
export const compararBlocos = (a: string, b: string) => comparar(chaveBloco(a), chaveBloco(b));

/**
 * Estrutura inicial a partir da configuração, em ordem. Configuração incoerente (bloco fora do formato, andar ou final
 * fora da faixa, ausente que não existe na grade) é erro: um "ausente" digitado errado não pode sumir em silêncio.
 */
export function gerarUnidades(c: ConfigEstrutura = ESTRUTURA_PADRAO): EstruturaUnidade[] {
  const blocos = c.blocos.map(normalizarBloco);
  const ruim = blocos.find((b) => !FORMATO_BLOCO.test(b));
  if (ruim !== undefined) throw new Error(`estrutura: bloco "${ruim}" fora do formato (1 a 3 letras ou dígitos)`);
  if (new Set(blocos).size !== blocos.length) throw new Error('estrutura: bloco repetido');
  if (!c.andares.every((a) => Number.isInteger(a) && a >= 0 && a <= 9)) throw new Error('estrutura: andar deve ser inteiro de 0 a 9');
  if (!c.finais.every((f) => Number.isInteger(f) && f >= 1 && f <= 9)) throw new Error('estrutura: final deve ser inteiro de 1 a 9');
  if (!AGRUPAMENTOS.includes(c.agrupamento)) throw new Error(`estrutura: agrupamento deve ser ${AGRUPAMENTOS.join(' ou ')}`);

  const grade: EstruturaUnidade[] = [];
  for (const bloco of blocos) {
    for (const andar of c.andares) for (const final of c.finais) grade.push({ bloco, numero: String(andar * 10 + final).padStart(2, '0') });
  }
  const fora = new Set<string>();
  for (const a of c.ausentes) {
    const [b, n] = a.includes('-') ? a.split('-') : [null, a];
    const numero = normalizarNumero(n ?? '');
    const alvos = grade.filter((u) => u.numero === numero && (b === null || u.bloco === normalizarBloco(b)));
    if (!alvos.length) throw new Error(`estrutura: ausente "${a}" não existe na grade`);
    for (const u of alvos) fora.add(codigoUnidade(u));
  }
  const out = grade.filter((u) => !fora.has(codigoUnidade(u)));
  if (new Set(out.map(codigoUnidade)).size !== out.length) throw new Error('estrutura: unidade repetida');
  return out.sort(compararUnidades);
}

/** Áreas comuns iniciais (RF-36), semeadas no banco. */
export const AREAS_COMUNS_INICIAIS = [
  'Salão de festas', 'Piscina', 'Quadra', 'Academia', 'Administração', 'Casa de máquinas', 'Jardins',
] as const;

/** Ponto de acesso único do MVP. */
export const PORTARIA_SOCIAL = 'Portaria social';

export type { Unidade };

// ----- Lista explícita de unidades (criação de condomínio pelo Master: lista colada ou planilha) ---------------------

/** Máximo de unidades na criação de um condomínio (lista, planilha ou JSON da CLI). */
export const LIMITE_UNIDADES = 5000;

/**
 * Uma unidade por linha: BLOCO e NÚMERO separados por hífen, espaço, barra, ponto, vírgula, ponto e vírgula ou tabulação
 * (a célula colada do Excel). Prefixo "Bloco"/"Torre" e "Ap"/"Apto" opcionais; maiúsculas e minúsculas tanto faz.
 * Exemplos aceitos: "A-101", "a 101", "B/12", "Bloco A 101", "Torre 2 - 34", "A;101", "Bloco A · AP 32".
 */
const LINHA_UNIDADE = /^(?:(?:bloco|torre)\s+)?([a-z0-9]+)\s*(?:[-/.·;,|\t]\s*|\s+)(?:(?:ap|apto|apartamento|unidade)\.?\s*)?([0-9]+)$/i;

export type SituacaoLinhaUnidade = 'ok' | 'invalida' | 'duplicada';

export interface LinhaListaUnidades {
  /** Número da linha no texto de origem (1 = primeira; linhas em branco contam, para bater com o que se vê). */
  linha: number;
  texto: string;
  situacao: SituacaoLinhaUnidade;
  /** Normalizada (`ok` e `duplicada`). */
  unidade: EstruturaUnidade | null;
  motivo: string | null;
}

export interface ResultadoListaUnidades {
  /** Linhas não vazias, na ordem do texto. */
  linhas: LinhaListaUnidades[];
  /** Unidades válidas e únicas, ordenadas (bloco natural, número). */
  unidades: EstruturaUnidade[];
  invalidas: number;
  duplicadas: number;
  /** Mais unidades válidas que LIMITE_UNIDADES. */
  acimaDoLimite: boolean;
}

/** Uma linha -> unidade normalizada, ou o motivo da recusa (texto para a tela). */
export function lerLinhaUnidade(texto: string, agrupamento: Agrupamento = 'Bloco'): { unidade: EstruturaUnidade } | { motivo: string } {
  const t = texto.trim().replace(/[–—]/g, '-');
  const falta = `Falta ${agrupamento === 'Torre' ? 'a torre' : 'o bloco'} (ex.: A-101).`;
  const m = LINHA_UNIDADE.exec(t);
  if (!m) {
    if (/^(?:(?:bloco|torre)\s*)?[0-9]+$/i.test(t)) return { motivo: falta };
    if (/^[a-z]+$/i.test(t)) return { motivo: 'Falta o número do apartamento (ex.: A-101).' };
    if (/^[a-z0-9]+$/i.test(t)) return { motivo: 'Separe o bloco do número com hífen ou espaço (ex.: A-101).' };
    return { motivo: 'Formato não reconhecido. Use BLOCO-NÚMERO (ex.: A-101).' };
  }
  const bloco = normalizarBloco(m[1]!);
  if (bloco === 'BLOCO' || bloco === 'TORRE') return { motivo: falta };
  const numero = normalizarNumero(m[2]!);
  const erro = validarEstruturaUnidade(bloco, numero, agrupamento);
  return erro ? { motivo: erro } : { unidade: { bloco, numero } };
}

/** Lê a lista colada (uma unidade por linha): valida cada linha, marca as repetidas e devolve as válidas, ordenadas. */
export function lerListaUnidades(texto: string, agrupamento: Agrupamento = 'Bloco'): ResultadoListaUnidades {
  const linhas: LinhaListaUnidades[] = [];
  const vistas = new Map<string, number>();
  texto.replace(/^﻿/, '').split(/\r?\n/).forEach((bruta, i) => {
    const t = bruta.trim();
    if (!t) return;
    const r = lerLinhaUnidade(t, agrupamento);
    if ('motivo' in r) { linhas.push({ linha: i + 1, texto: t, situacao: 'invalida', unidade: null, motivo: r.motivo }); return; }
    const chave = codigoUnidade(r.unidade);
    const antes = vistas.get(chave);
    if (antes !== undefined) {
      linhas.push({ linha: i + 1, texto: t, situacao: 'duplicada', unidade: r.unidade, motivo: `Repetida: ${chave} já está na linha ${antes}.` });
      return;
    }
    vistas.set(chave, i + 1);
    linhas.push({ linha: i + 1, texto: t, situacao: 'ok', unidade: r.unidade, motivo: null });
  });
  const unidades = linhas.filter((l) => l.situacao === 'ok').map((l) => l.unidade!).sort(compararUnidades);
  return {
    linhas, unidades,
    invalidas: linhas.filter((l) => l.situacao === 'invalida').length,
    duplicadas: linhas.filter((l) => l.situacao === 'duplicada').length,
    acimaDoLimite: unidades.length > LIMITE_UNIDADES,
  };
}

/** Unidades agrupadas por bloco, na ordem natural dos blocos (prévia e revisão). */
export function agruparPorBloco(unidades: readonly EstruturaUnidade[]): { bloco: string; unidades: EstruturaUnidade[] }[] {
  const m = new Map<string, EstruturaUnidade[]>();
  for (const u of [...unidades].sort(compararUnidades)) {
    const l = m.get(u.bloco) ?? [];
    l.push(u);
    m.set(u.bloco, l);
  }
  return [...m.entries()].map(([bloco, us]) => ({ bloco, unidades: us }));
}

/** Divide uma linha de CSV respeitando aspas. */
function dividirCsv(linha: string, sep: string): string[] {
  const out: string[] = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]!;
    if (c === '"') { if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else aspas = !aspas; } else if (c === sep && !aspas) { out.push(atual); atual = ''; } else atual += c;
  }
  out.push(atual);
  return out.map((s) => s.trim());
}

/** CSV (UTF-8, separador ";", "," ou tabulação, detectado na primeira linha) -> matriz de células. */
export function matrizDeCsv(texto: string): string[][] {
  const brutas = texto.replace(/^﻿/, '').split(/\r?\n/);
  const primeira = brutas.find((l) => l.trim()) ?? '';
  const conta = (c: string) => primeira.split(c).length - 1;
  const sep = [';', '\t', ','].reduce((a, b) => (conta(b) > conta(a) ? b : a));
  return brutas.map((l) => (l.trim() ? dividirCsv(l, sep) : []));
}

const semAcentoMin = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const ALIAS_BLOCO = ['bloco', 'torre', 'predio'];
const ALIAS_NUMERO = ['unidade', 'numero', 'apto', 'apartamento', 'ap', 'unidades'];

/**
 * Planilha (CSV ou .xlsx, já em matriz de texto) -> linhas no formato da lista colada, UMA POR LINHA DA PLANILHA: o
 * cabeçalho e as linhas vazias viram linha em branco, para "linha N" da prévia bater com a linha N do arquivo.
 * Aceita uma coluna ("A-101") ou duas (bloco e número). Cabeçalho opcional: se a primeira linha preenchida não tem
 * dígito, é cabeçalho; com "Bloco"/"Torre" e "Unidade"/"Apto"/"Número", as colunas são achadas pelo nome (em qualquer
 * ordem). Sem cabeçalho reconhecido: as duas primeiras células preenchidas, nessa ordem (bloco, número).
 */
export function linhasDePlanilha(matriz: readonly (readonly string[])[]): string[] {
  const linhas = matriz.map((l) => l.map((c) => (c ?? '').trim()));
  const iCab = linhas.findIndex((l) => l.some(Boolean));
  if (iCab < 0) return [];
  let iBloco = -1;
  let iNumero = -1;
  let cabecalho = -1;
  if (!linhas[iCab]!.some((c) => /[0-9]/.test(c))) {
    cabecalho = iCab;
    const nomes = linhas[iCab]!.map(semAcentoMin);
    iBloco = nomes.findIndex((n) => ALIAS_BLOCO.includes(n));
    iNumero = nomes.findIndex((n) => ALIAS_NUMERO.includes(n));
  }
  const saida = linhas.map((l, i) => {
    if (i === cabecalho || !l.some(Boolean)) return '';
    if (iBloco >= 0 && iNumero >= 0) return `${l[iBloco] ?? ''} ${l[iNumero] ?? ''}`.trim();
    if (iNumero >= 0) return l[iNumero] ?? '';
    return l.filter(Boolean).slice(0, 2).join(' ');
  });
  while (saida.length && !saida[saida.length - 1]) saida.pop();
  return saida;
}
