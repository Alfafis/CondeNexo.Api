// Laço de migração por banco (SaaS, SAAS-16; scripts/migrar-bancos.mjs): qual banco entra, em que ordem, e o
// que é recusado. A execução de verdade (drizzle-kit em N bancos) roda no CI do Postgres real.
import { describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sem declaração de tipos (roda na imagem `migrate`, fora do tsc)
import { bancosParaMigrar, urlDoBanco } from '../scripts/migrar-bancos.mjs';

const existentes = ['postgres', 'portaria', 'plataforma', 'portaria_aaaa1111', 'portaria_bbbb2222', 'portaria_cccc3333'];

describe('migrar-bancos: lista de bancos de condomínio', () => {
  it('piloto primeiro (mesmo antes de registrado), depois ativos, suspensos e encerrados em ordem; sem repetir', () => {
    expect(bancosParaMigrar([], existentes)).toEqual(['portaria']);
    expect(bancosParaMigrar([
      { banco: 'portaria_cccc3333', status: 'encerrado' }, { banco: 'portaria', status: 'ativo' },
      { banco: 'portaria_bbbb2222', status: 'suspenso' }, { banco: 'portaria_aaaa1111', status: 'ativo' },
    ], existentes)).toEqual(['portaria', 'portaria_aaaa1111', 'portaria_bbbb2222', 'portaria_cccc3333']);
  });

  it('provisionando (a CLI de onboarding migra) e excluido (sem banco) ficam de fora', () => {
    expect(bancosParaMigrar([{ banco: 'portaria_aaaa1111', status: 'provisionando' }, { banco: 'portaria_zzzz9999', status: 'excluido' }], existentes))
      .toEqual(['portaria']);
  });

  it('recusa nome fora do formato e banco atendido que não existe no cluster (para tudo, não pula)', () => {
    expect(() => bancosParaMigrar([{ banco: 'postgres', status: 'ativo' }], existentes)).toThrow(/fora do formato/);
    expect(() => bancosParaMigrar([{ banco: 'portaria_dddd4444', status: 'ativo' }], existentes)).toThrow(/não existe no cluster/);
  });

  it('URL: só troca o nome do banco', () => {
    expect(urlDoBanco('postgres://app_migrator:x@db:5432', 'portaria_aaaa1111')).toBe('postgres://app_migrator:x@db:5432/portaria_aaaa1111');
    expect(urlDoBanco('postgres://app_migrator:x@db:5432/portaria', 'plataforma')).toBe('postgres://app_migrator:x@db:5432/plataforma');
  });
});
