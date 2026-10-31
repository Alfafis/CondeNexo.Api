// Usuários da plataforma do modo e2e (app do Master). Fictícios, só deste servidor de teste: a senha é a do e2e. Sem
// segundo fator desde 2026-10-23 (SAAS-08).
import { sql } from 'drizzle-orm';
import type { DbPlataforma } from '../../src/saas/plataforma-db';
import { masterSessao, masterUsuario } from '../../src/saas/schema-plataforma';

export const MASTERS_E2E = [
  { id: '0e2e0000-0000-4000-8000-000000000001', email: 'master@exemplo.test', nome: 'Master de Exemplo', papel: 'master', trocaPendente: false },
  { id: '0e2e0000-0000-4000-8000-000000000002', email: 'novo.master@exemplo.test', nome: 'Novo Master de Exemplo', papel: 'master', trocaPendente: true },
  { id: '0e2e0000-0000-4000-8000-000000000003', email: 'suporte@exemplo.test', nome: 'Suporte de Exemplo', papel: 'suporte', trocaPendente: false },
] as const;

/** Cria ou devolve ao estado semeado (senha, troca pendente), revoga sessões e zera os limites. */
export async function semearMastersE2e(db: DbPlataforma, senhaHash: string) {
  const agora = new Date();
  for (const m of MASTERS_E2E) {
    const valores = {
      nome: m.nome, email: m.email, papel: m.papel, ativo: true, senhaHash, deveTrocarSenha: m.trocaPendente,
      senhaTemporariaExpiraEm: m.trocaPendente ? new Date(agora.getTime() + 72 * 3600_000) : null,
    };
    await db.insert(masterUsuario).values({ id: m.id, ...valores }).onConflictDoUpdate({ target: masterUsuario.id, set: valores });
  }
  await db.update(masterSessao).set({ revogadaEm: agora, motivoRevogacao: 'logout' }).where(sql`${masterSessao.revogadaEm} IS NULL`);
  await db.execute(sql`DELETE FROM plataforma_login_limite`); // superusuário do PGlite de teste (app_plataforma não tem DELETE)
}
