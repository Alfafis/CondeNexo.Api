import { describe, expect, it } from 'vitest';
import { ACOES_PLATAFORMA, MATRIZ_PLATAFORMA, podePlataforma } from '../../src/dominio/rbac-plataforma';
import type { Papel } from '../../src/dominio/types';

describe('rbac da plataforma', () => {
  it('master faz tudo; suporte só lista; papel de condomínio nada', () => {
    for (const a of ACOES_PLATAFORMA) expect(podePlataforma('master', a)).toBe(true);
    expect(podePlataforma('suporte', 'condominio.listar')).toBe(true);
    expect(podePlataforma('suporte', 'condominio.criar')).toBe(false);
    expect(podePlataforma('suporte', 'condominio.modulos')).toBe(false);
    expect(podePlataforma('suporte', 'condominio.ler')).toBe(false);
    expect(podePlataforma('suporte', 'condominio.sindicos')).toBe(false);
    const papeisCondominio: Papel[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
    for (const p of papeisCondominio) for (const a of ACOES_PLATAFORMA) expect(podePlataforma(p, a)).toBe(false);
    expect(Object.keys(MATRIZ_PLATAFORMA).sort()).toEqual([...ACOES_PLATAFORMA].sort());
  });
});
