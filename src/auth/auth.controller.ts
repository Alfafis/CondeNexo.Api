import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CONFIG, type Config } from '../config/config';
import { erroApi } from '../comum/erros';
import { HttpException } from '@nestjs/common';
import { ZodPipe } from '../comum/zod.pipe';
import { AuthService, MENSAGEM_CREDENCIAIS, MENSAGEM_TEMPORARIA_EXPIRADA } from './auth.service';
import { log } from '../comum/log';
import { gravarCookieSessao, limparCookieSessao } from './cookie';
import { Autenticado, Ctx, ipDe, Publico } from './decorators';
import { LoginSemCondominio } from './login-sem-condominio';
import { SENHA_MAX } from './senha.service';
import type { Contexto } from './tipos';
import type { CondominioResolvido } from '../saas/condominio';
import { ResolvedorCondominio } from '../saas/resolvedor';
import { permissoesDe } from './permissoes';

/** O condomínio da sessão para o front (cabeçalho e preferência do código): só código e nome, nunca id nem banco. */
const condominioPublico = (c: CondominioResolvido | null | undefined) => (c ? { codigo: c.codigo, nome: c.nome } : null);

const LoginDto = z.strictObject({
  login: z.string().trim().min(1, 'Informe o login.').max(200),
  senha: z.string().min(1, 'Informe a senha.').max(SENHA_MAX),
  /** "Manter conectado neste computador". Ignorado para o porteiro (sessao.service.ts, sessaoLonga). */
  manterConectado: z.boolean().optional(),
});

const TrocarSenhaDto = z.strictObject({
  senhaAtual: z.string().min(1).max(SENHA_MAX),
  novaSenha: z.string().min(1).max(SENHA_MAX),
});

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LoginSemCondominio) private readonly semCondominio: LoginSemCondominio,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
  ) {}

  /** Módulos ligados do condomínio da sessão (SAAS-19): o front esconde menu, rotas e atalhos dos desligados. */
  private modulos(c: CondominioResolvido | null | undefined) {
    return c ? this.resolvedor.modulosDe(c.id) : Promise.resolve([]);
  }

  @Post('login')
  @Publico()
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginDto)) body: z.infer<typeof LoginDto>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // SaaS (SAAS-05): o condomínio vem do cabeçalho X-Condominio (sem ele, o piloto durante a transição). Código
    // inexistente, condomínio fora de ativo/suspenso ou transição desligada: resposta INDISTINGUÍVEL da de um login
    // inexistente num condomínio que existe (mesmo argon2, mesmo atraso crescente, mesmo 429 ao bloquear), para o código
    // não virar oráculo de "quem é cliente". Ver login-sem-condominio.ts.
    const condominio = req.condominio;
    const r = condominio
      // Suspenso (SAAS-11): só quem acerta a senha descobre (auth.service.ts).
      ? await this.auth.login(body.login, body.senha, ipDe(req), req.get('user-agent'), { suspenso: req.condominioStatus === 'suspenso', manterConectado: body.manterConectado })
      : { ok: false as const, ...(await this.semCondominio.tentar(body.login, body.senha, ipDe(req))) };
    if (!condominio) log('info', 'auth.login_sem_condominio', { request_id: req.requestId });
    if (!r.ok && r.motivo === 'bloqueado') {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((r.ate.getTime() - Date.now()) / 1000))));
      throw erroApi(429, 'LOGIN_BLOQUEADO', 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.');
    }
    if (!r.ok && r.motivo === 'senha_temporaria_expirada') throw erroApi(401, 'SENHA_TEMPORARIA_EXPIRADA', MENSAGEM_TEMPORARIA_EXPIRADA);
    if (!r.ok && r.motivo === 'condominio_suspenso') {
      // Já registrado como auth.login_falha e contado no limite: o filtro não grava acesso.negado de novo.
      throw new HttpException({
        codigo: 'CONDOMINIO_SUSPENSO', mensagem: 'O acesso deste condomínio está suspenso. Fale com a administração do condomínio.',
        semRegistroDeNegacao: true,
      }, 403);
    }
    if (!r.ok || !condominio) throw erroApi(401, 'CREDENCIAIS_INVALIDAS', MENSAGEM_CREDENCIAIS);
    gravarCookieSessao(res, this.config, condominio.id, r.token, r.expiraEm);
    const modulos = await this.modulos(condominio);
    return {
      usuario: r.usuario, condominio: condominioPublico(condominio), modulos, permissoes: permissoesDe(r.usuario.papel, modulos),
      sessao: { expiraEm: r.expiraEm.toISOString(), inatividadeMin: r.inatividadeMin },
    };
  }

  @Post('logout')
  @Autenticado({ permiteTrocaPendente: true })
  @HttpCode(204)
  async logout(@Ctx() ctx: Contexto, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx);
    limparCookieSessao(res, this.config);
  }

  @Get('me')
  @Autenticado({ permiteTrocaPendente: true })
  async me(@Ctx() ctx: Contexto, @Req() req: Request) {
    const usuario = await this.auth.me(ctx);
    const modulos = await this.modulos(req.condominio);
    return {
      usuario, condominio: condominioPublico(req.condominio), modulos, permissoes: permissoesDe(usuario.papel, modulos),
      sessao: { expiraEm: req.auth!.expiraEm.toISOString(), inatividadeMin: req.auth!.inatividadeMin },
    };
  }

  @Post('trocar-senha')
  @Autenticado({ permiteTrocaPendente: true })
  @HttpCode(200)
  async trocarSenha(@Ctx() ctx: Contexto, @Body(new ZodPipe(TrocarSenhaDto)) body: z.infer<typeof TrocarSenhaDto>, @Req() req: Request) {
    const usuario = await this.auth.trocarSenha(ctx, body.senhaAtual, body.novaSenha);
    return { usuario, permissoes: permissoesDe(usuario.papel, await this.modulos(req.condominio)) };
  }
}
