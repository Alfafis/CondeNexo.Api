// Migração 0012 (máscara do CPF em dois formatos, 2026-10-24) sobre um banco de condomínio como o de produção: 0000..0011
// já aplicadas como app_migrator (dono das tabelas, como no laço scripts/migrar-bancos.mjs) e pessoas cadastradas no
// formato antigo. A 0012 tem de aplicar como app_migrator, manter essas linhas intactas (e válidas), aceitar o formato
// novo e continuar recusando o CPF completo.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentoBusca, mascararCpf } from '../src/db/cpf';
import { cpfComDv } from '../src/db/seed-pessoas-dev';
import { CHAVE_HMAC_TESTE, PASTA_MIGRACOES } from './helpers/banco';

const LEGADOS = ['529982247', '318406253', '407152936'].map(cpfComDv);
let client: PGlite;
let ate0011 = '';

const inserir = (mascara: string | null, cpf: string, nome = 'Pessoa Teste') => client.query(
  `INSERT INTO pessoa (nome, categoria, telefone, documento_mascarado, documento_busca) VALUES ($1, 'visitante', '11912345678', $2, $3)`,
  [nome, mascara, documentoBusca(cpf, CHAVE_HMAC_TESTE)]);

beforeAll(async () => {
  ate0011 = mkdtempSync(join(tmpdir(), 'condominio-0011-'));
  cpSync(PASTA_MIGRACOES, ate0011, { recursive: true });
  const journal = JSON.parse(readFileSync(join(ate0011, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag.slice(0, 4) <= '0011');
  expect(journal.entries.map((e) => e.tag).at(-1)).toBe('0011_permanencia');
  writeFileSync(join(ate0011, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(ate0011, '0012_mascara_cpf_inicio.sql'));

  client = new PGlite();
  await client.exec(`CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;
    ALTER DATABASE postgres OWNER TO app_migrator; ALTER SCHEMA public OWNER TO app_migrator;`);
  await client.exec('SET ROLE app_migrator');
  await migrate(drizzle(client), { migrationsFolder: ate0011 });
  await client.exec('RESET ROLE');
  for (const [i, c] of LEGADOS.entries()) await inserir(mascararCpf(c, 'meio'), c, `Legado ${i}`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (ate0011) rmSync(ate0011, { recursive: true, force: true });
});

describe('0012_mascara_cpf_inicio sobre o banco de produção', () => {
  it('antes da 0012 o formato novo era recusado', async () => {
    await expect(inserir(mascararCpf(cpfComDv('600000001')), cpfComDv('600000001'))).rejects.toThrow(/pessoa_documento_mascarado_ck/);
  });

  it('aplica como app_migrator; as linhas antigas ficam iguais; novo passa; CPF completo e máscara torta continuam recusados', async () => {
    const antes = (await client.query('SELECT id, nome, documento_mascarado, documento_busca FROM pessoa ORDER BY nome')).rows;
    await client.exec('SET ROLE app_migrator');
    try {
      await migrate(drizzle(client), { migrationsFolder: PASTA_MIGRACOES });
    } finally {
      await client.exec('RESET ROLE');
    }
    expect((await client.query('SELECT id, nome, documento_mascarado, documento_busca FROM pessoa ORDER BY nome')).rows).toEqual(antes);
    expect(antes.map((p) => (p as { documento_mascarado: string }).documento_mascarado)).toEqual(LEGADOS.map((c) => mascararCpf(c, 'meio')));
    // As linhas antigas continuam válidas sob o CHECK novo (ADD CONSTRAINT já validou; aqui, de novo, explicitamente).
    const invalidas = await client.query(`SELECT count(*)::int AS n FROM pessoa
      WHERE documento_mascarado !~ '^(\\*\\*\\*\\.[0-9]{3}\\.[0-9]{3}-\\*\\*|[0-9]{3}\\.[0-9]{2}\\*\\.\\*\\*\\*-\\*\\*)$'`);
    expect((invalidas.rows[0] as { n: number }).n).toBe(0);
    // Formato novo e antigo entram.
    const novo = cpfComDv('600000002');
    await inserir(mascararCpf(novo, 'inicio'), novo, 'Novo Formato');
    const antigo = cpfComDv('600000003');
    await inserir(mascararCpf(antigo, 'meio'), antigo, 'Antigo Ainda Aceito');
    // CPF completo (com e sem pontuação) e variações fora dos dois formatos: recusados.
    for (const m of ['600.000.004-46', '60000000446', '600.000.***-**', '***.***.***-**', '600.00*.***-46', '600.00*.***-*', '600.000*.***-**']) {
      await expect(inserir(m, cpfComDv('600000004'))).rejects.toThrow(/pessoa_documento_mascarado_ck/);
    }
  });
});
