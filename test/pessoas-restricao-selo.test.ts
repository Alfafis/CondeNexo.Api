// Selo de restrição na lista do Cadastro (GET /pessoas) e na busca (POST /pessoas/busca): `restricao` com estado,
// unidade e total, sem motivo; uma consulta por página. Só para quem vê restrições (unidade.ver, a permissão das rotas
// /restricoes). A busca global do topo (POST /busca) não traz o campo.
import { and, eq } from 'drizzle-orm';
import type { Papel } from '../src/dominio/types';
import type { Contexto } from '../src/auth/tipos';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { PessoasController } from '../src/pessoas/pessoas.module';
import { PessoasService } from '../src/pessoas/pessoas.service';
import { type ApiDeTeste, novaApi, type PapelTeste } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const ids = {} as Record<string, string>;

type Linha = { id: string; nome: string; restricao?: unknown };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
  for (const nome of ['Ana Ribeiro', 'Bruno Teixeira', 'Marcos Pereira', 'Juliana Costa', 'Carla Mendes', 'Helena Duarte']) {
    ids[nome] = (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  }
  ids['D-32'] = (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32'))))[0]!.id;

  const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
  const unidade = { unidadeId: ids['D-32'], motivo: 'Morador não autoriza', validaAte: '2026-12-31', solicitadaPorPessoaId: ids['Ana Ribeiro'] };
  const condominio = { unidadeId: null, motivo: 'Afastado pela administração', validaAte: '2026-12-31', solicitadaPorPessoaId: null, paraTodoCondominio: true };
  // Bruno: ativa na D-32. Marcos: de condomínio pendente. Juliana: de condomínio aprovada. Helena: revogada (some).
  expect((await post('porteiro', '/restricoes', { ...unidade, pessoaId: ids['Bruno Teixeira'] })).status).toBe(201);
  expect((await post('porteiro', '/restricoes', { ...condominio, pessoaId: ids['Marcos Pereira'] })).status).toBe(201);
  const ju = await post('porteiro', '/restricoes', { ...condominio, pessoaId: ids['Juliana Costa'] });
  expect((await post('sindico', `/restricoes/${ju.body.data.id}/aprovar`)).status).toBe(200);
  const he = await post('porteiro', '/restricoes', { ...unidade, pessoaId: ids['Helena Duarte'] });
  expect((await post('administracao', `/restricoes/${he.body.data.id}/revogar`)).status).toBe(204);
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

/** Todas as páginas da lista (com desativados), pelo papel. */
async function lista(papel: PapelTeste) {
  const todas: Linha[] = [];
  let cursor: string | null = null;
  do {
    // Tipo explícito: o cursor usado na própria chamada deixaria `r` implícito (TS7022)
    const r: { status: number; body: { data: Linha[]; pagination: { cursor: string | null } } } = await api.http().get(`${V1}/pessoas`).query({ limite: 100, incluirDesativadas: 'true', ...(cursor ? { cursor } : {}) })
      .set('Cookie', cookies[papel]);
    expect(r.status).toBe(200);
    todas.push(...r.body.data);
    cursor = r.body.pagination.cursor;
  } while (cursor);
  return new Map(todas.map((p) => [p.nome, p]));
}

describe('selo de restrição na lista de pessoas', () => {
  it.each(PAPEIS)('%s: ativa com a unidade, de condomínio com unidade null, pendente, sem restrição e revogada', async (papel) => {
    const m = await lista(papel);
    expect(m.get('Bruno Teixeira')!.restricao).toEqual({ estado: 'ativa', unidadeCodigo: 'D-32', total: 1 });
    expect(m.get('Juliana Costa')!.restricao).toEqual({ estado: 'ativa', unidadeCodigo: null, total: 1 });
    expect(m.get('Marcos Pereira')!.restricao).toEqual({ estado: 'pendente', unidadeCodigo: null, total: 1 });
    expect(m.get('Carla Mendes')!.restricao).toBeNull();
    expect(m.get('Helena Duarte')!.restricao).toBeNull();
    // Sem motivo nem id de restrição: só o necessário para o selo
    expect(JSON.stringify([...m.values()])).not.toContain('Morador não autoriza');
  });

  it('ativa prevalece sobre pendente, e o total conta as do mesmo estado', async () => {
    const post = (papel: PapelTeste, corpo: object) => api.http().post(`${V1}/restricoes`).set('Cookie', cookies[papel]).send(corpo);
    expect((await post('administracao', { pessoaId: ids['Bruno Teixeira'], unidadeId: null, motivo: 'Outro pedido', validaAte: '2026-12-31',
      solicitadaPorPessoaId: null, paraTodoCondominio: true })).status).toBe(201);
    expect((await lista('administracao')).get('Bruno Teixeira')!.restricao).toEqual({ estado: 'ativa', unidadeCodigo: 'D-32', total: 1 });
  });

  it('vencida não conta', async () => {
    const antes = api.relogio.atual;
    api.relogio.atual = new Date('2027-01-02T12:00:00.000Z');
    try {
      const pessoas = await api.servico<PessoasService>(PessoasService);
      const r = await pessoas.listar('sindico', { limite: 100, incluirDesativadas: true });
      expect(r.itens.find((p) => p.nome === 'Bruno Teixeira')!.restricao).toBeNull();
    } finally { api.relogio.atual = antes; }
  });

  it('papel sem unidade.ver (nenhum hoje; o gate segue a matriz): o campo não vem', async () => {
    const pessoas = await api.servico<PessoasService>(PessoasService);
    const r = await pessoas.listar('sem_papel' as Papel, { limite: 100, incluirDesativadas: true });
    expect(r.itens.length).toBeGreaterThan(0);
    expect(r.itens.every((p) => !('restricao' in p))).toBe(true);
  });
});

/** Busca do Cadastro pelo nome exato (o primeiro resultado é a pessoa, pela ordem "nome exato" da busca). */
async function buscar(papel: PapelTeste, q: string) {
  const r = await api.http().post(`${V1}/pessoas/busca`).set('Cookie', cookies[papel]).send({ q, limite: 50, incluirDesativadas: true });
  expect(r.status).toBe(200);
  return r.body.data.pessoas as Linha[];
}

describe('selo de restrição na busca de pessoas', () => {
  it.each(PAPEIS)('%s: ativa com a unidade, de condomínio com unidade null, pendente, sem restrição e revogada', async (papel) => {
    const um = async (nome: string) => (await buscar(papel, nome)).find((p) => p.nome === nome)!;
    expect((await um('Bruno Teixeira')).restricao).toEqual({ estado: 'ativa', unidadeCodigo: 'D-32', total: 1 });
    expect((await um('Juliana Costa')).restricao).toEqual({ estado: 'ativa', unidadeCodigo: null, total: 1 });
    expect((await um('Marcos Pereira')).restricao).toEqual({ estado: 'pendente', unidadeCodigo: null, total: 1 });
    expect((await um('Carla Mendes')).restricao).toBeNull();
    expect((await um('Helena Duarte')).restricao).toBeNull();
  });

  it('sem motivo nem id de restrição; a busca por unidade traz o selo de todos da página', async () => {
    const r = await buscar('porteiro', 'D-32');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => 'restricao' in p)).toBe(true);
    const texto = JSON.stringify(r);
    expect(texto).not.toContain('Morador não autoriza');
    expect(texto).not.toContain('Afastado pela administração');
    expect(r.every((p) => p.restricao === null || Object.keys(p.restricao as object).sort().join() === 'estado,total,unidadeCodigo')).toBe(true);
  });

  it('a busca global do topo não traz o campo', async () => {
    const r = await api.http().post(`${V1}/busca`).set('Cookie', cookies.sindico).send({ q: 'Bruno' });
    expect(r.status).toBe(200);
    const pessoas = r.body.data.pessoas as Linha[];
    expect(pessoas.some((p) => p.nome === 'Bruno Teixeira')).toBe(true);
    expect(pessoas.every((p) => !('restricao' in p))).toBe(true);
  });

  it('papel sem unidade.ver (nenhum hoje; o gate segue a matriz): o campo não vem', async () => {
    const controle = await api.servico<PessoasController>(PessoasController);
    const ctx = { ator: { papel: 'sem_papel' as Papel } } as Contexto;
    const r = await controle.buscar(ctx, { q: 'Bruno Teixeira', limite: 50, semMoradores: false, incluirDesativadas: true });
    expect(r.pessoas.some((p) => p.nome === 'Bruno Teixeira')).toBe(true);
    expect(r.pessoas.every((p) => !('restricao' in p))).toBe(true);
  });
});
