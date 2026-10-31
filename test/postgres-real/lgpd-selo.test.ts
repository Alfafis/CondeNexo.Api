// LGPD e selo sobre PostgreSQL REAL: a API conecta como app_rw (LOGIN, o cenário de produção), e o ataque é feito como
// SUPERUSUÁRIO do cluster, que é exatamente quem o hash sozinho não detém. Pulado sem PG_TEST_URL. Como rodar (raiz):
//   set -a; . ./.env; set +a; PG_TEST_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${DB_HOST_PORT}/postgres" npm run test:pg
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { principal as coletarAncoras } from '../../scripts/ancoras/anexar-selos.mjs';
import { AppModule } from '../../src/app.module';
import { diaBrt } from '../../src/comum/datas';
import { RELOGIO } from '../../src/comum/relogio';
import { CONFIG } from '../../src/config/config';
import type { Db } from '../../src/database/database.module';
import * as s from '../../src/db/schema';
import { seedEstrutura } from '../../src/db/seed';
import { seedPessoasDev } from '../../src/db/seed-pessoas-dev';
import { seedUsuariosDev } from '../../src/db/seed-usuarios';
import { configurarApp } from '../../src/plataforma';
import { ENVIO_ANCORA } from '../../src/selo/ancora';
import { conferirAncoras } from '../../src/selo/conferir-ancoras';
import { SeloService } from '../../src/selo/selo.module';
import { AncoraDeTeste, configDeTeste, cookieDe, SENHA } from '../helpers/app';
import { comSaas, plataformaComPiloto, registroDePool, servicoDe } from '../helpers/saas';
import { CHAVE_HMAC_TESTE, PASTA_MIGRACOES } from '../helpers/banco';

const URL_ADMIN = process.env.PG_TEST_URL;
const NOME_DB = `portaria_teste_lgpd_${Date.now()}`;
const JUST = 'Morador não atende o interfone, entrega urgente';
const V1 = '/api/v1';

function urlPara(base: string, banco: string, usuario?: string, senha?: string) {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  if (usuario) { u.username = usuario; u.password = senha ?? ''; }
  return u.toString();
}

describe.skipIf(!URL_ADMIN)('LGPD e selo sobre PostgreSQL real (app_rw com LOGIN; ataque como superusuário)', () => {
  let admin: pg.Client;
  let su: pg.Client; // superusuário conectado ao banco de teste
  let app: INestApplication;
  const ancora = new AncoraDeTeste();
  // Relógio real com deslocamento: o teste "espera" o cache do endpoint público vencer sem esperar de verdade.
  let deslocamentoMs = 0;
  const relogio = { agora: () => new Date(Date.now() + deslocamentoMs) };
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let pilotoId = ''; // a trava de job é por condomínio (SaaS, F2): portaria:job:<nome>:<condominio_id>

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

    const mig = new pg.Client({ connectionString: urlPara(URL_ADMIN!, NOME_DB) });
    mig.on('error', () => undefined);
    await mig.connect();
    await mig.query('SET ROLE app_migrator');
    await mig.query('GRANT CREATE ON SCHEMA public TO app_migrator').catch(() => undefined);
    const dbMig = drizzle(mig, { schema: s });
    await migrate(dbMig, { migrationsFolder: PASTA_MIGRACOES });
    await seedEstrutura(dbMig);
    // Destino github ligado (endpoint público dos selos diários); o envio por e-mail é o falso AncoraDeTeste.
    const config = configDeTeste({ ancora: { github: true, emails: [], remetente: 'portaria@localhost', smtp: null, arquivo: null } });
    const senhaHash = await hash(SENHA, { memoryCost: config.argon2.memoriaKib, timeCost: 1, parallelism: 1 });
    await seedUsuariosDev(dbMig, { senhaHash, deveTrocarSenha: false });
    await seedPessoasDev(dbMig, { chaveHmac: CHAVE_HMAC_TESTE });
    const [u] = await dbMig.select().from(s.unidade).limit(1);
    ids.unidade = u!.id;
    await mig.end();

    su = new pg.Client({ connectionString: urlPara(URL_ADMIN!, NOME_DB) });
    su.on('error', () => undefined);
    await su.connect();
    ids.marcos = (await su.query(`SELECT id FROM pessoa WHERE nome = 'Marcos Pereira'`)).rows[0].id;
    ids.bruno = (await su.query(`SELECT id FROM pessoa WHERE nome = 'Bruno Teixeira'`)).rows[0].id;

    const pool = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, NOME_DB, 'app_rw', senhaRw), max: 10 });
    pool.on('error', () => undefined);
    // SaaS (F2): o banco de teste é o `portaria` do registro; a plataforma (PGlite) só tem o piloto.
    const plat = await plataformaComPiloto();
    pilotoId = plat.pilotoId;
    const mod = await comSaas(Test.createTestingModule({ imports: [AppModule] }), {
      plataforma: plat.db, registro: registroDePool(pool, drizzle(pool, { schema: s }) as unknown as Db), fecharPlataforma: () => plat.client.close(),
    })
      .overrideProvider(CONFIG).useValue(config)
      .overrideProvider(ENVIO_ANCORA).useValue(ancora)
      .overrideProvider(RELOGIO).useValue(relogio)
      .compile();
    const nest = mod.createNestApplication<NestExpressApplication>({ logger: false });
    configurarApp(nest, config);
    await nest.listen(0, '127.0.0.1');
    app = nest;
    let ip = 0;
    for (const [papel, login] of [['porteiro', 'joao.lima'], ['sindico', 'carlos.andrade'], ['auditor', 'luiza.campos']] as const) {
      const r = await request(app.getHttpServer()).post(`${V1}/auth/login`).set('X-Forwarded-For', `10.8.0.${++ip}`).send({ login, senha: SENHA });
      if (r.status !== 200) throw new Error(`login de ${login}: ${r.status}`);
      cookies[papel] = cookieDe(r.headers['set-cookie']);
    }
    for (let i = 0; i < 3; i++) {
      const e = await post('porteiro', '/eventos-acesso', { pessoaId: ids.marcos, unidadeDestinoId: ids.unidade, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
      if (e.status !== 201) throw new Error(`entrada: ${e.status}`);
      await post('porteiro', `/eventos-acesso/${e.body.data.id}/saida`);
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await su?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${NOME_DB} WITH (FORCE)`);
      await admin.end();
    }
    vi.restoreAllMocks();
  });

  const post = (papel: string, url: string, corpo?: object) => request(app.getHttpServer()).post(`${V1}${url}`).set('Cookie', cookies[papel]!).send(corpo);
  const get = (papel: string, url: string) => request(app.getHttpServer()).get(`${V1}${url}`).set('Cookie', cookies[papel]!);

  it('app_rw (LOGIN) anonimiza, roda a retenção completa e sela com as funções SECURITY DEFINER; não apaga trilha direto', async () => {
    const a = await post('sindico', `/lgpd/pessoas/${ids.bruno}/anonimizar`);
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ pessoaId: ids.bruno, eventosRetidos: 0, retidoAte: null });
    const r = await post('sindico', '/lgpd/retencao');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ eventosDescartados: 0, trilhaDescartada: 0, registrosSemArquivo: 0 });
    const rw = await su.query(`SELECT has_table_privilege('app_rw', 'audit_log', 'DELETE') AS d, has_table_privilege('app_rw', 'retencao_execucao', 'INSERT') AS i,
      has_function_privilege('app_rw', 'retencao_descartar_audit()', 'EXECUTE') AS f`);
    expect(rw.rows[0]).toEqual({ d: false, i: false, f: true });
    const exec = await su.query(`SELECT tipo FROM retencao_execucao ORDER BY executada_em`);
    expect(exec.rows.map((x) => x.tipo)).toEqual(expect.arrayContaining(['pessoas', 'audit_redacao']));
  });

  it('0007: a anonimização (dona app_migrator, chamada pelo app_rw) limpa registros congelados; o app_rw sozinho não passa pela exceção', async () => {
    const v = await post('sindico', '/pessoas', { nome: 'Teodoro Visitante Real', categoria: 'visitante', documento: '111.444.777-35', telefone: '11955554444' });
    expect(v.status).toBe(201);
    const ana = (await su.query(`SELECT id FROM pessoa WHERE nome = 'Ana Ribeiro'`)).rows[0].id as string;
    const anaUn = (await su.query(`SELECT unidade_id FROM vinculo_unidade WHERE pessoa_id = $1 AND status = 'aprovado' LIMIT 1`, [ana])).rows[0].unidade_id as string;
    const enc = await post('porteiro', '/encomendas', { unidadeId: anaUn, destinatario: 'Teodoro Visitante Real', unidadeConfirmada: true });
    expect((await post('porteiro', `/encomendas/${enc.body.data.id}/retirada`, { pessoaId: ana })).status).toBe(200);
    const oc = await post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Teodoro Visitante Real deixou um volume' });
    await post('sindico', `/ocorrencias/${oc.body.data.id}/status`, { status: 'em_andamento' });
    await post('sindico', `/ocorrencias/${oc.body.data.id}/status`, { status: 'encerrada' });
    const a = await post('sindico', `/lgpd/pessoas/${v.body.data.id}/anonimizar`);
    expect(a.status).toBe(200);
    expect(a.body.data.limpeza).toMatchObject({ textoLivre: 'substituido', encomendas: 1, ocorrencias: 1 });
    expect((await su.query('SELECT destinatario FROM encomenda WHERE id = $1', [enc.body.data.id])).rows[0].destinatario).toBe('[anonimizado]');
    expect((await su.query('SELECT descricao FROM ocorrencia WHERE id = $1', [oc.body.data.id])).rows[0].descricao).toBe('[anonimizado] deixou um volume');
    // app_rw com o GUC ligado continua barrado (não é o dono da tabela)
    const rw = new pg.Client({ connectionString: urlPara(URL_ADMIN!, NOME_DB, 'app_rw', process.env.APP_RW_PASSWORD ?? 'senha_de_teste_app_rw') });
    rw.on('error', () => undefined);
    await rw.connect();
    try {
      await rw.query(`SELECT set_config('portaria.operacao', 'lgpd_anonimizar', false)`);
      await expect(rw.query('UPDATE encomenda SET destinatario = $1 WHERE id = $2', ['x', enc.body.data.id])).rejects.toThrow(/já foi retirada/);
      await expect(rw.query('UPDATE ocorrencia SET descricao = $1 WHERE id = $2', ['x', oc.body.data.id])).rejects.toThrow(/encerrada/);
    } finally { await rw.end(); }
  });

  it('trava de job entre conexões: com a trava tomada por outra sessão, 409; solta, roda', async () => {
    await su.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`portaria:job:retencao:${pilotoId}`]);
    try {
      const r = await post('sindico', '/lgpd/retencao');
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('RETENCAO_EM_ANDAMENTO');
    } finally {
      await su.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`portaria:job:retencao:${pilotoId}`]);
    }
    expect((await post('sindico', '/lgpd/retencao')).status).toBe(200);
  });

  it('superusuário reescreve um evento e RECALCULA a cadeia inteira: o selo denuncia; se ele também reescreve o selo, só a âncora externa (arquivo do GitHub e e-mail) denuncia', async () => {
    // Selo diário de hoje (o que o GitHub coleta) e a coleta do workflow: endpoint público -> script -> selos.jsonl
    expect((await (await servicoDe<SeloService>(app, SeloService)).selarDia(diaBrt(new Date())))?.novo).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'ancoras-pg-'));
    const f = { resposta: join(dir, 'resposta.json'), arquivo: join(dir, 'selos.jsonl'), relatorio: join(dir, 'divergencia.md') };
    const coletar = async () => {
      deslocamentoMs += 61_000; // fora do cache de 60 s (a coleta real é diária)
      const r = await request(app.getHttpServer()).get(`${V1}/auditoria/selos/publico`).set('X-Forwarded-For', '10.8.9.9');
      expect(r.status).toBe(200);
      writeFileSync(f.resposta, r.text);
      return coletarAncoras(['--resposta', f.resposta, '--arquivo', f.arquivo, '--relatorio', f.relatorio]);
    };
    expect((await coletar()).novos).toHaveLength(1);
    const ancorado = readFileSync(f.arquivo, 'utf8');
    const diaAncorado = JSON.parse(ancorado) as { seq: number; hash: string };
    const exportar = async () => (await post('auditor', '/auditoria/exportacoes', {})).body.data.conteudo as string;
    expect((await conferirAncoras(await exportar(), ancorado)).conclusao).toBe('confere');

    // Selo manual com e-mail (o destino opcional): a cabeça andou? não; devolve o diário existente, já "enviado".
    const selo = await post('auditor', '/auditoria/selos');
    expect(selo.body.data).toMatchObject({ ancora: 'enviada' });
    const recebido = ancora.enviados.at(-1)!; // o que o conselho guardou no e-mail
    expect(recebido).toMatchObject({ ultimoSeq: diaAncorado.seq, ultimoHash: diaAncorado.hash });
    expect((await get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: true, selosConferidos: 1 });

    // Ataque: desliga o append-only, altera o seq 2 e recalcula TODOS os hashes e a cabeça
    await su.query(`ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel`);
    try {
      await su.query(`UPDATE evento_acesso SET observacao = 'inserido depois do fato' WHERE seq = 2`);
      await su.query(`DO $$ DECLARE r evento_acesso%ROWTYPE; ant text := encode(sha256(convert_to('genesis', 'UTF8')), 'hex'); h text; BEGIN
        FOR r IN SELECT * FROM evento_acesso ORDER BY seq LOOP
          h := encode(sha256(convert_to(ant || evento_acesso_canonico(r), 'UTF8')), 'hex');
          UPDATE evento_acesso SET hash_anterior = ant, hash = h WHERE id = r.id;
          ant := h;
        END LOOP;
        UPDATE evento_acesso_cadeia SET ultimo_hash = ant WHERE id = 1;
      END $$`);
    } finally {
      await su.query(`ALTER TABLE evento_acesso ENABLE TRIGGER evento_acesso_imutavel`);
    }
    // A cadeia, por dentro, é coerente; o selo gravado no dia não bate mais
    const r1 = await get('auditor', '/auditoria/integridade');
    expect(r1.body.data).toMatchObject({ valido: false, motivo: 'selo_divergente', primeiroSeqInvalido: recebido.ultimoSeq });

    // O atacante também reescreve o selo no banco: a verificação interna volta a dizer "íntegra"...
    await su.query(`ALTER TABLE selo_cadeia DISABLE TRIGGER selo_cadeia_validar`);
    try {
      await su.query(`UPDATE selo_cadeia s SET ultimo_hash = e.hash FROM evento_acesso e WHERE e.seq = s.ultimo_seq`);
    } finally {
      await su.query(`ALTER TABLE selo_cadeia ENABLE TRIGGER selo_cadeia_validar`);
    }
    expect((await get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: true });
    // ...mas o arquivo de âncoras do GitHub, comparado OFFLINE com a trilha exportada, prova a reescrita
    const r = await conferirAncoras(await exportar(), ancorado);
    expect(r).toMatchObject({ conclusao: 'divergente', trilha: { valido: true }, divergentes: [{ seq: diaAncorado.seq, hashAncorado: diaAncorado.hash }] });
    // e a coleta seguinte do workflow falha alto, sem tocar no arquivo
    const depois = await coletar();
    expect(depois.codigo).toBe(2);
    expect(readFileSync(f.arquivo, 'utf8')).toBe(ancorado);
    // O e-mail (destino opcional) também denuncia, pela conferência na API
    const c = await post('auditor', '/auditoria/selos/conferir', { seq: recebido.ultimoSeq, hash: recebido.ultimoHash });
    expect(c.body.data).toMatchObject({ confere: false, motivo: 'hash_divergente' });
    expect(c.body.data.hashNoBanco).not.toBe(recebido.ultimoHash);
  });
});
