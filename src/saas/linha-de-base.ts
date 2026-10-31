// Linha de base da cadeia do piloto (docs/05_arquitetura_saas.md, fase F0): a fotografia contra a qual as fases
// seguintes (F2, F3, F4) provam que a cadeia antiga não mudou. Gera, de UMA leitura consistente do banco:
//   - trilha.jsonl         exportação verificável da cadeia inteira (mesmo formato do "Exportar trilha", manifesto v2),
//                          SEM os nomes de exibição (pessoa, operador, unidade, área: null). Os campos canônicos
//                          continuam, porque são eles que entram no hash (inclusive o texto livre: justificativa,
//                          observação, empresa, serviço). Por isso este arquivo só existe cifrado (cli/linha-de-base.ts);
//   - linha-de-base.json   cabeça (seq, hash), verificação interna (a mesma do RF-37), resultado do verificar-ancoras
//                          contra o selos.jsonl do branch `ancoras`, contagem por tabela e última migração. Só números,
//                          hashes e nomes de tabela: nenhum dado pessoal.
// O chamador abre a transação (REPEATABLE READ, READ ONLY): contagens, cabeça e trilha são do mesmo instante.
import { createHash } from 'node:crypto';
import { montarExportacaoJsonl } from '../dominio/exportacao';
import { hashGenese } from '../dominio/hashChain';
import { asc, eq, gt, sql } from 'drizzle-orm';
import { AuditoriaRotasService, type ResultadoIntegridadeApi } from '../auditoria/auditoria.controller';
import type { Relogio } from '../comum/relogio';
import type { Db } from '../database/database.module';
import { paraExportacao } from '../db/cadeia';
import { eventoAcesso, eventoAcessoCadeia } from '../db/schema';
import { conferirAncoras, type ResultadoAncoras } from '../selo/conferir-ancoras';

export const FORMATO_LINHA_DE_BASE = 'portaria-parque/linha-de-base';
const LOTE = 5000;
const NOME_TABELA = /^[a-z_][a-z0-9_]*$/;

export interface ResumoLinhaDeBase {
  formato: typeof FORMATO_LINHA_DE_BASE;
  versao: 1;
  geradoEm: string;
  /** Cabeça da cadeia (evento_acesso_cadeia, id = 1). */
  cabeca: { seq: number; hash: string };
  eventos: { quantidade: number; primeiroSeq: number | null; ultimoSeq: number | null };
  /** Verificação interna da API (RF-37): recálculo, cabeça e selos. */
  integridade: ResultadoIntegridadeApi;
  /** verificar-ancoras: a trilha exportada contra o selos.jsonl do branch `ancoras`. */
  ancoras: Pick<ResultadoAncoras, 'conclusao' | 'conferidas' | 'divergentes' | 'foraDoIntervalo'> & { dias: number };
  /** Linhas por tabela do schema public. null = o role da conexão não tem SELECT nela. */
  contagens: Record<string, number | null>;
  /** Última migração aplicada (drizzle.__drizzle_migrations), ou null se o role não a enxerga. */
  ultimaMigracao: { hash: string; criadaEm: number } | null;
  /** SHA-256 dos arquivos que acompanham este resumo. */
  arquivos: Record<'trilha.jsonl' | 'selos.jsonl', string>;
}

export interface LinhaDeBase {
  resumo: ResumoLinhaDeBase;
  trilha: string;
  /** Hash do evento no seq (null se não existe), para comparar com uma linha de base anterior. */
  hashDoSeq(seq: number): string | null;
}

type Linhas<T> = { rows: T[] };
const linhas = async <T>(db: Db, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as Linhas<T>).rows;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function contarTabelas(db: Db): Promise<Record<string, number | null>> {
  const tabelas = await linhas<{ nome: string; pode: boolean }>(db, sql`
    SELECT c.relname AS nome, has_table_privilege(c.oid, 'SELECT') AS pode
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
  const r: Record<string, number | null> = {};
  for (const t of tabelas) {
    // Sem SELECT, nem tenta: erro de permissão abortaria a transação inteira.
    if (!t.pode || !NOME_TABELA.test(t.nome)) { r[t.nome] = null; continue; }
    const [l] = await linhas<{ n: string | number }>(db, sql`SELECT count(*) AS n FROM ${sql.identifier(t.nome)}`);
    r[t.nome] = Number(l!.n);
  }
  return r;
}

async function ultimaMigracao(db: Db): Promise<ResumoLinhaDeBase['ultimaMigracao']> {
  // Pelo catálogo e por OID: resolver 'drizzle.x' pelo nome dá "permission denied for schema" a quem não tem USAGE
  // (o app_rw), e o CASE não protege (as funções com constante são avaliadas no planejamento). Sem a tabela, sem linha.
  const [ok] = await linhas<{ pode: boolean | null }>(db, sql`
    SELECT has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT') AS pode
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'`);
  if (!ok?.pode) return null;
  const [m] = await linhas<{ hash: string; created_at: string | number }>(db, sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`);
  return m ? { hash: m.hash, criadaEm: Number(m.created_at) } : null;
}

/** Gera a linha de base. `selosJsonl`: o conteúdo do selos.jsonl do branch `ancoras` (dado público). */
export async function gerarLinhaDeBase(db: Db, selosJsonl: string, relogio: Relogio): Promise<LinhaDeBase> {
  const [cab] = await db.select().from(eventoAcessoCadeia).where(eq(eventoAcessoCadeia.id, 1));
  if (!cab) throw new Error('evento_acesso_cadeia sem a linha id = 1: banco sem a migração 0001?');

  const eventos = [];
  for (let ultimo = 0; ;) {
    const lote = await db.select().from(eventoAcesso).where(gt(eventoAcesso.seq, ultimo)).orderBy(asc(eventoAcesso.seq)).limit(LOTE);
    eventos.push(...lote.map(paraExportacao));
    if (lote.length < LOTE) break;
    ultimo = lote[lote.length - 1]!.seq;
  }
  const agora = relogio.agora();
  const pacote = await montarExportacaoJsonl({
    eventos, filtros: {}, isolado: false,
    exibicao: () => ({ pessoa: null, unidade: null, areaComum: null, operador: null }),
    geradoPor: 'Linha de base SaaS (CLI)', geradoEm: agora.toISOString(), carimbo: agora.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-'),
    observacao: 'Linha de base da fase F0 (docs/05_arquitetura_saas.md). Sem nomes de exibição. Arquivo sigiloso: só circula cifrado.',
  });

  // Mesma verificação da tela de auditoria. O serviço só usa o banco nesse método.
  const integridade = await new AuditoriaRotasService(db, relogio, null as never, null as never, null).verificarIntegridade();
  const a = await conferirAncoras(pacote.conteudo, selosJsonl);

  const hashes = new Map<number, string>(eventos.map((e) => [e.seq, e.hash]));
  const genese = await hashGenese();
  const resumo: ResumoLinhaDeBase = {
    formato: FORMATO_LINHA_DE_BASE, versao: 1, geradoEm: agora.toISOString(),
    cabeca: { seq: cab.ultimoSeq, hash: cab.ultimoHash },
    eventos: { quantidade: eventos.length, primeiroSeq: eventos[0]?.seq ?? null, ultimoSeq: eventos.at(-1)?.seq ?? null },
    integridade,
    ancoras: { conclusao: a.conclusao, conferidas: a.conferidas, divergentes: a.divergentes, foraDoIntervalo: a.foraDoIntervalo, dias: a.conferidas.length + a.divergentes.length + a.foraDoIntervalo },
    contagens: await contarTabelas(db),
    ultimaMigracao: await ultimaMigracao(db),
    arquivos: { 'trilha.jsonl': sha256(pacote.conteudo), 'selos.jsonl': sha256(selosJsonl) },
  };
  return {
    resumo, trilha: pacote.conteudo,
    hashDoSeq: (seq) => (seq === 0 ? genese : hashes.get(seq) ?? (seq === cab.ultimoSeq ? cab.ultimoHash : null)),
  };
}

/** A linha de base está boa para servir de referência? (cadeia íntegra e âncoras conferidas). Lista os problemas. */
export function problemasDaLinhaDeBase(r: ResumoLinhaDeBase): string[] {
  const p: string[] = [];
  if (!r.integridade.valido) p.push(`verificação interna: ${r.integridade.motivo ?? 'inválida'} no seq ${r.integridade.primeiroSeqInvalido ?? '?'}`);
  if (r.ancoras.conclusao !== 'confere') p.push(`âncoras do GitHub: ${r.ancoras.conclusao}`);
  return p;
}

/**
 * Compara o estado atual (ex.: banco restaurado, ou o de produção depois de F2/F3/F4) com uma linha de base anterior:
 * a cadeia atual tem de ser íntegra, conferir com as âncoras, ter cabeça igual ou posterior e o MESMO hash no seq da
 * cabeça antiga. Seq antigo já descartado pela retenção não é divergência (o selo cobre); vira observação.
 */
export function compararComReferencia(atual: LinhaDeBase, ref: ResumoLinhaDeBase): { problemas: string[]; observacoes: string[] } {
  const problemas = problemasDaLinhaDeBase(atual.resumo);
  const observacoes: string[] = [];
  if (ref.formato !== FORMATO_LINHA_DE_BASE || ref.versao !== 1) problemas.push('referência não é uma linha de base v1');
  if (atual.resumo.cabeca.seq < ref.cabeca.seq) {
    problemas.push(`cabeça atual (seq ${atual.resumo.cabeca.seq}) é anterior à da referência (seq ${ref.cabeca.seq})`);
  } else {
    const h = atual.hashDoSeq(ref.cabeca.seq);
    if (h === null) observacoes.push(`seq ${ref.cabeca.seq} da referência não está mais no banco (retenção): conferido só pelas âncoras`);
    else if (h !== ref.cabeca.hash) problemas.push(`hash do seq ${ref.cabeca.seq} difere da referência: a cadeia antiga mudou`);
  }
  for (const [t, n] of Object.entries(ref.contagens)) {
    if (!(t in atual.resumo.contagens)) problemas.push(`tabela ${t} sumiu`);
    else if (n !== null && atual.resumo.contagens[t] !== null && atual.resumo.contagens[t]! < n) observacoes.push(`${t}: ${n} -> ${atual.resumo.contagens[t]} linhas`);
  }
  return { problemas, observacoes };
}
