// Verificação de Origin (src/comum/origem.ts, docs/deploy-subdominio-api.md): SameSite=Strict não barra requisição de
// outro subdomínio do MESMO site. Um <form method=POST> em blog.condenexo.com.br não faz preflight e leva o cookie da
// API; o CORS só impede a leitura. Aqui se prova que o efeito é recusado ANTES do limite de login e da trilha.
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PADROES_LOGIN } from '../src/config/config';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { nomeCookieMaster } from '../src/plataforma/cookie-master';
import { masterUsuario, plataformaAudit } from '../src/plataforma/schema-plataforma';
import { criarUsuario } from '../src/plataforma/usuario-plataforma';
import { type ApiDeTeste, LOGINS, novaApi, novoIp, SENHA, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const FRONT = 'https://www.condenexo.com.br';
const LOGIN = '/api/v1/auth/login';

const ORIGENS_RECUSADAS = [
  'https://blog.condenexo.com.br', // o cenário do ataque: outro subdomínio, mesmo site
  'null',
  'http://www.condenexo.com.br',
  'https://www.condenexo.com.br.evil.com',
  'https://condenexo.com.br',
  'https://www.condenexo.com.br/', // com barra: não é a origem exata
  'HTTPS://WWW.CONDENEXO.COM.BR',
];

function esperar403(r: { status: number; body: Record<string, unknown> }) {
  expect(r.status).toBe(403);
  expect(r.body).toMatchObject({ statusCode: 403, error: 'Forbidden', code: 'ORIGEM_NAO_PERMITIDA', message: 'Origem da requisição não permitida.' });
  // A lista permitida nunca vai na resposta.
  expect(JSON.stringify(r.body)).not.toContain('www.condenexo.com.br');
}

describe('Origin com CORS_ORIGENS definido', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi({ corsOrigens: [FRONT] }); });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('POST /auth/login com a origem do front segue o fluxo normal (401 com senha errada, 200 com a certa)', async () => {
    const ip = novoIp();
    const errado = await api.http().post(LOGIN).set('Origin', FRONT).set('X-Forwarded-For', ip).send({ login: LOGINS.porteiro, senha: 'errada' });
    expect(errado.status).toBe(401);
    expect(errado.body.code).toBe('CREDENCIAIS_INVALIDAS');
    const certo = await api.http().post(LOGIN).set('Origin', FRONT).set('X-Forwarded-For', ip).send({ login: LOGINS.porteiro, senha: SENHA });
    expect(certo.status).toBe(200);
    expect(certo.headers['access-control-allow-origin']).toBe(FRONT);
  });

  it.each(ORIGENS_RECUSADAS)('ataque com Origin %s: 403 ORIGEM_NAO_PERMITIDA em login JSON, urlencoded e multipart', async (origem) => {
    const ip = novoIp();
    esperar403(await api.http().post(LOGIN).set('Origin', origem).set('X-Forwarded-For', ip).send({ login: LOGINS.porteiro, senha: SENHA }));
    esperar403(await api.http().post(LOGIN).set('Origin', origem).set('X-Forwarded-For', ip).type('form').send({ login: LOGINS.porteiro, senha: SENHA }));
    esperar403(await api.http().post(LOGIN).set('Origin', origem).set('X-Forwarded-For', ip).field('login', LOGINS.porteiro).field('senha', SENHA));
  });

  it('o ataque não consome o limite de login nem grava trilha: depois de muitas recusas, o login certo do mesmo IP entra', async () => {
    const ip = novoIp();
    const antes = await trilha(api);
    // Mais que o limite por login E o por IP: se uma única recusa contasse, o login abaixo daria 429.
    const n = Math.max(PADROES_LOGIN.maxFalhasLogin, PADROES_LOGIN.maxFalhasIp) + 2;
    for (let i = 0; i < n; i++) {
      const origem = ORIGENS_RECUSADAS[i % ORIGENS_RECUSADAS.length]!;
      const r = await api.http().post(LOGIN).set('Origin', origem).set('X-Forwarded-For', ip).type('form').send({ login: LOGINS.porteiro, senha: `errada-${i}` });
      esperar403(r);
    }
    const depois = await trilha(api);
    expect(depois.length).toBe(antes.length); // nem auth.login_falha, nem auth.bloqueio, nem acesso.negado
    const ok = await api.http().post(LOGIN).set('Origin', FRONT).set('X-Forwarded-For', ip).send({ login: LOGINS.porteiro, senha: SENHA });
    expect(ok.status).toBe(200);
  });

  it('PATCH autenticado com Origin de outro subdomínio: 403, sem efeito e sem trilha; com a origem do front, aplica', async () => {
    const { cookie } = await api.como('sindico');
    const alvo = api.usuarios[LOGINS.auditor]!;
    const papel = async () => (await api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.id, alvo.id)))[0]!.papel;
    const papelAntes = await papel();
    const antes = await trilha(api);
    for (const origem of ORIGENS_RECUSADAS) {
      esperar403(await api.http().patch(`/api/v1/usuarios/${alvo.id}`).set('Cookie', cookie).set('Origin', origem).send({ papel: 'porteiro' }));
      esperar403(await api.http().patch(`/api/v1/usuarios/${alvo.id}`).set('Cookie', cookie).set('Origin', origem).type('form').send({ papel: 'porteiro' }));
    }
    expect(await papel()).toBe(papelAntes);
    expect((await trilha(api)).length).toBe(antes.length);

    const ok = await api.http().patch(`/api/v1/usuarios/${alvo.id}`).set('Cookie', cookie).set('Origin', FRONT).send({ papel: 'porteiro' });
    expect(ok.status).toBe(200);
    expect(await papel()).toBe('porteiro');
  });

  it('sem Origin e sem Sec-Fetch-Site (curl, integração): passa', async () => {
    const r = await api.http().post(LOGIN).set('X-Forwarded-For', novoIp()).send({ login: LOGINS.porteiro, senha: 'errada' });
    expect(r.status).toBe(401);
  });

  it.each(['same-origin', 'none'])('sem Origin com Sec-Fetch-Site: %s: passa', async (site) => {
    const r = await api.http().post(LOGIN).set('Sec-Fetch-Site', site).set('X-Forwarded-For', novoIp()).send({ login: LOGINS.porteiro, senha: 'errada' });
    expect(r.status).toBe(401);
  });

  it.each(['same-site', 'cross-site'])('sem Origin com Sec-Fetch-Site: %s (navegador que omitiu Origin): 403', async (site) => {
    esperar403(await api.http().post(LOGIN).set('Sec-Fetch-Site', site).set('X-Forwarded-For', novoIp()).send({ login: LOGINS.porteiro, senha: SENHA }));
  });

  it('GET com Origin de fora não é bloqueado por este middleware (o CORS é que impede a leitura)', async () => {
    const r = await api.http().get('/api/v1/saude').set('Origin', 'https://blog.condenexo.com.br');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const h = await api.http().head('/api/v1/saude').set('Origin', 'https://blog.condenexo.com.br');
    expect(h.status).toBe(200);
  });

  it('OPTIONS com Origin de fora: o middleware não responde 403 (preflight intacto, decidido só pelo CORS)', async () => {
    const r = await api.http().options(LOGIN).set('Origin', 'https://blog.condenexo.com.br').set('Access-Control-Request-Method', 'POST');
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('corpo urlencoded com a origem do front: 415 (a API só fala JSON e multipart)', async () => {
    const r = await api.http().post(LOGIN).set('Origin', FRONT).set('X-Forwarded-For', novoIp()).type('form').send({ login: LOGINS.porteiro, senha: SENHA });
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('TIPO_NAO_SUPORTADO');
  });
});

describe('Origin com CORS_ORIGENS vazio (dev/e2e, mesma origem pelo proxy do Vite)', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi(); });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('Origin com host:porta igual ao Host passa (o proxy do Vite com alvo local preserva o Host do navegador)', async () => {
    const r = await api.http().post(LOGIN).set('Host', 'localhost:5180').set('Origin', 'http://localhost:5180')
      .set('X-Forwarded-For', novoIp()).send({ login: LOGINS.porteiro, senha: SENHA });
    expect(r.status).toBe(200);
  });

  it.each([
    ['http://localhost:5181', 'localhost:5180'], // outra porta
    ['http://127.0.0.1:5180', 'localhost:5180'], // outro host
    ['https://blog.condenexo.com.br', 'localhost:5180'],
    ['null', 'localhost:5180'],
  ])('Origin %s com Host %s: 403', async (origem, host) => {
    esperar403(await api.http().post(LOGIN).set('Host', host).set('Origin', origem).set('X-Forwarded-For', novoIp()).send({ login: LOGINS.porteiro, senha: SENHA }));
  });

  it('X-Forwarded-Host não substitui o Host (seria forjável com trust proxy ligado)', async () => {
    esperar403(await api.http().post(LOGIN).set('Host', 'localhost:5180').set('X-Forwarded-Host', 'evil.example')
      .set('Origin', 'https://evil.example').set('X-Forwarded-For', novoIp()).send({ login: LOGINS.porteiro, senha: SENHA }));
  });
});

// Leituras de rota NÃO pública (src/comum/origem.guard.ts): a leitura auditada grava trilha (lgpd.exportar,
// documento.ler, plataforma.ler/exportar do Master). <img>/link de outro subdomínio chega sem Origin e com
// Sec-Fetch-Site: same-site, leva o cookie e geraria linha de trilha em nome da vítima.
describe('Origin nas leituras autenticadas (GET/HEAD), CORS_ORIGENS definido', () => {
  let api: ApiDeTeste;
  let cookie: string;
  let master: string;
  let pessoaId: string;
  const EMAIL = 'master-origem@exemplo.test';
  const SENHA_M = 'senha-do-master-bem-longa-1';
  const exportacao = () => `/api/v1/lgpd/pessoas/${pessoaId}/exportacao`;
  const leituraMaster = () => `/api/v1/plataforma/condominios/${api.pilotoId}/unidades`;
  const linhasPlataforma = () => api.plataforma.db.select().from(plataformaAudit);

  beforeAll(async () => {
    api = await novaApi({ corsOrigens: [FRONT] });
    await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
    pessoaId = (await api.db.select().from(s.pessoa).limit(1))[0]!.id;
    cookie = (await api.como('sindico')).cookie;
    const c = await criarUsuario(api.plataforma.db, {
      hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
    }, { email: EMAIL, nome: 'Operador', papel: 'master' });
    await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
    const r = await api.http().post('/api/v1/plataforma/auth/login').set('X-Forwarded-For', novoIp()).send({ email: EMAIL, senha: SENHA_M });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    master = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!.split(';')[0]!;
  });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('GET auditado com a origem do front passa e grava a trilha normal (síndico e Master)', async () => {
    const antes = (await trilha(api, 'lgpd.exportar')).length;
    const r = await api.http().get(exportacao()).set('Cookie', cookie).set('Origin', FRONT).set('Sec-Fetch-Site', 'same-site');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await trilha(api, 'lgpd.exportar')).length).toBe(antes + 1);
    const pAntes = (await linhasPlataforma()).length;
    const m = await api.http().get(leituraMaster()).set('Cookie', master).set('Origin', FRONT).set('Sec-Fetch-Site', 'same-site');
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await linhasPlataforma()).length).toBe(pAntes + 1);
  });

  it.each([
    ['Origin de fora', { Origin: 'https://blog.condenexo.com.br' }],
    ['Origin null', { Origin: 'null' }],
    ['sem Origin, Sec-Fetch-Site: same-site (<img>/link de outro subdomínio)', { 'Sec-Fetch-Site': 'same-site' }],
    ['sem Origin, Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
  ])('GET auditado com %s: 403 ORIGEM_NAO_PERMITIDA e NENHUMA linha de trilha (nem acesso.negado)', async (_, cab) => {
    const antes = (await trilha(api)).length;
    const pAntes = (await linhasPlataforma()).length;
    esperar403(await api.http().get(exportacao()).set('Cookie', cookie).set(cab));
    expect((await api.http().head(exportacao()).set('Cookie', cookie).set(cab)).status).toBe(403); // HEAD: sem corpo
    esperar403(await api.http().get(leituraMaster()).set('Cookie', master).set(cab));
    expect((await trilha(api)).length).toBe(antes);
    expect((await linhasPlataforma()).length).toBe(pAntes);
  });

  it('a recusa vem antes da autenticação: sem cookie e com Sec-Fetch-Site: same-site dá 403, não 401', async () => {
    esperar403(await api.http().get('/api/v1/auth/me').set('Sec-Fetch-Site', 'same-site'));
  });

  it.each([
    ['sem cabeçalho (curl)', {}],
    ['Sec-Fetch-Site: none (URL digitada)', { 'Sec-Fetch-Site': 'none' }],
    ['Sec-Fetch-Site: same-origin', { 'Sec-Fetch-Site': 'same-origin' }],
  ])('GET auditado %s: passa', async (_, cab) => {
    const r = await api.http().get(exportacao()).set('Cookie', cookie).set(cab);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = await api.http().get(leituraMaster()).set('Cookie', master).set(cab);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
  });

  it.each(['/api/v1/saude', '/api/v1/selo/publico'])('rota pública %s não é afetada (Origin de fora e Sec-Fetch-Site: cross-site)', async (caminho) => {
    for (const cab of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const r = await api.http().get(caminho).set(cab);
      expect(r.status).not.toBe(403); // /saude 200; selo público 404 com o destino github desligado nos testes
    }
  });
});

describe('Origin nas leituras autenticadas, CORS_ORIGENS vazio: regra Origin = Host', () => {
  let api: ApiDeTeste;
  let cookie: string;
  beforeAll(async () => { api = await novaApi(); cookie = (await api.como('sindico')).cookie; });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('Origin com o host do Host passa; de outro host, 403; sem Origin com same-origin passa', async () => {
    const me = () => api.http().get('/api/v1/auth/me').set('Cookie', cookie).set('Host', 'localhost:5180');
    expect((await me().set('Origin', 'http://localhost:5180')).status).toBe(200);
    expect((await me().set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    esperar403(await me().set('Origin', 'http://localhost:5181'));
    esperar403(await me().set('Sec-Fetch-Site', 'same-site'));
  });
});
