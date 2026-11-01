// Login do Master: e-mail + senha, sem segundo fator desde 2026-10-23 (decisão do usuário; docs/05_arquitetura_saas.md
// SAAS-08 e §5.3; o TOTP da entrega 1 saiu na migração 0004). Qualquer falha (e-mail inexistente, usuário inativo,
// senha errada) dá a MESMA resposta, no mesmo custo de argon2 (inexistente gasta o hash fictício), sob o mesmo limite de
// tentativas (login, par login+IP e IP). A senha temporária vencida só é revelada a quem acerta a senha (como no
// condomínio). Compensações pela falta do 2º fator: senha mínima de 16 na troca (SENHA_MIN_MASTER), limite de
// tentativas, sessão curta (15 min / 8 h) e o IP em toda linha de login, falha e bloqueio da trilha da plataforma.
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { senhaTemporariaVencida } from '../dominio/rules';
import { type PapelPlataforma, SENHA_MIN_MASTER } from '../dominio/rbac-plataforma';
import { eq, sql } from 'drizzle-orm';
import { codigoPg, constraintPg, erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { EsperaLogin } from '../auth/login-sem-condominio';
import { normalizarLogin } from '../auth/limite-login.service';
import { problemasDaSenha, SenhaService } from '../auth/senha.service';
import { type DbPlataforma, PLATAFORMA_DB } from '../plataforma/plataforma-db';
import { masterUsuario } from '../plataforma/schema-plataforma';
import { LimiteMasterService, type ReservaMaster } from './limite-master.service';
import { SessaoMasterService } from './sessao-master.service';
import type { AuthMaster, UsuarioPlataforma } from './tipos';
import { registrarPlataforma } from './trilha-plataforma';

export const MENSAGEM_CREDENCIAIS_MASTER = 'E-mail ou senha inválidos.';
export const MENSAGEM_TEMPORARIA_EXPIRADA_MASTER = 'Senha temporária vencida. Peça uma nova ao operador da plataforma.';

/** Pedido de PATCH /plataforma/auth/me, já normalizado (normalizarEmail/normalizarNome) pelo DTO do controller. */
export interface PerfilMaster { nome?: string; email?: string; senhaAtual?: string }
export type ResultadoPerfilMaster = { ok: true; usuario: UsuarioPlataforma } | { ok: false; motivo: 'bloqueado'; ate: Date };

export type ResultadoLoginMaster =
  | { ok: true; token: string; expiraEm: Date; usuario: UsuarioPlataforma }
  | { ok: false; motivo: 'credenciais' | 'senha_temporaria_expirada' }
  | { ok: false; motivo: 'bloqueado'; ate: Date };

const colunas = {
  id: masterUsuario.id, nome: masterUsuario.nome, email: masterUsuario.email, papel: masterUsuario.papel,
  deveTrocarSenha: masterUsuario.deveTrocarSenha,
};
const publico = (u: { id: string; nome: string; email: string; papel: string; deveTrocarSenha: boolean }): UsuarioPlataforma =>
  ({ id: u.id, nome: u.nome, email: u.email, papel: u.papel as PapelPlataforma, deveTrocarSenha: u.deveTrocarSenha });

@Injectable()
export class AuthMasterService {
  constructor(
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(SenhaService) private readonly senhas: SenhaService,
    @Inject(SessaoMasterService) private readonly sessoes: SessaoMasterService,
    @Inject(LimiteMasterService) private readonly limite: LimiteMasterService,
    @Inject(EsperaLogin) private readonly espera: EsperaLogin,
  ) {}

  private fimDoBloqueio(rs: (ReservaMaster | null)[], agora: Date): Date {
    const fins = rs.filter((r): r is ReservaMaster => !!r?.bloqueadoAte && r.bloqueadoAte > agora).map((r) => r.bloqueadoAte!.getTime());
    return new Date(fins.length ? Math.max(...fins) : agora.getTime() + this.limite.bloqueioMs());
  }

  async login(email: string, senha: string, ip: string | null): Promise<ResultadoLoginMaster> {
    const agora = this.relogio.agora();
    const chLogin = this.limite.chave('master', email);
    const chPar = this.limite.chavePar(email, ip);
    const chIp = ip ? this.limite.chave('ip', ip) : null;
    const rLogin = await this.limite.reservar(chLogin, agora);
    const rPar = await this.limite.reservar(chPar, agora);
    const rIp = chIp ? await this.limite.reservar(chIp, agora) : null;

    const [u] = await this.db.select({
      ...colunas, ativo: masterUsuario.ativo, senhaHash: masterUsuario.senhaHash, senhaTemporariaExpiraEm: masterUsuario.senhaTemporariaExpiraEm,
    }).from(masterUsuario).where(sql`lower(${masterUsuario.email}) = ${normalizarLogin(email)}`).limit(1);
    // O e-mail digitado NÃO vai para a trilha (append-only): login existente = o id do ator; inexistente = só o motivo.
    const falha = (motivo: string) => registrarPlataforma(this.db, {
      masterUsuarioId: u?.id ?? null, acao: 'auth.login_falha', detalhes: { motivo, ip },
    });

    if (this.limite.estaBloqueada(rPar, agora) || (rIp && this.limite.estaBloqueada(rIp, agora))) {
      await falha('bloqueado'); // sem argon2
      return { ok: false, motivo: 'bloqueado', ate: this.fimDoBloqueio([rPar, rIp], agora) };
    }

    let senhaOk = false;
    if (u && u.ativo) senhaOk = await this.senhas.verificar(u.senhaHash, senha);
    else await this.senhas.verificarFicticio(senha);

    const vencida = senhaOk
      && senhaTemporariaVencida({ deveTrocarSenha: u!.deveTrocarSenha, senhaTemporariaExpiraEm: u!.senhaTemporariaExpiraEm?.getTime() ?? null }, agora.getTime());

    if (!senhaOk || vencida) {
      const motivo = !u ? 'login_inexistente' : !u.ativo ? 'usuario_inativo' : !senhaOk ? 'senha_incorreta' : 'senha_temporaria_expirada';
      return this.recusar(motivo, falha, u?.id ?? null, ip, [rPar, rIp], rLogin, agora, vencida);
    }

    const usuario = u!;
    const criada = await this.db.transaction(async (tx) => {
      await tx.update(masterUsuario).set({ ultimoAcesso: agora }).where(eq(masterUsuario.id, usuario.id));
      const s = await this.sessoes.criar(tx, usuario.id, agora, ip);
      await registrarPlataforma(tx, { masterUsuarioId: usuario.id, acao: 'auth.login', detalhes: { sessao_id: s.sessaoId, expira_em: s.expiraEm, ip } });
      return s;
    });
    await this.limite.sucesso(chLogin, chPar, chIp, agora);
    return { ok: true, token: criada.token, expiraEm: criada.expiraEm, usuario: publico(usuario) };
  }

  private async recusar(motivo: string, falha: (m: string) => Promise<void>, usuarioId: string | null, ip: string | null,
    reservas: (ReservaMaster | null)[], rLogin: ReservaMaster, agora: Date, vencida: boolean): Promise<ResultadoLoginMaster> {
    await falha(motivo);
    for (const r of reservas) {
      if (!r) continue;
      const ate = await this.limite.bloquearSeAtingiu(r, agora);
      if (ate) {
        await registrarPlataforma(this.db, {
          masterUsuarioId: r.chave.tipo === 'master_ip' ? usuarioId : null, acao: 'auth.bloqueio',
          detalhes: { tipo: r.chave.tipo, falhas: r.falhas, bloqueado_ate: ate, ip },
        });
      }
    }
    await this.espera.esperar(this.limite.atraso(rLogin.falhas));
    return { ok: false, motivo: vencida ? 'senha_temporaria_expirada' : 'credenciais' };
  }

  /**
   * Reautenticação no próprio pedido (ações do Master sobre síndicos, docs/05_arquitetura_saas.md §5.5): a senha do Master
   * de novo, verificada com argon2 sob o MESMO limite do login (login gradua o atraso; par login+IP e IP bloqueiam). Uma
   * sessão roubada não basta para mexer em síndico. Falha: linha `auth.reautenticar_falha` em `plataforma_audit` (com a
   * ação tentada e o condomínio, nunca o texto digitado) e 403 `SENHA_MASTER_INCORRETA` (403, não 401: a sessão continua
   * válida e o app não deve tratá-la como expirada). Bloqueado: 429 sem argon2.
   */
  async reautenticar(m: AuthMaster, senha: string, contexto: { acao: string; condominioId: string }): Promise<void> {
    const agora = this.relogio.agora();
    const email = m.usuario.email;
    const chLogin = this.limite.chave('master', email);
    const chPar = this.limite.chavePar(email, m.ip);
    const chIp = m.ip ? this.limite.chave('ip', m.ip) : null;
    const rLogin = await this.limite.reservar(chLogin, agora);
    const rPar = await this.limite.reservar(chPar, agora);
    const rIp = chIp ? await this.limite.reservar(chIp, agora) : null;
    const falha = (motivo: string) => registrarPlataforma(this.db, {
      masterUsuarioId: m.usuario.id, acao: 'auth.reautenticar_falha', condominioId: contexto.condominioId,
      detalhes: { motivo, acao: contexto.acao, ip: m.ip },
    });
    if (this.limite.estaBloqueada(rPar, agora) || (rIp && this.limite.estaBloqueada(rIp, agora))) {
      await falha('bloqueado');
      throw erroApi(429, 'LOGIN_BLOQUEADO', 'Muitas tentativas. Aguarde e tente novamente.');
    }
    const [u] = await this.db.select({ ativo: masterUsuario.ativo, senhaHash: masterUsuario.senhaHash }).from(masterUsuario)
      .where(eq(masterUsuario.id, m.usuario.id));
    const ok = !!u?.ativo && (await this.senhas.verificar(u.senhaHash, senha));
    if (!ok) {
      await falha('senha_incorreta');
      for (const r of [rPar, rIp]) {
        if (!r) continue;
        const ate = await this.limite.bloquearSeAtingiu(r, agora);
        if (ate) {
          await registrarPlataforma(this.db, {
            masterUsuarioId: m.usuario.id, acao: 'auth.bloqueio', detalhes: { tipo: r.chave.tipo, falhas: r.falhas, bloqueado_ate: ate, ip: m.ip },
          });
        }
      }
      await this.espera.esperar(this.limite.atraso(rLogin.falhas));
      const mensagem = 'A sua senha não confere.';
      // `semRegistroDeNegacao`: não há trilha de condomínio a gravar pelo filtro (a da plataforma já registrou).
      throw new HttpException({ codigo: 'SENHA_MASTER_INCORRETA', mensagem, detalhes: [{ field: 'senhaMaster', message: mensagem }], semRegistroDeNegacao: true }, 403);
    }
    await this.limite.sucesso(chLogin, chPar, chIp, agora);
  }

  async logout(m: AuthMaster): Promise<void> {
    const agora = this.relogio.agora();
    await this.db.transaction(async (tx) => {
      await this.sessoes.revogar(tx, m.sessaoId, 'logout', agora);
      await registrarPlataforma(tx, { masterUsuarioId: m.usuario.id, acao: 'auth.logout', detalhes: { sessao_id: m.sessaoId, ip: m.ip } });
    });
  }

  async me(m: AuthMaster): Promise<UsuarioPlataforma> {
    const [u] = await this.db.select(colunas).from(masterUsuario).where(eq(masterUsuario.id, m.usuario.id));
    if (!u) throw erroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.');
    return publico(u);
  }

  async trocarSenha(m: AuthMaster, senhaAtual: string, novaSenha: string): Promise<UsuarioPlataforma> {
    const problemas = problemasDaSenha(novaSenha, { login: m.usuario.email, minimo: SENHA_MIN_MASTER });
    if (problemas.length) throw erroApi(422, 'SENHA_FRACA', problemas[0]!, problemas.map((message) => ({ field: 'novaSenha', message })));
    const agora = this.relogio.agora();
    // A senha atual é um segredo sendo adivinhado (sessão roubada): conta no limite do par login+IP, o mesmo do login.
    const par = this.limite.chavePar(m.usuario.email, m.ip);
    const r = await this.limite.reservar(par, agora);
    if (this.limite.estaBloqueada(r, agora)) throw erroApi(429, 'LOGIN_BLOQUEADO', 'Muitas tentativas. Aguarde e tente novamente.');
    const [u] = await this.db.select({ senhaHash: masterUsuario.senhaHash }).from(masterUsuario).where(eq(masterUsuario.id, m.usuario.id));
    if (!u || !(await this.senhas.verificar(u.senhaHash, senhaAtual))) {
      await registrarPlataforma(this.db, { masterUsuarioId: m.usuario.id, acao: 'auth.trocar_senha_falha', detalhes: { ip: m.ip } });
      const ate = await this.limite.bloquearSeAtingiu(r, agora);
      if (ate) await registrarPlataforma(this.db, { masterUsuarioId: m.usuario.id, acao: 'auth.bloqueio', detalhes: { tipo: 'master_ip', falhas: r.falhas, bloqueado_ate: ate, ip: m.ip } });
      throw erroApi(422, 'SENHA_ATUAL_INCORRETA', 'A senha atual não confere.');
    }
    if (novaSenha === senhaAtual) throw erroApi(422, 'SENHA_FRACA', 'A nova senha precisa ser diferente da atual.', [{ field: 'novaSenha', message: 'A nova senha precisa ser diferente da atual.' }]);
    const novoHash = await this.senhas.gerarHash(novaSenha); // fora da transação: argon2 leva centenas de ms
    const usuario = await this.db.transaction(async (tx) => {
      const [depois] = await tx.update(masterUsuario).set({ senhaHash: novoHash, deveTrocarSenha: false, senhaTemporariaExpiraEm: null })
        .where(eq(masterUsuario.id, m.usuario.id)).returning(colunas);
      const revogadas = await this.sessoes.revogarDoUsuario(tx, m.usuario.id, 'troca_senha', agora, m.sessaoId);
      await registrarPlataforma(tx, {
        masterUsuarioId: m.usuario.id, acao: 'auth.trocar_senha',
        detalhes: { deve_trocar_senha_antes: m.usuario.deveTrocarSenha, sessoes_revogadas: revogadas, ip: m.ip },
      });
      return publico(depois!);
    });
    await this.limite.sucesso(this.limite.chave('master', m.usuario.email), par, null, agora);
    return usuario;
  }

  /**
   * "Minha conta": o próprio nome e e-mail (qualquer papel; autoatendimento, fora da MATRIZ_PLATAFORMA). Valor igual ao
   * atual (e-mail sem diferenciar caixa) não conta como mudança. Trocar o e-mail (o identificador de login) exige a senha
   * atual, contada no limite do par login+IP como em trocarSenha. ORDEM: senha ANTES da unicidade, para quem não sabe a
   * senha (sessão roubada) não descobrir se um e-mail existe. As sessões NÃO são revogadas (o usuário precisa da sessão
   * para corrigir um erro de digitação; o CHECK de motivo de revogação nem tem este caso). A trilha leva só os campos.
   */
  async atualizarPerfil(m: AuthMaster, p: PerfilMaster): Promise<ResultadoPerfilMaster> {
    const atual = m.usuario;
    const nome = p.nome !== undefined && p.nome !== atual.nome ? p.nome : undefined;
    const email = p.email !== undefined && p.email !== normalizarLogin(atual.email) ? p.email : undefined;
    if (nome === undefined && email === undefined) return { ok: true, usuario: await this.me(m) };

    if (email !== undefined) {
      if (p.senhaAtual === undefined) {
        const message = 'Informe a senha atual para trocar o e-mail.';
        throw erroApi(400, 'DADOS_INVALIDOS', 'Dados inválidos.', [{ field: 'senhaAtual', message }]);
      }
      const agora = this.relogio.agora();
      // Chaves do e-mail ANTIGO (o login em vigor, o que um ladrão de sessão tentaria): o MESMO par que login, trocarSenha
      // e reautenticar contam, então alternar entre as rotas não dá palpites extras. As do e-mail novo ficam como estão
      // (contam tentativas de login com ele, de quem quer que seja); as do antigo ficam órfãs e expiram (aceito no spec).
      const par = this.limite.chavePar(atual.email, m.ip);
      const r = await this.limite.reservar(par, agora);
      if (this.limite.estaBloqueada(r, agora)) return { ok: false, motivo: 'bloqueado', ate: this.fimDoBloqueio([r], agora) };
      const [u] = await this.db.select({ senhaHash: masterUsuario.senhaHash }).from(masterUsuario).where(eq(masterUsuario.id, atual.id));
      if (!u || !(await this.senhas.verificar(u.senhaHash, p.senhaAtual))) {
        await registrarPlataforma(this.db, { masterUsuarioId: atual.id, acao: 'auth.alterar_perfil_falha', detalhes: { ip: m.ip } });
        const ate = await this.limite.bloquearSeAtingiu(r, agora);
        if (ate) await registrarPlataforma(this.db, { masterUsuarioId: atual.id, acao: 'auth.bloqueio', detalhes: { tipo: 'master_ip', falhas: r.falhas, bloqueado_ate: ate, ip: m.ip } });
        const mensagem = 'A senha atual não confere.';
        throw erroApi(422, 'SENHA_ATUAL_INCORRETA', mensagem, [{ field: 'senhaAtual', message: mensagem }]);
      }
      // A senha conferiu: zera aqui, antes da unicidade. Um 409 (e-mail de outro usuário) não é palpite errado de senha.
      await this.limite.sucesso(this.limite.chave('master', atual.email), par, null, agora);
    }

    const campos = [...(nome !== undefined ? ['nome'] : []), ...(email !== undefined ? ['email'] : [])];
    try {
      const usuario = await this.db.transaction(async (tx) => {
        const [depois] = await tx.update(masterUsuario).set({ ...(nome !== undefined ? { nome } : {}), ...(email !== undefined ? { email } : {}) })
          .where(eq(masterUsuario.id, atual.id)).returning(colunas);
        if (!depois) throw erroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.');
        // Só QUAIS campos mudaram: nunca o nome nem o e-mail (a trilha é append-only e não guarda texto digitado).
        await registrarPlataforma(tx, { masterUsuarioId: atual.id, acao: 'auth.alterar_perfil', detalhes: { campos, ip: m.ip } });
        return publico(depois);
      });
      return { ok: true, usuario };
    } catch (e) {
      // Índice único em lower(email): também cobre a corrida de dois pedidos com o mesmo e-mail novo.
      if (codigoPg(e) === '23505' && constraintPg(e) === 'master_usuario_email_uq') {
        const mensagem = 'Este e-mail já é usado por outro usuário da plataforma.';
        throw erroApi(409, 'EMAIL_EM_USO', mensagem, [{ field: 'email', message: mensagem }]);
      }
      throw e;
    }
  }
}
