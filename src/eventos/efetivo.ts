// Valores EFETIVOS do evento (spec §4.4): o registro gravado nunca muda; uma correção é um evento novo cujo
// `correcao_valores` (acumulado das correções anteriores) substitui campos do original. Vale a ÚLTIMA correção (maior
// seq).
//
// Em SQL: `efetivoSql(chave)` lê a última correção por subconsulta correlacionada (índice evento_correcao_ix). Para
// filtrar por um valor efetivo sem varrer a tabela, `filtroEfetivo` combina o valor gravado (indexado) com os poucos
// eventos que têm correção daquela chave (subconsulta NÃO correlacionada, avaliada uma vez) e só então confere o
// efetivo. Referência à linha externa sempre explícita (`"evento_acesso"."id"`): numa consulta de uma tabela só o
// Drizzle escreve as colunas sem o nome da tabela (numa subconsulta correlacionada sobre a mesma tabela, a referência sem nome ficaria ambígua).
import type { EventoAcesso, ValoresCorrecao } from '../dominio/types';
import { CAMPOS_CORRIGIVEIS } from '../dominio/types';
import { and, or, sql, type SQL } from 'drizzle-orm';
import type { eventoAcesso } from '../db/schema';

export type LinhaEvento = typeof eventoAcesso.$inferSelect;
export type ChaveCorrecao = 'unidade_destino_id' | 'ocorrido_em' | 'pessoa_id' | 'autorizado_por_pessoa_id';

const TIPO_SQL: Record<ChaveCorrecao, string> = {
  unidade_destino_id: 'uuid', ocorrido_em: 'timestamptz', pessoa_id: 'uuid', autorizado_por_pessoa_id: 'uuid',
};

/** Referência qualificada a uma coluna da linha externa. */
export const col = (nome: string, tabela = 'evento_acesso') => sql.raw(`"${tabela}"."${nome}"`);

/** `correcao_valores` da última correção do evento da linha externa (ou NULL). */
export const ultimaCorrecaoSql = (tabela = 'evento_acesso') =>
  sql`(SELECT c.correcao_valores FROM evento_acesso c WHERE c.corrige_evento_id = ${col('id', tabela)} ORDER BY c.seq DESC LIMIT 1)`;

/** Valor efetivo de uma coluna corrigível da linha externa. */
export function efetivoSql(chave: ChaveCorrecao, tabela = 'evento_acesso'): SQL {
  const u = ultimaCorrecaoSql(tabela);
  const k = literal(chave);
  return sql`(CASE WHEN coalesce(${u} ? ${k}, false) THEN (${u} ->> ${k})::${sql.raw(TIPO_SQL[chave])} ELSE ${col(chave, tabela)} END)`;
}

/** A chave entra como literal (conjunto fechado): parâmetro sem tipo em `->>` seria ambíguo entre text e int. */
const literal = (chave: ChaveCorrecao) => sql.raw(`'${chave}'`);

/** Ids dos eventos que têm alguma correção com a chave (subconsulta sem correlação). */
export const corrigidosComSql = (chave: ChaveCorrecao) =>
  sql`(SELECT c.corrige_evento_id FROM evento_acesso c WHERE c.corrige_evento_id IS NOT NULL AND c.correcao_valores ? ${literal(chave)})`;

/**
 * Filtro sobre o valor efetivo: (valor gravado casa OU o evento tem correção da chave) E o valor efetivo casa.
 * A primeira parte usa os índices do valor gravado; a segunda garante o resultado certo quando há correção.
 */
export function filtroEfetivo(chave: ChaveCorrecao, cond: (expr: SQL) => SQL, tabela = 'evento_acesso'): SQL {
  return and(or(cond(col(chave, tabela)), sql`${col('id', tabela)} IN ${corrigidosComSql(chave)}`), cond(efetivoSql(chave, tabela)))!;
}

/** Entrada sem saída registrada (quem está dentro). Usa o índice único evento_saida_unica_uq. */
export const semSaidaSql = (tabela = 'evento_acesso') =>
  sql`NOT EXISTS (SELECT 1 FROM evento_acesso s WHERE s.tipo = 'saida' AND s.refere_evento_id = ${col('id', tabela)})`;

/**
 * Exceção (RF-31): liberação do porteiro OU entrada por autorização prévia de unidade cadastrada sem solicitante.
 * Regra do responsável pela exceção. Área comum (RF-36) é da administração e não conta.
 */
export const ehExcecaoSql = (tabela = 'evento_acesso') => sql`(${col('tipo', tabela)} = 'entrada' AND (
  ${col('autorizado_por_tipo', tabela)} = 'excecao_porteiro'
  OR (${col('autorizado_por_tipo', tabela)} = 'autorizacao_previa' AND EXISTS (
    SELECT 1 FROM autorizacao_previa a WHERE a.id = ${col('autorizacao_previa_id', tabela)} AND a.sem_solicitante))))`;

/** Usuário responsável pela exceção: o operador, ou quem cadastrou a autorização sem solicitante. NULL se não for exceção. */
export const responsavelExcecaoSql = (tabela = 'evento_acesso') => sql`(CASE
  WHEN ${col('tipo', tabela)} <> 'entrada' THEN NULL
  WHEN ${col('autorizado_por_tipo', tabela)} = 'excecao_porteiro' THEN ${col('operador_id', tabela)}
  WHEN ${col('autorizado_por_tipo', tabela)} = 'autorizacao_previa' THEN (
    SELECT a.cadastrada_por_id FROM autorizacao_previa a WHERE a.id = ${col('autorizacao_previa_id', tabela)} AND a.sem_solicitante)
  END)`;

// ----- Conversões ----------------------------------------------------------------------------------------------------

/** `correcao_valores` do banco (snake_case, ISO) -> domínio (camelCase, epoch ms), na ordem canônica. */
export function correcaoDoBanco(v: Record<string, string | null> | null): Partial<ValoresCorrecao> | null {
  if (!v) return null;
  const o: Partial<ValoresCorrecao> = {};
  for (const k of CAMPOS_CORRIGIVEIS) {
    const sk = k === 'unidadeDestinoId' ? 'unidade_destino_id' : k === 'ocorridoEm' ? 'ocorrido_em' : k === 'pessoaId' ? 'pessoa_id' : 'autorizado_por_pessoa_id';
    if (!Object.prototype.hasOwnProperty.call(v, sk)) continue;
    const x = v[sk] ?? null;
    if (k === 'ocorridoEm') o.ocorridoEm = Date.parse(x!);
    else if (k === 'pessoaId') o.pessoaId = x!;
    else (o as Record<string, string | null>)[k] = x;
  }
  return o;
}

/** Domínio -> `correcao_valores` do banco (o trigger normaliza o instante e os uuids). */
export function correcaoParaBanco(v: Partial<ValoresCorrecao>): Record<string, string | null> {
  const o: Record<string, string | null> = {};
  if ('unidadeDestinoId' in v) o.unidade_destino_id = v.unidadeDestinoId ?? null;
  if ('ocorridoEm' in v) o.ocorrido_em = new Date(v.ocorridoEm!).toISOString();
  if ('pessoaId' in v) o.pessoa_id = v.pessoaId ?? null;
  if ('autorizadoPorPessoaId' in v) o.autorizado_por_pessoa_id = v.autorizadoPorPessoaId ?? null;
  return o;
}

/** Linha do Drizzle -> EventoAcesso do domínio (epoch ms, camelCase): o formato que a view devolve. */
export function paraDominio(r: LinhaEvento): EventoAcesso {
  return {
    id: r.id, seq: r.seq, formatoHash: r.formatoHash, tipo: r.tipo, categoriaPessoa: r.categoriaPessoa, pessoaId: r.pessoaId,
    unidadeDestinoId: r.unidadeDestinoId, areaComumId: r.areaComumId, pontoAcessoId: r.pontoAcessoId,
    autorizadoPorTipo: r.autorizadoPorTipo, autorizadoPorPessoaId: r.autorizadoPorPessoaId, autorizacaoPreviaId: r.autorizacaoPreviaId,
    justificativa: r.justificativa, restricaoId: r.restricaoId, operadorId: r.operadorId, operadorPapel: r.operadorPapel,
    ocorridoEm: r.ocorridoEm.getTime(), registradoEm: r.registradoEm.getTime(), retroativo: r.retroativo,
    refereEventoId: r.refereEventoId, corrigeEventoId: r.corrigeEventoId, observacao: r.observacao,
    formularioContingencia: r.formularioContingencia, correcaoValores: correcaoDoBanco(r.correcaoValores),
    empresa: r.empresa, servico: r.servico, veiculoPlaca: r.veiculoPlaca, veiculoModelo: r.veiculoModelo, veiculoCor: r.veiculoCor,
    hashAnterior: r.hashAnterior, hash: r.hash,
  };
}
