import type { Papel } from '../dominio/types';
import type { Ator } from '../auditoria/auditoria.service';

export interface UsuarioAutenticado extends Ator {
  login: string;
  papel: Papel;
  deveTrocarSenha: boolean;
}

/** Preenchido pelo SessaoGuard em `req.auth` (só em rota não pública com sessão válida). */
export interface AuthDaRequisicao {
  sessaoId: string;
  usuario: UsuarioAutenticado;
  /** Fim efetivo da sessão (o gravado, limitado pelo prazo do tipo de uso com o papel atual). */
  expiraEm: Date;
  /** Prazo de inatividade desta sessão, em minutos (padrão ou longa). */
  inatividadeMin: number;
}

/** Contexto passado EXPLICITAMENTE aos serviços (sem AsyncLocalStorage: nada vaza entre requisições). */
export interface Contexto {
  ator: UsuarioAutenticado;
  sessaoId: string;
  ip: string | null;
}
