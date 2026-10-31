import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Acao, Ctx, ipDe, Publico } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { erroApi } from '../comum/erros';
import { ZodPipe } from '../comum/zod.pipe';
import { CONFIG, type Config } from '../config/config';
import { CONDOMINIO, type CondominioResolvido } from '../tenancy/condominio';
import { CACHE_PUBLICO_MS, LimiteTaxaPublico } from './publico';
import { ConferirDto } from './selo.schemas';
import { SeloService } from './selo.service';

@Controller('auditoria/selos')
export class SeloController {
  constructor(
    @Inject(SeloService) private readonly s: SeloService,
    @Inject(LimiteTaxaPublico) private readonly limite: LimiteTaxaPublico,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
  ) {}

  /** Público, sem parâmetro (ver ./publico.ts). Só existe com o destino `github` ligado; desligado, 404. */
  @Get('publico')
  @Publico()
  async publico(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = this.limite.consumir(ipDe(req) ?? 'sem-ip', Date.now());
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSeg));
      throw erroApi(429, 'LIMITE_EXCEDIDO', 'Muitas consultas aos selos públicos. Tente de novo em instantes.');
    }
    // SaaS (F2): só o piloto publica (formato v1, por condomínio). Para vários condomínios, o v1 revelaria o volume de
    // cada cliente: a âncora agregada (§4.3) é a fase F4, que vem antes do segundo condomínio real.
    if (!this.config.ancora.github || !this.condominio?.piloto) throw erroApi(404, 'NAO_ENCONTRADO', 'Recurso não encontrado.');
    const corpo = await this.s.selosPublicos();
    // Só o sucesso sai com cache público. Não usar @Header: o Nest aplica antes do handler, e um 429/404 sairia
    // com max-age (resposta de erro com validade explícita pode ser guardada por cache intermediário).
    res.setHeader('Cache-Control', `public, max-age=${CACHE_PUBLICO_MS / 1000}`);
    return corpo;
  }

  @Get()
  @Acao('auditoria.verificar')
  estado() { return this.s.estado(); }

  @Post()
  @Acao('auditoria.selar')
  @HttpCode(200)
  selar(@Ctx() ctx: Contexto) { return this.s.selarAgora(ctx); }

  @Post('conferir')
  @Acao('auditoria.verificar')
  @HttpCode(200)
  conferir(@Ctx() ctx: Contexto, @Body(new ZodPipe(ConferirDto)) b: z.infer<typeof ConferirDto>) { return this.s.conferir(ctx, b); }
}
