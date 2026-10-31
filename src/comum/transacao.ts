// Transação com retry curto para falha de serialização (40001) e deadlock (40P01). Skill `postgresql`: o Postgres
// desfaz a transação inteira nesses casos e a operação pode ser repetida do zero, sem efeito parcial.
//
// Só a transação toda é repetida, nunca um pedaço: o que já foi COMMITADO (ex.: o evento "negado") não roda de novo,
// porque o retry só acontece quando a transação falhou. Os outros erros (regra, CHECK, trigger) sobem na primeira vez.
import type { Db, Tx } from '../database/database.module';
import { codigoPg } from './erros';
import { log } from './log';

const REPETIVEIS = new Set(['40001', '40P01']);
export const TENTATIVAS_TRANSACAO = 3;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function transacaoComRetry<T>(db: Db, fn: (tx: Tx) => Promise<T>, tentativas = TENTATIVAS_TRANSACAO): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await db.transaction(fn);
    } catch (e) {
      const pg = codigoPg(e);
      if (!pg || !REPETIVEIS.has(pg) || n >= tentativas) throw e;
      log('warn', 'transacao.repetida', { codigo_pg: pg, detalhe: `tentativa ${n}` });
      // Espera curta e aleatória: as duas transações que colidiram não voltam no mesmo instante.
      await esperar(10 * n + Math.floor(Math.random() * 20));
    }
  }
}
