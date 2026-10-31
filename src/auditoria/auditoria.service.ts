// Trilha de alterações (audit_log, spec §3.3). Padrão para os módulos (ver README.md, "Auditoria"):
//
//   await this.db.transaction(async (tx) => {
//     const [antes] = await tx.select().from(t).where(eq(t.id, id)).for('update');
//     const [depois] = await tx.update(t).set({...}).where(eq(t.id, id)).returning();
//     await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'x.alterar', entidade: 't', registroId: id, antes, depois });
//   });
//
// O primeiro argumento é o executor da ESCRITA: passando a `tx`, a linha de auditoria entra ou sai junto com a
// alteração. Antes de qualquer SQL, valida o que o banco recusaria (formato da ação, IP), porque um erro de SQL aborta
// a transação inteira do chamador e um try/catch sem savepoint não a salva.
import { Global, Injectable, Module } from '@nestjs/common';
import { isIP } from 'node:net';
import type { Papel } from '../dominio/types';
import type { Executor } from '../database/database.module';
import { auditLog } from '../db/schema';
import { mascararDigitos } from '../comum/log';
import { snapshot } from './snapshot';

export interface Ator {
  id: string;
  nome: string;
  papel: Papel;
}

export interface EntradaAuditoria {
  /** Quem fez. Nulo só em falha de login de usuário inexistente (CHECK audit_log_usuario_ck). */
  ator: Ator | null;
  /** usuario_nome quando não há ator: o login digitado, já com dígitos mascarados aqui. */
  nomeInformado?: string;
  /** `entidade.acao` (CHECK audit_log_acao_ck). */
  acao: string;
  /** Nome da tabela (snake_case), ou um rótulo para o que não é tabela ('acao' no acesso.negado). */
  entidade: string;
  registroId?: string | null;
  antes?: unknown;
  depois?: unknown;
  ip?: string | null;
}

const ACAO = /^[a-z][a-zA-Z_]*\.[a-z][a-zA-Z_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O mesmo formato que o Postgres aceita em `inet`; o resto vira nulo (não pode abortar a transação). */
export const ipOuNulo = (ip: string | null | undefined) => (ip && isIP(ip) ? ip : null);

@Injectable()
export class AuditoriaService {
  async registrar(exec: Executor, e: EntradaAuditoria): Promise<void> {
    await exec.insert(auditLog).values(this.linha(e));
  }

  /** Várias linhas num INSERT só (importação da planilha: centenas de pessoas e vínculos na mesma transação). */
  async registrarVarios(exec: Executor, es: EntradaAuditoria[], lote = 500): Promise<void> {
    const linhas = es.map((e) => this.linha(e)); // valida tudo antes do primeiro INSERT
    for (let i = 0; i < linhas.length; i += lote) await exec.insert(auditLog).values(linhas.slice(i, i + lote));
  }

  /**
   * Leitura do app do Master nos dados deste condomínio (SAAS-09): `usuario_id`/`usuario_papel` nulos (o Master não é
   * usuário do condomínio, SAAS-07) e `usuario_nome = plataforma/<e-mail>`, SEM a máscara de dígitos do nome informado
   * (o e-mail do operador é a identificação que o síndico precisa ver; não é dado de morador). Só ações `plataforma.*`.
   */
  async registrarPlataforma(exec: Executor, e: Omit<EntradaAuditoria, 'ator' | 'nomeInformado' | 'antes'> & { email: string }): Promise<void> {
    if (!/^plataforma\.[a-z][a-zA-Z_]*$/.test(e.acao)) throw new Error(`ação da plataforma fora do formato: ${e.acao}`);
    if (e.registroId && !UUID.test(e.registroId)) throw new Error('registroId da auditoria precisa ser uuid');
    await exec.insert(auditLog).values({
      usuarioId: null, usuarioPapel: null, usuarioNome: `plataforma/${e.email}`.replace(/[\r\n\t]+/g, ' ').slice(0, 300),
      acao: e.acao, entidade: e.entidade, registroId: e.registroId ?? null, antes: null, depois: snapshot(e.depois), ip: ipOuNulo(e.ip),
    });
  }

  private linha(e: EntradaAuditoria) {
    if (!ACAO.test(e.acao)) throw new Error(`ação de auditoria fora do formato entidade.acao: ${e.acao}`);
    if (e.registroId && !UUID.test(e.registroId)) throw new Error('registroId da auditoria precisa ser uuid');
    const nome = e.ator?.nome ?? mascararDigitos((e.nomeInformado ?? '').trim()).slice(0, 100);
    return {
      usuarioId: e.ator?.id ?? null,
      usuarioPapel: e.ator?.papel ?? null,
      usuarioNome: nome || '(vazio)',
      acao: e.acao,
      entidade: e.entidade,
      registroId: e.registroId ?? null,
      antes: snapshot(e.antes),
      depois: snapshot(e.depois),
      ip: ipOuNulo(e.ip),
    };
  }
}

@Global()
@Module({ providers: [AuditoriaService], exports: [AuditoriaService] })
export class AuditoriaModule {}

// Re-export para quem só precisa do sanitizador (ex.: testes, exportações).
export { snapshot };
