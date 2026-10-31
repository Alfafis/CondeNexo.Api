// ZodPipe: 400 DADOS_INVALIDOS com só caminho e mensagem dos campos em `details`, sem ecoar o valor enviado.
import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodPipe } from '../src/comum/zod.pipe';

const pipe = new ZodPipe(z.strictObject({ nome: z.string().min(3, 'mínimo de 3 letras'), contato: z.strictObject({ telefone: z.string().min(10) }) }));

function falha(valor: unknown): HttpException {
  try { pipe.transform(valor); } catch (e) { return e as HttpException; }
  throw new Error('esperava 400');
}

describe('ZodPipe', () => {
  it('devolve o dado validado', () => {
    expect(pipe.transform({ nome: 'Ana Paula', contato: { telefone: '11999990000' } }).nome).toBe('Ana Paula');
  });

  it('400 traz field e message de cada campo, sem o valor enviado', () => {
    const e = falha({ nome: 'ab', contato: { telefone: '123' }, extra: 'senha-123' });
    expect(e.getStatus()).toBe(400);
    const corpo = e.getResponse() as { codigo: string; mensagem: string; detalhes: { field: string; message: string }[] };
    expect(corpo.codigo).toBe('DADOS_INVALIDOS');
    expect(corpo.detalhes.map((d) => d.field).sort()).toEqual(['', 'contato.telefone', 'nome'].map((f) => f || '(corpo)').sort());
    expect(corpo.detalhes.find((d) => d.field === 'nome')?.message).toBe('mínimo de 3 letras');
    expect(JSON.stringify(corpo)).not.toMatch(/senha-123|"123"/);
  });
});
