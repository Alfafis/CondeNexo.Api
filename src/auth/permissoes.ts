// Permissões efetivas do usuário logado, devolvidas por login, /auth/me e trocar-senha para o front SÓ consultar: o front
// não tem matriz nem lista de módulos por rota. Quem decide continua sendo a API (guards com `pode()` da MATRIZ e
// ModuloGuard); isto é a mesma decisão, exposta como dado, para a tela esconder o que vai ser recusado.
import { MATRIZ, ROTAS, rotaInicial, type Acao, type Rota } from '../dominio/rbac';
import { rotaComModulo } from '../dominio/modulos';
import { ACOES_PLATAFORMA, MATRIZ_PLATAFORMA, type AcaoPlataforma, type PapelPlataforma } from '../dominio/rbac-plataforma';
import type { Papel } from '../dominio/types';

export interface PermissoesSessao {
  /** Ações da MATRIZ que o papel pode (a guarda de módulo é à parte: ver `rotas` e `modulos`). */
  acoes: Acao[];
  /** Telas disponíveis: papel (ROTAS) E módulo ligado no condomínio (MODULO_DA_ROTA). */
  rotas: Rota[];
  /** Tela de entrada do perfil (sempre do núcleo, nunca de módulo). */
  rotaInicial: Rota;
}

export function permissoesDe(papel: Papel, modulos: readonly string[] | null | undefined): PermissoesSessao {
  const acoes = (Object.keys(MATRIZ) as Acao[]).filter((a) => MATRIZ[a].includes(papel));
  const rotas = (Object.keys(ROTAS) as Rota[]).filter((r) => ROTAS[r].includes(papel) && rotaComModulo(modulos, r));
  return { acoes, rotas, rotaInicial: rotaInicial(papel) };
}

/** Ações da MATRIZ_PLATAFORMA que o papel do Master/suporte pode. */
export const permissoesPlataformaDe = (papel: PapelPlataforma): AcaoPlataforma[] =>
  ACOES_PLATAFORMA.filter((a) => (MATRIZ_PLATAFORMA[a] as readonly string[]).includes(papel));
