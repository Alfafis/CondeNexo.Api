// Usuários de desenvolvimento: um por papel (os mesmos nomes que os roteiros e os e2e do front usam).
// A senha NÃO está aqui: vem de SEED_SENHA_DEV (já em hash argon2id). Idempotente: login existente não é tocado
// (nem a senha), então rodar de novo não desfaz uma troca de senha. Com troca obrigatória, a senha do seed vale como
// temporária: 72 h a partir de agora (../dominio/rules), como a criada pela administração.
import { SENHA_TEMPORARIA_VALIDADE_MS } from '../dominio/rules';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auditLog, usuarioSistema } from './schema';

export const USUARIOS_DEV = [
  { nome: 'Carlos Andrade', login: 'carlos.andrade', papel: 'sindico' },
  { nome: 'Paula Nogueira', login: 'paula.nogueira', papel: 'administracao' },
  { nome: 'João Lima', login: 'joao.lima', papel: 'porteiro' },
  { nome: 'Luíza Campos', login: 'luiza.campos', papel: 'auditor' },
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aceita qualquer driver (PGlite, node-postgres) e schema
export async function seedUsuariosDev(db: PgDatabase<PgQueryResultHKT, any>, o: { senhaHash: string; deveTrocarSenha: boolean }) {
  const criados: string[] = [];
  const senhaTemporariaExpiraEm = o.deveTrocarSenha ? new Date(Date.now() + SENHA_TEMPORARIA_VALIDADE_MS) : null;
  for (const u of USUARIOS_DEV) {
    await db.transaction(async (tx) => {
      // Sem alvo: o índice único é de expressão (lower(login)), e o ON CONFLICT sem alvo cobre qualquer unicidade.
      const [novo] = await tx.insert(usuarioSistema)
        .values({ ...u, senhaHash: o.senhaHash, deveTrocarSenha: o.deveTrocarSenha, senhaTemporariaExpiraEm })
        .onConflictDoNothing()
        .returning({ id: usuarioSistema.id, login: usuarioSistema.login, papel: usuarioSistema.papel });
      if (!novo) return;
      criados.push(novo.login);
      await tx.insert(auditLog).values({
        usuarioId: null, usuarioPapel: null, usuarioNome: '(seed de desenvolvimento)', acao: 'usuario.criar',
        entidade: 'usuario_sistema', registroId: novo.id,
        depois: { login: novo.login, papel: novo.papel, deve_trocar_senha: o.deveTrocarSenha, origem: 'seed' },
      });
    });
  }
  return criados;
}
