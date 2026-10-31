import { Body, type CallHandler, Controller, type ExecutionContext, Get, HttpCode, HttpException, Inject, Injectable, type NestInterceptor, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { pode } from '../dominio/rbac';
import { ANEXO_MAX_BYTES } from '../dominio/rules';
import type { Response } from 'express';
import { catchError, type Observable, throwError } from 'rxjs';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { AcessoNegado, erroApi } from '../comum/erros';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { Modulo } from '../tenancy/modulo.guard';
import { ListarOcorrenciasDto, NovaDto, StatusDto, VincularDto } from './ocorrencias.schemas';
import { OcorrenciasService } from './ocorrencias.service';
import type { ArquivoEnviado } from './ocorrencias.types';

/** Erros do multer (tamanho, campo inesperado) chegam como exceção genérica do Nest: aqui viram código legível. */
@Injectable()
export class ErroDeUpload implements NestInterceptor {
  intercept(_c: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((e: unknown) => {
      if (e instanceof HttpException) {
        const r = e.getResponse();
        const nosso = r && typeof r === 'object' && 'codigo' in r;
        if (!nosso && e.getStatus() === 413) {
          return throwError(() => erroApi(413, 'ARQUIVO_GRANDE_DEMAIS', `O anexo passa de ${ANEXO_MAX_BYTES / 1024 / 1024} MB.`));
        }
        if (!nosso && e.getStatus() === 400) {
          return throwError(() => erroApi(400, 'ARQUIVO_INVALIDO', 'Envie um arquivo só, no campo "arquivo" (multipart/form-data).'));
        }
      }
      return throwError(() => e);
    }));
  }
}

@Modulo('ocorrencias')
@Controller('ocorrencias')
export class OcorrenciasController {
  constructor(@Inject(OcorrenciasService) private readonly s: OcorrenciasService) {}

  @Get()
  @Acao('ocorrencia.ver')
  listar(@Query(new ZodPipe(ListarOcorrenciasDto)) q: z.infer<typeof ListarOcorrenciasDto>) {
    return this.s.listar(q);
  }

  @Get(':id')
  @Acao('ocorrencia.ver')
  obter(@Param('id', uuidParam) id: string) {
    return this.s.obter(id);
  }

  @Get(':id/historico')
  @Acao('ocorrencia.ver')
  historico(@Param('id', uuidParam) id: string) {
    return this.s.historico(id);
  }

  @Post()
  @Acao('ocorrencia.operar')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovaDto)) b: z.infer<typeof NovaDto>) {
    return this.s.criar(ctx, b);
  }

  /** Transição de status (verbo na URL, como /desativar): 200 com a ocorrência. */
  @Post(':id/status')
  @Acao('ocorrencia.operar')
  @HttpCode(200)
  status(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(StatusDto)) b: z.infer<typeof StatusDto>) {
    return this.s.alterarStatus(ctx, id, b.status);
  }

  @Post(':id/eventos')
  @Acao('ocorrencia.operar')
  @HttpCode(200)
  vincular(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(VincularDto)) b: z.infer<typeof VincularDto>) {
    return this.s.vincularEventos(ctx, id, b.eventoIds);
  }

  /** multipart/form-data, campo `arquivo`. 201 com a ocorrência (a lista de anexos atualizada). */
  @Post(':id/anexos')
  @Acao('ocorrencia.operar')
  @UseInterceptors(ErroDeUpload, FileInterceptor('arquivo', { limits: { fileSize: ANEXO_MAX_BYTES, files: 1, fields: 0, parts: 1 } }))
  anexar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @UploadedFile() arquivo: ArquivoEnviado | undefined) {
    return this.s.anexar(ctx, id, arquivo);
  }

  /** Conteúdo decifrado, como download (nunca inline: um PDF aberto na origem da API rodaria no contexto dela). */
  @Get(':id/anexos/:documentoId')
  @Acao('documento.ver')
  async baixar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Param('documentoId', uuidParam) documentoId: string, @Res() res: Response) {
    if (!pode(ctx.ator.papel, 'documento.ver')) throw new AcessoNegado('documento.ver'); // redundante com o guard; explícito por ser binário
    const a = await this.s.conteudo(ctx, id, documentoId);
    res.status(200);
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Length', String(a.conteudo.length));
    res.setHeader('Content-Disposition', `attachment; filename="${a.nome}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(a.conteudo);
  }
}
