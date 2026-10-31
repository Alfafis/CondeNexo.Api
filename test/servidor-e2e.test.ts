// Trava do modo e2e (test/e2e/servidor.ts: API sobre PGlite com rotas /__e2e/*). Prova que:
//  1. ele recusa subir em qualquer sinal de ambiente real (produção ou Postgres de verdade);
//  2. a API de produção (o mesmo AppModule, montado como no main.ts) NÃO tem as rotas /__e2e/*;
//  3. o código do modo e2e não alcança o build de produção: fora de src/ (o único include do tsconfig.build.json),
//     sem import a partir de src/, e o runtime do Dockerfile só roda dist/main.js;
//  4. no próprio modo e2e, o reset devolve o banco ao estado semeado.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { novaApi, type ApiDeTeste } from './helpers/app';
import { iniciarServidorE2e, SENHA_E2E_PADRAO, verificarAmbienteE2e } from './e2e/servidor';

const RAIZ_API = fileURLToPath(new URL('..', import.meta.url));
const ROTAS_E2E = ['/__e2e/reset', '/__e2e/adulterar-evento', '/__e2e/vencer-senha-temporaria'];

describe('modo e2e (PGlite): trava contra produção', () => {
  it('recusa PORTARIA_AMBIENTE=producao, NODE_ENV=production e qualquer DATABASE_URL', () => {
    expect(() => verificarAmbienteE2e({})).not.toThrow();
    expect(() => verificarAmbienteE2e({ PORTARIA_AMBIENTE: 'dev', NODE_ENV: 'test' })).not.toThrow();
    for (const env of [
      { PORTARIA_AMBIENTE: 'producao' },
      { NODE_ENV: 'production' },
      { DATABASE_URL: 'postgres://app_rw:x@db:5432/portaria' },
      { DATABASE_URL_MIGRATOR: 'postgres://app_migrator:x@db:5432/portaria' },
    ]) {
      expect(() => verificarAmbienteE2e(env), JSON.stringify(Object.keys(env))).toThrow(/modo e2e \(PGlite\) recusado/);
    }
  });

  it('iniciarServidorE2e com ambiente de produção falha antes de criar banco ou abrir porta', async () => {
    await expect(iniciarServidorE2e({ porta: 0, env: { PORTARIA_AMBIENTE: 'producao', DATABASE_URL: 'postgres://x' } }))
      .rejects.toThrow(/PORTARIA_AMBIENTE=producao, DATABASE_URL definida/);
  });

  it('o código do modo e2e fica fora do build de produção', () => {
    // tsconfig.build.json (o `npm run build` da imagem) compila só src/; o servidor de e2e mora em test/e2e.
    const build = JSON.parse(readFileSync(join(RAIZ_API, 'tsconfig.build.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { include: string[] };
    expect(build.include).toEqual(['src']);
    // Nenhum arquivo de src/ importa test/ nem o PGlite (devDependency, ausente da imagem).
    const arquivos = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? arquivos(p) : [p];
    });
    for (const f of arquivos(join(RAIZ_API, 'src')).filter((f) => f.endsWith('.ts'))) {
      const texto = readFileSync(f, 'utf8');
      expect(texto, f).not.toMatch(/from ['"][./]*test\//);
      expect(texto, f).not.toMatch(/@electric-sql\/pglite|__e2e/);
    }
    // O runtime da imagem roda só o main de produção (o Dockerfile não é alterado por este modo).
    const dockerfile = readFileSync(join(RAIZ_API, 'Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).toMatch(/CMD \["node", "dist\/main\.js"\]/);
    expect(runtime).not.toMatch(/test\/|dev:pglite|vite-node/);
  });
});

describe('API de produção (AppModule) não expõe as rotas do e2e', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi(); });
  afterAll(async () => { await api.app.close(); });

  it.each(ROTAS_E2E)('POST %s (com e sem o prefixo /api/v1) dá 404', async (rota) => {
    expect((await api.http().post(rota).send({})).status).toBe(404);
    expect((await api.http().post(`/api/v1${rota}`).send({})).status).toBe(404);
  });
});

describe('API de produção (AppModule) não expõe a documentação', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi(); });
  afterAll(async () => { await api.app.close(); });

  it.each(['/api/v1/docs', '/api/v1/openapi.json'])('GET %s dá 404 (em produção a documentação é o arquivo versionado)', async (rota) => {
    expect((await api.http().get(rota)).status).toBe(404);
  });
});

describe('servidor de e2e: reset', () => {
  let s: Awaited<ReturnType<typeof iniciarServidorE2e>>;
  beforeAll(async () => { s = await iniciarServidorE2e({ porta: 0, env: {} }); }, 120_000);
  afterAll(async () => { await s?.fechar(); });

  it('escuta só no loopback; o reset desfaz o que foi gravado e mantém o seed', async () => {
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const http = () => request(s.url);
    const login = await http().post('/api/v1/auth/login').send({ login: 'paula.nogueira', senha: SENHA_E2E_PADRAO });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const nova = await http().post('/api/v1/pessoas').set('Cookie', cookie)
      .send({ nome: 'Pessoa Antes Do Reset', documento: '111.444.777-35', telefone: '11955550000', categoria: 'visitante' });
    expect(nova.status).toBe(201);
    const busca = (q: string) => http().post('/api/v1/pessoas/busca').set('Cookie', cookie).send({ q });

    expect((await http().post('/__e2e/reset')).status).toBe(200);
    // A sessão era do banco anterior: o reset a derruba junto (estado limpo de verdade).
    expect((await busca('Pessoa Antes')).status).toBe(401);
    const novo = await http().post('/api/v1/auth/login').send({ login: 'paula.nogueira', senha: SENHA_E2E_PADRAO });
    const cookie2 = String(novo.headers['set-cookie']).split(';')[0]!;
    const depois = await http().post('/api/v1/pessoas/busca').set('Cookie', cookie2).send({ q: 'Pessoa Antes' });
    expect(depois.body.data.pessoas).toEqual([]);
    const seed = await http().post('/api/v1/pessoas/busca').set('Cookie', cookie2).send({ q: 'Márcia Pereira' });
    expect(seed.body.data.pessoas.map((p: { nome: string }) => p.nome)).toContain('Márcia Pereira');
  }, 60_000);

  it('serve o OpenAPI e o Swagger UI (versão fixa do CDN), sem exigir sessão', async () => {
    const doc = await request(s.url).get('/api/v1/openapi.json');
    expect(doc.status).toBe(200);
    expect(doc.body.openapi).toBe('3.1.0');
    expect(doc.body.servers[0].url).toBe('/api/v1'); // o "Try it out" fala com este servidor
    const html = await request(s.url).get('/api/v1/docs');
    expect(html.status).toBe(200);
    expect(html.text).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js/);
  });
});
