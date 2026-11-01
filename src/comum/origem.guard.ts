// Verificação de Origin nas LEITURAS (GET/HEAD) de rota não pública. Os métodos que mudam estado já foram verificados
// pelo middleware (origem.ts) antes do roteamento; aqui é guarda porque o critério depende da política da rota, que só
// existe depois do roteamento.
//
// Por quê: leitura auditada grava trilha (documento.ler, lgpd.exportar; as leituras do Master não gravam mais desde
// 2026-11-01, mas continuam cobertas: a regra é por política, não por trilha). Um <img src="https://api.condenexo.com.br/..."> num subdomínio do mesmo site leva o cookie e geraria linha de
// trilha em nome da vítima. Critério: TODA rota que não é @Publico() (inclusive 'plataforma' e rota sem política), não
// só as que hoje gravam trilha: nenhuma depende de navegação direta pelo navegador (o front chama tudo por axios, que
// manda Origin), e a rota auditada nova fica coberta sem ninguém lembrar de marcá-la.
//
// Guarda global ESTÁTICA: o Nest roda as estáticas antes das duráveis por requisição, então ela vem antes do
// SessaoGuard (que toca a sessão), da guarda da plataforma, do controller e de qualquer gravação. O 403 sai com
// `semRegistroDeNegacao`: o FiltroExcecao não grava `acesso.negado` (gravar seria a própria linha falsa que se evita).
import { type CanActivate, type ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { POLITICA, type Politica } from '../auth/decorators';
import { CONFIG, type Config } from '../config/config';
import { CODIGO_ORIGEM_NAO_PERMITIDA, logarRecusa, MENSAGEM_ORIGEM_NAO_PERMITIDA, motivoDeRecusa } from './origem';

@Injectable()
export class GuardaOrigemLeitura implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  canActivate(c: ExecutionContext): boolean {
    if (c.getType() !== 'http') return true;
    const req = c.switchToHttp().getRequest<Request>();
    if (req.method !== 'GET' && req.method !== 'HEAD') return true; // o resto já passou pelo middleware
    const politica = this.reflector.getAllAndOverride<Politica | undefined>(POLITICA, [c.getHandler(), c.getClass()]);
    if (politica?.tipo === 'publico') return true; // /saude, selo público: feitos para qualquer origem
    const motivo = motivoDeRecusa(req, this.config.corsOrigens, true);
    if (!motivo) return true;
    logarRecusa(req, motivo);
    throw new HttpException({ codigo: CODIGO_ORIGEM_NAO_PERMITIDA, mensagem: MENSAGEM_ORIGEM_NAO_PERMITIDA, semRegistroDeNegacao: true }, 403);
  }
}
