// Provisionador de teste (app do Master): o `provisionar()` de verdade sobre PGlite, no lugar do serviço provisionador
// (src/cli/servidor-provisionador.ts). Cada banco novo é um PGlite próprio registrado no RegistroDeTeste da API, como o
// pool app_rw faria; a plataforma roda como app_plataforma (SET ROLE), então os GRANTs da migração valem.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../../src/database/database.module';
import * as s from '../../src/db/schema';
import type { Provisionador } from '../../src/master/provisionador';
import type { ChaveMestra } from '../../src/saas/chave-mestra';
import type { DbPlataforma } from '../../src/saas/plataforma-db';
import { type Cluster, type Portas, provisionar, validarEntrada } from '../../src/saas/provisionar';
import { PASTA_MIGRACOES } from './banco';
import type { RegistroDeTeste } from './saas';

const journal = JSON.parse(readFileSync(fileURLToPath(new URL('../../drizzle/meta/_journal.json', import.meta.url)), 'utf8')) as { entries: unknown[] };

export class ClusterPglite implements Cluster {
  readonly clientes = new Map<string, PGlite>();
  readonly restringidos = new Set<string>();
  constructor(private readonly registro: RegistroDeTeste) {}
  async donoDoBanco(banco: string) { return this.clientes.has(banco) ? 'app_migrator' : null; }
  async criarBanco(banco: string) {
    const c = new PGlite();
    await c.exec('CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;');
    this.clientes.set(banco, c);
    this.registro.bancos.set(banco, drizzle(c, { schema: s }) as unknown as Db);
  }
  async restringirConexao(banco: string) { this.restringidos.add(banco); }
  async conexoes(banco: string) { const ok = this.restringidos.has(banco); return { appRw: true, appPlataforma: !ok, publico: !ok }; }
  async fechar() { for (const c of this.clientes.values()) await c.close(); }
}

export interface OpcoesProvisionadorTeste {
  plataforma: { db: DbPlataforma; client: PGlite };
  registro: RegistroDeTeste;
  mestra: ChaveMestra;
  /** Senha temporária previsível (o teste confere que ela volta uma vez). */
  gerarSenha?: () => string;
}

export function provisionadorPglite(o: OpcoesProvisionadorTeste): Provisionador & { cluster: ClusterPglite; chamadas: number; ligado: boolean } {
  const cluster = new ClusterPglite(o.registro);
  let n = 0;
  const portas = (): Portas => ({
    plataforma: o.plataforma.db,
    cluster,
    migrar: async (banco) => {
      const c = cluster.clientes.get(banco)!;
      await c.exec('RESET ROLE');
      await migrate(drizzle(c), { migrationsFolder: PASTA_MIGRACOES });
      const aplicadas = Number((await c.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0]!.n);
      await c.exec('SET ROLE app_rw');
      return { aplicadas, esperadas: journal.entries.length };
    },
    dados: (banco) => drizzle(cluster.clientes.get(banco)!, { schema: s }) as unknown as Db,
    mestra: o.mestra,
    hashSenha: (senha) => hash(senha, { memoryCost: 1024, timeCost: 1, parallelism: 1 }),
    gerarSenha: o.gerarSenha ?? (() => `temp-${String(++n).padStart(4, '0')}-abcd-efgh`),
  });
  const p = {
    cluster,
    chamadas: 0,
    /** false simula o serviço parado (GET /saude responde disponivel: false). */
    ligado: true,
    configurado: () => true,
    disponivel: async () => p.ligado,
    async provisionar(entrada: unknown, masterUsuarioId: string) {
      p.chamadas++;
      const e = validarEntrada(entrada);
      await o.plataforma.client.exec('SET ROLE app_plataforma');
      try {
        return await provisionar(portas(), e, { masterUsuarioId });
      } finally {
        await o.plataforma.client.exec('RESET ROLE');
      }
    },
  };
  return p;
}
