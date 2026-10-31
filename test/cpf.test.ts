import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chaveHmacDoAmbiente, documentoBusca, mascararCpf } from '../src/db/cpf';

describe('CPF: máscara e HMAC', () => {
  const chave = Buffer.alloc(32, 1);
  it('máscara: a da API é a do domain (5 primeiros por padrão; 6 do meio no formato antigo)', () => {
    expect(mascararCpf('529.982.247-25')).toBe('529.98*.***-**');
    expect(mascararCpf('529.982.247-25', 'meio')).toBe('***.982.247-**');
  });
  it('HMAC é determinístico, depende da chave e difere do SHA-256 puro', () => {
    const h = documentoBusca('52998224725', chave);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(documentoBusca('529.982.247-25', chave)).toBe(h);
    expect(documentoBusca('52998224725', Buffer.alloc(32, 2))).not.toBe(h);
    expect(h).not.toBe(createHash('sha256').update('52998224725').digest('hex'));
  });
  it('chave do ambiente: obrigatória e com 32+ bytes', () => {
    expect(() => chaveHmacDoAmbiente('')).toThrow(/não definida/);
    expect(() => chaveHmacDoAmbiente(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(chaveHmacDoAmbiente(chave.toString('base64'))).toEqual(chave);
  });
});
