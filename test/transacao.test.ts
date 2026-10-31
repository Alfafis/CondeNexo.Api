// Retry curto de transação (skill postgresql): 40001 e 40P01 repetem a transação inteira; os outros erros sobem na hora.
import { describe, expect, it, vi } from 'vitest';
import { transacaoComRetry } from '../src/comum/transacao';
import type { Db } from '../src/database/database.module';

const erroPg = (code: string) => Object.assign(new Error('falha do driver'), { cause: { code } });

function dbFalso(falhas: string[]) {
  let n = 0;
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const f = falhas[n++];
    if (f) throw erroPg(f);
    return fn({});
  });
  return { db: { transaction } as unknown as Db, transaction };
}

describe('transacaoComRetry', () => {
  it('repete em 40001 e 40P01 até dar certo (no máximo 3 tentativas)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { db, transaction } = dbFalso(['40001', '40P01']);
    await expect(transacaoComRetry(db, async () => 'ok')).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(3);
  });
  it('desiste depois da terceira serialização e devolve o erro (o filtro responde 409)', async () => {
    const { db, transaction } = dbFalso(['40001', '40001', '40001', '40001']);
    await expect(transacaoComRetry(db, async () => 'ok')).rejects.toMatchObject({ cause: { code: '40001' } });
    expect(transaction).toHaveBeenCalledTimes(3);
  });
  it('não repete erro de regra ou de CHECK', async () => {
    const { db, transaction } = dbFalso(['23514']);
    await expect(transacaoComRetry(db, async () => 'ok')).rejects.toMatchObject({ cause: { code: '23514' } });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
