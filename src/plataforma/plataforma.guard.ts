// Guarda das rotas /plataforma (SAAS-07). Global e ESTÁTICA (só depende do banco plataforma, que não é por condomínio):
// o Nest roda as guardas globais estáticas antes das duráveis, então ela vê toda requisição primeiro e só age nas rotas
// marcadas `{ tipo: 'plataforma' }`. As guardas de condomínio (auth/guards.ts) deixam essas rotas passar, e esta deixa
// passar as de condomínio: cada lado autentica só o que é dele, com o seu cookie e a sua tabela.
import { type CanActivate, type ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { podePlataforma } from '../dominio/rbac-plataforma';
import type { Request } from 'express';
import { POLITICA, type Politica } from '../auth/decorators';
import { ipDe } from '../auth/decorators';
import { erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { CONFIG, type Config } from '../config/config';
import { type DbPlataforma, PLATAFORMA_DB } from '../plataforma/plataforma-db';
import { lerCookieMaster } from './cookie-master';
import { POLITICA_MASTER, type PoliticaMaster } from './decorators';
import { SessaoMasterService } from './sessao-master.service';
import { registrarPlataforma } from './trilha-plataforma';

/** 403 que o FiltroExcecao não grava na trilha de condomínio (não há condomínio aqui; a da plataforma já registrou). */
const negado = (codigo: string, mensagem: string) => new HttpException({ codigo, mensagem, semRegistroDeNegacao: true }, 403);

@Injectable()
export class PlataformaGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessaoMasterService) private readonly sessoes: SessaoMasterService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
  ) {}

  async canActivate(c: ExecutionContext): Promise<boolean> {
    const alvos = [c.getHandler(), c.getClass()];
    if (this.reflector.getAllAndOverride<Politica | undefined>(POLITICA, alvos)?.tipo !== 'plataforma') return true;
    const p = this.reflector.getAllAndOverride<PoliticaMaster | undefined>(POLITICA_MASTER, alvos);
    if (!p) {
      log('error', 'plataforma.rota_sem_politica', { rota: `${c.getClass().name}.${c.getHandler().name}` });
      throw negado('SEM_PERMISSAO', 'Seu perfil não tem permissão para esta ação.');
    }
    if (p.tipo === 'publico') return true;

    const req = c.switchToHttp().getRequest<Request>();
    const token = lerCookieMaster(req, this.config);
    if (!token) throw erroApi(401, 'NAO_AUTENTICADO', 'Entre na plataforma para continuar.');
    const auth = await this.sessoes.validar(token, ipDe(req));
    if (!auth) throw erroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.');
    req.master = auth;

    if (auth.usuario.deveTrocarSenha && !(p.tipo === 'autenticado' && p.permiteTrocaPendente)) {
      throw negado('TROCA_DE_SENHA_OBRIGATORIA', 'Troque a senha provisória antes de continuar.');
    }
    if (p.tipo === 'acao' && !podePlataforma(auth.usuario.papel, p.acao)) {
      await registrarPlataforma(this.db, {
        masterUsuarioId: auth.usuario.id, acao: 'acesso.negado', detalhes: { acao: p.acao, metodo: req.method, ip: auth.ip },
      }).catch(() => log('error', 'plataforma.falha_trilha_negacao', { request_id: req.requestId }));
      throw negado('SEM_PERMISSAO', 'Seu perfil não tem permissão para esta ação.');
    }
    return true;
  }
}
