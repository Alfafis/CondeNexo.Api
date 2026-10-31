// Módulos por condomínio (docs/05_arquitetura_saas.md SAAS-19, F5 entrega 2). O controller (ou o handler) de um módulo
// contratável leva `@Modulo('<nome>')`; o ModuloGuard recusa a rota com 403 MODULO_DESLIGADO quando o condomínio da
// requisição não tem o módulo ligado na plataforma (`condominio.modulos`, lido do cache do ResolvedorCondominio: desligar
// vale em até 1 min, sem reiniciar).
//
// - Ordem: depois da SessaoGuard e da PapelGuard (as três são duráveis e registradas nessa ordem no AppModule). Sem
//   sessão continua 401 e sem papel continua 403 de RBAC: quem não é usuário do condomínio não descobre o que está
//   contratado.
// - 403 e não 404: o usuário do condomínio sabe o que o condomínio contratou; o 403 vai para a trilha como qualquer
//   negação (`acesso.negado`, ação `modulo.<nome>`).
// - Não olham módulo: rotas públicas, rotas da plataforma (o Master lê os dados de qualquer módulo, SAAS-09: o dado
//   continua existindo, para suporte e exportação de fim de contrato) e os jobs (selo e retenção, que nem passam por
//   guarda). Desligar não apaga nada: religar devolve tudo.
// - Teste de arquitetura (test/modulos.test.ts): todo controller tem `@Modulo` ou está na lista do núcleo.
import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Modulo as NomeModulo } from '../dominio/modulos';
import type { Request } from 'express';
import { POLITICA, type Politica } from '../auth/decorators';
import { AcessoNegado } from '../comum/erros';
import { ResolvedorCondominio } from './resolvedor';

export const MODULO = 'portaria:modulo';

export const MENSAGEM_MODULO_DESLIGADO = 'Este módulo não está contratado para este condomínio.';

/** Rota (ou controller inteiro) de um módulo contratável (../dominio/modulos). */
export const Modulo = (m: NomeModulo) => SetMetadata(MODULO, m);

@Injectable()
export class ModuloGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
  ) {}

  async canActivate(c: ExecutionContext): Promise<boolean> {
    const alvos = [c.getHandler(), c.getClass()];
    const modulo = this.reflector.getAllAndOverride<NomeModulo | undefined>(MODULO, alvos);
    if (!modulo) return true;
    const tipo = this.reflector.getAllAndOverride<Politica | undefined>(POLITICA, alvos)?.tipo;
    if (tipo === 'publico' || tipo === 'plataforma') return true;
    const cond = c.switchToHttp().getRequest<Request>().condominio;
    // Sem condomínio a SessaoGuard já recusou (401); se chegar aqui, o DB da subárvore falha fechado no primeiro uso.
    if (!cond) return true;
    if ((await this.resolvedor.modulosDe(cond.id)).includes(modulo)) return true;
    throw new AcessoNegado(`modulo.${modulo}`, MENSAGEM_MODULO_DESLIGADO, 'MODULO_DESLIGADO');
  }
}
