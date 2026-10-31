// Bancos da API (SaaS, docs/05_arquitetura_saas.md SAAS-01/02/03, fase F2):
//  - `DB` / `PG_POOL`: o banco do condomínio da subárvore de injeção (durable provider; ver tenancy/contexto.ts). Os
//    serviços seguem com `@Inject(DB) db` e não sabem de condomínio: cada condomínio tem a sua instância de cada serviço.
//    Na subárvore "sem condomínio", `DB` lança no primeiro uso (falha fechada) e `PG_POOL` é null.
//  - `REGISTRO_BANCOS`: os pools `app_rw`, um por banco de condomínio (database/registro-bancos.ts).
//  - `PLATAFORMA_DB` (pool `app_plataforma`) e a chave mestra: declarados aqui. Só o ResolvedorCondominio, o
//    RegistroAnonimizacoes (só a tabela lgpd_anonimizacao, só ids) e o módulo do Master (src/plataforma) os injetam (teste
//    de arquitetura em test/saas-isolamento.test.ts).
import { Global, Inject, Module, type OnApplicationShutdown, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { type ConfigEstrutura, ESTRUTURA_PADRAO } from '../dominio/units';
import { ESTRUTURA } from '../config/config';
import * as schema from '../db/schema';
import { CONDOMINIO, type CondominioResolvido } from '../tenancy/condominio';
import type { PayloadCondominio } from '../tenancy/contexto';
import { CHAVE_MESTRA, chaveMestraDoAmbiente, dbPlataforma, PLATAFORMA_DB, PLATAFORMA_POOL, poolPlataforma } from '../plataforma/plataforma-db';
import { RegistroAnonimizacoes } from '../tenancy/registro-anonimizacao';
import { ResolvedorCondominio } from '../tenancy/resolvedor';
import { REGISTRO_BANCOS, type RegistroBancos, RegistroBancosPg } from './registro-bancos';

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');
/** Tipo comum aos drivers (node-postgres em produção, PGlite nos testes). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = PgTransaction<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
/** Onde uma escrita roda: a conexão do pool ou a transação do chamador. */
export type Executor = Db | Tx;

/** O que a API usa da estrutura do condomínio: só o nome do agrupamento (as unidades vêm do banco). */
export type EstruturaCondominio = Pick<ConfigEstrutura, 'agrupamento'>;

export class SemCondominio extends Error {
  constructor() { super('acesso a banco sem condomínio resolvido'); }
}

/**
 * `Db` da subárvore "sem condomínio": qualquer uso lança. `then` e símbolos ficam indefinidos para o Nest (que confere
 * se o valor da factory é uma promessa) e o inspetor do Node não dispararem o erro só por olhar o objeto.
 */
export const dbSemCondominio = (): Db => new Proxy({} as Db, {
  get(_alvo, chave) {
    if (chave === 'then' || typeof chave === 'symbol') return undefined;
    throw new SemCondominio();
  },
});

@Global()
@Module({
  providers: [
    {
      provide: REGISTRO_BANCOS,
      useFactory: (): RegistroBancos => {
        const base = process.env.DATABASE_URL;
        if (!base) throw new Error('DATABASE_URL não definida');
        return new RegistroBancosPg(base);
      },
    },
    { provide: PLATAFORMA_POOL, useFactory: () => poolPlataforma(process.env) },
    { provide: PLATAFORMA_DB, inject: [PLATAFORMA_POOL], useFactory: (pool: Pool) => dbPlataforma(pool) },
    { provide: CHAVE_MESTRA, useFactory: chaveMestraDoAmbiente },
    ResolvedorCondominio,
    RegistroAnonimizacoes,
    {
      provide: CONDOMINIO, scope: Scope.REQUEST, durable: true, inject: [REQUEST],
      useFactory: (p: PayloadCondominio | undefined): CondominioResolvido | null => p?.condominio ?? null,
    },
    {
      provide: DB, scope: Scope.REQUEST, durable: true, inject: [CONDOMINIO, REGISTRO_BANCOS],
      useFactory: (c: CondominioResolvido | null, r: RegistroBancos): Db => (c ? r.db(c.banco) : dbSemCondominio()),
    },
    {
      // Agrupamento ("Bloco"/"Torre") do condomínio da subárvore (tabela `configuracao`, lida pelo resolvedor). Sem
      // condomínio: o padrão (só rótulo; quem usa também usa o DB, que falha fechado).
      provide: ESTRUTURA, scope: Scope.REQUEST, durable: true, inject: [CONDOMINIO],
      useFactory: (c: CondominioResolvido | null): EstruturaCondominio => ({ agrupamento: c?.agrupamento ?? ESTRUTURA_PADRAO.agrupamento }),
    },
    {
      provide: PG_POOL, scope: Scope.REQUEST, durable: true, inject: [CONDOMINIO, REGISTRO_BANCOS],
      useFactory: (c: CondominioResolvido | null, r: RegistroBancos): Pool | null => (c ? r.pool(c.banco) : null),
    },
  ],
  // PLATAFORMA_DB e CHAVE_MESTRA saem daqui só para o módulo do Master (src/plataforma, F5): o teste de arquitetura
  // (test/saas-isolamento.test.ts) limita quem cita os dois símbolos.
  exports: [DB, PG_POOL, CONDOMINIO, ESTRUTURA, REGISTRO_BANCOS, ResolvedorCondominio, RegistroAnonimizacoes, PLATAFORMA_DB, CHAVE_MESTRA],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(REGISTRO_BANCOS) private readonly registro: RegistroBancos,
    @Inject(PLATAFORMA_POOL) private readonly plataforma: { end(): Promise<void> },
  ) {}

  async onApplicationShutdown() {
    await Promise.all([this.registro.fechar(), this.plataforma.end()]);
  }
}
