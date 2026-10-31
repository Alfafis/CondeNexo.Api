// Desativar/reativar o cadastro da pessoa (RF-02, spec §14 2026-10-22; migração 0009) pela API real (HTTP + PGlite).
// Não é exclusão: o histórico fica, a pessoa some das buscas, não entra e não recebe vínculo nem autorização.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { cpfComDv, seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const MOTIVO = 'Visitante não frequenta mais o condomínio';
const JUST = 'Morador não atende o interfone, entrega urgente';
const CPF_BRUNO = cpfComDv('697148503');

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const id = async (nome: string) => (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
const un = async (bloco: string, numero: string) =>
  (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, bloco), eq(s.unidade.numero, numero))))[0]!.id;
const desativar = (papel: PapelTeste, pid: string, motivo = MOTIVO) => post(papel, `/pessoas/${pid}/desativar`, { motivo });
const entrar = (pid: string, unidadeDestinoId: string) =>
  post('porteiro', '/eventos-acesso', { pessoaId: pid, unidadeDestinoId, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
const nomesDaBusca = async (papel: PapelTeste, q: string, extra: object = {}) =>
  ((await post(papel, '/pessoas/busca', { q, limite: 50, ...extra })).body.data.pessoas as { nome: string; desativadaEm: number | null }[]);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of ['sindico', 'administracao', 'porteiro', 'auditor'] as PapelTeste[]) cookies[p] = (await api.como(p)).cookie;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

describe('desativar cadastro: permissão e bloqueios', () => {
  it('porteiro e auditor recebem 403 (desativar e reativar); a negação vai para a trilha', async () => {
    const bruno = await id('Bruno Teixeira');
    for (const papel of ['porteiro', 'auditor'] as PapelTeste[]) {
      expect((await desativar(papel, bruno)).status).toBe(403);
      expect((await post(papel, `/pessoas/${bruno}/reativar`)).status).toBe(403);
    }
    expect((await trilha(api, 'acesso.negado')).at(-1)!.depois).toMatchObject({ acao: 'pessoa.desativar' });
    expect((await api.db.select().from(s.pessoa).where(eq(s.pessoa.id, bruno)))[0]!.desativadaEm).toBeNull();
  });

  it('motivo curto: 422 MOTIVO_OBRIGATORIO; sem motivo: 400 de validação; pessoa inexistente: 404', async () => {
    const bruno = await id('Bruno Teixeira');
    const r = await desativar('sindico', bruno, '  curto  ');
    expect([r.status, r.body.code]).toEqual([422, 'MOTIVO_OBRIGATORIO']);
    expect((await post('sindico', `/pessoas/${bruno}/desativar`, {})).status).toBe(400);
    expect((await desativar('sindico', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('com vínculo válido: 422 PESSOA_COM_VINCULO_VALIDO (encerrar antes)', async () => {
    const r = await desativar('administracao', await id('Ana Ribeiro'));
    expect([r.status, r.body.code]).toEqual([422, 'PESSOA_COM_VINCULO_VALIDO']);
  });

  it('dentro do condomínio: 422 PESSOA_DENTRO; depois da saída, desativa', async () => {
    const juliana = await id('Juliana Costa');
    const e = await entrar(juliana, await un('D', '32'));
    expect(e.status).toBe(201);
    const r = await desativar('administracao', juliana);
    expect([r.status, r.body.code]).toEqual([422, 'PESSOA_DENTRO']);
    expect((await post('porteiro', `/eventos-acesso/${e.body.data.id}/saida`)).status).toBe(201);
    expect((await desativar('administracao', juliana)).status).toBe(200);
  });

  it('funcionário ativo: 422 FUNCIONARIO_ATIVO', async () => {
    const f = await post('administracao', '/funcionarios', {
      nome: 'Zelador de Teste', documento: cpfComDv('912345670'), telefone: '11912340000', funcao: 'Zelador',
      escala: { diasSemana: [1, 2, 3, 4, 5], horaInicio: '08:00', horaFim: '17:00' },
    });
    expect(f.status).toBe(201);
    const r = await desativar('sindico', f.body.data.pessoaId);
    expect([r.status, r.body.code]).toEqual([422, 'FUNCIONARIO_ATIVO']);
  });
});

describe('desativar cadastro: efeitos', () => {
  let bruno: string;
  let autVigente: string;
  let autVencida: string;
  beforeAll(async () => {
    bruno = await id('Bruno Teixeira');
    const d32 = await un('D', '32');
    const a = await post('sindico', '/autorizacoes-previas', { unidadeId: d32, pessoaId: bruno, validaAte: '2027-01-31', justificativa: 'Primo do morador, vem cuidar do apartamento' });
    expect(a.status).toBe(201);
    autVigente = a.body.data.id;
    // Vencida (insere direto: a API não cria no passado): não é tocada.
    const [v] = await api.db.insert(s.autorizacaoPrevia).values({
      pessoaId: bruno, unidadeId: d32, validaDe: new Date('2026-01-01T03:00:00Z'), validaAte: new Date('2026-02-01T02:59:59Z'),
      semSolicitante: true, justificativa: 'Antiga, de quando reformava a cozinha', cadastradaPorId: (await api.db.select().from(s.usuarioSistema))[0]!.id,
    }).returning();
    autVencida = v!.id;
  });

  it('desativa: os três campos, autorização vigente revogada na mesma transação, trilha com o motivo só na linha da pessoa', async () => {
    const r = await desativar('administracao', bruno);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: bruno, desativacaoMotivo: MOTIVO, autorizacoesRevogadas: 1, desativadaEm: api.relogio.agora().getTime() });
    const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.id, bruno));
    expect(p!.desativadaPorId).not.toBeNull();
    const auts = await api.db.select().from(s.autorizacaoPrevia).where(eq(s.autorizacaoPrevia.pessoaId, bruno));
    expect(auts.find((a) => a.id === autVigente)!.revogadaEm).not.toBeNull();
    expect(auts.find((a) => a.id === autVencida)!.revogadaEm).toBeNull();
    const t = (await trilha(api, 'pessoa.desativar')).at(-1)!;
    expect(t.depois).toMatchObject({ desativacao_motivo: MOTIVO, autorizacoes_revogadas: [autVigente] });
    const rev = (await trilha(api, 'autorizacao.revogar')).filter((l) => l.registroId === autVigente);
    expect(rev).toHaveLength(1);
    expect(rev[0]!.depois).toMatchObject({ motivo: 'desativacao_da_pessoa', pessoa_desativada_id: bruno });
    expect(JSON.stringify(rev[0]!.depois)).not.toContain(MOTIVO);
  });

  it('desativar de novo: 409 PESSOA_JA_DESATIVADA', async () => {
    const r = await desativar('sindico', bruno);
    expect([r.status, r.body.code]).toEqual([409, 'PESSOA_JA_DESATIVADA']);
  });

  it('some da busca da portaria, da busca do topo e da lista; aparece com incluirDesativadas, marcada', async () => {
    expect((await nomesDaBusca('porteiro', 'Bruno')).map((p) => p.nome)).not.toContain('Bruno Teixeira');
    expect((await nomesDaBusca('porteiro', CPF_BRUNO)).map((p) => p.nome)).not.toContain('Bruno Teixeira');
    const g = await post('porteiro', '/busca', { q: 'Bruno' });
    expect(g.body.data.pessoas.map((p: { nome: string }) => p.nome)).not.toContain('Bruno Teixeira');
    const lista = (await get('administracao', '/pessoas?limite=100')).body.data.map((p: { nome: string }) => p.nome);
    expect(lista).not.toContain('Bruno Teixeira');
    const comDesativados = (await get('administracao', '/pessoas?limite=100&incluirDesativadas=true')).body.data as { nome: string; desativadaEm: number | null }[];
    expect(comDesativados.find((p) => p.nome === 'Bruno Teixeira')!.desativadaEm).toEqual(expect.any(Number));
    const busca = await nomesDaBusca('administracao', 'Bruno', { incluirDesativadas: true });
    expect(busca.find((p) => p.nome === 'Bruno Teixeira')!.desativadaEm).toEqual(expect.any(Number));
  });

  it('entrada recusada (422 PESSOA_DESATIVADA, nem retroativa), sem evento gravado; autorização e vínculo novos também', async () => {
    const d32 = await un('D', '32');
    const antes = (await api.db.select().from(s.eventoAcesso)).length;
    const e = await entrar(bruno, d32);
    expect([e.status, e.body.code]).toEqual([422, 'PESSOA_DESATIVADA']);
    expect(e.body.message).toMatch(/desativado/i);
    expect((await api.db.select().from(s.eventoAcesso)).length).toBe(antes);
    const a = await post('sindico', '/autorizacoes-previas', { unidadeId: d32, pessoaId: bruno, validaAte: '2027-01-31', justificativa: 'Primo do morador, vem cuidar do apartamento' });
    expect([a.status, a.body.code]).toEqual([422, 'PESSOA_DESATIVADA']);
    const v = await post('administracao', '/vinculos', { pessoaId: bruno, unidadeId: d32, tipo: 'dependente' });
    expect([v.status, v.body.code]).toEqual([422, 'PESSOA_DESATIVADA']);
  });

  it('a ficha mostra a desativação; o motivo só para quem pode reativar', async () => {
    expect((await get('administracao', `/pessoas/${bruno}`)).body.data.pessoa).toMatchObject({ desativadaEm: expect.any(Number), desativacaoMotivo: MOTIVO });
    const po = (await get('porteiro', `/pessoas/${bruno}`)).body.data.pessoa;
    expect(po.desativadaEm).toEqual(expect.any(Number));
    expect(po).not.toHaveProperty('desativacaoMotivo');
  });

  it('cadastrar de novo o mesmo CPF: 409 PESSOA_DUPLICADA com detalhes.desativada; o id só para quem pode reativar', async () => {
    const corpo = { nome: 'Bruno Teixeira', documento: CPF_BRUNO, telefone: '11987650013', categoria: 'visitante' };
    const adm = await post('administracao', '/pessoas', corpo);
    expect([adm.status, adm.body.code]).toEqual([409, 'PESSOA_DUPLICADA']);
    expect(adm.body.details).toEqual({ desativada: true, pessoaId: bruno });
    expect(adm.body.message).toMatch(/reative/i);
    const po = await post('porteiro', '/pessoas', corpo);
    expect([po.status, po.body.code]).toEqual([409, 'PESSOA_DUPLICADA']);
    expect(po.body.details).toEqual({ desativada: true });
    // Ativo duplicado: o id vai a quem acharia a pessoa pela busca por CPF (pessoa.ver), inclusive o porteiro
    const marcos = await id('Marcos Pereira');
    for (const papel of ['administracao', 'porteiro'] as PapelTeste[]) {
      const ativo = await post(papel, '/pessoas', { ...corpo, documento: cpfComDv('586037492') });
      expect([ativo.status, ativo.body.message]).toEqual([409, 'Já existe cadastro com este CPF.']);
      expect(ativo.body.details).toEqual({ desativada: false, pessoaId: marcos });
    }
  });

  it('importação: linha com o CPF de um desativado é recusada (PESSOA_DESATIVADA), sem vínculo legado', async () => {
    const r = await post('administracao', '/importacoes', { arquivo: 'moradores.csv', linhas: [
      { linha: 2, bloco: 'A', unidade: '11', nome: 'Bruno Teixeira', documento: CPF_BRUNO, telefone: '11987650013', tipo: 'Proprietário' },
    ] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ importaveis: 0, rejeitadas: 1 });
    expect(r.body.data.inconsistencias).toEqual([expect.objectContaining({ linha: 2, codigo: 'PESSOA_DESATIVADA', tipo: 'erro' })]);
  });

  it('reativar: limpa os campos, volta à busca e entra; a autorização revogada não volta; reativar de novo: 409', async () => {
    const r = await post('sindico', `/pessoas/${bruno}/reativar`);
    expect(r.status).toBe(200);
    expect(r.body.data.desativadaEm).toBeNull();
    const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.id, bruno));
    expect([p!.desativadaEm, p!.desativadaPorId, p!.desativacaoMotivo]).toEqual([null, null, null]);
    expect((await trilha(api, 'pessoa.reativar')).at(-1)!.antes).toMatchObject({ desativacao_motivo: MOTIVO });
    expect((await nomesDaBusca('porteiro', 'Bruno')).map((x) => x.nome)).toContain('Bruno Teixeira');
    const [a] = await api.db.select().from(s.autorizacaoPrevia).where(eq(s.autorizacaoPrevia.id, autVigente));
    expect(a!.revogadaEm).not.toBeNull();
    const e = await entrar(bruno, await un('D', '32'));
    expect(e.status).toBe(201);
    await post('porteiro', `/eventos-acesso/${e.body.data.id}/saida`);
    const de = await post('sindico', `/pessoas/${bruno}/reativar`);
    expect([de.status, de.body.code]).toEqual([409, 'PESSOA_JA_ATIVA']);
  });
});

describe('desativação e LGPD', () => {
  it('anonimizar um desativado: o motivo vira texto fixo no cadastro e sai dos snapshots da trilha da pessoa', async () => {
    const marcos = await id('Marcos Pereira');
    const motivo = 'Pediu para não ser mais cadastrado aqui';
    expect((await desativar('sindico', marcos, motivo)).status).toBe(200);
    const r = await post('sindico', `/lgpd/pessoas/${marcos}/anonimizar`);
    expect(r.status).toBe(200);
    const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.id, marcos));
    expect(p!.anonimizadaEm).not.toBeNull();
    expect(p!.desativadaEm).not.toBeNull();
    expect(p!.desativacaoMotivo).toBe('Removido na anonimização (LGPD)');
    const linhas = (await trilha(api)).filter((l) => l.entidade === 'pessoa' && l.registroId === marcos);
    expect(JSON.stringify(linhas.map((l) => [l.antes, l.depois]))).not.toContain(motivo);
    const re = await post('sindico', `/pessoas/${marcos}/reativar`);
    expect([re.status, re.body.code]).toEqual([409, 'PESSOA_ANONIMIZADA']);
  });

  it('o banco recusa estado parcial (CHECK pessoa_desativacao_ck)', async () => {
    const pid = await id('Cláudia Rocha');
    await expect(api.client.query(`UPDATE pessoa SET desativada_em = now() WHERE id = '${pid}'`)).rejects.toThrow(/pessoa_desativacao_ck/);
  });
});
