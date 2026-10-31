// Provisiona um condomínio novo de ponta a ponta (docs/05_arquitetura_saas.md SAAS-10; regras e passos em
// src/saas/provisionar.ts; passo a passo de produção em docs/deploy.md, seção 16). Entrada: JSON pelo stdin (ou
// --entrada <arquivo>), nunca dado pessoal em argumento de linha de comando.
//
//   docker compose --profile provisionar run --rm -T provisionar-cli < condominio.json
//   docker compose --profile provisionar run --rm -T provisionar-cli node dist/cli/provisionar-condominio.js --nova-senha-sindico < condominio.json
//
// Ambiente (o serviço provisionar-cli do compose monta as URLs do .env; nada vem por argumento):
//   DATABASE_URL_PROVISIONADOR       app_provisionador no banco `postgres` (CREATE DATABASE)
//   MIGRATOR_URL_BASE                app_migrator, sem nome de banco (migrações do condomínio)
//   DATABASE_URL                     app_rw (qualquer banco: o nome é trocado pelo do condomínio)
//   DATABASE_URL_PLATAFORMA          app_plataforma no banco `plataforma`
//   PORTARIA_CHAVE_MESTRA(_VERSAO)   embrulho das chaves do condomínio
// Saída: JSON no stdout (ids, banco, unidades, impressões das chaves; nunca chave nem senha). A senha temporária do
// síndico vai SÓ para o stderr, uma vez. Códigos: 0 ok; 1 recusado ou falha (retomável: rodar de novo); 2 uso.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { gerarSenhaTemporaria } from '../auth/senha.service';
import { PADROES_ARGON2 } from '../config/config';
import type { Db } from '../database/database.module';
import { NOME_BANCO, urlDoBanco } from '../database/registro-bancos';
import * as schema from '../db/schema';
import { carregarChaveMestra, type ChaveMestra, ErroChave } from '../saas/chave-mestra';
import {
  type Cluster, DONO_BANCO, type EntradaProvisionamento, ErroProvisionamento, type OpcoesProvisionamento, type Portas,
  provisionar, validarEntrada,
} from '../saas/provisionar';
import type { DbPlataforma } from '../saas/registrar-piloto';
import * as sp from '../saas/schema-plataforma';

const USO = 'uso: provisionar-condominio.js [--entrada <arquivo.json>] [--nova-senha-sindico]   (sem --entrada: JSON pelo stdin)';

export class ErroUso extends Error {}

/** Pasta das migrações do condomínio (a mesma do laço de deploy): drizzle, ao lado de dist/. */
export const PASTA_MIGRACOES = join(__dirname, '..', '..', 'drizzle');

export interface Ambiente {
  provisionador: string;
  migratorBase: string;
  rwBase: string;
  plataforma: string;
  mestra: ChaveMestra;
}

/** URL do ambiente com o role (e, se pedido, o banco) conferidos. Mensagem cita a variável, nunca o valor. */
function url(env: NodeJS.ProcessEnv, nome: string, role: string, banco?: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new ErroChave(`${nome} não definida`);
  let u: URL;
  try { u = new URL(v); } catch { throw new ErroChave(`${nome} inválida`); }
  if (decodeURIComponent(u.username) !== role) throw new ErroChave(`${nome} precisa usar o role ${role}`);
  if (!u.password) throw new ErroChave(`${nome} sem senha (variável vazia no .env?)`);
  if (banco !== undefined && u.pathname !== `/${banco}`) throw new ErroChave(`${nome} precisa apontar para o banco ${banco}`);
  return v;
}

export function lerAmbiente(env: NodeJS.ProcessEnv): Ambiente {
  return {
    provisionador: url(env, 'DATABASE_URL_PROVISIONADOR', 'app_provisionador', 'postgres'),
    migratorBase: url(env, 'MIGRATOR_URL_BASE', 'app_migrator'),
    rwBase: url(env, 'DATABASE_URL', 'app_rw'),
    plataforma: url(env, 'DATABASE_URL_PLATAFORMA', 'app_plataforma', 'plataforma'),
    mestra: carregarChaveMestra(env),
  };
}

export function lerArgs(argv: string[]): { arquivo: string | null; opcoes: OpcoesProvisionamento } {
  let arquivo: string | null = null;
  const opcoes: OpcoesProvisionamento = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entrada' && argv[i + 1] !== undefined) arquivo = argv[++i]!;
    else if (a === '--nova-senha-sindico') opcoes.novaSenhaSindico = true;
    else throw new ErroUso(USO);
  }
  return { arquivo, opcoes };
}

export function lerEntrada(texto: string): EntradaProvisionamento {
  let bruto: unknown;
  try { bruto = JSON.parse(texto); } catch { throw new ErroProvisionamento('entrada não é JSON válido'); }
  return validarEntrada(bruto);
}

/** Identificador entre aspas (o nome já foi validado por NOME_BANCO; isto é a segunda rede). */
const ident = (banco: string) => {
  if (!NOME_BANCO.test(banco) || banco === 'portaria') throw new ErroProvisionamento('nome de banco fora do formato');
  return `"${banco}"`;
};

/** Cluster como app_provisionador (CREATEDB + SET em app_migrator, sem INHERIT; db/bootstrap/10_plataforma.sh). */
export class ClusterPg implements Cluster {
  constructor(private readonly c: Client) {}

  async donoDoBanco(banco: string) {
    const r = await this.c.query<{ dono: string }>('SELECT pg_get_userbyid(datdba) AS dono FROM pg_database WHERE datname = $1', [banco]);
    return r.rows[0]?.dono ?? null;
  }

  async criarBanco(banco: string) {
    // template0: o banco nasce limpo mesmo que alguém tenha mexido no template1. CREATE DATABASE não roda em transação.
    await this.c.query(`CREATE DATABASE ${ident(banco)} OWNER ${DONO_BANCO} TEMPLATE template0 ENCODING 'UTF8'`);
  }

  async restringirConexao(banco: string) {
    // Como o dono (SET ROLE, sem herdar privilégio): os mesmos GRANTs do 00_roles.sh para o `portaria`.
    await this.c.query(`SET ROLE ${DONO_BANCO}`);
    try {
      await this.c.query(`REVOKE ALL ON DATABASE ${ident(banco)} FROM PUBLIC`);
      await this.c.query(`GRANT CONNECT ON DATABASE ${ident(banco)} TO app_migrator, app_rw`);
    } finally {
      await this.c.query('RESET ROLE');
    }
  }

  async conexoes(banco: string) {
    const r = await this.c.query<{ rw: boolean; plat: boolean; pub: boolean }>(
      `SELECT has_database_privilege('app_rw', $1, 'CONNECT') AS rw, has_database_privilege('app_plataforma', $1, 'CONNECT') AS plat,
              has_database_privilege('public', $1, 'CONNECT') AS pub`, [banco]);
    const l = r.rows[0]!;
    return { appRw: l.rw, appPlataforma: l.plat, publico: l.pub };
  }
}

/** Migrações do condomínio como app_migrator; devolve aplicadas (tabela do drizzle) e esperadas (journal). */
export async function migrarComo(migratorBase: string, banco: string, pasta = PASTA_MIGRACOES) {
  const c = new Client({ connectionString: urlDoBanco(migratorBase, banco), connectionTimeoutMillis: 5000 });
  c.on('error', () => undefined);
  await c.connect();
  try {
    await migrate(drizzle(c), { migrationsFolder: pasta });
    const r = await c.query<{ n: string }>('SELECT count(*) AS n FROM drizzle.__drizzle_migrations');
    const journal = JSON.parse(readFileSync(join(pasta, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
    return { aplicadas: Number(r.rows[0]!.n), esperadas: journal.entries.length };
  } finally {
    await c.end().catch(() => undefined);
  }
}

/**
 * As conexões de produção do provisionamento (uma por papel, cada uma no seu banco), compartilhadas pela CLI e pelo
 * serviço provisionador (servidor-provisionador.ts). `portas()` conecta o cluster na primeira chamada.
 */
export function abrirPortas(amb: Ambiente) {
  const cluster = new Client({ connectionString: amb.provisionador, connectionTimeoutMillis: 5000 });
  cluster.on('error', () => undefined);
  const plataforma = new Pool({ connectionString: amb.plataforma, max: 1, connectionTimeoutMillis: 5000 });
  plataforma.on('error', () => undefined);
  let conectado = false;
  let dados: { banco: string; pool: Pool } | null = null;
  return {
    async portas(): Promise<Portas> {
      if (!conectado) { await cluster.connect(); conectado = true; }
      return {
        plataforma: drizzle(plataforma, { schema: sp }) as unknown as DbPlataforma,
        cluster: new ClusterPg(cluster),
        migrar: (banco) => migrarComo(amb.migratorBase, banco),
        dados: (banco) => {
          if (!dados || dados.banco !== banco) {
            if (dados) void dados.pool.end().catch(() => undefined);
            dados = { banco, pool: new Pool({ connectionString: urlDoBanco(amb.rwBase, banco), max: 1, connectionTimeoutMillis: 5000 }) };
            dados.pool.on('error', () => undefined);
          }
          return drizzle(dados.pool, { schema }) as unknown as Db;
        },
        mestra: amb.mestra,
        hashSenha: (senha) => hash(senha, { memoryCost: PADROES_ARGON2.memoriaKib, timeCost: PADROES_ARGON2.iteracoes, parallelism: PADROES_ARGON2.paralelismo }),
        gerarSenha: () => gerarSenhaTemporaria(),
      };
    },
    async fechar() {
      await cluster.end().catch(() => undefined);
      await plataforma.end().catch(() => undefined);
      const d = dados as { pool: Pool } | null;
      if (d) await d.pool.end().catch(() => undefined);
      dados = null;
    },
  };
}

async function lerStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new ErroUso(`${USO}\n(stdin é um terminal: passe o JSON por redirecionamento, ex. < condominio.json)`);
  const partes: Buffer[] = [];
  for await (const p of process.stdin) partes.push(p as Buffer);
  return Buffer.concat(partes).toString('utf8');
}

async function principal(): Promise<number> {
  let amb: Ambiente;
  let entrada: EntradaProvisionamento;
  let opcoes: OpcoesProvisionamento;
  try {
    const args = lerArgs(process.argv.slice(2));
    opcoes = args.opcoes;
    amb = lerAmbiente(process.env);
    entrada = lerEntrada(args.arquivo ? readFileSync(args.arquivo, 'utf8') : await lerStdin());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return e instanceof ErroUso ? 2 : 1;
  }

  const conexoes = abrirPortas(amb);
  try {
    const r = await provisionar(await conexoes.portas(), entrada, opcoes);

    const { sindico, ...publico } = r;
    console.log(JSON.stringify(publico, null, 2));
    if (sindico) {
      // Uma vez, só no terminal (stderr). Não grava em arquivo; a entrega ao síndico é fora do sistema (pergunta 8).
      console.error([
        '',
        '================ SENHA TEMPORÁRIA DO SÍNDICO (mostrada UMA vez) ================',
        `  código do condomínio: ${r.codigo}`,
        `  login:                ${sindico.login}`,
        `  senha temporária:     ${sindico.senhaTemporaria}`,
        `  válida até:           ${sindico.expiraEm} (troca obrigatória no primeiro login)`,
        '================================================================================',
        '',
      ].join('\n'));
    }
    console.error(({
      provisionado: 'OK: condomínio provisionado e ativo.',
      retomado: 'OK: provisionamento retomado e concluído; condomínio ativo.',
      ja_provisionado: 'OK: o condomínio já estava ativo com esta entrada; nada mudou.',
      nova_senha_sindico: 'OK: nova senha temporária do síndico gerada (a anterior deixou de valer).',
    } as const)[r.situacao]);
    return 0;
  } catch (e) {
    // Só a mensagem: as nossas citam nomes, e a do pg não traz a senha.
    const m = e instanceof Error ? (e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message) : String(e);
    console.error(`RECUSADO: ${m}`);
    console.error('O condomínio, se chegou a ser registrado, continua em `provisionando` (a API não o atende). Corrija e rode de novo '
      + 'com a MESMA entrada para retomar, ou desfaça pela docs/deploy.md, seção 16.');
    return 1;
  } finally {
    await conexoes.fechar();
    amb.mestra.chave.fill(0);
  }
}

// Só roda como programa (o teste importa as funções).
if (typeof require !== 'undefined' && require.main === module) {
  principal().then((c) => { process.exitCode = c; }, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}

