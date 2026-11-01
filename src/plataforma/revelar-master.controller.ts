// "Revelar" do app do Master (Fase B, 2026-11-01; decisão do dono do produto): a leitura devolve o dado minimizado
// (minimizacao.ts) e esta rota devolve o valor completo dos campos escondidos de UM registro. Uma rota por entidade, POST
// (ação com efeito: consome o limite e grava `condominio.revelar` em plataforma_audit), tudo pelo ponto único
// (AcessoPlataformaService.revelar: limite, situação do condomínio, trilha da plataforma; nada na trilha do condomínio).
// Só os campos que a leitura esconde. CPF: o número não é armazenado, só a máscara existe (vai a mesma do síndico).
import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { uuidParam } from '../comum/zod.pipe';
import { EncomendasService } from '../encomendas/encomendas.service';
import { OcorrenciasService } from '../ocorrencias/ocorrencias.service';
import { PessoasService } from '../pessoas/pessoas.service';
import { VeiculosService } from '../veiculos/veiculos.service';
import { AcessoPlataformaService } from './acesso-plataforma.service';
import { Master, PlataformaAcao } from './decorators';
import type { AuthMaster } from './tipos';

export interface PessoaRevelada {
  id: string;
  nome: string;
  /** Só dígitos, com DDD; null sem telefone (legado, menor de idade, anonimizada). */
  telefone: string | null;
  /** O CPF não é armazenado: a máscara (ou "(sem CPF)", "(anonimizado)"), como na ficha. */
  documentoMascarado: string;
  desativacaoMotivo: string | null;
}
export interface VeiculoRevelado { id: string; placa: string }
export interface OcorrenciaRevelada { id: string; descricao: string; envolvidos: string }
export interface EncomendaRevelada { id: string; destinatario: string; retiradaPorNome: string | null }

@Controller('plataforma/condominios/:id')
@PlataformaAcao('condominio.ler')
export class RevelarMasterController {
  constructor(@Inject(AcessoPlataformaService) private readonly acesso: AcessoPlataformaService) {}

  @Post('pessoas/:pessoaId/revelar')
  @HttpCode(200)
  pessoa(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('pessoaId', uuidParam) pessoaId: string): Promise<PessoaRevelada> {
    return this.acesso.revelar(m, req, id, { entidade: 'pessoa', registroId: pessoaId },
      async (s) => (await s(PessoasService)).paraRevelarNaPlataforma(pessoaId));
  }

  @Post('veiculos/:veiculoId/revelar')
  @HttpCode(200)
  veiculo(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('veiculoId', uuidParam) veiculoId: string): Promise<VeiculoRevelado> {
    return this.acesso.revelar(m, req, id, { entidade: 'veiculo', registroId: veiculoId }, async (s) => {
      const v = await (await s(VeiculosService)).obter(veiculoId);
      return { id: v.id, placa: v.placa };
    });
  }

  @Post('ocorrencias/:ocorrenciaId/revelar')
  @HttpCode(200)
  ocorrencia(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('ocorrenciaId', uuidParam) ocorrenciaId: string): Promise<OcorrenciaRevelada> {
    return this.acesso.revelar(m, req, id, { entidade: 'ocorrencia', registroId: ocorrenciaId }, async (s) => {
      const o = await (await s(OcorrenciasService)).obter(ocorrenciaId);
      return { id: o.id, descricao: o.descricao, envolvidos: o.envolvidos };
    });
  }

  @Post('encomendas/:encomendaId/revelar')
  @HttpCode(200)
  encomenda(@Master() m: AuthMaster, @Req() req: Request, @Param('id', uuidParam) id: string, @Param('encomendaId', uuidParam) encomendaId: string): Promise<EncomendaRevelada> {
    return this.acesso.revelar(m, req, id, { entidade: 'encomenda', registroId: encomendaId }, async (s) => {
      const e = await (await s(EncomendasService)).obter(encomendaId);
      return { id: e.id, destinatario: e.destinatario, retiradaPorNome: e.retiradaPorNome };
    });
  }
}
