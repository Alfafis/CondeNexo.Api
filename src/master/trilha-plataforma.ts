// Trilha da plataforma (`plataforma_audit`, append-only por trigger desde a 0000). Uma linha por ação do Master e por
// recusa de login. `detalhes` nunca leva dado de morador nem texto digitado (o e-mail digitado num login que falhou não é
// gravado: só o motivo, como na trilha do condomínio). `master_usuario_id` é o ATOR (nulo: CLI ou login inexistente).
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type * as sp from '../saas/schema-plataforma';
import { plataformaAudit } from '../saas/schema-plataforma';

export type ExecPlataforma = PgDatabase<PgQueryResultHKT, typeof sp> | PgTransaction<PgQueryResultHKT, typeof sp, ExtractTablesWithRelations<typeof sp>>;

export interface LinhaTrilhaPlataforma {
  masterUsuarioId: string | null;
  acao: string;
  condominioId?: string | null;
  detalhes?: Record<string, unknown>;
}

export async function registrarPlataforma(exec: ExecPlataforma, l: LinhaTrilhaPlataforma): Promise<void> {
  await exec.insert(plataformaAudit).values({
    masterUsuarioId: l.masterUsuarioId, acao: l.acao, condominioId: l.condominioId ?? null, detalhes: l.detalhes ?? null,
  });
}
