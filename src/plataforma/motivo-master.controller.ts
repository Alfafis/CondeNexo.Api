// Motivo da leitura do Master (spec 2026-10-31, Fase B): emite o token que toda rota de leitura do condomínio exige em
// `X-Motivo-Token` (motivo-leitura.ts). Mesma permissão da leitura (`condominio.ler`, só `master`) e o mesmo critério de
// texto do motivo da escrita de síndicos (MIN_JUSTIFICATIVA a 500 caracteres).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { MIN_JUSTIFICATIVA } from '../dominio/rules';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { AcessoPlataformaService } from './acesso-plataforma.service';
import { Master, PlataformaAcao } from './decorators';
import { CATEGORIAS_MOTIVO } from './motivo-leitura';
import type { AuthMaster } from './tipos';

const MotivoDto = z.strictObject({
  categoria: z.enum(CATEGORIAS_MOTIVO, 'Escolha a finalidade: suporte, incidente, obrigacao_legal ou operacao.'),
  texto: z.string().trim()
    .min(MIN_JUSTIFICATIVA, `Escreva o motivo com pelo menos ${MIN_JUSTIFICATIVA} caracteres (ex.: o número do chamado e o pedido).`)
    .max(500, 'O motivo tem no máximo 500 caracteres.'),
});

/** Token do motivo: vai em `X-Motivo-Token` nas leituras deste condomínio, nesta sessão, até `expiraEm`. */
export interface MotivoEmitido {
  token: string;
  /** ISO 8601 (30 min depois da emissão). */
  expiraEm: string;
}

@Controller('plataforma/condominios/:id/motivo')
@PlataformaAcao('condominio.ler')
export class MotivoMasterController {
  constructor(@Inject(AcessoPlataformaService) private readonly acesso: AcessoPlataformaService) {}

  @Post()
  @HttpCode(200)
  async emitir(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(MotivoDto)) b: z.infer<typeof MotivoDto>, @Res({ passthrough: true }) res: Response): Promise<MotivoEmitido> {
    res.setHeader('Cache-Control', 'no-store');
    const r = await this.acesso.emitirMotivo(m, req, id, b);
    return { token: r.token, expiraEm: r.expiraEm.toISOString() };
  }
}
