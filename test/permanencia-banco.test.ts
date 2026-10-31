// Tabela `permanencia` no banco (migração 0011): append-only nas duas camadas (privilégio do app_rw e trigger), regras do
// trigger de inserção, cascata no descarte da entrada por retenção e convivência com a anonimização LGPD.
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { type Db, type Fixtures, comoAppRw, entradaBase, erroDe, inserirEvento, novoBanco } from './helpers/banco';

const HORA = 3_600_000;
let client: PGlite;
let db: Db;
let fx: Fixtures;
let entrada: typeof s.eventoAcesso.$inferSelect;

const prazo = (valores: Partial<typeof s.permanencia.$inferInsert> = {}) => db.insert(s.permanencia).values({
  eventoEntradaId: entrada.id, ordem: 0, tipoVisita: 'visita', prazoAte: new Date(entrada.ocorridoEm.getTime() + 4 * HORA),
  motivo: 'entrada', definidoPorId: fx.porteiro.id, ...valores,
}).returning();

beforeEach(async () => {
  ({ client, db, fx } = await novoBanco());
  entrada = (await inserirEvento(db, entradaBase(fx)))!;
});

describe('trigger de inserção', () => {
  it('só entrada de visitante/prestador; prazo depois da entrada e até 12 h', async () => {
    const saida = await inserirEvento(db, { ...entradaBase(fx), tipo: 'saida', refereEventoId: entrada.id, autorizadoPorTipo: null, autorizadoPorPessoaId: null });
    expect(await erroDe(prazo({ eventoEntradaId: saida!.id }))).toMatch(/referenciar uma entrada/);
    const morador = await inserirEvento(db, { ...entradaBase(fx), categoriaPessoa: 'morador', pessoaId: fx.morador.id, autorizadoPorTipo: null, autorizadoPorPessoaId: null });
    expect(await erroDe(prazo({ eventoEntradaId: morador!.id }))).toMatch(/visitante e prestador/);
    expect(await erroDe(prazo({ prazoAte: entrada.ocorridoEm }))).toMatch(/fora do intervalo/);
    expect(await erroDe(prazo({ prazoAte: new Date(entrada.ocorridoEm.getTime() + 12 * HORA + 1) }))).toMatch(/fora do intervalo/);
    const [l] = await prazo();
    expect(l!.definidoEm).toBeInstanceOf(Date);
  });

  it('prorrogação: em sequência, mesmo tipo, prazo maior, máximo 4, uma por ordem e nunca depois da saída', async () => {
    const [l0] = await prazo();
    const p = (ordem: number, extra: Partial<typeof s.permanencia.$inferInsert> = {}) =>
      prazo({ ordem, motivo: 'prorrogacao', prazoAte: new Date(l0!.prazoAte.getTime() + ordem * HORA), ...extra });
    expect(await erroDe(p(2))).toMatch(/fora de sequência/);
    expect(await erroDe(p(1, { tipoVisita: 'entrega' }))).toMatch(/mantém o tipo/);
    expect(await erroDe(p(1, { prazoAte: l0!.prazoAte }))).toMatch(/estender o prazo/);
    // CHECK (roda depois do trigger): ordem 0 é a entrada, o resto é prorrogação
    expect(await erroDe(p(1, { motivo: 'entrada' }))).toMatch(/permanencia_motivo_ck/);
    await p(1);
    expect(await erroDe(p(1))).toMatch(/permanencia_evento_ordem_uq/);
    await p(2); await p(3); await p(4);
    expect(await erroDe(p(5))).toMatch(/permanencia_ordem_ck/);
    const outra = await inserirEvento(db, entradaBase(fx, { pessoaId: fx.prestador.id, categoriaPessoa: 'prestador', empresa: 'Elétrica Silva' }));
    const [o0] = await prazo({ eventoEntradaId: outra!.id, tipoVisita: 'servico', prazoAte: new Date(outra!.ocorridoEm.getTime() + HORA) });
    await inserirEvento(db, { ...entradaBase(fx), tipo: 'saida', pessoaId: fx.prestador.id, categoriaPessoa: 'prestador', refereEventoId: outra!.id, autorizadoPorTipo: null, autorizadoPorPessoaId: null });
    expect(await erroDe(prazo({ eventoEntradaId: outra!.id, ordem: 1, motivo: 'prorrogacao', tipoVisita: 'servico', prazoAte: new Date(o0!.prazoAte.getTime() + HORA) })))
      .toMatch(/já saiu/);
  });
});

describe('append-only', () => {
  it('camada 2: UPDATE, DELETE e TRUNCATE falham até para o dono', async () => {
    await prazo();
    expect(await erroDe(client.query(`UPDATE permanencia SET prazo_ate = prazo_ate + interval '1 hour'`))).toMatch(/append-only/);
    expect(await erroDe(client.query('DELETE FROM permanencia'))).toMatch(/append-only/);
    expect(await erroDe(client.query('TRUNCATE permanencia'))).toMatch(/append-only/);
    expect(await db.select().from(s.permanencia)).toHaveLength(1);
  });

  it('camada 1: app_rw lê e insere, mas não altera nem apaga', async () => {
    await comoAppRw(client, async () => {
      await prazo();
      expect(await db.select().from(s.permanencia)).toHaveLength(1);
      expect(await erroDe(client.query(`UPDATE permanencia SET prazo_ate = prazo_ate + interval '1 hour'`))).toMatch(/permission denied/);
      expect(await erroDe(client.query('DELETE FROM permanencia'))).toMatch(/permission denied/);
    });
  });
});

describe('retenção e LGPD', () => {
  it('o descarte da entrada por retenção leva o prazo junto (cascata), sem afrouxar o append-only', async () => {
    await prazo();
    await db.insert(s.seloCadeia).values({ data: '2026-10-17', ultimoSeq: entrada.seq, ultimoHash: entrada.hash });
    await client.query(`SELECT retencao_descartar_prefixo(${entrada.seq})`);
    expect(await db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.id, entrada.id))).toHaveLength(0);
    expect(await db.select().from(s.permanencia)).toHaveLength(0);
  });

  it('anonimizar o titular não toca o prazo (não há dado pessoal na tabela) e continua funcionando', async () => {
    await prazo();
    await client.query(`SELECT lgpd_anonimizar_titular('${fx.visitante.id}', 'pedido')`);
    const [p] = await db.select().from(s.pessoa).where(eq(s.pessoa.id, fx.visitante.id));
    expect(p!.anonimizadaEm).not.toBeNull();
    expect(await db.select().from(s.permanencia)).toHaveLength(1);
  });
});
