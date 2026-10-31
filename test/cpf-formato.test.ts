// Formato da máscara do CPF (decisão de 2026-10-24) pela API real: cadastro novo no formato novo ("123.45*.***-**"),
// quem já está no antigo ("***.456.789-**") continua nele, e a REGRA ANTI-RECONSTRUÇÃO: o mesmo CPF (ou a mesma pessoa)
// nunca aparece nos dois formatos, nem na tabela pessoa nem nos snapshots do audit_log.
import { eq, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { documentoBusca, mascararCpf } from '../src/db/cpf';
import * as s from '../src/db/schema';
import { cpfComDv, seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { formatoParaCpf } from '../src/pessoas/formato-cpf';
import { type ApiDeTeste, novaApi, type PapelTeste } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const NOVO = /\d{3}\.\d{2}\*\.\*\*\*-\*\*/;
const ANTIGO = /\*\*\*\.\d{3}\.\d{3}-\*\*/;
let n = 0;
// Começo e meio diferentes a cada chamada: as máscaras de CPFs distintos não coincidem por acaso nos testes.
const novoCpf = () => cpfComDv(String(400_000_000 + ++n * 1_234_567));

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;

beforeAll(async () => {
  for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of ['administracao', 'porteiro'] as const) cookies[p] = (await api.como(p)).cookie;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const patch = (papel: PapelTeste, url: string, corpo: object) => api.http().patch(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const criar = async (corpo: object) => {
  const r = await post('administracao', '/pessoas', { telefone: '11912345678', categoria: 'visitante', ...corpo });
  expect(r.status).toBe(201);
  return r.body.data as { id: string; documentoMascarado: string };
};

/** Pessoa "de antes de 2026-10-24": máscara antiga, gravada direto (como as 7 de produção). */
async function pessoaLegada(nome: string, cpf: string) {
  const agora = api.relogio.agora();
  const [p] = await api.db.insert(s.pessoa).values({
    nome, categoria: 'visitante', telefone: '11912345678', documentoMascarado: mascararCpf(cpf, 'meio'),
    documentoBusca: documentoBusca(cpf, CHAVE_HMAC_TESTE), criadoEm: agora, atualizadoEm: agora,
  }).returning();
  return p!;
}

/** Tudo o que o banco guarda sobre a pessoa: a linha e os snapshots da trilha dela, num texto só. */
async function rastro(id: string) {
  const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.id, id));
  const t = await api.db.select({ antes: s.auditLog.antes, depois: s.auditLog.depois }).from(s.auditLog).where(eq(s.auditLog.registroId, id));
  expect(t.length).toBeGreaterThan(0);
  return JSON.stringify([p, t]);
}
/** Todos os snapshots e linhas do banco em que aparece uma máscara (para conferir um CPF entre pessoas diferentes). */
async function bancoTodo() {
  const ps = await api.db.select({ m: s.pessoa.documentoMascarado }).from(s.pessoa);
  const t = await api.db.select({ antes: s.auditLog.antes, depois: s.auditLog.depois }).from(s.auditLog);
  return JSON.stringify([ps, t]);
}

describe('formatoParaCpf (regra pura)', () => {
  const cpf = '52998224725';
  it('quem tem máscara mantém o formato; sem máscara, novo, salvo se a máscara antiga deste CPF já existe', () => {
    expect(formatoParaCpf(cpf, '***.111.222-**', new Set())).toBe('meio');
    expect(formatoParaCpf(cpf, '111.22*.***-**', new Set(['***.982.247-**']))).toBe('inicio'); // a pessoa não mistura formatos
    expect(formatoParaCpf(cpf, null, new Set())).toBe('inicio');
    expect(formatoParaCpf(cpf, '(sem CPF)', new Set())).toBe('inicio');
    expect(formatoParaCpf(cpf, null, new Set(['***.982.247-**']))).toBe('meio');
  });
});

describe('cadastro novo: formato novo', () => {
  it('pela rota de pessoas, na trilha também', async () => {
    const c = novoCpf();
    const p = await criar({ nome: 'Formato Novo', documento: c });
    expect(p.documentoMascarado).toBe(mascararCpf(c, 'inicio'));
    const r = await rastro(p.id);
    expect(r).toMatch(NOVO);
    expect(r).not.toMatch(ANTIGO);
    expect(r).not.toContain(c);
  });

  it('funcionário também', async () => {
    const c = novoCpf();
    const r = await post('administracao', '/funcionarios', { nome: 'Func Formato', documento: c, telefone: '11912345678', funcao: 'Zelador', escala: { diasSemana: [1], horaInicio: '08:00', horaFim: '17:00' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Func Formato'));
    expect(p!.documentoMascarado).toBe(mascararCpf(c, 'inicio'));
  });
});

describe('correção de CPF (PATCH /pessoas/:id)', () => {
  it('pessoa no formato antigo corrige: continua no antigo, e o formato novo não aparece nem na pessoa nem na trilha', async () => {
    const ana = (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro')))[0]!;
    expect(ana.documentoMascarado).toBe('***.982.247-**'); // seed: a pessoa fictícia no formato antigo
    const outro = await pessoaLegada('Legado Corrige', novoCpf());
    const correto = novoCpf();
    const r = await patch('administracao', `/pessoas/${outro.id}`, { documento: correto });
    expect(r.status).toBe(200);
    expect(r.body.data.documentoMascarado).toBe(mascararCpf(correto, 'meio'));
    const t = await rastro(outro.id);
    expect(t).toMatch(ANTIGO);
    expect(t).not.toMatch(NOVO);
    expect(t).not.toContain(correto);
  });

  it('pessoa no formato novo corrige: continua no novo', async () => {
    const p = await criar({ nome: 'Novo Corrige', documento: novoCpf() });
    const correto = novoCpf();
    const r = await patch('administracao', `/pessoas/${p.id}`, { documento: correto });
    expect(r.status).toBe(200);
    expect(r.body.data.documentoMascarado).toBe(mascararCpf(correto, 'inicio'));
    const t = await rastro(p.id);
    expect(t).toMatch(NOVO);
    expect(t).not.toMatch(ANTIGO);
  });

  it('sem CPF que passa a informar: formato novo', async () => {
    const p = await criar({ nome: 'Sem Cpf Informa', semCpf: true });
    const c = novoCpf();
    const r = await patch('administracao', `/pessoas/${p.id}`, { documento: c });
    expect(r.status).toBe(200);
    expect(r.body.data.documentoMascarado).toBe(mascararCpf(c, 'inicio'));
  });

  it('o MESMO CPF entre pessoas: o número liberado por quem estava no antigo não renasce no novo (cadastro, correção e importação)', async () => {
    // Legado com CPF errado (A) corrige para B: a máscara antiga de A fica no "antes" da trilha.
    const [a1, a2, a3, b] = [novoCpf(), novoCpf(), novoCpf(), novoCpf()];
    const legado = await pessoaLegada('Legado Libera', a1);
    expect((await patch('administracao', `/pessoas/${legado.id}`, { documento: b })).status).toBe(200);
    // Outra pessoa cadastrada com A: formato antigo, senão A sairia inteiro do banco (antigo + novo).
    const nova = await criar({ nome: 'Dona Do A', documento: a1 });
    expect(nova.documentoMascarado).toBe(mascararCpf(a1, 'meio'));
    // Sem CPF que informa um número liberado do mesmo jeito.
    const legado2 = await pessoaLegada('Legado Libera Dois', a2);
    expect((await patch('administracao', `/pessoas/${legado2.id}`, { documento: novoCpf() })).status).toBe(200);
    const sem = await criar({ nome: 'Sem Cpf Pega A2', semCpf: true });
    expect((await patch('administracao', `/pessoas/${sem.id}`, { documento: a2 })).body.data.documentoMascarado).toBe(mascararCpf(a2, 'meio'));
    // Importação de um número liberado.
    const legado3 = await pessoaLegada('Legado Libera Tres', a3);
    expect((await patch('administracao', `/pessoas/${legado3.id}`, { documento: novoCpf() })).status).toBe(200);
    const linhas = [{ linha: 2, bloco: 'A', unidade: '11', nome: 'Importado Pega A3', documento: a3, telefone: '' }];
    const an = await post('administracao', '/importacoes', { arquivo: 'a3.csv', linhas });
    expect(an.status).toBe(201);
    expect((await post('administracao', `/importacoes/${an.body.data.id}/confirmar`, { linhas })).status).toBe(200);
    const [imp] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Importado Pega A3'));
    expect(imp!.documentoMascarado).toBe(mascararCpf(a3, 'meio'));
    // Nenhum dos três números aparece no formato novo em lugar nenhum.
    const tudo = await bancoTodo();
    for (const c of [a1, a2, a3]) {
      expect(tudo).toContain(mascararCpf(c, 'meio'));
      expect(tudo).not.toContain(mascararCpf(c, 'inicio'));
      expect(tudo).not.toContain(c);
    }
  });
});

describe('importação: formato novo', () => {
  it('pessoa nova da planilha nasce no formato novo', async () => {
    const c = novoCpf();
    const linhas = [{ linha: 2, bloco: 'A', unidade: '12', nome: 'Importado Formato Novo', documento: c, telefone: '' }];
    const an = await post('administracao', '/importacoes', { arquivo: 'novo.csv', linhas });
    expect(an.status).toBe(201);
    expect(an.body.data.amostra[0].documento).toBe(mascararCpf(c, 'inicio'));
    expect((await post('administracao', `/importacoes/${an.body.data.id}/confirmar`, { linhas })).status).toBe(200);
    const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Importado Formato Novo'));
    expect(p!.documentoMascarado).toBe(mascararCpf(c, 'inicio'));
    expect(await rastro(p!.id)).not.toMatch(ANTIGO);
  });
});

describe('banco: CHECK da máscara (migração 0012)', () => {
  it('aceita os dois formatos e recusa CPF completo ou máscara fora do padrão', async () => {
    const ins = (m: string) => api.client.query(`INSERT INTO pessoa (nome, categoria, telefone, documento_mascarado, documento_busca)
      VALUES ('Check', 'visitante', '11912345678', $1, $2)`, [m, 'c'.repeat(63) + String(Math.floor(Math.random() * 10))]);
    for (const m of ['529.982.247-25', '52998224725', '529.982.***-**', '***.***.***-**', '529.98*.***-25']) {
      await expect(ins(m)).rejects.toThrow(/pessoa_documento_mascarado_ck/);
    }
    const n = await api.db.select({ n: sql<number>`count(*)::int` }).from(s.pessoa)
      .where(or(eq(s.pessoa.documentoMascarado, '***.982.247-**'), eq(s.pessoa.documentoMascarado, '529.98*.***-**')));
    expect(n[0]!.n).toBe(1); // só a Ana (antigo); o mesmo CPF no novo não existe
  });
});
