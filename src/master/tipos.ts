import type { PapelPlataforma } from '../dominio/rbac-plataforma';

/** Visão pública do usuário da plataforma (sem hash). */
export interface UsuarioPlataforma {
  id: string;
  nome: string;
  email: string;
  papel: PapelPlataforma;
  deveTrocarSenha: boolean;
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
