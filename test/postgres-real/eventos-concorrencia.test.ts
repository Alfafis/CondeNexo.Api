// Registro de acesso concorrente pela API inteira (Nest, guards, filtro) sobre PostgreSQL REAL com várias conexões
// (pool app_rw com LOGIN, o cenário de produção). O PGlite tem uma conexão só e não mostra corrida; aqui ela existe.
// Pulado sem PG_TEST_URL. Como rodar (raiz do repositório):
//   set -a; . ./.env; set +a; PG_TEST_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${DB_HOST_PORT}/postgres" npm run test:pg
import { hash } from '@node-rs/argon2';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { CONFIG } from '../../src/config/config';
import type { Db } from '../../src/database/database.module';
import { documentoBusca, mascararCpf } from '../../src/db/cpf';
import * as s from '../../src/db/schema';
import { seedEstrutura } from '../../src/db/seed';
import { cpfComDv, seedPessoasDev } from '../../src/db/seed-pessoas-dev';
import { seedUsuariosDev } from '../../src/db/seed-usuarios';
import { configurarApp } from '../../src/plataforma';
import { configDeTeste, cookieDe, SENHA } from '../helpers/app';
import { comSaas, plataformaComPiloto, registroDePool } from '../helpers/saas';
import { CHAVE_HMAC_TESTE, PASTA_MIGRACOES } from '../helpers/banco';

const URL_ADMIN = process.env.PG_TEST_URL;
const NOME_DB = `portaria_teste_ev_${Date.now()}`;
const JUST = 'Morador não atende o interfone, entrega urgente';
const V1 = '/api/v1';

function urlPara(base: string, banco: string, usuario?: string, senha?: string) {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  if (usuario) { u.username = usuario; u.password = senha ?? ''; }
  return u.toString();
}

describe.skipIf(!URL_ADMIN)('API sobre PostgreSQL real: registro de acesso concorrente', () => {
  let admin: pg.Client;
  let app: INestApplication;
  let leitura: pg.Pool;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const visitantes: string[] = [];

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    admin = new pg.Client({ connectionString: URL_ADMIN });
    admin.on('error', () => undefined);
    await admin.connect();
    const { rowCount: rwExiste } = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'app_rw'`);
    let senhaRw = 'senha_de_teste_app_rw';
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN CREATE ROLE app_migrator LOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw LOGIN; END IF;
    END $$`);
    if (rwExiste) {
      if (!process.env.APP_RW_PASSWORD) throw new Error('app_rw já existe neste cluster: defina APP_RW_PASSWORD (o teste não altera a senha real)');
      senhaRw = process.env.APP_RW_PASSWORD;
    } else {
      await admin.query(`ALTER ROLE app_rw PASSWORD '${senhaRw}'`);
    }
    await admin.query(`CREATE DATABASE ${NOME_DB} OWNER app_migrator`);

    // Migrações e seed como dono (app_migrator); a API conecta como app_rw (LOGIN), com várias conexões
    const mig = new pg.Client({ connectionString: urlPara(URL_ADMIN!, NOME_DB) });
    mig.on('error', () => undefined);
    await mig.connect();
    await mig.query('SET ROLE app_migrator');
    await mig.query('GRANT CREATE ON SCHEMA public TO app_migrator').catch(() => undefined);
    const dbMig = drizzle(mig, { schema: s });
    await migrate(dbMig, { migrationsFolder: PASTA_MIGRACOES });
    await seedEstrutura(dbMig);
    const config = configDeTeste();
    const senhaHash = await hash(SENHA, { memoryCost: config.argon2.memoriaKib, timeCost: 1, parallelism: 1 });
    await seedUsuariosDev(dbMig, { senhaHash, deveTrocarSenha: false });
    await seedPessoasDev(dbMig, { chaveHmac: CHAVE_HMAC_TESTE });
    for (let i = 0; i < 30; i++) {
      const cpf = cpfComDv(String(400_000_000 + i));
      const [p] = await dbMig.insert(s.pessoa).values({ nome: `Visitante Concorrente ${i}`, categoria: 'visitante', telefone: '11987650000',
        documentoMascarado: mascararCpf(cpf), documentoBusca: documentoBusca(cpf, CHAVE_HMAC_TESTE) }).returning();
      visitantes.push(p!.id);
    }
    const un = async (bloco: string, numero: string) => (await dbMig.select().from(s.unidade).where(and(eq(s.unidade.bloco, bloco), eq(s.unidade.numero, numero))))[0]!.id;
    ids.d32 = await un('D', '32');
    ids.t711 = await un('G', '11');
    ids.ana = (await dbMig.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro')))[0]!.id;
    ids.bruno = (await dbMig.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Bruno Teixeira')))[0]!.id;
    ids.marcos = (await dbMig.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Marcos Pereira')))[0]!.id;
    ids.paulo = (await dbMig.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Paulo Ribeiro')))[0]!.id;
    await mig.end();

    // Pool da API: o app o encerra no close (DatabaseModule). Erro em conexão ociosa não vira "unhandled".
    const pool = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, NOME_DB, 'app_rw', senhaRw), max: 10 });
    pool.on('error', () => undefined);
    leitura = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, NOME_DB, 'app_rw', senhaRw), max: 2 });
    leitura.on('error', () => undefined);
    // SaaS (F2): o banco de teste é o `portaria` do registro; a plataforma (PGlite) só tem o piloto.
    const plat = await plataformaComPiloto();
    const mod = await comSaas(Test.createTestingModule({ imports: [AppModule] }), {
      plataforma: plat.db, registro: registroDePool(pool, drizzle(pool, { schema: s }) as unknown as Db), fecharPlataforma: () => plat.client.close(),
    })
      .overrideProvider(CONFIG).useValue(config)
      .compile();
    const nest = mod.createNestApplication<NestExpressApplication>({ logger: false });
    configurarApp(nest, config);
    await nest.listen(0, '127.0.0.1');
    app = nest;
    let ip = 0;
    for (const [papel, login] of [['porteiro', 'joao.lima'], ['administracao', 'paula.nogueira'], ['auditor', 'luiza.campos']] as const) {
      const r = await request(app.getHttpServer()).post(`${V1}/auth/login`).set('X-Forwarded-For', `10.9.0.${++ip}`).send({ login, senha: SENHA });
      if (r.status !== 200) throw new Error(`login de ${login}: ${r.status}`);
      cookies[papel] = cookieDe(r.headers['set-cookie']);
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close(); // encerra o pool da API antes do DROP ... WITH (FORCE)
    await leitura?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${NOME_DB} WITH (FORCE)`);
      await admin.end();
    }
    vi.restoreAllMocks();
  });

  const post = (papel: string, url: string, corpo?: object) => request(app.getHttpServer()).post(`${V1}${url}`).set('Cookie', cookies[papel]!).send(corpo);
  const get = (papel: string, url: string) => request(app.getHttpServer()).get(`${V1}${url}`).set('Cookie', cookies[papel]!);
  const excecao = (pessoaId: string) => ({ pessoaId, unidadeDestinoId: ids.d32, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });

  it('30 entradas simultâneas de pessoas diferentes: todas gravadas, seq contínuo, cadeia íntegra', async () => {
    const rs = await Promise.all(visitantes.map((v) => post('porteiro', '/eventos-acesso', excecao(v))));
    expect(rs.map((r) => r.status)).toEqual(Array(30).fill(201));
    const seqs = rs.map((r) => r.body.data.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => seqs[0]! + i));
    expect((await get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: true, verificados: 30, ultimoSeq: 30 });
    expect((await get('porteiro', '/turnos/resumo')).body.data.pessoasDentro).toBe(30);
  }, 120_000);

  it('a mesma pessoa em 8 entradas simultâneas: uma entra, as outras 7 recebem 409 JA_ESTA_DENTRO', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => post('porteiro', '/eventos-acesso', excecao(ids.marcos!))));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(Array(7).fill('JA_ESTA_DENTRO'));
    const entrada = rs.find((r) => r.status === 201)!.body.data.id as string;
    // 8 saídas simultâneas da mesma entrada: uma grava, as outras 409 (índice único evento_saida_unica_uq)
    const ss = await Promise.all(Array.from({ length: 8 }, () => post('porteiro', `/eventos-acesso/${entrada}/saida`)));
    expect(ss.filter((r) => r.status === 201)).toHaveLength(1);
    expect(ss.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(Array(7).fill('SAIDA_JA_REGISTRADA'));
    expect(JSON.stringify(ss.map((r) => r.body))).not.toMatch(/evento_saida_unica_uq|duplicate key|password/i); // sem mensagem do driver
  }, 60_000);

  it('restrição: 6 tentativas simultâneas gravam 6 negados (um por tentativa, nenhum duplicado)', async () => {
    const r = await post('porteiro', '/restricoes', { pessoaId: ids.bruno, unidadeId: ids.d32, motivo: 'Morador não autoriza', validaAte: '2099-12-31', solicitadaPorPessoaId: ids.ana });
    expect(r.status).toBe(201);
    const db = drizzle(leitura, { schema: s });
    const contar = async () => Number((await db.select({ n: count() }).from(s.eventoAcesso).where(eq(s.eventoAcesso.tipo, 'negado')))[0]!.n);
    const antes = await contar();
    const rs = await Promise.all(Array.from({ length: 6 }, () => post('porteiro', '/eventos-acesso', excecao(ids.bruno!))));
    expect(rs.map((x) => x.body.code)).toEqual(Array(6).fill('PESSOA_EM_RESTRICAO'));
    const eventos = rs.map((x) => x.body.details.eventoId as string);
    expect(new Set(eventos).size).toBe(6);
    expect(await contar()).toBe(antes + 6);
  }, 60_000);

  it('correções simultâneas do mesmo evento: a última acumula as duas (advisory lock)', async () => {
    // Ana (moradora da D-32) visita a G-11: entra como visitante, por exceção
    const alvo = await post('porteiro', '/eventos-acesso', { ...excecao(ids.ana!), unidadeDestinoId: ids.t711 });
    expect(alvo.status).toBe(201);
    const id = alvo.body.data.id as string;
    const hora = Date.now() - 3_600_000;
    const [c1, c2] = await Promise.all([
      post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: 'Unidade digitada errada pelo porteiro', valores: { unidadeDestinoId: ids.d32 } }),
      post('administracao', `/eventos-acesso/${id}/correcoes`, { justificativa: 'Hora real informada pelo morador', valores: { ocorridoEm: hora } }),
    ]);
    expect([c1.status, c2.status]).toEqual([201, 201]);
    const ev = (await get('auditor', `/eventos-acesso/${id}`)).body.data;
    expect(ev).toMatchObject({ unidadeDestinoId: ids.d32, ocorridoEm: hora });
    expect(Object.keys(ev.valoresOriginais).sort()).toEqual(['ocorridoEm', 'unidadeDestinoId']);
  }, 60_000);

  it('encomenda: 8 retiradas simultâneas (duas pessoas com vínculo) gravam uma só; as outras 7 são 409 legíveis', async () => {
    const e = await post('porteiro', '/encomendas', { unidadeId: ids.d32, destinatario: 'Ana Ribeiro', unidadeConfirmada: true });
    expect(e.status).toBe(201);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post(i % 2 ? 'administracao' : 'porteiro', `/encomendas/${e.body.data.id}/retirada`, { pessoaId: i % 2 ? ids.paulo : ids.ana })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(Array(7).fill('ENCOMENDA_JA_ENTREGUE'));
    expect(JSON.stringify(rs.map((r) => r.body))).not.toMatch(/encomenda \d+ já foi retirada|check_violation|password/i); // sem a mensagem do trigger/driver
    const db = drizzle(leitura, { schema: s });
    const trilha = await db.select().from(s.auditLog).where(and(eq(s.auditLog.acao, 'encomenda.entregar'), eq(s.auditLog.registroId, e.body.data.id)));
    expect(trilha).toHaveLength(1);
  }, 60_000);

  it('ocorrência: 6 mudanças simultâneas para "em andamento": uma passa, as outras veem o novo status (422), histórico com uma linha', async () => {
    const o = await post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Portão travado', unidadeId: null });
    expect(o.status).toBe(201);
    const rs = await Promise.all(Array.from({ length: 6 }, () => post('porteiro', `/ocorrencias/${o.body.data.id}/status`, { status: 'em_andamento' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 200).map((r) => r.body.code)).toEqual(Array(5).fill('TRANSICAO_INVALIDA'));
    expect((await get('auditor', `/ocorrencias/${o.body.data.id}`)).body.data.historicoStatus).toHaveLength(1);
  }, 60_000);

  it('depois de tudo, a verificação no banco real continua íntegra', async () => {
    const r = await get('auditor', '/auditoria/integridade');
    const db = drizzle(leitura, { schema: s });
    const total = Number((await db.select({ n: count() }).from(s.eventoAcesso))[0]!.n);
    expect(r.body.data).toMatchObject({ valido: true, verificados: total, ultimoSeq: total });
  }, 60_000);
});
