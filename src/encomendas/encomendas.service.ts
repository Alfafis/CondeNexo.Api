// M3 — Encomendas (RF-22 a RF-26, RN-08; spec §6.4). Regras: receber só com a unidade conferida (RF-23) e ativa; entregar só a quem tem vínculo válido na unidade
// ou autorização de retirada desta encomenda (RN-08); autorização a pedido de morador com vínculo válido, para pessoa
// cadastrada com CPF. Toda escrita grava audit_log na mesma transação (RN-11).
//
// Concorrência: entregar e autorizar travam a linha da encomenda (FOR UPDATE). A segunda entrega simultânea espera,
// relê "já retirada" e responde 409 legível; o trigger `encomenda_retirada_congela` é a última barreira (23514 -> 409).
import { Inject, Injectable } from '@nestjs/common';
import { encomendaAtrasada } from '../dominio/rules';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { diaBrt } from '../comum/datas';
import { codigoPg, constraintPg, erroApi } from '../comum/erros';
import { codificarCursor, decodificarCursor, Pagina } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { transacaoComRetry } from '../comum/transacao';
import { DB, type Db, type Executor } from '../database/database.module';
import { autorizacaoRetirada, encomenda, pessoa, unidade, usuarioSistema, vinculoUnidade } from '../db/schema';
import { UnidadesService } from '../unidades/unidades.service';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';
import { codigoUnidade } from '../dominio/units';
import { AutorizarDto, CursorEncomendas, ListarEncomendasDto, ReceberDto } from './encomendas.schemas';
import type { EncomendaViewApi } from './encomendas.types';

const DIA_MS = 86_400_000;

type LinhaEncomenda = typeof encomenda.$inferSelect;
type LinhaAutorizacao = typeof autorizacaoRetirada.$inferSelect;

const ms = (d: Date | null) => (d ? d.getTime() : null);
/** "K108": prefixo fixo, a partir do `numero` (identity) do banco. */
export const codigoEncomenda = (numero: number) => `K${numero}`;

const autorizacaoDominio = (a: LinhaAutorizacao) => ({
  id: a.id, encomendaId: a.encomendaId, pessoaAutorizadaId: a.pessoaAutorizadaId, solicitantePessoaId: a.solicitantePessoaId,
  registradaPorId: a.registradaPorId, registradaEm: a.registradaEm.getTime(),
});

/** Erro do banco numa escrita de encomenda -> resposta legível, sem a mensagem do driver. */
function traduzir(e: unknown): unknown {
  const pg = codigoPg(e);
  if (pg === '23514' && constraintPg(e) === undefined) return erroApi(409, 'ENCOMENDA_JA_ENTREGUE', 'Esta encomenda já foi retirada.'); // trigger
  if (pg === '23505' && constraintPg(e) === 'autorizacao_retirada_pessoa_uq') {
    return erroApi(409, 'AUTORIZACAO_DUPLICADA', 'Esta pessoa já está autorizada a retirar esta encomenda.');
  }
  if (pg === '23503') return erroApi(422, 'REFERENCIA_INVALIDA', 'Pessoa ou unidade informada não existe.');
  return e;
}

@Injectable()
export class EncomendasService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(UnidadesService) private readonly unidades: UnidadesService,
  ) {}

  private agora() { return this.relogio.agora(); }

  private async temVinculoValido(exec: Executor, pessoaId: string, unidadeId: string): Promise<boolean> {
    const [v] = await exec.select({ id: vinculoUnidade.id }).from(vinculoUnidade)
      .where(and(eq(vinculoUnidade.pessoaId, pessoaId), eq(vinculoUnidade.unidadeId, unidadeId), vinculoValidoSql(diaBrt(this.agora())))).limit(1);
    return !!v;
  }

  /** Views em lote: nomes (pessoa, usuário), código da unidade, autorizações e o tipo do vínculo de quem retirou. */
  async views(exec: Executor, linhas: LinhaEncomenda[]): Promise<EncomendaViewApi[]> {
    if (linhas.length === 0) return [];
    const ids = linhas.map((e) => e.id);
    const auts = await exec.select().from(autorizacaoRetirada).where(inArray(autorizacaoRetirada.encomendaId, ids))
      .orderBy(asc(autorizacaoRetirada.registradaEm), asc(autorizacaoRetirada.id));
    const pessoaIds = new Set<string>();
    const usuarioIds = new Set<string>();
    for (const e of linhas) {
      usuarioIds.add(e.recebidaPorId);
      if (e.retiradaRegistradaPorId) usuarioIds.add(e.retiradaRegistradaPorId);
      if (e.retiradaPorPessoaId) pessoaIds.add(e.retiradaPorPessoaId);
    }
    for (const a of auts) { pessoaIds.add(a.pessoaAutorizadaId); pessoaIds.add(a.solicitantePessoaId); }
    const unidadeIds = [...new Set(linhas.map((e) => e.unidadeId))];
    const retirantes = linhas.filter((e) => e.retiradaPorPessoaId && !e.retiradaAutorizacaoId);
    const [ps, us, uns, vs] = await Promise.all([
      pessoaIds.size ? exec.select({ id: pessoa.id, nome: pessoa.nome }).from(pessoa).where(inArray(pessoa.id, [...pessoaIds])) : [],
      exec.select({ id: usuarioSistema.id, nome: usuarioSistema.nome }).from(usuarioSistema).where(inArray(usuarioSistema.id, [...usuarioIds])),
      exec.select({ id: unidade.id, bloco: unidade.bloco, numero: unidade.numero }).from(unidade).where(inArray(unidade.id, unidadeIds)),
      // Tipo do vínculo de quem retirou por vínculo (para "Lúcia Ribeiro (dependente)")
      retirantes.length ? exec.select({ pessoaId: vinculoUnidade.pessoaId, unidadeId: vinculoUnidade.unidadeId, tipo: vinculoUnidade.tipo })
        .from(vinculoUnidade).where(inArray(vinculoUnidade.pessoaId, [...new Set(retirantes.map((e) => e.retiradaPorPessoaId!))]))
        .orderBy(asc(vinculoUnidade.registradoEm)) : [],
    ]);
    const nomeP = new Map(ps.map((p) => [p.id, p.nome]));
    const nomeU = new Map(us.map((u) => [u.id, u.nome]));
    const codU = new Map(uns.map((u) => [u.id, codigoUnidade(u)]));
    const tipoV = new Map<string, string>();
    for (const v of vs) if (!tipoV.has(`${v.pessoaId}:${v.unidadeId}`)) tipoV.set(`${v.pessoaId}:${v.unidadeId}`, v.tipo);
    const autsPor = new Map<string, LinhaAutorizacao[]>();
    for (const a of auts) autsPor.set(a.encomendaId, [...(autsPor.get(a.encomendaId) ?? []), a]);
    const agora = this.agora().getTime();

    return linhas.map((e) => {
      let retiradaPorNome: string | null = null;
      if (e.retiradaPorPessoaId) {
        const nome = nomeP.get(e.retiradaPorPessoaId) ?? '?';
        const aut = e.retiradaAutorizacaoId ? auts.find((a) => a.id === e.retiradaAutorizacaoId) : undefined;
        const tipo = tipoV.get(`${e.retiradaPorPessoaId}:${e.unidadeId}`);
        retiradaPorNome = aut
          ? `${nome} (autorizado por ${nomeP.get(aut.solicitantePessoaId) ?? '?'})`
          : `${nome} (${tipo === 'dependente' ? 'dependente' : tipo === 'inquilino' ? 'inquilino' : 'morador'})`;
      }
      return {
        id: e.id, codigo: codigoEncomenda(e.numero), unidadeId: e.unidadeId, destinatario: e.destinatario,
        transportadora: e.transportadora ?? '', codigoRastreio: e.codigoRastreio ?? '', recebidaPorId: e.recebidaPorId,
        recebidaEm: e.recebidaEm.getTime(), unidadeConfirmada: e.unidadeConfirmada, retiradaEm: ms(e.retiradaEm),
        retiradaPorPessoaId: e.retiradaPorPessoaId, retiradaRegistradaPorId: e.retiradaRegistradaPorId, retiradaAutorizacaoId: e.retiradaAutorizacaoId,
        unidadeCodigo: codU.get(e.unidadeId) ?? '?', recebidaPorNome: nomeU.get(e.recebidaPorId) ?? '?', retiradaPorNome,
        retiradaRegistradaPorNome: e.retiradaRegistradaPorId ? nomeU.get(e.retiradaRegistradaPorId) ?? '?' : null,
        atrasada: !e.retiradaEm && encomendaAtrasada(e.recebidaEm.getTime(), agora),
        autorizacoes: (autsPor.get(e.id) ?? []).map((a) => ({
          ...autorizacaoDominio(a), pessoaNome: nomeP.get(a.pessoaAutorizadaId) ?? '?', solicitanteNome: nomeP.get(a.solicitantePessoaId) ?? '?',
        })),
      };
    });
  }

  /** Limite de "atrasada": recebida há mais de N dias inteiros (diasDesde > N), i.e. recebida_em <= agora - (N+1) dias. */
  private limiteAtraso(dias: number) { return new Date(this.agora().getTime() - (dias + 1) * DIA_MS); }

  /** RF-26: filas por status, mais recentes primeiro (recebida_em + id, keyset). */
  async listar(f: z.infer<typeof ListarEncomendasDto>): Promise<Pagina<EncomendaViewApi>> {
    const depois = f.cursor ? decodificarCursor(f.cursor, CursorEncomendas) : null;
    const filtros: SQL[] = [];
    if (f.status === 'aguardando' || f.atrasadasDias !== undefined) filtros.push(isNull(encomenda.retiradaEm));
    if (f.status === 'entregue') filtros.push(isNotNull(encomenda.retiradaEm));
    if (f.unidadeId) filtros.push(eq(encomenda.unidadeId, f.unidadeId));
    if (f.atrasadasDias !== undefined) filtros.push(lte(encomenda.recebidaEm, this.limiteAtraso(f.atrasadasDias)));
    if (depois) filtros.push(sql`(${encomenda.recebidaEm}, ${encomenda.id}) < (${depois.t}::timestamptz, ${depois.id}::uuid)`);
    const linhas = await this.db.select().from(encomenda).where(filtros.length ? and(...filtros) : undefined)
      .orderBy(desc(encomenda.recebidaEm), desc(encomenda.id)).limit(f.limite + 1);
    const pagina = linhas.slice(0, f.limite);
    const ultimo = pagina[pagina.length - 1];
    const proximo = linhas.length > f.limite && ultimo ? codificarCursor({ t: ultimo.recebidaEm.toISOString(), id: ultimo.id }) : null;
    return new Pagina(await this.views(this.db, pagina), proximo);
  }

  /** Contagens das abas e do painel (sem carregar as listas). */
  async resumo(dias: number) {
    const total = async (onde: SQL | undefined) => Number((await this.db.select({ n: count() }).from(encomenda).where(onde))[0]?.n ?? 0);
    const [aguardando, atrasadas, entregues] = await Promise.all([
      total(isNull(encomenda.retiradaEm)),
      total(and(isNull(encomenda.retiradaEm), lte(encomenda.recebidaEm, this.limiteAtraso(dias)))),
      total(isNotNull(encomenda.retiradaEm)),
    ]);
    return { aguardando, atrasadas, entregues, diasAtraso: dias };
  }

  async obter(id: string): Promise<EncomendaViewApi> {
    const [e] = await this.db.select().from(encomenda).where(eq(encomenda.id, id));
    if (!e) throw erroApi(404, 'ENCOMENDA_NAO_ENCONTRADA', 'Encomenda não encontrada.');
    return (await this.views(this.db, [e]))[0]!;
  }

  /** RF-22, RF-23: unidade conferida e ativa (FOR SHARE contra a desativação concorrente). */
  async receber(ctx: Contexto, i: z.infer<typeof ReceberDto>): Promise<EncomendaViewApi> {
    if (!i.unidadeConfirmada) throw erroApi(422, 'UNIDADE_NAO_CONFIRMADA', 'Confirme a unidade de destino antes de salvar (RF-23).');
    const destinatario = i.destinatario.trim();
    if (!destinatario) throw erroApi(422, 'DESTINATARIO_OBRIGATORIO', 'Informe o destinatário.');
    try {
      const linha = await transacaoComRetry(this.db, async (tx) => {
        await this.unidades.paraNovoUso(tx, i.unidadeId);
        const [e] = await tx.insert(encomenda).values({
          unidadeId: i.unidadeId, destinatario, transportadora: i.transportadora.trim() || null, codigoRastreio: i.codigoRastreio.trim() || null,
          unidadeConfirmada: true, recebidaPorId: ctx.ator.id, recebidaEm: this.agora(),
        }).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'encomenda.receber', entidade: 'encomenda', registroId: e!.id, depois: e });
        return e!;
      });
      return (await this.views(this.db, [linha]))[0]!;
    } catch (e) { throw traduzir(e); }
  }

  /** RF-25, RN-08: vínculo válido na unidade OU autorização de retirada desta encomenda para esta pessoa. */
  async entregar(ctx: Contexto, id: string, pessoaId: string): Promise<EncomendaViewApi> {
    try {
      const linha = await transacaoComRetry(this.db, async (tx) => {
        const [antes] = await tx.select().from(encomenda).where(eq(encomenda.id, id)).for('update');
        if (!antes) throw erroApi(404, 'ENCOMENDA_NAO_ENCONTRADA', 'Encomenda não encontrada.');
        if (antes.retiradaEm) throw erroApi(409, 'ENCOMENDA_JA_ENTREGUE', 'Esta encomenda já foi retirada.');
        const [p] = await tx.select({ id: pessoa.id }).from(pessoa).where(eq(pessoa.id, pessoaId));
        if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
        let autorizacaoId: string | null = null;
        if (!(await this.temVinculoValido(tx, pessoaId, antes.unidadeId))) {
          const [aut] = await tx.select({ id: autorizacaoRetirada.id }).from(autorizacaoRetirada)
            .where(and(eq(autorizacaoRetirada.encomendaId, id), eq(autorizacaoRetirada.pessoaAutorizadaId, pessoaId)));
          if (!aut) {
            const [u] = await tx.select({ bloco: unidade.bloco, numero: unidade.numero }).from(unidade).where(eq(unidade.id, antes.unidadeId));
            throw erroApi(422, 'PESSOA_SEM_VINCULO', `Esta pessoa não tem vínculo com a ${u ? codigoUnidade(u) : 'unidade'} nem autorização de retirada. Contate a unidade.`);
          }
          autorizacaoId = aut.id; // FK composta: a autorização usada é desta encomenda e desta pessoa
        }
        const [depois] = await tx.update(encomenda).set({
          retiradaEm: this.agora(), retiradaPorPessoaId: pessoaId, retiradaRegistradaPorId: ctx.ator.id, retiradaAutorizacaoId: autorizacaoId,
        }).where(eq(encomenda.id, id)).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'encomenda.entregar', entidade: 'encomenda', registroId: id, antes, depois });
        return depois!;
      });
      return (await this.views(this.db, [linha]))[0]!;
    } catch (e) { throw traduzir(e); }
  }

  /** RN-08: "ou a pessoa autorizada por ela". Retirante com CPF; solicitante com vínculo válido na unidade. */
  async autorizarRetirada(ctx: Contexto, encomendaId: string, i: z.infer<typeof AutorizarDto>) {
    try {
      const a = await transacaoComRetry(this.db, async (tx) => {
        const [e] = await tx.select().from(encomenda).where(eq(encomenda.id, encomendaId)).for('update');
        if (!e) throw erroApi(404, 'ENCOMENDA_NAO_ENCONTRADA', 'Encomenda não encontrada.');
        if (e.retiradaEm) throw erroApi(409, 'ENCOMENDA_JA_ENTREGUE', 'Esta encomenda já foi retirada.');
        const [p] = await tx.select({ id: pessoa.id, semCpf: pessoa.semCpf, documentoBusca: pessoa.documentoBusca, anonimizadaEm: pessoa.anonimizadaEm })
          .from(pessoa).where(eq(pessoa.id, i.pessoaId));
        if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
        if (p.anonimizadaEm || p.semCpf || !p.documentoBusca) throw erroApi(422, 'CPF_OBRIGATORIO', 'Quem vai retirar precisa estar cadastrado com CPF.');
        if (!(await this.temVinculoValido(tx, i.solicitadaPorPessoaId, e.unidadeId))) {
          throw erroApi(422, 'SOLICITANTE_SEM_VINCULO', 'Quem autoriza precisa ter vínculo válido (aprovado ou legado no prazo) com a unidade da encomenda.');
        }
        if (i.pessoaId === i.solicitadaPorPessoaId) throw erroApi(422, 'AUTORIZACAO_PROPRIA', 'O morador com vínculo já pode retirar: não precisa se autorizar.');
        const [dup] = await tx.select({ id: autorizacaoRetirada.id }).from(autorizacaoRetirada)
          .where(and(eq(autorizacaoRetirada.encomendaId, encomendaId), eq(autorizacaoRetirada.pessoaAutorizadaId, i.pessoaId)));
        if (dup) throw erroApi(409, 'AUTORIZACAO_DUPLICADA', 'Esta pessoa já está autorizada a retirar esta encomenda.');
        const [nova] = await tx.insert(autorizacaoRetirada).values({
          encomendaId, pessoaAutorizadaId: i.pessoaId, solicitantePessoaId: i.solicitadaPorPessoaId, registradaPorId: ctx.ator.id, registradaEm: this.agora(),
        }).returning();
        await this.auditoria.registrar(tx, {
          ator: ctx.ator, ip: ctx.ip, acao: 'encomenda.autorizarRetirada', entidade: 'autorizacao_retirada', registroId: nova!.id, depois: nova,
        });
        return nova!;
      });
      return autorizacaoDominio(a);
    } catch (e) { throw traduzir(e); }
  }
}
