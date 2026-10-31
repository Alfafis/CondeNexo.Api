// Rotas de usuários (spec §6.1: GET/POST/PATCH /usuarios). Respostas com senha temporária saem uma única vez
// (Cache-Control: no-store vale para toda a API, ver main.ts).
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { PaginacaoDto, type Paginacao } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { UsuariosService } from './usuarios.service';

const PAPEIS = ['sindico', 'administracao', 'porteiro', 'auditor'] as const;

const CriarUsuarioDto = z.strictObject({
  nome: z.string().trim().min(3).max(120),
  // RN-05: login individual. Minúsculo, sem espaço; letras, dígitos, ponto, hífen e sublinhado.
  login: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{2,39}$/, 'Login: 3 a 40 caracteres, começando por letra (a-z, 0-9, ".", "-", "_").'),
  papel: z.enum(PAPEIS),
});

const AlterarUsuarioDto = z.strictObject({ papel: z.enum(PAPEIS) });

@Controller('usuarios')
export class UsuariosController {
  constructor(@Inject(UsuariosService) private readonly usuarios: UsuariosService) {}

  @Get()
  @Acao('usuario.gerenciar')
  listar(@Query(new ZodPipe(PaginacaoDto)) p: Paginacao) {
    return this.usuarios.listar(p); // { data: [...], pagination: { cursor, hasNextPage } }
  }

  @Post()
  @Acao('usuario.gerenciar')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(CriarUsuarioDto)) body: z.infer<typeof CriarUsuarioDto>) {
    return this.usuarios.criar(ctx, body);
  }

  @Patch(':id')
  @Acao('usuario.gerenciar')
  alterar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(AlterarUsuarioDto)) body: z.infer<typeof AlterarUsuarioDto>) {
    return this.usuarios.alterarPapel(ctx, id, body.papel);
  }

  @Post(':id/desativar')
  @Acao('usuario.gerenciar')
  @HttpCode(200)
  desativar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.usuarios.desativar(ctx, id);
  }

  @Post(':id/reativar')
  @Acao('usuario.gerenciar')
  @HttpCode(200)
  reativar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.usuarios.reativar(ctx, id);
  }

  @Post(':id/redefinir-senha')
  @Acao('usuario.gerenciar')
  @HttpCode(200)
  redefinirSenha(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.usuarios.redefinirSenha(ctx, id);
  }
}
