// Provisionamento de condomínio novo sobre PostgreSQL REAL (src/saas/provisionar.ts com as portas da CLI de verdade:
// ClusterPg como app_provisionador, migrarComo como app_migrator, app_rw nos dados e app_plataforma na plataforma).
// O que o PGlite não prova: CREATE DATABASE por um role CREATEDB que só tem SET em app_migrator, os GRANTs de CONNECT
// do banco novo, o provisionador sem CONNECT no banco que criou, login com o código pela API e o isolamento entre
// bancos com roles de verdade. Também: idempotência e retomada depois de falha.
//
// Cria uma plataforma descartável e um condomínio "piloto" descartável (como o saas-multibanco), provisiona dois
// condomínios e apaga tudo no fim. Pulado sem PG_TEST_URL. Roles já existentes no cluster (CI: bootstrap): a senha
// vem do ambiente (APP_RW_PASSWORD, APP_PLATAFORMA_PASSWORD, APP_MIGRATOR_PASSWORD, APP_PROVISIONADOR_PASSWORD).
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { ClusterPg, migrarComo } from '../../src/cli/provisionar-condominio';
import { RELOGIO } from '../../src/comum/relogio';
import { CONFIG } from '../../src/config/config';
import type { Db } from '../../src/database/database.module';
import { REGISTRO_BANCOS, RegistroBancosPg } from '../../src/database/registro-bancos';
import * as s from '../../src/db/schema';
import { seedEstrutura } from '../../src/db/seed';
import { seedUsuariosDev } from '../../src/db/seed-usuarios';
import { configurarApp } from '../../src/plataforma';
import { CHAVE_MESTRA, type DbPlataforma, PLATAFORMA_DB, PLATAFORMA_POOL } from '../../src/saas/plataforma-db';
import { type Portas, provisionar, validarEntrada } from '../../src/saas/provisionar';
import { ResolvedorCondominio } from '../../src/saas/resolvedor';
import * as sp from '../../src/saas/schema-plataforma';
import { configDeTeste, cookieDe, SENHA } from '../helpers/app';
import { PASTA_MIGRACOES } from '../helpers/banco';
import { PASTA_MIGRACOES_PLATAFORMA } from '../helpers/plataforma';
import { MESTRA_TESTE, registrarCondominio } from '../helpers/saas';

const URL_ADMIN = process.env.PG_TEST_URL;
const sufixo = () => randomBytes(6).toString('hex').slice(0, 8);
const PILOTO = `portaria_${sufixo()}`;
const PLATAFORMA = `plataforma_prov_${Date.now()}`;
const V1 = '/api/v1';

function urlPara(base: string, banco: string, usuario?: string, senha?: string) {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  if (usuario) { u.username = usuario; u.password = senha ?? ''; }
  return u.toString();
}

async function tentar(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => undefined);
  try {
    await c.connect();
    return (await c.query<{ d: string }>('select current_database() as d')).rows[0]!.d;
  } catch (e) {
    return `ERRO: ${(e as Error).message}`;
  } finally {
    await c.end().catch(() => undefined);
  }
}

const ENTRADA = {
  codigo: 'prov-pg-a', nome: 'Provisionado A', cidade: 'Santos', uf: 'SP',
  estrutura: { agrupamento: 'Torre', blocos: ['1', '2', '3'], andares: [1, 2], finais: [1, 2, 3, 4], ausentes: [] },
  sindico: { nome: 'Síndico de Exemplo', login: 'sindico.exemplo' },
};

describe.skipIf(!URL_ADMIN)('provisionamento de condomínio sobre PostgreSQL real', () => {
  let admin: pg.Client;
  const senha: Record<string, string> = {
    app_rw: 'senha_teste_rw', app_plataforma: 'senha_teste_plataforma', app_migrator: 'senha_teste_migrator', app_provisionador: 'senha_teste_provisionador',
  };
  const ENV: Record<string, string> = {
    app_rw: 'APP_RW_PASSWORD', app_plataforma: 'APP_PLATAFORMA_PASSWORD', app_migrator: 'APP_MIGRATOR_PASSWORD', app_provisionador: 'APP_PROVISIONADOR_PASSWORD',
  };
  const criados: string[] = [PILOTO, PLATAFORMA];
  let poolPlat: pg.Pool;
  let clusterCli: pg.Client;
  const poolsRw = new Map<string, pg.Pool>();
  let app: INestApplication;
  let pilotoId = '';

  function portas(extra: Partial<Portas> = {}): Portas {
    return {
      plataforma: drizzle(poolPlat, { schema: sp }) as unknown as DbPlataforma,
      cluster: new ClusterPg(clusterCli),
      migrar: async (banco) => { criados.push(banco); return migrarComo(urlPara(URL_ADMIN!, 'postgres', 'app_migrator', senha.app_migrator), banco, PASTA_MIGRACOES); },
      dados: (banco) => {
        let p = poolsRw.get(banco);
        if (!p) {
          p = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, banco, 'app_rw', senha.app_rw), max: 2 });
          p.on('error', () => undefined);
          poolsRw.set(banco, p);
        }
        return drizzle(p, { schema: s }) as unknown as Db;
      },
      mestra: MESTRA_TESTE,
      hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }),
      gerarSenha: () => `temp-${randomBytes(6).toString('hex')}`,
      ...extra,
    };
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    admin = new pg.Client({ connectionString: URL_ADMIN });
    admin.on('error', () => undefined);
    await admin.connect();
    // Roles do bootstrap (db/bootstrap/00_roles.sh e 10_plataforma.sh). Existentes com LOGIN: senha do ambiente, sem alterar.
    for (const role of Object.keys(senha)) {
      const { rows } = await admin.query<{ login: boolean }>('SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = $1', [role]);
      if (rows[0]?.login) {
        const v = process.env[ENV[role]!];
        if (!v) throw new Error(`${role} já existe com LOGIN neste cluster: defina ${ENV[role]} (o teste não altera a senha real)`);
        senha[role] = v;
      } else {
        if (!rows[0]) await admin.query(`CREATE ROLE ${role} NOSUPERUSER NOCREATEROLE`);
        await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${senha[role]}'`);
      }
    }
    await admin.query('ALTER ROLE app_provisionador CREATEDB');
    await admin.query('GRANT app_migrator TO app_provisionador WITH INHERIT FALSE, SET TRUE');

    // "Piloto" descartável (outro banco já em uso, com os usuários de dev) e plataforma descartável.
    for (const [banco, quem] of [[PILOTO, 'app_rw'], [PLATAFORMA, 'app_plataforma']] as const) {
      await admin.query(`CREATE DATABASE ${banco} OWNER app_migrator`);
      await admin.query(`REVOKE ALL ON DATABASE ${banco} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${banco} TO app_migrator, ${quem}`);
    }
    const mig = new pg.Client({ connectionString: urlPara(URL_ADMIN!, PILOTO) });
    await mig.connect();
    await mig.query('SET ROLE app_migrator');
    const dbPiloto = drizzle(mig, { schema: s });
    await migrate(dbPiloto, { migrationsFolder: PASTA_MIGRACOES });
    await seedEstrutura(dbPiloto);
    await seedUsuariosDev(dbPiloto, { senhaHash: await hash(SENHA, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), deveTrocarSenha: false });
    await mig.end();
    const migPlat = new pg.Client({ connectionString: urlPara(URL_ADMIN!, PLATAFORMA) });
    await migPlat.connect();
    await migPlat.query('SET ROLE app_migrator');
    await migrate(drizzle(migPlat, { schema: sp }), { migrationsFolder: PASTA_MIGRACOES_PLATAFORMA });
    pilotoId = await registrarCondominio(drizzle(migPlat, { schema: sp }) as unknown as DbPlataforma, { codigo: 'piloto-pg', banco: PILOTO, hmac: randomBytes(32), kek: randomBytes(32) });
    await migPlat.end();

    poolPlat = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, PLATAFORMA, 'app_plataforma', senha.app_plataforma), max: 3 });
    poolPlat.on('error', () => undefined);
    clusterCli = new pg.Client({ connectionString: urlPara(URL_ADMIN!, 'postgres', 'app_provisionador', senha.app_provisionador) });
    clusterCli.on('error', () => undefined);
    await clusterCli.connect();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await clusterCli?.end().catch(() => undefined);
    for (const p of poolsRw.values()) await p.end().catch(() => undefined);
    await poolPlat?.end().catch(() => undefined);
    if (admin) {
      for (const b of new Set(criados)) await admin.query(`DROP DATABASE IF EXISTS ${b} WITH (FORCE)`);
      await admin.end();
    }
  });

  let resultadoA: Awaited<ReturnType<typeof provisionar>>;

  it('provisiona: banco do app_migrator, CONNECT só de app_migrator e app_rw, migrações todas, ativo', async () => {
    resultadoA = await provisionar(portas(), validarEntrada(ENTRADA));
    expect(resultadoA.situacao).toBe('provisionado');
    expect(resultadoA.unidades).toBe(24);
    const banco = resultadoA.banco;
    const q = async (sql: string) => (await admin.query(sql, [banco])).rows[0];
    expect(await q('SELECT pg_get_userbyid(datdba) AS dono FROM pg_database WHERE datname = $1')).toEqual({ dono: 'app_migrator' });
    expect(await q(`SELECT has_database_privilege('app_rw', $1, 'CONNECT') AS rw, has_database_privilege('app_plataforma', $1, 'CONNECT') AS plat,
      has_database_privilege('app_provisionador', $1, 'CONNECT') AS prov, has_database_privilege('public', $1, 'CONNECT') AS pub`))
      .toEqual({ rw: true, plat: false, prov: false, pub: false });
    // Login de verdade: o servidor recusa quem não tem CONNECT, inclusive o provisionador que criou o banco.
    expect(await tentar(urlPara(URL_ADMIN!, banco, 'app_provisionador', senha.app_provisionador))).toMatch(/^ERRO: permission denied for database/);
    expect(await tentar(urlPara(URL_ADMIN!, banco, 'app_plataforma', senha.app_plataforma))).toMatch(/^ERRO: permission denied for database/);
    expect(await tentar(urlPara(URL_ADMIN!, banco, 'app_rw', senha.app_rw))).toBe(banco);
    expect(await tentar(urlPara(URL_ADMIN!, PILOTO, 'app_provisionador', senha.app_provisionador))).toMatch(/^ERRO: permission denied for database/);
    // Os mesmos GRANTs do piloto nas tabelas: app_rw não apaga nem troca a configuração.
    const rw = poolsRw.get(banco)!;
    await expect(rw.query('delete from usuario_sistema')).rejects.toThrow(/permission denied/);
    await expect(rw.query(`update configuracao set agrupamento = 'Bloco'`)).rejects.toThrow(/permission denied/);
    expect((await poolPlat.query('select status, uf, cidade from condominio where codigo = $1', [ENTRADA.codigo])).rows)
      .toEqual([{ status: 'ativo', uf: 'SP', cidade: 'Santos' }]);
  });

  it('idempotente: a 2a execução não cria nada nem imprime senha', async () => {
    const r = await provisionar(portas(), validarEntrada(ENTRADA));
    expect(r.situacao).toBe('ja_provisionado');
    expect(r.sindico).toBeUndefined();
    expect(r.banco).toBe(resultadoA.banco);
  });

  it('retomada: falha depois do CREATE DATABASE fica provisionando; a 2a execução conclui no MESMO banco', async () => {
    const E = { ...ENTRADA, codigo: 'prov-pg-b', nome: 'Provisionado B', estrutura: { ...ENTRADA.estrutura, agrupamento: 'Bloco', blocos: ['A'] } };
    let falhou = false;
    const p = portas();
    const migrarReal = p.migrar;
    await expect(provisionar({ ...p, migrar: async (b) => { if (!falhou) { falhou = true; criados.push(b); throw new Error('queda simulada antes das migrações'); } return migrarReal(b); } }, validarEntrada(E)))
      .rejects.toThrow(/queda simulada/);
    const linhas = (await poolPlat.query<{ status: string; banco: string }>('select status, banco from condominio where codigo = $1', ['prov-pg-b'])).rows;
    expect(linhas).toEqual([{ status: 'provisionando', banco: expect.stringMatching(/^portaria_[a-z0-9]{8}$/) }]);
    expect((await admin.query('select 1 from pg_database where datname = $1', [linhas[0]!.banco])).rowCount).toBe(1);
    const r = await provisionar(p, validarEntrada(E));
    expect(r).toMatchObject({ situacao: 'retomado', banco: linhas[0]!.banco, unidades: 8 });
  });

  it('API: o síndico entra pelo código no condomínio novo; nada cruza com o piloto', async () => {
    const config = configDeTeste({ saas: { pilotoPadrao: false, chavesAmbiente: { hmacCpf: null, kek: null, kekVersao: null } } });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRO_BANCOS).useValue(new RegistroBancosPg(urlPara(URL_ADMIN!, PILOTO, 'app_rw', senha.app_rw), 2))
      .overrideProvider(PLATAFORMA_POOL).useValue({ end: async () => undefined })
      .overrideProvider(PLATAFORMA_DB).useValue(drizzle(poolPlat, { schema: sp }))
      .overrideProvider(CHAVE_MESTRA).useValue(MESTRA_TESTE)
      .overrideProvider(CONFIG).useValue(config)
      .overrideProvider(RELOGIO).useValue({ agora: () => new Date() })
      .compile();
    const nest = mod.createNestApplication<NestExpressApplication>({ logger: false });
    configurarApp(nest, config);
    await nest.listen(0, '127.0.0.1');
    app = nest;
    expect((await app.get(ResolvedorCondominio).atendidos()).map((x) => x.condominio.codigo).sort()).toEqual(['piloto-pg', 'prov-pg-a', 'prov-pg-b']);

    const http = () => request(app.getHttpServer());
    let ip = 0;
    const entrar = (codigo: string, login: string, senhaUsada: string) =>
      http().post(`${V1}/auth/login`).set('X-Condominio', codigo).set('X-Forwarded-For', `10.9.0.${++ip}`).send({ login, senha: senhaUsada });
    const ok = await entrar(ENTRADA.codigo, ENTRADA.sindico.login, resultadoA.sindico!.senhaTemporaria);
    expect(ok.status).toBe(200);
    expect(ok.body.data.usuario.deveTrocarSenha).toBe(true);
    const cookie = cookieDe(ok.headers['set-cookie']);
    expect(cookie).toContain(`v2.${resultadoA.condominioId}.`);
    // Cruzado: o síndico novo não existe no piloto; o usuário do piloto não existe no novo.
    expect((await entrar('piloto-pg', ENTRADA.sindico.login, resultadoA.sindico!.senhaTemporaria)).status).toBe(401);
    expect((await entrar(ENTRADA.codigo, 'joao.lima', SENHA)).status).toBe(401);
    expect((await entrar('piloto-pg', 'joao.lima', SENHA)).status).toBe(200);
    // Prefixo trocado para o piloto: o token não existe lá.
    const token = cookie.split('=')[1]!.split('.')[2]!;
    expect((await http().get(`${V1}/auth/me`).set('Cookie', `__Host-portaria_sessao=v2.${pilotoId}.${token}`)).status).toBe(401);
    expect((await http().get(`${V1}/auth/me`).set('Cookie', cookie)).status).toBe(200);
    // A sessão está no banco novo, não no piloto.
    expect((await poolsRw.get(resultadoA.banco)!.query('select count(*)::int as n from sessao')).rows[0].n).toBe(1);
    const piloto = new pg.Client({ connectionString: urlPara(URL_ADMIN!, PILOTO) });
    await piloto.connect();
    try {
      expect((await piloto.query('select count(*)::int as n from usuario_sistema where login = $1', [ENTRADA.sindico.login])).rows[0].n).toBe(0);
      expect((await piloto.query('select count(*)::int as n from configuracao')).rows[0].n).toBe(0);
    } finally { await piloto.end(); }
  });
});
