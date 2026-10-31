// Validação de entrada com Zod, um pipe por parâmetro: `@Body(new ZodPipe(schema))`.
// Não há ValidationPipe global (whitelist do class-validator esvaziaria o corpo validado por Zod), e `@UsePipes` no
// método validaria TODOS os parâmetros. Schemas são `z.strictObject`: campo desconhecido (ex.: `papel`, `ativo` no
// corpo de quem não pode) é 400, não ignorado em silêncio.
import { type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { erroApi } from './erros';

export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(valor: unknown): z.output<T> {
    const r = this.schema.safeParse(valor);
    if (r.success) return r.data;
    // Só caminho e mensagem: o valor recebido nunca volta na resposta (pode ser senha).
    throw erroApi(400, 'DADOS_INVALIDOS', 'Dados inválidos.',
      r.error.issues.map((i) => ({ field: i.path.join('.') || '(corpo)', message: i.message })));
  }
}

export const uuidParam = new ZodPipe(z.uuid({ message: 'id inválido' }));
