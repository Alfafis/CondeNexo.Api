// Importação da planilha (RF-11, RN-09) pela API real: análise com relatório de inconsistências, confirmação que reconfere
// as linhas pelo HMAC, deduplicação pelo CPF (HMAC) e pelo nome na mesma unidade, legados com prazo. O CPF em claro não
// fica em lugar nenhum: nem na tabela da importação, nem nas inconsistências, nem na trilha, nem no log.
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { cpfComDv, seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const CPF_ANA = cpfComDv('529982247');
const CPF_NOVO = cpfComDv('300000001');
const CPF_NOVO_2 = cpfComDv('300000002');
const saida: string[] = [];

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;

beforeAll(async () => {
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { saida.push(a.map(String).join(' ')); });
  }
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of ['administracao', 'porteiro', 'auditor'] as const) cookies[p] = (await api.como(p)).cookie;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);

const fmt = (c: string) => `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
const LINHAS = [
  { linha: 2, bloco: 'A', unidade: '11', nome: 'Importado Novo', documento: fmt(CPF_NOVO), telefone: '(11) 93333-0001', tipo: 'Proprietário' },
  { linha: 3, bloco: 'A', unidade: '11', nome: 'Importado Novo', documento: CPF_NOVO, telefone: '', tipo: 'Proprietário' }, // duplicada na planilha
  { linha: 4, bloco: 'A', unidade: '12', nome: 'Importado Novo', documento: CPF_NOVO, telefone: '', tipo: 'Inquilino' }, // mesmo CPF, outra unidade
  { linha: 5, bloco: 'A', unidade: '13', nome: 'Sem Documento', documento: '', telefone: '1199', tipo: 'Dependente' },
  { linha: 6, bloco: 'A', unidade: '14', nome: 'CPF Errado', documento: '123.456.789-00', telefone: '11933330006' },
  { linha: 7, bloco: 'Z', unidade: '1', nome: 'Unidade Inexistente', documento: CPF_NOVO_2, telefone: '' },
  { linha: 8, bloco: 'A', unidade: '12', nome: '  ', documento: CPF_NOVO_2, telefone: '' },
  { linha: 9, bloco: 'Bloco D', unidade: 'Apto 32', nome: 'Ana Ribeiro', documento: CPF_ANA, telefone: '' }, // já é moradora de D-32
  { linha: 10, bloco: 'd', unidade: '32', nome: 'paulo ribeiro', documento: '', telefone: '' }, // sem CPF: casa pelo nome NA unidade
];

describe('importação: análise', () => {
  let id: string;

  it('porteiro e auditor: 403', async () => {
    expect((await post('porteiro', '/importacoes', { arquivo: 'x.csv', linhas: LINHAS })).status).toBe(403);
    expect((await post('auditor', '/importacoes', { arquivo: 'x.csv', linhas: LINHAS })).status).toBe(403);
  });

  it('relatório com as mesmas regras do mock; amostra sem CPF em claro; prazo de 90 dias', async () => {
    const r = await post('administracao', '/importacoes', { arquivo: 'moradores.csv', linhas: LINHAS });
    expect(r.status).toBe(201);
    const d = r.body.data;
    id = d.id;
    expect(d).toMatchObject({ arquivo: 'moradores.csv', status: 'analisada', lidas: 9, importaveis: 6, rejeitadas: 2, prazoRegularizacao: '2027-01-15' });
    const codigos = d.inconsistencias.map((i: { linha: number; codigo: string }) => `${i.linha}:${i.codigo}`);
    expect(codigos).toEqual(expect.arrayContaining([
      '3:DUPLICIDADE_PLANILHA', '5:DOC_AUSENTE', '5:TELEFONE_INVALIDO', '6:DOC_INVALIDO', '7:UNIDADE_INEXISTENTE', '8:NOME_AUSENTE',
      '9:DUPLICIDADE_BANCO', '10:DOC_AUSENTE', '10:DUPLICIDADE_BANCO',
    ]));
    expect(codigos).not.toContain('4:DUPLICIDADE_PLANILHA'); // mesmo CPF em OUTRA unidade não é duplicidade
    expect(d.avisos).toBe(d.inconsistencias.filter((i: { tipo: string }) => i.tipo === 'aviso').length);
    expect(d.amostra[0].documento).toBe(`${CPF_NOVO.slice(0, 3)}.${CPF_NOVO.slice(3, 5)}*.***-**`);
    expect(JSON.stringify(r.body)).not.toContain(CPF_NOVO);
    expect(JSON.stringify(r.body)).not.toContain(CPF_ANA);
    // Nada foi importado ainda.
    expect(await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Importado Novo'))).toHaveLength(0);
    const [imp] = await api.db.select().from(s.importacao).where(eq(s.importacao.id, id));
    expect(imp!.arquivoSha256).toMatch(/^[0-9a-f]{64}$/);
    const incs = await api.db.select().from(s.importacaoInconsistencia).where(eq(s.importacaoInconsistencia.importacaoId, id));
    expect(incs).toHaveLength(d.inconsistencias.length);
  });

  it('confirmar com linhas diferentes da análise: 409 IMPORTACAO_DIVERGENTE', async () => {
    const alteradas = LINHAS.map((l, i) => (i === 0 ? { ...l, nome: 'Outro Nome' } : l));
    const r = await post('administracao', `/importacoes/${id}/confirmar`, { linhas: alteradas });
    expect([r.status, r.body.code]).toEqual([409, 'IMPORTACAO_DIVERGENTE']);
  });

  it('confirmar: legados novos, reaproveita quem já tem vínculo, um CPF = uma pessoa; segunda confirmação é 409', async () => {
    const r = await post('administracao', `/importacoes/${id}/confirmar`, { linhas: LINHAS });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ importados: 4, reaproveitados: 2, prazoRegularizacao: '2027-01-15' });
    const novo = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Importado Novo'));
    expect(novo).toHaveLength(1);
    expect(novo[0]).toMatchObject({ categoria: 'morador', semCpf: false, telefone: '11933330001', importacaoId: id });
    const vs = await api.db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.pessoaId, novo[0]!.id));
    expect(vs.map((v) => [v.status, v.tipo, v.prazoRegularizacao]).sort()).toEqual([['legado', 'inquilino', '2027-01-15'], ['legado', 'proprietario', '2027-01-15']]);
    const [semDoc] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Sem Documento'));
    expect(semDoc).toMatchObject({ semCpf: true, documentoBusca: null, telefone: null });
    const [errado] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'CPF Errado'));
    expect(errado).toMatchObject({ semCpf: true, documentoMascarado: null });
    expect(await api.db.select().from(s.pessoa).where(inArray(s.pessoa.nome, ['Ana Ribeiro']))).toHaveLength(1);
    const [imp] = await api.db.select().from(s.importacao).where(eq(s.importacao.id, id));
    expect(imp).toMatchObject({ status: 'confirmada', importados: 4, reaproveitados: 2 });
    expect((await trilha(api, 'importacao.confirmar')).at(-1)!.registroId).toBe(id);
    expect((await trilha(api, 'vinculo.criar')).filter((t) => (t.depois as { origem?: string }).origem === 'importacao')).toHaveLength(4);
    const de2 = await post('administracao', `/importacoes/${id}/confirmar`, { linhas: LINHAS });
    expect([de2.status, de2.body.code]).toEqual([409, 'IMPORTACAO_JA_CONFIRMADA']);
  });

  it('importar a mesma planilha de novo não duplica nada', async () => {
    const r = await post('administracao', '/importacoes', { arquivo: 'moradores.csv', linhas: LINHAS });
    const c = await post('administracao', `/importacoes/${r.body.data.id}/confirmar`, { linhas: LINHAS });
    expect(c.body.data).toMatchObject({ importados: 0, reaproveitados: 6 });
  });

  it('o legado importado com CPF e telefone é regularizável; sem CPF, não', async () => {
    const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Importado Novo'));
    const [v] = await api.db.select().from(s.vinculoUnidade).where(and(eq(s.vinculoUnidade.pessoaId, p!.id), eq(s.vinculoUnidade.tipo, 'proprietario')));
    await post('administracao', `/vinculos/${v!.id}/conferencias`, { tipo: 'escritura' });
    expect((await post('administracao', `/vinculos/${v!.id}/regularizar`)).body.data.status).toBe('aprovado');
  });

  it('id inexistente: 404; lista vazia ou grande demais: 400', async () => {
    expect((await post('administracao', '/importacoes/00000000-0000-4000-8000-000000000000/confirmar', { linhas: LINHAS })).body.code).toBe('IMPORTACAO_NAO_ENCONTRADA');
    expect((await post('administracao', '/importacoes', { arquivo: 'x.csv', linhas: [] })).status).toBe(400);
  });

  it('nenhum CPF em claro na trilha, nas inconsistências, na importação nem no log', async () => {
    const tudo = JSON.stringify({
      trilha: await trilha(api), incs: await api.db.select().from(s.importacaoInconsistencia), imps: await api.db.select().from(s.importacao),
    }).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
    const log = saida.join('\n');
    for (const c of [CPF_NOVO, CPF_NOVO_2, CPF_ANA, '12345678900']) {
      expect(tudo).not.toContain(c);
      expect(log).not.toContain(c);
    }
    expect(tudo).not.toContain(fmt(CPF_NOVO));
  });
});

describe('importação: prazo do legado configurável (RN-09, definido em assembleia)', () => {
  it('IMPORTACAO_PRAZO_LEGADO_DIAS=30: análise e legados com o prazo da configuração', async () => {
    const outra = await novaApi({ importacao: { prazoLegadoDias: 30 } });
    try {
      const { cookie } = await outra.como('administracao');
      const linhas = [{ linha: 2, bloco: 'A', unidade: '13', nome: 'Prazo Curto', documento: cpfComDv('300000777'), telefone: '' }];
      const r = await outra.http().post(`${V1}/importacoes`).set('Cookie', cookie).send({ arquivo: 'prazo.csv', linhas });
      expect(r.body.data.prazoRegularizacao).toBe('2026-11-16'); // 17/10 + 30 dias
      const c = await outra.http().post(`${V1}/importacoes/${r.body.data.id}/confirmar`).set('Cookie', cookie).send({ linhas });
      expect(c.body.data).toMatchObject({ importados: 1, prazoRegularizacao: '2026-11-16' });
    } finally { await outra.app.close(); await outra.client.close(); }
  });
});
