// Autorização prévia (RF-14, RN-07, RF-36) e restrição (RF-15, RF-16, RN-06). Revogar duas vezes e mudar a aprovação são barrados também no banco (triggers
// revogacao_congela e restricao_aprovacao_unica): a API checa antes, com a linha travada, para responder 409 legível.
// Toda criação, revogação e aprovação grava audit_log na mesma transação (RN-11).
import { Inject, Injectable } from '@nestjs/common';
import { pode } from '../dominio/rbac';
import { ERRO_PESSOA_DESATIVADA, MIN_JUSTIFICATIVA, justificativaValida, proximaJanelaAutorizacao, restricoesVigentes } from '../dominio/rules';
import { fimDoDia, HORA, inicioDoDia, partes } from '../dominio/time';
import { codigoUnidade } from '../dominio/units';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { diaBrt, inicioDoDiaBrt } from '../comum/datas';
import { AcessoNegado, codigoPg, erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db, type Executor, type Tx } from '../database/database.module';
import { areaComum, autorizacaoPrevia, pessoa, restricao, unidade, vinculoUnidade } from '../db/schema';
import { UnidadesService } from '../unidades/unidades.service';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';
import { col, efetivoSql, semSaidaSql } from './efetivo';
import {
  montarAutorizacoesView, montarRestricoesView, paraAutorizacaoDominio, paraRestricaoDominio, type AutorizacaoViewApi, type RestricaoViewApi,
} from './conversoes';

const DIA_MS = 86_400_000;
/** 'AAAA-MM-DD' -> fim do dia BRT (23:59:59.999), com `fimDoDia` de ../dominio/time. */
const fimDoDiaBrt = (dia: string) => new Date(inicioDoDiaBrt(dia).getTime() + DIA_MS - 1);

export interface NovaAutorizacao {
  unidadeId: string | null; areaComumId?: string | null; pessoaId: string;
  /** Datas de calendário (dia BRT). `validaDe` padrão: hoje. A autorização vale do início de `validaDe` ao fim de `validaAte`. */
  validaDe?: string; validaAte: string | null;
  diasSemana: number[] | null; horaInicio: string | null; horaFim: string | null;
  solicitadaPorPessoaId: string | null; justificativa?: string | null;
}
/** Visita prevista (porteiro): sem CPF e sem telefone (minimização, LGPD). `inicio`/`fim` = próxima janela da autorização. */
export interface PrevistoView {
  autorizacaoId: string; pessoaId: string; nome: string; categoria: typeof pessoa.$inferSelect['categoria'];
  destino: { tipo: 'unidade' | 'area_comum'; id: string; rotulo: string };
  inicio: number; fim: number;
}
export interface NovaRestricao {
  pessoaId: string; unidadeId: string | null; motivo: string; validaAte: string | null;
  solicitadaPorPessoaId: string | null; paraTodoCondominio?: boolean;
}

/** Erro do banco (corrida com a revogação ou com a aprovação) -> 409 legível, sem a mensagem do driver. */
function traduzir(e: unknown, entidade: 'autorizacao' | 'restricao'): unknown {
  const pg = codigoPg(e);
  if (pg === '23514') {
    return entidade === 'autorizacao'
      ? erroApi(409, 'AUTORIZACAO_JA_REVOGADA', 'Esta autorização já foi revogada.')
      : erroApi(409, 'RESTRICAO_ALTERADA', 'A restrição mudou ao mesmo tempo (revogada ou aprovada). Atualize a tela.');
  }
  if (pg === '23503') return erroApi(422, 'REFERENCIA_INVALIDA', 'Pessoa, unidade ou área informada não existe.');
  return e;
}

@Injectable()
export class AutorizacoesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(UnidadesService) private readonly unidades: UnidadesService,
  ) {}

  private agora() { return this.relogio.agora().getTime(); }

  private async temVinculoValido(exec: Executor, pessoaId: string, unidadeId: string, quando: number) {
    const [v] = await exec.select({ id: vinculoUnidade.id }).from(vinculoUnidade)
      .where(and(eq(vinculoUnidade.pessoaId, pessoaId), eq(vinculoUnidade.unidadeId, unidadeId), vinculoValidoSql(diaBrt(new Date(quando))))).limit(1);
    return !!v;
  }

  private async areaParaNovoUso(exec: Executor, id: string) {
    const [a] = await exec.select().from(areaComum).where(eq(areaComum.id, id)).for('share');
    if (!a) throw erroApi(404, 'AREA_COMUM_NAO_ENCONTRADA', 'Área comum não encontrada.');
    if (!a.ativo) throw erroApi(422, 'AREA_COMUM_INATIVA', `A área comum ${a.nome} está desativada.`);
    return a;
  }

  async viewsAutorizacao(linhas: (typeof autorizacaoPrevia.$inferSelect)[]): Promise<AutorizacaoViewApi[]> {
    return montarAutorizacoesView(this.db, linhas.map(paraAutorizacaoDominio), this.agora());
  }

  // ----- Autorização prévia ------------------------------------------------------------------------------------------

  async criarAutorizacao(ctx: Contexto, i: NovaAutorizacao): Promise<AutorizacaoViewApi> {
    // RF-36: área comum é autorizada pela administração
    if (i.areaComumId && !pode(ctx.ator.papel, 'autorizacao.area_comum')) throw new AcessoNegado('autorizacao.area_comum');
    const n = this.agora();
    const hoje = diaBrt(new Date(n));
    if (!i.validaAte) throw erroApi(422, 'VALIDADE_OBRIGATORIA', 'Autorização prévia exige data de validade (RN-07).');
    if (i.validaAte < hoje) throw erroApi(422, 'VALIDADE_INVALIDA', 'A validade não pode estar no passado.');
    if (i.validaDe !== undefined && i.validaDe > i.validaAte) throw erroApi(422, 'PERIODO_INVALIDO', 'O início da validade não pode ser posterior ao fim.');
    try {
      const linha = await this.db.transaction(async (tx) => {
        // FOR SHARE: a desativação concorrente (FOR UPDATE) espera esta autorização nascer, e a revoga junto.
        const [p] = await tx.select({ id: pessoa.id, categoria: pessoa.categoria, desativadaEm: pessoa.desativadaEm }).from(pessoa)
          .where(eq(pessoa.id, i.pessoaId)).for('share');
        if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
        if (p.desativadaEm) throw erroApi(ERRO_PESSOA_DESATIVADA.status, ERRO_PESSOA_DESATIVADA.code, ERRO_PESSOA_DESATIVADA.message);
        if (i.unidadeId && i.areaComumId) throw erroApi(422, 'DESTINO_DUPLO', 'Informe a unidade OU a área comum, não as duas.');
        if (!i.unidadeId && !i.areaComumId) throw erroApi(422, 'UNIDADE_OBRIGATORIA', 'Informe a unidade de destino.');
        if (!!i.horaInicio !== !!i.horaFim) throw erroApi(422, 'JANELA_INCOMPLETA', 'Informe hora de início e de fim, ou nenhuma.');
        if (i.horaInicio && i.horaFim && i.horaFim <= i.horaInicio) throw erroApi(422, 'JANELA_INVALIDA', 'A hora final deve ser posterior à inicial.');
        const base = {
          pessoaId: i.pessoaId,
          validaDe: i.validaDe !== undefined ? inicioDoDiaBrt(i.validaDe) : new Date(inicioDoDia(n)),
          validaAte: fimDoDiaBrt(i.validaAte!),
          diasSemana: i.diasSemana && i.diasSemana.length > 0 && i.diasSemana.length < 7 ? [...new Set(i.diasSemana)].sort((a, b) => a - b) : null,
          horaInicio: i.horaInicio, horaFim: i.horaFim, cadastradaPorId: ctx.ator.id, cadastradaEm: new Date(n),
        };
        let valores: typeof autorizacaoPrevia.$inferInsert;
        if (i.areaComumId) {
          // Área comum: sem morador solicitante (a administração é a solicitante) e não conta como exceção
          await this.areaParaNovoUso(tx, i.areaComumId);
          if (p.categoria !== 'prestador') throw erroApi(422, 'AREA_COMUM_SO_PRESTADOR', 'Área comum só é destino de prestador de serviço (RF-36).');
          if (i.solicitadaPorPessoaId) throw erroApi(422, 'AREA_COMUM_SEM_SOLICITANTE', 'Autorização de área comum não tem morador solicitante.');
          valores = { ...base, unidadeId: null, areaComumId: i.areaComumId, solicitadaPorPessoaId: null, semSolicitante: false, justificativa: i.justificativa?.trim() || null };
        } else {
          await this.unidades.paraNovoUso(tx, i.unidadeId!);
          // Com solicitante: morador com vínculo válido na unidade; sem ele, só com justificativa (conta como exceção)
          const semSolicitante = !i.solicitadaPorPessoaId;
          if (!semSolicitante && !(await this.temVinculoValido(tx, i.solicitadaPorPessoaId!, i.unidadeId!, n))) {
            throw erroApi(422, 'SOLICITANTE_SEM_VINCULO', 'O morador que pediu precisa ter vínculo válido (aprovado ou legado no prazo) com a unidade.');
          }
          if (semSolicitante && !justificativaValida(i.justificativa)) {
            throw erroApi(422, 'SOLICITANTE_OU_JUSTIFICATIVA', `Informe o morador que pediu ou, sem ele, uma justificativa de pelo menos ${MIN_JUSTIFICATIVA} caracteres.`);
          }
          valores = {
            ...base, unidadeId: i.unidadeId!, areaComumId: null, solicitadaPorPessoaId: i.solicitadaPorPessoaId ?? null,
            semSolicitante, justificativa: semSolicitante ? i.justificativa!.trim() : null,
          };
        }
        const [a] = await tx.insert(autorizacaoPrevia).values(valores).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'autorizacao.criar', entidade: 'autorizacao_previa', registroId: a!.id, depois: a });
        return a!;
      });
      return (await this.viewsAutorizacao([linha]))[0]!;
    } catch (e) { throw traduzir(e, 'autorizacao'); }
  }

  async revogarAutorizacao(ctx: Contexto, id: string): Promise<void> {
    const n = new Date(this.agora());
    try {
      await this.db.transaction(async (tx: Tx) => {
        const [antes] = await tx.select().from(autorizacaoPrevia).where(eq(autorizacaoPrevia.id, id)).for('update');
        if (!antes) throw erroApi(404, 'AUTORIZACAO_NAO_ENCONTRADA', 'Autorização não encontrada.');
        if (antes.areaComumId && !pode(ctx.ator.papel, 'autorizacao.area_comum')) {
          throw new AcessoNegado('autorizacao.area_comum', 'Só síndico ou administração revogam autorização de área comum.');
        }
        if (antes.revogadaEm) throw erroApi(409, 'AUTORIZACAO_JA_REVOGADA', 'Esta autorização já foi revogada.');
        const [depois] = await tx.update(autorizacaoPrevia).set({ revogadaEm: n, revogadaPorId: ctx.ator.id }).where(eq(autorizacaoPrevia.id, id)).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'autorizacao.revogar', entidade: 'autorizacao_previa', registroId: id, antes, depois });
      });
    } catch (e) { throw traduzir(e, 'autorizacao'); }
  }

  /** Autorizações da pessoa para o destino que valem agora ou valem hoje fora da janela (a tela avisa o horário). */
  async vigentes(pessoaId: string, destino: { unidadeId?: string; areaComumId?: string }): Promise<AutorizacaoViewApi[]> {
    const ls = await this.db.select().from(autorizacaoPrevia).where(and(
      eq(autorizacaoPrevia.pessoaId, pessoaId), isNull(autorizacaoPrevia.revogadaEm),
      destino.areaComumId ? eq(autorizacaoPrevia.areaComumId, destino.areaComumId) : eq(autorizacaoPrevia.unidadeId, destino.unidadeId!),
    )).orderBy(asc(autorizacaoPrevia.cadastradaEm), asc(autorizacaoPrevia.id));
    return (await this.viewsAutorizacao(ls)).filter((a) => a.estado === 'valida' || a.estado === 'fora_da_janela');
  }

  /** Autorizações que valem hoje (dia e dia da semana), por hora de início. */
  async hoje(): Promise<AutorizacaoViewApi[]> {
    const n = this.agora();
    const dow = partes(n).dow;
    const ls = await this.db.select().from(autorizacaoPrevia).where(and(
      isNull(autorizacaoPrevia.revogadaEm), lte(autorizacaoPrevia.validaDe, new Date(fimDoDia(n))), gte(autorizacaoPrevia.validaAte, new Date(inicioDoDia(n))),
      sql`(${autorizacaoPrevia.diasSemana} IS NULL OR ${dow}::smallint = ANY(${autorizacaoPrevia.diasSemana}))`,
    )).orderBy(sql`${autorizacaoPrevia.horaInicio} ASC NULLS FIRST`, asc(autorizacaoPrevia.id)).limit(500);
    // Corte do LIMIT na ordem de exibição (hora de início): antes era por cadastro, e a autorização cadastrada hoje era a que caía fora.
    return (await this.viewsAutorizacao(ls)).sort((a, b) => (a.horaInicio ?? '').localeCompare(b.horaInicio ?? ''));
  }

  /**
   * Pessoas com autorização prévia cuja janela vale agora ou começa nas próximas `horas` h e que NÃO estão dentro
   * (entrada sem saída, pelo valor efetivo da pessoa, como em "presentes"). Por início da janela.
   */
  async previstas(horas: number): Promise<PrevistoView[]> {
    const n = this.agora();
    const horizonte = horas * HORA;
    const dentro = sql`EXISTS (SELECT 1 FROM evento_acesso e WHERE e.tipo = 'entrada' AND ${semSaidaSql('e')}
      AND ${efetivoSql('pessoa_id', 'e')} = ${col('pessoa_id', 'autorizacao_previa')})`;
    const ls = await this.db.select({ a: autorizacaoPrevia, nome: pessoa.nome, categoria: pessoa.categoria, bloco: unidade.bloco, numero: unidade.numero, area: areaComum.nome })
      .from(autorizacaoPrevia)
      .innerJoin(pessoa, eq(pessoa.id, autorizacaoPrevia.pessoaId))
      .leftJoin(unidade, eq(unidade.id, autorizacaoPrevia.unidadeId))
      .leftJoin(areaComum, eq(areaComum.id, autorizacaoPrevia.areaComumId))
      .where(and(
        isNull(autorizacaoPrevia.revogadaEm), isNull(pessoa.desativadaEm), isNull(pessoa.anonimizadaEm),
        gte(autorizacaoPrevia.validaAte, new Date(n)), lte(autorizacaoPrevia.validaDe, new Date(n + horizonte)),
        sql`NOT ${dentro}`,
      )).orderBy(asc(autorizacaoPrevia.validaDe), asc(autorizacaoPrevia.id)).limit(1000);
    // Ordem definida antes do corte (sem ORDER BY o LIMIT era arbitrário). Limite aceito: com mais de 1000 no horizonte, uma recorrente
    // antiga (valida_de antigo) ocupa vaga de uma que abre logo; o volume real é muito menor.
    const out: PrevistoView[] = [];
    for (const l of ls) {
      const ap = paraAutorizacaoDominio(l.a);
      const j = proximaJanelaAutorizacao(ap, n, horizonte);
      if (!j) continue;
      const destino = ap.unidadeId
        ? { tipo: 'unidade' as const, id: ap.unidadeId, rotulo: l.bloco !== null && l.numero !== null ? codigoUnidade({ bloco: l.bloco, numero: l.numero }) : '(unidade)' }
        : { tipo: 'area_comum' as const, id: ap.areaComumId!, rotulo: l.area ?? '(área comum)' };
      out.push({ autorizacaoId: ap.id, pessoaId: ap.pessoaId, nome: l.nome, categoria: l.categoria, destino, inicio: j.inicio, fim: j.fim });
    }
    return out.sort((a, b) => a.inicio - b.inicio || a.nome.localeCompare(b.nome, 'pt-BR') || a.autorizacaoId.localeCompare(b.autorizacaoId)).slice(0, 200);
  }

  /** Detalhe da unidade: não revogadas e ainda não vencidas. */
  async autorizacoesDaUnidade(unidadeId: string): Promise<AutorizacaoViewApi[]> {
    const ls = await this.db.select().from(autorizacaoPrevia).where(and(
      eq(autorizacaoPrevia.unidadeId, unidadeId), isNull(autorizacaoPrevia.revogadaEm), gte(autorizacaoPrevia.validaAte, new Date(this.agora())),
    )).orderBy(asc(autorizacaoPrevia.cadastradaEm), asc(autorizacaoPrevia.id)).limit(200);
    return this.viewsAutorizacao(ls);
  }

  // ----- Restrição ---------------------------------------------------------------------------------------------------

  private async viewsRestricao(linhas: (typeof restricao.$inferSelect)[]): Promise<RestricaoViewApi[]> {
    return montarRestricoesView(this.db, linhas.map(paraRestricaoDominio));
  }

  /** RF-16: restrições vigentes da pessoa (unidade e, aprovadas, de condomínio). `unidadeId` null: só as de condomínio. */
  async verificar(pessoaId: string, unidadeId: string | null) {
    const ls = await this.db.select().from(restricao).where(and(eq(restricao.pessoaId, pessoaId), isNull(restricao.revogadaEm)));
    const vig = new Set(restricoesVigentes(ls.map(paraRestricaoDominio), pessoaId, unidadeId, this.agora()).map((r) => r.id));
    const alertas = await this.viewsRestricao(ls.filter((r) => vig.has(r.id)));
    return { restrita: alertas.length > 0, alertas };
  }

  async criarRestricao(ctx: Contexto, i: NovaRestricao): Promise<RestricaoViewApi> {
    const paraTodos = !!i.paraTodoCondominio;
    const n = this.agora();
    const motivo = i.motivo.trim();
    if (!motivo) throw erroApi(422, 'MOTIVO_OBRIGATORIO', 'Informe o motivo da restrição.');
    if (!i.validaAte) throw erroApi(422, 'VALIDADE_OBRIGATORIA', 'Informe até quando a restrição vale.');
    if (i.validaAte < diaBrt(new Date(n))) throw erroApi(422, 'VALIDADE_INVALIDA', 'A validade da restrição não pode estar no passado.');
    try {
      const linha = await this.db.transaction(async (tx) => {
        const [p] = await tx.select({ id: pessoa.id }).from(pessoa).where(eq(pessoa.id, i.pessoaId));
        if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
        if (!paraTodos && !i.unidadeId) throw erroApi(422, 'UNIDADE_OBRIGATORIA', 'Restrição de unidade exige a unidade.');
        // Unidade desativada não recebe restrição nova: ninguém entra
        // nela (a entrada já barra UNIDADE_INATIVA) e o solicitante não teria vínculo válido para pedir. FOR SHARE contra a
        // desativação concorrente, como os outros usos novos. Vale também para a origem de uma restrição de condomínio.
        if (i.unidadeId) await this.unidades.paraNovoUso(tx, i.unidadeId);
        // CHECK restricao_escopo_unidade_ck: no escopo unidade o solicitante é obrigatório (morador com vínculo válido)
        if (!paraTodos && !i.solicitadaPorPessoaId) throw erroApi(422, 'SOLICITANTE_OBRIGATORIO', 'Registre o morador que pediu a restrição.');
        if (i.solicitadaPorPessoaId) {
          const [s] = await tx.select({ id: pessoa.id }).from(pessoa).where(eq(pessoa.id, i.solicitadaPorPessoaId));
          if (!s) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Solicitante não encontrado.');
          if (!paraTodos && !(await this.temVinculoValido(tx, i.solicitadaPorPessoaId, i.unidadeId!, n))) {
            throw erroApi(422, 'SOLICITANTE_SEM_VINCULO', 'Quem pediu a restrição precisa ter vínculo válido (aprovado ou legado no prazo) com a unidade.');
          }
        }
        // RN-06: escopo condomínio nasce pendente; só o síndico aprova
        const [r] = await tx.insert(restricao).values({
          escopo: paraTodos ? 'condominio' : 'unidade', unidadeId: i.unidadeId ?? null, pessoaId: i.pessoaId, motivo,
          validaAte: fimDoDiaBrt(i.validaAte!), solicitadaPorPessoaId: i.solicitadaPorPessoaId ?? null, cadastradaPorId: ctx.ator.id,
          cadastradaEm: new Date(n),
        }).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'restricao.criar', entidade: 'restricao', registroId: r!.id, depois: r });
        return r!;
      });
      return (await this.viewsRestricao([linha]))[0]!;
    } catch (e) { throw traduzir(e, 'restricao'); }
  }

  /** RN-06: só o síndico aprova (a rota exige restricao.aprovar). Aprovar duas vezes: 409. */
  async aprovar(ctx: Contexto, id: string): Promise<RestricaoViewApi> {
    const n = new Date(this.agora());
    try {
      const linha = await this.db.transaction(async (tx) => {
        const [antes] = await tx.select().from(restricao).where(eq(restricao.id, id)).for('update');
        if (!antes) throw erroApi(404, 'RESTRICAO_NAO_ENCONTRADA', 'Restrição não encontrada.');
        if (antes.escopo !== 'condominio') throw erroApi(422, 'RESTRICAO_NAO_PENDENTE', 'Somente restrições para todo o condomínio exigem aprovação.');
        if (antes.aprovadaEm) throw erroApi(409, 'RESTRICAO_JA_APROVADA', 'Restrição já aprovada.');
        if (antes.revogadaEm) throw erroApi(409, 'RESTRICAO_JA_REVOGADA', 'Esta restrição já foi revogada.');
        const [depois] = await tx.update(restricao).set({ aprovadaPorId: ctx.ator.id, aprovadaEm: n }).where(eq(restricao.id, id)).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'restricao.aprovar', entidade: 'restricao', registroId: id, antes, depois });
        return depois!;
      });
      return (await this.viewsRestricao([linha]))[0]!;
    } catch (e) { throw traduzir(e, 'restricao'); }
  }

  async revogarRestricao(ctx: Contexto, id: string): Promise<void> {
    const n = new Date(this.agora());
    try {
      await this.db.transaction(async (tx) => {
        const [antes] = await tx.select().from(restricao).where(eq(restricao.id, id)).for('update');
        if (!antes) throw erroApi(404, 'RESTRICAO_NAO_ENCONTRADA', 'Restrição não encontrada.');
        if (antes.revogadaEm) throw erroApi(409, 'RESTRICAO_JA_REVOGADA', 'Esta restrição já foi revogada.');
        const [depois] = await tx.update(restricao).set({ revogadaEm: n, revogadaPorId: ctx.ator.id }).where(eq(restricao.id, id)).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'restricao.revogar', entidade: 'restricao', registroId: id, antes, depois });
      });
    } catch (e) { throw traduzir(e, 'restricao'); }
  }

  /** Pendentes de aprovação do síndico (escopo condomínio, não aprovadas, não revogadas). */
  async pendentes(): Promise<RestricaoViewApi[]> {
    const ls = await this.db.select().from(restricao).where(and(eq(restricao.escopo, 'condominio'), isNull(restricao.aprovadaEm), isNull(restricao.revogadaEm)))
      .orderBy(asc(restricao.cadastradaEm)).limit(200);
    return this.viewsRestricao(ls);
  }

  /** Detalhe da unidade: restrições com origem na unidade, não revogadas e não vencidas. */
  async restricoesDaUnidade(unidadeId: string): Promise<RestricaoViewApi[]> {
    const ls = await this.db.select().from(restricao).where(and(
      eq(restricao.unidadeId, unidadeId), isNull(restricao.revogadaEm), gte(restricao.validaAte, new Date(this.agora())),
    )).orderBy(asc(restricao.cadastradaEm), asc(restricao.id)).limit(200);
    return this.viewsRestricao(ls);
  }
}

