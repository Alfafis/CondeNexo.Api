// Pessoas (spec §6.2, RF-02, RF-18, RF-34): busca, busca global, cadastro, correção, listagem, ficha e desativação.
// Busca por POST com o termo no CORPO: o termo pode ser um CPF, e a URL (query string) fica registrada em proxies e na
// borda da Vercel, fora do controle do log da API. Pelo mesmo motivo a listagem não aceita filtro de texto.
import { Body, Controller, Get, HttpCode, Inject, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { PaginacaoDto } from '../comum/pagina';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { categoriaPessoa } from '../db/schema';
import { BuscaService } from './busca.service';
import { veRestricao } from './pessoa-view';
import { PessoasService } from './pessoas.service';

const Termo = z.string().max(100);
const BuscaPessoasDto = z.strictObject({
  q: Termo,
  /** Padrão 8. A portaria pede 8 e usa `temMais` para avisar que há mais resultados. */
  limite: z.number().int().min(1).max(50).default(8),
  semMoradores: z.boolean().default(false),
  /** Tela Cadastro, "mostrar desativados". A portaria e os seletores nunca mandam: desativado não aparece. */
  incluirDesativadas: z.boolean().default(false),
});
const BuscaGlobalDto = z.strictObject({ q: Termo });

/** Só o tipo e o tamanho; as regras (CPF, telefone, empresa) ficam no serviço e respondem 422. */
const Texto = (max: number) => z.string().max(max);
const NovaPessoaDto = z.strictObject({
  nome: Texto(150),
  documento: Texto(20).optional(),
  /** Obrigatório, salvo dependente menor de idade (`menorIdade`); a regra fica no serviço (422). */
  telefone: Texto(20).optional(),
  categoria: z.enum(categoriaPessoa.enumValues),
  empresa: Texto(150).optional(),
  servico: Texto(150).optional(),
  semCpf: z.boolean().optional(),
  /** Dependente menor de idade (LGPD art. 14): CPF e telefone opcionais. Só morador. */
  menorIdade: z.boolean().optional(),
});
const EdicaoPessoaDto = z.strictObject({
  nome: Texto(150).optional(),
  telefone: Texto(20).optional(),
  documento: Texto(20).optional(),
  empresa: Texto(150).nullable().optional(),
  servico: Texto(150).nullable().optional(),
  /** false: deixou de ser menor (exige CPF e telefone); true: só morador, não "sem CPF". */
  menorIdade: z.boolean().optional(),
});
export const ListarPessoasDto = PaginacaoDto.extend({
  categoria: z.enum(categoriaPessoa.enumValues).optional(),
  incluirDesativadas: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
/** O mínimo (MIN_JUSTIFICATIVA) é regra do domain, checada no serviço (422 MOTIVO_OBRIGATORIO); aqui só tipo e teto. */
const DesativarPessoaDto = z.strictObject({ motivo: Texto(500) });

@Controller()
export class PessoasController {
  constructor(
    @Inject(BuscaService) private readonly busca: BuscaService,
    @Inject(PessoasService) private readonly pessoas: PessoasService,
  ) {}

  /** `{ pessoas, temMais }`; cada pessoa com `restricao` (selo, sem motivo) só para quem vê restrições. */
  @Post('pessoas/busca')
  @Acao('pessoa.ver')
  @HttpCode(200)
  buscar(@Ctx() ctx: Contexto, @Body(new ZodPipe(BuscaPessoasDto)) b: z.infer<typeof BuscaPessoasDto>) {
    return this.busca.pessoas(b.q, {
      limite: b.limite, semMoradores: b.semMoradores, incluirDesativadas: b.incluirDesativadas, restricao: veRestricao(ctx.ator.papel),
    });
  }

  /** Busca do topo: `{ pessoas, unidades: [{ id, motivo }], temMaisPessoas }`. */
  @Post('busca')
  @Acao('pessoa.ver')
  @HttpCode(200)
  global(@Body(new ZodPipe(BuscaGlobalDto)) b: z.infer<typeof BuscaGlobalDto>) {
    return this.busca.global(b.q);
  }

  @Get('pessoas')
  @Acao('pessoa.ver')
  listar(@Ctx() ctx: Contexto, @Query(new ZodPipe(ListarPessoasDto)) q: z.infer<typeof ListarPessoasDto>) {
    return this.pessoas.listar(ctx.ator.papel, q);
  }

  @Get('pessoas/:id')
  @Acao('pessoa.ver')
  ficha(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.pessoas.ficha(ctx.ator.papel, id);
  }

  /** pessoa.cadastrar_externo (SI, AD, PO); morador e funcionário exigem também pessoa.cadastrar_morador (no serviço). */
  @Post('pessoas')
  @Acao('pessoa.cadastrar_externo')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovaPessoaDto)) b: z.infer<typeof NovaPessoaDto>) {
    return this.pessoas.criar(ctx, b);
  }

  @Patch('pessoas/:id')
  @Acao('pessoa.editar')
  editar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(EdicaoPessoaDto)) b: z.infer<typeof EdicaoPessoaDto>) {
    return this.pessoas.editar(ctx, id, b);
  }

  /** RF-02: desativar (não exclui). Resposta: a pessoa e `autorizacoesRevogadas` (quantas foram revogadas junto). */
  @Post('pessoas/:id/desativar')
  @Acao('pessoa.desativar')
  @HttpCode(200)
  desativar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(DesativarPessoaDto)) b: z.infer<typeof DesativarPessoaDto>) {
    return this.pessoas.desativar(ctx, id, b.motivo);
  }

  @Post('pessoas/:id/reativar')
  @Acao('pessoa.desativar')
  @HttpCode(200)
  reativar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string) {
    return this.pessoas.reativar(ctx, id);
  }
}

@Module({ controllers: [PessoasController], providers: [BuscaService, PessoasService], exports: [BuscaService, PessoasService] })
export class PessoasModule {}
