// Painel da plataforma (Fase A, spec 2026-10-31): GET /plataforma/painel (master e suporte) e /plataforma/painel/revelacoes
// (só master, pela guarda existente; substituiu /painel/leituras na Fase B, 2026-11-01). Contagens, blocos isolados (falha
// vira null sem derrubar o resto) e janela de 7 dias.
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nomeCookieMaster } from '../src/plataforma/cookie-master';
import { PainelMasterService } from '../src/plataforma/painel-master.service';
import { ancoraDiaria, condominio, masterUsuario, plataformaAudit } from '../src/plataforma/schema-plataforma';
import { criarUsuario } from '../src/plataforma/usuario-plataforma';
import { type ApiDeTeste, novaApi, novoIp } from './helpers/app';
import { provisionadorPglite } from './helpers/provisionador';
import { MESTRA_TESTE } from './helpers/saas';

const P = '/api/v1/plataforma';
const SENHA_M = 'senha-do-master-bem-longa-1';
const DIA = 86_400_000;

let api: ApiDeTeste;
let prov: ReturnType<typeof provisionadorPglite>;
let master: string;
let suporte: string;
let masterId: string;

async function novoMaster(email: string, papel: 'master' | 'suporte') {
  const c = await criarUsuario(api.plataforma.db, {
    hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
  }, { email, nome: `Operador ${papel}`, papel });
  await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
  const r = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', novoIp()).send({ email, senha: SENHA_M });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const linha = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!;
  return { cookie: linha.split(';')[0]!, id: c.id };
}

const painel = (cookie = master) => api.http().get(`${P}/painel`).set('Cookie', cookie);
const revelacoes = (cookie = master) => api.http().get(`${P}/painel/revelacoes`).set('Cookie', cookie);
const audit = (acao: string, detalhes: Record<string, unknown> | null, em: Date) =>
  api.plataforma.db.insert(plataformaAudit).values({ masterUsuarioId: masterId, acao, em, detalhes });

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  api = await novaApi({}, {
    provisionador: (c) => (prov = provisionadorPglite({ plataforma: c.plataforma, registro: c.registro, mestra: MESTRA_TESTE, gerarSenha: () => 'temp-sindico-unica-0001' })),
  });
  const m = await novoMaster('master@exemplo.test', 'master');
  master = m.cookie; masterId = m.id;
  suporte = (await novoMaster('suporte@exemplo.test', 'suporte')).cookie;
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await api.app.close();
  await api.client.close();
});

describe('GET /plataforma/painel', () => {
  it('sem sessão 401; master e suporte 200 com no-store', async () => {
    expect((await api.http().get(`${P}/painel`)).status).toBe(401);
    for (const c of [master, suporte]) {
      const r = await painel(c);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });

  it('contagens por status e plano (inclui encerrado/excluido) e os 5 mais recentes', async () => {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const status = ['ativo', 'ativo', 'suspenso', 'encerrado', 'excluido', 'provisionando', 'ativo'];
    for (const [i, st] of status.entries()) {
      await api.plataforma.db.insert(condominio).values({
        codigo: `painel-${i}`, nome: `Painel ${i}`, banco: `portaria_p${String(i).padStart(7, '0')}`, status: st, plano: i % 2 ? 'pro' : 'basico', criadoEm: new Date(base + i * DIA),
        encerradoEm: ['encerrado', 'excluido'].includes(st) ? new Date(base + i * DIA) : null,
      });
    }
    const todos = await api.plataforma.db.select().from(condominio);
    const esperado = (k: 'status' | 'plano') => todos.reduce<Record<string, number>>((a, c) => ({ ...a, [c[k]]: (a[c[k]] ?? 0) + 1 }), {});
    const r = await painel();
    const c = r.body.data.condominios;
    expect(c.porStatus).toEqual(esperado('status'));
    expect(c.porPlano).toEqual(esperado('plano'));
    expect(c.porStatus.excluido).toBe(1);
    expect(c.porStatus.encerrado).toBe(1);
    expect(c.recentes).toHaveLength(5);
    const ordenados = [...todos].sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime()).slice(0, 5);
    expect(c.recentes.map((x: { id: string }) => x.id)).toEqual(ordenados.map((x) => x.id));
    expect(Object.keys(c.recentes[0]).sort()).toEqual(['codigo', 'criadoEm', 'id', 'nome', 'status']);
  });

  it('provisionador: disponível, desligado e com falha (null), sem derrubar o resto', async () => {
    expect((await painel()).body.data.provisionador).toEqual({ disponivel: true });
    prov.ligado = false;
    try { expect((await painel()).body.data.provisionador).toEqual({ disponivel: false }); } finally { prov.ligado = true; }
    const svc = api.app.get(PainelMasterService) as unknown as { blocoProvisionador: () => Promise<unknown> };
    const spy = vi.spyOn(svc, 'blocoProvisionador').mockRejectedValue(new Error('segredo-interno'));
    try {
      const r = await painel();
      expect(r.status).toBe(200);
      expect(r.body.data.provisionador).toBeNull();
      expect(r.body.data.condominios).not.toBeNull();
      expect(r.body.data.ancora).not.toBeNull();
      expect(JSON.stringify(r.body)).not.toContain('segredo-interno');
    } finally { spy.mockRestore(); }
  });

  it('bloco do banco falha: só ele vira null (200)', async () => {
    const svc = api.app.get(PainelMasterService) as unknown as { blocoAncora: () => Promise<unknown> };
    const spy = vi.spyOn(svc, 'blocoAncora').mockRejectedValue(new Error('banco caiu'));
    try {
      const r = await painel();
      expect(r.status).toBe(200);
      expect(r.body.data.ancora).toBeNull();
      expect(r.body.data.condominios).not.toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('âncora: sem linhas = null e NÃO atrasada (nada escreve na tabela ainda); ontem em dia; anterior a ontem atrasada (dia BRT)', async () => {
    api.relogio.atual = new Date('2026-10-17T12:00:00.000Z'); // dia BRT 2026-10-17; ontem = 2026-10-16
    expect((await painel()).body.data.ancora).toEqual({ ultimaData: null, atrasada: false });
    const raiz = 'a'.repeat(64);
    await api.plataforma.db.insert(ancoraDiaria).values({ data: '2026-10-14', raiz, folhas: [] });
    expect((await painel()).body.data.ancora).toEqual({ ultimaData: '2026-10-14', atrasada: true });
    await api.plataforma.db.insert(ancoraDiaria).values({ data: '2026-10-16', raiz, folhas: [] });
    expect((await painel()).body.data.ancora).toEqual({ ultimaData: '2026-10-16', atrasada: false });
  });
});

describe('GET /plataforma/painel/revelacoes', () => {
  it('sem sessão 401; suporte 403 (guarda); master 200 com no-store e tudo zerado; /painel/leituras não existe mais', async () => {
    expect((await api.http().get(`${P}/painel/revelacoes`)).status).toBe(401);
    const s = await revelacoes(suporte);
    expect([s.status, s.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    const r = await revelacoes();
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.data).toEqual({ janelaDias: 7, total: 0, porEntidade: { pessoa: 0, veiculo: 0, ocorrencia: 0, encomenda: 0 } });
    expect((await api.http().get(`${P}/painel/leituras`).set('Cookie', master)).status).toBe(404);
  });

  it('conta condominio.revelar por entidade na janela; ignora leituras antigas e outras ações; não vaza id, rota nem IP', async () => {
    const agora = api.relogio.agora();
    const dentro = new Date(agora.getTime() - 3 * DIA);
    const fora = new Date(agora.getTime() - 8 * DIA);
    const reg = '11111111-1111-4111-8111-111111111111';
    await audit('condominio.revelar', { entidade: 'pessoa', registro_id: reg, rota: '/pessoas/:pessoaId/revelar', ip: '10.0.0.9' }, dentro);
    await audit('condominio.revelar', { entidade: 'pessoa', registro_id: reg }, dentro);
    await audit('condominio.revelar', { entidade: 'veiculo' }, dentro);
    await audit('condominio.revelar', { entidade: 'entidade-inventada-texto-livre' }, dentro); // conta no total, não vira chave
    await audit('condominio.revelar', { entidade: 'encomenda' }, fora);
    await audit('condominio.ler', { categoria: 'suporte' }, dentro); // leitura antiga (antes da Fase B): fora do bloco
    await audit('condominio.motivo', { categoria: 'suporte' }, dentro);
    const r = await revelacoes();
    expect(r.body.data).toEqual({ janelaDias: 7, total: 4, porEntidade: { pessoa: 2, veiculo: 1, ocorrencia: 0, encomenda: 0 } });
    const json = JSON.stringify(r.body);
    for (const proibido of [reg, '10.0.0.9', 'revelar', 'inventada', masterId]) expect(json).not.toContain(proibido);
  });
});
