// Migração 0005 (torre numérica -> bloco texto) sobre dados no formato antigo, e a CLI recriar-estrutura.
// O banco é levado só até a 0004 (cópia do journal truncada), recebe dados "de produção" no formato antigo e então
// sobe para a 0005 pelo mesmo migrator do Drizzle: o que se testa é exatamente o SQL que roda na VPS.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { asc, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { codigoUnidade, compararUnidades, ESTRUTURA_PADRAO, gerarUnidades } from '../src/dominio/units';
import { afterAll, describe, expect, it } from 'vitest';
import { paraExportacao, verificarCadeia } from '../src/db/cadeia';
import { recriarEstrutura } from '../src/db/recriar-estrutura';
import * as s from '../src/db/schema';
import { comoAppRw, erroDe, novoBanco, PASTA_MIGRACOES, SENHA_FALSA } from './helpers/banco';

const temporarias: string[] = [];
afterAll(() => { for (const p of temporarias) rmSync(p, { recursive: true, force: true }); });

/** Pasta de migrações só até a 0004 (journal truncado): o estado do banco antes desta mudança. */
function migracoesAte0004(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migracoes-0004-'));
  temporarias.push(dir);
  cpSync(PASTA_MIGRACOES, dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 4);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  return dir;
}

/** Banco na 0004 com as 165 unidades antigas (torres 1–8: 11..54; torre 9: 11..15) e `extras` (torre, número). */
async function bancoAntigo(extras: [number, string][] = []) {
  const client = new PGlite();
  await client.exec('CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;');
  const db = drizzle(client, { schema: s });
  await migrate(db, { migrationsFolder: migracoesAte0004() });
  const antigas: [number, string][] = [];
  for (let t = 1; t <= 9; t++) {
    for (let andar = 1; andar <= 5; andar++) for (let ap = 1; ap <= 4; ap++) if (t < 9 || (andar === 1)) antigas.push([t, `${andar}${ap}`]);
  }
  antigas.push([9, '15']);
  const valores = [...antigas, ...extras].map(([t, n]) => `(${t}, '${n}')`).join(', ');
  await client.exec(`INSERT INTO unidade (torre, numero) VALUES ${valores}`);
  return { client, db };
}

const idAntigo = async (client: PGlite, torre: number, numero: string) =>
  (await client.query<{ id: string }>('SELECT id FROM unidade WHERE torre = $1 AND numero = $2', [torre, numero])).rows[0]!.id;

describe('migração 0005: torre -> bloco, sem apagar nem mudar id, hash ou referência', () => {
  it('converte as linhas existentes (torre::text, número normalizado) e mantém vínculos, eventos e a cadeia', async () => {
    const { client, db } = await bancoAntigo([[2, '3'], [9, '032'], [1, '0']]);
    expect(await client.query('SELECT 1 FROM unidade')).toMatchObject({ rows: { length: 168 } });
    const t432 = await idAntigo(client, 4, '32');
    const t23 = await idAntigo(client, 2, '3');
    const t9032 = await idAntigo(client, 9, '032');

    // Uso real antes da migração: vínculo aprovado e eventos encadeados apontando para a unidade
    // Usuários em SQL cru: o schema atual tem colunas de migrações posteriores (0006), que o banco na 0004 não tem.
    const usuarioAntigo = async (nome: string, login: string, papel: string) => (await client.query<{ id: string }>(
      'INSERT INTO usuario_sistema (nome, login, papel, senha_hash) VALUES ($1, $2, $3, $4) RETURNING id', [nome, login, papel, SENHA_FALSA])).rows;
    const [usuario] = await usuarioAntigo('Ana Adm', 'ana', 'administracao');
    const [porteiro] = await usuarioAntigo('Paulo', 'paulo', 'porteiro');
    const [ponto] = await db.insert(s.pontoAcesso).values({ nome: 'Portaria social' }).returning();
    // Pessoas também em SQL cru: o schema atual tem `menor_idade` (0007).
    const pessoaAntiga = async (nome: string, categoria: string, telefone: string) => (await client.query<{ id: string }>(
      'INSERT INTO pessoa (nome, categoria, sem_cpf, telefone) VALUES ($1, $2, true, $3) RETURNING id', [nome, categoria, telefone])).rows;
    const [morador] = await pessoaAntiga('Joana', 'morador', '11987654321');
    const [visitante] = await pessoaAntiga('Vítor', 'visitante', '11987654322');
    const [vinculo] = await db.insert(s.vinculoUnidade).values({
      pessoaId: morador!.id, unidadeId: t432, tipo: 'proprietario', registradoPorId: usuario!.id, vigenciaInicio: '2026-01-01',
    }).returning();
    // Eventos e leitura em SQL cru: o schema atual tem as colunas de veículo (0013), que o banco na 0004 não tem.
    for (const unidadeDestinoId of [t432, t23, t9032]) {
      await client.query(`INSERT INTO evento_acesso (tipo, categoria_pessoa, pessoa_id, unidade_destino_id, ponto_acesso_id,
        autorizado_por_tipo, justificativa, operador_id, operador_papel)
        VALUES ('entrada', 'visitante', $1, $2, $3, 'excecao_porteiro', 'Morador não atende o interfone, entrega urgente', $4, 'porteiro')`,
      [visitante!.id, unidadeDestinoId, ponto!.id, porteiro!.id]);
    }
    const cadeiaCrua = async () => (await client.query('SELECT id, seq, formato_hash, unidade_destino_id, hash_anterior, hash FROM evento_acesso ORDER BY seq')).rows;
    const antes = await cadeiaCrua();

    await migrate(db, { migrationsFolder: PASTA_MIGRACOES });

    const col = await client.query<{ data_type: string }>(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'unidade' AND column_name IN ('bloco', 'torre')");
    expect(col.rows).toEqual([{ data_type: 'text' }]); // só bloco, texto
    const porId = async (id: string) => (await db.select().from(s.unidade).where(eq(s.unidade.id, id)))[0];
    expect(await porId(t432)).toMatchObject({ bloco: '4', numero: '32', ativo: true });
    expect(await porId(t23)).toMatchObject({ bloco: '2', numero: '03' });
    expect(await porId(t9032)).toMatchObject({ bloco: '9', numero: '32' });
    expect((await db.select({ n: count() }).from(s.unidade))[0]!.n).toBe(168); // nada apagado
    expect((await client.query("SELECT 1 FROM unidade WHERE numero = '00'")).rows).toHaveLength(1); // "0" antigo preservado

    expect(await cadeiaCrua()).toEqual(antes);
    const depois = (await db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq))).map(paraExportacao);
    expect(await verificarCadeia(depois)).toMatchObject({ valido: true, verificados: 3 });
    expect((await db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.id, vinculo!.id)))[0]!.unidadeId).toBe(t432);

    // Os CHECKs novos valem dali em diante
    expect(await erroDe(db.insert(s.unidade).values({ bloco: '4', numero: '032' }))).toMatch(/unidade_numero_ck/);
    expect(await erroDe(db.insert(s.unidade).values({ bloco: '4', numero: '32' }))).toMatch(/unidade_bloco_numero_uq/);

    // Com unidade em uso, a CLI recusa e não muda nada
    expect(await erroDe(recriarEstrutura(db, ESTRUTURA_PADRAO, true))).toMatch(/evento_acesso\.unidade_destino_id.*vinculo_unidade\.unidade_id/);
    expect((await db.select({ n: count() }).from(s.unidade))[0]!.n).toBe(168);
  });

  it('aborta inteira (nada muda) se a normalização juntar duas unidades do mesmo bloco', async () => {
    const { client, db } = await bancoAntigo([[1, '032']]); // "032" e "32" na torre 1
    expect(await erroDe(migrate(db, { migrationsFolder: PASTA_MIGRACOES }))).toMatch(/viram a mesma.*1: 032, 32/);
    const col = await client.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'unidade' AND column_name IN ('bloco', 'torre')");
    expect(col.rows).toEqual([{ column_name: 'torre', data_type: 'smallint' }]);
  });
});

describe('CLI recriar-estrutura (banco de produção: 165 unidades antigas, nenhum uso)', () => {
  it('simula sem gravar; aplica como app_rw (162 da configuração + audit_log); de novo, nada a fazer', async () => {
    const { client, db } = await bancoAntigo();
    await migrate(db, { migrationsFolder: PASTA_MIGRACOES });
    const total = async () => (await db.select({ n: count() }).from(s.unidade))[0]!.n;
    const trilha = () => db.select().from(s.auditLog).where(eq(s.auditLog.acao, 'unidade.recriarEstrutura'));

    // O app_rw (papel da API e da CLI) não apaga unidade direto; só pela função
    expect(await comoAppRw(client, () => erroDe(db.delete(s.unidade)))).toMatch(/permission denied/);

    expect(await comoAppRw(client, () => recriarEstrutura(db, ESTRUTURA_PADRAO, false))).toEqual({ resultado: 'simulado', antes: 165, depois: 162 });
    expect(await total()).toBe(165);
    expect(await trilha()).toHaveLength(0);

    expect(await comoAppRw(client, () => recriarEstrutura(db, ESTRUTURA_PADRAO, true))).toEqual({ resultado: 'aplicado', antes: 165, depois: 162 });
    const unidades = (await db.select().from(s.unidade)).sort(compararUnidades);
    expect(unidades.map(codigoUnidade)).toEqual(gerarUnidades(ESTRUTURA_PADRAO).map(codigoUnidade));
    expect(unidades.every((u) => u.ativo)).toBe(true);
    const [a] = await trilha();
    expect(a).toMatchObject({ usuarioId: null, usuarioNome: '(recriar-estrutura)', entidade: 'unidade' });
    expect(a!.antes).toMatchObject({ quantidade: 165 });
    expect(a!.depois).toMatchObject({ quantidade: 162, agrupamento: 'Bloco' });

    expect(await comoAppRw(client, () => recriarEstrutura(db, ESTRUTURA_PADRAO, true))).toEqual({ resultado: 'nada_a_fazer', antes: 162 });
    expect(await trilha()).toHaveLength(1);
  });

  it('recusa com qualquer referência (aqui, um vínculo) e não altera nada', async () => {
    const { db } = await novoBanco(); // fixtures: vínculo aprovado na D-32
    await db.insert(s.unidade).values({ bloco: 'Z', numero: '11' }); // diferente da configuração: haveria o que fazer
    const e = await erroDe(recriarEstrutura(db, ESTRUTURA_PADRAO, true));
    expect(e).toMatch(/há unidades referenciadas \(vinculo_unidade\.unidade_id\)/);
    expect((await db.select({ n: count() }).from(s.unidade))[0]!.n).toBe(163);
  });

});
