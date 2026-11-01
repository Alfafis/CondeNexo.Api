// 2º fator (TOTP) dos usuários da plataforma (spec C2, fase A1: OPCIONAL). Login em duas etapas com desafio no servidor
// (`master_login_pendente` + cookie de desafio), enrolamento pela tela "Minha conta" (iniciar/confirmar), códigos de
// recuperação e a visão `segundoFator` das respostas. A obrigatoriedade (D4/A3) NÃO existe nesta fase: quem não enrolou
// entra só com a senha, exatamente como antes.
//
// Limite do código em três camadas (D9): (1) 5 tentativas por desafio, reservadas num UPDATE atômico antes de conferir;
// (2) `master_codigo` por usuário em `plataforma_login_limite` (5 falhas em 15 min bloqueiam 15 min); (3)
// `segundo_fator_falhas`: 20 falhas seguidas travam o fator até a CLI (--resetar-2fa ou --nova-senha). Código de
// recuperação conta nas mesmas camadas. Sucesso zera (2) e (3).
//
// NUNCA vai para trilha, log ou mensagem de erro: segredo (claro, base32 ou cifrado), otpauthUri, código TOTP, código de
// recuperação, hash de código. A trilha leva só motivo, etapa, IP e o deslocamento da janela (`desvio`).
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { senhaTemporariaVencida } from '../dominio/rules';
import type { PapelPlataforma } from '../dominio/rbac-plataforma';
import { EsperaLogin } from '../auth/login-sem-condominio';
import { SenhaService } from '../auth/senha.service';
import { erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { type ChaveMestra, ErroChave } from './chave-mestra';
import { gerarCodigosRecuperacao, hashCodigoRecuperacao } from './codigos-recuperacao';
import { LimiteMasterService, type ReservaMaster } from './limite-master.service';
import { CHAVE_MESTRA, type DbPlataforma, PLATAFORMA_DB } from './plataforma-db';
import { masterCodigoRecuperacao, masterLoginPendente, masterUsuario } from './schema-plataforma';
import { cifrarSegredoTotp, decifrarSegredoTotp } from './segredo-totp';
import { SessaoMasterService } from './sessao-master.service';
import type { AuthMaster, SegundoFatorStatus, UsuarioPlataforma } from './tipos';
import { base32, gerarSegredoTotp, otpauthUri, passoDe, verificarTotp } from './totp';
import { type ExecPlataforma, registrarPlataforma } from './trilha-plataforma';

/** Validade do desafio entre a senha e o código. */
export const DESAFIO_TTL_MS = 5 * 60_000;
/** Camada 1: tentativas de código por desafio. */
export const DESAFIO_MAX_TENTATIVAS = 5;
/** Camada 3: falhas seguidas que travam o 2º fator até a CLI. */
export const SEGUNDO_FATOR_MAX_FALHAS = 20;
/** Validade do enrolamento pendente (iniciar -> confirmar). */
export const ENROLAMENTO_TTL_MS = 10 * 60_000;
/**
 * Obrigatoriedade (D4). DESLIGADA na fase A1: nada exige o 2º fator de ninguém. A fase A3 troca isto (e a guarda).
 */
export const SEGUNDO_FATOR_OBRIGATORIO = false;

export const MENSAGEM_DESAFIO_EXPIRADO = 'Entre de novo com e-mail e senha.';
export const MENSAGEM_CODIGO_INVALIDO = 'Código inválido ou já usado.';
export const MENSAGEM_TRAVADO = 'Verificação em duas etapas travada por excesso de tentativas. Fale com o operador da plataforma.';
export const MENSAGEM_INDISPONIVEL = 'Não foi possível conferir o código do autenticador agora. Use um código de recuperação.';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** 403 que o FiltroExcecao não grava na trilha de condomínio (a da plataforma já registrou). */
const travado = () => new HttpException({ codigo: 'SEGUNDO_FATOR_TRAVADO', mensagem: MENSAGEM_TRAVADO, semRegistroDeNegacao: true }, 403);
const indisponivel = () => erroApi(503, 'SEGUNDO_FATOR_INDISPONIVEL', MENSAGEM_INDISPONIVEL);
const codigoInvalido422 = () => erroApi(422, 'CODIGO_INVALIDO', MENSAGEM_CODIGO_INVALIDO, [{ field: 'codigo', message: MENSAGEM_CODIGO_INVALIDO }]);

export type ProvaCodigo = { codigo: string; codigoRecuperacao?: undefined } | { codigo?: undefined; codigoRecuperacao: string };
export type FatorUsado = 'totp' | 'recuperacao';
type MotivoFalha = 'codigo_incorreto' | 'codigo_reutilizado' | 'recuperacao_invalida';

export type ResultadoLoginSegundoFator =
  | { ok: true; token: string; expiraEm: Date; usuario: UsuarioPlataforma; fator: FatorUsado; codigosRecuperacaoRestantes?: number }
  | { ok: false; motivo: 'desafio_expirado' | 'codigo_invalido' | 'travado' | 'indisponivel' }
  | { ok: false; motivo: 'bloqueado'; ate: Date };

export type Bloqueado = { ok: false; motivo: 'bloqueado'; ate: Date };
export interface InicioEnrolamento { segredo: string; otpauthUri: string; expiraEm: Date }

const colunasPublicas = {
  id: masterUsuario.id, nome: masterUsuario.nome, email: masterUsuario.email, papel: masterUsuario.papel, deveTrocarSenha: masterUsuario.deveTrocarSenha,
};
const publico = (u: { id: string; nome: string; email: string; papel: string; deveTrocarSenha: boolean }): UsuarioPlataforma =>
  ({ id: u.id, nome: u.nome, email: u.email, papel: u.papel as PapelPlataforma, deveTrocarSenha: u.deveTrocarSenha });

const colunasFator = {
  ...colunasPublicas,
  ativo: masterUsuario.ativo, senhaTemporariaExpiraEm: masterUsuario.senhaTemporariaExpiraEm,
  totpCifrado: masterUsuario.totpCifrado, totpMestraVersao: masterUsuario.totpMestraVersao, totpAtivadoEm: masterUsuario.totpAtivadoEm,
  totpUltimoPasso: masterUsuario.totpUltimoPasso, segundoFatorFalhas: masterUsuario.segundoFatorFalhas,
  totpPendenteCifrado: masterUsuario.totpPendenteCifrado, totpPendenteMestraVersao: masterUsuario.totpPendenteMestraVersao,
  totpPendenteExpiraEm: masterUsuario.totpPendenteExpiraEm,
};
const selecionarFator = (db: DbPlataforma, usuarioId: string) => db.select(colunasFator).from(masterUsuario).where(eq(masterUsuario.id, usuarioId));
type LinhaFator = Awaited<ReturnType<typeof selecionarFator>>[number];

/** Sentinelas para desfazer a transação do sucesso e decidir fora dela. */
class DesafioPerdido extends Error {}
class FalhaDeCodigo extends Error { constructor(readonly motivo: MotivoFalha) { super(motivo); } }

@Injectable()
export class SegundoFatorService {
  constructor(
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(CHAVE_MESTRA) private readonly mestra: ChaveMestra,
    @Inject(LimiteMasterService) private readonly limite: LimiteMasterService,
    @Inject(SessaoMasterService) private readonly sessoes: SessaoMasterService,
    @Inject(SenhaService) private readonly senhas: SenhaService,
    @Inject(EsperaLogin) private readonly espera: EsperaLogin,
  ) {}

  // ----------------------------------------------------------------------------------------------------------------
  // Visão pública
  // ----------------------------------------------------------------------------------------------------------------

  /** `segundoFator` das respostas: estado e quantos códigos de recuperação restam. Nunca o segredo. */
  async status(usuarioId: string): Promise<SegundoFatorStatus> {
    const [u] = await this.db.select({ ativadoEm: masterUsuario.totpAtivadoEm, geracao: masterUsuario.recuperacaoGeracao })
      .from(masterUsuario).where(eq(masterUsuario.id, usuarioId));
    const ativo = !!u?.ativadoEm;
    return {
      ativo, ativadoEm: u?.ativadoEm ?? null,
      codigosRestantes: ativo ? await this.restantes(this.db, usuarioId, u!.geracao) : 0,
      obrigatorio: SEGUNDO_FATOR_OBRIGATORIO,
    };
  }

  private async restantes(exec: ExecPlataforma, usuarioId: string, geracao: number): Promise<number> {
    const [r] = await exec.select({ n: count() }).from(masterCodigoRecuperacao).where(and(
      eq(masterCodigoRecuperacao.masterUsuarioId, usuarioId), eq(masterCodigoRecuperacao.geracao, geracao), isNull(masterCodigoRecuperacao.usadoEm)));
    return Number(r?.n ?? 0);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // Login, etapa 1 (chamado pelo AuthMasterService depois que a senha conferiu)
  // ----------------------------------------------------------------------------------------------------------------

  /** Cria o desafio (token de 256 bits; só o SHA-256 no banco). Sem sessão. */
  async criarDesafio(usuarioId: string, agora: Date, ip: string | null): Promise<{ token: string; expiraEm: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiraEm = new Date(agora.getTime() + DESAFIO_TTL_MS);
    await this.db.transaction(async (tx) => {
      const [d] = await tx.insert(masterLoginPendente).values({
        tokenHash: hashToken(token), masterUsuarioId: usuarioId, criadoEm: agora, expiraEm, ip: ip && ip.length <= 45 ? ip : null,
      }).returning({ id: masterLoginPendente.id });
      await registrarPlataforma(tx, { masterUsuarioId: usuarioId, acao: 'auth.login_senha_ok', detalhes: { desafio_id: d!.id, expira_em: expiraEm, ip } });
    });
    return { token, expiraEm };
  }

  // ----------------------------------------------------------------------------------------------------------------
  // Login, etapa 2
  // ----------------------------------------------------------------------------------------------------------------

  async loginSegundoFator(token: string | null, prova: ProvaCodigo, ip: string | null): Promise<ResultadoLoginSegundoFator> {
    const agora = this.relogio.agora();
    if (!token || !TOKEN.test(token)) return { ok: false, motivo: 'desafio_expirado' };
    // Camada 1: reserva a tentativa ANTES de conferir, num UPDATE atômico (pedidos paralelos não ganham tentativas extras).
    const [d] = await this.db.update(masterLoginPendente).set({ tentativas: sql`${masterLoginPendente.tentativas} + 1` })
      .where(and(eq(masterLoginPendente.tokenHash, hashToken(token)), isNull(masterLoginPendente.concluidoEm),
        gt(masterLoginPendente.expiraEm, agora), lt(masterLoginPendente.tentativas, DESAFIO_MAX_TENTATIVAS)))
      .returning({ id: masterLoginPendente.id, usuarioId: masterLoginPendente.masterUsuarioId });
    if (!d) return { ok: false, motivo: 'desafio_expirado' };

    // Camada 2.
    const chCodigo = this.limite.chaveCodigo(d.usuarioId);
    const rCodigo = await this.limite.reservar(chCodigo, agora);
    if (this.limite.estaBloqueada(rCodigo, agora)) {
      await this.trilhaFalha(d.usuarioId, 'bloqueado', 'login', ip);
      return { ok: false, motivo: 'bloqueado', ate: this.fimDoBloqueio(rCodigo, agora) };
    }

    // A CLI pode ter agido entre as etapas (desativou, reemitiu a senha, resetou o fator).
    const u = await this.linha(d.usuarioId);
    if (!u || !u.ativo || !u.totpAtivadoEm
      || senhaTemporariaVencida({ deveTrocarSenha: u.deveTrocarSenha, senhaTemporariaExpiraEm: u.senhaTemporariaExpiraEm?.getTime() ?? null }, agora.getTime())) {
      return { ok: false, motivo: 'desafio_expirado' };
    }
    if (u.segundoFatorFalhas >= SEGUNDO_FATOR_MAX_FALHAS) return { ok: false, motivo: 'travado' };

    let passo: number | null = null;
    let desvio: -1 | 0 | 1 | undefined;
    if (prova.codigo !== undefined) {
      let segredo: Buffer;
      try { segredo = this.abrirAtivo(u); } catch { return { ok: false, motivo: 'indisponivel' }; }
      const aceito = verificarTotp(segredo, prova.codigo, passoDe(agora));
      segredo.fill(0);
      if (!aceito) return this.falhaLogin(u.id, rCodigo, 'codigo_incorreto', ip, agora);
      if (u.totpUltimoPasso !== null && aceito.passo <= u.totpUltimoPasso) return this.falhaLogin(u.id, rCodigo, 'codigo_reutilizado', ip, agora);
      passo = aceito.passo;
      desvio = aceito.desvio;
    }
    const fator: FatorUsado = passo !== null ? 'totp' : 'recuperacao';

    try {
      const r = await this.db.transaction(async (tx) => {
        const fechado = await tx.update(masterLoginPendente).set({ concluidoEm: agora })
          .where(and(eq(masterLoginPendente.id, d.id), isNull(masterLoginPendente.concluidoEm), gt(masterLoginPendente.expiraEm, agora)))
          .returning({ id: masterLoginPendente.id });
        if (!fechado.length) throw new DesafioPerdido();
        let restantes: number | undefined;
        if (passo !== null) {
          // Anti-replay (D6): só passo MAIOR que o último aceito. Dois pedidos com o mesmo código: um vence.
          const ok = await tx.update(masterUsuario).set({ totpUltimoPasso: passo, segundoFatorFalhas: 0, ultimoAcesso: agora })
            .where(and(eq(masterUsuario.id, u.id), isNotNull(masterUsuario.totpAtivadoEm),
              or(isNull(masterUsuario.totpUltimoPasso), lt(masterUsuario.totpUltimoPasso, passo))))
            .returning({ id: masterUsuario.id });
          if (!ok.length) throw new FalhaDeCodigo('codigo_reutilizado');
        } else {
          const usado = await tx.update(masterCodigoRecuperacao).set({ usadoEm: agora })
            .where(and(eq(masterCodigoRecuperacao.masterUsuarioId, u.id), eq(masterCodigoRecuperacao.codigoHash, hashCodigoRecuperacao(prova.codigoRecuperacao!)),
              isNull(masterCodigoRecuperacao.usadoEm),
              sql`${masterCodigoRecuperacao.geracao} = (SELECT recuperacao_geracao FROM master_usuario WHERE id = ${u.id})`))
            .returning({ geracao: masterCodigoRecuperacao.geracao });
          if (!usado.length) throw new FalhaDeCodigo('recuperacao_invalida');
          const ok = await tx.update(masterUsuario).set({ segundoFatorFalhas: 0, ultimoAcesso: agora })
            .where(and(eq(masterUsuario.id, u.id), isNotNull(masterUsuario.totpAtivadoEm))).returning({ id: masterUsuario.id });
          if (!ok.length) throw new DesafioPerdido();
          restantes = await this.restantes(tx, u.id, usado[0]!.geracao);
        }
        const s = await this.sessoes.criar(tx, u.id, agora, ip);
        await registrarPlataforma(tx, {
          masterUsuarioId: u.id, acao: 'auth.login',
          detalhes: { sessao_id: s.sessaoId, expira_em: s.expiraEm, ip, fator, ...(desvio !== undefined ? { desvio } : {}) },
        });
        return { ...s, restantes };
      });
      await this.limite.zerar(chCodigo, agora);
      return {
        ok: true, token: r.token, expiraEm: r.expiraEm, usuario: publico(u), fator,
        ...(r.restantes !== undefined ? { codigosRecuperacaoRestantes: r.restantes } : {}),
      };
    } catch (e) {
      if (e instanceof DesafioPerdido) return { ok: false, motivo: 'desafio_expirado' };
      if (e instanceof FalhaDeCodigo) return this.falhaLogin(u.id, rCodigo, e.motivo, ip, agora);
      throw e;
    }
  }

  private async falhaLogin(usuarioId: string, r: ReservaMaster, motivo: MotivoFalha, ip: string | null, agora: Date): Promise<ResultadoLoginSegundoFator> {
    await this.contarFalha(usuarioId, r, motivo, 'login', ip, agora);
    return { ok: false, motivo: 'codigo_invalido' };
  }

  /** Camadas 2 e 3 de uma falha de código, com trilha (motivo, etapa e IP; nunca o código) e o atraso graduado. */
  private async contarFalha(usuarioId: string, r: ReservaMaster, motivo: MotivoFalha, etapa: string, ip: string | null, agora: Date, camada3 = true) {
    await this.trilhaFalha(usuarioId, motivo, etapa, ip);
    if (camada3) {
      const [f] = await this.db.update(masterUsuario).set({ segundoFatorFalhas: sql`least(${masterUsuario.segundoFatorFalhas} + 1, 1000)` })
        .where(eq(masterUsuario.id, usuarioId)).returning({ falhas: masterUsuario.segundoFatorFalhas });
      if (f?.falhas === SEGUNDO_FATOR_MAX_FALHAS) {
        await registrarPlataforma(this.db, { masterUsuarioId: usuarioId, acao: 'auth.segundo_fator_travado', detalhes: { falhas: f.falhas, ip } });
      }
    }
    const ate = await this.limite.bloquearSeAtingiu(r, agora);
    if (ate) {
      await registrarPlataforma(this.db, {
        masterUsuarioId: usuarioId, acao: 'auth.bloqueio', detalhes: { tipo: 'master_codigo', falhas: r.falhas, bloqueado_ate: ate, ip },
      });
    }
    await this.espera.esperar(this.limite.atraso(r.falhas));
  }

  private trilhaFalha(usuarioId: string, motivo: string, etapa: string, ip: string | null) {
    return registrarPlataforma(this.db, { masterUsuarioId: usuarioId, acao: 'auth.segundo_fator_falha', detalhes: { motivo, etapa, ip } });
  }

  private fimDoBloqueio(r: ReservaMaster, agora: Date): Date {
    return r.bloqueadoAte && r.bloqueadoAte > agora ? r.bloqueadoAte : new Date(agora.getTime() + this.limite.bloqueioMs());
  }

  private async linha(usuarioId: string): Promise<LinhaFator | undefined> {
    const [u] = await selecionarFator(this.db, usuarioId);
    return u;
  }

  /** Decifra o segredo ativo; se não abrir (mestra trocada sem rotação, linha adulterada), log sem detalhe e ErroChave. */
  private abrirAtivo(u: LinhaFator): Buffer {
    try {
      return decifrarSegredoTotp(this.mestra, u.id, 'ativo', { cifrado: u.totpCifrado!, mestraVersao: u.totpMestraVersao! });
    } catch (e) {
      log('error', 'plataforma.totp_nao_abre', { usuario_id: u.id });
      throw e instanceof ErroChave ? e : new ErroChave('segredo TOTP não abriu');
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // Enrolamento (rotas autenticadas)
  // ----------------------------------------------------------------------------------------------------------------

  /**
   * Senha atual conferida sob o limite do par login+IP (o mesmo de login, trocarSenha e reautenticar). Errada: 422
   * SENHA_ATUAL_INCORRETA; bloqueado: devolve o fim do bloqueio (o controller responde 429 com Retry-After).
   */
  private async provarSenha(m: AuthMaster, senha: string, etapa: string): Promise<Bloqueado | null> {
    const agora = this.relogio.agora();
    const par = this.limite.chavePar(m.usuario.email, m.ip);
    const r = await this.limite.reservar(par, agora);
    if (this.limite.estaBloqueada(r, agora)) return { ok: false, motivo: 'bloqueado', ate: this.fimDoBloqueio(r, agora) };
    const [u] = await this.db.select({ senhaHash: masterUsuario.senhaHash }).from(masterUsuario).where(eq(masterUsuario.id, m.usuario.id));
    if (!u || !(await this.senhas.verificar(u.senhaHash, senha))) {
      await this.trilhaFalha(m.usuario.id, 'senha_incorreta', etapa, m.ip);
      const ate = await this.limite.bloquearSeAtingiu(r, agora);
      if (ate) await registrarPlataforma(this.db, { masterUsuarioId: m.usuario.id, acao: 'auth.bloqueio', detalhes: { tipo: 'master_ip', falhas: r.falhas, bloqueado_ate: ate, ip: m.ip } });
      const mensagem = 'A senha atual não confere.';
      throw erroApi(422, 'SENHA_ATUAL_INCORRETA', mensagem, [{ field: 'senhaAtual', message: mensagem }]);
    }
    await this.limite.sucesso(this.limite.chave('master', m.usuario.email), par, null, agora);
    return null;
  }

  /**
   * Prova de posse do fator ATIVO, sem efeito colateral: TOTP sem gravar o passo, recuperação SEM consumir (spec:
   * "iniciar não consome": com 1 código restante ainda dá para trocar de dispositivo). Conta nas camadas 2 e 3.
   */
  private async provarPosse(m: AuthMaster, u: LinhaFator, prova: { codigo?: string; codigoRecuperacao?: string }, etapa: string): Promise<Bloqueado | null> {
    const agora = this.relogio.agora();
    if (u.segundoFatorFalhas >= SEGUNDO_FATOR_MAX_FALHAS) throw travado();
    if (prova.codigo === undefined && prova.codigoRecuperacao === undefined) {
      const mensagem = 'Informe o código do autenticador ou um código de recuperação.';
      throw erroApi(422, 'CODIGO_INVALIDO', mensagem, [{ field: 'codigo', message: mensagem }]);
    }
    const ch = this.limite.chaveCodigo(u.id);
    const r = await this.limite.reservar(ch, agora);
    if (this.limite.estaBloqueada(r, agora)) {
      await this.trilhaFalha(u.id, 'bloqueado', etapa, m.ip);
      return { ok: false, motivo: 'bloqueado', ate: this.fimDoBloqueio(r, agora) };
    }
    let ok: boolean;
    if (prova.codigo !== undefined) {
      let segredo: Buffer;
      try { segredo = this.abrirAtivo(u); } catch { throw indisponivel(); }
      ok = verificarTotp(segredo, prova.codigo, passoDe(agora)) !== null;
      segredo.fill(0);
    } else {
      const [c] = await this.db.select({ g: masterCodigoRecuperacao.geracao }).from(masterCodigoRecuperacao).where(and(
        eq(masterCodigoRecuperacao.masterUsuarioId, u.id), eq(masterCodigoRecuperacao.codigoHash, hashCodigoRecuperacao(prova.codigoRecuperacao!)),
        isNull(masterCodigoRecuperacao.usadoEm),
        sql`${masterCodigoRecuperacao.geracao} = (SELECT recuperacao_geracao FROM master_usuario WHERE id = ${u.id})`));
      ok = !!c;
    }
    if (!ok) {
      await this.contarFalha(u.id, r, prova.codigo !== undefined ? 'codigo_incorreto' : 'recuperacao_invalida', etapa, m.ip, agora);
      throw codigoInvalido422();
    }
    await this.limite.zerar(ch, agora);
    await this.db.update(masterUsuario).set({ segundoFatorFalhas: 0 }).where(eq(masterUsuario.id, u.id));
    return null;
  }

  /**
   * Gera um segredo novo no trio PENDENTE (o ativo, se houver, continua valendo até a confirmação). Exige a senha e, se
   * já há fator ativo (troca de dispositivo), também um código válido. Chamar de novo substitui o pendente.
   */
  async iniciar(m: AuthMaster, senhaAtual: string, prova: { codigo?: string; codigoRecuperacao?: string }): Promise<InicioEnrolamento | Bloqueado> {
    const b = await this.provarSenha(m, senhaAtual, 'iniciar');
    if (b) return b;
    const u = await this.linha(m.usuario.id);
    if (!u) throw erroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.');
    const troca = !!u.totpAtivadoEm;
    if (troca) {
      const bp = await this.provarPosse(m, u, prova, 'iniciar');
      if (bp) return bp;
    }
    const agora = this.relogio.agora();
    const segredo = gerarSegredoTotp();
    try {
      const c = cifrarSegredoTotp(this.mestra, u.id, 'pendente', segredo);
      const expiraEm = new Date(agora.getTime() + ENROLAMENTO_TTL_MS);
      await this.db.transaction(async (tx) => {
        await tx.update(masterUsuario).set({ totpPendenteCifrado: c.cifrado, totpPendenteMestraVersao: c.mestraVersao, totpPendenteExpiraEm: expiraEm })
          .where(eq(masterUsuario.id, u.id));
        await registrarPlataforma(tx, { masterUsuarioId: u.id, acao: 'auth.segundo_fator_iniciar', detalhes: { troca_de_dispositivo: troca, ip: m.ip } });
      });
      return { segredo: base32(segredo), otpauthUri: otpauthUri(u.email, segredo), expiraEm };
    } finally {
      segredo.fill(0);
    }
  }

  /**
   * Confirma o pendente com um código dele: vira o ativo (cifrado de novo com a AAD `ativo`), grava o passo (o mesmo
   * código não abre login), zera as falhas, gera a geração nova de códigos e revoga as OUTRAS sessões (D8).
   */
  async confirmar(m: AuthMaster, codigo: string): Promise<{ codigosRecuperacao: string[]; usuario: UsuarioPlataforma } | Bloqueado> {
    const agora = this.relogio.agora();
    const ch = this.limite.chaveCodigo(m.usuario.id);
    const r = await this.limite.reservar(ch, agora);
    if (this.limite.estaBloqueada(r, agora)) {
      await this.trilhaFalha(m.usuario.id, 'bloqueado', 'confirmar', m.ip);
      return { ok: false, motivo: 'bloqueado', ate: this.fimDoBloqueio(r, agora) };
    }
    const u = await this.linha(m.usuario.id);
    const expirado = () => erroApi(409, 'ENROLAMENTO_EXPIRADO', 'O enrolamento expirou. Comece de novo.');
    if (!u?.totpPendenteCifrado || !u.totpPendenteExpiraEm || !u.totpPendenteMestraVersao || u.totpPendenteExpiraEm <= agora) throw expirado();
    let segredo: Buffer;
    try {
      segredo = decifrarSegredoTotp(this.mestra, u.id, 'pendente', { cifrado: u.totpPendenteCifrado, mestraVersao: u.totpPendenteMestraVersao });
    } catch {
      log('error', 'plataforma.totp_pendente_nao_abre', { usuario_id: u.id });
      throw expirado();
    }
    try {
      const aceito = verificarTotp(segredo, codigo, passoDe(agora));
      if (!aceito) {
        // Só camada 2: quem chegou aqui já provou senha (e posse, na troca); um erro de digitação não conta para a trava.
        await this.contarFalha(u.id, r, 'codigo_incorreto', 'confirmar', m.ip, agora, false);
        throw codigoInvalido422();
      }
      const c = cifrarSegredoTotp(this.mestra, u.id, 'ativo', segredo);
      const { codigos, hashes } = gerarCodigosRecuperacao();
      const troca = !!u.totpAtivadoEm;
      const usuario = await this.db.transaction(async (tx) => {
        const [depois] = await tx.update(masterUsuario).set({
          totpCifrado: c.cifrado, totpMestraVersao: c.mestraVersao, totpAtivadoEm: agora, totpUltimoPasso: aceito.passo,
          totpPendenteCifrado: null, totpPendenteMestraVersao: null, totpPendenteExpiraEm: null,
          segundoFatorFalhas: 0, recuperacaoGeracao: sql`${masterUsuario.recuperacaoGeracao} + 1`,
        }).where(and(eq(masterUsuario.id, u.id), eq(masterUsuario.totpPendenteExpiraEm, u.totpPendenteExpiraEm!),
          eq(masterUsuario.totpPendenteMestraVersao, u.totpPendenteMestraVersao!)))
          .returning({ ...colunasPublicas, geracao: masterUsuario.recuperacaoGeracao });
        // Outro `iniciar` (ou a rotação da mestra) trocou o pendente entre a leitura e aqui.
        if (!depois) throw expirado();
        await tx.insert(masterCodigoRecuperacao).values(hashes.map((codigoHash) => ({ masterUsuarioId: u.id, geracao: depois.geracao, codigoHash, criadoEm: agora })));
        const revogadas = await this.sessoes.revogarDoUsuario(tx, u.id, 'segundo_fator', agora, m.sessaoId);
        await registrarPlataforma(tx, {
          masterUsuarioId: u.id, acao: 'auth.segundo_fator_ativar', detalhes: { troca_de_dispositivo: troca, sessoes_revogadas: revogadas, ip: m.ip },
        });
        return publico(depois);
      });
      await this.limite.zerar(ch, agora);
      return { codigosRecuperacao: codigos, usuario };
    } finally {
      segredo.fill(0);
    }
  }

  /** Geração nova de códigos (a anterior deixa de valer inteira). Exige senha e um código TOTP atual. */
  async regerarCodigos(m: AuthMaster, senhaAtual: string, codigo: string): Promise<{ codigosRecuperacao: string[] } | Bloqueado> {
    const b = await this.provarSenha(m, senhaAtual, 'regerar');
    if (b) return b;
    const u = await this.linha(m.usuario.id);
    if (!u?.totpAtivadoEm) throw erroApi(409, 'SEGUNDO_FATOR_INATIVO', 'A verificação em duas etapas não está ativa.');
    const bp = await this.provarPosse(m, u, { codigo }, 'regerar');
    if (bp) return bp;
    const agora = this.relogio.agora();
    const { codigos, hashes } = gerarCodigosRecuperacao();
    await this.db.transaction(async (tx) => {
      const [g] = await tx.update(masterUsuario).set({ recuperacaoGeracao: sql`${masterUsuario.recuperacaoGeracao} + 1` })
        .where(and(eq(masterUsuario.id, u.id), isNotNull(masterUsuario.totpAtivadoEm))).returning({ geracao: masterUsuario.recuperacaoGeracao });
      if (!g) throw erroApi(409, 'SEGUNDO_FATOR_INATIVO', 'A verificação em duas etapas não está ativa.');
      await tx.insert(masterCodigoRecuperacao).values(hashes.map((codigoHash) => ({ masterUsuarioId: u.id, geracao: g.geracao, codigoHash, criadoEm: agora })));
      await registrarPlataforma(tx, { masterUsuarioId: u.id, acao: 'auth.recuperacao_regerar', detalhes: { ip: m.ip } });
    });
    return { codigosRecuperacao: codigos };
  }
}

