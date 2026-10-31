// EventoView da API: o evento gravado + valores efetivos + nomes resolvidos (o evento guarda só ids). Formato
// `EventoView` de ../dominio/types, o que a tela consome. Monta uma PÁGINA de cada vez:
// as referências (última correção, saída, entrada, autorização, nomes) vêm em consultas em lote, sem N+1.
import { codigoEvento } from '../dominio/hashChain';
import type { EventoAcesso, EventoView, ValoresCorrecao, VeiculoAcesso } from '../dominio/types';
import { CAMPOS_CORRIGIVEIS, ROTULO_PAPEL } from '../dominio/types';
import { codigoUnidade, PORTARIA_SOCIAL } from '../dominio/units';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import { areaComum, autorizacaoPrevia, eventoAcesso, pessoa, pontoAcesso, unidade, usuarioSistema } from '../db/schema';
import { type LinhaEvento, paraDominio } from './efetivo';

const unicos = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];

/** Última correção de cada evento (DISTINCT ON pelo evento corrigido, maior seq). */
async function ultimasCorrecoes(exec: Executor, ids: string[]): Promise<Map<string, EventoAcesso>> {
  const mapa = new Map<string, EventoAcesso>();
  if (!ids.length) return mapa;
  const linhas = await exec.selectDistinctOn([eventoAcesso.corrigeEventoId]).from(eventoAcesso)
    .where(and(eq(eventoAcesso.tipo, 'correcao'), inArray(eventoAcesso.corrigeEventoId, ids)))
    .orderBy(eventoAcesso.corrigeEventoId, desc(eventoAcesso.seq));
  for (const l of linhas) mapa.set(l.corrigeEventoId!, paraDominio(l));
  return mapa;
}

export interface ContextoView {
  correcoes: Map<string, EventoAcesso>;
  ef: (e: EventoAcesso) => EventoAcesso;
}

/** Valores efetivos = original + última correção (spec §4.4). */
export const aplicarCorrecao = (correcoes: Map<string, EventoAcesso>) => (e: EventoAcesso): EventoAcesso => {
  const c = correcoes.get(e.id);
  return c?.correcaoValores ? { ...e, ...c.correcaoValores } : e;
};

export async function montarViews(exec: Executor, linhas: LinhaEvento[]): Promise<EventoView[]> {
  if (!linhas.length) return [];
  const evs = linhas.map(paraDominio);
  const entradas = evs.filter((e) => e.tipo === 'entrada').map((e) => e.id);
  const saidas = entradas.length
    ? (await exec.select().from(eventoAcesso).where(and(eq(eventoAcesso.tipo, 'saida'), inArray(eventoAcesso.refereEventoId, entradas)))).map(paraDominio)
    : [];
  const saidaDe = new Map(saidas.map((s) => [s.refereEventoId!, s]));
  const correcoes = await ultimasCorrecoes(exec, unicos([...evs.filter((e) => e.tipo !== 'correcao').map((e) => e.id), ...saidas.map((s) => s.id)]));
  const ef = aplicarCorrecao(correcoes);

  // Saída: código e veículo da entrada a que ela se refere (a saída não grava veículo; herda da entrada)
  const refEntradas = unicos(evs.filter((e) => e.tipo === 'saida').map((e) => e.refereEventoId));
  const entradaRef = new Map((refEntradas.length
    ? await exec.select({
      id: eventoAcesso.id, seq: eventoAcesso.seq, veiculoPlaca: eventoAcesso.veiculoPlaca, veiculoModelo: eventoAcesso.veiculoModelo,
      veiculoCor: eventoAcesso.veiculoCor,
    }).from(eventoAcesso).where(inArray(eventoAcesso.id, refEntradas))
    : []).map((x) => [x.id, x]));

  const efs = evs.map(ef);
  const aut = unicos(evs.map((e) => e.autorizacaoPreviaId));
  const autorizacoes = new Map((aut.length ? await exec.select({
    id: autorizacaoPrevia.id, areaComumId: autorizacaoPrevia.areaComumId, semSolicitante: autorizacaoPrevia.semSolicitante,
    cadastradaPorId: autorizacaoPrevia.cadastradaPorId,
  }).from(autorizacaoPrevia).where(inArray(autorizacaoPrevia.id, aut)) : []).map((a) => [a.id, a]));

  const todasCorrecoes = [...correcoes.values()];
  const pessoaIds = unicos([
    ...evs.map((e) => e.pessoaId), ...efs.map((e) => e.pessoaId), ...evs.map((e) => e.autorizadoPorPessoaId), ...efs.map((e) => e.autorizadoPorPessoaId),
    ...evs.map((e) => e.correcaoValores?.pessoaId), ...evs.map((e) => e.correcaoValores?.autorizadoPorPessoaId),
  ]);
  const usuarioIds = unicos([...evs.map((e) => e.operadorId), ...todasCorrecoes.map((c) => c.operadorId), ...[...autorizacoes.values()].map((a) => a.cadastradaPorId)]);
  const unidadeIds = unicos([...efs.map((e) => e.unidadeDestinoId), ...evs.map((e) => e.unidadeDestinoId)]);
  const areaIds = unicos(evs.map((e) => e.areaComumId));
  const pontoIds = unicos(evs.map((e) => e.pontoAcessoId));
  const [pessoas, usuarios, unidades, areas, pontos] = await Promise.all([
    pessoaIds.length ? exec.select({ id: pessoa.id, nome: pessoa.nome }).from(pessoa).where(inArray(pessoa.id, pessoaIds)) : [],
    usuarioIds.length ? exec.select({ id: usuarioSistema.id, nome: usuarioSistema.nome, papel: usuarioSistema.papel }).from(usuarioSistema).where(inArray(usuarioSistema.id, usuarioIds)) : [],
    unidadeIds.length ? exec.select({ id: unidade.id, bloco: unidade.bloco, numero: unidade.numero }).from(unidade).where(inArray(unidade.id, unidadeIds)) : [],
    areaIds.length ? exec.select({ id: areaComum.id, nome: areaComum.nome }).from(areaComum).where(inArray(areaComum.id, areaIds)) : [],
    pontoIds.length ? exec.select({ id: pontoAcesso.id, nome: pontoAcesso.nome }).from(pontoAcesso).where(inArray(pontoAcesso.id, pontoIds)) : [],
  ]);
  const nomeP = new Map(pessoas.map((p) => [p.id, p.nome]));
  const usu = new Map(usuarios.map((u) => [u.id, u]));
  const uni = new Map(unidades.map((u) => [u.id, codigoUnidade(u)]));
  const are = new Map(areas.map((a) => [a.id, a.nome]));
  const pon = new Map(pontos.map((p) => [p.id, p.nome]));
  const nomeUsuario = (id: string | null | undefined) => (id ? usu.get(id)?.nome ?? '(usuário)' : null);
  const nomePessoa = (id: string | null | undefined) => (id ? nomeP.get(id) ?? '(pessoa)' : null);
  const codigoUn = (id: string | null | undefined) => (id ? uni.get(id) ?? '(unidade)' : null);

  /** Quem autorizou, pelo id; autorização sem solicitante ou de área comum: quem cadastrou. */
  const nomeAutorizador = (e: Pick<EventoAcesso, 'autorizadoPorPessoaId' | 'autorizadoPorTipo' | 'autorizacaoPreviaId'>): string | null => {
    if (e.autorizadoPorPessoaId) return nomePessoa(e.autorizadoPorPessoaId);
    if (e.autorizadoPorTipo === 'autorizacao_previa' && e.autorizacaoPreviaId) {
      const ap = autorizacoes.get(e.autorizacaoPreviaId);
      if (ap?.areaComumId) return `Área comum — cadastrada por ${nomeUsuario(ap.cadastradaPorId)}`;
      if (ap?.semSolicitante) return `Sem solicitante — cadastrada por ${nomeUsuario(ap.cadastradaPorId)}`;
    }
    return null;
  };

  return evs.map((bruto, k): EventoView => {
    const e = efs[k]!;
    const saida = e.tipo === 'entrada' ? saidaDe.get(e.id) ?? null : null;
    const c = correcoes.get(bruto.id);
    const aplicados: Partial<ValoresCorrecao> = c?.correcaoValores ?? {};
    const valoresOriginais: Partial<ValoresCorrecao> = {};
    for (const campo of CAMPOS_CORRIGIVEIS) if (campo in aplicados) (valoresOriginais as Record<string, unknown>)[campo] = bruto[campo];
    const corrigidos = bruto.tipo === 'correcao' ? bruto.correcaoValores : null;
    const ent = e.tipo === 'saida' && e.refereEventoId ? entradaRef.get(e.refereEventoId) : undefined;
    const seqEnt = ent?.seq;
    const ap = e.autorizacaoPreviaId ? autorizacoes.get(e.autorizacaoPreviaId) : undefined;
    return {
      ...e,
      codigo: codigoEvento(bruto.seq),
      pessoaNome: nomeP.get(e.pessoaId) ?? '(pessoa removida)',
      operadorNome: usu.get(e.operadorId)?.nome ?? '(operador)',
      unidadeRotulo: e.unidadeDestinoId ? codigoUn(e.unidadeDestinoId) : e.areaComumId ? are.get(e.areaComumId) ?? '(área comum)' : null,
      areaComumNome: e.areaComumId ? are.get(e.areaComumId) ?? '(área comum)' : null,
      pontoAcessoNome: pon.get(e.pontoAcessoId) ?? PORTARIA_SOCIAL,
      autorizadoPorNome: nomeAutorizador(e),
      veiculo: veiculoDe(e.tipo === 'entrada' ? bruto : ent),
      saida: saida ? { id: saida.id, codigo: codigoEvento(saida.seq), em: ef(saida).ocorridoEm } : null,
      dentro: e.tipo === 'entrada' && !saida,
      entradaCodigo: seqEnt !== undefined ? codigoEvento(seqEnt) : null,
      valoresOriginais: Object.keys(valoresOriginais).length > 0 ? valoresOriginais : null,
      correcao: c ? {
        id: c.id, codigo: codigoEvento(c.seq), em: c.registradoEm, justificativa: c.justificativa, observacao: c.observacao,
        operadorNome: usu.get(c.operadorId)?.nome ?? '(operador)',
      } : null,
      valoresCorrigidos: corrigidos,
      pessoaNomeOriginal: 'pessoaId' in aplicados ? nomeP.get(bruto.pessoaId) ?? null : null,
      pessoaNomeCorrigida: corrigidos?.pessoaId ? nomeP.get(corrigidos.pessoaId) ?? null : null,
      autorizadoPorNomeOriginal: 'autorizadoPorPessoaId' in aplicados ? nomeAutorizador(bruto) : null,
      autorizadoPorNomeCorrigido: corrigidos && 'autorizadoPorPessoaId' in corrigidos ? nomePessoa(corrigidos.autorizadoPorPessoaId) : null,
      autorizacaoSemSolicitante: !!ap?.semSolicitante,
    };
  });
}

/** Veículo gravado numa entrada (nulo a pé). */
const veiculoDe = (e: { veiculoPlaca: string | null; veiculoModelo: string | null; veiculoCor: string | null } | undefined): VeiculoAcesso | null =>
  (e?.veiculoPlaca ? { placa: e.veiculoPlaca, modelo: e.veiculoModelo, cor: e.veiculoCor } : null);

/** "Nome (Papel)" (autorizações e restrições). */
export const comPapel = (u: { nome: string; papel: keyof typeof ROTULO_PAPEL } | undefined) => (u ? `${u.nome} (${ROTULO_PAPEL[u.papel]})` : '(usuário)');
