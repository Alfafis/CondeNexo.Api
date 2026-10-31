// Testes que dependem de um PostgreSQL de verdade (16+): várias conexões simultâneas e login como app_rw.
// Pulados sem PG_TEST_URL. Como rodar: db/README.md ("Testes contra Postgres real").
//   PG_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:pg
// O teste cria um banco descartável (portaria_teste_<n>), aplica as migrações como app_migrator e o remove no fim.
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paraExportacao, verificarCadeia } from '../../src/db/cadeia';
import * as s from '../../src/db/schema';
import { seedEstrutura } from '../../src/db/seed';
import { PASTA_MIGRACOES, SENHA_FALSA } from '../helpers/banco';

const URL_ADMIN = process.env.PG_TEST_URL;
const NOME_DB = `portaria_teste_${Date.now()}`;
// Roles são do cluster: se app_rw já existe (ex.: Postgres do compose), o teste usa a senha real vinda de
// APP_RW_PASSWORD e nunca a altera; só define senha própria quando é ele quem cria o role.
let SENHA_APP = 'senha_de_teste_app_rw';

function urlPara(base: string, banco: string, usuario?: string, senha?: string) {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  if (usuario) { u.username = usuario; u.password = senha ?? ''; }
  return u.toString();
}

describe.skipIf(!URL_ADMIN)('PostgreSQL real', () => {
  let admin: pg.Client;
  let rw: pg.Pool;
  const ids = { pessoa: '', unidade: '', ponto: '', operador: '' };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL_ADMIN });
    await admin.connect();
    // Bootstrap equivalente a db/bootstrap/00_roles.sh (idempotente; senhas só de teste)
    const { rowCount: rwExiste } = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'app_rw'`);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN CREATE ROLE app_migrator LOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw LOGIN; END IF;
    END $$`);
    if (rwExiste) {
      if (!process.env.APP_RW_PASSWORD) throw new Error('app_rw já existe neste cluster: defina APP_RW_PASSWORD (o teste não altera a senha real)');
      SENHA_APP = process.env.APP_RW_PASSWORD;
    } else {
      await admin.query(`ALTER ROLE app_rw PASSWORD '${SENHA_APP}'`);
    }
    await admin.query(`CREATE DATABASE ${NOME_DB} OWNER app_migrator`);

    // Migrações como app_migrator (dono do schema), nunca como app_rw
    const mig = new pg.Client({ connectionString: urlPara(URL_ADMIN!, NOME_DB) });
    await mig.connect();
    await mig.query('SET ROLE app_migrator');
    await mig.query('GRANT CREATE ON SCHEMA public TO app_migrator').catch(() => undefined);
    const dbMig = drizzle(mig, { schema: s });
    await migrate(dbMig, { migrationsFolder: PASTA_MIGRACOES });
    await seedEstrutura(dbMig);
    const [u] = await dbMig.insert(s.usuarioSistema).values({ nome: 'Porteiro', login: 'p', papel: 'porteiro', senhaHash: SENHA_FALSA }).returning();
    const [p] = await dbMig.insert(s.pessoa).values({ nome: 'Visitante', categoria: 'visitante', telefone: '11999998888', semCpf: true }).returning();
    const [un] = await dbMig.select().from(s.unidade).limit(1);
    const [pa] = await dbMig.select().from(s.pontoAcesso).limit(1);
    Object.assign(ids, { pessoa: p.id, unidade: un.id, ponto: pa.id, operador: u.id });
    await mig.end();

    // A API conecta com LOGIN app_rw (não SET ROLE): é o cenário de produção
    rw = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, NOME_DB, 'app_rw', SENHA_APP), max: 10 });
  }, 120_000);

  afterAll(async () => {
    await rw?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${NOME_DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  const inserir = (c: pg.Pool | pg.PoolClient) => c.query(
    `INSERT INTO evento_acesso (tipo, categoria_pessoa, pessoa_id, unidade_destino_id, ponto_acesso_id, autorizado_por_tipo,
       justificativa, operador_id, operador_papel)
     VALUES ('entrada', 'visitante', $1, $2, $3, 'excecao_porteiro', 'Morador não atende, entrega urgente', $4, 'porteiro')`,
    [ids.pessoa, ids.unidade, ids.ponto, ids.operador]);

  it('200 inserções concorrentes em 10 conexões: seq contínuo e cadeia válida', async () => {
    await Promise.all(Array.from({ length: 200 }, () => inserir(rw)));
    // Transações longas concorrentes: a segunda espera o COMMIT da primeira (FOR UPDATE na cabeça)
    const [a, b] = await Promise.all([rw.connect(), rw.connect()]);
    await a.query('BEGIN'); await b.query('BEGIN');
    await inserir(a);
    const pendente = inserir(b); // bloqueia até `a` terminar
    await new Promise((r) => setTimeout(r, 200));
    await a.query('ROLLBACK'); // o seq que `a` tomou é devolvido: sem lacuna
    await pendente; await b.query('COMMIT');
    a.release(); b.release();

    const dbRw = drizzle(rw, { schema: s });
    const evs = (await dbRw.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(evs).toHaveLength(201);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: 201, ultimoSeq: 201 });
  }, 120_000);

  it('RF-05 (login app_rw): aprovar sem conferência falha; observação com CPF falha; aprovado congela a conferência', async () => {
    const { rows: [v] } = await rw.query(
      `INSERT INTO vinculo_unidade (pessoa_id, unidade_id, tipo, registrado_por_id) VALUES ($1, $2, 'dependente', $3) RETURNING id`,
      [ids.pessoa, ids.unidade, ids.operador]);
    const aprovar = () => rw.query(`UPDATE vinculo_unidade SET status = 'aprovado', decidido_por_id = $2, decidido_em = now() WHERE id = $1`, [v.id, ids.operador]);
    const conferir = (obs: string | null) => rw.query(
      `UPDATE vinculo_unidade SET conferencia_tipo_documento = 'outro', conferencia_descricao = 'Certidão de nascimento',
         conferencia_data = current_date, conferido_por_id = $2, conferencia_observacao = $3 WHERE id = $1`, [v.id, ids.operador, obs]);
    await expect(aprovar()).rejects.toThrow(/vinculo_aprovado_conferido_ck/);
    await expect(conferir('CPF 529.982.247-25')).rejects.toThrow(/vinculo_conferencia_sem_numero_ck/);
    await conferir('Recebido por e-mail em 01/10/2026.');
    await aprovar();
    await expect(conferir(null)).rejects.toThrow(/imutável depois da aprovação/);
  });

  it('app_rw (login real) não altera nem apaga a trilha', async () => {
    for (const q of ['UPDATE evento_acesso SET observacao = null', 'DELETE FROM evento_acesso', 'TRUNCATE evento_acesso',
      'UPDATE audit_log SET antes = null', 'DELETE FROM audit_log', 'UPDATE evento_acesso_cadeia SET ultimo_seq = 0',
      'DELETE FROM pessoa', 'SELECT retencao_descartar_prefixo(1)']) {
      await expect(rw.query(q), q).rejects.toThrow(/permission denied/);
    }
  });

  it('0003 (login app_rw): sessão e limite de login com GRANT mínimo, UPSERT concorrente sem perder contagem', async () => {
    const tok = 'a'.repeat(64);
    const { rows: [s] } = await rw.query(
      `INSERT INTO sessao (token_hash, usuario_id, expira_em) VALUES ($1, $2, now() + interval '12 hours') RETURNING id`, [tok, ids.operador]);
    await rw.query(`UPDATE sessao SET ultimo_uso_em = now() WHERE id = $1`, [s.id]);
    await rw.query(`UPDATE sessao SET revogada_em = now(), motivo_revogacao = 'logout' WHERE id = $1`, [s.id]);
    for (const q of [`UPDATE sessao SET token_hash = '${'b'.repeat(64)}'`, `UPDATE sessao SET expira_em = now() + interval '1 year'`,
      `UPDATE sessao SET usuario_id = usuario_id`, 'UPDATE sessao SET manter_conectado = true', 'DELETE FROM sessao', 'DELETE FROM login_limite', 'TRUNCATE login_limite']) {
      await expect(rw.query(q), q).rejects.toThrow(/permission denied/);
    }
    // O mesmo UPSERT do LimiteLoginService, simplificado, em 10 conexões: o contador fecha em 20 (nenhum incremento perdido).
    const chave = 'c'.repeat(64);
    // Pool próprio, encerrado aqui: conexões ainda fechando quando o afterAll faz DROP ... WITH (FORCE) recebem FATAL
    // 57P01 sem handler e viram "unhandled error" no vitest.
    const p = new pg.Pool({ connectionString: urlPara(URL_ADMIN!, NOME_DB, 'app_rw', SENHA_APP), max: 10 });
    try {
      const upsert = () => p.query(`INSERT INTO login_limite AS l (tipo, chave, falhas, janela_inicio) VALUES ('login', $1, 1, now())
        ON CONFLICT (tipo, chave) DO UPDATE SET falhas = l.falhas + 1, atualizado_em = now() RETURNING falhas`, [chave]);
      await Promise.all(Array.from({ length: 20 }, upsert));
      const { rows: [l] } = await p.query(`SELECT falhas FROM login_limite WHERE chave = $1`, [chave]);
      expect(l.falhas).toBe(20);
    } finally {
      await p.end();
    }
  });

  it('app_rw não é dono de nada e não cria objetos no schema', async () => {
    const { rows } = await rw.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'app_rw'`);
    expect(rows[0].n).toBe(0);
    await expect(rw.query('CREATE TABLE intrusa (x int)')).rejects.toThrow(/permission denied/);
  });

  it('nem o dono (app_migrator) altera evento sem desligar o trigger', async () => {
    const c = new pg.Client({ connectionString: urlPara(URL_ADMIN!, NOME_DB) });
    await c.connect();
    await c.query('SET ROLE app_migrator');
    await expect(c.query('UPDATE evento_acesso SET observacao = null')).rejects.toThrow(/append-only/);
    await c.end();
  });
});
