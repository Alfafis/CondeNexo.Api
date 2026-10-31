// Unidades (RF-01), catálogo leve e áreas comuns (RF-36). Regras:
// - bloco e número normalizados ("a" -> "A", "3" -> "03") e únicos (ativa ou desativada): 409 UNIDADE_DUPLICADA;
// - unidade já referenciada (vínculo, veículo, autorização, restrição, encomenda, ocorrência, evento) não muda de número:
//   422 UNIDADE_REFERENCIADA (mudaria o sentido do que já foi registrado nela; o caminho é desativar e cadastrar a certa);
// - nunca é excluída: desativar/reativar; inativa continua no histórico e barra novos usos (`paraNovoUso`).
// Toda escrita grava audit_log na mesma transação.
import { Inject, Injectable } from '@nestjs/common';
import {
  codigoUnidade, leiturasDoCodigo, normalizarBloco, normalizarNumero, rotuloUnidade, validarEstruturaUnidade,
} from '../dominio/units';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { codigoPg, erroApi } from '../comum/erros';
import { diaBrt } from '../comum/datas';
import { codificarCursor, decodificarCursor, Pagina } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { ESTRUTURA } from '../config/config';
import { DB, type Db, type EstruturaCondominio, type Executor, type Tx } from '../database/database.module';
import {
  areaComum, autorizacaoPrevia, encomenda, eventoAcesso, ocorrencia, pontoAcesso, restricao, unidade, veiculo, vinculoUnidade,
} from '../db/schema';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';
import { carregarVinculos } from '../vinculos/vinculo-view';
import { chaveBlocoSql, ORDEM_UNIDADES } from './ordem';

export interface UnidadeApi { id: string; bloco: string; numero: string; ativo: boolean }
export interface UnidadeCatalogo extends UnidadeApi { codigo: string; rotulo: string }
export interface UnidadeResumo {
  unidade: UnidadeApi; moradoresValidos: number; pendentes: number; restricoes: number; cadastroCompleto: boolean;
}

const colunas = { id: unidade.id, bloco: unidade.bloco, numero: unidade.numero, ativo: unidade.ativo };

/** Cursor = chave de ordenação do último item da página (bloco, número). Estável com inserção concorrente. */
const CursorUnidades = z.strictObject({ b: z.string().regex(/^[A-Z0-9]{1,3}$/), n: z.string().regex(/^[0-9]{1,10}$/) });

export interface FiltroUnidades { limite: number; cursor?: string; bloco?: string }

@Injectable()
export class UnidadesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(ESTRUTURA) private readonly estrutura: EstruturaCondominio,
  ) {}

  /**
   * Catálogo leve (RF-01, RF-36): todas as unidades (inclusive inativas, para o histórico), as áreas comuns e o nome do
   * agrupamento ("Bloco"/"Torre"), que o front usa nos rótulos. Exige sessão, como o resto (o Layout o carrega).
   */
  async catalogo() {
    const [unidades, areasComuns, pontosAcesso] = await Promise.all([
      this.db.select(colunas).from(unidade).orderBy(...ORDEM_UNIDADES),
      this.db.select({ id: areaComum.id, nome: areaComum.nome, ativo: areaComum.ativo }).from(areaComum).orderBy(asc(areaComum.nome), asc(areaComum.id)),
      this.db.select({ id: pontoAcesso.id, nome: pontoAcesso.nome, ativo: pontoAcesso.ativo }).from(pontoAcesso).orderBy(asc(pontoAcesso.nome), asc(pontoAcesso.id)),
    ]);
    return {
      agrupamento: this.estrutura.agrupamento,
      unidades: unidades.map((u): UnidadeCatalogo => ({ ...u, codigo: codigoUnidade(u), rotulo: rotuloUnidade(u, this.estrutura.agrupamento, false) })),
      areasComuns,
      pontosAcesso,
    };
  }

  /**
   * Listagem paginada com o resumo de cada unidade. Contagens por subconsulta correlacionada (uma página tem no máximo
   * 100 unidades; os índices (unidade_id, status) do vínculo cobrem). Nada de JOIN 1:N + count, que infla o total.
   */
  async listar(f: FiltroUnidades): Promise<Pagina<UnidadeResumo>> {
    const agora = this.relogio.agora();
    const hoje = diaBrt(agora);
    const depois = f.cursor ? decodificarCursor(f.cursor, CursorUnidades) : null;
    const filtros: SQL[] = [];
    if (f.bloco !== undefined) filtros.push(eq(unidade.bloco, normalizarBloco(f.bloco)));
    if (depois) {
      filtros.push(sql`(${chaveBlocoSql(unidade.bloco)}, ${unidade.numero}::numeric, ${unidade.numero})
        > (${chaveBlocoSql(sql`${depois.b}::text`)}, ${depois.n}::numeric, ${depois.n})`);
    }
    const valido = vinculoValidoSql(hoje);
    // Referência EXPLÍCITA à linha externa: numa consulta de uma tabela só, o Drizzle escreve as colunas da seleção sem
    // o nome da tabela, e um "id" solto dentro da subconsulta seria o id do vínculo (contagem sempre zero).
    const uid = sql.raw('"unidade"."id"');
    const linhas = await this.db.select({
      ...colunas,
      moradoresValidos: sql<number>`(SELECT count(*) FROM ${vinculoUnidade} WHERE ${vinculoUnidade.unidadeId} = ${uid} AND ${valido})`.mapWith(Number),
      pendentes: sql<number>`(SELECT count(*) FROM ${vinculoUnidade} WHERE ${vinculoUnidade.unidadeId} = ${uid} AND ${vinculoUnidade.status} = 'pendente')`.mapWith(Number),
      restricoes: sql<number>`(SELECT count(*) FROM ${restricao} WHERE ${restricao.unidadeId} = ${uid}
        AND ${restricao.revogadaEm} IS NULL AND ${restricao.validaAte} >= ${agora.toISOString()}::timestamptz)`.mapWith(Number),
      // Há ao menos um vínculo APROVADO e válido (legado não conta como cadastro completo).
      cadastroCompleto: sql<boolean>`EXISTS (SELECT 1 FROM ${vinculoUnidade} WHERE ${vinculoUnidade.unidadeId} = ${uid}
        AND ${vinculoUnidade.status} = 'aprovado' AND ${valido})`.mapWith(Boolean),
    }).from(unidade)
      .where(filtros.length ? and(...filtros) : undefined)
      .orderBy(...ORDEM_UNIDADES)
      .limit(f.limite + 1); // um a mais: diz se há próxima página sem COUNT
    const pagina = linhas.slice(0, f.limite);
    const ultimo = pagina[pagina.length - 1];
    const proximo = linhas.length > f.limite && ultimo ? codificarCursor({ b: ultimo.bloco, n: ultimo.numero }) : null;
    return new Pagina(pagina.map((l) => ({
      unidade: { id: l.id, bloco: l.bloco, numero: l.numero, ativo: l.ativo },
      moradoresValidos: l.moradoresValidos, pendentes: l.pendentes, restricoes: l.restricoes, cadastroCompleto: l.cadastroCompleto,
    })), proximo);
  }

  /** `ref`: uuid ou código legível ("A-32", "a 32", e o antigo "T4-32"), para links legíveis. */
  async porReferencia(ref: string): Promise<UnidadeApi> {
    const uuid = z.uuid().safeParse(ref);
    if (uuid.success) {
      const [u] = await this.db.select(colunas).from(unidade).where(eq(unidade.id, uuid.data));
      if (u) return u;
    } else {
      // Leitura literal primeiro; "T4-32" só cai na torre 4 se não houver bloco "T4" (no máximo duas consultas).
      for (const p of leiturasDoCodigo(ref)) {
        const [u] = await this.db.select(colunas).from(unidade).where(and(eq(unidade.bloco, p.bloco), eq(unidade.numero, p.numero)));
        if (u) return u;
      }
    }
    throw erroApi(404, 'UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada.');
  }

  /**
   * Detalhe da unidade. Só o que já tem módulo na API: a unidade, os vínculos (todos os status) e os
   * veículos ativos. Autorizações, restrições e eventos chegam com os respectivos módulos (o front mostra "disponível em
   * breve" por seção).
   */
  async detalhe(ref: string) {
    const u = await this.porReferencia(ref);
    const [veiculos, vinculos] = await Promise.all([
      this.db.select({ id: veiculo.id, unidadeId: veiculo.unidadeId, placa: veiculo.placa, modelo: veiculo.modelo, cor: veiculo.cor, ativo: veiculo.ativo })
        .from(veiculo).where(and(eq(veiculo.unidadeId, u.id), eq(veiculo.ativo, true))).orderBy(asc(veiculo.placa)),
      carregarVinculos(this.db, eq(vinculoUnidade.unidadeId, u.id), diaBrt(this.relogio.agora())),
    ]);
    return { unidade: u, veiculos, vinculos };
  }

  /** "BLOCO A · AP 32", com o agrupamento configurado (mensagens que citam a unidade). */
  rotulo(u: { bloco: string; numero: string }, caixaAlta = true) {
    return rotuloUnidade(u, this.estrutura.agrupamento, caixaAlta);
  }

  /** Normaliza ("a" -> "A", "3" -> "03") e valida com a regra do domain (a mesma dos CHECKs). */
  private normalizar(i: { bloco: string; numero: string }) {
    const n = { bloco: normalizarBloco(i.bloco), numero: normalizarNumero(i.numero) };
    const erro = validarEstruturaUnidade(n.bloco, n.numero, this.estrutura.agrupamento);
    if (erro) throw erroApi(422, 'UNIDADE_INVALIDA', erro);
    return n;
  }

  private duplicada(u: { bloco: string; numero: string }) {
    return erroApi(409, 'UNIDADE_DUPLICADA', `Já existe a unidade ${codigoUnidade(u)} (ativa ou desativada).`);
  }

  /** Trava a unidade com FOR UPDATE: conflita com o FOR KEY SHARE que o INSERT de quem a referencia (FK) toma. */
  private async travar(tx: Tx, id: string): Promise<UnidadeApi> {
    const [u] = await tx.select(colunas).from(unidade).where(eq(unidade.id, id)).for('update');
    if (!u) throw erroApi(404, 'UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada.');
    return u;
  }

  /** Qualquer registro que aponte para a unidade (inclusive correção de evento que a cite como novo destino). */
  private async referenciada(tx: Tx, id: string): Promise<boolean> {
    const res = (await tx.execute(sql`SELECT (
         EXISTS (SELECT 1 FROM ${vinculoUnidade} WHERE ${vinculoUnidade.unidadeId} = ${id})
      OR EXISTS (SELECT 1 FROM ${veiculo} WHERE ${veiculo.unidadeId} = ${id})
      OR EXISTS (SELECT 1 FROM ${autorizacaoPrevia} WHERE ${autorizacaoPrevia.unidadeId} = ${id})
      OR EXISTS (SELECT 1 FROM ${restricao} WHERE ${restricao.unidadeId} = ${id})
      OR EXISTS (SELECT 1 FROM ${encomenda} WHERE ${encomenda.unidadeId} = ${id})
      OR EXISTS (SELECT 1 FROM ${ocorrencia} WHERE ${ocorrencia.unidadeId} = ${id})
      OR EXISTS (SELECT 1 FROM ${eventoAcesso} WHERE ${eventoAcesso.unidadeDestinoId} = ${id})
      OR EXISTS (SELECT 1 FROM ${eventoAcesso} WHERE ${eventoAcesso.correcaoValores} ->> 'unidade_destino_id' = ${id}::text)
    ) AS sim`)) as unknown as { rows: { sim: boolean | string }[] };
    const sim = res.rows[0]?.sim;
    return sim === true || sim === 't';
  }

  async criar(ctx: Contexto, i: { bloco: string; numero: string }): Promise<UnidadeApi> {
    const n = this.normalizar(i);
    const agora = this.relogio.agora();
    try {
      return await this.db.transaction(async (tx) => {
        const [nova] = await tx.insert(unidade).values({ ...n, criadoEm: agora, atualizadoEm: agora }).returning(colunas);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'unidade.criar', entidade: 'unidade', registroId: nova!.id, depois: nova });
        return nova!;
      });
    } catch (e) {
      if (codigoPg(e) === '23505') throw this.duplicada(n);
      throw e;
    }
  }

  async editar(ctx: Contexto, id: string, i: { bloco: string; numero: string }): Promise<UnidadeApi> {
    const n = this.normalizar(i);
    const agora = this.relogio.agora();
    try {
      return await this.db.transaction(async (tx) => {
        const antes = await this.travar(tx, id);
        if (antes.bloco === n.bloco && antes.numero === n.numero) return antes; // nada mudou: sem auditoria
        // Duplicata antes da checagem de referência (a mensagem mais útil primeiro).
        const [outra] = await tx.select({ id: unidade.id }).from(unidade)
          .where(and(eq(unidade.bloco, n.bloco), eq(unidade.numero, n.numero)));
        if (outra) throw this.duplicada(n);
        if (await this.referenciada(tx, id)) {
          throw erroApi(422, 'UNIDADE_REFERENCIADA',
            `A ${codigoUnidade(antes)} já tem registros (vínculos, acessos, encomendas...). Desative-a e cadastre a unidade correta.`);
        }
        const [depois] = await tx.update(unidade).set({ ...n, atualizadoEm: agora }).where(eq(unidade.id, id)).returning(colunas);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'unidade.editar', entidade: 'unidade', registroId: id, antes, depois });
        return depois!;
      });
    } catch (e) {
      if (codigoPg(e) === '23505') throw this.duplicada(n); // corrida com outra criação
      throw e;
    }
  }

  private alternar(ctx: Contexto, id: string, ativo: boolean): Promise<UnidadeApi> {
    const agora = this.relogio.agora();
    return this.db.transaction(async (tx) => {
      const antes = await this.travar(tx, id);
      if (antes.ativo === ativo) {
        throw ativo ? erroApi(409, 'UNIDADE_JA_ATIVA', 'A unidade já está ativa.') : erroApi(409, 'UNIDADE_JA_INATIVA', 'A unidade já está desativada.');
      }
      const [depois] = await tx.update(unidade).set({ ativo, atualizadoEm: agora }).where(eq(unidade.id, id)).returning(colunas);
      await this.auditoria.registrar(tx, {
        ator: ctx.ator, ip: ctx.ip, acao: ativo ? 'unidade.reativar' : 'unidade.desativar', entidade: 'unidade', registroId: id, antes, depois,
      });
      return depois!;
    });
  }

  desativar(ctx: Contexto, id: string) { return this.alternar(ctx, id, false); }
  reativar(ctx: Contexto, id: string) { return this.alternar(ctx, id, true); }

  /**
   * Para os próximos módulos (vínculo, entrada, encomenda, autorização, veículo): a unidade de um NOVO uso precisa estar
   * ativa (422 UNIDADE_INATIVA). Chamar dentro da transação da escrita: o FOR SHARE segura a desativação concorrente
   * (que pede FOR UPDATE) até o commit, então não existe "desativou no meio".
   */
  async paraNovoUso(exec: Executor, id: string): Promise<UnidadeApi> {
    const [u] = await exec.select(colunas).from(unidade).where(eq(unidade.id, id)).for('share');
    if (!u) throw erroApi(404, 'UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada.');
    if (!u.ativo) throw erroApi(422, 'UNIDADE_INATIVA', `A unidade ${codigoUnidade(u)} está desativada.`);
    return u;
  }
}
