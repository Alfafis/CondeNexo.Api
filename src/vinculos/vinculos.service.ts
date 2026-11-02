// Vínculos com a unidade (RF-03 a RF-07, RN-02, RN-03, RN-09). A máquina de estados
// está no banco (trigger vinculo_unidade_transicao: nasce pendente ou legado; pendente -> aprovado | rejeitado;
// aprovado -> encerrado; legado -> aprovado | encerrado; conferência congelada depois da aprovação) e nos CHECKs
// (aprovado exige conferência, inquilino exige fim de vigência...). A API checa ANTES, para responder 409/422 legíveis,
// e ainda traduz o erro do banco (corrida, regra esquecida) sem deixar a mensagem do driver sair (`traduzirErroVinculo`).
// Toda escrita trava a linha do vínculo (FOR UPDATE) e grava o audit_log na mesma transação.
import { Inject, Injectable } from '@nestjs/common';
import { ERRO_PESSOA_DESATIVADA, MIN_JUSTIFICATIVA, validarConferencia, validarDecisaoVinculo } from '../dominio/rules';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { diaBrt, inicioDoDiaBrt } from '../comum/datas';
import { codigoPg, constraintPg, erroApi } from '../comum/erros';
import { codificarCursor, decodificarCursor, Pagina } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db, type Tx } from '../database/database.module';
import { pessoa, statusVinculo, tipoComprovante, tipoVinculo, vinculoUnidade as v } from '../db/schema';
import { cadastroCompletoDe, colunasPessoa, paraPessoaApi } from '../pessoas/pessoa-view';
import { UnidadesService } from '../unidades/unidades.service';
import { carregarVinculos, paraVinculoApi, selecionarVinculos, type VinculoApi } from './vinculo-view';
import { vinculoValidoSql } from './vinculo-valido';

type Status = (typeof statusVinculo.enumValues)[number];
export type Ordem = 'recentes' | 'decisao' | 'prazo';

export interface FiltroVinculos {
  limite: number; cursor?: string; status?: Status[]; unidadeId?: string; pessoaId?: string; ordem: Ordem;
}

/**
 * Erro do banco num vínculo -> 409/422 legível. Nunca repassa a mensagem do driver (ela cita ids e valores).
 * - trigger de transição (check_violation sem constraint): o vínculo mudou de estado no meio;
 * - CHECKs conhecidos: a regra correspondente;
 * - índice vinculo_ativo_uq: já existe vínculo ativo ou pendente da pessoa na unidade.
 */
export function traduzirErroVinculo(e: unknown): unknown {
  const pg = codigoPg(e);
  if (!pg) return e;
  const c = constraintPg(e);
  if (pg === '23505') return erroApi(409, 'VINCULO_DUPLICADO', 'Já existe vínculo ativo ou pendente desta pessoa com a unidade.');
  if (pg !== '23514') return e;
  switch (c) {
    case 'vinculo_aprovado_conferido_ck': return erroApi(422, 'CONFERENCIA_OBRIGATORIA', 'Registre a conferência do comprovante (RF-05) antes de aprovar o vínculo.');
    case 'vinculo_inquilino_fim_ck': return erroApi(422, 'VIGENCIA_OBRIGATORIA', 'Inquilino exige data de fim da vigência.');
    case 'vinculo_vigencia_ck': return erroApi(422, 'VIGENCIA_INVALIDA', 'O fim da vigência não pode ser anterior ao início.');
    case 'vinculo_conferencia_sem_numero_ck': return erroApi(422, 'DADO_PESSOAL_NA_CONFERENCIA', 'Não escreva CPF, telefone ou outro número pessoal na conferência.');
    case 'vinculo_conferencia_descricao_ck': return erroApi(422, 'DESCRICAO_OBRIGATORIA', 'Descreva o comprovante (até 80 caracteres) só quando o tipo for “Outro”.');
    case 'vinculo_conferencia_observacao_ck': return erroApi(422, 'OBSERVACAO_LONGA', 'A observação tem no máximo 200 caracteres.');
    case 'vinculo_rejeicao_justificada_ck': return erroApi(422, 'JUSTIFICATIVA_OBRIGATORIA', 'Rejeitar um vínculo exige justificativa.');
    case undefined: return erroApi(409, 'TRANSICAO_INVALIDA', 'O vínculo não permite esta operação no estado atual. Atualize a tela e tente de novo.');
    default: return erroApi(422, 'REGRA_VIOLADA', 'Os dados violam uma regra do vínculo.');
  }
}

const ROTULO_STATUS: Record<Status, string> = { pendente: 'pendente', aprovado: 'aprovado', rejeitado: 'rejeitado', legado: 'legado', encerrado: 'encerrado' };

const Cursor = z.discriminatedUnion('o', [
  z.strictObject({ o: z.literal('recentes'), t: z.iso.datetime(), id: z.uuid() }),
  z.strictObject({ o: z.literal('decisao'), t: z.iso.datetime(), id: z.uuid() }),
  // Data de calendário real (2026-02-30 passa na regex e no Date.parse, mas o Postgres recusa e viraria 500).
  z.strictObject({ o: z.literal('prazo'), d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => { const ms = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(d); }, 'data inválida'), id: z.uuid() }),
]);

/** Chave de ordenação "decisão": a decisão, o encerramento ou o registro, o que houver (mais recente primeiro). */
const chaveDecisao = sql`coalesce(${v.decididoEm}, ${v.encerradoEm}, ${v.registradoEm})`;
/** Prazo nulo vai para o fim (sentinela, para o keyset não lidar com NULL). */
const chavePrazo = sql`coalesce(${v.prazoRegularizacao}, '9999-12-31'::date)`;


@Injectable()
export class VinculosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(UnidadesService) private readonly unidades: UnidadesService,
  ) {}

  private hoje() { return diaBrt(this.relogio.agora()); }

  async listar(f: FiltroVinculos): Promise<Pagina<VinculoApi>> {
    const hoje = this.hoje();
    const filtros: SQL[] = [];
    if (f.status?.length) filtros.push(inArray(v.status, f.status));
    if (f.unidadeId) filtros.push(eq(v.unidadeId, f.unidadeId));
    if (f.pessoaId) filtros.push(eq(v.pessoaId, f.pessoaId));
    const c = f.cursor ? decodificarCursor(f.cursor, Cursor) : null;
    if (c && c.o !== f.ordem) throw erroApi(400, 'CURSOR_INVALIDO', 'Cursor de paginação inválido.', [{ field: 'cursor', message: 'cursor de outra ordenação' }]);
    let ordem: SQL[];
    if (f.ordem === 'prazo') {
      if (c?.o === 'prazo') filtros.push(sql`(${chavePrazo}, ${v.id}) > (${c.d}::date, ${c.id}::uuid)`);
      ordem = [asc(chavePrazo), asc(v.id)];
    } else if (f.ordem === 'decisao') {
      if (c?.o === 'decisao') filtros.push(sql`(${chaveDecisao}, ${v.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`);
      ordem = [desc(chaveDecisao), desc(v.id)];
    } else {
      if (c?.o === 'recentes') filtros.push(sql`(${v.registradoEm}, ${v.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`);
      ordem = [desc(v.registradoEm), desc(v.id)];
    }
    const linhas = await selecionarVinculos(this.db).where(filtros.length ? and(...filtros) : undefined).orderBy(...ordem).limit(f.limite + 1);
    const pagina = linhas.slice(0, f.limite);
    const u = pagina[pagina.length - 1]?.v;
    let proximo: string | null = null;
    if (linhas.length > f.limite && u) {
      proximo = codificarCursor(f.ordem === 'prazo' ? { o: 'prazo', d: u.prazoRegularizacao ?? '9999-12-31', id: u.id }
        : f.ordem === 'decisao' ? { o: 'decisao', t: (u.decididoEm ?? u.encerradoEm ?? u.registradoEm).toISOString(), id: u.id }
          : { o: 'recentes', t: u.registradoEm.toISOString(), id: u.id });
    }
    return new Pagina(pagina.map((l) => paraVinculoApi(l, hoje)), proximo);
  }

  async obter(id: string, exec: Db | Tx = this.db): Promise<VinculoApi> {
    const [l] = await selecionarVinculos(exec).where(eq(v.id, id));
    if (!l) throw erroApi(404, 'VINCULO_NAO_ENCONTRADO', 'Vínculo não encontrado.');
    return paraVinculoApi(l, this.hoje());
  }

  /** Vínculos válidos da unidade (aprovado na vigência ou legado no prazo): quem pode autorizar entrada e encomenda. */
  async autorizadores(unidadeId: string) {
    const hoje = this.hoje();
    const vinculos = await carregarVinculos(this.db, and(eq(v.unidadeId, unidadeId), vinculoValidoSql(hoje))!, hoje);
    const ids = [...new Set(vinculos.map((x) => x.pessoaId))];
    const pessoas = ids.length ? await this.db.select(colunasPessoa).from(pessoa).where(and(inArray(pessoa.id, ids), isNull(pessoa.anonimizadaEm), isNull(pessoa.desativadaEm))) : [];
    const porId = new Map(pessoas.map((p) => [p.id, paraPessoaApi(p)]));
    return vinculos.filter((x) => porId.has(x.pessoaId)).map((vinculo) => ({ pessoa: porId.get(vinculo.pessoaId)!, vinculo }));
  }

  /** Executa `fn` numa transação com o vínculo travado; traduz o erro do banco. */
  private async comVinculo<T>(id: string, fn: (tx: Tx, antes: typeof v.$inferSelect) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        const [antes] = await tx.select().from(v).where(eq(v.id, id)).for('update');
        if (!antes) throw erroApi(404, 'VINCULO_NAO_ENCONTRADO', 'Vínculo não encontrado.');
        return fn(tx, antes);
      });
    } catch (e) {
      throw traduzirErroVinculo(e);
    }
  }

  private registrar(tx: Tx, ctx: Contexto, acao: string, id: string, antes: unknown, depois: unknown) {
    return this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao, entidade: 'vinculo_unidade', registroId: id, antes, depois });
  }

  /** Pessoa travada (FOR UPDATE: a categoria pode mudar) com o que o "cadastro completo" exige. */
  private async pessoaDoVinculo(tx: Tx, pessoaId: string) {
    const [p] = await tx.select({
      id: pessoa.id, categoria: pessoa.categoria, semCpf: pessoa.semCpf, telefone: pessoa.telefone, anonimizadaEm: pessoa.anonimizadaEm,
      menorIdade: pessoa.menorIdade, temCpf: sql<boolean>`(${pessoa.documentoBusca} IS NOT NULL)`.mapWith(Boolean),
      desativadaEm: pessoa.desativadaEm,
    }).from(pessoa).where(eq(pessoa.id, pessoaId)).for('update');
    // RF-02: aprovar/regularizar faria de um cadastro desativado um morador válido.
    if (p!.desativadaEm) throw erroApi(ERRO_PESSOA_DESATIVADA.status, ERRO_PESSOA_DESATIVADA.code, ERRO_PESSOA_DESATIVADA.message);
    return p!;
  }

  /** RF-04: a categoria de morador nasce na aprovação (e na regularização do legado), com trilha própria. */
  private async tornarMorador(tx: Tx, ctx: Contexto, p: { id: string; categoria: string }, agora: Date) {
    if (p.categoria === 'morador') return;
    await tx.update(pessoa).set({ categoria: 'morador', atualizadoEm: agora }).where(eq(pessoa.id, p.id));
    await this.auditoria.registrar(tx, {
      ator: ctx.ator, ip: ctx.ip, acao: 'pessoa.editar', entidade: 'pessoa', registroId: p.id,
      antes: { categoria: p.categoria }, depois: { categoria: 'morador', motivo: 'aprovacao_de_vinculo' },
    });
  }

  async criar(ctx: Contexto, i: { pessoaId: string; unidadeId: string; tipo: (typeof tipoVinculo.enumValues)[number]; vigenciaInicio: string | null; vigenciaFim: string | null }) {
    if (i.tipo === 'inquilino' && !i.vigenciaFim) throw erroApi(422, 'VIGENCIA_OBRIGATORIA', 'Inquilino exige data de fim da vigência.');
    if (i.vigenciaInicio && i.vigenciaFim && i.vigenciaFim < i.vigenciaInicio) throw erroApi(422, 'VIGENCIA_INVALIDA', 'O fim da vigência não pode ser anterior ao início.');
    const agora = this.relogio.agora();
    try {
      return await this.db.transaction(async (tx) => {
        // FOR SHARE: a anonimização concorrente (que altera a pessoa) espera este vínculo nascer, e vê o vínculo.
        const [p] = await tx.select({ id: pessoa.id, anonimizadaEm: pessoa.anonimizadaEm, desativadaEm: pessoa.desativadaEm }).from(pessoa)
          .where(eq(pessoa.id, i.pessoaId)).for('share');
        if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
        if (p.anonimizadaEm) throw erroApi(422, 'PESSOA_ANONIMIZADA', 'Cadastro anonimizado não recebe vínculo.');
        if (p.desativadaEm) throw erroApi(ERRO_PESSOA_DESATIVADA.status, ERRO_PESSOA_DESATIVADA.code, ERRO_PESSOA_DESATIVADA.message);
        await this.unidades.paraNovoUso(tx, i.unidadeId);
        // Pedir vínculo NÃO muda a categoria: ela só vira 'morador' na aprovação (RF-04).
        const [novo] = await tx.insert(v).values({
          pessoaId: i.pessoaId, unidadeId: i.unidadeId, tipo: i.tipo, status: 'pendente',
          vigenciaInicio: i.vigenciaInicio, vigenciaFim: i.vigenciaFim,
          registradoPorId: ctx.ator.id, registradoEm: agora, atualizadoEm: agora,
        }).returning();
        await this.registrar(tx, ctx, 'vinculo.criar', novo!.id, null, novo);
        return this.obter(novo!.id, tx);
      });
    } catch (e) {
      throw traduzirErroVinculo(e);
    }
  }

  /** RF-05: registra (ou refaz, enquanto pendente/legado) a conferência do comprovante. O conferente é quem está logado. */
  conferir(ctx: Contexto, id: string, i: { tipo: (typeof tipoComprovante.enumValues)[number]; descricao?: string; observacao?: string; data?: string }) {
    const agora = this.relogio.agora();
    const dia = i.data ?? diaBrt(agora);
    return this.comVinculo(id, async (tx, antes) => {
      if (antes.status !== 'pendente' && antes.status !== 'legado') {
        throw erroApi(409, 'CONFERENCIA_IMUTAVEL', 'A conferência só pode ser registrada em vínculo pendente ou legado.');
      }
      const erro = validarConferencia({ ...i, data: inicioDoDiaBrt(dia).getTime() }, agora.getTime());
      if (erro) throw erroApi(erro.status, erro.code, erro.message);
      const descricao = i.tipo === 'outro' ? (i.descricao ?? '').trim() || null : null;
      const observacao = (i.observacao ?? '').trim() || null;
      const [depois] = await tx.update(v).set({
        conferenciaTipoDocumento: i.tipo, conferenciaDescricao: descricao, conferenciaData: dia, conferidoPorId: ctx.ator.id,
        conferenciaObservacao: observacao, atualizadoEm: agora,
      }).where(eq(v.id, id)).returning();
      await this.registrar(tx, ctx, 'vinculo.conferir', id, antes, depois);
      return this.obter(id, tx);
    });
  }

  /** RF-06, RN-02, RN-03: aprovar exige cadastro completo e conferência; a pessoa passa a morador. */
  aprovar(ctx: Contexto, id: string) {
    const agora = this.relogio.agora();
    return this.comVinculo(id, async (tx, antes) => {
      if (antes.status !== 'pendente') throw erroApi(409, 'VINCULO_JA_DECIDIDO', `Este vínculo já foi decidido (está ${ROTULO_STATUS[antes.status]}).`);
      const p = await this.pessoaDoVinculo(tx, antes.pessoaId);
      if (!cadastroCompletoDe(p, antes.tipo)) {
        throw erroApi(422, 'CADASTRO_INCOMPLETO', 'Para aprovar o vínculo a pessoa precisa ter CPF válido (não “sem CPF”) e telefone cadastrados (dependente menor de idade dispensa os dois).');
      }
      // Aprovar é um novo uso da unidade: desativada, barra (422 UNIDADE_INATIVA). FOR SHARE segura a desativação concorrente.
      await this.unidades.paraNovoUso(tx, antes.unidadeId);
      const erro = validarDecisaoVinculo('aprovar', undefined, antes.conferidoPorId ? { tipoDocumento: antes.conferenciaTipoDocumento!, data: 0, conferidoPorId: antes.conferidoPorId } : null);
      if (erro) throw erroApi(erro.status, erro.code, erro.message);
      const [depois] = await tx.update(v).set({ status: 'aprovado', decididoPorId: ctx.ator.id, decididoEm: agora, atualizadoEm: agora }).where(eq(v.id, id)).returning();
      await this.registrar(tx, ctx, 'vinculo.aprovar', id, antes, depois);
      await this.tornarMorador(tx, ctx, p, agora);
      return this.obter(id, tx);
    });
  }

  rejeitar(ctx: Contexto, id: string, justificativa: string) {
    const agora = this.relogio.agora();
    const j = justificativa.trim();
    return this.comVinculo(id, async (tx, antes) => {
      if (antes.status !== 'pendente') throw erroApi(409, 'VINCULO_JA_DECIDIDO', `Este vínculo já foi decidido (está ${ROTULO_STATUS[antes.status]}).`);
      const erro = validarDecisaoVinculo('rejeitar', j, null);
      if (erro) throw erroApi(erro.status, erro.code, erro.message);
      const [depois] = await tx.update(v).set({ status: 'rejeitado', decididoPorId: ctx.ator.id, decididoEm: agora, justificativa: j, atualizadoEm: agora })
        .where(eq(v.id, id)).returning();
      await this.registrar(tx, ctx, 'vinculo.rejeitar', id, antes, depois);
      return this.obter(id, tx);
    });
  }

  /** RN-09: legado -> aprovado, com conferência registrada e cadastro completo. `vigenciaFim` undefined = mantém. */
  regularizar(ctx: Contexto, id: string, o: { vigenciaFim?: string | null }) {
    const agora = this.relogio.agora();
    return this.comVinculo(id, async (tx, antes) => {
      if (antes.status !== 'legado') throw erroApi(409, 'VINCULO_NAO_LEGADO', 'Só vínculo legado (importado da planilha) é regularizado.');
      const p = await this.pessoaDoVinculo(tx, antes.pessoaId);
      if (!cadastroCompletoDe(p, antes.tipo)) {
        throw erroApi(422, 'CADASTRO_INCOMPLETO', 'Para regularizar, complete o cadastro (CPF válido e telefone) pela ficha da pessoa.');
      }
      await this.unidades.paraNovoUso(tx, antes.unidadeId); // regularizar aprova: unidade desativada barra
      if (!antes.conferidoPorId) throw erroApi(422, 'CONFERENCIA_OBRIGATORIA', 'Registre a conferência do comprovante (RF-05) antes de regularizar.');
      const vigenciaFim = o.vigenciaFim !== undefined ? o.vigenciaFim : antes.vigenciaFim;
      if (antes.tipo === 'inquilino' && !vigenciaFim) throw erroApi(422, 'VIGENCIA_OBRIGATORIA', 'Inquilino exige data de fim da vigência para ser regularizado.');
      if (vigenciaFim && antes.vigenciaInicio && vigenciaFim < antes.vigenciaInicio) throw erroApi(422, 'VIGENCIA_INVALIDA', 'O fim da vigência não pode ser anterior ao início.');
      const [depois] = await tx.update(v).set({ status: 'aprovado', vigenciaFim, decididoPorId: ctx.ator.id, decididoEm: agora, atualizadoEm: agora })
        .where(eq(v.id, id)).returning();
      await this.registrar(tx, ctx, 'vinculo.regularizar', id, antes, depois);
      await this.tornarMorador(tx, ctx, p, agora);
      return this.obter(id, tx);
    });
  }

  /**
   * RF-07, encerramento manual (o automático no fim da vigência é do agendador, fora deste lote). Só aprovado ou legado.
   * Data padrão: hoje; se a vigência já terminou, o fim da vigência (o vínculo deixou de valer ali, regra de
   * `vinculoValido`). Não pode ser futura nem anterior ao início da vigência. Motivo de 15+ caracteres em `justificativa`.
   * `encerrado_em`: agora, se a data for hoje; senão, o início do dia informado (BRT).
   */
  encerrar(ctx: Contexto, id: string, i: { motivo: string; data?: string }) {
    const agora = this.relogio.agora();
    const hoje = diaBrt(agora);
    const motivo = i.motivo.trim();
    return this.comVinculo(id, async (tx, antes) => {
      if (antes.status !== 'aprovado' && antes.status !== 'legado') {
        throw erroApi(409, 'VINCULO_NAO_ENCERRAVEL', antes.status === 'pendente'
          ? 'Vínculo pendente não é encerrado: rejeite a solicitação.' : `Este vínculo já está ${ROTULO_STATUS[antes.status]}.`);
      }
      if (motivo.length < MIN_JUSTIFICATIVA) throw erroApi(422, 'MOTIVO_OBRIGATORIO', `Informe o motivo do encerramento (mínimo de ${MIN_JUSTIFICATIVA} caracteres).`);
      const dia = i.data ?? (antes.vigenciaFim && antes.vigenciaFim < hoje ? antes.vigenciaFim : hoje);
      if (dia > hoje) throw erroApi(422, 'DATA_FUTURA', 'A data do encerramento não pode ser futura. Para encerrar no futuro, ajuste o fim da vigência.');
      if (antes.vigenciaInicio && dia < antes.vigenciaInicio) throw erroApi(422, 'DATA_ANTES_DO_INICIO', 'A data do encerramento não pode ser anterior ao início do vínculo.');
      const encerradoEm = dia === hoje ? agora : inicioDoDiaBrt(dia);
      const [depois] = await tx.update(v).set({ status: 'encerrado', encerradoEm, justificativa: motivo, atualizadoEm: agora }).where(eq(v.id, id)).returning();
      await this.registrar(tx, ctx, 'vinculo.encerrar', id, antes, depois);
      return this.obter(id, tx);
    });
  }
}

