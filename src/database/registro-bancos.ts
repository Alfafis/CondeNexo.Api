// Registro dos bancos de condomínio (docs/05_arquitetura_saas.md SAAS-01/03, fase F2): um pool `app_rw` por banco,
// aberto na primeira vez que o banco é pedido e reaproveitado depois. É o ÚNICO lugar que abre conexão em banco de
// condomínio; os serviços recebem o `Db` pela subárvore de injeção do condomínio (database.module.ts).
//
// A URL de cada banco é a `DATABASE_URL` da API (app_rw) com outro nome de banco. O nome vem da coluna
// `condominio.banco` da plataforma, cujo CHECK já fecha o formato (`portaria` ou `portaria_<8>`); aqui ele é conferido
// de novo antes de virar URL, porque um nome fora do formato apontaria a API para um banco que não é de condomínio.
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../db/schema';
import type { Db } from './database.module';

export const REGISTRO_BANCOS = Symbol('REGISTRO_BANCOS');

/** Mesmo formato do CHECK `condominio_banco_ck` da plataforma. */
export const NOME_BANCO = /^portaria(_[a-z0-9]{8})?$/;

export interface RegistroBancos {
  /** Executor do banco do condomínio. Lança para nome de banco fora do formato. */
  db(banco: string): Db;
  /** Pool do banco (trava de job por advisory lock); `null` onde não há pool (PGlite dos testes). */
  pool(banco: string): Pool | null;
  fechar(): Promise<void>;
}

export class ErroBanco extends Error {}

export function urlDoBanco(base: string, banco: string): string {
  if (!NOME_BANCO.test(banco)) throw new ErroBanco('nome de banco de condomínio fora do formato');
  const u = new URL(base);
  u.pathname = `/${banco}`;
  return u.toString();
}

export class RegistroBancosPg implements RegistroBancos {
  private readonly bancos = new Map<string, { pool: Pool; db: Db }>();
  private readonly log = new Logger('Pool');

  /** `max`: conexões por banco (hoje o mesmo 10 da API de um banco só; SAAS-01 sugere 3 com muitos condomínios). */
  constructor(private readonly base: string, private readonly max = 10) {
    urlDoBanco(base, 'portaria'); // URL inválida derruba o boot, não a primeira requisição
  }

  private abrir(banco: string) {
    let b = this.bancos.get(banco);
    if (!b) {
      // keepAlive: o SO sonda a conexão ociosa; connectionTimeoutMillis: falha rápida em vez de pendurar o request.
      const pool = new Pool({ connectionString: urlDoBanco(this.base, banco), max: this.max, keepAlive: true, connectionTimeoutMillis: 5000 });
      // Erro em conexão ociosa não pode derrubar o processo. Só a mensagem do driver (não traz a senha).
      pool.on('error', (erro) => this.log.error(erro.message));
      b = { pool, db: drizzle(pool, { schema }) as unknown as Db };
      this.bancos.set(banco, b);
    }
    return b;
  }

  db(banco: string): Db { return this.abrir(banco).db; }
  pool(banco: string): Pool { return this.abrir(banco).pool; }

  async fechar() {
    const pools = [...this.bancos.values()].map((b) => b.pool.end());
    this.bancos.clear();
    await Promise.all(pools);
  }
}
