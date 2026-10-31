// Autorização prévia e restrição: linha do Drizzle -> domínio (epoch ms, 'HH:MM') e as views com nomes (campos de
// `AutorizacaoViewApi` e `RestricaoViewApi`). Instantes em epoch ms; nomes por consulta em lote.
import { estadoAutorizacaoPrevia } from '../dominio/rules';
import { fimDoDia, inicioDoDia } from '../dominio/time';
import type { AutorizacaoPrevia, Restricao } from '../dominio/types';
import { codigoUnidade } from '../dominio/units';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import { areaComum, autorizacaoPrevia, eventoAcesso, pessoa, restricao, unidade, usuarioSistema } from '../db/schema';
import { comPapel } from './evento-view';

const ms = (d: Date | null) => (d ? d.getTime() : null);
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const unicos = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];

export function paraAutorizacaoDominio(a: typeof autorizacaoPrevia.$inferSelect): AutorizacaoPrevia {
  return {
    id: a.id, unidadeId: a.unidadeId, areaComumId: a.areaComumId, pessoaId: a.pessoaId, validaDe: a.validaDe.getTime(),
    validaAte: a.validaAte.getTime(), diasSemana: a.diasSemana ?? null, horaInicio: hhmm(a.horaInicio), horaFim: hhmm(a.horaFim),
    cadastradaPorId: a.cadastradaPorId, cadastradaEm: a.cadastradaEm.getTime(), solicitadaPorPessoaId: a.solicitadaPorPessoaId,
    semSolicitante: a.semSolicitante, justificativa: a.justificativa, revogadaEm: ms(a.revogadaEm), revogadaPorId: a.revogadaPorId,
  };
}

export function paraRestricaoDominio(r: typeof restricao.$inferSelect): Restricao {
  return {
    id: r.id, escopo: r.escopo, unidadeId: r.unidadeId, pessoaId: r.pessoaId, motivo: r.motivo, validaAte: r.validaAte.getTime(),
    cadastradaPorId: r.cadastradaPorId, cadastradaEm: r.cadastradaEm.getTime(), solicitadaPorPessoaId: r.solicitadaPorPessoaId,
    aprovadaPorId: r.aprovadaPorId, aprovadaEm: ms(r.aprovadaEm), revogadaEm: ms(r.revogadaEm), revogadaPorId: r.revogadaPorId,
  };
}

/** Nomes de pessoas, usuários (com papel), unidades e áreas, numa consulta por tabela. */
async function nomes(exec: Executor, i: { pessoas: string[]; usuarios: string[]; unidades: string[]; areas: string[] }) {
  const [ps, us, uns, as] = await Promise.all([
    i.pessoas.length ? exec.select({ id: pessoa.id, nome: pessoa.nome }).from(pessoa).where(inArray(pessoa.id, i.pessoas)) : [],
    i.usuarios.length ? exec.select({ id: usuarioSistema.id, nome: usuarioSistema.nome, papel: usuarioSistema.papel }).from(usuarioSistema).where(inArray(usuarioSistema.id, i.usuarios)) : [],
    i.unidades.length ? exec.select({ id: unidade.id, bloco: unidade.bloco, numero: unidade.numero }).from(unidade).where(inArray(unidade.id, i.unidades)) : [],
    i.areas.length ? exec.select({ id: areaComum.id, nome: areaComum.nome }).from(areaComum).where(inArray(areaComum.id, i.areas)) : [],
  ]);
  const p = new Map(ps.map((x) => [x.id, x.nome]));
  const u = new Map(us.map((x) => [x.id, x]));
  const un = new Map(uns.map((x) => [x.id, codigoUnidade(x)]));
  const ar = new Map(as.map((x) => [x.id, x.nome]));
  return {
    pessoa: (id: string | null | undefined) => (id ? p.get(id) ?? '(pessoa)' : null),
    usuario: (id: string | null | undefined) => (id ? u.get(id)?.nome ?? '(usuário)' : null),
    comPapel: (id: string) => comPapel(u.get(id)),
    unidade: (id: string | null | undefined) => (id ? un.get(id) ?? '(unidade)' : null),
    area: (id: string | null | undefined) => (id ? ar.get(id) ?? '(área comum)' : null),
  };
}

export interface AutorizacaoViewApi extends AutorizacaoPrevia {
  pessoaNome: string; estado: ReturnType<typeof estadoAutorizacaoPrevia>; unidadeRotulo: string; utilizadaEm: number | null;
  cadastradaPorNome: string; solicitadaPorNome: string | null; revogadaPorNome: string | null;
}

/** `quando`: instante do estado e do "utilizada hoje" (o relógio da API). */
export async function montarAutorizacoesView(exec: Executor, as: AutorizacaoPrevia[], quando: number): Promise<AutorizacaoViewApi[]> {
  if (!as.length) return [];
  const n = await nomes(exec, {
    pessoas: unicos([...as.map((a) => a.pessoaId), ...as.map((a) => a.solicitadaPorPessoaId)]),
    usuarios: unicos([...as.map((a) => a.cadastradaPorId), ...as.map((a) => a.revogadaPorId)]),
    unidades: unicos(as.map((a) => a.unidadeId)), areas: unicos(as.map((a) => a.areaComumId)),
  });
  // Uso no dia de `quando` (entrada com esta autorização entre o início e o fim do dia), valor gravado
  const usos = await exec.select({ a: eventoAcesso.autorizacaoPreviaId, em: eventoAcesso.ocorridoEm }).from(eventoAcesso).where(and(
    eq(eventoAcesso.tipo, 'entrada'), inArray(eventoAcesso.autorizacaoPreviaId, as.map((a) => a.id)),
    gte(eventoAcesso.ocorridoEm, new Date(inicioDoDia(quando))), lte(eventoAcesso.ocorridoEm, new Date(fimDoDia(quando))),
  )).orderBy(eventoAcesso.seq);
  const uso = new Map<string, number>();
  for (const u of usos) if (u.a && !uso.has(u.a)) uso.set(u.a, u.em.getTime());
  return as.map((a) => ({
    ...a, pessoaNome: n.pessoa(a.pessoaId) ?? '?', estado: estadoAutorizacaoPrevia(a, quando),
    unidadeRotulo: a.unidadeId ? n.unidade(a.unidadeId) ?? '?' : n.area(a.areaComumId) ?? '(área comum)',
    utilizadaEm: uso.get(a.id) ?? null, cadastradaPorNome: n.comPapel(a.cadastradaPorId),
    solicitadaPorNome: n.pessoa(a.solicitadaPorPessoaId), revogadaPorNome: n.usuario(a.revogadaPorId),
  }));
}

export interface RestricaoViewApi extends Restricao {
  pessoaNome: string; pendente: boolean; unidadeCodigo: string | null;
  cadastradaPorNome: string; solicitadaPorNome: string | null; aprovadaPorNome: string | null; revogadaPorNome: string | null;
}

export async function montarRestricoesView(exec: Executor, rs: Restricao[]): Promise<RestricaoViewApi[]> {
  if (!rs.length) return [];
  const n = await nomes(exec, {
    pessoas: unicos([...rs.map((r) => r.pessoaId), ...rs.map((r) => r.solicitadaPorPessoaId)]),
    usuarios: unicos([...rs.map((r) => r.cadastradaPorId), ...rs.map((r) => r.aprovadaPorId), ...rs.map((r) => r.revogadaPorId)]),
    unidades: unicos(rs.map((r) => r.unidadeId)), areas: [],
  });
  return rs.map((r) => ({
    ...r, pessoaNome: n.pessoa(r.pessoaId) ?? '?', pendente: r.escopo === 'condominio' && r.aprovadaEm === null,
    unidadeCodigo: n.unidade(r.unidadeId), cadastradaPorNome: n.comPapel(r.cadastradaPorId),
    solicitadaPorNome: n.pessoa(r.solicitadaPorPessoaId), aprovadaPorNome: n.usuario(r.aprovadaPorId), revogadaPorNome: n.usuario(r.revogadaPorId),
  }));
}
