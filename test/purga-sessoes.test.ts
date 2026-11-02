// 0016 (índices das listagens) e 0017 (purga de sessões e contadores de login), aplicadas por cima de um banco 0000..0015 com dados.
// A purga roda como app_rw por retencao_limpar_sessoes (SECURITY DEFINER): app_rw continua SEM DELETE direto.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comoAppRw, erroDe, PASTA_MIGRACOES, SENHA_FALSA } from './helpers/banco';

// Cadeia de dono de produção: 0000..0015 aplicadas COMO app_migrator (dono das tabelas e da função da 0007), depois 0016 e
// 0017 também como app_migrator, e a purga roda como app_rw. Um CREATE OR REPLACE por quem não é dono falharia aqui.
let client: PGlite;
let ate0015 = '';
const ids: Record<string, string> = {};
const hex = (n: number) => n.toString(16).padStart(64, '0');
const existe = async (tabela: string, col: string, v: string) =>
  ((await client.query(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${col} = $1`, [v])).rows[0] as { n: number }).n === 1;

beforeAll(async () => {
  ate0015 = mkdtempSync(join(tmpdir(), 'condominio-0015-'));
  cpSync(PASTA_MIGRACOES, ate0015, { recursive: true });
  const journal = JSON.parse(readFileSync(join(ate0015, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= '0015');
  expect(journal.entries.map((e) => e.tag).at(-1)).toBe('0015_meio_celular');
  writeFileSync(join(ate0015, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(ate0015, '0016_indices_listagens.sql'));
  rmSync(join(ate0015, '0017_purga_sessoes.sql'));

  client = new PGlite();
  await client.exec(`CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;
    ALTER DATABASE postgres OWNER TO app_migrator; ALTER SCHEMA public OWNER TO app_migrator;`);
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: ate0015 });
  await client.exec('RESET ROLE');

  const u = (await client.query<{ id: string }>(
    `INSERT INTO usuario_sistema (nome, login, papel, senha_hash) VALUES ('Paulo', 'paulo', 'porteiro', $1) RETURNING id`, [SENHA_FALSA])).rows[0]!.id;
  const sessao = async (nome: string, expira: string, ultimoUso = 'now()', comIp = false) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO sessao (token_hash, usuario_id, expira_em, ultimo_uso_em, criada_em ${comIp ? ', ip, user_agent' : ''})
       VALUES ($1, $2, ${expira}, ${ultimoUso}, now() - interval '100 days' ${comIp ? ", '10.1.1.1', 'Navegador'" : ''}) RETURNING id`, [hex(Object.keys(ids).length + 1), u]);
    ids[nome] = r.rows[0]!.id;
  };
  await sessao('morta91', "now() - interval '91 days'", "now() - interval '92 days'");
  await sessao('morta89', "now() - interval '89 days'", "now() - interval '91 days'", true); // vencida, dentro dos 90 dias, uso há 91: perde IP
  await sessao('ativa', "now() + interval '1 hour'");
  await sessao('revogadaRecente', "now() + interval '1 hour'");
  await client.query(`UPDATE sessao SET revogada_em = now(), motivo_revogacao = 'logout' WHERE id = $1`, [ids.revogadaRecente]);
  const limite = async (nome: string, tipo: string, n: number, atualizado: string, bloqueado: string | null) => {
    await client.query(`INSERT INTO login_limite (tipo, chave, falhas, janela_inicio, bloqueado_ate, atualizado_em)
      VALUES ($1, $2, 3, ${atualizado}, ${bloqueado ?? 'NULL'}, ${atualizado})`, [tipo, hex(n)]);
    ids[nome] = hex(n);
  };
  await limite('limiteVelho', 'ip', 101, "now() - interval '8 days'", null);
  await limite('limiteBloqueioVencido', 'login_ip', 102, "now() - interval '8 days'", "now() - interval '7 days'");
  await limite('limiteBloqueioVigente', 'ip', 103, "now() - interval '8 days'", "now() + interval '1 day'");
  await limite('limiteRecente', 'login', 104, "now() - interval '1 day'", null);

  // Agora as migrações novas, como em produção: pelo dono.
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: PASTA_MIGRACOES });
  await client.exec('RESET ROLE');
}, 90_000);

afterAll(async () => {
  await client?.close();
  if (ate0015) rmSync(ate0015, { recursive: true, force: true });
});

describe('0017: purga de sessões e contadores de login', () => {
  it('app_rw continua sem DELETE direto (a purga só passa pela função)', async () => {
    await comoAppRw(client, async () => {
      expect(await erroDe(client.query('DELETE FROM sessao'))).toMatch(/permission denied/);
      expect(await erroDe(client.query('DELETE FROM login_limite'))).toMatch(/permission denied/);
    });
  });

  it('apaga só o que está morto há mais de 90 dias (sessão) e parado há mais de 7 dias sem bloqueio (contador); zera o IP das velhas', async () => {
    const n = await comoAppRw(client, async () => ((await client.query<{ n: number }>('SELECT retencao_limpar_sessoes() AS n')).rows[0]!).n);
    // 1 sessão (91 dias) + 2 contadores (velho e de bloqueio vencido) + 1 IP zerado (sessão de 89 dias, uso há 91)
    expect(n).toBe(4);
    expect(await existe('sessao', 'id', ids.morta91!)).toBe(false);
    expect(await existe('sessao', 'id', ids.morta89!)).toBe(true);
    expect(await existe('sessao', 'id', ids.ativa!)).toBe(true);
    expect(await existe('sessao', 'id', ids.revogadaRecente!)).toBe(true);
    const velha = (await client.query<{ ip: string | null; user_agent: string | null }>('SELECT ip::text, user_agent FROM sessao WHERE id = $1', [ids.morta89])).rows[0]!;
    expect(velha).toEqual({ ip: null, user_agent: null });
    expect(await existe('login_limite', 'chave', ids.limiteVelho!)).toBe(false);
    expect(await existe('login_limite', 'chave', ids.limiteBloqueioVencido!)).toBe(false);
    expect(await existe('login_limite', 'chave', ids.limiteBloqueioVigente!)).toBe(true); // bloqueio ainda em vigor
    expect(await existe('login_limite', 'chave', ids.limiteRecente!)).toBe(true);
  });

  it('registra uma execução do tipo sessoes com a soma, e rodar de novo não faz nada', async () => {
    const reg = (await client.query<{ quantidade: number }>(`SELECT quantidade FROM retencao_execucao WHERE tipo = 'sessoes' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    expect(reg.quantidade).toBe(4);
    const n2 = await comoAppRw(client, async () => ((await client.query<{ n: number }>('SELECT retencao_limpar_sessoes() AS n')).rows[0]!).n);
    expect(n2).toBe(0);
  });

  it('a função continua SECURITY DEFINER com search_path fixo e sem EXECUTE para PUBLIC', async () => {
    const f = (await client.query<{ definer: boolean; cfg: string[] | null }>(
      `SELECT prosecdef AS definer, proconfig AS cfg FROM pg_proc WHERE proname = 'retencao_limpar_sessoes'`)).rows[0]!;
    expect(f.definer).toBe(true);
    expect(f.cfg?.join(',')).toMatch(/search_path=pg_catalog, public, pg_temp/);
    const publico = (await client.query<{ ok: boolean }>(`SELECT has_function_privilege('public', 'retencao_limpar_sessoes()', 'EXECUTE') AS ok`)).rows[0]!;
    expect(publico.ok).toBe(false);
  });
});

describe('0016: índices das listagens', () => {
  it('os quatro índices existem', async () => {
    const r = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('encomenda_recebida_ix', 'ocorrencia_aberta_ix', 'restricao_unidade_vigente_ix', 'veiculo_unidade_ix')`);
    expect(r.rows.map((x) => x.indexname).sort()).toEqual(['encomenda_recebida_ix', 'ocorrencia_aberta_ix', 'restricao_unidade_vigente_ix', 'veiculo_unidade_ix']);
  });
});
