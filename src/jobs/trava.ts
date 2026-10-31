// Trava de job entre processos (várias réplicas da API, o agendador e o pedido sob demanda): advisory lock de SESSÃO
// numa conexão dedicada do pool, `pg_try_advisory_lock` (não espera: se outra réplica já está rodando, esta pula).
// Se o processo cair, a conexão fecha e o Postgres solta a trava sozinho; não há lease nem tabela para limpar.
//
// A trava evita trabalho e e-mail em dobro; a CORREÇÃO não depende dela: cada passo é idempotente no banco (selo diário
// com índice único, pessoa travada e reconferida antes de anonimizar, descarte com a cabeça da cadeia travada, documento
// só é marcado se ainda não foi eliminado).
//
// Nos testes com PGlite (uma conexão só, sem pool), não há concorrência a proteger: roda direto.
//
// SaaS (F2, SAAS-13): a trava é do condomínio. O pool é o do banco dele (advisory lock vale por banco) e a chave leva o
// id (`portaria:job:<nome>:<condominio_id>`): o selo de A não espera o de B. Durável: uma instância por condomínio.
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { CONDOMINIO, type CondominioResolvido } from '../saas/condominio';

export type NomeJob = 'retencao' | 'selo';

@Injectable()
export class TravaJobs {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
  ) {}

  /** Roda `fn` com a trava; `{ obtida: false }` se outro processo a tem. */
  async tentar<T>(nome: NomeJob, fn: () => Promise<T>): Promise<{ obtida: true; valor: T } | { obtida: false }> {
    if (!this.condominio) throw new Error('trava de job sem condomínio resolvido');
    if (!this.pool || !('connect' in this.pool)) return { obtida: true, valor: await fn() };
    const chave = `portaria:job:${nome}:${this.condominio.id}`;
    const c: PoolClient = await this.pool.connect();
    let solta = false;
    try {
      const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [chave]);
      if (!r.rows[0]?.ok) return { obtida: false };
      try {
        return { obtida: true, valor: await fn() };
      } finally {
        try { await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [chave]); } catch {
          solta = true; // conexão com problema: descartada abaixo, o que solta a trava de sessão
        }
      }
    } finally {
      c.release(solta);
    }
  }
}
