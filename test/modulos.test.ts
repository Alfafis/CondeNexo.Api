// Módulos por condomínio (docs/05_arquitetura_saas.md SAAS-19, F5 entrega 2): @Modulo + ModuloGuard (403
// MODULO_DESLIGADO depois da sessão e do papel), módulos em /auth/me, login e /catalogo, cache de até 1 min, o PATCH do
// Master valendo na hora neste processo, jobs sem módulo e o teste de arquitetura (todo controller tem @Modulo ou é núcleo).
import { hash } from '@node-rs/argon2';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { MODULOS } from '../src/dominio/modulos';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agendador } from '../src/jobs/agendador';
import { nomeCookieMaster } from '../src/master/cookie-master';
import { criarUsuario } from '../src/master/usuario-plataforma';
import { MODULO } from '../src/saas/modulo.guard';
import { RENOVAR_MS, ResolvedorCondominio } from '../src/saas/resolvedor';
import { condominio, masterUsuario } from '../src/saas/schema-plataforma';
import { type ApiDeTeste, novaApi, novoIp, trilha } from './helpers/app';

const V1 = '/api/v1';
let api: ApiDeTeste;
const cookies: Record<string, string> = {};

async function modulos(lista: readonly string[], invalidar = true) {
  await api.plataforma.db.update(condominio).set({ modulos: [...lista] }).where(eq(condominio.id, api.pilotoId));
  if (invalidar) api.app.get(ResolvedorCondominio).invalidar();
}
const get = (url: string, papel = 'porteiro') => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]!);
const sem = (m: string) => MODULOS.filter((x) => x !== m);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  for (const p of ['sindico', 'administracao', 'porteiro', 'auditor'] as const) cookies[p] = (await api.como(p)).cookie;
}, 60_000);

afterEach(async () => { vi.restoreAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => undefined); await modulos(MODULOS); });
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

describe('ModuloGuard', () => {
  it('módulo desligado: 403 MODULO_DESLIGADO com a mensagem; a negação vai para a trilha (acesso.negado, modulo.<nome>)', async () => {
    await modulos(sem('encomendas'));
    const r = await get('/encomendas');
    expect([r.status, r.body.code, r.body.message]).toEqual([403, 'MODULO_DESLIGADO', 'Este módulo não está contratado para este condomínio.']);
    const [l] = (await trilha(api, 'acesso.negado')).slice(-1);
    expect((l!.depois as { acao: string }).acao).toBe('modulo.encomendas');
    // Religou: volta tudo (desligar não apaga dado).
    await modulos(MODULOS);
    expect((await get('/encomendas')).status).toBe(200);
  });

  it('ordem: sem sessão continua 401; sem papel continua o 403 do RBAC (não revela o que está contratado)', async () => {
    await modulos(sem('importacao'));
    expect((await api.http().get(`${V1}/encomendas`)).status).toBe(401);
    const r = await api.http().post(`${V1}/importacoes`).set('Cookie', cookies.porteiro!).send({ arquivo: 'x.csv', linhas: [] });
    expect([r.status, r.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    const r2 = await api.http().post(`${V1}/importacoes`).set('Cookie', cookies.administracao!).send({ arquivo: 'x.csv', linhas: [] });
    expect([r2.status, r2.body.code]).toEqual([403, 'MODULO_DESLIGADO']);
  });

  it('cada módulo recusa as suas rotas e só elas', async () => {
    const casos: [string, string, string][] = [
      ['encomendas', '/encomendas', 'porteiro'], ['ocorrencias', '/ocorrencias', 'porteiro'], ['relatorios', '/relatorios/resumo', 'sindico'],
      ['funcionarios', '/funcionarios', 'sindico'], ['autorizacoes_previas', '/autorizacoes-previas/hoje', 'porteiro'],
    ];
    for (const [m, url, papel] of casos) {
      await modulos(sem(m));
      expect((await get(url, papel)).body.code, `${m} ${url}`).toBe('MODULO_DESLIGADO');
      for (const [outro, url2, papel2] of casos.filter((c) => c[0] !== m)) expect((await get(url2, papel2)).status, `${m} desligado não afeta ${outro}`).toBe(200);
      // O núcleo nunca desliga.
      for (const nucleo of ['/catalogo', '/pessoas', '/vinculos', '/eventos-acesso', '/acessos/presentes', '/restricoes/pendentes', '/auth/me']) {
        expect((await get(nucleo, 'sindico')).status, `${nucleo} com ${m} desligado`).toBe(200);
      }
    }
    // Veículos: escrita (não há GET de veículo).
    await modulos(sem('veiculos'));
    const v = await api.http().post(`${V1}/veiculos`).set('Cookie', cookies.sindico!).send({});
    expect(v.body.code).toBe('MODULO_DESLIGADO');
  });

  it('nenhum módulo ligado: a portaria (núcleo) continua de pé', async () => {
    await modulos([]);
    for (const url of ['/catalogo', '/pessoas', '/eventos-acesso', '/acessos/presentes', '/turnos/resumo']) expect((await get(url)).status, url).toBe(200);
  });
});

describe('módulos em /auth/me, login e /catalogo', () => {
  it('a lista vem na ordem de MODULOS e acompanha a plataforma', async () => {
    expect((await get('/auth/me')).body.data.modulos).toEqual([...MODULOS]);
    await modulos(['relatorios', 'encomendas']);
    expect((await get('/auth/me')).body.data.modulos).toEqual(['encomendas', 'relatorios']);
    expect((await get('/catalogo')).body.data.modulos).toEqual(['encomendas', 'relatorios']);
    const login = await api.entrar('joao.lima');
    expect(login.corpo.modulos).toEqual(['encomendas', 'relatorios']);
  });
});

describe('cache: desligar vale em até 1 min sem reiniciar; o PATCH do Master vale na hora', () => {
  it('mudança direta na plataforma: vale depois de RENOVAR_MS', async () => {
    expect((await get('/encomendas')).status).toBe(200); // cache carregado agora
    await modulos(sem('encomendas'), false);
    expect((await get('/encomendas')).status).toBe(200); // ainda o cache anterior
    const agora = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(agora + RENOVAR_MS + 1);
    expect((await get('/encomendas')).body.code).toBe('MODULO_DESLIGADO');
  });

  it('PATCH /plataforma/condominios/:id/modulos invalida o cache deste processo', async () => {
    const c = await criarUsuario(api.plataforma.db, {
      hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => 'senha-do-master-bem-longa-1', agora: () => api.relogio.agora(),
    }, { email: 'm@exemplo.test', nome: 'Operador', papel: 'master' });
    await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
    const r = await api.http().post(`${V1}/plataforma/auth/login`).set('X-Forwarded-For', novoIp()).send({ email: 'm@exemplo.test', senha: 'senha-do-master-bem-longa-1' });
    const m = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!.split(';')[0]!;
    expect((await get('/ocorrencias')).status).toBe(200);
    const p = await api.http().patch(`${V1}/plataforma/condominios/${api.pilotoId}/modulos`).set('Cookie', m).send({ modulos: sem('ocorrencias') });
    expect(p.status).toBe(200);
    expect((await get('/ocorrencias')).body.code).toBe('MODULO_DESLIGADO');
  });
});

describe('jobs não olham módulo', () => {
  it('com tudo desligado, o ciclo do agendador roda (selo e retenção)', async () => {
    await modulos([]);
    const r = await api.app.get(Agendador).ciclo();
    expect(r.falharam).toEqual([]);
    expect((await trilha(api, 'lgpd.retencao')).length).toBeGreaterThan(0); // a retenção do dia rodou no ciclo
  });
});

describe('arquitetura: todo controller tem @Modulo ou é do núcleo', () => {
  /** Núcleo (SAAS-19): nunca desliga. AcessoController é núcleo com os handlers de autorização prévia marcados. */
  const NUCLEO = [
    'AcessoController', 'AuditoriaController', 'AuthController', 'LgpdController', 'PessoasController', 'SaudeController', 'SeloController',
    'UnidadesController', 'UsuariosController', 'VinculosController',
    // Parâmetros de regra para a tela (/parametros): núcleo, sem módulo.
    'ParametrosController',
    // Plataforma (/plataforma/*): o Master não é recusado por módulo.
    'AuthMasterController', 'CondominiosMasterController', 'LeituraMasterController', 'ProvisionadorMasterController', 'SindicosMasterController',
    'ParametrosMasterController',
  ];
  const ESPERADOS: Record<string, string> = {
    EncomendasController: 'encomendas', OcorrenciasController: 'ocorrencias', ImportacaoController: 'importacao', VeiculosController: 'veiculos',
    FuncionariosController: 'funcionarios', RelatoriosController: 'relatorios',
  };

  it('a lista fecha com os controllers do AppModule', () => {
    const reflector = new Reflector();
    const controllers = [...api.app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()].map((c) => c.metatype as new () => object));
    const nomes = controllers.map((c) => c.name).sort();
    expect(nomes).toEqual([...NUCLEO, ...Object.keys(ESPERADOS)].sort());
    for (const c of controllers) {
      const doController = reflector.get<string | undefined>(MODULO, c);
      if (c.name in ESPERADOS) expect(doController, c.name).toBe(ESPERADOS[c.name]);
      else expect(doController, c.name).toBeUndefined();
    }
    const acesso = controllers.find((c) => c.name === 'AcessoController')!;
    const marcados = Object.getOwnPropertyNames(acesso.prototype)
      .filter((h) => h !== 'constructor' && reflector.get(MODULO, (acesso.prototype as Record<string, () => void>)[h]!) === 'autorizacoes_previas').sort();
    expect(marcados).toEqual(['autorizacoesDaUnidade', 'autorizacoesHoje', 'criarAutorizacao', 'previstas', 'revogarAutorizacao', 'vigentes']);
  });
});
