// Isolamento entre condomínios (docs/05_arquitetura_saas.md §6.1, fase F2). Dois condomínios de verdade na mesma API:
// o piloto (`piloto`, banco `portaria`) e o `demo` (outro PGlite, outras chaves), com os MESMOS logins e o mesmo seed
// de pessoas. Cada teste diz qual item da §6.1 prova. O que depende de privilégio real (app_plataforma sem CONNECT no
// banco de condomínio) está em test/postgres-real/saas-multibanco.test.ts.
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SenhaService } from '../src/auth/senha.service';
import { DB, SemCondominio } from '../src/database/database.module';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { kekAbreDek } from '../src/documentos/cofre';
import { Agendador } from '../src/jobs/agendador';
import { EsperaLogin } from '../src/auth/login-sem-condominio';
import { SaudeService } from '../src/saude/saude.controller';
import { PessoasService } from '../src/pessoas/pessoas.service';
import { estrategiaCondominio } from '../src/tenancy/contexto';
import { conferirChavesDoAmbiente, ResolvedorCondominio } from '../src/tenancy/resolvedor';
import { SeloService } from '../src/selo/selo.service';
import { semearDadosE2e, USUARIOS_E2E } from './e2e/dados';
import { type ApiDeTeste, configDeTeste, cookieDe, novaApi, novoIp, SENHA, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE, novoBanco, SENHA_FALSA } from './helpers/banco';
import { novoBancoPlataforma } from './helpers/plataforma';
import { CODIGO_PILOTO, DEMO, KEK_TESTE, MESTRA_TESTE, registrarCondominio, RegistroDeTeste } from './helpers/saas';

const V1 = '/api/v1';
const COOKIE = '__Host-portaria_sessao';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('ANEXO DO DEMO '.repeat(10))]);

let api: ApiDeTeste;
const piloto: Record<string, string> = {};
const demo: Record<string, string> = {};

/** Login num condomínio pelo código (X-Condominio); sem código, o piloto. Devolve o cabeçalho Cookie. */
async function entrarEm(codigo: string | null, login: string, senha = SENHA) {
  const r = api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp());
  if (codigo) r.set('X-Condominio', codigo);
  const resp = await r.send({ login, senha });
  if (resp.status !== 200) throw new Error(`login ${codigo}/${login}: ${resp.status} ${JSON.stringify(resp.body)}`);
  return cookieDe(resp.headers['set-cookie']);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // Destino github ligado: o piloto publica e tem destino de âncora; o demo não (F2, até a âncora agregada da F4).
  api = await novaApi({ ancora: { github: true, emails: [], remetente: 'portaria@localhost', smtp: null, arquivo: null } }, { demo: true });
  api.relogio.atual = new Date(); // os dados do e2e são relativos à hora real
  const agora = api.relogio.agora();
  // Mesmo seed de pessoas nos dois (mesmos CPFs), cada um com a SUA chave HMAC.
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora });
  await seedPessoasDev(api.demo!.db, { chaveHmac: DEMO.hmac, agora });
  // Dados do e2e no demo, pelos serviços DO DEMO (subárvore dele): eventos, restrição, ocorrências, encomendas.
  await api.demo!.db.insert(s.usuarioSistema).values(USUARIOS_E2E.map((u) => ({ ...u, senhaHash: SENHA_FALSA, deveTrocarSenha: false })));
  await semearDadosE2e(api.app, await api.condominio(api.demo!.id));

  for (const login of ['carlos.andrade', 'paula.nogueira', 'joao.lima', 'luiza.campos']) {
    piloto[login] = await entrarEm(null, login);
    demo[login] = await entrarEm('demo', login);
  }
  // O que o seed não cria no demo: autorização prévia, importação e anexo (pela API do demo, com sessão do demo).
  const [ana] = await api.demo!.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro'));
  const [bruno] = await api.demo!.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Bruno Teixeira'));
  const [d32] = await api.demo!.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32')));
  const post = (login: string, url: string, corpo: object) => api.http().post(`${V1}${url}`).set('Cookie', demo[login]!).send(corpo);
  // Validade relativa à hora real (o relógio deste teste é o real): uma data fixa vence e o POST passa a dar 422.
  const validaAte = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await post('joao.lima', '/autorizacoes-previas', { unidadeId: d32!.id, pessoaId: bruno!.id, validaAte, solicitadaPorPessoaId: ana!.id });
  expect(a.status).toBe(201);
  const imp = await post('paula.nogueira', '/importacoes', { arquivo: 'x.csv', linhas: [{ linha: 2, bloco: 'A', unidade: '11', nome: 'Importado Demo', documento: '', telefone: '', tipo: 'Proprietário' }] });
  expect(imp.status).toBe(201);
  const [oc] = await api.demo!.db.select().from(s.ocorrencia).where(ne(s.ocorrencia.status, 'encerrada')).limit(1);
  const anexo = await api.http().post(`${V1}/ocorrencias/${oc!.id}/anexos`).set('Cookie', demo['carlos.andrade']!).attach('arquivo', PNG, { filename: 'f.png', contentType: 'image/png' });
  expect(anexo.status).toBe(201);
}, 120_000);

afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

describe('§6.1 item 1: id de outro condomínio se comporta como id inexistente (nunca 200 nem 403 a mais)', () => {
  const openapi = JSON.parse(readFileSync(fileURLToPath(new URL('../docs/api/openapi.json', import.meta.url)), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  /** Prefixo da rota -> tabela (e coluna) de onde sai um id que EXISTE no demo. */
  const TABELA: Record<string, [string, string]> = {
    'autorizacoes-previas': ['autorizacao_previa', 'id'], encomendas: ['encomenda', 'id'], 'eventos-acesso': ['evento_acesso', 'id'],
    funcionarios: ['funcionario', 'pessoa_id'], importacoes: ['importacao', 'id'], lgpd: ['pessoa', 'id'], ocorrencias: ['ocorrencia_anexo', 'ocorrencia_id'],
    pessoas: ['pessoa', 'id'], restricoes: ['restricao', 'id'], unidades: ['unidade', 'id'], usuarios: ['usuario_sistema', 'id'],
    veiculos: ['veiculo', 'id'], vinculos: ['vinculo_unidade', 'id'],
  };
  // Rotas do app do Master (/plataforma/*) não são de condomínio: nenhuma sessão de condomínio as alcança
  // (test/master-api.test.ts, "cookie cruzado"), e o id delas é de condomínio na plataforma, não de registro do condomínio.
  const rotas = Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => [m, p] as const))
    .filter(([, p]) => p.includes('{') && !p.startsWith('/plataforma/'));

  it('cobre todas as rotas com parâmetro do openapi.json', () => {
    expect(rotas.length).toBeGreaterThanOrEqual(40);
    for (const [, p] of rotas) expect(TABELA[p.split('/')[1]!], p).toBeDefined();
  });

  it('para cada rota e cada papel do piloto: a resposta com o id do demo é igual à de um uuid aleatório, e nunca 2xx', async () => {
    const idDe = async (prefixo: string) => {
      const [tabela, coluna] = TABELA[prefixo]!;
      const r = await api.demo!.client.query<{ id: string }>(`select ${coluna}::text as id from ${tabela} limit 1`);
      if (!r.rows[0]) throw new Error(`demo sem linha em ${tabela}: o teste não provaria nada para esta rota`);
      return r.rows[0].id;
    };
    const [doc] = await api.demo!.db.select().from(s.ocorrenciaAnexo).limit(1);
    let com404 = 0;
    for (const [metodo, caminho] of rotas) {
      const id = await idDe(caminho.split('/')[1]!);
      const aleatorio = randomUUID();
      const montar = (x: string) => caminho.replace(/\{(id|pessoaId|ref)\}/, x).replace('{documentoId}', caminho.includes('{documentoId}') ? (x === id ? doc!.documentoId : randomUUID()) : '');
      const chamar = (url: string, cookie: string) => {
        const r = (api.http() as unknown as Record<string, (u: string) => import('supertest').Test>)[metodo]!(`${V1}${url}`).set('Cookie', cookie).set('X-Forwarded-For', novoIp());
        return metodo === 'get' ? r : r.send({});
      };
      for (const [login, cookie] of Object.entries(piloto)) {
        const doDemo = await chamar(montar(id), cookie);
        const inexistente = await chamar(montar(aleatorio), cookie);
        const rotulo = `${metodo.toUpperCase()} ${caminho} como ${login}`;
        expect([rotulo, doDemo.status, doDemo.body.code], rotulo).toEqual([rotulo, inexistente.status, inexistente.body.code]);
        expect(doDemo.status, rotulo).toBeLessThan(500);
        // 2xx só onde a rota responde igual para qualquer id (ex.: lista de correções vazia): corpo idêntico ao do aleatório.
        if (doDemo.status < 300) expect(doDemo.body.data, rotulo).toEqual(inexistente.body.data);
        if (doDemo.status === 404) com404++;
      }
    }
    // A maioria das rotas chega à busca do id (404) para pelo menos um papel; o resto para antes, por RBAC ou validação
    // do corpo vazio, e aí a igualdade com o uuid aleatório já é a prova.
    expect(com404).toBeGreaterThanOrEqual(rotas.length);
  });
});

describe('§6.1 item 2: sessão de um condomínio não abre outro', () => {
  const valor = (cookie: string) => cookie.split('=')[1]!;
  const me = (cookie: string, codigo?: string) => {
    const r = api.http().get(`${V1}/auth/me`).set('Cookie', cookie);
    return codigo ? r.set('X-Condominio', codigo) : r;
  };

  it('cada sessão vale no seu condomínio; o cookie leva o id do condomínio certo', async () => {
    expect((await me(piloto['joao.lima']!)).status).toBe(200);
    expect((await me(demo['joao.lima']!)).status).toBe(200);
    expect(valor(piloto['joao.lima']!).split('.')[1]).toBe(api.pilotoId);
    expect(valor(demo['joao.lima']!).split('.')[1]).toBe(api.demo!.id);
  });

  it('login e /auth/me devolvem código e nome do condomínio da sessão (nunca id nem banco)', async () => {
    const pilotoMe = await me(piloto['joao.lima']!);
    const demoMe = await me(demo['joao.lima']!);
    expect(pilotoMe.body.data.condominio).toEqual({ codigo: CODIGO_PILOTO, nome: 'Condomínio de teste' });
    expect(demoMe.body.data.condominio).toEqual({ codigo: DEMO.codigo, nome: `Condomínio ${DEMO.codigo}` });
    const login = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).set('X-Condominio', DEMO.codigo)
      .send({ login: 'joao.lima', senha: SENHA });
    expect(login.status).toBe(200);
    expect(login.body.data.condominio).toEqual({ codigo: DEMO.codigo, nome: `Condomínio ${DEMO.codigo}` });
    // Sem código (transição): o piloto, e o front aprende o código dele pela resposta.
    const semCodigo = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: 'joao.lima', senha: SENHA });
    expect(semCodigo.body.data.condominio).toEqual({ codigo: CODIGO_PILOTO, nome: 'Condomínio de teste' });
  });

  it('prefixo trocado (A -> B e B -> A): 401; o token não existe no outro banco', async () => {
    const tokenPiloto = valor(piloto['joao.lima']!).split('.')[2]!;
    const tokenDemo = valor(demo['joao.lima']!).split('.')[2]!;
    for (const v of [`v2.${api.demo!.id}.${tokenPiloto}`, `v2.${api.pilotoId}.${tokenDemo}`]) {
      const r = await me(`${COOKIE}=${v}`);
      expect([r.status, r.body.code]).toEqual([401, 'SESSAO_INVALIDA']);
    }
  });

  it('X-Condominio de outro condomínio com o cookie certo: 401 (a sessão só é procurada no condomínio escolhido)', async () => {
    expect((await me(demo['joao.lima']!, 'piloto')).status).toBe(401);
    expect((await me(piloto['joao.lima']!, 'demo')).status).toBe(401);
    expect((await me(piloto['joao.lima']!, 'piloto')).status).toBe(200);
  });

  it('login ignora o cookie: com o cookie do demo e sem código, entra no piloto (cookie velho não escolhe o condomínio)', async () => {
    const r = await api.http().post(`${V1}/auth/login`).set('Cookie', demo['joao.lima']!).set('X-Forwarded-For', novoIp()).send({ login: 'joao.lima', senha: SENHA });
    expect(r.status).toBe(200);
    expect(cookieDe(r.headers['set-cookie']).split('=')[1]!.split('.')[1]).toBe(api.pilotoId);
    // O Express casa a rota sem diferenciar maiúsculas e com barra final: o cookie também é ignorado assim.
    const r2 = await api.http().post(`/API/V1/AUTH/LOGIN/`).set('Cookie', demo['joao.lima']!).set('X-Forwarded-For', novoIp()).send({ login: 'joao.lima', senha: SENHA });
    expect(r2.status).toBe(200);
    expect(cookieDe(r2.headers['set-cookie']).split('=')[1]!.split('.')[1]).toBe(api.pilotoId);
  });

  it('cookie antigo (sem prefixo) só vale no piloto: o token do demo sem prefixo é 401', async () => {
    const tokenDemo = valor(demo['joao.lima']!).split('.')[2]!;
    expect((await me(`${COOKIE}=${tokenDemo}`)).status).toBe(401);
    expect((await me(`${COOKIE}=${tokenDemo}`, 'demo')).status).toBe(401);
    expect((await me(`${COOKIE}=${valor(piloto['joao.lima']!).split('.')[2]}`)).status).toBe(200);
  });

  it('dado de um não aparece no outro: a mesma listagem devolve as pessoas de cada banco', async () => {
    const nomes = async (cookie: string) => (await api.http().get(`${V1}/pessoas?limite=100`).set('Cookie', cookie)).body.data.map((p: { nome: string }) => p.nome);
    expect(await nomes(demo['paula.nogueira']!)).toContain('Márcia Pereira'); // só o demo recebeu os dados do e2e
    expect(await nomes(piloto['paula.nogueira']!)).not.toContain('Márcia Pereira');
  });
});

describe('§6.1 item 3: login com código de A e senha de B', () => {
  it('mesmo login nos dois, senhas diferentes: cada senha só entra no seu condomínio', async () => {
    const outra = 'senha-so-do-demo-bem-longa';
    await api.demo!.db.update(s.usuarioSistema).set({ senhaHash: await hash(outra, { memoryCost: 1024, timeCost: 1, parallelism: 1 }) })
      .where(eq(s.usuarioSistema.login, 'luiza.campos'));
    const login = (codigo: string | null, senha: string) => {
      const r = api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp());
      return (codigo ? r.set('X-Condominio', codigo) : r).send({ login: 'luiza.campos', senha });
    };
    expect((await login('demo', outra)).status).toBe(200);
    for (const [codigo, senha] of [['piloto', outra], [null, outra], ['demo', SENHA]] as const) {
      const r = await login(codigo, senha);
      expect([r.status, r.body.code]).toEqual([401, 'CREDENCIAIS_INVALIDAS']);
    }
  });

  it('código inexistente: a mesma resposta e o mesmo argon2 de uma senha errada (verificação fictícia)', async () => {
    const senhas = api.app.get(SenhaService);
    const ficticio = vi.spyOn(senhas, 'verificarFicticio');
    const r = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).set('X-Condominio', 'nao-existe').send({ login: 'joao.lima', senha: SENHA });
    expect([r.status, r.body.code, r.body.message]).toEqual([401, 'CREDENCIAIS_INVALIDAS', 'Usuário ou senha inválidos.']);
    expect(ficticio).toHaveBeenCalledTimes(1);
    ficticio.mockRestore();
  });

  it('código inexistente é indistinguível de login inexistente num condomínio que existe: status, corpo e atrasos', async () => {
    // Atraso crescente ligado (no resto dos testes é 0) e observado no ponto único de espera dos dois caminhos.
    const outra = await novaApi({ login: { ...configDeTeste().login, atrasoBaseMs: 1 } }, { demo: true });
    try {
      const atrasos: number[] = [];
      const espiao = vi.spyOn(outra.app.get(EsperaLogin), 'esperar').mockImplementation(async (ms: number) => { atrasos.push(ms); });
      const rodada = async (codigo: string, login: string) => {
        atrasos.length = 0;
        const ip = novoIp();
        const respostas: unknown[] = [];
        for (let i = 0; i < outra.config.login.maxFalhasLogin + 2; i++) {
          const x = await outra.http().post(`${V1}/auth/login`).set('X-Forwarded-For', ip).set('X-Condominio', codigo).send({ login, senha: 'senha-errada-qualquer' });
          const { timestamp: _t, ...corpo } = x.body;
          respostas.push([x.status, corpo, x.headers['retry-after'] !== undefined]);
        }
        return { respostas, atrasos: [...atrasos] };
      };
      const existente = await rodada('demo', 'fantasma.um');
      const inexistente = await rodada('nao-existe', 'fantasma.dois');
      espiao.mockRestore();
      expect(inexistente).toEqual(existente);
      // E a sequência é a esperada: 10 x 401 com atraso 1, 2, 4... e depois 429 sem argon2 nem atraso.
      expect(existente.atrasos).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
      expect(existente.respostas.map((x) => (x as [number])[0])).toEqual([...Array(10).fill(401), 429, 429]);
    } finally { await outra.app.close(); await outra.client.close(); }
  });
});

describe('login sem condomínio: o mesmo limite por par login+IP', () => {
  it('muitos IPs no mesmo login nunca dão 429; o mesmo IP dá, como no condomínio existente', async () => {
    const tentar = (ip: string) => api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', ip).set('X-Condominio', 'nao-existe')
      .send({ login: 'alvo.fixo', senha: 'x' });
    for (let i = 0; i < api.config.login.maxFalhasLogin + 3; i++) expect((await tentar(novoIp())).status).toBe(401);
    const ip = novoIp();
    for (let i = 0; i < api.config.login.maxFalhasLogin; i++) expect((await tentar(ip)).status).toBe(401);
    expect((await tentar(ip)).status).toBe(429);
  });
});

describe('§6.1 itens 4 e 5: chaves por condomínio', () => {
  it('o mesmo CPF gera documento_busca diferente em cada condomínio', async () => {
    const busca = async (db: typeof api.db) => (await db.select({ b: s.pessoa.documentoBusca }).from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro')))[0]!.b;
    const a = await busca(api.db);
    const b = await busca(api.demo!.db);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('anexo do demo: pasta própria; a DEK abre com a KEK do demo e falha (GCM) com a do piloto', async () => {
    const [d] = await api.demo!.db.select().from(s.documento).limit(1);
    expect(kekAbreDek(DEMO.kek, d!)).toBe(true);
    expect(kekAbreDek(KEK_TESTE, d!)).toBe(false);
    expect(await readdir(join(api.config.documentos.dir, api.demo!.id))).toContain(`${d!.id}.bin`);
    // A raiz (pasta do piloto) não tem o arquivo do demo: a varredura de órfãos do piloto nunca o vê.
    expect(readdirSync(api.config.documentos.dir).filter((n) => n.endsWith('.bin'))).not.toContain(`${d!.id}.bin`);
    // E o demo baixa o próprio anexo pela API (KEK do demo, pasta do demo).
    const [oa] = await api.demo!.db.select().from(s.ocorrenciaAnexo).where(eq(s.ocorrenciaAnexo.documentoId, d!.id));
    const r = await api.http().get(`${V1}/ocorrencias/${oa!.ocorrenciaId}/anexos/${d!.id}`).set('Cookie', demo['carlos.andrade']!).buffer(true);
    expect(r.status).toBe(200);
  });
});

describe('falha fechada sem condomínio', () => {
  it('serviço na subárvore "sem condomínio": o banco lança no primeiro uso', async () => {
    const id = estrategiaCondominio.arvore(null);
    api.app.registerRequestByContextId({ condominio: null }, id);
    // (o CONDOMINIO desta subárvore é null; o Nest não deixa resolver um provider nulo diretamente, só como dependência)
    const db = await api.app.resolve<typeof api.db>(DB, id, { strict: false });
    expect(() => db.select()).toThrow(SemCondominio);
    const pessoas = await api.app.resolve(PessoasService, id, { strict: false });
    await expect(pessoas.listar('sindico', { limite: 1 })).rejects.toThrow(SemCondominio);
  });

  it('rota de condomínio com código desconhecido: 401 sem tocar banco; /saude segue público', async () => {
    const r = await api.http().get(`${V1}/pessoas`).set('Cookie', piloto['joao.lima']!).set('X-Condominio', 'nao-existe');
    expect([r.status, r.body.code]).toEqual([401, 'SESSAO_INVALIDA']);
    const sem = await api.http().get(`${V1}/pessoas`).set('X-Condominio', 'nao-existe');
    expect(sem.status).toBe(401);
    expect((await api.http().get(`${V1}/saude`).set('X-Condominio', 'nao-existe')).body.data).toMatchObject({ status: 'ok', banco: 'ok' });
  });
});

describe('§6.1 item 7: arquitetura', () => {
  const raiz = fileURLToPath(new URL('../src', import.meta.url));
  const arquivos = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? arquivos(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const fontes = arquivos(raiz).map((f) => ({ f: f.slice(raiz.length + 1), texto: readFileSync(f, 'utf8') }));

  it('só o DatabaseModule, o módulo da plataforma, o ResolvedorCondominio e o registro de anonimizações citam PLATAFORMA_DB', () => {
    const citam = fontes.filter((x) => /\bPLATAFORMA_DB\b/.test(x.texto)).map((x) => x.f).sort();
    // App do Master (F5): só arquivos de src/plataforma/, e nenhum deles injeta DB/CONDOMINIO de condomínio.
    const doMaster = citam.filter((f) => f.startsWith('plataforma/'));
    expect(citam.filter((f) => !f.startsWith('plataforma/'))).toEqual(['database/database.module.ts', 'tenancy/registro-anonimizacao.ts', 'tenancy/resolvedor.ts']);
    expect(doMaster.length).toBeGreaterThan(0);
    for (const f of fontes.filter((x) => x.f.startsWith('plataforma/'))) {
      expect(/@Inject\((DB|CONDOMINIO|PG_POOL|REGISTRO_BANCOS)\)/.test(f.texto), `${f.f} injeta banco de condomínio`).toBe(false);
    }
  });

  it('nenhuma classe do src guarda estado em campo estático (estado tem de ficar na instância, por condomínio)', () => {
    const estaticos = fontes.flatMap((x) => [...x.texto.matchAll(/^\s+(?:private |public |protected |readonly )*static (?!readonly [A-Z_]+ =)[^(]*[=;]/gm)].map((m) => `${x.f}: ${m[0].trim()}`));
    expect(estaticos).toEqual([]);
  });
});

describe('§6.1 item 8: agendador com dois condomínios', () => {
  it('falha forçada no piloto não impede o selo do demo; cada um sela no próprio banco', async () => {
    // Amanhã: o "ontem" do agendador é hoje, quando o demo teve eventos (os dados do e2e são da hora real).
    api.relogio.atual = new Date(Date.now() + 86_400_000);
    const seloPiloto = await api.servico<SeloService>(SeloService);
    const espiao = vi.spyOn(seloPiloto, 'rotinaDiaria').mockRejectedValue(Object.assign(new Error('falha forçada'), { code: '57P01' }));
    let r: { falharam: string[] };
    try { r = await api.app.get(Agendador).ciclo(); } finally { espiao.mockRestore(); }
    expect(r.falharam).toEqual([api.pilotoId]);
    const selosDemo = await api.demo!.db.select().from(s.seloCadeia).where(eq(s.seloCadeia.tipo, 'diario'));
    expect(selosDemo.length).toBeGreaterThan(0);
    expect(await api.db.select().from(s.seloCadeia).where(eq(s.seloCadeia.tipo, 'diario'))).toEqual([]);
    // Segundo ciclo, sem falha: o piloto recupera o dia (o agendador pergunta ao banco o que falta).
    expect((await api.app.get(Agendador).ciclo()).falharam).toEqual([]);
    expect((await api.db.select().from(s.seloCadeia).where(eq(s.seloCadeia.tipo, 'diario'))).length).toBeGreaterThan(0);
    api.relogio.atual = new Date();
  });

  it('o demo não publica selo (endpoint v1 só do piloto) e não manda âncora para os destinos do piloto', async () => {
    const publico = (codigo: string) => api.http().get(`${V1}/auditoria/selos/publico`).set('X-Condominio', codigo).set('X-Forwarded-For', novoIp());
    expect((await publico('demo')).status).toBe(404);
    expect((await publico('piloto')).status).toBe(200);
    const destinos = async (cookie: string) => (await api.http().get(`${V1}/auditoria/selos`).set('Cookie', cookie)).body.data.destinos;
    expect(await destinos(demo['carlos.andrade']!)).toEqual([]);
    expect(await destinos(piloto['carlos.andrade']!)).toEqual(['GitHub Actions (endpoint público, coleta diária)']);
  });
});

describe('transição e status do condomínio', () => {
  it('SAAS_PILOTO_PADRAO=false: sem código não entra; cookie antigo não vale; com código entra', async () => {
    const outra = await novaApi({ saas: { pilotoPadrao: false, chavesAmbiente: { hmacCpf: null, kek: null, kekVersao: null } } });
    try {
      const sem = await outra.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: 'joao.lima', senha: SENHA });
      expect([sem.status, sem.body.code]).toEqual([401, 'CREDENCIAIS_INVALIDAS']);
      const com = await outra.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).set('X-Condominio', 'piloto').send({ login: 'joao.lima', senha: SENHA });
      expect(com.status).toBe(200);
      const cookie = cookieDe(com.headers['set-cookie']);
      expect((await outra.http().get(`${V1}/auth/me`).set('Cookie', cookie)).status).toBe(200);
      const legado = `${COOKIE}=${cookie.split('=')[1]!.split('.')[2]}`;
      expect((await outra.http().get(`${V1}/auth/me`).set('Cookie', legado)).status).toBe(401);
      expect((await outra.http().get(`${V1}/auditoria/selos/publico`)).status).toBe(404);
    } finally { await outra.app.close(); await outra.client.close(); }
  });

  it('condomínio suspenso: só quem acerta a senha vê a mensagem própria; conta como falha e não grava acesso.negado', async () => {
    const outra = await novaApi({}, { statusPiloto: 'suspenso' });
    try {
      const login = (senha: string) => outra.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: 'joao.lima', senha });
      const errada = await login('senha-errada-qualquer');
      expect([errada.status, errada.body.code]).toEqual([401, 'CREDENCIAIS_INVALIDAS']);
      const certa = await login(SENHA);
      expect([certa.status, certa.body.code, certa.headers['set-cookie']]).toEqual([403, 'CONDOMINIO_SUSPENSO', undefined]);
      expect(await trilha(outra, 'acesso.negado')).toEqual([]);
      expect((await trilha(outra, 'auth.login_falha')).map((l) => (l.depois as { motivo: string }).motivo)).toEqual(['senha_incorreta', 'condominio_suspenso']);
      expect(await outra.db.select().from(s.sessao)).toEqual([]);
    } finally { await outra.app.close(); await outra.client.close(); }
  });

  it('condomínio com chave que não desembrulha: agendador e /saude isolam o defeituoso (o resto segue, saúde 200)', async () => {
    const outra = await novaApi({}, { demo: true });
    try {
      // Terceiro condomínio registrado DEPOIS do boot com a chave embrulhada por outra mestra (corrompida para esta API).
      const id = await registrarCondominio(outra.plataforma.db, { codigo: 'quebrado', banco: 'portaria_quebr001', hmac: Buffer.alloc(32, 21), kek: Buffer.alloc(32, 22) },
        { chave: Buffer.alloc(32, 23), versao: 1 });
      const resolvedor = outra.app.get(ResolvedorCondominio) as unknown as { carregadoEm: number };
      resolvedor.carregadoEm = 0; // força a renovação do cache (em produção: até 1 min)
      outra.relogio.atual = new Date(Date.now() + 86_400_000);
      const r = await outra.app.get(Agendador).ciclo();
      expect(r.falharam).toEqual([id]);
      expect((await outra.demo!.db.select().from(s.seloCadeia)).length).toBe(1);
      expect((await outra.db.select().from(s.seloCadeia)).length).toBe(1);
      (outra.app.get(SaudeService) as unknown as { cache: null }).cache = null;
      const saude = await outra.http().get(`${V1}/saude`);
      expect([saude.status, saude.body.data.banco, saude.body.data.condominios_com_falha]).toEqual([200, 'ok', 1]);
      expect(JSON.stringify(saude.body)).not.toMatch(/quebrado|portaria_quebr001/);
    } finally { await outra.app.close(); await outra.client.close(); }
  });

  it('/saude guarda o resultado por alguns segundos: rajada de healthchecks não vira consulta por banco', async () => {
    const saudeSvc = api.app.get(SaudeService) as unknown as { cache: null };
    saudeSvc.cache = null;
    const ping = vi.spyOn(api.app.get(ResolvedorCondominio), 'pingPlataforma');
    for (let i = 0; i < 5; i++) expect((await api.http().get(`${V1}/saude`)).status).toBe(200);
    expect(ping).toHaveBeenCalledTimes(1);
    ping.mockRestore();
  });

  it('condomínio encerrado: não é atendido (sem código vai a lugar nenhum; a API nem sobe sem condomínio atendido)', async () => {
    await expect(novaApi({}, { statusPiloto: 'encerrado' })).rejects.toThrow(/nenhum condomínio ativo ou suspenso/);
  });
});

describe('boot: conferência das chaves (transição da F2)', () => {
  const vazio = { hmacCpf: null, kek: null, kekVersao: null };
  const piloto = { id: 'x', codigo: 'piloto', nome: 'Condomínio de teste', banco: 'portaria', piloto: true, agrupamento: 'Bloco' as const, chaves: { hmacCpf: CHAVE_HMAC_TESTE, kek: KEK_TESTE, kekVersao: 1 } };

  it('chaves do ambiente iguais às da plataforma: confere; ausentes: nada a conferir; diferentes: recusa', () => {
    expect(conferirChavesDoAmbiente(vazio, piloto)).toEqual([]);
    expect(conferirChavesDoAmbiente({ hmacCpf: CHAVE_HMAC_TESTE, kek: KEK_TESTE, kekVersao: 1 }, piloto)).toEqual(['hmac_cpf', 'kek_documentos', 'kek_versao']);
    expect(() => conferirChavesDoAmbiente({ ...vazio, hmacCpf: Buffer.alloc(32, 1) }, piloto)).toThrow(/PORTARIA_HMAC_CPF_KEY difere/);
    expect(() => conferirChavesDoAmbiente({ ...vazio, kek: Buffer.alloc(32, 1) }, piloto)).toThrow(/PORTARIA_KEK difere/);
    expect(() => conferirChavesDoAmbiente({ ...vazio, kekVersao: 2 }, piloto)).toThrow(/PORTARIA_KEK_VERSAO=2/);
    expect(() => conferirChavesDoAmbiente({ ...vazio, kek: KEK_TESTE }, undefined)).toThrow(/sem o piloto/);
  });

  it('API inteira: sobe com as chaves certas no ambiente e recusa o boot com uma chave trocada', async () => {
    const certa = await novaApi({ saas: { pilotoPadrao: true, chavesAmbiente: { hmacCpf: CHAVE_HMAC_TESTE, kek: KEK_TESTE, kekVersao: 1 } } });
    await certa.app.close(); await certa.client.close();
    await expect(novaApi({ saas: { pilotoPadrao: true, chavesAmbiente: { hmacCpf: Buffer.alloc(32, 8), kek: null, kekVersao: null } } }))
      .rejects.toThrow(/PORTARIA_HMAC_CPF_KEY difere/);
  });

  /** Resolvedor isolado: plataforma com o piloto e um banco `portaria` com um documento cuja DEK foi cifrada por `kekDoc`. */
  async function resolvedorCom(kekDoc: Buffer, mestra = MESTRA_TESTE) {
    const plat = await novoBancoPlataforma();
    await registrarCondominio(plat.db, { codigo: 'piloto', banco: 'portaria', hmac: CHAVE_HMAC_TESTE, kek: KEK_TESTE });
    const banco = await novoBanco();
    const id = randomUUID();
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', kekDoc, nonce, { authTagLength: 16 });
    c.setAAD(Buffer.from(`portaria:dek:${id}:v1`, 'utf8'));
    const dekCifrada = Buffer.concat([nonce, c.update(randomBytes(32)), c.final(), c.getAuthTag()]);
    await banco.db.insert(s.documento).values({
      id, tipo: 'anexo_ocorrencia', caminhoStorage: `${id}.bin`, dekCifrada, nonce: randomBytes(12), chaveVersao: 1,
      sha256Conteudo: 'a'.repeat(64), mime: 'image/png', tamanhoBytes: 1, enviadoPorId: banco.fx.porteiro!.id,
    });
    const r = new ResolvedorCondominio(plat.db, mestra, configDeTeste(), new RegistroDeTeste(new Map([['portaria', banco.db as never]])));
    return { r, fechar: async () => { await plat.client.close(); await banco.client.close(); } };
  }

  it('a KEK da plataforma abre a DEK de um anexo existente: sobe; KEK que não abre: recusa', async () => {
    const ok = await resolvedorCom(KEK_TESTE);
    try { await ok.r.onModuleInit(); } finally { await ok.fechar(); }
    const ruim = await resolvedorCom(Buffer.alloc(32, 3));
    try { await expect(ruim.r.onModuleInit()).rejects.toThrow(/não abre a DEK de um anexo existente/); } finally { await ruim.fechar(); }
  });

  it('chave mestra errada: as chaves não desembrulham e o boot é recusado', async () => {
    const x = await resolvedorCom(KEK_TESTE, { chave: Buffer.alloc(32, 6), versao: 1 });
    try { await expect(x.r.onModuleInit()).rejects.toThrow(/não autenticou/); } finally { await x.fechar(); }
  });
});
