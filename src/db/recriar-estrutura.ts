// Troca TODAS as unidades pela estrutura configurada (CLI recriar-estrutura; ver lá o uso). Separado da CLI para os
// testes rodarem o mesmo código no PGlite com as migrações reais.
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { codigoUnidade, compararUnidades, gerarUnidades, type ConfigEstrutura } from '../dominio/units';
import { auditLog, unidade } from './schema';

const ORIGEM = '(recriar-estrutura)';

export type ResultadoRecriar =
  | { resultado: 'nada_a_fazer'; antes: number }
  | { resultado: 'simulado' | 'aplicado'; antes: number; depois: number };

class Simulacao extends Error {
  constructor(readonly antes: number) { super('simulação'); }
}

/**
 * Numa transação: se o banco já tem exatamente a estrutura (todas ativas), nada; senão apaga todas as unidades pela
 * função unidade_descartar_estrutura() (recusa com 23503 se alguma tiver referência), insere a estrutura e grava o
 * audit_log. Sem `aplicar`, faz tudo e desfaz (ROLLBACK): a simulação passa pelas mesmas checagens.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aceita qualquer driver (PGlite, node-postgres) e schema
export async function recriarEstrutura(db: PgDatabase<PgQueryResultHKT, any>, estrutura: ConfigEstrutura, aplicar: boolean): Promise<ResultadoRecriar> {
  const alvo = gerarUnidades(estrutura); // valida a configuração antes de tocar no banco
  const codigosAlvo = alvo.map(codigoUnidade);
  try {
    return await db.transaction(async (tx) => {
      const atuais = (await tx.select({ bloco: unidade.bloco, numero: unidade.numero, ativo: unidade.ativo }).from(unidade)).sort(compararUnidades);
      const codigosAtuais = atuais.map(codigoUnidade);
      if (atuais.every((u) => u.ativo) && codigosAtuais.length === codigosAlvo.length
        && new Set([...codigosAtuais, ...codigosAlvo]).size === codigosAlvo.length) {
        return { resultado: 'nada_a_fazer' as const, antes: atuais.length };
      }
      // Recusa (23503) se alguma unidade for referenciada; trava a tabela até o fim desta transação.
      await tx.execute(sql`SELECT unidade_descartar_estrutura()`);
      await tx.insert(unidade).values(alvo.map((u) => ({ bloco: u.bloco, numero: u.numero })));
      await tx.insert(auditLog).values({
        usuarioId: null, usuarioPapel: null, usuarioNome: ORIGEM, acao: 'unidade.recriarEstrutura', entidade: 'unidade', registroId: null,
        antes: { quantidade: atuais.length, unidades: codigosAtuais, inativas: atuais.filter((u) => !u.ativo).map(codigoUnidade) },
        depois: { quantidade: alvo.length, agrupamento: estrutura.agrupamento, unidades: codigosAlvo },
      });
      if (!aplicar) throw new Simulacao(atuais.length);
      return { resultado: 'aplicado' as const, antes: atuais.length, depois: alvo.length };
    });
  } catch (e) {
    if (e instanceof Simulacao) return { resultado: 'simulado', antes: e.antes, depois: alvo.length };
    throw e;
  }
}
