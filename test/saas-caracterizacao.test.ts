// Testes de CARACTERIZAÇÃO da fase F0 do SaaS (docs/05_arquitetura_saas.md §5): fixam o comportamento de hoje nos
// pontos que F2 e F4 vão mudar (login, sessão/cookie, selo público, agendador). Não dizem que o comportamento é o certo
// para o SaaS; dizem o que existe. Quando uma fase mudar um destes pontos de propósito, o teste muda junto, no mesmo
// commit, e o diff do teste documenta a mudança. Quebrar sem querer = regressão no piloto.
// F2 (2026-10-22): login com código do condomínio (opcional para o piloto), cookie v2 com o antigo aceito para o piloto,
// selo público só do piloto e trava de job por condomínio. Os testes abaixo foram atualizados no mesmo passo.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { TravaJobs } from '../src/jobs/trava';
import { SeloService } from '../src/selo/selo.module';
import { type ApiDeTeste, cookieDe, novaApi, novoIp, SENHA } from './helpers/app';

const V1 = '/api/v1';
const ANCORA_GITHUB = { github: true, emails: [], remetente: 'portaria@localhost', smtp: null, arquivo: null };

describe('caracterização: login e sessão (F2: código do condomínio e cookie v2.<condominio_id>.<token>)', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi(); });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('login {login, senha}: sem X-Condominio ou com o código do piloto entra no piloto; código desconhecido = credenciais inválidas', async () => {
    for (const cab of [undefined, 'piloto', ' PILOTO ']) {
      const r = api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp());
      if (cab) r.set('X-Condominio', cab);
      expect((await r.send({ login: 'joao.lima', senha: SENHA })).status).toBe(200);
    }
    for (const cab of ['demo', 'nao-existe', '', '<script>']) {
      const r = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).set('X-Condominio', cab).send({ login: 'joao.lima', senha: SENHA });
      expect([r.status, r.body.code, r.headers['set-cookie']]).toEqual([401, 'CREDENCIAIS_INVALIDAS', undefined]);
    }
  });

  it('campo `codigo` no corpo do login é recusado hoje (400, corpo estrito)', async () => {
    const r = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: 'joao.lima', senha: SENHA, codigo: 'demo' });
    expect(r.status).toBe(400);
  });

  it('cookie: v2.<id do piloto>.<token opaco base64url de 43>; no banco, só o SHA-256 do token', async () => {
    const { cookie } = await api.entrar('joao.lima');
    const [nome, valor] = cookie.split('=') as [string, string];
    expect(nome).toBe('__Host-portaria_sessao');
    const [versao, id, token] = valor.split('.') as [string, string, string];
    expect([versao, id]).toEqual(['v2', api.pilotoId]);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hashes = (await api.db.select({ h: s.sessao.tokenHash }).from(s.sessao)).map((x) => x.h);
    expect(hashes).toContain(createHash('sha256').update(token, 'utf8').digest('hex'));
  });

  it('sessão aberta antes da F2 (cookie sem prefixo) continua valendo no piloto; prefixo de outro condomínio: 401', async () => {
    const { cookie } = await api.entrar('joao.lima');
    const token = cookie.split('=')[1]!.split('.')[2]!;
    expect((await api.http().get(`${V1}/auth/me`).set('Cookie', cookie)).status).toBe(200);
    expect((await api.http().get(`${V1}/auth/me`).set('Cookie', `__Host-portaria_sessao=${token}`)).status).toBe(200);
    for (const valor of [`v2.${randomUUID()}.${token}`, `v3.${api.pilotoId}.${token}`, `v2.${api.pilotoId}.${token}x`]) {
      const r = await api.http().get(`${V1}/auth/me`).set('Cookie', `__Host-portaria_sessao=${valor}`);
      expect([valor, r.status, r.body.code]).toEqual([valor, 401, 'SESSAO_INVALIDA']);
    }
  });

  it('o login é procurado no banco inteiro, sem distinguir maiúsculas (um condomínio por banco)', async () => {
    const r = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: 'JOAO.LIMA', senha: SENHA });
    expect(r.status).toBe(200);
    expect(cookieDe(r.headers['set-cookie'])).toMatch(/^__Host-portaria_sessao=/);
  });
});

describe('caracterização: selo público v1 (F4 muda: só {data, raiz} por dia, formato v2)', () => {
  let api: ApiDeTeste;
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    api = await novaApi({ ancora: ANCORA_GITHUB });
    await (await api.servico<SeloService>(SeloService)).selarDia('2026-10-16');
  });
  afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

  it('formato v1 exato: {formato, versao: 1, selos: [{data, seq, hash, totalDoDia}]}; só do piloto (F2)', async () => {
    const r = await api.http().get(`${V1}/auditoria/selos/publico`).set('X-Forwarded-For', novoIp());
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data)).toEqual(['formato', 'versao', 'selos']);
    expect(r.body.data).toMatchObject({ formato: 'portaria-parque/selos-diarios', versao: 1 });
    expect(r.body.data.selos.map((x: object) => Object.keys(x))).toEqual([['data', 'seq', 'hash', 'totalDoDia']]);
    expect(r.body.data.selos[0]).toMatchObject({ data: '2026-10-16', seq: 0, totalDoDia: 0 });
    const piloto = await api.http().get(`${V1}/auditoria/selos/publico`).set('X-Forwarded-For', novoIp()).set('X-Condominio', 'piloto');
    expect(piloto.body).toEqual(r.body);
    // Código desconhecido: sem condomínio, 404 (antes da F2 o cabeçalho era ignorado e respondia o piloto).
    const outro = await api.http().get(`${V1}/auditoria/selos/publico`).set('X-Forwarded-For', novoIp()).set('X-Condominio', 'outro');
    expect(outro.status).toBe(404);
  });
});

describe('caracterização: agendador (F2: laço por condomínio e trava por condomínio)', () => {
  it('trava de job: advisory lock por nome E condomínio (portaria:job:<nome>:<condominio_id>); sem condomínio, recusa', async () => {
    const chaves: unknown[] = [];
    const conexao = { query: async (_q: string, p: unknown[]) => { chaves.push(p[0]); return { rows: [{ ok: true }] }; }, release: () => undefined };
    const pool = { connect: async () => conexao, end: async () => undefined } as never;
    const id = randomUUID();
    const trava = new TravaJobs(pool, { id } as never);
    expect(await trava.tentar('selo', async () => 1)).toEqual({ obtida: true, valor: 1 });
    expect(await trava.tentar('retencao', async () => 2)).toEqual({ obtida: true, valor: 2 });
    expect([...new Set(chaves)]).toEqual([`portaria:job:selo:${id}`, `portaria:job:retencao:${id}`]);
    await expect(new TravaJobs(pool, null).tentar('selo', async () => 1)).rejects.toThrow(/sem condomínio/);
  });

  it('o "ontem" do selo diário é BRT fixo: 02:59Z ainda é o dia anterior em São Paulo, 03:00Z já não', async () => {
    const api = await novaApi();
    try {
      const selo = await api.servico<SeloService>(SeloService);
      api.relogio.atual = new Date('2026-10-17T02:59:00.000Z'); // 23:59 de 16/10 em BRT -> ontem = 15/10
      await selo.rotinaDiaria();
      api.relogio.atual = new Date('2026-10-17T03:00:00.000Z'); // 00:00 de 17/10 em BRT -> ontem = 16/10
      await selo.rotinaDiaria();
      const dias = (await api.db.select({ d: s.seloCadeia.data, t: s.seloCadeia.tipo }).from(s.seloCadeia)).map((x) => `${x.t}:${x.d}`);
      expect(dias.sort()).toEqual(['diario:2026-10-15', 'diario:2026-10-16']);
    } finally { await api.app.close(); await api.client.close(); }
  });
});
