// CORS com credenciais (docs/deploy-subdominio-api.md): o front em https://www.condenexo.com.br chama a API em
// https://api.condenexo.com.br. Mesmo site (o SameSite=Strict do cookie vale), outra origem: o navegador só entrega a
// resposta ao front com Access-Control-Allow-Origin EXATO e Allow-Credentials. Nunca refletir Origin.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PADROES_LOGIN } from '../src/config/config';
import { type ApiDeTeste, LOGINS, novaApi, novoIp, SENHA } from './helpers/app';

const FRONT = 'https://www.condenexo.com.br';
const LOGIN = '/api/v1/auth/login';
const ME = '/api/v1/auth/me';

const preflight = (api: ApiDeTeste, caminho: string, origem: string, metodo = 'POST', cabecalhos = 'content-type,x-condominio') =>
  api.http().options(caminho)
    .set('Origin', origem)
    .set('Access-Control-Request-Method', metodo)
    .set('Access-Control-Request-Headers', cabecalhos);

const lista = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

describe('CORS com CORS_ORIGENS definido', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi({ corsOrigens: [FRONT] }); });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it.each([LOGIN, ME, '/api/v1/plataforma/auth/me'])('preflight de %s com a origem do front: ACAO exato, credenciais, métodos, cabeçalhos e Max-Age', async (caminho) => {
    const r = await preflight(api, caminho, FRONT);
    // Respondido pelo middleware de CORS, antes de guard e de rota: sem cookie (o preflight nunca leva) e sem 401/403.
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(FRONT);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    expect(lista(r.headers['access-control-allow-methods'])).toEqual(['get', 'post', 'patch']);
    expect(lista(r.headers['access-control-allow-headers'])).toEqual(['content-type', 'x-condominio']);
    expect(r.headers['access-control-max-age']).toBe('600');
    expect(lista(r.headers.vary)).toContain('origin');
  });

  it('preflight pedindo X-Motivo-Token (Front anterior à Fase B): o cabeçalho não é liberado (saiu na Fase C1)', async () => {
    const r = await preflight(api, '/api/v1/plataforma/auth/me', FRONT, 'GET', 'content-type,x-motivo-token');
    expect(lista(r.headers['access-control-allow-headers'])).not.toContain('x-motivo-token');
  });

  it.each([
    'https://evil.example',
    'https://condenexo.com.br', // o apex não está na lista: origem é exata
    'https://outro.condenexo.com.br', // mesmo site, mas não é o front
    'http://www.condenexo.com.br', // esquema diferente
    'https://www.condenexo.com.br.evil.example',
    'null',
  ])('origem não listada (%s) não recebe Access-Control-Allow-Origin', async (origem) => {
    const r = await preflight(api, LOGIN, origem);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const g = await api.http().get('/api/v1/saude').set('Origin', origem);
    expect(g.status).toBe(200);
    // Só o ACAO decide: o pacote `cors` manda Allow-Credentials/Expose-Headers fixos mesmo para origem recusada, e sem
    // ACAO o navegador bloqueia a leitura da resposta inteira.
    expect(g.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('resposta comum com a origem do front: ACAO exato e Retry-After/Content-Disposition expostos', async () => {
    const r = await api.http().get('/api/v1/saude').set('Origin', FRONT);
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(FRONT);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    expect(lista(r.headers['access-control-expose-headers'])).toEqual(['retry-after', 'content-disposition']);
  });

  it('erro também leva os cabeçalhos de CORS (o front precisa ler o 401 para mandar ao login)', async () => {
    const r = await api.http().get(ME).set('Origin', FRONT);
    expect(r.status).toBe(401);
    expect(r.headers['access-control-allow-origin']).toBe(FRONT);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  it('429 do login: Retry-After presente e exposto ao front', async () => {
    const ip = novoIp();
    for (let i = 0; i < PADROES_LOGIN.maxFalhasLogin; i++) {
      const r = await api.http().post(LOGIN).set('Origin', FRONT).set('X-Forwarded-For', ip).send({ login: LOGINS.porteiro, senha: `errada-${i}` });
      expect(r.status).toBe(401);
    }
    const r = await api.http().post(LOGIN).set('Origin', FRONT).set('X-Forwarded-For', ip).send({ login: LOGINS.porteiro, senha: SENHA });
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.headers['access-control-allow-origin']).toBe(FRONT);
    expect(lista(r.headers['access-control-expose-headers'])).toContain('retry-after');
  });
});

describe('CORS com CORS_ORIGENS vazio', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi(); });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('nenhum cabeçalho de CORS, nem no preflight nem na resposta', async () => {
    const p = await preflight(api, LOGIN, FRONT);
    const g = await api.http().get('/api/v1/saude').set('Origin', FRONT);
    expect(g.status).toBe(200);
    for (const r of [p, g]) {
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['access-control-allow-credentials']).toBeUndefined();
      expect(r.headers['access-control-allow-methods']).toBeUndefined();
      expect(r.headers['access-control-expose-headers']).toBeUndefined();
      expect(r.headers['access-control-max-age']).toBeUndefined();
    }
  });
});
