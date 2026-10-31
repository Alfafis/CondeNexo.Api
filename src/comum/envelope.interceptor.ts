// Envelope de sucesso (skill rest-api: req-response-consistency): todo 2xx com corpo sai como { data }, e listagem
// paginada como { data, pagination }. 204 (handler sem retorno) sai sem corpo. Erros não passam por aqui: o
// FiltroExcecao os formata ({ statusCode, error, code, message, details?, timestamp, path }).
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { Pagina } from './pagina';

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_c: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((corpo: unknown) => {
      if (corpo === undefined) return undefined;
      if (corpo instanceof Pagina) {
        return { data: corpo.itens, pagination: { cursor: corpo.proximoCursor, hasNextPage: corpo.proximoCursor !== null } };
      }
      return { data: corpo };
    }));
  }
}
