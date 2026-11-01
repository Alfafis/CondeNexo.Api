// Matriz de permissões da PLATAFORMA (docs/05_arquitetura_saas.md SAAS-07): o Master não é papel de condomínio e esta
// matriz não se mistura com MATRIZ (rbac.ts). Fonte única para a API (guarda das rotas /plataforma) e para o front do
// Master (esconder o que o papel não pode).

export const PAPEIS_PLATAFORMA = ['master', 'suporte'] as const;
export type PapelPlataforma = (typeof PAPEIS_PLATAFORMA)[number];

/**
 * Tamanho mínimo da senha do usuário da plataforma na troca (a do condomínio é 12, em src/auth/senha.service.ts). Maior de
 * propósito: é a conta que alcança todos os condomínios, e o 2º fator ainda é opcional (sub-projeto C2, fase A1).
 * A API valida (fonte de verdade); o app do Master usa para avisar antes de enviar.
 */
export const SENHA_MIN_MASTER = 16;

export const ACOES_PLATAFORMA = ['condominio.listar', 'condominio.criar', 'condominio.modulos', 'condominio.ler', 'condominio.sindicos'] as const;
export type AcaoPlataforma = (typeof ACOES_PLATAFORMA)[number];

/**
 * `suporte` (funcionário do operador) só consulta o cadastro; criar condomínio e mudar módulo é do `master`.
 * `condominio.ler` (SAAS-09, revista na Fase B em 2026-11-01): ler os dados de um condomínio (o que o síndico vê,
 * minimizado), sem motivo e sem trilha, e o "Revelar" de um registro (valor completo, registrado em plataforma_audit).
 * Só `master`: o contrato com o condomínio lista nominalmente quem tem esse papel.
 * `condominio.sindicos` (§5.5): adicionar, trocar, desativar/reativar síndico e gerar nova senha temporária dele, a ÚNICA
 * escrita do Master em dado de condomínio; sempre com motivo, a senha do Master de novo e a trilha do condomínio. Só `master`.
 */
export const MATRIZ_PLATAFORMA: Record<AcaoPlataforma, readonly PapelPlataforma[]> = {
  'condominio.listar': ['master', 'suporte'],
  'condominio.criar': ['master'],
  'condominio.modulos': ['master'],
  'condominio.ler': ['master'],
  'condominio.sindicos': ['master'],
};

export const podePlataforma = (papel: string, acao: AcaoPlataforma): boolean =>
  (MATRIZ_PLATAFORMA[acao] as readonly string[]).includes(papel);
