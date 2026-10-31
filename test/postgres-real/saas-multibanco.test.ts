// SaaS multi-banco (fase F2) sobre PostgreSQL REAL: o que o PGlite (superusuário, uma conexão) não prova.
//  - app_plataforma não abre conexão em banco de condomínio, e app_rw não abre no banco da plataforma (§6.1 item 6);
//  - o RegistroBancosPg abre o banco CERTO a partir da DATABASE_URL (outro nome de banco, mesmo role app_rw);
//  - a API inteira, com app_plataforma de verdade lendo `condominio`/`condominio_chave` e app_rw nos dois bancos:
//    login por código em cada condomínio, sessão de um não abre o outro, e o agendador sela os dois com a trava
//    (advisory lock) de cada banco.
// Cria dois bancos de condomínio e um de plataforma descartáveis (como o onboarding da F5 fará), e apaga no fim.
// Pulado sem PG_TEST_URL. Precisa de APP_RW_PASSWORD e APP_PLATAFORMA_PASSWORD se os roles já existirem no cluster.
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { RELOGIO } from '../../src/comum/relogio';
import { CONFIG } from '../../src/config/config';
import { RegistroBancosPg } from '../../src/database/registro-bancos';
import * as s from '../../src/db/schema';
import { seedEstrutura } from '../../src/db/seed';
import { seedUsuariosDev } from '../../src/db/seed-usuarios';
import { Agendador } from '../../src/jobs/agendador';
import { CHAVE_MESTRA, type DbPlataforma, PLATAFORMA_DB, PLATAFORMA_POOL } from '../../src/saas/plataforma-db';
import { REGISTRO_BANCOS } from '../../src/database/registro-bancos';
import * as sp from '../../src/saas/schema-plataforma';
import { configurarApp } from '../../src/plataforma';
import { configDeTeste, cookieDe, SENHA } from '../helpers/app';
import { PASTA_MIGRACOES } from '../helpers/banco';
import { PASTA_MIGRACOES_PLATAFORMA } from '../helpers/plataforma';
import { MESTRA_TESTE, registrarCondominio } from '../helpers/saas';

const URL_ADMIN = process.env.PG_TEST_URL;
const sufixo = () => randomBytes(6).toString('hex').slice(0, 8); // [0-9a-f]{8}: cabe no CHECK condominio_banco_ck
const BANCO_A = `portaria_${sufixo()}`;
const BANCO_B = `portaria_${sufixo()}`;
const PLATAFORMA = `plataforma_teste_${Date.now()}`;
const V1 = '/api/v1';

function urlPara(base: string, banco: string, usuario?: string, senha?: string) {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  if (usuario) { u.username = usuario; u.password = senha ?? ''; }
  return u.toString();
}

/** Tenta logar e rodar `select current_database()`; devolve o banco ou a mensagem de erro do servidor. */
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

describe.skipIf(!URL_ADMIN)('SaaS multi-banco sobre PostgreSQL real (F2)', () => {
  let admin: pg.Client;
  const senha = { rw: 'senha_de_teste_app_rw', plataforma: 'senha_de_teste_app_plataforma' };
  let app: INestApplication;
  let poolPlat: pg.Pool;
  let dbPlat: DbPlataforma;
  const ids = { a: '', b: '' };
  const bancos: Record<string, NodePgDatabase<typeof s>> = {};
  let fechar: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    admin = new pg.Client({ connectionString: URL_ADMIN });
    admin.on('error', () => undefined);
    await admin.connect();
    // Roles do bootstrap (db/bootstrap/00_roles.sh e 10_plataforma.sh). Existentes: usa a senha do ambiente, sem alterar.
    for (const [role, chave, env] of [['app_rw', 'rw', 'APP_RW_PASSWORD'], ['app_plataforma', 'plataforma', 'APP_PLATAFORMA_PASSWORD']] as const) {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1 AND rolcanlogin', [role]);
      if (rowCount) {
        if (!process.env[env]) throw new Error(`${role} já existe neste cluster: defina ${env} (o teste não altera a senha real)`);
        senha[chave] = process.env[env]!;
      } else {
        await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
        await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${senha[chave]}'`);
      }
    }
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN CREATE ROLE app_migrator LOGIN; END IF; END $$`);

    // Bancos de condomínio como o provisionamento fará: dono app_migrator, CONNECT só para app_migrator e app_rw.
    for (const banco of [BANCO_A, BANCO_B]) {
      await admin.query(`CREATE DATABASE ${banco} OWNER app_migrator`);
      await admin.query(`REVOKE ALL ON DATABASE ${banco} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${banco} TO app_migrator, app_rw`);
      const mig = new pg.Client({ connectionString: urlPara(URL_ADMIN!, banco) });
      mig.on('error', () => undefined);
      await mig.connect();
      await mig.query('SET ROLE app_migrator');
      const db = drizzle(mig, { schema: s });
      await migrate(db, { migrationsFolder: PASTA_MIGRACOES });
      await seedEstrutura(db);
      await seedUsuariosDev(db, { senhaHash: await hash(SENHA, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), deveTrocarSenha: false });
      bancos[banco] = db;
      fechar.push(() => mig.end());
    }
    // Plataforma descartável (nome próprio para não tocar no `plataforma` do cluster), como o 10_plataforma.sh.
    await admin.query(`CREATE DATABASE ${PLATAFORMA} OWNER app_migrator`);
    await admin.query(`REVOKE ALL ON DATABASE ${PLATAFORMA} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${PLATAFORMA} TO app_migrator, app_plataforma`);
    const migPlat = new pg.Client({ connectionString: urlPara(URL_ADMIN!, PLATAFORMA) });
    migPlat.on('error', () => undefined);
    await migPlat.connect();
    await migPlat.query('SET ROLE app_migrator');
    await migrate(drizzle(migPlat, { schema: sp }), { migrationsFolder: PASTA_MIGRACOES_PLATAFORMA });
    await migPlat.end();

    // A API lê a plataforma como app_plataforma DE VERDADE; o registro dos condomínios (onboarding, F5) é do operador.
    poolPlat = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, PLATAFORMA, 'app_plataforma', senha.plataforma), max: 3 });
    poolPlat.on('error', () => undefined);
    dbPlat = drizzle(poolPlat, { schema: sp }) as unknown as DbPlataforma;
    const su = new pg.Client({ connectionString: urlPara(URL_ADMIN!, PLATAFORMA) });
    await su.connect();
    const dbSu = drizzle(su, { schema: sp }) as unknown as DbPlataforma;
    ids.a = await registrarCondominio(dbSu, { codigo: 'cond-a', banco: BANCO_A, hmac: randomBytes(32), kek: randomBytes(32) });
    ids.b = await registrarCondominio(dbSu, { codigo: 'cond-b', banco: BANCO_B, hmac: randomBytes(32), kek: randomBytes(32) });
    await su.end();

    // Sem piloto: transição desligada (ninguém aqui é o banco `portaria`).
    const config = configDeTeste({ saas: { pilotoPadrao: false, chavesAmbiente: { hmacCpf: null, kek: null, kekVersao: null } } });
    const registro = new RegistroBancosPg(urlPara(URL_ADMIN!, BANCO_A, 'app_rw', senha.rw));
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRO_BANCOS).useValue(registro)
      .overrideProvider(PLATAFORMA_POOL).useValue(poolPlat)
      .overrideProvider(PLATAFORMA_DB).useValue(dbPlat)
      .overrideProvider(CHAVE_MESTRA).useValue(MESTRA_TESTE)
      .overrideProvider(CONFIG).useValue(config)
      .overrideProvider(RELOGIO).useValue({ agora: () => new Date() })
      .compile();
    const nest = mod.createNestApplication<NestExpressApplication>({ logger: false });
    configurarApp(nest, config);
    await nest.listen(0, '127.0.0.1');
    app = nest;
  }, 180_000);

  afterAll(async () => {
    await app?.close(); // fecha os pools app_rw (registro) e o da plataforma
    for (const f of fechar) await f().catch(() => undefined);
    if (admin) {
      for (const b of [BANCO_A, BANCO_B, PLATAFORMA]) await admin.query(`DROP DATABASE IF EXISTS ${b} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('§6.1 item 6: app_plataforma não entra em banco de condomínio; app_rw não entra na plataforma', async () => {
    for (const banco of [BANCO_A, BANCO_B]) {
      expect(await tentar(urlPara(URL_ADMIN!, banco, 'app_plataforma', senha.plataforma))).toMatch(/^ERRO: permission denied for database/);
      expect(await tentar(urlPara(URL_ADMIN!, banco, 'app_rw', senha.rw))).toBe(banco);
    }
    expect(await tentar(urlPara(URL_ADMIN!, PLATAFORMA, 'app_rw', senha.rw))).toMatch(/^ERRO: permission denied for database/);
    expect(await tentar(urlPara(URL_ADMIN!, PLATAFORMA, 'app_plataforma', senha.plataforma))).toBe(PLATAFORMA);
  });

  it('app_plataforma lê o cadastro e as chaves embrulhadas, mas não apaga nem troca o embrulho', async () => {
    const c = await poolPlat.connect();
    try {
      expect((await c.query('select count(*)::int as n from condominio_chave where ativa')).rows[0].n).toBe(4);
      await expect(c.query('delete from condominio_chave')).rejects.toThrow(/permission denied/);
      await expect(c.query('delete from condominio')).rejects.toThrow(/permission denied/);
      await expect(c.query(`update condominio_chave set chave_cifrada = chave_cifrada`)).rejects.toThrow(/permission denied/);
    } finally { c.release(); }
  });

  it('RegistroBancosPg: mesma DATABASE_URL (app_rw), banco trocado pelo nome; nome fora do formato é recusado', async () => {
    const r = new RegistroBancosPg(urlPara(URL_ADMIN!, BANCO_A, 'app_rw', senha.rw), 2);
    try {
      for (const banco of [BANCO_A, BANCO_B]) {
        expect((await r.pool(banco).query('select current_database() as d, current_user as u')).rows[0]).toEqual({ d: banco, u: 'app_rw' });
      }
      for (const ruim of ['plataforma', 'postgres', 'portaria_A1234567', 'portaria;drop', `${BANCO_A}x`]) expect(() => r.db(ruim)).toThrow(/fora do formato/);
    } finally { await r.fechar(); }
  });

  it('login por código em cada condomínio; o cookie de um não abre o outro (sessões em bancos diferentes)', async () => {
    const http = () => request(app.getHttpServer());
    const entrar = async (codigo: string) => {
      const r = await http().post(`${V1}/auth/login`).set('X-Condominio', codigo).set('X-Forwarded-For', `10.7.0.${codigo.length}`).send({ login: 'joao.lima', senha: SENHA });
      expect(r.status).toBe(200);
      return cookieDe(r.headers['set-cookie']);
    };
    const a = await entrar('cond-a');
    const b = await entrar('cond-b');
    expect((await http().get(`${V1}/auth/me`).set('Cookie', a)).status).toBe(200);
    expect((await http().get(`${V1}/auth/me`).set('Cookie', b)).status).toBe(200);
    const token = a.split('=')[1]!.split('.')[2]!;
    expect((await http().get(`${V1}/auth/me`).set('Cookie', `__Host-portaria_sessao=v2.${ids.b}.${token}`)).status).toBe(401);
    // Sem código e com a transição desligada: nenhum condomínio.
    expect((await http().post(`${V1}/auth/login`).send({ login: 'joao.lima', senha: SENHA })).status).toBe(401);
    // Cada sessão está no banco do seu condomínio.
    for (const [banco, n] of [[BANCO_A, 1], [BANCO_B, 1]] as const) {
      expect(await bancos[banco]!.select().from(s.sessao)).toHaveLength(n);
    }
  });

  it('agendador: sela os dois condomínios, cada um com a trava (advisory lock) do próprio banco', async () => {
    // Trava do selo de A presa por outra conexão (outra réplica): A pula o selo, B sela normalmente.
    const outra = new pg.Client({ connectionString: urlPara(URL_ADMIN!, BANCO_A, 'app_rw', senha.rw) });
    await outra.connect();
    await outra.query('select pg_advisory_lock(hashtextextended($1, 0))', [`portaria:job:selo:${ids.a}`]);
    try {
      expect((await app.get(Agendador).ciclo()).falharam).toEqual([]);
      expect(await bancos[BANCO_A]!.select().from(s.seloCadeia)).toHaveLength(0);
      expect(await bancos[BANCO_B]!.select().from(s.seloCadeia)).toHaveLength(1);
    } finally {
      await outra.end();
    }
    expect((await app.get(Agendador).ciclo()).falharam).toEqual([]);
    expect(await bancos[BANCO_A]!.select().from(s.seloCadeia)).toHaveLength(1);
  });
});
