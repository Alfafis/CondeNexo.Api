// Guards globais, nesta ordem: SessaoGuard (quem é) e PapelGuard (pode?). Os dois respeitam @Publico().
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { pode } from '../dominio/rbac';
import type { Request } from 'express';
import { CONFIG, type Config } from '../config/config';
import { AcessoNegado, erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { interpretarCookie, lerCookieSessao } from './cookie';
import { POLITICA, type Politica } from './decorators';
import { SessaoService } from './sessao.service';

const politicaDe = (reflector: Reflector, c: ExecutionContext) =>
  reflector.getAllAndOverride<Politica | undefined>(POLITICA, [c.getHandler(), c.getClass()]);

@Injectable()
export class SessaoGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessaoService) private readonly sessoes: SessaoService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async canActivate(c: ExecutionContext): Promise<boolean> {
    const tipo = politicaDe(this.reflector, c)?.tipo;
    if (tipo === 'publico' || tipo === 'plataforma') return true; // plataforma: PlataformaGuard (src/master)
    const req = c.switchToHttp().getRequest<Request>();
    const valor = lerCookieSessao(req, this.config);
    if (!valor) throw erroApi(401, 'NAO_AUTENTICADO', 'Entre no sistema para continuar.');
    // SaaS (SAAS-03): a sessão só é procurada no banco do condomínio que o middleware resolveu, e só se o cookie for
    // daquele condomínio. Prefixo de outro condomínio (o X-Condominio escolheu outro), cookie antigo fora do piloto ou
    // sem condomínio: 401 sem ir a banco nenhum. Prefixo forjado para o condomínio certo não basta: o hash do token
    // tem de existir nesse banco.
    const cookie = interpretarCookie(valor);
    const cond = req.condominio;
    const doCondominio = !!cond && !!cookie && (cookie.formato === 'v2' ? cookie.condominioId === cond.id : cond.piloto);
    if (!doCondominio) throw erroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.');
    const auth = await this.sessoes.validar(cookie!.token);
    if (!auth) throw erroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.');
    req.auth = auth;
    return true;
  }
}

@Injectable()
export class PapelGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(c: ExecutionContext): boolean {
    const politica = politicaDe(this.reflector, c);
    if (politica?.tipo === 'publico' || politica?.tipo === 'plataforma') return true;
    const req = c.switchToHttp().getRequest<Request>();
    const usuario = req.auth?.usuario;
    if (!usuario) throw erroApi(401, 'NAO_AUTENTICADO', 'Entre no sistema para continuar.');
    if (!politica) {
      // Erro de programação: rota sem @Publico/@Autenticado/@Acao. Falha fechada.
      log('error', 'rbac.rota_sem_politica', { rota: `${c.getClass().name}.${c.getHandler().name}` });
      throw new AcessoNegado('rota.sem_politica');
    }
    const permiteTroca = politica.tipo === 'autenticado' && politica.permiteTrocaPendente;
    if (usuario.deveTrocarSenha && !permiteTroca) {
      throw new AcessoNegado(politica.tipo === 'acao' ? politica.acao : 'autenticado',
        'Troque a senha provisória antes de continuar.', 'TROCA_DE_SENHA_OBRIGATORIA');
    }
    if (politica.tipo === 'acao' && !pode(usuario.papel, politica.acao)) throw new AcessoNegado(politica.acao);
    return true;
  }
}
