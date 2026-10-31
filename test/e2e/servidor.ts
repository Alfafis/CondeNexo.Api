// Servidor de e2e: a API de verdade (AppModule, guards, filtro, configurarApp) sobre um PGlite em memória, com as
// migrações reais, o seed de desenvolvimento (estrutura, 4 usuários, pessoas fictícias) e os dados de e2e (dados.ts).
// Uso: `npm run dev:pglite` (o playwright.config.ts do web sobe este servidor sozinho).
//
// Nunca é caminho de produção:
//  - mora em test/, fora de src/: o tsconfig.build.json só compila src/, então nada daqui vai para o dist nem para a
//    imagem (o runtime do Dockerfile copia só dist/ e roda `node dist/main.js`); o PGlite é devDependency e nem existe lá;
//  - `verificarAmbienteE2e` recusa o boot com PORTARIA_AMBIENTE=producao, NODE_ENV=production ou qualquer DATABASE_URL
//    (este modo nunca fala com Postgres de verdade);
//  - as rotas /__e2e/* (reset e manipulação de dados de teste) são registradas aqui, direto no Express, e não existem no
//    AppModule; o servidor escuta só em 127.0.0.1. Prova: test/servidor-e2e.test.ts.
//  - o mesmo vale para a documentação: /api/v1/openapi.json e /api/v1/docs (Swagger UI) só existem aqui. Em produção a
//    documentação é o arquivo versionado docs/api/openapi.json.
import { hash } from '@node-rs/argon2';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Request, Response } from 'express';
import { AppModule } from '../../src/app.module';
import { type Config, CONFIG, nomeCookie } from '../../src/config/config';
import { RELOGIO, relogioDoSistema } from '../../src/comum/relogio';
import type { Db } from '../../src/database/database.module';
import * as s from '../../src/db/schema';
import { seedEstrutura } from '../../src/db/seed';
import { seedPessoasDev } from '../../src/db/seed-pessoas-dev';
import { seedUsuariosDev } from '../../src/db/seed-usuarios';
import { gerarOpenApi } from '../../src/openapi/gerar-openapi';
import { configurarApp, PREFIXO_GLOBAL } from '../../src/plataforma';
import { configDeTeste } from '../helpers/app';
import { CHAVE_HMAC_TESTE, PASTA_MIGRACOES } from '../helpers/banco';
import { novoBancoPlataforma } from '../helpers/plataforma';
import { comSaas, KEK_TESTE, MESTRA_TESTE, registrarCondominio, RegistroDeTeste } from '../helpers/saas';
import { provisionadorPglite } from '../helpers/provisionador';
import { PROVISIONADOR } from '../../src/master/provisionador';
import { ResolvedorCondominio } from '../../src/saas/resolvedor';
import { condominio, MODULOS_PLATAFORMA } from '../../src/saas/schema-plataforma';
import { semearMastersE2e } from './masters';
import { semearDadosE2e, USUARIOS_E2E } from './dados';

/** Senha de todos os usuários do e2e (fictícia, só deste modo). O playwright.config.ts manda a mesma em E2E_SENHA. */
export const SENHA_E2E_PADRAO = 'senha-e2e-portaria-parque';

/** Versão fixa do Swagger UI (jsdelivr): sem `latest`, para a página não mudar sozinha. */
const SWAGGER_UI_VERSAO = '5.17.14';
const HTML_SWAGGER = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API do CondNexo (local)</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSAO}/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSAO}/swagger-ui-bundle.js"></script>
<script>
  window.ui = SwaggerUIBundle({ url: '/${PREFIXO_GLOBAL}/openapi.json', dom_id: '#swagger-ui', withCredentials: true });
</script>
</body>
</html>
`;

/** Recusa o modo e2e em qualquer sinal de ambiente real. Lança com a lista do que encontrou. */
export function verificarAmbienteE2e(env: NodeJS.ProcessEnv): void {
  const problemas: string[] = [];
  if (env.PORTARIA_AMBIENTE === 'producao') problemas.push('PORTARIA_AMBIENTE=producao');
  if (env.NODE_ENV === 'production') problemas.push('NODE_ENV=production');
  for (const k of ['DATABASE_URL', 'DATABASE_URL_MIGRATOR'] as const) if (env[k]) problemas.push(`${k} definida`);
  if (problemas.length) {
    throw new Error(`modo e2e (PGlite) recusado: ${problemas.join(', ')}. Ele só roda em máquina de desenvolvimento ou no CI.`);
  }
}

/** PGlite novo com o bootstrap de roles (db/bootstrap em produção) e as migrações reais. */
async function bancoMigrado() {
  const client = new PGlite();
  await client.exec('CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;');
  await migrate(drizzle(client, { schema: s }), { migrationsFolder: PASTA_MIGRACOES });
  return client;
}

/** Código do piloto no servidor de e2e: o mesmo slug da produção, para o e2e do front digitar o que a portaria digita. */
export const CODIGO_PILOTO_E2E = 'parque';

export interface OpcoesServidorE2e {
  /** 0 = porta livre qualquer (testes). */
  porta: number;
  senha?: string;
  env?: NodeJS.ProcessEnv;
}

export async function iniciarServidorE2e(o: OpcoesServidorE2e) {
  verificarAmbienteE2e(o.env ?? process.env);
  const senha = o.senha || SENHA_E2E_PADRAO;
  // Cookie sem Secure (http://localhost) e argon2 leve: é teste. SameSite=Strict e HttpOnly continuam os de produção.
  const config: Config = configDeTeste({ cookie: { secure: false, nome: nomeCookie(false) }, trustProxy: false });

  // Modelo: banco semeado UMA vez. Cada reset troca o banco ativo por um clone dele (PGlite.clone, sem refazer migração).
  const modelo = await bancoMigrado();
  const dbModelo = drizzle(modelo, { schema: s });
  await seedEstrutura(dbModelo);
  const senhaHash = await hash(senha, { memoryCost: config.argon2.memoriaKib, timeCost: 1, parallelism: 1 });
  await seedUsuariosDev(dbModelo, { senhaHash, deveTrocarSenha: false });
  await dbModelo.insert(s.usuarioSistema).values(USUARIOS_E2E.map((u) => ({ ...u, senhaHash, deveTrocarSenha: false })));
  await seedPessoasDev(dbModelo, { chaveHmac: CHAVE_HMAC_TESTE });

  // Os serviços recebem um Proxy que delega ao banco ATIVO: o reset troca o alvo sem recriar o Nest.
  let cliente = modelo;
  let ativo = dbModelo as unknown as Db;
  const db = new Proxy({} as Db, {
    get(_alvo, chave) {
      const v = Reflect.get(ativo as object, chave, ativo);
      return typeof v === 'function' ? v.bind(ativo) : v;
    },
  });

  // Banco plataforma (SaaS, F2) com o piloto: o banco `portaria` do registro é o Proxy acima.
  const plataforma = await novoBancoPlataforma();
  const pilotoId = await registrarCondominio(plataforma.db, { codigo: CODIGO_PILOTO_E2E, banco: 'portaria', hmac: CHAVE_HMAC_TESTE, kek: KEK_TESTE });
  // App do Master (F5): usuários fictícios da plataforma e o provisionamento de verdade sobre PGlite (sem o sidecar).
  const masterHash = await hash(senha, { memoryCost: config.argon2.memoriaKib, timeCost: 1, parallelism: 1 });
  const semearMasters = () => semearMastersE2e(plataforma.db, masterHash);
  await semearMasters();
  const registro = new RegistroDeTeste(new Map([['portaria', db]]));
  const provisionador = provisionadorPglite({ plataforma, registro, mestra: MESTRA_TESTE });
  const mod = await comSaas(Test.createTestingModule({ imports: [AppModule] }), {
    plataforma: plataforma.db, registro, fecharPlataforma: async () => { await provisionador.cluster.fechar(); await plataforma.client.close(); },
  })
    .overrideProvider(PROVISIONADOR).useValue(provisionador)
    .overrideProvider(CONFIG).useValue(config)
    .overrideProvider(RELOGIO).useValue(relogioDoSistema)
    .compile();
  const app = mod.createNestApplication<NestExpressApplication>({ logger: ['error', 'warn'] });
  configurarApp(app, config);
  // Rotas só deste modo, registradas antes do init (depois dele o Nest já pôs o tratamento de 404 na frente). Uma por vez: reset concorrente não deixa banco órfão aberto.
  let fila: Promise<unknown> = Promise.resolve();
  const emFila = <T>(fn: () => Promise<T>) => (fila = fila.then(fn, fn)) as Promise<T>;
  const rota = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response) => {
    emFila(() => fn(req)).then(
      (r) => res.status(200).json({ ok: true, ...(r as object) }),
      (e: unknown) => res.status(400).json({ ok: false, erro: e instanceof Error ? e.message : String(e) }),
    );
  };
  const http = app.getHttpAdapter().getInstance();
  // O reset também devolve os usuários da plataforma ao estado semeado (senha, troca pendente), zera os limites de login
  // da plataforma e religa todos os módulos do piloto (o e2e de módulos desliga pelo app do Master; SAAS-19).
  // Condomínios criados pelo e2e do app do Master ficam (códigos únicos por execução).
  const religarModulos = async () => {
    await plataforma.db.update(condominio).set({ modulos: [...MODULOS_PLATAFORMA] }).where(eq(condominio.id, pilotoId));
    app.get(ResolvedorCondominio).invalidar();
  };
  http.post('/__e2e/reset', rota(async () => { await trocarBanco(); await semearMasters(); await religarModulos(); return {}; }));
  // Adultera um evento sem recalcular o hash (o que um DBA mal-intencionado faria): a verificação da trilha deve apontar.
  // session_replication_role=replica desliga os triggers de imutabilidade só nesta transação do banco de teste.
  http.post('/__e2e/adulterar-evento', rota(async (req) => {
    const pessoaNome = String((req.body as { pessoa?: unknown })?.pessoa ?? '');
    const [ev] = await ativo.select({ id: s.eventoAcesso.id }).from(s.eventoAcesso)
      .innerJoin(s.pessoa, eq(s.pessoa.id, s.eventoAcesso.pessoaId))
      .where(eq(s.pessoa.nome, pessoaNome)).orderBy(s.eventoAcesso.seq).limit(1);
    if (!ev) throw new Error(`nenhum evento de ${pessoaNome}`);
    await cliente.transaction(async (tx) => {
      await tx.exec("SET LOCAL session_replication_role = 'replica'");
      await tx.query("UPDATE evento_acesso SET observacao = 'adulterado fora da API' WHERE id = $1", [ev.id]);
    });
    return { eventoId: ev.id };
  }));
  // Senha temporária vencida sem esperar 72 h: o prazo vai para 1 min atrás (a API e a tela comparam com a hora real).
  http.post('/__e2e/vencer-senha-temporaria', rota(async (req) => {
    const login = String((req.body as { login?: unknown })?.login ?? '');
    const r = await ativo.update(s.usuarioSistema).set({ senhaTemporariaExpiraEm: sql`now() - interval '1 minute'` })
      .where(sql`lower(${s.usuarioSistema.login}) = lower(${login}) AND ${s.usuarioSistema.deveTrocarSenha}`)
      .returning({ id: s.usuarioSistema.id });
    if (!r.length) throw new Error(`${login} não tem senha temporária pendente`);
    return {};
  }));

  // Documentação (só neste modo): o OpenAPI sai dos metadados do app em execução; o Swagger UI vem do CDN com versão fixa.
  // O servidor local vai primeiro na lista, para o "Try it out" falar com este processo (e não com a produção).
  let openapi: string | undefined;
  http.get(`/${PREFIXO_GLOBAL}/openapi.json`, (_req: Request, res: Response) => {
    if (!openapi) {
      const doc = gerarOpenApi(app, { aviso: () => undefined }) as { servers: { url: string }[] };
      const local = doc.servers.find((sv) => sv.url.startsWith('http://127.0.0.1')) ?? doc.servers[0]!;
      openapi = JSON.stringify({ ...doc, servers: [{ ...local, url: `/${PREFIXO_GLOBAL}` }, ...doc.servers.filter((sv) => sv !== local)] });
    }
    res.type('application/json').send(openapi);
  });
  http.get(`/${PREFIXO_GLOBAL}/docs`, (_req: Request, res: Response) => { res.type('html').send(HTML_SWAGGER); });

  await app.init();

  // Dados de e2e pelos serviços da própria API (mesmas regras, trilha e hash), ainda no modelo.
  await semearDadosE2e(app);

  async function trocarBanco() {
    const anterior = cliente;
    cliente = (await modelo.clone()) as PGlite; // o clone é um PGlite (a assinatura devolve a interface)
    ativo = drizzle(cliente, { schema: s }) as unknown as Db;
    if (anterior !== modelo) await anterior.close();
  }
  await trocarBanco(); // o modelo nunca recebe escrita de teste

  await app.listen(o.porta, '127.0.0.1');
  const url = await app.getUrl();
  return {
    app,
    url: url.replace('[::1]', '127.0.0.1'),
    async fechar() {
      await app.close();
      if (cliente !== modelo) await cliente.close();
      await modelo.close();
    },
  };
}
