// Migração 0015 (meio de autorização 'celular') sobre um banco de condomínio como o de produção: 0000..0014 aplicadas
// como app_migrator e uma cadeia já gravada (entrada por interfone, recusa, exceção). A 0015 roda na MESMA transação do
// migrador do Drizzle (ADD VALUE + troca de dois CHECKs): tem de aplicar sem "unsafe use of new value", sem mudar
// nenhum hash, e o evento novo com 'celular' encadeia no formato 1 e verifica com o domain.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verificarCadeia } from '../src/dominio/hashChain';
import { paraExportacao } from '../src/db/cadeia';
import * as s from '../src/db/schema';
import { JUSTIFICATIVA, PASTA_MIGRACOES, SENHA_FALSA } from './helpers/banco';

let client: PGlite;
let ate0014 = '';
const ids: Record<string, string> = {};
const um = async (sql: string, p: unknown[] = []) => ((await client.query<{ id: string }>(sql, p)).rows[0]!).id;
const cadeiaCrua = async () => (await client.query(
  'SELECT id, seq, formato_hash, hash_anterior, hash, evento_acesso_canonico(e) AS canon FROM evento_acesso e ORDER BY seq')).rows;
const erroDe = async (p: Promise<unknown>) => {
  try { await p; return ''; } catch (e) { return `${(e as Error).message} ${((e as Error).cause as Error | undefined)?.message ?? ''}`; }
};

beforeAll(async () => {
  ate0014 = mkdtempSync(join(tmpdir(), 'condominio-0014-'));
  cpSync(PASTA_MIGRACOES, ate0014, { recursive: true });
  const journal = JSON.parse(readFileSync(join(ate0014, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= '0014');
  expect(journal.entries.map((e) => e.tag).at(-1)).toBe('0014_sessao_manter_conectado');
  writeFileSync(join(ate0014, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(ate0014, '0015_meio_celular.sql'));

  client = new PGlite();
  await client.exec(`CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;
    ALTER DATABASE postgres OWNER TO app_migrator; ALTER SCHEMA public OWNER TO app_migrator;`);
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: ate0014 });
  await client.exec('RESET ROLE');

  ids.ponto = await um(`INSERT INTO ponto_acesso (nome) VALUES ('Portaria social') RETURNING id`);
  ids.unidade = await um(`INSERT INTO unidade (bloco, numero) VALUES ('D', '32') RETURNING id`);
  ids.porteiro = await um(`INSERT INTO usuario_sistema (nome, login, papel, senha_hash) VALUES ('Paulo', 'paulo', 'porteiro', $1) RETURNING id`, [SENHA_FALSA]);
  ids.visitante = await um(`INSERT INTO pessoa (nome, categoria, sem_cpf, telefone) VALUES ('Vítor', 'visitante', true, '11987654322') RETURNING id`);
  ids.morador = await um(`INSERT INTO pessoa (nome, categoria, sem_cpf, telefone) VALUES ('Ana', 'morador', true, '11987654323') RETURNING id`);
  const evento = (extra: string, valores: string, p: unknown[]) => um(`INSERT INTO evento_acesso (tipo, categoria_pessoa, pessoa_id,
    ponto_acesso_id, operador_id, operador_papel${extra}) VALUES (${valores}) RETURNING id`, p);
  await evento(', unidade_destino_id, autorizado_por_tipo, justificativa',
    `'entrada', 'visitante', $1, $2, $3, 'porteiro', $4, 'excecao_porteiro', $5`, [ids.visitante, ids.ponto, ids.porteiro, ids.unidade, JUSTIFICATIVA]);
  await evento(', unidade_destino_id, autorizado_por_tipo, autorizado_por_pessoa_id',
    `'recusado', 'visitante', $1, $2, $3, 'porteiro', $4, 'interfone', $5`, [ids.visitante, ids.ponto, ids.porteiro, ids.unidade, ids.morador]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (ate0014) rmSync(ate0014, { recursive: true, force: true });
});

describe('0015_meio_celular sobre o banco de produção', () => {
  it('antes da 0015 o enum não tinha celular', async () => {
    expect(await erroDe(client.query(`SELECT 'celular'::meio_autorizacao`))).toMatch(/invalid input value for enum/);
  });

  it('aplica como app_migrator numa transação só, sem mudar nenhum hash; a cadeia continua verificando', async () => {
    const antes = await cadeiaCrua();
    await client.exec('SET ROLE app_migrator');
    try {
      await migrate(drizzle(client), { migrationsFolder: PASTA_MIGRACOES });
    } finally {
      await client.exec('RESET ROLE');
    }
    expect(await cadeiaCrua()).toEqual(antes);
    const ordem = await client.query<{ v: string }>(`SELECT unnest(enum_range(NULL::meio_autorizacao))::text AS v`);
    expect(ordem.rows.map((r) => r.v)).toEqual(['interfone', 'celular', 'morador_presente', 'autorizacao_previa', 'excecao_porteiro', 'escala']);
  });

  it('depois dela (como app_rw): celular exige morador e vale para a recusa; o hash é o do domain (formato 1)', async () => {
    const db = drizzle(client, { schema: s });
    const base = {
      tipo: 'entrada' as const, categoriaPessoa: 'visitante' as const, pessoaId: ids.visitante!, unidadeDestinoId: ids.unidade!,
      pontoAcessoId: ids.ponto!, autorizadoPorTipo: 'celular' as const, operadorId: ids.porteiro!, operadorPapel: 'porteiro' as const,
    };
    await client.exec('SET ROLE app_rw');
    try {
      // Pessoa sem CPF só entra por exceção (trigger): celular não é exceção
      expect(await erroDe(db.insert(s.eventoAcesso).values({ ...base, autorizadoPorPessoaId: ids.morador! }))).toMatch(/sem CPF só entra por exceção/);
      const [cpf] = await db.insert(s.pessoa).values({ nome: 'Vera', categoria: 'visitante', semCpf: false, documentoMascarado: '123.45*.***-**',
        documentoBusca: 'f'.repeat(64), telefone: '11987654324' }).returning();
      const comCpf = { ...base, pessoaId: cpf!.id };
      expect(await erroDe(db.insert(s.eventoAcesso).values(comCpf))).toMatch(/evento_morador_identificado_ck/);
      const [entrada] = await db.insert(s.eventoAcesso).values({ ...comCpf, autorizadoPorPessoaId: ids.morador! }).returning();
      const [recusa] = await db.insert(s.eventoAcesso).values({ ...comCpf, tipo: 'recusado', autorizadoPorPessoaId: ids.morador! }).returning();
      expect([entrada!.formatoHash, recusa!.formatoHash]).toEqual([1, 1]);
    } finally {
      await client.exec('RESET ROLE');
    }
    const evs = (await db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(evs.map((e) => e.autorizado_por_tipo)).toEqual(['excecao_porteiro', 'interfone', 'celular', 'celular']);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: 4 });
  });
});
