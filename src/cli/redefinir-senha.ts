// Redefinição de senha pelo operador da VPS, para quando ninguém com usuario.gerenciar consegue entrar (ex.: a senha do
// seed se perdeu). Mesmo efeito da redefinição pela tela de Usuários: senha temporária de 72 h, troca obrigatória no
// primeiro login, sessões abertas revogadas, registro no audit_log. A temporária sai SÓ no terminal de quem rodou.
//   docker compose run --rm --no-deps api node dist/cli/redefinir-senha.js --login <login>
// Roda como app_rw (DATABASE_URL da API, banco do piloto). Usuário desativado é recusado: reative pela tela antes.
// O bloqueio por login+IP (login_limite) não é zerado aqui; ele expira sozinho em 15 min.
import { hash } from '@node-rs/argon2';
import { SENHA_TEMPORARIA_VALIDADE_MS } from '../dominio/rules';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { SenhaService } from '../auth/senha.service';
import { PADROES_ARGON2 } from '../config/config';
import * as schema from '../db/schema';
import { auditLog, sessao, usuarioSistema } from '../db/schema';

const USO = 'uso: redefinir-senha.js --login <login>';

async function principal(): Promise<number> {
  const [k, login] = process.argv.slice(2);
  if (k !== '--login' || !login) { console.error(USO); return 2; }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL não definida'); return 1; }

  // gerarTemporaria não usa a configuração; o resto do serviço (fila do argon2) não é usado aqui.
  const temporaria = new SenhaService(null as never).gerarTemporaria();
  const senhaHash = await hash(temporaria, { memoryCost: PADROES_ARGON2.memoriaKib, timeCost: PADROES_ARGON2.iteracoes, parallelism: PADROES_ARGON2.paralelismo });

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const r = await db.transaction(async (tx) => {
      const [alvo] = await tx.select().from(usuarioSistema).where(eq(usuarioSistema.login, login));
      if (!alvo) return 'inexistente' as const;
      if (!alvo.ativo) return 'desativado' as const;
      const agora = new Date();
      await tx.update(usuarioSistema).set({
        senhaHash, deveTrocarSenha: true, senhaTemporariaExpiraEm: new Date(agora.getTime() + SENHA_TEMPORARIA_VALIDADE_MS),
        senhaAlteradaEm: agora, atualizadoEm: agora,
      }).where(eq(usuarioSistema.id, alvo.id));
      const revogadas = await tx.update(sessao).set({ revogadaEm: agora, motivoRevogacao: 'redefinicao_senha' })
        .where(and(eq(sessao.usuarioId, alvo.id), isNull(sessao.revogadaEm))).returning({ id: sessao.id });
      await tx.insert(auditLog).values({
        usuarioId: null, usuarioPapel: null, usuarioNome: '(operador da VPS, CLI)', acao: 'usuario.redefinir_senha',
        entidade: 'usuario_sistema', registroId: alvo.id, depois: { origem: 'cli', sessoes_revogadas: revogadas.length },
      });
      return { papel: alvo.papel, revogadas: revogadas.length };
    });
    if (r === 'inexistente') { console.error(`login não encontrado: ${login}`); return 1; }
    if (r === 'desativado') { console.error(`usuário desativado: ${login} (reative pela tela de Usuários antes)`); return 1; }
    console.log(`senha temporária de ${login} (${r.papel}), válida por 72 h, troca obrigatória no primeiro login:`);
    console.log(`  ${temporaria}`);
    console.log(`sessões revogadas: ${r.revogadas}. Copie agora: ela não fica guardada em lugar nenhum.`);
    return 0;
  } finally {
    await pool.end();
  }
}

principal().then((c) => process.exit(c), (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
