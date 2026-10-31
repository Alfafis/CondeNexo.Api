// Vínculo como a API devolve (VinculoApi): a linha do vínculo mais os nomes por join (pessoa, unidade, quem registrou,
// decidiu e conferiu, arquivo da importação). Usado pela lista, pelo detalhe da unidade, pela ficha e pelas escritas.
// Datas de calendário saem como 'AAAA-MM-DD' (dia BRT); instantes, em epoch ms.
import { codigoUnidade } from '../dominio/units';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Executor } from '../database/database.module';
import { importacao, pessoa, unidade, usuarioSistema, vinculoUnidade as v } from '../db/schema';
import { cadastroCompletoDe } from '../pessoas/pessoa-view';
import { ORDEM_UNIDADES } from '../unidades/ordem';

const registrador = alias(usuarioSistema, 'registrador');
const decisor = alias(usuarioSistema, 'decisor');
const conferente = alias(usuarioSistema, 'conferente');

type TipoComprovante = NonNullable<(typeof v.$inferSelect)['conferenciaTipoDocumento']>;

export interface VinculoApi {
  id: string;
  pessoaId: string;
  unidadeId: string;
  tipo: (typeof v.tipo.enumValues)[number];
  status: (typeof v.status.enumValues)[number];
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  prazoRegularizacao: string | null;
  conferencia: { tipoDocumento: TipoComprovante; descricao?: string; data: string; conferidoPorId: string; observacao?: string } | null;
  solicitadoPor: string;
  solicitadoEm: number;
  registradoPorId: string;
  importacaoId?: string;
  nota?: string;
  decididoPorId?: string;
  decididoEm?: number;
  justificativa?: string;
  encerradoEm: number | null;
  pessoaNome: string;
  pessoaDocumento: string;
  pessoaCadastroCompleto: boolean;
  unidadeCodigo: string;
  decididoPorNome: string | null;
  registradoPorNome: string | null;
  conferidoPorNome: string | null;
  legadoVencido: boolean;
}

/** SELECT com os joins da view. O chamador acrescenta where/orderBy/limit. */
export function selecionarVinculos(exec: Executor) {
  return exec.select({
    v,
    pessoaNome: pessoa.nome, pessoaSemCpf: pessoa.semCpf, pessoaMascarado: pessoa.documentoMascarado,
    pessoaTelefone: pessoa.telefone, pessoaAnonimizadaEm: pessoa.anonimizadaEm, pessoaMenorIdade: pessoa.menorIdade,
    pessoaTemCpf: sql<boolean>`(${pessoa.documentoBusca} IS NOT NULL)`.mapWith(Boolean),
    bloco: unidade.bloco, numero: unidade.numero,
    registradoPorNome: registrador.nome, decididoPorNome: decisor.nome, conferidoPorNome: conferente.nome,
    arquivo: importacao.arquivoNome,
  }).from(v)
    .innerJoin(pessoa, eq(pessoa.id, v.pessoaId))
    .innerJoin(unidade, eq(unidade.id, v.unidadeId))
    .leftJoin(registrador, eq(registrador.id, v.registradoPorId))
    .leftJoin(decisor, eq(decisor.id, v.decididoPorId))
    .leftJoin(conferente, eq(conferente.id, v.conferidoPorId))
    .leftJoin(importacao, eq(importacao.id, v.importacaoId));
}

export type LinhaView = Awaited<ReturnType<typeof selecionarVinculos>>[number];

/** `hoje`: dia BRT do relógio da API ('AAAA-MM-DD'), para o "legado vencido" (mesma regra de `legadoVencido` do domain). */
export function paraVinculoApi(l: LinhaView, hoje: string): VinculoApi {
  const x = l.v;
  const conferencia = x.conferenciaTipoDocumento && x.conferenciaData && x.conferidoPorId ? {
    tipoDocumento: x.conferenciaTipoDocumento, data: x.conferenciaData, conferidoPorId: x.conferidoPorId,
    ...(x.conferenciaDescricao ? { descricao: x.conferenciaDescricao } : {}),
    ...(x.conferenciaObservacao ? { observacao: x.conferenciaObservacao } : {}),
  } : null;
  const documento = l.pessoaAnonimizadaEm ? '(anonimizado)' : l.pessoaSemCpf ? '(sem CPF)' : (l.pessoaMascarado ?? (l.pessoaMenorIdade ? '(menor, sem CPF)' : '(sem CPF)'));
  return {
    id: x.id, pessoaId: x.pessoaId, unidadeId: x.unidadeId, tipo: x.tipo, status: x.status,
    vigenciaInicio: x.vigenciaInicio, vigenciaFim: x.vigenciaFim, prazoRegularizacao: x.prazoRegularizacao,
    conferencia,
    solicitadoPor: x.importacaoId ? `Importação da planilha ${l.arquivo ?? ''}`.trim() : (l.registradoPorNome ?? 'Administração'),
    solicitadoEm: x.registradoEm.getTime(),
    registradoPorId: x.registradoPorId,
    ...(x.importacaoId ? { importacaoId: x.importacaoId } : {}),
    ...(x.nota ? { nota: x.nota } : {}),
    ...(x.decididoPorId ? { decididoPorId: x.decididoPorId } : {}),
    ...(x.decididoEm ? { decididoEm: x.decididoEm.getTime() } : {}),
    ...(x.justificativa ? { justificativa: x.justificativa } : {}),
    encerradoEm: x.encerradoEm ? x.encerradoEm.getTime() : null,
    pessoaNome: l.pessoaNome,
    pessoaDocumento: documento,
    pessoaCadastroCompleto: cadastroCompletoDe({
      semCpf: l.pessoaSemCpf, anonimizadaEm: l.pessoaAnonimizadaEm, telefone: l.pessoaTelefone, temCpf: l.pessoaTemCpf, menorIdade: l.pessoaMenorIdade,
    }, x.tipo),
    unidadeCodigo: codigoUnidade({ bloco: l.bloco, numero: l.numero }),
    decididoPorNome: l.decididoPorNome, registradoPorNome: l.registradoPorNome, conferidoPorNome: l.conferidoPorNome,
    legadoVencido: x.status === 'legado' && x.prazoRegularizacao !== null && x.prazoRegularizacao < hoje,
  };
}

/** Vínculos que casam com `filtro`, na ordem de exibição da unidade e da ficha (unidade, pessoa). Conjunto pequeno. */
export async function carregarVinculos(exec: Executor, filtro: SQL, hoje: string): Promise<VinculoApi[]> {
  const linhas = await selecionarVinculos(exec).where(filtro)
    .orderBy(...ORDEM_UNIDADES, asc(pessoa.nome), asc(v.id));
  return linhas.map((l) => paraVinculoApi(l, hoje));
}
