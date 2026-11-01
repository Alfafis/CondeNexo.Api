// Peças do 2º fator da plataforma (sub-projeto C2, fase A1) sem banco: TOTP (RFC 6238), base32, cifra do segredo pela
// mestra com AAD, a primitiva genérica de chave-mestra.ts (com não regressão do embrulho das chaves de condomínio) e os
// códigos de recuperação.
import { createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cifrarComAad, decifrarComAad, desembrulhar, embrulhar, ErroChave } from '../src/plataforma/chave-mestra';
import { CODIGOS_POR_GERACAO, gerarCodigosRecuperacao, hashCodigoRecuperacao, normalizarCodigoRecuperacao } from '../src/plataforma/codigos-recuperacao';
import { aadTotp, cifrarSegredoTotp, decifrarSegredoTotp, TAMANHO_TOTP_CIFRADO } from '../src/plataforma/segredo-totp';
import { base32, codigoTotp, deBase32, gerarSegredoTotp, otpauthUri, passoDe, verificarTotp } from '../src/plataforma/totp';

const RFC = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 6238, SHA1, 6 dígitos, 30 s)', () => {
  it('vetores da RFC 6238 (apêndice B, SHA1; os 6 últimos dos 8 dígitos)', () => {
    const vetores: [number, string][] = [
      [59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
    ];
    for (const [t, esperado] of vetores) expect(codigoTotp(RFC, passoDe(new Date(t * 1000))), String(t)).toBe(esperado);
  });

  it('janela: -1, 0 e +1 aceitos (com o desvio), ±2 recusados', () => {
    const p = passoDe(new Date(1234567890 * 1000));
    expect(verificarTotp(RFC, codigoTotp(RFC, p), p)).toEqual({ passo: p, desvio: 0 });
    expect(verificarTotp(RFC, codigoTotp(RFC, p - 1), p)).toEqual({ passo: p - 1, desvio: -1 });
    expect(verificarTotp(RFC, codigoTotp(RFC, p + 1), p)).toEqual({ passo: p + 1, desvio: 1 });
    expect(verificarTotp(RFC, codigoTotp(RFC, p - 2), p)).toBeNull();
    expect(verificarTotp(RFC, codigoTotp(RFC, p + 2), p)).toBeNull();
    expect(verificarTotp(RFC, '12345', p)).toBeNull();
    expect(verificarTotp(RFC, '1234567', p)).toBeNull();
    expect(verificarTotp(RFC, 'abcdef', p)).toBeNull();
  });

  it('troca de passo exatamente no segundo 30', () => {
    expect(passoDe(new Date(29_999))).toBe(0);
    expect(passoDe(new Date(30_000))).toBe(1);
    expect(passoDe(new Date(59_999))).toBe(1);
    expect(passoDe(new Date(60_000))).toBe(2);
  });

  it('base32 RFC 4648 sem padding: vetores e ida e volta; segredo de 20 bytes = 32 caracteres', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32(Buffer.from('f'))).toBe('MY');
    expect(deBase32('MZXW6YTBOI').toString()).toBe('foobar');
    expect(deBase32('mzxw6ytboi').toString()).toBe('foobar');
    for (let i = 0; i < 50; i++) {
      const s = gerarSegredoTotp();
      expect(s).toHaveLength(20);
      const b = base32(s);
      expect(b).toMatch(/^[A-Z2-7]{32}$/);
      expect(deBase32(b).equals(s)).toBe(true);
    }
    expect(() => deBase32('ABC1')).toThrow('base32 inválido');
  });

  it('otpauthUri com emissor, algoritmo, dígitos e período', () => {
    const s = Buffer.alloc(20, 1);
    expect(otpauthUri('m@x.test', s)).toBe(`otpauth://totp/CondeNexo%3Am%40x.test?secret=${base32(s)}&issuer=CondeNexo&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('cifra do segredo pela mestra (AAD amarrada ao usuário e ao estado)', () => {
  const mestra = { chave: randomBytes(32), versao: 2 };
  const A = '0a0a0000-0000-4000-8000-0000000000aa';
  const B = '0a0a0000-0000-4000-8000-0000000000bb';

  it('ida e volta; 48 bytes (nonce || cifrado || tag); nonce novo a cada vez', () => {
    const s = gerarSegredoTotp();
    const c1 = cifrarSegredoTotp(mestra, A, 'ativo', s);
    const c2 = cifrarSegredoTotp(mestra, A, 'ativo', s);
    expect(c1.cifrado).toHaveLength(TAMANHO_TOTP_CIFRADO);
    expect(TAMANHO_TOTP_CIFRADO).toBe(48);
    expect(c1.mestraVersao).toBe(2);
    expect(c1.cifrado.equals(c2.cifrado)).toBe(false);
    expect(decifrarSegredoTotp(mestra, A, 'ativo', c1).equals(s)).toBe(true);
    expect(c1.cifrado.includes(s)).toBe(false);
    expect(aadTotp(A, 'pendente')).toBe(`portaria:totp:${A}:pendente`);
  });

  it('linha de outro usuário, estado trocado, mestra de outra versão, mestra errada, adulterado: recusa', () => {
    const c = cifrarSegredoTotp(mestra, A, 'ativo', gerarSegredoTotp());
    expect(() => decifrarSegredoTotp(mestra, B, 'ativo', c)).toThrow(ErroChave);
    expect(() => decifrarSegredoTotp(mestra, A, 'pendente', c)).toThrow(ErroChave);
    expect(() => decifrarSegredoTotp({ chave: mestra.chave, versao: 3 }, A, 'ativo', c)).toThrow(/mestra v2, mas o ambiente tem a v3/);
    expect(() => decifrarSegredoTotp({ chave: randomBytes(32), versao: 2 }, A, 'ativo', c)).toThrow(/não autenticou/);
    const adulterado = Buffer.from(c.cifrado);
    adulterado[20] = adulterado[20]! ^ 1;
    expect(() => decifrarSegredoTotp(mestra, A, 'ativo', { cifrado: adulterado, mestraVersao: 2 })).toThrow(ErroChave);
    expect(() => decifrarSegredoTotp(mestra, A, 'ativo', { cifrado: c.cifrado.subarray(1), mestraVersao: 2 })).toThrow(/tamanho/);
    expect(() => cifrarSegredoTotp(mestra, A, 'ativo', Buffer.alloc(19))).toThrow(/20 bytes/);
  });

  it('primitiva genérica: AAD diferente não abre; a mensagem de erro não leva a AAD', () => {
    const c = cifrarComAad(mestra, 'portaria:teste:1', Buffer.from('claro'));
    expect(decifrarComAad(mestra, 'portaria:teste:1', c).toString()).toBe('claro');
    try { decifrarComAad(mestra, 'portaria:teste:2', c); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(ErroChave);
      expect((e as Error).message).not.toContain('portaria:teste');
    }
  });
});

describe('não regressão: embrulhar/desembrulhar das chaves de condomínio', () => {
  // Gerado com o chave-mestra.ts ANTERIOR à primitiva genérica (2026-11-01, antes do C2): a saída não pode mudar.
  const mestra = { chave: Buffer.alloc(32, 0x21), versao: 3 };
  const id = { condominioId: '11111111-2222-4333-8444-555555555555', tipo: 'kek_documentos' as const, versao: 2 };
  const claro = Buffer.alloc(32, 0x42);
  const ANTIGO = {
    chaveCifrada: Buffer.from('f1e8e8a99cbb8eb6efbb4e53bfb2adac7ba177dc0b3d175d546edd7bc06b570842fecd6ba8753b3dfd6e72e70cbd23c9', 'hex'),
    nonce: Buffer.from('1db2607ce66c2a47d6c2e688', 'hex'),
    mestraVersao: 3,
  };

  it('embrulho gerado antes da refatoração continua abrindo', () => {
    expect(desembrulhar(mestra, id, ANTIGO).equals(claro)).toBe(true);
  });

  it('embrulho novo tem o formato de sempre (cifrado || tag, nonce à parte) e abre pelo algoritmo antigo, escrito à parte', () => {
    const e = embrulhar(mestra, id, claro);
    expect([e.chaveCifrada.length, e.nonce.length, e.mestraVersao]).toEqual([48, 12, 3]);
    const d = createDecipheriv('aes-256-gcm', mestra.chave, e.nonce, { authTagLength: 16 });
    d.setAAD(Buffer.from(`portaria:chave:${id.condominioId}:${id.tipo}:v${id.versao}`, 'utf8'));
    d.setAuthTag(e.chaveCifrada.subarray(32));
    expect(Buffer.concat([d.update(e.chaveCifrada.subarray(0, 32)), d.final()]).equals(claro)).toBe(true);
  });

  it('mensagens de erro de sempre', () => {
    expect(() => desembrulhar({ chave: mestra.chave, versao: 4 }, id, ANTIGO)).toThrow('chave embrulhada com a mestra v3, mas o ambiente tem a v4');
    expect(() => desembrulhar(mestra, { ...id, versao: 1 }, ANTIGO)).toThrow('embrulho de kek_documentos v1 não autenticou (chave mestra errada ou linha adulterada)');
    expect(() => desembrulhar(mestra, id, { ...ANTIGO, nonce: Buffer.alloc(11) })).toThrow('embrulho com tamanho inválido');
    expect(() => embrulhar(mestra, id, Buffer.alloc(20))).toThrow('chave do condomínio deve ter de 32 a 128 bytes');
  });
});

describe('códigos de recuperação', () => {
  it('10 códigos XXXX-XXXX-XXXX-XXXX distintos; só o hash rotulado (64 hex); o hash não contém o código', () => {
    const { codigos, hashes } = gerarCodigosRecuperacao();
    expect(codigos).toHaveLength(CODIGOS_POR_GERACAO);
    expect(new Set(codigos).size).toBe(10);
    for (const [i, c] of codigos.entries()) {
      expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      expect(hashes[i]).toMatch(/^[0-9a-f]{64}$/);
      expect(hashCodigoRecuperacao(normalizarCodigoRecuperacao(c)!)).toBe(hashes[i]);
    }
  });

  it('normalização: caixa, hífens e espaços não importam; formato errado = null', () => {
    expect(normalizarCodigoRecuperacao(' abcd-efgh ijkl-mn23 ')).toBe('ABCDEFGHIJKLMN23');
    for (const x of ['ABCD-EFGH-IJKL-MN2', 'ABCD-EFGH-IJKL-MN231', 'ABCD-EFGH-IJKL-MN21', '']) expect(normalizarCodigoRecuperacao(x), x).toBeNull();
  });
});
