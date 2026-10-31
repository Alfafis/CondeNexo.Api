// Banco de teste: PGlite (Postgres 18 em WASM) com as MIGRAÇÕES REAIS aplicadas pelo migrator do Drizzle.
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { documentoBusca, mascararCpf } from '../../src/db/cpf';
import * as s from '../../src/db/schema';
import { PORTARIA_SOCIAL, seedEstrutura } from '../../src/db/seed';

export const PASTA_MIGRACOES = fileURLToPath(new URL('../../drizzle', import.meta.url));
export const CHAVE_HMAC_TESTE = Buffer.alloc(32, 7);
export const SENHA_FALSA = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
export const JUSTIFICATIVA = 'Morador não atende o interfone, entrega urgente';

export type Db = ReturnType<typeof drizzle<typeof s>>;

export async function novoBanco() {
  const client = new PGlite();
  // Bootstrap (em produção: db/bootstrap/00_roles.sh, como superusuário). No PGlite os roles não fazem login,
  // mas SET ROLE aplica os privilégios normalmente.
  await client.exec('CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;');
  const db = drizzle(client, { schema: s });
  await migrate(db, { migrationsFolder: PASTA_MIGRACOES });
  await seedEstrutura(db);
  const fx = await fixtures(db);
  return { client, db, fx };
}

async function fixtures(db: Db) {
  const [ponto] = await db.select().from(s.pontoAcesso).where(eq(s.pontoAcesso.nome, PORTARIA_SOCIAL));
  const un = async (bloco: string, numero: string) =>
    (await db.select().from(s.unidade).where(and(eq(s.unidade.bloco, bloco), eq(s.unidade.numero, numero))))[0];
  const d32 = await un('D', '32');
  const a11 = await un('A', '11');
  const usuario = async (nome: string, login: string, papel: (typeof s.papel.enumValues)[number]) =>
    (await db.insert(s.usuarioSistema).values({ nome, login, papel, senhaHash: SENHA_FALSA }).returning())[0];
  const sindico = await usuario('Marcos Síndico', 'marcos', 'sindico');
  const admin = await usuario('Ana Administração', 'ana', 'administracao');
  const porteiro = await usuario('Paulo Porteiro', 'paulo', 'porteiro');
  const auditor = await usuario('Clara Conselho', 'clara', 'auditor');
  let n = 0;
  const pessoa = async (nome: string, categoria: (typeof s.categoriaPessoa.enumValues)[number], extra: Partial<typeof s.pessoa.$inferInsert> = {}) => {
    const cpf = `5298209${String(1000 + ++n).slice(-4)}`; // 11 dígitos distintos por pessoa (validade do DV é regra da API)
    return (await db.insert(s.pessoa).values({
      nome, categoria, telefone: '11987654321',
      documentoMascarado: mascararCpf(cpf), documentoBusca: documentoBusca(cpf, CHAVE_HMAC_TESTE), ...extra,
    }).returning())[0];
  };
  const morador = await pessoa('Joana Moradora', 'morador');
  const visitante = await pessoa('Vítor Visitante', 'visitante');
  const prestador = await pessoa('Pedro Prestador', 'prestador', { empresa: 'Elétrica Silva', servico: 'Reparo' });
  const funcionarioPessoa = await pessoa('Fábio Funcionário', 'funcionario');
  const semCpf = await pessoa('Sem Documento', 'visitante', { semCpf: true, documentoMascarado: null, documentoBusca: null });
  await db.insert(s.funcionario).values({ pessoaId: funcionarioPessoa.id, funcao: 'Zelador', diasSemana: [1, 2, 3, 4, 5], horaInicio: '22:00:00', horaFim: '06:00:00' });
  const [vinculo] = await db.insert(s.vinculoUnidade).values({
    pessoaId: morador.id, unidadeId: d32.id, tipo: 'proprietario', registradoPorId: admin.id, vigenciaInicio: '2026-01-01',
  }).returning();
  await db.update(s.vinculoUnidade).set({ ...conferencia(admin.id), status: 'aprovado', decididoPorId: admin.id, decididoEm: new Date() }).where(eq(s.vinculoUnidade.id, vinculo.id));
  const [area] = await db.select().from(s.areaComum).where(eq(s.areaComum.nome, 'Salão de festas')); // vem do seed
  return { ponto, d32, a11, sindico, admin, porteiro, auditor, morador, visitante, prestador, funcionarioPessoa, semCpf, vinculo, area };
}

export type Fixtures = Awaited<ReturnType<typeof fixtures>>;

/** Conferência do comprovante (RF-05) válida, exigida para aprovar o vínculo (CHECK vinculo_aprovado_conferido_ck). */
export const conferencia = (conferidoPorId: string, extra: Partial<typeof s.vinculoUnidade.$inferInsert> = {}) => ({
  conferenciaTipoDocumento: 'escritura' as const, conferenciaData: '2026-01-01', conferidoPorId, ...extra,
});

/** Entrada de visitante por interfone, válida; `extra` sobrescreve. */
export function entradaBase(fx: Fixtures, extra: Partial<typeof s.eventoAcesso.$inferInsert> = {}): typeof s.eventoAcesso.$inferInsert {
  return {
    tipo: 'entrada', categoriaPessoa: 'visitante', pessoaId: fx.visitante.id, unidadeDestinoId: fx.d32.id,
    pontoAcessoId: fx.ponto.id, autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: fx.morador.id,
    operadorId: fx.porteiro.id, operadorPapel: 'porteiro', ...extra,
  };
}

export async function inserirEvento(db: Db, valores: typeof s.eventoAcesso.$inferInsert) {
  return (await db.insert(s.eventoAcesso).values(valores).returning())[0];
}

/** Executa `fn` como app_rw (SET ROLE) e volta ao superusuário, mesmo em erro. */
export async function comoAppRw<T>(client: PGlite, fn: () => Promise<T>): Promise<T> {
  await client.exec('SET ROLE app_rw');
  try { return await fn(); } finally { await client.exec('RESET ROLE'); }
}

/** Mensagem do erro do Postgres (o Drizzle embrulha o erro original em `cause`). */
export async function erroDe(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    const c = (e as { cause?: { message?: string } }).cause;
    return `${(e as Error).message} | ${c?.message ?? ''}`;
  }
  throw new Error('era esperado um erro, mas a operação passou');
}
