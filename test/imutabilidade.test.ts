// Imutabilidade em 3 camadas (spec §4): permissões do app_rw, trigger append-only e hash (ver cadeia.test.ts).
// O PGlite roda como superusuário, mas SET ROLE aplica os privilégios do role: os testes de GRANT/REVOKE rodam
// aqui também. A versão em test/postgres-real repete o essencial com conexões reais (login como app_rw).
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { type Db, type Fixtures, comoAppRw, entradaBase, erroDe, inserirEvento, novoBanco } from './helpers/banco';

let client: PGlite;
let db: Db;
let fx: Fixtures;

beforeEach(async () => {
  ({ client, db, fx } = await novoBanco());
  await inserirEvento(db, entradaBase(fx));
  await db.insert(s.auditLog).values({
    usuarioId: fx.admin.id, usuarioNome: fx.admin.nome, usuarioPapel: 'administracao', acao: 'pessoa.criar',
    entidade: 'pessoa', registroId: fx.visitante.id, depois: { nome: 'Vítor Visitante', telefone: '(**) *****-4321', categoria: 'visitante' },
  });
  // Trigger de linha só dispara se houver linha: cada trilha precisa de ao menos um registro.
  const [oc] = await db.insert(s.ocorrencia).values({ tipo: 'dano', descricao: 'Portão riscado', abertaPorId: fx.porteiro.id }).returning();
  await db.update(s.ocorrencia).set({ status: 'em_andamento' }).where(eq(s.ocorrencia.id, oc.id));
  await db.insert(s.ocorrenciaStatusHistorico).values({ ocorrenciaId: oc.id, de: 'aberta', para: 'em_andamento', porId: fx.porteiro.id });
  await db.insert(s.retencaoExecucao).values({ tipo: 'pessoas', quantidade: 0 });
});

describe('camada 2: trigger append-only (vale até para o superusuário/dono)', () => {
  for (const tabela of ['evento_acesso', 'audit_log', 'ocorrencia_status_historico', 'retencao_execucao']) {
    it(`${tabela}: UPDATE, DELETE e TRUNCATE falham`, async () => {
      expect(await erroDe(client.query(`UPDATE ${tabela} SET id = id`))).toMatch(/append-only/);
      expect(await erroDe(client.query(`DELETE FROM ${tabela}`))).toMatch(/append-only/);
      expect(await erroDe(client.query(`TRUNCATE ${tabela} CASCADE`))).toMatch(/append-only/);
    });
  }

  it('evento_acesso: UPDATE de qualquer campo falha e o evento continua igual', async () => {
    const [antes] = await db.select().from(s.eventoAcesso);
    expect(await erroDe(db.update(s.eventoAcesso).set({ observacao: 'x' }))).toMatch(/append-only/);
    const [depois] = await db.select().from(s.eventoAcesso);
    expect(depois).toEqual(antes);
  });

  it('cabeça da cadeia não pode ser apagada', async () => {
    expect(await erroDe(client.query('DELETE FROM evento_acesso_cadeia'))).toMatch(/append-only/);
  });

  it('selo: hash que não confere é rejeitado; depois de criado, só o envio pode ser registrado, uma vez', async () => {
    expect(await erroDe(db.insert(s.seloCadeia).values({ data: '2026-10-17', ultimoSeq: 1, ultimoHash: 'a'.repeat(64) })))
      .toMatch(/selo não confere/);
    const [ev] = await db.select().from(s.eventoAcesso);
    const [selo] = await db.insert(s.seloCadeia).values({ data: '2026-10-17', ultimoSeq: 1, ultimoHash: ev.hash }).returning();
    expect(await erroDe(db.update(s.seloCadeia).set({ ultimoSeq: 0 }).where(eq(s.seloCadeia.id, selo.id)))).toMatch(/selo é imutável/);
    await db.update(s.seloCadeia).set({ enviadoPara: 'conselho@exemplo.org', enviadoEm: new Date() }).where(eq(s.seloCadeia.id, selo.id));
    expect(await erroDe(db.update(s.seloCadeia).set({ enviadoPara: 'outro@exemplo.org' }).where(eq(s.seloCadeia.id, selo.id))))
      .toMatch(/selo é imutável/);
    expect(await erroDe(client.query('DELETE FROM selo_cadeia'))).toMatch(/append-only/);
  });

  it('marcador de operação controlada sozinho não libera DELETE para quem não é dono', async () => {
    await comoAppRw(client, async () => {
      await client.exec("SELECT set_config('portaria.operacao', 'retencao_eventos', false)");
      expect(await erroDe(client.query('DELETE FROM evento_acesso'))).toMatch(/permission denied/);
    });
  });
});

describe('camada 1: privilégios do app_rw (SET ROLE)', () => {
  it('insere evento (o trigger SECURITY DEFINER avança a cadeia), mas não altera nem apaga', async () => {
    await comoAppRw(client, async () => {
      const ev = await inserirEvento(db, entradaBase(fx));
      expect(ev.seq).toBe(2);
      expect(await erroDe(client.query('UPDATE evento_acesso SET observacao = null'))).toMatch(/permission denied/);
      expect(await erroDe(client.query('DELETE FROM evento_acesso'))).toMatch(/permission denied/);
      expect(await erroDe(client.query('TRUNCATE evento_acesso'))).toMatch(/permission denied/);
    });
  });

  it('audit_log: insere e lê; não altera nem apaga', async () => {
    await comoAppRw(client, async () => {
      await db.insert(s.auditLog).values({ usuarioNome: 'desconhecido', acao: 'auth.login_falha', entidade: 'auth' });
      expect((await db.select().from(s.auditLog)).length).toBe(2);
      expect(await erroDe(client.query('UPDATE audit_log SET antes = null'))).toMatch(/permission denied/);
      expect(await erroDe(client.query('DELETE FROM audit_log'))).toMatch(/permission denied/);
    });
  });

  it('não mexe na cabeça da cadeia nem no registro de retenção', async () => {
    await comoAppRw(client, async () => {
      expect(await erroDe(client.query('UPDATE evento_acesso_cadeia SET ultimo_seq = 0'))).toMatch(/permission denied/);
      expect(await erroDe(client.query(`INSERT INTO retencao_execucao (tipo, quantidade) VALUES ('eventos', 0)`))).toMatch(/permission denied/);
    });
  });

  it('cadastros: sem DELETE (remoção lógica), com UPDATE', async () => {
    await comoAppRw(client, async () => {
      await db.update(s.pessoa).set({ telefone: '11911112222' }).where(eq(s.pessoa.id, fx.visitante.id));
      for (const t of ['pessoa', 'unidade', 'vinculo_unidade', 'usuario_sistema', 'encomenda', 'ocorrencia']) {
        expect(await erroDe(client.query(`DELETE FROM ${t}`))).toMatch(/permission denied/);
      }
    });
  });

  it('selo: app_rw registra o envio, mas não altera o hash selado', async () => {
    const [ev] = await db.select().from(s.eventoAcesso);
    await comoAppRw(client, async () => {
      const [selo] = await db.insert(s.seloCadeia).values({ data: '2026-10-18', ultimoSeq: 1, ultimoHash: ev.hash }).returning();
      expect(await erroDe(client.query(`UPDATE selo_cadeia SET ultimo_hash = '${'b'.repeat(64)}'`))).toMatch(/permission denied/);
      await db.update(s.seloCadeia).set({ enviadoPara: 'conselho@exemplo.org', enviadoEm: new Date() }).where(eq(s.seloCadeia.id, selo.id));
    });
  });

  it('funções: chama o descarte com prazo e a redação; não chama o descarte interno', async () => {
    await comoAppRw(client, async () => {
      expect(await erroDe(client.query('SELECT retencao_descartar_prefixo(1)'))).toMatch(/permission denied/);
      expect(await erroDe(client.query('SELECT retencao_descartar_eventos(1)'))).toMatch(/dentro do prazo de retenção/);
      expect(await erroDe(client.query(`SELECT lgpd_redigir_audit_pessoa('${fx.visitante.id}')`))).toMatch(/não está anonimizada/);
    });
  });
});

describe('LGPD: redação controlada do audit_log', () => {
  it('pessoa anonimizada: nome e telefone saem dos snapshots; o resto do registro fica', async () => {
    await db.update(s.pessoa).set({
      nome: 'Pessoa anonimizada', telefone: null, documentoMascarado: null, documentoBusca: null, anonimizadaEm: new Date(),
    }).where(eq(s.pessoa.id, fx.visitante.id));
    await comoAppRw(client, async () => {
      const { rows } = await client.query<{ n: number }>(`SELECT lgpd_redigir_audit_pessoa('${fx.visitante.id}') AS n`);
      expect(rows[0].n).toBe(1);
    });
    const [reg] = await db.select().from(s.auditLog).where(eq(s.auditLog.registroId, fx.visitante.id));
    expect(reg.depois).toEqual({ categoria: 'visitante' });
    expect(reg).toMatchObject({ acao: 'pessoa.criar', usuarioId: fx.admin.id });
    expect(reg.redigidoEm).not.toBeNull();
    // Fora da função, o UPDATE continua bloqueado
    expect(await erroDe(client.query('UPDATE audit_log SET depois = null'))).toMatch(/append-only/);
  });
});
