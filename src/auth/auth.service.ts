import { Inject, Injectable } from '@nestjs/common';
import { senhaTemporariaVencida } from '../dominio/rules';
import { eq, sql } from 'drizzle-orm';
import { AuditoriaService, type Ator } from '../auditoria/auditoria.service';
import { erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db } from '../database/database.module';
import { usuarioSistema } from '../db/schema';
import { LimiteLoginService, normalizarLogin, type Reserva } from './limite-login.service';
import { EsperaLogin } from './login-sem-condominio';
import { problemasDaSenha, SenhaService } from './senha.service';
import { SessaoService, sessaoLonga } from './sessao.service';
import type { Contexto } from './tipos';

/** Visão pública do usuário (sem hash). `ultimoAcesso` em ms, como `UsuarioSistema` de ../dominio/types. */
export interface UsuarioPublico {
  id: string;
  nome: string;
  login: string;
  papel: Ator['papel'];
  ativo: boolean;
  ultimoAcesso: number | null;
  deveTrocarSenha: boolean;
}

export const colunasPublicas = {
  id: usuarioSistema.id, nome: usuarioSistema.nome, login: usuarioSistema.login, papel: usuarioSistema.papel,
  ativo: usuarioSistema.ativo, ultimoAcesso: usuarioSistema.ultimoAcesso, deveTrocarSenha: usuarioSistema.deveTrocarSenha,
};

export const paraPublico = (u: { ultimoAcesso: Date | null } & Omit<UsuarioPublico, 'ultimoAcesso'>): UsuarioPublico => ({
  id: u.id, nome: u.nome, login: u.login, papel: u.papel, ativo: u.ativo,
  ultimoAcesso: u.ultimoAcesso ? u.ultimoAcesso.getTime() : null, deveTrocarSenha: u.deveTrocarSenha,
});

/** Gestão de usuários (só quem tem usuario.gerenciar): a visão pública + o fim da validade da senha temporária. */
export interface UsuarioGerenciado extends UsuarioPublico {
  senhaTemporariaExpiraEm: number | null;
  /** Troca pendente com a senha temporária vencida no instante da resposta (`senhaTemporariaVencida`): a tela só mostra. */
  senhaTemporariaVencida: boolean;
}

export const colunasGestao = { ...colunasPublicas, senhaTemporariaExpiraEm: usuarioSistema.senhaTemporariaExpiraEm };

export const paraGestao = (u: Parameters<typeof paraPublico>[0] & { senhaTemporariaExpiraEm: Date | null }, agora: Date): UsuarioGerenciado => ({
  ...paraPublico(u), senhaTemporariaExpiraEm: u.senhaTemporariaExpiraEm ? u.senhaTemporariaExpiraEm.getTime() : null,
  senhaTemporariaVencida: temporariaVencida(u, agora),
});

/** Troca pendente com a senha temporária vencida (ou sem prazo gravado: falha fechada). */
export const temporariaVencida = (u: { deveTrocarSenha: boolean; senhaTemporariaExpiraEm: Date | null }, agora: Date) =>
  senhaTemporariaVencida({ deveTrocarSenha: u.deveTrocarSenha, senhaTemporariaExpiraEm: u.senhaTemporariaExpiraEm?.getTime() ?? null }, agora.getTime());

export type ResultadoLogin =
  | { ok: true; token: string; expiraEm: Date; inatividadeMin: number; usuario: UsuarioPublico }
  | { ok: false; motivo: 'credenciais' | 'senha_temporaria_expirada' | 'condominio_suspenso' }
  | { ok: false; motivo: 'bloqueado'; ate: Date };

/** Mensagem ÚNICA para usuário inexistente, inativo e senha errada (spec §5.1). */
export const MENSAGEM_CREDENCIAIS = 'Usuário ou senha inválidos.';
/** Só sai com a senha CERTA: quem não a conhece recebe MENSAGEM_CREDENCIAIS, como em qualquer senha errada. */
/** usuario_nome da trilha quando o login digitado não existe (o texto digitado não é gravado). */
export const LOGIN_INEXISTENTE = '(login inexistente)';
export const MENSAGEM_TEMPORARIA_EXPIRADA = 'Senha temporária vencida. Peça a redefinição à administração.';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(SenhaService) private readonly senhas: SenhaService,
    @Inject(SessaoService) private readonly sessoes: SessaoService,
    @Inject(LimiteLoginService) private readonly limite: LimiteLoginService,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(EsperaLogin) private readonly espera: EsperaLogin,
  ) {}

  private fimDoBloqueio(rs: (Reserva | null)[], agora: Date): Date {
    const fins = rs.filter((r): r is Reserva => !!r && !!r.bloqueadoAte && r.bloqueadoAte > agora).map((r) => r.bloqueadoAte!.getTime());
    // Passou do máximo por concorrência, antes de o bloqueio ser gravado: no mínimo um bloqueio inteiro a partir de agora.
    return new Date(fins.length ? Math.max(...fins) : agora.getTime() + this.limite.bloqueioMs());
  }

  /**
   * `suspenso` (SaaS, SAAS-11): o condomínio está suspenso. Só é revelado a quem acerta a senha (antes disso, o caminho
   * é o de qualquer login inválido); e mesmo com a senha certa conta como falha, como a temporária vencida: não cria
   * sessão, grava auth.login_falha e pode bloquear. Assim a recusa fica sob o mesmo limite de tentativas.
   * `manterConectado`: o pedido do login; vale só para quem não é porteiro (sessaoLonga).
   */
  async login(loginDigitado: string, senha: string, ip: string | null, userAgent: string | undefined, opcoes: { suspenso?: boolean; manterConectado?: boolean } = {}): Promise<ResultadoLogin> {
    const agora = this.relogio.agora();
    // Bloqueiam: o par login+IP e o IP. O login sozinho só gradua o atraso (sem bloqueio dirigido; limite-login.service.ts).
    const chLogin = this.limite.chave('login', loginDigitado);
    const chPar = this.limite.chavePar(loginDigitado, ip);
    const chIp = ip ? this.limite.chave('ip', ip) : null;
    const rLogin = await this.limite.reservar(chLogin, agora);
    const rPar = await this.limite.reservar(chPar, agora);
    const rIp = chIp ? await this.limite.reservar(chIp, agora) : null;

    // Login começando por `@` (o usuário técnico da plataforma, usuarios.service.ts LOGIN_TECNICO_PLATAFORMA): nem é
    // buscado. Segue o caminho de login inexistente (mesma resposta, mesmo custo, mesma trilha): ninguém entra com ele.
    const loginNormalizado = normalizarLogin(loginDigitado);
    const [u] = loginNormalizado.startsWith('@') ? [] : await this.db.select({ ...colunasGestao, senhaHash: usuarioSistema.senhaHash }).from(usuarioSistema)
      .where(sql`lower(${usuarioSistema.login}) = ${loginNormalizado}`).limit(1);
    const ator: Ator | null = u ? { id: u.id, nome: u.nome, papel: u.papel } : null;
    // O texto digitado NUNCA vai para a trilha (append-only, guardada para sempre): quem erra o campo e digita a senha
    // no lugar do login a deixaria legível, e qualquer anônimo gravaria texto arbitrário. Login existente: o ator
    // (usuario_id, nome e papel do cadastro). Inexistente: só um rótulo fixo, sem identificador derivado do texto (um
    // HMAC permitiria, com a chave vazada, testar offline um dicionário de senhas digitadas por engano). A correlação
    // de tentativas fica pelo IP e pelo instante, que já estão na linha.
    const falha = (motivo: string) => this.auditoria.registrar(this.db, {
      ator, nomeInformado: LOGIN_INEXISTENTE, acao: 'auth.login_falha', entidade: 'sessao', ip, depois: { motivo },
    });

    if (this.limite.estaBloqueada(rPar, agora) || (rIp && this.limite.estaBloqueada(rIp, agora))) {
      await falha('bloqueado'); // sem verificar a senha: bloqueado não gasta argon2
      return { ok: false, motivo: 'bloqueado', ate: this.fimDoBloqueio([rPar, rIp], agora) };
    }

    let ok = false;
    if (u && u.ativo) ok = await this.senhas.verificar(u.senhaHash, senha);
    else await this.senhas.verificarFicticio(senha); // mesmo custo: o tempo de resposta não revela se o login existe

    // A validade só é olhada DEPOIS do argon2 e só com a senha certa: senha errada numa conta vencida recebe a
    // mensagem genérica, no mesmo tempo. Senha certa e vencida conta como falha (mantém a reserva, pode bloquear e
    // NÃO chama limite.sucesso): não autenticou, e um "sucesso" aqui zeraria o contador do login e aliviaria o do IP
    // para quem tem uma senha vencida em mãos. Não cria sessão.
    const vencida = ok && temporariaVencida(u!, agora);
    const suspenso = ok && !vencida && !!opcoes.suspenso;
    if (!ok || vencida || suspenso) {
      await falha(vencida ? 'senha_temporaria_expirada' : suspenso ? 'condominio_suspenso' : !u ? 'login_inexistente' : !u.ativo ? 'usuario_inativo' : 'senha_incorreta');
      for (const r of [rPar, rIp]) {
        if (!r) continue;
        const ate = await this.limite.bloquearSeAtingiu(r, agora);
        if (ate) {
          await this.auditoria.registrar(this.db, {
            ator: r.chave.tipo === 'login_ip' ? ator : null, nomeInformado: r.chave.tipo === 'login_ip' ? LOGIN_INEXISTENTE : '(ip)',
            acao: 'auth.bloqueio', entidade: 'login_limite', ip, depois: { tipo: r.chave.tipo, falhas: r.falhas, bloqueado_ate: ate },
          });
        }
      }
      await this.espera.esperar(this.limite.atraso(rLogin.falhas));
      return { ok: false, motivo: vencida ? 'senha_temporaria_expirada' : suspenso ? 'condominio_suspenso' : 'credenciais' };
    }

    const user = u!;
    const longa = sessaoLonga(!!opcoes.manterConectado, user.papel);
    const criada = await this.db.transaction(async (tx) => {
      const s = await this.sessoes.criar(tx, user.id, agora, ip, userAgent, longa);
      await tx.update(usuarioSistema).set({ ultimoAcesso: agora }).where(eq(usuarioSistema.id, user.id));
      await this.auditoria.registrar(tx, {
        ator, acao: 'auth.login', entidade: 'sessao', registroId: s.sessaoId, ip, depois: { login: user.login, expira_em: s.expiraEm, manter_conectado: longa },
      });
      return s;
    });
    await this.limite.sucesso(chLogin, chPar, chIp, agora);
    return { ok: true, token: criada.token, expiraEm: criada.expiraEm, inatividadeMin: criada.inatividadeMin, usuario: paraPublico({ ...user, ultimoAcesso: agora }) };
  }

  async logout(ctx: Contexto): Promise<void> {
    const agora = this.relogio.agora();
    await this.db.transaction(async (tx) => {
      await this.sessoes.revogar(tx, ctx.sessaoId, 'logout', agora);
      await this.auditoria.registrar(tx, {
        ator: ctx.ator, acao: 'auth.logout', entidade: 'sessao', registroId: ctx.sessaoId, ip: ctx.ip, depois: { login: ctx.ator.login },
      });
    });
  }

  async me(ctx: Contexto): Promise<UsuarioPublico> {
    const [u] = await this.db.select(colunasPublicas).from(usuarioSistema).where(eq(usuarioSistema.id, ctx.ator.id));
    if (!u) throw erroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.');
    return paraPublico(u);
  }

  async trocarSenha(ctx: Contexto, senhaAtual: string, novaSenha: string): Promise<UsuarioPublico> {
    const problemas = problemasDaSenha(novaSenha, { login: ctx.ator.login });
    if (problemas.length) throw erroApi(422, 'SENHA_FRACA', problemas[0]!, problemas.map((m) => ({ field: 'novaSenha', message: m })));
    const agora = this.relogio.agora();
    // A senha atual é um segredo sendo adivinhado (sessão roubada): conta no limite do par login+IP da sessão, o mesmo
    // do login. Não no contador só do login: esse não bloqueia, e qualquer anônimo o enche.
    const chPar = this.limite.chavePar(ctx.ator.login, ctx.ip);
    const r = await this.limite.reservar(chPar, agora);
    if (this.limite.estaBloqueada(r, agora)) throw erroApi(429, 'LOGIN_BLOQUEADO', 'Muitas tentativas. Aguarde e tente novamente.');

    const [u] = await this.db.select({ senhaHash: usuarioSistema.senhaHash }).from(usuarioSistema).where(eq(usuarioSistema.id, ctx.ator.id));
    if (!u || !(await this.senhas.verificar(u.senhaHash, senhaAtual))) {
      await this.auditoria.registrar(this.db, {
        ator: ctx.ator, acao: 'auth.trocar_senha_falha', entidade: 'usuario_sistema', registroId: ctx.ator.id, ip: ctx.ip,
      });
      const ate = await this.limite.bloquearSeAtingiu(r, agora);
      if (ate) {
        await this.auditoria.registrar(this.db, {
          ator: ctx.ator, acao: 'auth.bloqueio', entidade: 'login_limite', ip: ctx.ip, depois: { tipo: 'login_ip', falhas: r.falhas, bloqueado_ate: ate },
        });
      }
      throw erroApi(422, 'SENHA_ATUAL_INCORRETA', 'A senha atual não confere.');
    }
    if (novaSenha === senhaAtual) throw erroApi(422, 'SENHA_FRACA', 'A nova senha precisa ser diferente da atual.');

    const novoHash = await this.senhas.gerarHash(novaSenha); // fora da transação: argon2 leva ~250 ms
    return this.db.transaction(async (tx) => {
      const [depois] = await tx.update(usuarioSistema)
        .set({ senhaHash: novoHash, deveTrocarSenha: false, senhaTemporariaExpiraEm: null, senhaAlteradaEm: agora, atualizadoEm: agora })
        .where(eq(usuarioSistema.id, ctx.ator.id)).returning(colunasPublicas);
      const revogadas = await this.sessoes.revogarDoUsuario(tx, ctx.ator.id, 'troca_senha', agora, ctx.sessaoId);
      await this.limite.zerarLogin(tx, ctx.ator.login, agora);
      await this.auditoria.registrar(tx, {
        ator: ctx.ator, acao: 'auth.trocar_senha', entidade: 'usuario_sistema', registroId: ctx.ator.id, ip: ctx.ip,
        antes: { deve_trocar_senha: ctx.ator.deveTrocarSenha }, depois: { deve_trocar_senha: false, sessoes_revogadas: revogadas },
      });
      return paraPublico(depois!);
    });
  }
}
