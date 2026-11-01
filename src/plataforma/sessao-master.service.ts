// Sessão do Master (SAAS-08): token opaco de 256 bits no cookie da plataforma; no banco `plataforma` só o SHA-256.
// Expira por inatividade (2 h) e por tempo absoluto (12 h), mais curtas que as do condomínio (4 h / 14 h; decisão do
// usuário de 2026-10-29): é a conta que alcança todos os condomínios (o 2º fator é opcional na fase A1 do C2). Revogada no logout, na troca de senha (as outras) e quando a CLI reemite a
// credencial. Usuário desativado ou com senha temporária vencida: a sessão deixa de valer na hora.
import { Inject, Injectable } from '@nestjs/common';
import { senhaTemporariaVencida } from '../dominio/rules';
import type { PapelPlataforma } from '../dominio/rbac-plataforma';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { type DbPlataforma, PLATAFORMA_DB } from '../plataforma/plataforma-db';
import { masterSessao, masterUsuario } from '../plataforma/schema-plataforma';
import type { ExecPlataforma } from './trilha-plataforma';
import type { AuthMaster } from './tipos';

export const SESSAO_MASTER_INATIVIDADE_MIN = 2 * 60;
export const SESSAO_MASTER_ABSOLUTA_MIN = 12 * 60;
/** Intervalo mínimo entre gravações de `ultimo_uso_em` (uma escrita por minuto, não uma por requisição). */
const TOQUE_MS = 60_000;

/** `segundo_fator` (0005): ativar o 2º fator revoga as OUTRAS sessões, abertas só com senha. */
export type MotivoRevogacaoMaster = 'logout' | 'troca_senha' | 'credencial_reemitida' | 'desativacao' | 'segundo_fator';

export const hashTokenMaster = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class SessaoMasterService {
  constructor(
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(RELOGIO) private readonly relogio: Relogio,
  ) {}

  async criar(tx: ExecPlataforma, masterUsuarioId: string, agora: Date, ip: string | null) {
    const token = randomBytes(32).toString('base64url');
    const expiraEm = new Date(agora.getTime() + SESSAO_MASTER_ABSOLUTA_MIN * 60_000);
    const [s] = await tx.insert(masterSessao).values({
      tokenHash: hashTokenMaster(token), masterUsuarioId, criadaEm: agora, ultimoUsoEm: agora, expiraEm,
      ip: ip && ip.length <= 45 ? ip : null,
    }).returning({ id: masterSessao.id });
    return { token, sessaoId: s!.id, expiraEm };
  }

  async validar(token: string, ip: string | null): Promise<AuthMaster | null> {
    if (!TOKEN.test(token)) return null;
    const agora = this.relogio.agora();
    const [l] = await this.db.select({
      id: masterSessao.id, ultimoUsoEm: masterSessao.ultimoUsoEm, expiraEm: masterSessao.expiraEm, revogadaEm: masterSessao.revogadaEm,
      usuarioId: masterUsuario.id, nome: masterUsuario.nome, email: masterUsuario.email, papel: masterUsuario.papel, ativo: masterUsuario.ativo,
      deveTrocarSenha: masterUsuario.deveTrocarSenha, senhaTemporariaExpiraEm: masterUsuario.senhaTemporariaExpiraEm,
    }).from(masterSessao).innerJoin(masterUsuario, eq(masterUsuario.id, masterSessao.masterUsuarioId))
      .where(eq(masterSessao.tokenHash, hashTokenMaster(token))).limit(1);
    if (!l || l.revogadaEm || !l.ativo) return null;
    if (l.expiraEm <= agora) return null;
    if (agora.getTime() - l.ultimoUsoEm.getTime() >= SESSAO_MASTER_INATIVIDADE_MIN * 60_000) return null;
    if (senhaTemporariaVencida({ deveTrocarSenha: l.deveTrocarSenha, senhaTemporariaExpiraEm: l.senhaTemporariaExpiraEm?.getTime() ?? null }, agora.getTime())) return null;
    if (agora.getTime() - l.ultimoUsoEm.getTime() >= TOQUE_MS) {
      await this.db.update(masterSessao).set({ ultimoUsoEm: agora }).where(and(eq(masterSessao.id, l.id), isNull(masterSessao.revogadaEm)));
    }
    return {
      sessaoId: l.id, expiraEm: l.expiraEm, ip,
      usuario: { id: l.usuarioId, nome: l.nome, email: l.email, papel: l.papel as PapelPlataforma, deveTrocarSenha: l.deveTrocarSenha },
    };
  }

  async revogar(exec: ExecPlataforma, sessaoId: string, motivo: MotivoRevogacaoMaster, agora: Date) {
    await exec.update(masterSessao).set({ revogadaEm: agora, motivoRevogacao: motivo })
      .where(and(eq(masterSessao.id, sessaoId), isNull(masterSessao.revogadaEm)));
  }

  async revogarDoUsuario(exec: ExecPlataforma, masterUsuarioId: string, motivo: MotivoRevogacaoMaster, agora: Date, excetoSessaoId?: string) {
    const r = await exec.update(masterSessao).set({ revogadaEm: agora, motivoRevogacao: motivo })
      .where(and(eq(masterSessao.masterUsuarioId, masterUsuarioId), isNull(masterSessao.revogadaEm),
        excetoSessaoId ? ne(masterSessao.id, excetoSessaoId) : undefined))
      .returning({ id: masterSessao.id });
    return r.length;
  }
}
