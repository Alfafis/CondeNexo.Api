// Cadeia de hash do evento de acesso: cálculo no trigger x verificador TS independente (RF-32, RF-37, spec §4.3).
import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashGenese, jsonCanonicoV1, paraExportacao, verificarCadeia } from '../src/db/cadeia';
import * as s from '../src/db/schema';
import { type Db, type Fixtures, JUSTIFICATIVA, entradaBase, erroDe, inserirEvento, novoBanco } from './helpers/banco';
import type { PGlite } from '@electric-sql/pglite';

let client: PGlite;
let db: Db;
let fx: Fixtures;

const exportar = async () => (await db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);

/** Um de cada tipo de evento, com texto livre que exercita o escape JSON. */
async function popularCadeia() {
  const entrada = await inserirEvento(db, entradaBase(fx, { observacao: 'Disse: "volto já" \\ barra\nlinha 2\u0001 ção 😀' }));
  await inserirEvento(db, { ...entradaBase(fx), tipo: 'saida', autorizadoPorTipo: null, autorizadoPorPessoaId: null, refereEventoId: entrada.id });
  await inserirEvento(db, entradaBase(fx, { tipo: 'recusado', autorizadoPorTipo: 'morador_presente' }));
  await inserirEvento(db, entradaBase(fx, {
    pessoaId: fx.semCpf.id, autorizadoPorTipo: 'excecao_porteiro', autorizadoPorPessoaId: null, justificativa: JUSTIFICATIVA,
  }));
  await inserirEvento(db, entradaBase(fx, {
    categoriaPessoa: 'prestador', pessoaId: fx.prestador.id, unidadeDestinoId: null, areaComumId: fx.area.id,
    autorizadoPorTipo: 'excecao_porteiro', autorizadoPorPessoaId: null, justificativa: JUSTIFICATIVA, empresa: 'Elétrica Silva', servico: 'Reparo',
  }));
  await inserirEvento(db, entradaBase(fx, {
    categoriaPessoa: 'funcionario', pessoaId: fx.funcionarioPessoa.id, unidadeDestinoId: null, autorizadoPorTipo: 'escala', autorizadoPorPessoaId: null,
  }));
  await inserirEvento(db, entradaBase(fx, {
    retroativo: true, formularioContingencia: 'FC-0042', ocorridoEm: new Date(Date.now() - 3 * 3600_000),
  }));
  await inserirEvento(db, {
    tipo: 'correcao', categoriaPessoa: 'visitante', pessoaId: fx.visitante.id, unidadeDestinoId: fx.d32.id, pontoAcessoId: fx.ponto.id,
    operadorId: fx.admin.id, operadorPapel: 'administracao', corrigeEventoId: entrada.id, justificativa: 'Unidade digitada errada pelo porteiro',
    correcaoValores: { unidade_destino_id: fx.a11.id, ocorrido_em: '2026-10-17T08:15:00.123456-03:00', autorizado_por_pessoa_id: null },
  });
  return entrada;
}

beforeAll(async () => {
  ({ client, db, fx } = await novoBanco());
  await popularCadeia();
});

describe('cadeia de hash', () => {
  it('o verificador TS independente valida a cadeia gerada pelo trigger', async () => {
    const evs = await exportar();
    expect(evs).toHaveLength(8);
    expect(evs[0].hash_anterior).toBe(await hashGenese());
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: 8, ultimoSeq: 8, ultimoHash: evs[7].hash });
  });

  it('a serialização canônica do banco é idêntica à do TS, byte a byte', async () => {
    const { rows } = await client.query<{ seq: number; canon: string }>(
      'SELECT seq, evento_acesso_canonico(e) AS canon FROM evento_acesso e ORDER BY seq');
    const evs = await exportar();
    for (const [i, r] of rows.entries()) expect(r.canon).toBe(jsonCanonicoV1(evs[i]));
  });

  it('a cabeça da cadeia acompanha o último evento', async () => {
    const [cab] = await db.select().from(s.eventoAcessoCadeia);
    const evs = await exportar();
    expect(cab).toMatchObject({ ultimoSeq: evs.length, ultimoHash: evs[evs.length - 1].hash });
  });

  it('correção: valores normalizados (UTC com ms, ordem fixa) e dentro do hash', async () => {
    const [cor] = await db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.tipo, 'correcao'));
    expect(cor.correcaoValores).toEqual({
      unidade_destino_id: fx.a11.id, ocorrido_em: '2026-10-17T11:15:00.123Z', autorizado_por_pessoa_id: null,
    });
    expect(jsonCanonicoV1(paraExportacao(cor))).toContain(
      `"correcao_valores":{"unidade_destino_id":"${fx.a11.id}","ocorrido_em":"2026-10-17T11:15:00.123Z","autorizado_por_pessoa_id":null}`);
  });

  it('o servidor define seq, registrado_em, hash e (fora da contingência) ocorrido_em', async () => {
    const forjado = new Date('2020-01-01T00:00:00Z');
    const ev = await inserirEvento(db, entradaBase(fx, {
      seq: 999, hash: 'f'.repeat(64), hashAnterior: '0'.repeat(64), registradoEm: forjado, ocorridoEm: forjado,
    }));
    expect(ev.seq).toBe(9);
    expect(ev.registradoEm.getTime()).toBeGreaterThan(forjado.getTime());
    expect(ev.ocorridoEm.getTime()).toBe(ev.registradoEm.getTime());
    expect((await verificarCadeia(await exportar())).valido).toBe(true);
  });

  it('inserção rejeitada (CHECK) não avança a cadeia: sem lacuna de seq', async () => {
    const antes = (await db.select().from(s.eventoAcessoCadeia))[0].ultimoSeq;
    expect(await erroDe(inserirEvento(db, entradaBase(fx, { autorizadoPorTipo: null, autorizadoPorPessoaId: null }))))
      .toMatch(/evento_rn01_autorizado_por_ck/);
    const ev = await inserirEvento(db, entradaBase(fx));
    expect(ev.seq).toBe(antes + 1);
    expect((await verificarCadeia(await exportar())).valido).toBe(true);
  });

  it('inserções disparadas em paralelo mantêm a cadeia (no PGlite elas são serializadas; ver teste em Postgres real)', async () => {
    await Promise.all(Array.from({ length: 30 }, () => inserirEvento(db, entradaBase(fx))));
    const r = await verificarCadeia(await exportar());
    expect(r.valido).toBe(true);
    expect(r.ultimoSeq).toBe(r.verificados);
  });
});

describe('detecção de adulteração (superusuário desliga o trigger e mexe na tabela)', () => {
  it('alterar um campo do meio: hash_divergente no seq alterado', async () => {
    const { client: c, db: d, fx: f } = await novoBanco();
    for (let i = 0; i < 5; i++) await inserirEvento(d, entradaBase(f));
    await c.exec(`ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel;
      UPDATE evento_acesso SET observacao = 'apagando rastro' WHERE seq = 3;`);
    const evs = (await d.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: false, primeiroSeqInvalido: 3, motivo: 'hash_divergente', verificados: 2 });
  });

  it('apagar um evento do meio: lacuna_de_seq', async () => {
    const { client: c, db: d, fx: f } = await novoBanco();
    for (let i = 0; i < 5; i++) await inserirEvento(d, entradaBase(f));
    await c.exec(`ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel; DELETE FROM evento_acesso WHERE seq = 2;`);
    const evs = (await d.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: false, primeiroSeqInvalido: 3, motivo: 'lacuna_de_seq' });
  });
});

describe('retenção: descarte do prefixo da cadeia com selo (spec §9.1)', () => {
  it('descarta até o seq selado e a cadeia restante verifica a partir do selo', async () => {
    const { client: c, db: d, fx: f } = await novoBanco();
    for (let i = 0; i < 6; i++) await inserirEvento(d, entradaBase(f));
    const [e4] = await d.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, 4));
    // Sem selo no seq 4: recusado
    expect(await erroDe(c.query('SELECT retencao_descartar_prefixo(4)'))).toMatch(/não há selo no seq 4/);
    await d.insert(s.seloCadeia).values({ data: '2026-10-17', ultimoSeq: 4, ultimoHash: e4.hash });
    // Pelo caminho público: eventos recentes estão dentro do prazo de 3 anos
    expect(await erroDe(c.query('SELECT retencao_descartar_eventos(4)'))).toMatch(/dentro do prazo de retenção/);
    // Pelo caminho interno (só o dono): descarta seq 1..4
    const { rows } = await c.query<{ n: number }>('SELECT retencao_descartar_prefixo(4) AS n');
    expect(rows[0].n).toBe(4);
    const restantes = (await d.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(restantes.map((e) => e.seq)).toEqual([5, 6]);
    expect((await verificarCadeia(restantes)).valido).toBe(false); // sem âncora, parece começar do nada
    expect(await verificarCadeia(restantes, { seq: 4, hash: e4.hash })).toMatchObject({ valido: true, verificados: 2 });
    // A cadeia continua depois do descarte
    const e7 = await inserirEvento(d, entradaBase(f));
    expect(e7.seq).toBe(7);
    const [exec] = await d.select().from(s.retencaoExecucao);
    expect(exec).toMatchObject({ tipo: 'eventos', ateSeq: 4, quantidade: 4 });
  });

  it('DELETE direto continua bloqueado fora do procedimento controlado', async () => {
    const { client: c, db: d, fx: f } = await novoBanco();
    await inserirEvento(d, entradaBase(f));
    expect(await erroDe(c.query('DELETE FROM evento_acesso'))).toMatch(/append-only/);
  });
});

it('formato de instante: o banco serializa igual a Date.toISOString() (ms, UTC, Z)', async () => {
  const { rows } = await client.query<{ a: string }>(
    `SELECT canon_instante(timestamptz '2026-10-17 12:34:56.789-03') AS a`);
  expect(rows[0].a).toBe(`"${new Date('2026-10-17T15:34:56.789Z').toISOString()}"`);
});
