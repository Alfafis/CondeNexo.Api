import type { PapelPlataforma } from '../dominio/rbac-plataforma';

/** Visão pública do usuário da plataforma (sem hash). */
export interface UsuarioPlataforma {
  id: string;
  nome: string;
  email: string;
  papel: PapelPlataforma;
  deveTrocarSenha: boolean;
}

/** `segundoFator` das respostas com usuário (GET /me, login, confirmar). Nunca o segredo. */
export interface SegundoFatorStatus {
  ativo: boolean;
  ativadoEm: Date | null;
  /** Códigos de recuperação ainda não usados da geração atual (0 sem fator ativo). */
  codigosRestantes: number;
  /** Fase A1: sempre false (nada exige o 2º fator). */
  obrigatorio: boolean;
}

/** Preenchido pela PlataformaGuard em `req.master` (rota /plataforma não pública com sessão válida). */
export interface AuthMaster {
  sessaoId: string;
  expiraEm: Date;
  usuario: UsuarioPlataforma;
  ip: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    master?: AuthMaster;
  }
}
