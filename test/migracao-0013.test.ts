// Migração 0013 (veículo na entrada, formato de hash 2) sobre um banco de condomínio como o de produção: 0000..0012
// aplicadas como app_migrator e uma cadeia já gravada no formato 1 (entrada, saída, correção, retroativo). A 0013 tem de
// aplicar como app_migrator sem reescrever nada: mesmos hashes, mesma serialização canônica byte a byte, a cadeia antiga
// continua verificando, e eventos novos (com e sem veículo) encadeiam em cima dela.
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
let ate0012 = '';
const ids: Record<string, string> = {};
const um = async (sql: string, p: unknown[] = []) => ((await client.query<{ id: string }>(sql, p)).rows[0]!).id;
const cadeiaCrua = async () => (await client.query(
  'SELECT id, seq, formato_hash, hash_anterior, hash, evento_acesso_canonico(e) AS canon FROM evento_acesso e ORDER BY seq')).rows;

beforeAll(async () => {
  ate0012 = mkdtempSync(join(tmpdir(), 'condominio-0012-'));
  cpSync(PASTA_MIGRACOES, ate0012, { recursive: true });
  const journal = JSON.parse(readFileSync(join(ate0012, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= '0012');
  expect(journal.entries.map((e) => e.tag).at(-1)).toBe('0012_mascara_cpf_inicio');
  writeFileSync(join(ate0012, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(ate0012, '0013_veiculo_evento.sql'));

  client = new PGlite();
  await client.exec(`CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;
    ALTER DATABASE postgres OWNER TO app_migrator; ALTER SCHEMA public OWNER TO app_migrator;`);
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: ate0012 });
  await client.exec('RESET ROLE');

  // Dados "de produção" em SQL cru (o schema TS atual já tem as colunas da 0013, que este banco ainda não tem)
  ids.ponto = await um(`INSERT INTO ponto_acesso (nome) VALUES ('Portaria social') RETURNING id`);
  ids.unidade = await um(`INSERT INTO unidade (bloco, numero) VALUES ('D', '32') RETURNING id`);
  ids.outra = await um(`INSERT INTO unidade (bloco, numero) VALUES ('A', '11') RETURNING id`);
  ids.porteiro = await um(`INSERT INTO usuario_sistema (nome, login, papel, senha_hash) VALUES ('Paulo', 'paulo', 'porteiro', $1) RETURNING id`, [SENHA_FALSA]);
  ids.admin = await um(`INSERT INTO usuario_sistema (nome, login, papel, senha_hash) VALUES ('Ana', 'ana', 'administracao', $1) RETURNING id`, [SENHA_FALSA]);
  ids.visitante = await um(`INSERT INTO pessoa (nome, categoria, sem_cpf, telefone) VALUES ('Vítor', 'visitante', true, '11987654322') RETURNING id`);
  const evento = (extra: string, valores: string, p: unknown[]) => um(`INSERT INTO evento_acesso (tipo, categoria_pessoa, pessoa_id,
    ponto_acesso_id, operador_id, operador_papel${extra}) VALUES (${valores}) RETURNING id`, p);
  ids.entrada = await evento(', unidade_destino_id, autorizado_por_tipo, justificativa',
    `'entrada', 'visitante', $1, $2, $3, 'porteiro', $4, 'excecao_porteiro', $5`, [ids.visitante, ids.ponto, ids.porteiro, ids.unidade, JUSTIFICATIVA]);
  await evento(', refere_evento_id', `'saida', 'visitante', $1, $2, $3, 'porteiro', $4`, [ids.visitante, ids.ponto, ids.porteiro, ids.entrada]);
  await evento(', corrige_evento_id, justificativa, correcao_valores', `'correcao', 'visitante', $1, $2, $3, 'administracao', $4, $5, $6`,
    [ids.visitante, ids.ponto, ids.admin, ids.entrada, 'Unidade digitada errada pelo porteiro', JSON.stringify({ unidade_destino_id: ids.outra })]);
  await evento(', unidade_destino_id, autorizado_por_tipo, justificativa, retroativo, formulario_contingencia, ocorrido_em',
    `'entrada', 'visitante', $1, $2, $3, 'porteiro', $4, 'excecao_porteiro', $5, true, 'FC-7', now() - interval '2 hours'`,
    [ids.visitante, ids.ponto, ids.porteiro, ids.unidade, JUSTIFICATIVA]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (ate0012) rmSync(ate0012, { recursive: true, force: true });
});

describe('0013_veiculo_evento sobre o banco de produção', () => {
  it('antes da 0013 não havia veículo no evento', async () => {
    const c = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'evento_acesso' AND column_name LIKE 'veiculo_%'`);
    expect(c.rows).toHaveLength(0);
  });

  it('aplica como app_migrator sem mudar nenhum hash nem a serialização dos eventos antigos; a cadeia continua verificando', async () => {
    const antes = await cadeiaCrua();
    expect(antes.map((e) => (e as { formato_hash: number }).formato_hash)).toEqual([1, 1, 1, 1]);
    await client.exec('SET ROLE app_migrator');
    try {
      await migrate(drizzle(client), { migrationsFolder: PASTA_MIGRACOES });
    } finally {
      await client.exec('RESET ROLE');
    }
    expect(await cadeiaCrua()).toEqual(antes); // inclusive evento_acesso_canonico(e), agora a função nova
    const db = drizzle(client, { schema: s });
    const evs = (await db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(evs.every((e) => !('veiculo_placa' in e))).toBe(true);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: 4 });
  });

  it('depois dela: entrada com veículo vira formato 2, sem veículo segue 1, e a cadeia mista verifica (como app_rw)', async () => {
    const db = drizzle(client, { schema: s });
    const base = {
      tipo: 'entrada' as const, categoriaPessoa: 'visitante' as const, pessoaId: ids.visitante!, unidadeDestinoId: ids.unidade!,
      pontoAcessoId: ids.ponto!, autorizadoPorTipo: 'excecao_porteiro' as const, justificativa: JUSTIFICATIVA,
      operadorId: ids.porteiro!, operadorPapel: 'porteiro' as const,
    };
    await client.exec('SET ROLE app_rw');
    try {
      const [com] = await db.insert(s.eventoAcesso).values({ ...base, veiculoPlaca: 'ABC1D23', veiculoModelo: 'Onix', veiculoCor: 'Prata' }).returning();
      const [sem] = await db.insert(s.eventoAcesso).values({ ...base }).returning();
      expect([com!.formatoHash, sem!.formatoHash]).toEqual([2, 1]);
      // O trigger decide o formato pelo conteúdo: o valor mandado pela aplicação é ignorado
      const [forcado] = await db.insert(s.eventoAcesso).values({ ...base, formatoHash: 2 }).returning();
      expect(forcado!.formatoHash).toBe(1);
    } finally {
      await client.exec('RESET ROLE');
    }
    const evs = (await db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(evs.map((e) => e.v)).toEqual([1, 1, 1, 1, 2, 1, 1]);
    expect(await verificarCadeia(evs)).toMatchObject({ valido: true, verificados: 7 });
  });
});
