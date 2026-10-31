// Gestão de síndicos pelo app do Master (docs/05_arquitetura_saas.md §5.5): a ÚNICA escrita do Master em dado de
// condomínio, e só sobre usuários de papel `sindico`. Toda rota passa pelo ponto único (AcessoPlataformaService
// .alterarSindico), que reautentica o Master, confere a situação do condomínio e grava a trilha do condomínio e a da
// plataforma junto com a mudança. A lista dos síndicos é uma leitura auditada (`plataforma.ler`) no controller de leitura.
//
// O corpo leva `motivo` (15+ caracteres, o critério JUST do schema) e `senhaMaster` (verificada, nunca gravada). A senha
// do síndico é SEMPRE gerada pela API e temporária (72 h, troca obrigatória): não há campo para o Master defini-la.
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { LOGIN_SINDICO } from '../dominio/condominio';
import { MIN_JUSTIFICATIVA } from '../dominio/rules';
import type { Request } from 'express';
import { z } from 'zod';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { AcessoPlataformaService } from './acesso-plataforma.service';
import { Master, PlataformaAcao } from './decorators';
import type { AuthMaster } from './tipos';

const protecao = {
  motivo: z.string().trim()
    .min(MIN_JUSTIFICATIVA, `Escreva o motivo com pelo menos ${MIN_JUSTIFICATIVA} caracteres (ex.: o número do chamado e o pedido).`)
    .max(500, 'O motivo tem no máximo 500 caracteres.'),
  senhaMaster: z.string().min(1, 'Digite a sua senha para confirmar.').max(200, 'Senha longa demais.'),
};

/** Mesmas regras do síndico do provisionamento (plataforma/provisionar.ts). */
const NovoSindicoDto = z.strictObject({
  nome: z.string().trim().min(3, 'O nome tem pelo menos 3 caracteres.').max(120, 'O nome tem no máximo 120 caracteres.'),
  login: z.string().trim().toLowerCase().regex(LOGIN_SINDICO, 'Login: 3 a 40 caracteres, começando por letra (a-z, 0-9, ".", "-", "_").'),
  ...protecao,
});
const ProtecaoDto = z.strictObject(protecao);

type NovoSindico = z.infer<typeof NovoSindicoDto>;
type Protecao = z.infer<typeof ProtecaoDto>;

@Controller('plataforma/condominios/:id/sindicos')
@PlataformaAcao('condominio.sindicos')
export class SindicosMasterController {
  constructor(@Inject(AcessoPlataformaService) private readonly acesso: AcessoPlataformaService) {}

  /** Adicionar síndico: senha temporária na resposta, uma vez. */
  @Post()
  @HttpCode(201)
  adicionar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Body(new ZodPipe(NovoSindicoDto)) b: NovoSindico) {
    return this.acesso.alterarSindico(m, req, id, b, { tipo: 'criar', nome: b.nome, login: b.login });
  }

  /** Trocar: cria o novo e desativa o antigo (sessões revogadas) na mesma transação. */
  @Post(':usuarioId/trocar')
  @HttpCode(201)
  trocar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('usuarioId', uuidParam) usuarioId: string,
    @Body(new ZodPipe(NovoSindicoDto)) b: NovoSindico) {
    return this.acesso.alterarSindico(m, req, id, b, { tipo: 'trocar', id: usuarioId, nome: b.nome, login: b.login });
  }

  /** Nova senha temporária (72 h, troca obrigatória, sessões revogadas). Desativado: recusado. */
  @Post(':usuarioId/redefinir-senha')
  @HttpCode(200)
  redefinirSenha(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('usuarioId', uuidParam) usuarioId: string,
    @Body(new ZodPipe(ProtecaoDto)) b: Protecao) {
    return this.acesso.alterarSindico(m, req, id, b, { tipo: 'redefinir_senha', id: usuarioId });
  }

  /** Desativar (sessões revogadas). O último síndico ativo não sai por aqui: use "trocar". */
  @Post(':usuarioId/desativar')
  @HttpCode(200)
  desativar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('usuarioId', uuidParam) usuarioId: string,
    @Body(new ZodPipe(ProtecaoDto)) b: Protecao) {
    return this.acesso.alterarSindico(m, req, id, b, { tipo: 'desativar', id: usuarioId });
  }

  @Post(':usuarioId/reativar')
  @HttpCode(200)
  reativar(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('usuarioId', uuidParam) usuarioId: string,
    @Body(new ZodPipe(ProtecaoDto)) b: Protecao) {
    return this.acesso.alterarSindico(m, req, id, b, { tipo: 'reativar', id: usuarioId });
  }
}
