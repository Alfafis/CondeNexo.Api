// Funcionários do condomínio (RF-09): pessoa (mesmas regras de CPF e telefone) + função, escala e ativo. Escala que atravessa a meia-noite (22:00–06:00) vale no dia do início do turno
// (`escalaVigente` do domain; o CHECK funcionario_escala_ck só barra início = fim).
// Leitura (lista e ficha): funcionario.ver — síndico, administração e auditor; o porteiro NÃO vê a lista (ver spec §14,
// decisão nº 29). A entrada por escala é validada pela própria API (eventos.service). Para a tela de entrada, a
// portaria lê só a escala da pessoa sendo registrada (GET /funcionarios/:id/escala, sem dados da pessoa).
// Escrita: funcionario.gerenciar (SI, AD).
import { Inject, Injectable } from '@nestjs/common';
import { escalaVigente, validarEscala } from '../dominio/rules';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { codigoPg, erroApi } from '../comum/erros';
import { codificarCursor, decodificarCursor, Pagina } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db, type Executor } from '../database/database.module';
import { funcionario, pessoa } from '../db/schema';
import { colunasPessoa, paraPessoaApi, type LinhaPessoa } from '../pessoas/pessoa-view';
import { PessoasService } from '../pessoas/pessoas.service';
import { NovoFuncionarioDto, EdicaoFuncionarioDto, CursorFuncionarios } from './funcionarios.schemas';
import type { Escala, FuncionarioApi } from './funcionarios.types';

const colunasFuncionario = {
  pessoaId: funcionario.pessoaId, funcao: funcionario.funcao, diasSemana: funcionario.diasSemana,
  horaInicio: funcionario.horaInicio, horaFim: funcionario.horaFim, ativo: funcionario.ativo,
};
type LinhaFuncionario = { pessoaId: string; funcao: string; diasSemana: number[]; horaInicio: string; horaFim: string; ativo: boolean };

/** Escala normalizada (dias ordenados) ou 422 com a mensagem do domain. */
function escalaValida(e: Escala): Escala {
  const erro = validarEscala(e);
  if (erro) throw erroApi(422, 'ESCALA_INVALIDA', erro);
  return { diasSemana: [...e.diasSemana].sort((a, b) => a - b), horaInicio: e.horaInicio, horaFim: e.horaFim };
}

@Injectable()
export class FuncionariosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(PessoasService) private readonly pessoas: PessoasService,
  ) {}

  private view(f: LinhaFuncionario, p: LinhaPessoa): FuncionarioApi {
    const escala = { diasSemana: f.diasSemana, horaInicio: f.horaInicio.slice(0, 5), horaFim: f.horaFim.slice(0, 5) };
    return {
      pessoaId: f.pessoaId, funcao: f.funcao, escala, ativo: f.ativo, pessoa: paraPessoaApi(p),
      emEscalaAgora: escalaVigente({ pessoaId: f.pessoaId, funcao: f.funcao, escala, ativo: f.ativo }, this.relogio.agora().getTime()),
    };
  }

  private async carregar(exec: Executor, pessoaId: string): Promise<FuncionarioApi> {
    const [l] = await exec.select({ f: colunasFuncionario, p: colunasPessoa }).from(funcionario)
      .innerJoin(pessoa, eq(pessoa.id, funcionario.pessoaId)).where(eq(funcionario.pessoaId, pessoaId));
    if (!l) throw erroApi(404, 'FUNCIONARIO_NAO_ENCONTRADO', 'Funcionário não encontrado.');
    return this.view(l.f, l.p);
  }

  obter(pessoaId: string) { return this.carregar(this.db, pessoaId); }

  async listar(f: { limite: number; cursor?: string }) {
    const depois = f.cursor ? decodificarCursor(f.cursor, CursorFuncionarios) : null;
    const filtros: SQL[] = [];
    if (depois) filtros.push(sql`(${pessoa.nome}, ${pessoa.id}) > (${depois.n}, ${depois.id}::uuid)`);
    const linhas = await this.db.select({ f: colunasFuncionario, p: colunasPessoa }).from(funcionario)
      .innerJoin(pessoa, eq(pessoa.id, funcionario.pessoaId))
      .where(filtros.length ? and(...filtros) : undefined)
      .orderBy(asc(pessoa.nome), asc(pessoa.id)).limit(f.limite + 1);
    const pagina = linhas.slice(0, f.limite);
    const ultimo = pagina[pagina.length - 1];
    const proximo = linhas.length > f.limite && ultimo ? codificarCursor({ n: ultimo.p.nome, id: ultimo.p.id }) : null;
    return new Pagina(pagina.map((l) => this.view(l.f, l.p)), proximo);
  }

  async criar(ctx: Contexto, i: z.infer<typeof NovoFuncionarioDto>): Promise<FuncionarioApi> {
    const funcao = i.funcao.trim();
    if (!funcao) throw erroApi(422, 'FUNCAO_OBRIGATORIA', 'Informe a função.');
    const escala = escalaValida(i.escala);
    const agora = this.relogio.agora();
    try {
      return await this.db.transaction(async (tx) => {
        const valores = await this.pessoas.valoresNovaPessoa(tx, { nome: i.nome, documento: i.documento, telefone: i.telefone, categoria: 'funcionario' }, agora, ctx.ator);
        const [p] = await tx.insert(pessoa).values(valores).returning(colunasPessoa);
        const [f] = await tx.insert(funcionario).values({
          pessoaId: p!.id, funcao, diasSemana: escala.diasSemana, horaInicio: escala.horaInicio, horaFim: escala.horaFim,
          ativo: i.ativo ?? true, criadoEm: agora, atualizadoEm: agora,
        }).returning(colunasFuncionario);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'pessoa.criar', entidade: 'pessoa', registroId: p!.id, depois: p });
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'funcionario.criar', entidade: 'funcionario', registroId: p!.id, depois: f });
        return this.view(f!, p!);
      });
    } catch (e) {
      if (codigoPg(e) === '23505') throw erroApi(409, 'PESSOA_DUPLICADA', 'Já existe cadastro com este CPF.');
      throw e;
    }
  }

  async editar(ctx: Contexto, pessoaId: string, i: z.infer<typeof EdicaoFuncionarioDto>): Promise<FuncionarioApi> {
    const agora = this.relogio.agora();
    return this.db.transaction(async (tx) => {
      const [antes] = await tx.select(colunasFuncionario).from(funcionario).where(eq(funcionario.pessoaId, pessoaId)).for('update');
      if (!antes) throw erroApi(404, 'FUNCIONARIO_NAO_ENCONTRADO', 'Funcionário não encontrado.');
      const mudancas: Partial<typeof funcionario.$inferInsert> = {};
      if (i.funcao !== undefined) {
        const funcao = i.funcao.trim();
        if (!funcao) throw erroApi(422, 'FUNCAO_OBRIGATORIA', 'Informe a função.');
        if (funcao !== antes.funcao) mudancas.funcao = funcao;
      }
      if (i.escala !== undefined) {
        const e = escalaValida(i.escala);
        const igual = e.diasSemana.join() === antes.diasSemana.join() && e.horaInicio === antes.horaInicio.slice(0, 5) && e.horaFim === antes.horaFim.slice(0, 5);
        if (!igual) Object.assign(mudancas, { diasSemana: e.diasSemana, horaInicio: e.horaInicio, horaFim: e.horaFim });
      }
      if (i.ativo !== undefined && i.ativo !== antes.ativo) mudancas.ativo = i.ativo;
      if (Object.keys(mudancas).length) {
        const [depois] = await tx.update(funcionario).set({ ...mudancas, atualizadoEm: agora }).where(eq(funcionario.pessoaId, pessoaId)).returning(colunasFuncionario);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'funcionario.editar', entidade: 'funcionario', registroId: pessoaId, antes, depois });
      }
      return this.carregar(tx, pessoaId);
    });
  }
}
