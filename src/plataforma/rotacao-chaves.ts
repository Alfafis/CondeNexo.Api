// Rotação das chaves do envelope (docs/05_arquitetura_saas.md SAAS-04, "Rotação"; passo a passo de produção em
// docs/deploy-rotacao-chaves.md). CLI em src/cli/rotacionar-chaves.ts. Três operações e uma inspeção:
//
// - inspeção (dry-run): desembrulha TODAS as linhas de `condominio_chave` com a mestra do ambiente e confere a DEK de
//   cada anexo de cada condomínio com a KEK da versão gravada nele. Não escreve nada.
// - mestra: re-embrulha cada linha de `condominio_chave` (mesma identidade, mesma AAD, nonce novo) com a mestra nova, numa
//   transação só, com a tabela travada contra escrita; antes do COMMIT re-lê e desembrulha tudo com a nova e compara com
//   o claro original. Qualquer divergência: ROLLBACK. O trigger `condominio_chave_imutavel` (0000) só aceita embrulho
//   novo com `mestra_versao` MAIOR, e o UPDATE dessas colunas só o dono (app_migrator) tem.
// - KEK, passo 1 (`prepararKek`): KEK nova (32 bytes do CSPRNG) como versão+1 ATIVA e a anterior inativa, na mesma
//   transação (o índice `condominio_chave_ativa_uq` não permite duas ativas). Inativa NÃO é descartada: continua
//   registrada e a API (tenancy/resolvedor.ts) a carrega para ler os anexos que ainda estão nela.
// - KEK, passo 2 (`migrarDocumentos`): re-embrulha a DEK de cada anexo para a KEK ativa, em lotes (uma transação por
//   lote, no banco do condomínio, com ida e volta antes do COMMIT). O arquivo cifrado não muda. Queda entre lotes:
//   o que já foi está na versão nova, o resto na anterior, e as duas são legíveis; rodar de novo continua.
//
// Nada aqui imprime, loga ou devolve chave (nem em hex/base64): os resultados levam contagens, tipos, versões e o id/código
// do condomínio. Os buffers em claro são zerados ao fim de cada operação.
import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../database/database.module';
import { documento } from '../db/schema';
import { abrirDek, embrulharDek } from '../documentos/cofre';
import { type ChaveMestra, desembrulhar, embrulhar, type IdChave, mesmaChave } from './chave-mestra';
import type { DbPlataforma } from './registrar-piloto';
import * as sp from './schema-plataforma';

export class ErroRotacao extends Error {}

/** Status em que o condomínio tem banco com dados (os mesmos que o Master lê; `provisionando` e `excluido` ficam fora). */
export const STATUS_COM_BANCO = ['ativo', 'suspenso', 'encerrado'] as const;
/** Lote padrão da migração das DEKs: cada lote é uma transação curta no banco do condomínio. */
export const LOTE_PADRAO = 200;
const VERSAO_MAX = 32767;

type LinhaChave = typeof sp.condominioChave.$inferSelect;
type LinhaCondominio = Pick<typeof sp.condominio.$inferSelect, 'id' | 'codigo' | 'banco' | 'status'>;

const idDe = (l: LinhaChave): IdChave => ({ condominioId: l.condominioId, tipo: l.tipo as sp.TipoChave, versao: l.versao });
const zerar = (bs: Iterable<Buffer>) => { for (const b of bs) b.fill(0); };

function contarPor<T>(xs: T[], chave: (x: T) => string | number): Record<string, number> {
  const r: Record<string, number> = {};
  for (const x of xs) { const k = String(chave(x)); r[k] = (r[k] ?? 0) + 1; }
  return r;
}

/** Mestra nova coerente com a atual: versão maior (o trigger exige) e valor diferente. Mensagem sem valor. */
export function validarMestraNova(atual: ChaveMestra, nova: ChaveMestra): void {
  if (nova.versao <= atual.versao) {
    throw new ErroRotacao(`PORTARIA_CHAVE_MESTRA_VERSAO_NOVA (${nova.versao}) precisa ser maior que PORTARIA_CHAVE_MESTRA_VERSAO (${atual.versao})`);
  }
  if (mesmaChave(atual.chave, nova.chave)) throw new ErroRotacao('PORTARIA_CHAVE_MESTRA_NOVA é igual à PORTARIA_CHAVE_MESTRA: gere uma chave nova');
}

/** Situação das linhas de `condominio_chave` frente à mestra atual e à nova. */
export type SituacaoMestra = 'a_rotacionar' | 'ja_rotacionada' | 'estado_misto';

function situacaoMestra(linhas: LinhaChave[], atual: number, nova: number): SituacaoMestra {
  if (linhas.every((l) => l.mestraVersao === atual)) return 'a_rotacionar';
  if (linhas.every((l) => l.mestraVersao === nova)) return 'ja_rotacionada';
  return 'estado_misto';
}

const descreverVersoes = (linhas: LinhaChave[]) =>
  Object.entries(contarPor(linhas, (l) => l.mestraVersao)).map(([v, n]) => `v${v}: ${n}`).join(', ');

// ------------------------------------------------------------------------------------------------------------------
// Inspeção (dry-run)
// ------------------------------------------------------------------------------------------------------------------

export interface ResumoChave { tipo: sp.TipoChave; versao: number; ativa: boolean; mestraVersao: number; abre: boolean }
export interface ResumoDocumentos { total: number; porVersao: Record<string, number>; semChave: number; naoAbrem: number }
export interface ResumoCondominio {
  condominioId: string;
  codigo: string;
  status: string;
  chaves: ResumoChave[];
  /** Ausente quando o banco do condomínio não foi lido (status sem banco, ou KEK que não desembrulha). */
  documentos?: ResumoDocumentos;
}
export interface RelatorioInspecao {
  mestraVersao: number;
  linhas: number;
  porMestraVersao: Record<string, number>;
  porTipoVersao: Record<string, number>;
  linhasQueNaoAbrem: number;
  condominios: ResumoCondominio[];
  /** Só se a mestra nova estiver no ambiente: o que a rotação faria. */
  mestraNova?: { versao: number; situacao: SituacaoMestra; linhasAReembrulhar: number };
  /** Total de problemas (linha que não abre + anexo sem chave + anexo cuja DEK não abre). 0 = pronto. */
  falhas: number;
}

/** KEKs do condomínio, desembrulhadas, por versão (todas, ativa e anteriores). Lança se alguma não abrir. */
function keksDe(mestra: ChaveMestra, linhas: LinhaChave[]): { keks: Map<number, Buffer>; ativa: number } {
  const keks = new Map<number, Buffer>();
  let ativa: number | null = null;
  try {
    for (const l of linhas) {
      if (l.tipo !== 'kek_documentos') continue;
      const k = desembrulhar(mestra, idDe(l), l);
      keks.set(l.versao, k);
      if (k.length !== 32) throw new ErroRotacao(`KEK v${l.versao} com tamanho diferente de 32 bytes`);
      if (l.ativa) ativa = l.versao;
    }
    if (ativa === null) throw new ErroRotacao('condomínio sem KEK ativa');
  } catch (e) {
    zerar(keks.values());
    throw e;
  }
  return { keks, ativa };
}

/** Confere cada anexo (todos, em páginas por id): a versão tem KEK registrada e a DEK abre com ela. Só lê. */
export async function inspecionarDocumentos(db: Db, keks: ReadonlyMap<number, Buffer>, pagina = 500): Promise<ResumoDocumentos> {
  const r: ResumoDocumentos = { total: 0, porVersao: {}, semChave: 0, naoAbrem: 0 };
  let ultimo: string | null = null;
  for (;;) {
    const docs: { id: string; dekCifrada: Uint8Array; chaveVersao: number }[] = await db
      .select({ id: documento.id, dekCifrada: documento.dekCifrada, chaveVersao: documento.chaveVersao }).from(documento)
      .where(ultimo ? gt(documento.id, ultimo) : undefined).orderBy(asc(documento.id)).limit(pagina);
    if (!docs.length) return r;
    for (const d of docs) {
      r.total++;
      r.porVersao[d.chaveVersao] = (r.porVersao[d.chaveVersao] ?? 0) + 1;
      const kek = keks.get(d.chaveVersao);
      if (!kek) { r.semChave++; continue; }
      try { abrirDek(kek, d).fill(0); } catch { r.naoAbrem++; }
    }
    ultimo = docs[docs.length - 1]!.id;
  }
}

/**
 * Dry-run: desembrulha todas as linhas com a mestra atual e, para cada condomínio com banco, confere os anexos.
 * `bancoDe` abre o banco do condomínio (só leitura é usada). Não escreve em nenhum dos bancos.
 */
export async function inspecionar(
  plataforma: DbPlataforma, mestra: ChaveMestra, bancoDe: ((banco: string) => Db) | null, nova?: ChaveMestra | null,
): Promise<RelatorioInspecao> {
  const condominios: LinhaCondominio[] = await plataforma.select({ id: sp.condominio.id, codigo: sp.condominio.codigo, banco: sp.condominio.banco, status: sp.condominio.status })
    .from(sp.condominio).orderBy(asc(sp.condominio.codigo));
  const linhas = await plataforma.select().from(sp.condominioChave)
    .orderBy(asc(sp.condominioChave.condominioId), asc(sp.condominioChave.tipo), asc(sp.condominioChave.versao));
  let linhasQueNaoAbrem = 0;
  let falhasDocs = 0;
  const saida: ResumoCondominio[] = [];
  for (const c of condominios) {
    const minhas = linhas.filter((l) => l.condominioId === c.id);
    const chaves: ResumoChave[] = minhas.map((l) => {
      let abre = false;
      try { desembrulhar(mestra, idDe(l), l).fill(0); abre = true; } catch { linhasQueNaoAbrem++; }
      return { tipo: l.tipo as sp.TipoChave, versao: l.versao, ativa: l.ativa, mestraVersao: l.mestraVersao, abre };
    });
    const resumo: ResumoCondominio = { condominioId: c.id, codigo: c.codigo, status: c.status, chaves };
    if (bancoDe && (STATUS_COM_BANCO as readonly string[]).includes(c.status) && chaves.every((k) => k.abre)) {
      let keks: Map<number, Buffer>;
      try { ({ keks } = keksDe(mestra, minhas)); } catch (e) {
        throw new ErroRotacao(`condomínio ${c.codigo}: ${e instanceof Error ? e.message : 'KEK inválida'}`);
      }
      try {
        resumo.documentos = await inspecionarDocumentos(bancoDe(c.banco), keks);
        falhasDocs += resumo.documentos.semChave + resumo.documentos.naoAbrem;
      } finally {
        zerar(keks.values());
      }
    }
    saida.push(resumo);
  }
  const rel: RelatorioInspecao = {
    mestraVersao: mestra.versao,
    linhas: linhas.length,
    porMestraVersao: contarPor(linhas, (l) => l.mestraVersao),
    porTipoVersao: contarPor(linhas, (l) => `${l.tipo}:v${l.versao}${l.ativa ? ':ativa' : ''}`),
    linhasQueNaoAbrem,
    condominios: saida,
    falhas: linhasQueNaoAbrem + falhasDocs,
  };
  if (nova) {
    validarMestraNova(mestra, nova);
    const situacao = situacaoMestra(linhas, mestra.versao, nova.versao);
    rel.mestraNova = { versao: nova.versao, situacao, linhasAReembrulhar: situacao === 'a_rotacionar' ? linhas.length : 0 };
  }
  return rel;
}

// ------------------------------------------------------------------------------------------------------------------
// Mestra
// ------------------------------------------------------------------------------------------------------------------

export interface ResultadoMestra {
  situacao: 'rotacionada' | 'ja_rotacionada';
  mestraVersaoAnterior: number;
  mestraVersao: number;
  linhas: number;
  porTipoVersao: Record<string, number>;
}

/** Ganchos de teste (falha injetada no meio). Produção não passa nada. */
export interface GanchosMestra { aposReembrulhar?: (indice: number) => void | Promise<void> }

/**
 * Re-embrulha TODAS as linhas de `condominio_chave` com a mestra nova, numa transação só. `db` tem de ser o dono das
 * tabelas (app_migrator): app_plataforma só tem UPDATE em `ativa`. Idempotente: tudo já na nova (e abrindo com ela) =
 * `ja_rotacionada`, sem escrita. Estado misto (linhas em versões diferentes): recusa sem escrever.
 */
export async function rotacionarMestra(db: DbPlataforma, atual: ChaveMestra, nova: ChaveMestra, ganchos: GanchosMestra = {}): Promise<ResultadoMestra> {
  validarMestraNova(atual, nova);
  return db.transaction(async (tx) => {
    // Sem escrita concorrente (provisionamento, outra rotação) até o COMMIT; a leitura da API segue.
    await tx.execute(sql`LOCK TABLE condominio_chave IN SHARE ROW EXCLUSIVE MODE`);
    const linhas = await tx.select().from(sp.condominioChave)
      .orderBy(asc(sp.condominioChave.condominioId), asc(sp.condominioChave.tipo), asc(sp.condominioChave.versao));
    if (!linhas.length) throw new ErroRotacao('condominio_chave vazia: banco errado? nada foi alterado');
    const base = { mestraVersaoAnterior: atual.versao, mestraVersao: nova.versao, linhas: linhas.length, porTipoVersao: contarPor(linhas, (l) => `${l.tipo}:v${l.versao}`) };
    const situacao = situacaoMestra(linhas, atual.versao, nova.versao);
    if (situacao === 'estado_misto') {
      throw new ErroRotacao(`estado misto em condominio_chave (${descreverVersoes(linhas)}); esperado tudo na v${atual.versao} ou tudo na v${nova.versao}. Nada foi alterado: conferir à mão (docs/deploy-rotacao-chaves.md, "Estado misto")`);
    }
    if (situacao === 'ja_rotacionada') {
      // Prova de que a "nova" do ambiente é mesmo a que embrulhou (não basta o número da versão).
      for (const l of linhas) desembrulhar(nova, idDe(l), l).fill(0);
      return { situacao: 'ja_rotacionada' as const, ...base };
    }

    const claros: Buffer[] = [];
    try {
      for (const [i, l] of linhas.entries()) {
        const claro = desembrulhar(atual, idDe(l), l); // mestra atual errada: ErroChave e ROLLBACK
        claros.push(claro);
        const emb = embrulhar(nova, idDe(l), claro);
        const r = await tx.update(sp.condominioChave).set({ chaveCifrada: emb.chaveCifrada, nonce: emb.nonce, mestraVersao: emb.mestraVersao })
          .where(and(eq(sp.condominioChave.condominioId, l.condominioId), eq(sp.condominioChave.tipo, l.tipo), eq(sp.condominioChave.versao, l.versao),
            eq(sp.condominioChave.mestraVersao, atual.versao)))
          .returning({ versao: sp.condominioChave.versao });
        if (r.length !== 1) throw new ErroRotacao(`linha ${l.tipo} v${l.versao} do condomínio ${l.condominioId} mudou durante a rotação: nada foi alterado`);
        await ganchos.aposReembrulhar?.(i);
      }

      // Ida e volta antes do COMMIT: relê tudo, abre com a nova e compara com o claro original, linha a linha.
      const relidas = await tx.select().from(sp.condominioChave)
        .orderBy(asc(sp.condominioChave.condominioId), asc(sp.condominioChave.tipo), asc(sp.condominioChave.versao));
      if (relidas.length !== linhas.length) throw new ErroRotacao('número de linhas mudou durante a rotação: nada foi alterado');
      for (const [i, l] of relidas.entries()) {
        const o = linhas[i]!;
        if (l.condominioId !== o.condominioId || l.tipo !== o.tipo || l.versao !== o.versao || l.ativa !== o.ativa || l.mestraVersao !== nova.versao) {
          throw new ErroRotacao('verificação de ida e volta: identidade ou versão divergente; nada foi alterado');
        }
        const volta = desembrulhar(nova, idDe(l), l);
        try {
          if (!mesmaChave(volta, claros[i]!)) throw new ErroRotacao('verificação de ida e volta: chave divergente; nada foi alterado');
        } finally {
          volta.fill(0);
        }
      }
      await tx.insert(sp.plataformaAudit).values({
        acao: 'plataforma.mestraRotacionada',
        detalhes: { origem: 'cli', de: atual.versao, para: nova.versao, linhas: linhas.length },
      });
      return { situacao: 'rotacionada' as const, ...base };
    } finally {
      zerar(claros);
    }
  });
}

// ------------------------------------------------------------------------------------------------------------------
// KEK, passo 1: versão nova ativa
// ------------------------------------------------------------------------------------------------------------------

export interface ResultadoPrepararKek {
  situacao: 'preparada' | 'ja_preparada';
  condominioId: string;
  codigo: string;
  versaoAnterior: number;
  versaoAtiva: number;
  versoesRegistradas: number[];
}

async function condominioPorCodigo(db: Pick<DbPlataforma, 'select'>, codigo: string): Promise<LinhaCondominio> {
  const [c] = await db.select({ id: sp.condominio.id, codigo: sp.condominio.codigo, banco: sp.condominio.banco, status: sp.condominio.status })
    .from(sp.condominio).where(eq(sp.condominio.codigo, codigo));
  if (!c) throw new ErroRotacao(`condomínio ${codigo} não existe na plataforma`);
  if (!(STATUS_COM_BANCO as readonly string[]).includes(c.status)) throw new ErroRotacao(`condomínio ${codigo} está ${c.status}: rotação de KEK só em ${STATUS_COM_BANCO.join('/')}`);
  return c;
}

/**
 * Grava a KEK nova (versão máxima + 1) como ativa e desativa a `versaoAtual`, numa transação no banco `plataforma`
 * (app_plataforma basta: INSERT e UPDATE(ativa)). Idempotente pela versão esperada: se a ativa já é posterior e a
 * `versaoAtual` está registrada inativa, `ja_preparada` sem escrita (não gera uma terceira versão ao repetir).
 * `gerar` existe para o teste; produção usa o CSPRNG.
 */
export async function prepararKek(
  db: DbPlataforma, mestra: ChaveMestra, codigo: string, versaoAtual: number, gerar: () => Buffer = () => randomBytes(32),
): Promise<ResultadoPrepararKek> {
  return db.transaction(async (tx) => {
    const c = await condominioPorCodigo(tx, codigo);
    const linhas = await tx.select().from(sp.condominioChave).where(eq(sp.condominioChave.condominioId, c.id))
      .orderBy(asc(sp.condominioChave.tipo), asc(sp.condominioChave.versao)).for('update');
    const fora = linhas.filter((l) => l.mestraVersao !== mestra.versao);
    if (fora.length) {
      throw new ErroRotacao(`condomínio ${codigo}: ${fora.length} chave(s) embrulhada(s) com outra versão da mestra (${descreverVersoes(linhas)}; ambiente v${mestra.versao}). Conclua a rotação da mestra e atualize o .env antes`);
    }
    const hmac = linhas.find((l) => l.tipo === 'hmac_cpf' && l.ativa);
    if (!hmac) throw new ErroRotacao(`condomínio ${codigo} sem chave hmac_cpf ativa`);
    const { keks, ativa } = keksDe(mestra, linhas); // todas abrem com a mestra do ambiente, ou nada acontece
    const nova: Buffer[] = [];
    try {
      const hmacClaro = desembrulhar(mestra, idDe(hmac), hmac);
      nova.push(hmacClaro);
      const versoes = [...keks.keys()].sort((a, b) => a - b);
      const resultado = (situacao: ResultadoPrepararKek['situacao'], versaoAtiva: number, registradas: number[]) =>
        ({ situacao, condominioId: c.id, codigo: c.codigo, versaoAnterior: versaoAtual, versaoAtiva, versoesRegistradas: registradas });

      if (ativa !== versaoAtual) {
        if (ativa > versaoAtual && keks.has(versaoAtual)) return resultado('ja_preparada', ativa, versoes);
        throw new ErroRotacao(`condomínio ${codigo}: a KEK ativa é a v${ativa}, não a v${versaoAtual} informada em --kek-versao-atual. Nada foi alterado`);
      }
      const versaoNova = versoes[versoes.length - 1]! + 1;
      if (versaoNova > VERSAO_MAX) throw new ErroRotacao(`condomínio ${codigo}: versão da KEK passaria de ${VERSAO_MAX}`);
      const kek = gerar();
      nova.push(kek);
      if (kek.length !== 32) throw new ErroRotacao('KEK nova precisa ter 32 bytes');
      // Reuso entre finalidades anularia o envelope (mesma regra do registro do piloto).
      if ([...keks.values()].some((k) => mesmaChave(k, kek)) || mesmaChave(mestra.chave, kek) || mesmaChave(hmacClaro.subarray(0, 32), kek)) {
        throw new ErroRotacao('KEK nova coincide com uma chave existente: nada foi alterado');
      }

      // Primeiro desativa (índice parcial de ativa única), depois insere a nova ativa. Mesma transação: ninguém vê
      // o condomínio sem KEK ativa.
      const off = await tx.update(sp.condominioChave).set({ ativa: false })
        .where(and(eq(sp.condominioChave.condominioId, c.id), eq(sp.condominioChave.tipo, 'kek_documentos'), eq(sp.condominioChave.versao, versaoAtual), eq(sp.condominioChave.ativa, true)))
        .returning({ versao: sp.condominioChave.versao });
      if (off.length !== 1) throw new ErroRotacao(`condomínio ${codigo}: a KEK v${versaoAtual} deixou de ser a ativa durante a operação`);
      const id: IdChave = { condominioId: c.id, tipo: 'kek_documentos', versao: versaoNova };
      await tx.insert(sp.condominioChave).values({ ...id, ...embrulhar(mestra, id, kek), ativa: true });

      // Ida e volta antes do COMMIT.
      const [l] = await tx.select().from(sp.condominioChave)
        .where(and(eq(sp.condominioChave.condominioId, c.id), eq(sp.condominioChave.tipo, 'kek_documentos'), eq(sp.condominioChave.ativa, true)));
      if (!l || l.versao !== versaoNova) throw new ErroRotacao('verificação de ida e volta: KEK ativa divergente; nada foi alterado');
      const volta = desembrulhar(mestra, id, l);
      try {
        if (!mesmaChave(volta, kek)) throw new ErroRotacao('verificação de ida e volta: KEK divergente; nada foi alterado');
      } finally {
        volta.fill(0);
      }
      await tx.insert(sp.plataformaAudit).values({
        acao: 'condominio.kekRotacionada', condominioId: c.id,
        detalhes: { origem: 'cli', de: versaoAtual, para: versaoNova, mestraVersao: mestra.versao },
      });
      return resultado('preparada', versaoNova, [...versoes, versaoNova]);
    } finally {
      zerar(nova);
      zerar(keks.values());
    }
  });
}

// ------------------------------------------------------------------------------------------------------------------
// KEK, passo 2: DEKs dos anexos para a versão ativa
// ------------------------------------------------------------------------------------------------------------------

export interface ResultadoMigracao {
  situacao: 'migrada' | 'nada_a_migrar';
  condominioId: string;
  codigo: string;
  versaoAtiva: number;
  migrados: number;
  lotes: number;
  /** Anexos por versão depois da migração (tudo na ativa = concluída). */
  porVersao: Record<string, number>;
}

export interface GanchosMigracao {
  /** Depois do COMMIT de cada lote (progresso; o teste simula queda lançando aqui). */
  aposLote?: (lote: number, migradosAteAqui: number) => void | Promise<void>;
}

async function contarPorVersao(db: Db): Promise<Record<string, number>> {
  const linhas = await db.select({ versao: documento.chaveVersao, n: sql<number>`count(*)::int` }).from(documento).groupBy(documento.chaveVersao);
  return Object.fromEntries(linhas.map((l) => [String(l.versao), Number(l.n)]));
}

/**
 * Re-embrulha, em lotes, a DEK de todo anexo que não está na KEK ativa (inclusive anexo já eliminado: a linha continua e
 * fica coerente). Lê as KEKs da plataforma (app_plataforma, só leitura) e escreve no banco do condomínio (app_rw:
 * UPDATE em `documento`). Cada lote: SELECT ... FOR UPDATE, re-embrulho, UPDATE condicionado à versão lida, releitura e
 * comparação da DEK (ida e volta) e COMMIT. Reentrante: rodar de novo continua de onde parou.
 */
export async function migrarDocumentos(
  plataforma: DbPlataforma, bancoDe: (banco: string) => Db, mestra: ChaveMestra, codigo: string,
  opcoes: { lote?: number } & GanchosMigracao = {},
): Promise<ResultadoMigracao> {
  const lote = opcoes.lote ?? LOTE_PADRAO;
  if (!Number.isInteger(lote) || lote < 1 || lote > 5000) throw new ErroRotacao('--lote deve ser inteiro entre 1 e 5000');
  const c = await condominioPorCodigo(plataforma, codigo);
  const linhas = await plataforma.select().from(sp.condominioChave).where(eq(sp.condominioChave.condominioId, c.id));
  const { keks, ativa } = keksDe(mestra, linhas);
  const db = bancoDe(c.banco);
  let migrados = 0;
  let lotes = 0;
  try {
    const kekAlvo = keks.get(ativa)!;
    for (;;) {
      const n = await db.transaction(async (tx) => {
        const docs = await tx.select({ id: documento.id, dekCifrada: documento.dekCifrada, chaveVersao: documento.chaveVersao }).from(documento)
          .where(ne(documento.chaveVersao, ativa)).orderBy(asc(documento.id)).limit(lote).for('update');
        if (!docs.length) return 0;
        const deks = new Map<string, Buffer>();
        try {
          for (const d of docs) {
            const kek = keks.get(d.chaveVersao);
            if (!kek) throw new ErroRotacao(`condomínio ${codigo}: anexo na versão v${d.chaveVersao}, sem KEK registrada. Lote desfeito`);
            let dek: Buffer;
            try { dek = abrirDek(kek, d); } catch {
              throw new ErroRotacao(`condomínio ${codigo}: DEK de um anexo da v${d.chaveVersao} não abriu com a KEK registrada. Lote desfeito`);
            }
            deks.set(d.id, dek);
            const r = await tx.update(documento).set({ dekCifrada: embrulharDek(kekAlvo, ativa, d.id, dek), chaveVersao: ativa })
              .where(and(eq(documento.id, d.id), eq(documento.chaveVersao, d.chaveVersao))).returning({ id: documento.id });
            if (r.length !== 1) throw new ErroRotacao(`condomínio ${codigo}: anexo mudou durante a migração. Lote desfeito`);
          }
          // Ida e volta antes do COMMIT: a DEK relida, aberta com a KEK ativa, é byte a byte a de antes.
          const relidos = await tx.select({ id: documento.id, dekCifrada: documento.dekCifrada, chaveVersao: documento.chaveVersao }).from(documento)
            .where(inArray(documento.id, docs.map((d) => d.id)));
          if (relidos.length !== docs.length) throw new ErroRotacao(`condomínio ${codigo}: verificação de ida e volta (contagem). Lote desfeito`);
          for (const d of relidos) {
            if (d.chaveVersao !== ativa) throw new ErroRotacao(`condomínio ${codigo}: verificação de ida e volta (versão). Lote desfeito`);
            let volta: Buffer;
            try { volta = abrirDek(kekAlvo, d); } catch { throw new ErroRotacao(`condomínio ${codigo}: verificação de ida e volta (não abriu). Lote desfeito`); }
            try {
              if (!mesmaChave(volta, deks.get(d.id)!)) throw new ErroRotacao(`condomínio ${codigo}: verificação de ida e volta (DEK divergente). Lote desfeito`);
            } finally {
              volta.fill(0);
            }
          }
          return docs.length;
        } finally {
          zerar(deks.values());
        }
      });
      if (!n) break;
      migrados += n;
      lotes++;
      await opcoes.aposLote?.(lotes, migrados);
    }
  } finally {
    zerar(keks.values());
  }
  const porVersao = await contarPorVersao(db);
  return { situacao: migrados ? 'migrada' : 'nada_a_migrar', condominioId: c.id, codigo: c.codigo, versaoAtiva: ativa, migrados, lotes, porVersao };
}

