// Auditoria pela API real (RF-32, RF-37, RNF-01): verificação de integridade no banco, exportação verificável pelo
// verificador do domain e trilha de alterações paginada. A adulteração é feita como SUPERUSUÁRIO do PGlite (desliga o
// trigger append-only e mexe na tabela): é o ataque que o hash existe para revelar.
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lerExportacaoJsonl } from '../src/dominio/exportacao';
import { calcularHashExportado, verificarCadeia } from '../src/dominio/hashChain';
import { paraExportacao } from '../src/db/cadeia';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const JUST = 'Morador não atende o interfone, entrega urgente';

async function montar() {
  const api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  const cookies = {} as Record<PapelTeste, string>;
  for (const p of ['sindico', 'administracao', 'porteiro', 'auditor'] as PapelTeste[]) cookies[p] = (await api.como(p)).cookie;
  const pessoaId = async (nome: string) => (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  const [d32] = await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32')));
  const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
  const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
  /** n entradas por exceção (com saída), de pessoas do seed. */
  async function movimentar(n: number) {
    const pessoas = await Promise.all(['Marcos Pereira', 'Bruno Teixeira', 'Juliana Costa'].map(pessoaId));
    for (let i = 0; i < n; i++) {
      const e = await post('porteiro', '/eventos-acesso', { pessoaId: pessoas[i % 3], unidadeDestinoId: d32!.id, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
      if (e.status !== 201) throw new Error(`entrada falhou: ${JSON.stringify(e.body)}`);
      await post('porteiro', `/eventos-acesso/${e.body.data.id}/saida`);
    }
  }
  return { api, get, post, movimentar, pessoaId, d32: d32! };
}

/** Superusuário, sem o trigger append-only: o que o ataque faria. */
const semTrigger = (api: ApiDeTeste, sql: string) =>
  api.client.exec(`ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel; ${sql}; ALTER TABLE evento_acesso ENABLE TRIGGER evento_acesso_imutavel;`);

describe('verificação de integridade no banco (GET /auditoria/integridade)', () => {
  let m: Awaited<ReturnType<typeof montar>>;
  beforeAll(async () => { vi.spyOn(console, 'log').mockImplementation(() => undefined); m = await montar(); await m.movimentar(5); });
  afterAll(async () => { vi.restoreAllMocks(); await m.api.app.close(); await m.api.client.close(); });

  it('cadeia íntegra: verifica todos, até a cabeça; porteiro 403', async () => {
    expect((await m.get('porteiro', '/auditoria/integridade')).status).toBe(403);
    const r = await m.get('auditor', '/auditoria/integridade');
    expect(r.body.data).toMatchObject({ valido: true, verificados: 10, ultimoSeq: 10 });
    const [cab] = await m.api.db.select().from(s.eventoAcessoCadeia);
    expect(r.body.data.ultimoHash).toBe(cab!.ultimoHash);
  });

  it('selo diário confere; UPDATE forçado num campo do meio aponta hash_divergente no seq alterado', async () => {
    const [e8] = await m.api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, 8));
    await m.api.db.insert(s.seloCadeia).values({ data: '2026-10-17', ultimoSeq: 8, ultimoHash: e8!.hash });
    expect((await m.get('sindico', '/auditoria/integridade')).body.data).toMatchObject({ valido: true, selosConferidos: 1 });
    await semTrigger(m.api, `UPDATE evento_acesso SET justificativa = 'Justificativa trocada depois do fato' WHERE seq = 3`);
    const r = await m.get('auditor', '/auditoria/integridade');
    expect(r.body.data).toMatchObject({ valido: false, verificados: 2, primeiroSeqInvalido: 3, motivo: 'hash_divergente' });
  });
});

describe('ataques que mantêm a cadeia coerente por dentro', () => {
  let m: Awaited<ReturnType<typeof montar>>;
  beforeAll(async () => { vi.spyOn(console, 'log').mockImplementation(() => undefined); m = await montar(); await m.movimentar(4); });
  afterAll(async () => { vi.restoreAllMocks(); await m.api.app.close(); await m.api.client.close(); });

  it('remover o ÚLTIMO evento (sem lacuna no meio): a cabeça da cadeia denuncia (lacuna_de_seq)', async () => {
    await semTrigger(m.api, 'DELETE FROM evento_acesso WHERE seq = 8');
    const r = await m.get('auditor', '/auditoria/integridade');
    expect(r.body.data).toMatchObject({ valido: false, verificados: 7, ultimoSeq: 7, primeiroSeqInvalido: 8, motivo: 'lacuna_de_seq' });
  });

  it('adulterar e RECALCULAR a cadeia inteira (e a cabeça): só o selo denuncia (selo_divergente)', async () => {
    const [e5] = await m.api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, 5));
    await m.api.db.insert(s.seloCadeia).values({ data: '2026-10-16', ultimoSeq: 5, ultimoHash: e5!.hash });
    // Troca o operador do seq 4 e recalcula os hashes de 4 em diante, como faria quem conhece o algoritmo
    await semTrigger(m.api, `UPDATE evento_acesso SET observacao = 'inserido depois' WHERE seq = 4`);
    const linhas = await m.api.db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq));
    let anterior = linhas.find((l) => l.seq === 3)!.hash;
    for (const l of linhas.filter((x) => x.seq >= 4)) {
      const novo = await calcularHashExportado({ ...paraExportacao(l), hash_anterior: anterior });
      await semTrigger(m.api, `UPDATE evento_acesso SET hash_anterior = '${anterior}', hash = '${novo}' WHERE seq = ${l.seq}`);
      anterior = novo;
    }
    await m.api.client.exec(`UPDATE evento_acesso_cadeia SET ultimo_hash = '${anterior}', ultimo_seq = 7 WHERE id = 1`);
    // A cadeia, sozinha, parece íntegra...
    const recalculada = (await m.api.db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect((await verificarCadeia(recalculada)).valido).toBe(true);
    // ...mas não bate com o selo do seq 5
    const r = await m.get('auditor', '/auditoria/integridade');
    expect(r.body.data).toMatchObject({ valido: false, primeiroSeqInvalido: 5, motivo: 'selo_divergente' });
  });
});

describe('exportação verificável (POST /auditoria/exportacoes) e trilha de alterações', () => {
  let m: Awaited<ReturnType<typeof montar>>;
  beforeAll(async () => { vi.spyOn(console, 'log').mockImplementation(() => undefined); m = await montar(); await m.movimentar(4); });
  afterAll(async () => { vi.restoreAllMocks(); await m.api.app.close(); await m.api.client.close(); });

  it('período inteiro: manifesto v3, consecutivos, e o verificador do domain confere a partir da âncora', async () => {
    const r = await m.post('auditor', '/auditoria/exportacoes', {});
    expect(r.status).toBe(200);
    const p = r.body.data;
    expect(p.nomeArquivo).toMatch(/^trilha-condnexo-\d{8}-\d{4}\.jsonl$/);
    expect(p.quantidade).toBe(8);
    const { manifesto, eventos, resumo } = lerExportacaoJsonl(p.conteudo);
    expect(manifesto).toMatchObject({ formato: 'portaria-parque/trilha-jsonl', versao: 3, formatosHash: [1, 2], modo: 'trilha', consecutivos: true, quantidade: 8,
      geradoPor: 'Luíza Campos', ancora: { seq: 0 }, camposVeiculo: ['veiculo_placa', 'veiculo_modelo', 'veiculo_cor'] });
    expect(manifesto).not.toHaveProperty('formatoHash');
    expect(typeof manifesto.condominio === 'string' && manifesto.condominio.length > 0).toBe(true); // nome do condomínio da sessão, não texto fixo
    expect(String(manifesto.geradoEm)).not.toContain('simulado');
    expect(await verificarCadeia(eventos, manifesto.ancora)).toMatchObject({ valido: true, verificados: 8 });
    expect(resumo).toMatchObject({ quantidade: 8, ultimoSeq: 8 });
    // Nomes à parte ("exibicao"), fora do hash
    const linha = JSON.parse(p.conteudo.split('\n')[1]!);
    expect(linha.exibicao).toMatchObject({ codigo: 'EV-000001', unidade: 'D-32', pessoa: 'Marcos Pereira', operador: 'João Lima' });
    expect(linha.evento).not.toHaveProperty('exibicao');
  });

  it('filtrada: cada evento confere sozinho; consecutivos = false; o nome do filtro não vai para a trilha', async () => {
    const r = await m.post('administracao', '/auditoria/exportacoes', { tipo: 'saida' });
    const { manifesto, eventos } = lerExportacaoJsonl(r.body.data.conteudo);
    expect(manifesto).toMatchObject({ consecutivos: false, filtros: { tipo: 'saida' } });
    expect(eventos.map((e) => e.seq)).toEqual([2, 4, 6, 8]);
    for (const e of eventos) expect(await calcularHashExportado(e)).toBe(e.hash);
    const porNome = lerExportacaoJsonl((await m.post('administracao', '/auditoria/exportacoes', { tipo: 'saida', pessoa: 'bruno' })).body.data.conteudo);
    expect(porNome.manifesto).toMatchObject({ filtros: { tipo: 'saida', pessoa: 'bruno' }, quantidade: 1 });
    const reg = (await trilha(m.api, 'auditoria.exportar')).at(-1)!;
    expect(reg.depois).toMatchObject({ modo: 'trilha', filtros: { tipo: 'saida', pessoa: '(nome)' } });
    expect(JSON.stringify(reg.depois)).not.toContain('bruno');
  });

  it('evento isolado: confere o hash e liga com o anterior; inexistente 404; porteiro 403', async () => {
    const [e3] = await m.api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, 3));
    const [e2] = await m.api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, 2));
    const r = await m.post('sindico', '/auditoria/exportacoes', { eventoId: e3!.id });
    expect(r.body.data.nomeArquivo).toMatch(/^evento-EV-000003-\d{8}-\d{4}\.jsonl$/);
    const { manifesto, eventos } = lerExportacaoJsonl(r.body.data.conteudo);
    expect(manifesto).toMatchObject({ modo: 'evento_isolado', quantidade: 1, ancora: { seq: 2, hash: e2!.hash } });
    expect(await calcularHashExportado(eventos[0]!)).toBe(e3!.hash);
    expect(eventos[0]!.hash_anterior).toBe(e2!.hash);
    expect((await trilha(m.api, 'auditoria.exportar')).at(-1)!.registroId).toBe(e3!.id);
    expect((await m.post('sindico', '/auditoria/exportacoes', { eventoId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await m.post('porteiro', '/auditoria/exportacoes', { eventoId: e3!.id })).status).toBe(403);
  });

  it('trilha de alterações: paginada (mais recente primeiro), filtros por ação e entidade; SI/AD/AU; sem IP', async () => {
    const ana = await m.pessoaId('Ana Ribeiro');
    const bruno = await m.pessoaId('Bruno Teixeira');
    for (let i = 0; i < 3; i++) {
      const a = await m.post('porteiro', '/autorizacoes-previas', { unidadeId: m.d32.id, pessoaId: bruno, validaAte: '2026-10-30', solicitadaPorPessoaId: ana });
      expect(a.status).toBe(201);
    }
    const p1 = await m.get('auditor', '/auditoria/alteracoes?acao=autorizacao.criar&limite=2');
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.pagination.hasNextPage).toBe(true);
    const p2 = await m.get('auditor', `/auditoria/alteracoes?acao=autorizacao.criar&limite=2&cursor=${p1.body.pagination.cursor}`);
    expect(p2.body.data).toHaveLength(1);
    const seqs = [...p1.body.data, ...p2.body.data].map((r: { seq: number }) => r.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    expect(p1.body.data[0]).toMatchObject({ acao: 'autorizacao.criar', entidade: 'autorizacao_previa', usuarioNome: 'João Lima', usuarioPapel: 'porteiro' });
    expect(p1.body.data[0]).not.toHaveProperty('ip');
    const ent = await m.get('administracao', '/auditoria/alteracoes?entidade=autorizacao_previa&limite=100');
    expect(ent.body.data.every((r: { entidade: string }) => r.entidade === 'autorizacao_previa')).toBe(true);
    expect((await m.get('porteiro', '/auditoria/alteracoes')).status).toBe(403);
    expect((await m.get('auditor', '/auditoria/alteracoes?acao=DROP TABLE')).status).toBe(400);
  });
});
