// Módulos por condomínio (docs/05_arquitetura_saas.md, "Módulos por condomínio", 2026-10-22). Fonte única da lista para a
// plataforma (coluna `condominio.modulos`, CHECK e default da migração drizzle-plataforma/0002), para a API (recusa de
// rota de módulo desligado, fase posterior) e para os fronts (menu do condomínio, tela de licenças do Master).
//
// Só o que é opcional por contrato entra aqui. O núcleo da portaria nunca desliga: autenticação, usuários, unidades,
// pessoas, vínculos, eventos de acesso, restrições (RF-16: a portaria confere restrição em toda entrada), trilha,
// selo e LGPD (obrigação legal do controlador).
//
// Mudar esta lista exige migração da plataforma (o CHECK e o default repetem os valores; o teste
// test/saas-provisionar.test.ts confere a migração contra esta lista). Módulo novo nasce DESLIGADO nos condomínios
// existentes, a menos que a migração diga o contrário (decisão comercial, não técnica).

import type { Rota } from './rbac';

export const MODULOS = [
  'encomendas',
  'ocorrencias',
  'autorizacoes_previas',
  'importacao',
  'veiculos',
  'funcionarios',
  'relatorios',
] as const;

export type Modulo = (typeof MODULOS)[number];

/** Rótulo exibido (tela de licenças do Master, aviso de módulo desligado). */
export const ROTULO_MODULO: Record<Modulo, string> = {
  encomendas: 'Encomendas',
  ocorrencias: 'Ocorrências',
  autorizacoes_previas: 'Autorizações prévias',
  importacao: 'Importação de planilha',
  veiculos: 'Veículos',
  funcionarios: 'Funcionários',
  relatorios: 'Relatórios',
};

/** Padrão de um condomínio novo: todos os módulos existentes ligados. */
export const MODULOS_PADRAO: readonly Modulo[] = MODULOS;

export const ehModulo = (m: string): m is Modulo => (MODULOS as readonly string[]).includes(m);

/**
 * Tela do condomínio que pertence a um módulo (menu, rota e atalho somem com o módulo desligado). As outras telas são
 * do núcleo. A API recusa as rotas do módulo com 403 MODULO_DESLIGADO (ModuloGuard); o front só esconde.
 */
export const MODULO_DA_ROTA: Partial<Record<Rota, Modulo>> = {
  encomendas: 'encomendas',
  ocorrencias: 'ocorrencias',
  importar: 'importacao',
  relatorios: 'relatorios',
  funcionarios: 'funcionarios',
};

/**
 * O módulo está ligado? `modulos` ausente (API anterior à F5 entrega 2, que não manda a lista) vale como todos ligados:
 * o front não esconde nada que a API ainda não recusa.
 */
export const moduloLigado = (modulos: readonly string[] | null | undefined, m: Modulo): boolean => !modulos || modulos.includes(m);

/** A rota está disponível com estes módulos (rota do núcleo: sempre). */
export const rotaComModulo = (modulos: readonly string[] | null | undefined, rota: Rota): boolean => {
  const m = MODULO_DA_ROTA[rota];
  return !m || moduloLigado(modulos, m);
};
