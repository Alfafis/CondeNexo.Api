// App do Master na API (F5, entrega 1; src/plataforma): login com e-mail e senha (sem 2º fator desde 2026-10-23, SAAS-08),
// sessão e cookie próprios, guarda,
// trilha da plataforma, troca de senha obrigatória, limite de tentativas, cookies cruzados com o condomínio, lista de
// condomínios, provisionamento pela tela (provisionar() de verdade sobre PGlite) e módulos.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { SENHA_MIN_MASTER } from '../src/dominio/rbac-plataforma';
import { problemasDaSenha, SenhaService } from '../src/auth/senha.service';
import { CondominiosMasterService } from '../src/plataforma/condominios-master.service';
import { ResolvedorCondominio } from '../src/tenancy/resolvedor';
import { nomeCookieMaster } from '../src/plataforma/cookie-master';
import { ProvisionadorHttp, provisionadorDoAmbiente } from '../src/plataforma/provisionador';
import { criarUsuario } from '../src/plataforma/usuario-plataforma';
import { masterSessao, masterUsuario, plataformaAudit, condominio } from '../src/plataforma/schema-plataforma';
import { type ApiDeTeste, novaApi, novoIp, trilha } from './helpers/app';
import { provisionadorPglite } from './helpers/provisionador';
import { MESTRA_TESTE } from './helpers/saas';
import { hash } from '@node-rs/argon2';

const P = '/api/v1/plataforma';
const SENHA_M = 'senha-do-master-bem-longa-1';

const ENTRADA = {
  codigo: 'vila-sul',
  nome: 'Residencial Vila Sul',
  cidade: 'Santos',
  uf: 'SP',
  estrutura: { agrupamento: 'Bloco', blocos: ['A', 'B'], andares: [1, 2], finais: [1, 2], ausentes: [] },
  sindico: { nome: 'Síndico Fictício', login: 'sindico.vila' },
};

let api: ApiDeTeste;
let prov: ReturnType<typeof provisionadorPglite>;
const logs: string[] = [];

async function novoMaster(email: string, o: { papel?: 'master' | 'suporte'; trocaPendente?: boolean } = {}) {
  const c = await criarUsuario(api.plataforma.db, {
    hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
  }, { email, nome: `Operador ${email.split('@')[0]}`, papel: o.papel ?? 'master' });
  if (!o.trocaPendente) {
    await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
  }
  return c.id;
}

function login(email: string, senha = SENHA_M, ip = novoIp()) {
  return api.http().post(`${P}/auth/login`).set('X-Forwarded-For', ip).send({ email, senha });
}

function cookieM(r: { headers: Record<string, unknown> }) {
  const linhas = r.headers['set-cookie'] as string[];
  const l = linhas.find((x) => x.startsWith(nomeCookieMaster(true)))!;
  return l.split(';')[0]!;
}

async function entrarMaster(email: string) {
  const r = await login(email);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return cookieM(r);
}

async function trilhaP(acao: string) {
  return (await api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, acao))).sort((a, b) => a.seq - b.seq);
}

beforeAll(async () => {
  for (const k of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  }
  api = await novaApi({}, {
    provisionador: (c) => (prov = provisionadorPglite({ plataforma: c.plataforma, registro: c.registro, mestra: MESTRA_TESTE, gerarSenha: () => 'temp-sindico-unica-0001' })),
  });
  await novoMaster('master@exemplo.test');
  await novoMaster('novo@exemplo.test', { trocaPendente: true });
  await novoMaster('suporte@exemplo.test', { papel: 'suporte' });
  await novoMaster('alvo@exemplo.test');
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await api.app.close();
  await api.client.close();
});

describe('login com e-mail e senha (sem segundo fator)', () => {
  it('sucesso: cookie próprio (nome, Path, HttpOnly, Secure, SameSite=Strict), sessão de 12 h com 2 h de inatividade, trilha com IP', async () => {
    const ip = novoIp();
    const r = await login('Master@Exemplo.test', SENHA_M, ip);
    expect(r.status).toBe(200);
    expect(r.body.data.usuario).toEqual({ id: expect.any(String), nome: 'Operador master', email: 'master@exemplo.test', papel: 'master', deveTrocarSenha: false });
    expect(r.body.data.sessao.inatividadeMin).toBe(120);
    expect(new Date(r.body.data.sessao.expiraEm).getTime() - api.relogio.agora().getTime()).toBe(12 * 3600_000);
    const sc = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('__Secure-portaria_plataforma='))!;
    expect(sc).toMatch(/; Path=\/api\/v1\/plataforma/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Strict/);
    expect(sc).not.toMatch(/Domain=/i);
    expect(r.headers['cache-control']).toBe('no-store');
    const me = await api.http().get(`${P}/auth/me`).set('Cookie', cookieM(r));
    expect(me.status).toBe(200);
    expect(me.body.data.usuario.email).toBe('master@exemplo.test');
    const [l] = (await trilhaP('auth.login')).slice(-1);
    expect(l!.masterUsuarioId).toBe(r.body.data.usuario.id);
    expect((l!.detalhes as { ip: string }).ip).toBe(ip);
    // Só o hash do token no banco.
    const [sess] = await api.plataforma.db.select().from(masterSessao).where(eq(masterSessao.masterUsuarioId, r.body.data.usuario.id));
    expect(sess!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookieM(r)).not.toContain(sess!.tokenHash);
    const [u] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, r.body.data.usuario.id));
    expect(u!.ultimoAcesso).not.toBeNull();
  });

  it('senha errada e e-mail inexistente: mesma resposta, mesmo argon2 (hash fictício), motivo e IP na trilha, e-mail digitado nunca gravado', async () => {
    const senhas = api.app.get(SenhaService, { strict: false });
    const ficticio = vi.spyOn(senhas, 'verificarFicticio');
    const ip = novoIp();
    const respostas = [await login('master@exemplo.test', 'senha-errada-errada', ip), await login('ninguem@exemplo.test', SENHA_M, ip)];
    for (const r of respostas) {
      expect([r.status, r.body.code, r.body.message]).toEqual([401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos.']);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    // Só o e-mail inexistente passa pelo hash fictício (que roda o argon2 do mesmo jeito): o custo das duas é igual.
    expect(ficticio.mock.calls.length).toBe(1);
    ficticio.mockRestore();
    const falhas = (await trilhaP('auth.login_falha')).slice(-2).map((l) => l.detalhes as { motivo: string; ip: string });
    expect(falhas).toEqual([{ motivo: 'senha_incorreta', ip }, { motivo: 'login_inexistente', ip }]);
    const tudo = JSON.stringify(await api.plataforma.db.select().from(plataformaAudit));
    expect(tudo).not.toContain('ninguem@exemplo.test');
    expect(tudo).not.toContain('senha-errada');
  });

  it('o corpo é estrito: o antigo campo `codigo` (ou qualquer outro) é 400, sem tocar no limite', async () => {
    const r = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', novoIp()).send({ email: 'master@exemplo.test', senha: SENHA_M, codigo: '123456' });
    expect([r.status, r.body.code]).toEqual([400, 'DADOS_INVALIDOS']);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect((await api.http().post(`${P}/auth/login`).send({ email: 'master@exemplo.test' })).status).toBe(400);
  });

  it('bloqueio pelo par e-mail+IP: a 11ª tentativa recebe 429 com Retry-After, mesmo com a senha certa', async () => {
    const ip = novoIp();
    for (let i = 0; i < 10; i++) expect((await login('alvo@exemplo.test', 'senha-errada-x', ip)).status).toBe(401);
    const r = await login('alvo@exemplo.test', SENHA_M, ip);
    expect([r.status, r.body.code]).toEqual([429, 'LOGIN_BLOQUEADO']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    const bloqueio = (await trilhaP('auth.bloqueio')).find((l) => (l.detalhes as { tipo: string }).tipo === 'master_ip');
    expect((bloqueio!.detalhes as { ip: string }).ip).toBe(ip);
    // Outro IP continua entrando (o login sozinho não bloqueia).
    expect((await login('alvo@exemplo.test', SENHA_M)).status).toBe(200);
  });
});

describe('sessão e cookie', () => {
  it('cookie cruzado é recusado nos dois sentidos (inclusive trocando o valor de nome)', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const sindico = (await api.como('sindico')).cookie;
    // Cookie de condomínio na plataforma (com e sem X-Condominio): 401.
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', sindico)).status).toBe(401);
    expect((await api.http().get(`${P}/condominios`).set('Cookie', sindico).set('X-Condominio', 'piloto')).status).toBe(401);
    // Cookie da plataforma no condomínio: 401.
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', m)).status).toBe(401);
    expect((await api.http().get('/api/v1/pessoas').set('Cookie', m)).status).toBe(401);
    // Token de um no nome do outro: não existe na tabela do outro banco.
    const tokenM = m.split('=')[1]!;
    const [nomeC, valorC] = sindico.split('=');
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', `${nomeC}=${tokenM}`)).status).toBe(401);
    const tokenC = valorC!.split('.').pop()!;
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', `${nomeCookieMaster(true)}=${tokenC}`)).status).toBe(401);
    // Os dois juntos: cada lado só enxerga o seu.
    const ambos = `${m}; ${sindico}`;
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', ambos)).body.data.usuario.email).toBe('master@exemplo.test');
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', ambos)).body.data.usuario.login).toBe('carlos.andrade');
  });

  it('logout revoga (204, depois 401) e grava trilha', async () => {
    const m = await entrarMaster('master@exemplo.test');
    expect((await api.http().post(`${P}/auth/logout`).set('Cookie', m)).status).toBe(204);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', m)).status).toBe(401);
    expect((await trilhaP('auth.logout')).length).toBeGreaterThan(0);
  });

  it('inatividade de 2 h derruba a sessão; o uso renova', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const me = async () => (await api.http().get(`${P}/auth/me`).set('Cookie', m)).status;
    api.relogio.avancarMin(119);
    expect(await me()).toBe(200);
    api.relogio.avancarMin(120);
    expect(await me()).toBe(401);
  });

  it('12 h no total derrubam a sessão mesmo em uso contínuo', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const me = async () => (await api.http().get(`${P}/auth/me`).set('Cookie', m)).status;
    for (let min = 100; min < 12 * 60; min += 100) {
      api.relogio.avancarMin(100);
      expect(await me(), `minuto ${min}`).toBe(200);
    }
    api.relogio.avancarMin(30); // 12h10 desde o login, 50 min desde o último uso
    expect(await me()).toBe(401);
  });

  it('sem cookie: 401 nas rotas autenticadas', async () => {
    expect((await api.http().get(`${P}/condominios`)).status).toBe(401);
    expect((await api.http().get(`${P}/auth/me`)).status).toBe(401);
  });
});

describe('troca de senha obrigatória', () => {
  it('com troca pendente: só me, logout e trocar-senha; depois da troca, acesso liberado e outras sessões revogadas', async () => {
    const outra = await entrarMaster('novo@exemplo.test');
    const m = await entrarMaster('novo@exemplo.test');
    const negada = await api.http().get(`${P}/condominios`).set('Cookie', m);
    expect([negada.status, negada.body.code]).toEqual([403, 'TROCA_DE_SENHA_OBRIGATORIA']);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', m)).body.data.usuario.deveTrocarSenha).toBe(true);
    const fraca = await api.http().post(`${P}/auth/trocar-senha`).set('Cookie', m).send({ senhaAtual: SENHA_M, novaSenha: 'curta' });
    expect([fraca.status, fraca.body.code]).toEqual([422, 'SENHA_FRACA']);
    // 15 caracteres: valeria no condomínio (mínimo 12), não no Master (16).
    const quinze = await api.http().post(`${P}/auth/trocar-senha`).set('Cookie', m).send({ senhaAtual: SENHA_M, novaSenha: 'frase-de-15-car' });
    expect([quinze.status, quinze.body.code, quinze.body.message]).toEqual([422, 'SENHA_FRACA', 'A senha precisa ter pelo menos 16 caracteres.']);
    const errada = await api.http().post(`${P}/auth/trocar-senha`).set('Cookie', m).send({ senhaAtual: 'nao-e-essa-senha', novaSenha: 'uma-senha-nova-bem-longa' });
    expect([errada.status, errada.body.code]).toEqual([422, 'SENHA_ATUAL_INCORRETA']);
    const ok = await api.http().post(`${P}/auth/trocar-senha`).set('Cookie', m).send({ senhaAtual: SENHA_M, novaSenha: 'uma-senha-nova-bem-longa' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.usuario.deveTrocarSenha).toBe(false);
    expect((await api.http().get(`${P}/condominios`).set('Cookie', m)).status).toBe(200);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', outra)).status).toBe(401);
    expect((await trilhaP('auth.trocar_senha')).length).toBe(1);
    // A trilha de condomínio do piloto não recebeu nada da plataforma (nem o 403).
    expect((await trilha(api)).filter((l) => l.acao === 'acesso.negado' && JSON.stringify(l.depois).includes('plataforma'))).toEqual([]);
  });

  it('a regra de 16 é só do Master: a do condomínio continua 12', () => {
    expect('frase-de-15-car'.length).toBe(15);
    expect(SENHA_MIN_MASTER).toBe(16);
    expect(problemasDaSenha('frase-de-15-car')).toEqual([]);
    expect(problemasDaSenha('frase-de-15-car', { minimo: SENHA_MIN_MASTER })).toEqual(['A senha precisa ter pelo menos 16 caracteres.']);
    expect(problemasDaSenha('frase-de-16-cara', { minimo: SENHA_MIN_MASTER })).toEqual([]);
    expect(problemasDaSenha('curtinha', { minimo: 4 })).toEqual(['A senha precisa ter pelo menos 12 caracteres.']);
  });

  it('senha temporária vencida: revelada só a quem acerta a senha', async () => {
    const id = await novoMaster('vencido@exemplo.test', { trocaPendente: true });
    await api.plataforma.db.update(masterUsuario).set({ senhaTemporariaExpiraEm: new Date(api.relogio.agora().getTime() - 60_000) }).where(eq(masterUsuario.id, id));
    expect((await login('vencido@exemplo.test', 'senha-errada-errada')).body.code).toBe('CREDENCIAIS_INVALIDAS');
    expect((await login('vencido@exemplo.test')).body.code).toBe('SENHA_TEMPORARIA_EXPIRADA');
  });
});

describe('condomínios', () => {
  it('lista sem dado pessoal: só cadastro da plataforma', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const r = await api.http().get(`${P}/condominios`).set('Cookie', m);
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    for (const c of r.body.data) expect(Object.keys(c).sort()).toEqual(['cidade', 'codigo', 'criadoEm', 'id', 'modulos', 'nome', 'plano', 'situacao', 'uf']);
  });

  it('criar: provisiona, devolve a senha do síndico UMA vez (no-store), trilha com o Master na transação da ativação; repetir = ja_provisionado', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const [{ id: masterId }] = await api.plataforma.db.select({ id: masterUsuario.id }).from(masterUsuario).where(eq(masterUsuario.email, 'master@exemplo.test'));
    logs.length = 0;
    const r = await api.http().post(`${P}/condominios`).set('Cookie', m).send(ENTRADA);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.data).toMatchObject({
      situacao: 'provisionado',
      condominio: { codigo: 'vila-sul', nome: 'Residencial Vila Sul', cidade: 'Santos', uf: 'SP', situacao: 'ativo' },
      sindico: { login: 'sindico.vila', senhaTemporaria: 'temp-sindico-unica-0001' },
    });
    expect(logs.join('\n')).not.toContain('temp-sindico-unica-0001');
    const [a] = (await trilhaP('condominio.provisionar')).filter((l) => l.condominioId === r.body.data.condominio.id);
    expect(a!.masterUsuarioId).toBe(masterId);
    expect((a!.detalhes as { origem: string }).origem).toBe('plataforma');
    expect(JSON.stringify(await api.plataforma.db.select().from(plataformaAudit))).not.toContain('temp-sindico-unica-0001');

    const de_novo = await api.http().post(`${P}/condominios`).set('Cookie', m).send(ENTRADA);
    expect(de_novo.status).toBe(201);
    expect(de_novo.body.data).toMatchObject({ situacao: 'ja_provisionado', sindico: null });
  });

  it('criar: entrada inválida é 400 (formato) ou 422 (estrutura incoerente / código com outro cadastro), com trilha da recusa', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const ruim = await api.http().post(`${P}/condominios`).set('Cookie', m).send({ ...ENTRADA, uf: 'XX' });
    expect(ruim.status).toBe(400);
    const incoerente = await api.http().post(`${P}/condominios`).set('Cookie', m).send({ ...ENTRADA, codigo: 'outro-cond', estrutura: { ...ENTRADA.estrutura, ausentes: ['Z-99'] } });
    expect([incoerente.status, incoerente.body.code]).toEqual([422, 'PROVISIONAMENTO_RECUSADO']);
    const conflito = await api.http().post(`${P}/condominios`).set('Cookie', m).send({ ...ENTRADA, nome: 'Outro nome' });
    expect([conflito.status, conflito.body.code]).toEqual([422, 'PROVISIONAMENTO_RECUSADO']);
    expect((await trilhaP('condominio.provisionar_falha')).at(-1)!.detalhes).toMatchObject({ codigo: 'vila-sul', motivo: 'recusado' });
  });

  it('criar com lista explícita: agrupamento próprio, bloco em maiúsculas, unidades fora da grade; repetir = ja_provisionado', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const { estrutura: _e, ...base } = ENTRADA;
    const corpo = {
      ...base, codigo: 'lista-norte', nome: 'Residencial Lista Norte', agrupamento: 'Torre', sindico: { nome: 'Síndica Lista', login: 'sindica.lista' },
      unidades: [{ bloco: '2', numero: '1201' }, { bloco: 'a', numero: '03' }, { bloco: '10', numero: '01' }, { bloco: '2', numero: '32' }],
    };
    const r = await api.http().post(`${P}/condominios`).set('Cookie', m).send(corpo);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ situacao: 'provisionado', condominio: { codigo: 'lista-norte' }, sindico: { login: 'sindica.lista' } });
    const [c] = await api.plataforma.db.select().from(condominio).where(eq(condominio.codigo, 'lista-norte'));
    const banco = prov.cluster.clientes.get(c!.banco)!;
    expect((await banco.query<{ c: string }>("select bloco || '-' || numero as c from unidade order by 1")).rows.map((x) => x.c))
      .toEqual(['10-01', '2-1201', '2-32', 'A-03']);
    expect((await banco.query<{ agrupamento: string }>('select agrupamento from configuracao')).rows).toEqual([{ agrupamento: 'Torre' }]);
    const de_novo = await api.http().post(`${P}/condominios`).set('Cookie', m).send({ ...corpo, unidades: [...corpo.unidades].reverse() });
    expect(de_novo.body.data).toMatchObject({ situacao: 'ja_provisionado', sindico: null });
  });

  it('criar: estrutura E unidades, nenhuma das duas, repetida, sem agrupamento, número não canônico ou acima do limite = 400 citando o campo', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const { estrutura: _e, ...base } = ENTRADA;
    const lista = { ...base, codigo: 'recusa-lista', agrupamento: 'Bloco', unidades: [{ bloco: 'A', numero: '01' }] };
    const casos: [unknown, string][] = [
      [{ ...lista, estrutura: ENTRADA.estrutura }, 'unidades'],
      [base, 'unidades'],
      [{ ...lista, unidades: [{ bloco: 'A', numero: '01' }, { bloco: 'a', numero: '01' }] }, 'unidades.1'],
      [{ ...lista, agrupamento: undefined }, 'agrupamento'],
      [{ ...lista, unidades: [{ bloco: 'A', numero: '1' }] }, 'unidades.0.numero'],
      [{ ...lista, unidades: [{ bloco: 'ABCD', numero: '01' }] }, 'unidades.0.bloco'],
      [{ ...lista, unidades: [] }, 'unidades'],
      [{ ...lista, unidades: Array.from({ length: 5001 }, (_, i) => ({ bloco: 'A', numero: String(i + 10) })) }, 'unidades'],
      [{ ...ENTRADA, codigo: 'recusa-lista', agrupamento: 'Torre' }, 'agrupamento'],
    ];
    for (const [corpo, campo] of casos) {
      const r = await api.http().post(`${P}/condominios`).set('Cookie', m).send(corpo as object);
      expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([400, 'DADOS_INVALIDOS']);
      expect(r.body.details.map((d: { field: string }) => d.field), JSON.stringify(r.body)).toContain(campo);
    }
    expect(await api.plataforma.db.select().from(condominio).where(eq(condominio.codigo, 'recusa-lista'))).toEqual([]);
  });

  it('saúde do provisionador: master consulta (no-store), só o booleano; desligado = false; suporte 403; sem sessão 401', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const ok = await api.http().get(`${P}/provisionador/saude`).set('Cookie', m);
    expect([ok.status, ok.body.data]).toEqual([200, { disponivel: true }]);
    expect(ok.headers['cache-control']).toBe('no-store');
    prov.ligado = false;
    try {
      expect((await api.http().get(`${P}/provisionador/saude`).set('Cookie', m)).body.data).toEqual({ disponivel: false });
    } finally {
      prov.ligado = true;
    }
    const sup = await api.http().get(`${P}/provisionador/saude`).set('Cookie', await entrarMaster('suporte@exemplo.test'));
    expect([sup.status, sup.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    expect((await api.http().get(`${P}/provisionador/saude`)).status).toBe(401);
  });

  it('módulos: PATCH grava, normaliza a ordem e registra antes/depois na mesma transação; 400, 404', async () => {
    const m = await entrarMaster('master@exemplo.test');
    const [c] = await api.plataforma.db.select().from(condominio).where(eq(condominio.codigo, 'vila-sul'));
    const r = await api.http().patch(`${P}/condominios/${c!.id}/modulos`).set('Cookie', m).send({ modulos: ['relatorios', 'encomendas'] });
    expect(r.status).toBe(200);
    expect(r.body.data.modulos).toEqual(['encomendas', 'relatorios']);
    const [a] = (await trilhaP('condominio.modulos')).slice(-1);
    expect(a).toMatchObject({ condominioId: c!.id, detalhes: { depois: ['encomendas', 'relatorios'], ligados: [] } });
    expect((a!.detalhes as { desligados: string[] }).desligados).toContain('veiculos');
    // Sem mudança: sem linha nova.
    const n = (await trilhaP('condominio.modulos')).length;
    await api.http().patch(`${P}/condominios/${c!.id}/modulos`).set('Cookie', m).send({ modulos: ['encomendas', 'relatorios'] });
    expect((await trilhaP('condominio.modulos')).length).toBe(n);
    expect((await api.http().patch(`${P}/condominios/${c!.id}/modulos`).set('Cookie', m).send({ modulos: ['cafeteria'] })).status).toBe(400);
    expect((await api.http().patch(`${P}/condominios/00000000-0000-4000-8000-000000000000/modulos`).set('Cookie', m).send({ modulos: [] })).status).toBe(404);
  });

  it('suporte: lista, mas não cria nem muda módulo (403 com trilha na plataforma)', async () => {
    const m = await entrarMaster('suporte@exemplo.test');
    expect((await api.http().get(`${P}/condominios`).set('Cookie', m)).status).toBe(200);
    const r = await api.http().post(`${P}/condominios`).set('Cookie', m).send({ ...ENTRADA, codigo: 'nao-cria' });
    expect([r.status, r.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    expect((await trilhaP('acesso.negado')).at(-1)!.detalhes).toMatchObject({ acao: 'condominio.criar' });
    expect((await api.plataforma.db.select().from(condominio).where(eq(condominio.codigo, 'nao-cria')))).toEqual([]);
  });

  it('o piloto não mudou: login da portaria e trilha de condomínio sem linhas da plataforma', async () => {
    expect((await api.como('porteiro')).cookie).toMatch(/^__Host-portaria_sessao=/);
    const linhas = await api.db.select().from(s.auditLog).where(and(eq(s.auditLog.acao, 'condominio.provisionar')));
    expect(linhas).toEqual([]);
  });
});

describe('provisionador', () => {
  it('desligado ou fora do ar: 503; configuração validada', async () => {
    const fake = { configurado: () => false, disponivel: vi.fn(async () => true), provisionar: vi.fn() };
    const svc = new CondominiosMasterService(api.plataforma.db, fake, api.app.get(ResolvedorCondominio));
    const m = { sessaoId: 'x', expiraEm: new Date(), ip: null, usuario: { id: 'x', nome: 'x', email: 'x@x.x', papel: 'master' as const, deveTrocarSenha: false } };
    await expect(svc.criar(m, { ...ENTRADA, plano: 'padrao', estrutura: { ...ENTRADA.estrutura, agrupamento: 'Bloco' } } as never)).rejects.toMatchObject({ status: 503 });
    expect(fake.provisionar).not.toHaveBeenCalled();
    // Desligado (sem URL/token): a saúde nem consulta o serviço.
    expect(await svc.provisionadorDisponivel()).toEqual({ disponivel: false });
    expect(fake.disponivel).not.toHaveBeenCalled();

    expect(provisionadorDoAmbiente({}).configurado()).toBe(false);
    expect(() => provisionadorDoAmbiente({ PROVISIONADOR_URL: 'http://provisionador:3200' })).toThrow(/juntas/);
    expect(() => provisionadorDoAmbiente({ PROVISIONADOR_URL: 'http://provisionador:3200', PROVISIONADOR_TOKEN: 'curto' })).toThrow(/32/);
    expect(() => provisionadorDoAmbiente({ PROVISIONADOR_URL: 'https://x/caminho', PROVISIONADOR_TOKEN: 'a'.repeat(40) })).toThrow(/http/);
    expect(provisionadorDoAmbiente({ PROVISIONADOR_URL: 'http://provisionador:3200', PROVISIONADOR_TOKEN: 'a'.repeat(40) }).configurado()).toBe(true);

    const fora = new ProvisionadorHttp('http://127.0.0.1:9', 'a'.repeat(40), (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    await expect(fora.provisionar({}, 'x')).rejects.toThrow(/fora do ar/);
    const recusa = new ProvisionadorHttp('http://p:1', 'a'.repeat(40), (async () => new Response(JSON.stringify({ erro: 'código já cadastrado' }), { status: 422 })) as unknown as typeof fetch);
    await expect(recusa.provisionar({}, 'x')).rejects.toThrow('código já cadastrado');
  });
});
