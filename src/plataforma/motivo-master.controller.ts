// STUB DE COMPATIBILIDADE (Fase B, 2026-11-01): a leitura do Master não pede mais motivo nem grava trilha
// (acesso-plataforma.service.ts). O Front ANTERIOR à Fase B não lê nada antes de receber 200 aqui, e a Api é publicada
// primeiro; por isso a rota fica por UMA publicação: valida o corpo como antes, NÃO grava nada em trilha nenhuma, não
// guarda o texto e devolve um token sem valor (a leitura ignora `X-Motivo-Token`). Remover na Fase C, junto com
// `X-Motivo-Token` em `allowedHeaders` (configurar-app.ts) e o teste do stub em test/master-revelar.test.ts.
import { Body, Controller, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { MIN_JUSTIFICATIVA } from '../dominio/rules';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { Obsoleta, PlataformaAcao } from './decorators';

const CATEGORIAS = ['suporte', 'incidente', 'obrigacao_legal', 'operacao'] as const;
const MotivoDto = z.strictObject({
  categoria: z.enum(CATEGORIAS, 'Escolha a finalidade: suporte, incidente, obrigacao_legal ou operacao.'),
  texto: z.string().trim().min(MIN_JUSTIFICATIVA).max(500),
});

/** Resposta do stub: o mesmo formato de antes; `token` é sempre `dispensado`. */
export interface MotivoEmitido {
  token: string;
  /** ISO 8601 (30 min depois). */
  expiraEm: string;
}

@Controller('plataforma/condominios/:id/motivo')
@PlataformaAcao('condominio.ler')
export class MotivoMasterController {
  constructor(@Inject(RELOGIO) private readonly relogio: Relogio) {}

  @Post()
  @HttpCode(200)
  @Obsoleta('desde 2026-11-01 a leitura não pede motivo; a rota só responde ao app anterior e não grava nada. Sai na próxima publicação.')
  emitir(@Param('id', uuidParam) _id: string, @Body(new ZodPipe(MotivoDto)) _b: z.infer<typeof MotivoDto>,
    @Res({ passthrough: true }) res: Response): MotivoEmitido {
    res.setHeader('Cache-Control', 'no-store');
    return { token: 'dispensado', expiraEm: new Date(this.relogio.agora().getTime() + 30 * 60_000).toISOString() };
  }
}
