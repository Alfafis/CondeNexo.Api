// Relatórios (RF-30, RF-31; spec §6.5): o resumo do período, pelos VALORES EFETIVOS (com
// correção), agregado no banco (GROUP BY por dia, tipo, meio, responsável e retroativo: poucas linhas, mesmo num ano).
// O CSV usa o construtor do domain (../dominio/relatorio). Permissão: relatorio.ver (SI, AD, AU).
// Período em dias de calendário BRT ('AAAA-MM-DD'); sem período: os últimos 30 dias até hoje; no máximo 366 dias.
import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { csvRelatorio, FAIXAS_ENCOMENDA, PERIODO_MAX_RELATORIO_DIAS, type ResumoRelatorio } from '../dominio/relatorio';
import { DIA, fimDoDia } from '../dominio/time';
import type { MeioAutorizacao } from '../dominio/types';
import { codigoUnidade } from '../dominio/units';
import { and, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { Acao } from '../auth/decorators';
import { diaBrt, ehDiaValido, inicioDoDiaBrt, somarDias } from '../comum/datas';
import { erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { ZodPipe } from '../comum/zod.pipe';
import { DB, type Db } from '../database/database.module';
import { categoriaPessoa, encomenda, meioAutorizacao, unidade, usuarioSistema, vinculoUnidade } from '../db/schema';
import { corrigidosComSql, efetivoSql, responsavelExcecaoSql } from '../eventos/efetivo';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';
import { Modulo } from '../saas/modulo.guard';

const Dia = z.string().refine(ehDiaValido, { message: 'data inválida (AAAA-MM-DD)' });
export const FiltroRelatorioDto = z.strictObject({
  de: Dia.optional(), ate: Dia.optional(), unidadeId: z.uuid().optional(),
  categoria: z.enum(categoriaPessoa.enumValues).optional(), meio: z.enum(meioAutorizacao.enumValues).optional(),
});
type Filtro = z.infer<typeof FiltroRelatorioDto>;

interface Grupo { dia: string; tipo: string; meio: MeioAutorizacao | null; resp: string | null; retroativo: boolean; n: number; s: number }

@Injectable()
export class RelatoriosService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(RELOGIO) private readonly relogio: Relogio) {}

  async resumo(f: Filtro): Promise<ResumoRelatorio> {
    const n = this.relogio.agora().getTime();
    const hoje = diaBrt(new Date(n));
    const ateDia = f.ate ?? hoje;
    const deDia = f.de ?? somarDias(hoje, -29);
    if (deDia > ateDia) throw erroApi(422, 'PERIODO_INVALIDO', 'A data inicial não pode ser posterior à final.');
    const de = inicioDoDiaBrt(deDia).getTime();
    const ate = fimDoDia(inicioDoDiaBrt(ateDia).getTime());
    if ((ate - de) / DIA > PERIODO_MAX_RELATORIO_DIAS) throw erroApi(422, 'PERIODO_LONGO', `O período máximo do relatório é de ${PERIODO_MAX_RELATORIO_DIAS} dias.`);
    const deIso = new Date(de).toISOString();
    const ateIso = new Date(ate).toISOString();

    const filtros: SQL[] = [sql`ef.quando BETWEEN ${deIso}::timestamptz AND ${ateIso}::timestamptz`];
    if (f.unidadeId) filtros.push(sql`ef.unidade = ${f.unidadeId}::uuid`);
    if (f.categoria) filtros.push(sql`ef.categoria_pessoa = ${f.categoria}`);
    if (f.meio) filtros.push(sql`ef.meio = ${f.meio}`);
    const res = (await this.db.execute(sql`
      WITH ef AS (
        SELECT e.seq, e.tipo::text AS tipo, e.categoria_pessoa::text AS categoria_pessoa, e.autorizado_por_tipo::text AS meio, e.retroativo,
          ${efetivoSql('ocorrido_em', 'e')} AS quando, ${efetivoSql('unidade_destino_id', 'e')} AS unidade, ${responsavelExcecaoSql('e')} AS resp
        FROM evento_acesso e
        WHERE e.tipo IN ('entrada', 'negado', 'recusado')
          AND (e.ocorrido_em BETWEEN ${deIso}::timestamptz AND ${ateIso}::timestamptz OR e.id IN ${corrigidosComSql('ocorrido_em')})
      )
      SELECT (ef.quando AT TIME ZONE 'UTC' - interval '3 hours')::date::text AS dia, ef.tipo, ef.meio, ef.resp::text AS resp, ef.retroativo,
        count(*)::int AS n, min(ef.seq)::float8 AS s
      FROM ef WHERE ${sql.join(filtros, sql` AND `)}
      GROUP BY 1, 2, 3, 4, 5`)) as unknown as { rows: Grupo[] };
    const grupos = res.rows.map((g) => ({ ...g, n: Number(g.n), s: Number(g.s), retroativo: g.retroativo === true || (g.retroativo as unknown) === 't' }));

    const porDia = new Map<string, number>();
    for (let d = deDia; d <= ateDia; d = somarDias(d, 1)) porDia.set(d, 0);
    const meios = new Map<MeioAutorizacao, { total: number; s: number }>();
    const exc = new Map<string, { total: number; s: number }>();
    const tot = { entradas: 0, negados: 0, recusados: 0, retroativos: 0, excecoes: 0 };
    const somar = <K>(m: Map<K, { total: number; s: number }>, k: K, g: { n: number; s: number }) => {
      const a = m.get(k);
      m.set(k, a ? { total: a.total + g.n, s: Math.min(a.s, g.s) } : { total: g.n, s: g.s });
    };
    for (const g of grupos) {
      if (g.tipo === 'negado') tot.negados += g.n;
      if (g.tipo === 'recusado') tot.recusados += g.n;
      if (g.tipo !== 'entrada') continue;
      tot.entradas += g.n;
      porDia.set(g.dia, (porDia.get(g.dia) ?? 0) + g.n);
      if (g.meio) somar(meios, g.meio, g);
      if (g.retroativo) tot.retroativos += g.n;
      if (g.resp) { tot.excecoes += g.n; somar(exc, g.resp, g); }
    }
    // Empate no total: a ordem de primeira aparição na cadeia (segue o seq).
    const ordenar = <K>(m: Map<K, { total: number; s: number }>) => [...m].sort((a, b) => b[1].total - a[1].total || a[1].s - b[1].s);
    const respIds = [...exc.keys()];
    const nomes = new Map((respIds.length ? await this.db.select({ id: usuarioSistema.id, nome: usuarioSistema.nome }).from(usuarioSistema)
      .where(inArray(usuarioSistema.id, respIds)) : []).map((u) => [u.id, u.nome]));

    const pend = await this.db.select({ em: encomenda.recebidaEm }).from(encomenda)
      .where(and(isNull(encomenda.retiradaEm), f.unidadeId ? eq(encomenda.unidadeId, f.unidadeId) : undefined));
    const [ativas] = await this.db.select({ n: count() }).from(unidade).where(eq(unidade.ativo, true));
    const [completas] = await this.db.select({ n: sql<number>`count(DISTINCT ${vinculoUnidade.unidadeId})`.mapWith(Number) }).from(vinculoUnidade)
      .innerJoin(unidade, eq(unidade.id, vinculoUnidade.unidadeId))
      .where(and(eq(unidade.ativo, true), eq(vinculoUnidade.status, 'aprovado'), vinculoValidoSql(hoje)));

    return {
      periodo: { de, ate },
      acessosPorDia: [...porDia].map(([dia, entradas]) => ({ dia: inicioDoDiaBrt(dia).getTime(), entradas })),
      acessosPorMeio: ordenar(meios).map(([meio, v]) => ({ meio, total: v.total })),
      excecoesPorPorteiro: ordenar(exc).map(([operadorId, v]) => ({ operadorId, operador: nomes.get(operadorId) ?? '?', total: v.total })),
      encomendasPorIdade: FAIXAS_ENCOMENDA.map(([faixa, min, max]) => ({
        faixa, total: pend.filter((e) => { const dd = Math.floor((n - e.em.getTime()) / DIA); return dd >= min && dd <= max; }).length,
      })),
      cadastroCompleto: { unidadesCompletas: completas?.n ?? 0, total: Number(ativas?.n ?? 0) },
      totais: tot,
    };
  }

  async csv(f: Filtro) {
    const r = await this.resumo(f);
    let codigo: string | undefined;
    if (f.unidadeId) {
      const [u] = await this.db.select().from(unidade).where(eq(unidade.id, f.unidadeId));
      codigo = u ? codigoUnidade(u) : f.unidadeId;
    }
    return csvRelatorio(r, { unidade: codigo, categoria: f.categoria, meio: f.meio }, diaBrt(this.relogio.agora()));
  }
}

@Modulo('relatorios')
@Controller('relatorios')
export class RelatoriosController {
  constructor(@Inject(RelatoriosService) private readonly servico: RelatoriosService) {}

  @Get('resumo')
  @Acao('relatorio.ver')
  resumo(@Query(new ZodPipe(FiltroRelatorioDto)) q: Filtro) { return this.servico.resumo(q); }

  /** `{ nomeArquivo, conteudo, quantidade }` (UTF-8 com BOM, separador ";"). */
  @Get('resumo/csv')
  @Acao('relatorio.ver')
  csv(@Query(new ZodPipe(FiltroRelatorioDto)) q: Filtro) { return this.servico.csv(q); }
}

@Module({ controllers: [RelatoriosController], providers: [RelatoriosService] })
export class RelatoriosModule {}
