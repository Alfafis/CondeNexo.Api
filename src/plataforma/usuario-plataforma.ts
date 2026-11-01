// Bootstrap e manutenção dos usuários da plataforma pela CLI do operador (src/cli/criar-usuario-plataforma.ts). Não há
// tela para isso de propósito: o primeiro Master não tem quem o crie pela tela, e reemitir a senha pela tela seria o
// caminho de quem roubou a sessão. Roda como app_plataforma (INSERT/UPDATE em master_usuario e master_sessao, INSERT em
// plataforma_audit); a senha temporária sai SÓ no resultado, para o terminal. Sem segundo fator desde 2026-10-23 (SAAS-08).
// Criar e reemitir continuam só aqui. O próprio usuário logado edita o PRÓPRIO nome e e-mail pela tela "Minha conta"
// (PATCH /plataforma/auth/me, com a senha atual para trocar o e-mail), com as regras normalizarNome/normalizarEmail daqui.
import { randomUUID } from 'node:crypto';
import { SENHA_TEMPORARIA_VALIDADE_MS } from '../dominio/rules';
import { PAPEIS_PLATAFORMA, type PapelPlataforma } from '../dominio/rbac-plataforma';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbPlataforma } from '../plataforma/plataforma-db';
import { masterSessao, masterUsuario } from '../plataforma/schema-plataforma';
import { registrarPlataforma } from './trilha-plataforma';

export class ErroUsuarioPlataforma extends Error {}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const EMAIL_MAX = 254;
export const NOME_MIN = 3;
export const NOME_MAX = 120;

/**
 * Regras de e-mail e nome do usuário da plataforma, as MESMAS na CLI (validarCadastro) e em PATCH /plataforma/auth/me.
 * Devolvem o valor normalizado ou null se inválido. O tamanho é conferido ANTES da regex: ela retrocede em tempo
 * quadrático em texto longo (ex.: muitos pontos seguidos de '@'), e na API o texto vem de fora.
 */
export function normalizarEmail(bruto: string): string | null {
  const email = bruto.trim().toLowerCase();
  return email.length <= EMAIL_MAX && EMAIL.test(email) ? email : null;
}

export function normalizarNome(bruto: string): string | null {
  const nome = bruto.trim();
  return nome.length >= NOME_MIN && nome.length <= NOME_MAX ? nome : null;
}

export interface Ferramentas {
  hashSenha(senha: string): Promise<string>;
  gerarSenha(): string;
  agora?: () => Date;
}

export interface Credenciais {
  id: string;
  email: string;
  /** Só quando gerada nesta execução. */
  senhaTemporaria?: string;
  senhaExpiraEm?: string;
}

export function validarCadastro(o: { email?: string; nome?: string; papel?: string }): { email: string; nome: string; papel: PapelPlataforma } {
  const email = normalizarEmail(o.email ?? '');
  const nome = normalizarNome(o.nome ?? '');
  const papel = (o.papel ?? 'master').trim();
  if (email === null) throw new ErroUsuarioPlataforma('--email inválido');
  if (nome === null) throw new ErroUsuarioPlataforma(`--nome precisa de ${NOME_MIN} a ${NOME_MAX} caracteres`);
  if (!(PAPEIS_PLATAFORMA as readonly string[]).includes(papel)) throw new ErroUsuarioPlataforma(`--papel deve ser ${PAPEIS_PLATAFORMA.join(' ou ')}`);
  return { email, nome, papel: papel as PapelPlataforma };
}

const porEmail = (email: string) => sql`lower(${masterUsuario.email}) = ${email.trim().toLowerCase()}`;

/** Cria o usuário com senha temporária (72 h, troca obrigatória). E-mail já cadastrado: recusa. */
export async function criarUsuario(db: DbPlataforma, f: Ferramentas, c: { email: string; nome: string; papel: PapelPlataforma }): Promise<Credenciais> {
  const agora = (f.agora ?? (() => new Date()))();
  const [existe] = await db.select({ id: masterUsuario.id }).from(masterUsuario).where(porEmail(c.email));
  if (existe) throw new ErroUsuarioPlataforma('já existe usuário da plataforma com este e-mail: nada foi alterado (para reemitir a senha: --nova-senha)');
  const id = randomUUID();
  const senha = f.gerarSenha();
  const senhaHash = await f.hashSenha(senha);
  const expira = new Date(agora.getTime() + SENHA_TEMPORARIA_VALIDADE_MS);
  await db.transaction(async (tx) => {
    await tx.insert(masterUsuario).values({
      id, nome: c.nome, email: c.email, senhaHash, papel: c.papel, ativo: true, criadoEm: agora, deveTrocarSenha: true, senhaTemporariaExpiraEm: expira,
    });
    await registrarPlataforma(tx, { masterUsuarioId: null, acao: 'master.criar', detalhes: { origem: 'cli', usuario_id: id, papel: c.papel } });
  });
  return { id, email: c.email, senhaTemporaria: senha, senhaExpiraEm: expira.toISOString() };
}

/** Reemite a senha (esquecida ou suspeita de vazamento): temporária, troca obrigatória, e revoga todas as sessões do usuário. */
export async function reemitirSenha(db: DbPlataforma, f: Ferramentas, email: string): Promise<Credenciais> {
  const agora = (f.agora ?? (() => new Date()))();
  const [u] = await db.select({ id: masterUsuario.id, email: masterUsuario.email, ativo: masterUsuario.ativo }).from(masterUsuario).where(porEmail(email));
  if (!u) throw new ErroUsuarioPlataforma('e-mail não encontrado entre os usuários da plataforma');
  if (!u.ativo) throw new ErroUsuarioPlataforma('usuário desativado: nada foi reemitido');
  const senha = f.gerarSenha();
  const senhaHash = await f.hashSenha(senha);
  const expira = new Date(agora.getTime() + SENHA_TEMPORARIA_VALIDADE_MS);
  await db.transaction(async (tx) => {
    await tx.update(masterUsuario).set({ senhaHash, deveTrocarSenha: true, senhaTemporariaExpiraEm: expira }).where(eq(masterUsuario.id, u.id));
    const revogadas = await tx.update(masterSessao).set({ revogadaEm: agora, motivoRevogacao: 'credencial_reemitida' })
      .where(and(eq(masterSessao.masterUsuarioId, u.id), isNull(masterSessao.revogadaEm))).returning({ id: masterSessao.id });
    await registrarPlataforma(tx, {
      masterUsuarioId: null, acao: 'master.reemitir_credencial',
      detalhes: { origem: 'cli', usuario_id: u.id, senha: true, sessoes_revogadas: revogadas.length },
    });
  });
  return { id: u.id, email: u.email, senhaTemporaria: senha, senhaExpiraEm: expira.toISOString() };
}
