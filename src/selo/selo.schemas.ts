import { z } from 'zod';

export const ConferirDto = z.strictObject({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // Colado do e-mail: aceita maiúsculas e espaços nas pontas, compara em minúsculas.
  hash: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, 'hash SHA-256 em hexadecimal (64 caracteres)'),
});
