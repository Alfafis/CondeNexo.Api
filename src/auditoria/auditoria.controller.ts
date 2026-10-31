// Auditoria (spec §4.5, §4.7, §6.6; RF-32, RF-37, RNF-01): verificação de integridade da trilha de acessos no banco real,
// exportação verificável (JSONL, manifesto v2, formato definido em ../dominio/exportacao) e a trilha de
// alterações (audit_log) paginada. Permissões: auditoria.verificar e auditoria.exportar (SI, AD, AU).
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post, Query } from '@nestjs/common';
import { montarExportacaoJsonl } from '../dominio/exportacao';
import { hashGenese, verificarCadeia, type Ancora, type ResultadoVerificacao } from '../dominio/hashChain';
import { codigoUnidade } from '../dominio/units';
import { and, asc, desc, eq, gt, gte, inArray, like, lt, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { erroApi } from '../comum/erros';
import { codificarCursor, decodificarCursor, Pagina, PaginacaoDto } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { ZodPipe } from '../comum/zod.pipe';
import { DB, type Db } from '../database/database.module';
import { paraExportacao } from '../db/cadeia';
import { areaComum, auditLog, eventoAcesso, eventoAcessoCadeia, pessoa, seloCadeia, unidade, usuarioSistema } from '../db/schema';
import { AcessoModule, FiltrosCorpo } from '../eventos/acesso.module';
import { EventosService } from '../eventos/eventos.service';
import { CONDOMINIO, type CondominioResolvido } from '../saas/condominio';
import { AuditoriaService } from './auditoria.service';

/** Lote da verificação: a cadeia inteira não cabe na memória do container (384 MiB em produção). */
const LOTE_VERIFICACAO = 2000;
/** Teto de uma exportação (~1 KB por evento): acima disso, o pedido precisa de um período menor. */
export const TETO_EXPORTACAO = 20_000;

const unicos = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];
const isoSP = (ms: number) => new Date(ms - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
const carimboSP = (ms: number) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export interface ResultadoIntegridadeApi extends ResultadoVerificacao {
  /** Selos diários conferidos contra o hash do evento no seq selado. */
  selosConferidos: number;
}

const AlteracoesDto = PaginacaoDto.extend({
  de: z.coerce.number().int().min(0).optional(),
  ate: z.coerce.number().int().min(0).optional(),
  usuarioId: z.uuid().optional(),
  acao: z.string().regex(/^[a-z][a-zA-Z_]*\.[a-z][a-zA-Z_]*$/).optional(),
  entidade: z.string().regex(/^[a-z_]{1,40}$/).optional(),
});
const CursorSeq = z.strictObject({ s: z.number().int().positive() });

/** Período (ms, como em /auditoria/alteracoes) e paginação. */
const AcessosPlataformaDto = PaginacaoDto.extend({
  de: z.coerce.number().int().min(0).optional(),
  ate: z.coerce.number().int().min(0).optional(),
});

/**
 * Ações que o app do Master grava na trilha do condomínio (SAAS-09 e §5.5; src/master/acesso-plataforma.service.ts):
 * leitura, exportação e a gestão de síndicos.
 */
export const ACOES_PLATAFORMA_TRILHA = [
  'plataforma.ler', 'plataforma.exportar', 'plataforma.usuario_criar', 'plataforma.usuario_trocar', 'plataforma.usuario_redefinir_senha',
  'plataforma.usuario_desativar', 'plataforma.usuario_reativar',
] as const;

/**
 * Um acesso do Master aos dados deste condomínio: quando, quem, o quê e por qual rota (sem corpo nem filtros). Nas
 * ações sobre síndicos (§5.5), também o motivo escrito pelo Master e o usuário afetado (`alvo`: "Nome (login)").
 */
export interface AcessoPlataformaApi {
  id: string;
  em: number;
  quem: string;
  acao: string;
  entidade: string;
  registroId: string | null;
  rota: string | null;
  metodo: string | null;
  status: number | null;
  /** Só nas ações sobre síndicos. */
  motivo: string | null;
  alvo: string | null;
  /** Na troca: `entrou` (o novo síndico) ou `saiu` (o substituído). */
  troca: string | null;
}

const texto = (v: unknown) => (typeof v === 'string' ? v : null);

@Injectable()
export class AuditoriaRotasService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(EventosService) private readonly eventos: EventosService,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
  ) {}

  /**
   * RF-37 / spec §4.5: recalcula a cadeia a partir da serialização canônica do domain (a mesma do trigger), em lotes.
   * Âncora: gênese (seq 1) ou, depois de um descarte por retenção, o selo no seq de corte. Depois confere a cabeça
   * (evento_acesso_cadeia: pega remoção no FIM da cadeia) e cada selo diário (pega a cadeia recalculada inteira).
   */
  async verificarIntegridade(): Promise<ResultadoIntegridadeApi> {
    const [cab] = await this.db.select().from(eventoAcessoCadeia).where(eq(eventoAcessoCadeia.id, 1));
    const [primeiro] = await this.db.select({ seq: eventoAcesso.seq }).from(eventoAcesso).orderBy(asc(eventoAcesso.seq)).limit(1);
    const genese: Ancora = { seq: 0, hash: await hashGenese() };
    let ancora = genese;
    if (primeiro && primeiro.seq > 1) {
      const [selo] = await this.db.select().from(seloCadeia).where(eq(seloCadeia.ultimoSeq, primeiro.seq - 1));
      if (selo) ancora = { seq: selo.ultimoSeq, hash: selo.ultimoHash }; // sem selo no corte: a lacuna aparece logo no primeiro
    } else if (!primeiro && cab && cab.ultimoSeq > 0) {
      const [selo] = await this.db.select().from(seloCadeia).where(eq(seloCadeia.ultimoSeq, cab.ultimoSeq));
      if (selo) ancora = { seq: selo.ultimoSeq, hash: selo.ultimoHash };
    }
    let verificados = 0;
    for (;;) {
      // Até a cabeça lida no início: eventos gravados durante a verificação ficam para a próxima (sem falso alarme).
      const ate = cab ? lte(eventoAcesso.seq, cab.ultimoSeq) : undefined;
      const lote = await this.db.select().from(eventoAcesso).where(and(gt(eventoAcesso.seq, ancora.seq), ate))
        .orderBy(asc(eventoAcesso.seq)).limit(LOTE_VERIFICACAO);
      if (!lote.length) break;
      const r = await verificarCadeia(lote.map(paraExportacao), ancora);
      if (!r.valido) return { ...r, verificados: verificados + r.verificados, selosConferidos: 0 };
      verificados += r.verificados;
      ancora = { seq: r.ultimoSeq, hash: r.ultimoHash };
      if (lote.length < LOTE_VERIFICACAO) break;
    }
    const base = { verificados, ultimoSeq: ancora.seq, ultimoHash: ancora.hash };
    // Cabeça: o último evento verificado tem de ser o último que o trigger encadeou.
    if (cab && (cab.ultimoSeq !== ancora.seq || cab.ultimoHash !== ancora.hash)) {
      return { valido: false, ...base, primeiroSeqInvalido: ancora.seq + 1, motivo: 'lacuna_de_seq', selosConferidos: 0 };
    }
    // Selos: o hash selado precisa ser o do evento naquele seq (enquanto o evento existir).
    const selos = await this.db.select().from(seloCadeia)
      .where(and(gte(seloCadeia.ultimoSeq, primeiro?.seq ?? 1), lte(seloCadeia.ultimoSeq, ancora.seq))).orderBy(asc(seloCadeia.ultimoSeq));
    let conferidos = 0;
    for (let i = 0; i < selos.length; i += 500) {
      const parte = selos.slice(i, i + 500);
      const hashes = new Map((await this.db.select({ seq: eventoAcesso.seq, hash: eventoAcesso.hash, id: eventoAcesso.id }).from(eventoAcesso)
        .where(inArray(eventoAcesso.seq, parte.map((s) => s.ultimoSeq)))).map((e) => [e.seq, e]));
      for (const s of parte) {
        const e = hashes.get(s.ultimoSeq);
        if (!e || e.hash !== s.ultimoHash) {
          return { valido: false, ...base, primeiroSeqInvalido: s.ultimoSeq, primeiroEventoIdInvalido: e?.id, motivo: 'selo_divergente', selosConferidos: conferidos };
        }
        conferidos++;
      }
    }
    return { valido: true, ...base, selosConferidos: conferidos };
  }

  /** RF-32: JSONL do período (ou de um evento isolado), no formato de ../dominio/exportacao. Grava a exportação no audit_log. */
  async exportar(ctx: Contexto, f: z.infer<typeof FiltrosCorpo>) {
    const pacote = await this.gerarExportacao(f, ctx.ator.nome);
    await this.auditoria.registrar(this.db, {
      ator: ctx.ator, ip: ctx.ip, acao: 'auditoria.exportar', entidade: 'evento_acesso', registroId: f.eventoId ?? null,
      // Sem o texto dos filtros de nome e placa (podem identificar alguém): só se ele foi usado.
      depois: { modo: f.eventoId ? 'evento_isolado' : 'trilha', quantidade: pacote.quantidade, filtros: { ...f, pessoa: f.pessoa ? '(nome)' : undefined, placa: f.placa ? '(placa)' : undefined } },
    });
    return pacote;
  }

  /**
   * O pacote JSONL, sem gravar trilha: quem chama registra (o usuário do condomínio como `auditoria.exportar`; o app do
   * Master como `plataforma.exportar`, pelo AcessoPlataformaService). `geradoPor` vai no manifesto.
   */
  async gerarExportacao(f: z.infer<typeof FiltrosCorpo>, geradoPor: string) {
    const linhas = await this.eventos.linhas(f, TETO_EXPORTACAO);
    const isolado = !!f.eventoId;
    if (isolado && linhas.length === 0) throw erroApi(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado.');
    if (linhas.length > TETO_EXPORTACAO) {
      throw erroApi(422, 'EXPORTACAO_GRANDE', `A exportação passa de ${TETO_EXPORTACAO.toLocaleString('pt-BR')} eventos. Escolha um período menor.`);
    }
    const [ps, us, uns, ars] = await Promise.all([
      this.nomes(pessoa, unicos(linhas.map((l) => l.pessoaId))),
      this.nomes(usuarioSistema, unicos(linhas.map((l) => l.operadorId))),
      (async () => { const ids = unicos(linhas.map((l) => l.unidadeDestinoId)); return new Map((ids.length ? await this.db.select().from(unidade).where(inArray(unidade.id, ids)) : []).map((u) => [u.id, codigoUnidade(u)])); })(),
      this.nomes(areaComum, unicos(linhas.map((l) => l.areaComumId))),
    ]);
    const n = this.relogio.agora().getTime();
    const pacote = await montarExportacaoJsonl({
      eventos: linhas.map(paraExportacao), filtros: { ...f }, isolado,
      exibicao: (e) => ({
        pessoa: ps.get(e.pessoa_id!) ?? null, unidade: e.unidade_destino_id ? uns.get(e.unidade_destino_id) ?? null : null,
        areaComum: e.area_comum_id ? ars.get(e.area_comum_id) ?? null : null, operador: us.get(e.operador_id!) ?? null,
      }),
      geradoPor, condominio: this.condominio?.nome ?? null, geradoEm: isoSP(n), carimbo: carimboSP(n),
      observacao: 'Arquivo de hashes para verificação, gerado pela API a partir do banco. Não há assinatura digital nem âncora externa neste arquivo.',
    });
    return pacote;
  }

  private async nomes(t: typeof pessoa | typeof usuarioSistema | typeof areaComum, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const ls = await this.db.select({ id: t.id, nome: t.nome }).from(t).where(inArray(t.id, ids));
    return new Map(ls.map((l) => [l.id, l.nome]));
  }

  /** Trilha de alterações (audit_log), mais recentes primeiro. Os snapshots já estão sem dado pessoal em claro. */
  async alteracoes(f: z.infer<typeof AlteracoesDto>) {
    const w: SQL[] = [];
    if (f.de !== undefined) w.push(gte(auditLog.em, new Date(f.de)));
    if (f.ate !== undefined) w.push(lte(auditLog.em, new Date(f.ate)));
    if (f.usuarioId) w.push(eq(auditLog.usuarioId, f.usuarioId));
    if (f.acao) w.push(eq(auditLog.acao, f.acao));
    if (f.entidade) w.push(eq(auditLog.entidade, f.entidade));
    if (f.cursor) w.push(lt(auditLog.seq, decodificarCursor(f.cursor, CursorSeq).s));
    const ls = await this.db.select().from(auditLog).where(w.length ? and(...w) : undefined).orderBy(desc(auditLog.seq)).limit(f.limite + 1);
    const pagina = ls.slice(0, f.limite);
    const ultimo = pagina[pagina.length - 1];
    return new Pagina(pagina.map((r) => ({
      id: r.id, seq: r.seq, em: r.em.getTime(), usuarioId: r.usuarioId, usuarioNome: r.usuarioNome, usuarioPapel: r.usuarioPapel,
      acao: r.acao, entidade: r.entidade, registroId: r.registroId, redigidoEm: r.redigidoEm ? r.redigidoEm.getTime() : null,
      // Snapshots do audit_log: sempre objeto JSON (já sem dado pessoal em claro) ou null.
      antes: r.antes as Record<string, unknown> | null, depois: r.depois as Record<string, unknown> | null,
    })), ls.length > f.limite && ultimo ? codificarCursor({ s: ultimo.seq }) : null);
  }

  /**
   * "Acessos da plataforma" (SAAS-09): as linhas `plataforma.*` da trilha, mais recentes primeiro. Só o que a tela
   * mostra (o `master_usuario_id` do `depois` é da plataforma e não sai). O filtro por período usa o índice de `em`;
   * as linhas da plataforma são poucas perto do resto da trilha (uma por consulta do Master).
   */
  async acessosPlataforma(f: z.infer<typeof AcessosPlataformaDto>): Promise<Pagina<AcessoPlataformaApi>> {
    const w: SQL[] = [like(auditLog.acao, 'plataforma.%')];
    if (f.de !== undefined) w.push(gte(auditLog.em, new Date(f.de)));
    if (f.ate !== undefined) w.push(lte(auditLog.em, new Date(f.ate)));
    if (f.cursor) w.push(lt(auditLog.seq, decodificarCursor(f.cursor, CursorSeq).s));
    const ls = await this.db.select({
      id: auditLog.id, seq: auditLog.seq, em: auditLog.em, usuarioNome: auditLog.usuarioNome, acao: auditLog.acao, entidade: auditLog.entidade,
      registroId: auditLog.registroId, depois: auditLog.depois,
    }).from(auditLog).where(and(...w)).orderBy(desc(auditLog.seq)).limit(f.limite + 1);
    const pagina = ls.slice(0, f.limite);
    const ultimo = pagina[pagina.length - 1];
    return new Pagina(pagina.map((r): AcessoPlataformaApi => {
      const d = (r.depois ?? {}) as Record<string, unknown>;
      const u = (d.usuario ?? null) as { nome?: unknown; login?: unknown } | null;
      return {
        id: r.id, em: r.em.getTime(), quem: r.usuarioNome, acao: r.acao, entidade: r.entidade, registroId: r.registroId,
        rota: texto(d.rota), metodo: texto(d.metodo), status: typeof d.status === 'number' ? d.status : null,
        motivo: texto(d.motivo), alvo: u && texto(u.nome) ? `${texto(u.nome)}${texto(u.login) ? ` (${texto(u.login)})` : ''}` : null,
        troca: texto(d.troca),
      };
    }), ls.length > f.limite && ultimo ? codificarCursor({ s: ultimo.seq }) : null);
  }
}

@Controller('auditoria')
export class AuditoriaController {
  constructor(@Inject(AuditoriaRotasService) private readonly servico: AuditoriaRotasService) {}

  @Get('integridade')
  @Acao('auditoria.verificar')
  integridade() { return this.servico.verificarIntegridade(); }

  /** Gera o arquivo na hora (síncrono) e devolve { nomeArquivo, conteudo, quantidade }. Filtros no corpo (o nome é texto). */
  @Post('exportacoes')
  @Acao('auditoria.exportar')
  @HttpCode(200)
  exportar(@Ctx() ctx: Contexto, @Body(new ZodPipe(FiltrosCorpo)) b: z.infer<typeof FiltrosCorpo>) { return this.servico.exportar(ctx, b); }

  @Get('alteracoes')
  @Acao('auditoria.verificar')
  alteracoes(@Query(new ZodPipe(AlteracoesDto)) q: z.infer<typeof AlteracoesDto>) { return this.servico.alteracoes(q); }

  /** Leituras do app do Master nos dados deste condomínio (SAAS-09). Só leitura: a trilha é append-only. */
  @Get('acessos-plataforma')
  @Acao('auditoria.acessos_plataforma')
  acessosPlataforma(@Query(new ZodPipe(AcessosPlataformaDto)) q: z.infer<typeof AcessosPlataformaDto>) { return this.servico.acessosPlataforma(q); }
}

@Module({ imports: [AcessoModule], controllers: [AuditoriaController], providers: [AuditoriaRotasService] })
export class AuditoriaRotasModule {}
