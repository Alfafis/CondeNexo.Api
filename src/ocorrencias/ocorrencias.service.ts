// M4 — Ocorrências (RF-27, RF-28; spec §6.5). Regras: nasce aberta; o status só anda
// para a frente (aberta -> em andamento -> encerrada) e encerrada é final; o porteiro só altera a ocorrência que ele
// mesmo abriu (403 SO_PROPRIA_OCORRENCIA, gravado em acesso.negado pelo filtro global). O trigger `ocorrencia_transicao`
// repete a máquina de estados no banco (a API checa antes, com a linha travada, para responder 409/422 legível).
//
// Vincular eventos (RF-28) é ADITIVO: `ocorrencia_evento` só aceita INSERT para o app_rw (sem DELETE), então não existe
// "substituir a lista" (o PUT da spec virou POST). Vínculo repetido é ignorado.
//
// Anexos (RNF-03, spec §9.2): conteúdo cifrado fora do banco (CofreDocumentos). Tipo decidido pelos primeiros bytes
// (JPEG, PNG ou PDF), até 4 MiB, até 5 por ocorrência. O nome original do arquivo NÃO é guardado (pode identificar
// alguém, e não há coluna para ele): a tela mostra "anexo-1.pdf". O conteúdo só sai para quem tem `documento.ver`
// (síndico e administração, RN-10), e cada leitura grava `documento.ler` no audit_log.
import { Inject, Injectable } from '@nestjs/common';
import { codigoUnidade } from '../dominio/units';
import { ANEXO_MAX_BYTES, ANEXO_MAX_POR_OCORRENCIA, ANEXO_TIPOS, tipoAnexoPorConteudo } from '../dominio/rules';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { AcessoNegado, codigoPg, erroApi } from '../comum/erros';
import { codificarCursor, decodificarCursor, Pagina } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { transacaoComRetry } from '../comum/transacao';
import { DB, type Db, type Executor, type Tx } from '../database/database.module';
import { documento, eventoAcesso, ocorrencia, ocorrenciaAnexo, ocorrenciaEvento, ocorrenciaStatusHistorico, unidade, usuarioSistema } from '../db/schema';
import { CofreDocumentos } from '../documentos/cofre';
import { CursorOcorrencias, ListarOcorrenciasDto, NovaDto } from './ocorrencias.schemas';
import type { ArquivoEnviado, OcorrenciaViewApi, Status } from './ocorrencias.types';

const PROXIMO: Record<Status, Status | null> = { aberta: 'em_andamento', em_andamento: 'encerrada', encerrada: null };
const BRT_MS = 3 * 3600 * 1000;

/** "OC-2026-047": ano (BRT) da abertura + `numero` (identity). */
export const codigoOcorrencia = (numero: number, abertaEm: Date) =>
  `OC-${new Date(abertaEm.getTime() - BRT_MS).getUTCFullYear()}-${String(numero).padStart(3, '0')}`;

/**
 * "anexo-1a2b3c4d.pdf": prefixo do id do documento (estável: não depende da ordem nem de empate de horário) e a extensão
 * do tipo detectado. Nada do nome original.
 */
const nomeAnexo = (id: string, mime: string) => `anexo-${id.slice(0, 8)}.${ANEXO_TIPOS[mime as keyof typeof ANEXO_TIPOS] ?? 'bin'}`;
/** Ordem do histórico no empate de horário: a da máquina de estados (cada transição sai do status anterior). */
const ORDEM_STATUS: Record<Status, number> = { aberta: 0, em_andamento: 1, encerrada: 2 };

function traduzir(e: unknown): unknown {
  const pg = codigoPg(e);
  // Trigger ocorrencia_transicao (corrida com outra mudança de status): a regra já foi checada com a linha travada
  if (pg === '23514') return erroApi(409, 'OCORRENCIA_ALTERADA', 'A ocorrência mudou ao mesmo tempo. Atualize a tela.');
  if (pg === '23503') return erroApi(422, 'REFERENCIA_INVALIDA', 'Unidade ou evento informado não existe.');
  return e;
}

@Injectable()
export class OcorrenciasService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(CofreDocumentos) private readonly cofre: CofreDocumentos,
  ) {}

  private agora() { return this.relogio.agora(); }

  async views(exec: Executor, linhas: (typeof ocorrencia.$inferSelect)[]): Promise<OcorrenciaViewApi[]> {
    if (linhas.length === 0) return [];
    const ids = linhas.map((o) => o.id);
    const [hist, evs, anexos] = await Promise.all([
      exec.select().from(ocorrenciaStatusHistorico).where(inArray(ocorrenciaStatusHistorico.ocorrenciaId, ids))
        .orderBy(asc(ocorrenciaStatusHistorico.em), asc(ocorrenciaStatusHistorico.id)),
      exec.select({ ocorrenciaId: ocorrenciaEvento.ocorrenciaId, eventoId: ocorrenciaEvento.eventoId }).from(ocorrenciaEvento)
        .where(inArray(ocorrenciaEvento.ocorrenciaId, ids)).orderBy(asc(ocorrenciaEvento.vinculadoEm), asc(ocorrenciaEvento.eventoId)),
      exec.select({
        ocorrenciaId: ocorrenciaAnexo.ocorrenciaId, id: documento.id, mime: documento.mime, tamanhoBytes: documento.tamanhoBytes,
        enviadoEm: documento.enviadoEm, enviadoPorId: documento.enviadoPorId,
      }).from(ocorrenciaAnexo).innerJoin(documento, eq(documento.id, ocorrenciaAnexo.documentoId))
        .where(inArray(ocorrenciaAnexo.ocorrenciaId, ids)).orderBy(asc(documento.enviadoEm), asc(documento.id)),
    ]);
    const usuarioIds = new Set<string>([...linhas.map((o) => o.abertaPorId), ...hist.map((h) => h.porId), ...anexos.map((a) => a.enviadoPorId)]);
    const unidadeIds = [...new Set(linhas.map((o) => o.unidadeId).filter((x): x is string => !!x))];
    const [us, uns] = await Promise.all([
      exec.select({ id: usuarioSistema.id, nome: usuarioSistema.nome }).from(usuarioSistema).where(inArray(usuarioSistema.id, [...usuarioIds])),
      unidadeIds.length ? exec.select({ id: unidade.id, bloco: unidade.bloco, numero: unidade.numero }).from(unidade).where(inArray(unidade.id, unidadeIds)) : [],
    ]);
    const nomeU = new Map(us.map((u) => [u.id, u.nome]));
    const codU = new Map(uns.map((u) => [u.id, codigoUnidade(u)]));
    return linhas.map((o) => {
      const docs = anexos.filter((a) => a.ocorrenciaId === o.id).map((a) => ({
        id: a.id, nome: nomeAnexo(a.id, a.mime), mime: a.mime, tamanhoBytes: a.tamanhoBytes, enviadoEm: a.enviadoEm.getTime(),
        enviadoPorNome: nomeU.get(a.enviadoPorId) ?? '?',
      }));
      return {
        id: o.id, codigo: codigoOcorrencia(o.numero, o.abertaEm), tipo: o.tipo, descricao: o.descricao, unidadeId: o.unidadeId,
        envolvidos: o.envolvidos ?? '', abertaPorId: o.abertaPorId, abertaEm: o.abertaEm.getTime(), status: o.status,
        abertaPorNome: nomeU.get(o.abertaPorId) ?? '?', unidadeCodigo: o.unidadeId ? codU.get(o.unidadeId) ?? '?' : null,
        historicoStatus: hist.filter((h) => h.ocorrenciaId === o.id)
          .sort((x, y) => x.em.getTime() - y.em.getTime() || ORDEM_STATUS[x.de] - ORDEM_STATUS[y.de]).map((h) => ({
          de: h.de, para: h.para, porId: h.porId, em: h.em.getTime(), porNome: nomeU.get(h.porId) ?? '?',
        })),
        eventoIds: evs.filter((e) => e.ocorrenciaId === o.id).map((e) => e.eventoId),
        anexos: docs.map((d) => d.nome), documentos: docs,
      };
    });
  }

  private async view(exec: Executor, id: string) {
    const [o] = await exec.select().from(ocorrencia).where(eq(ocorrencia.id, id));
    if (!o) throw erroApi(404, 'OCORRENCIA_NAO_ENCONTRADA', 'Ocorrência não encontrada.');
    return (await this.views(exec, [o]))[0]!;
  }

  async listar(f: z.infer<typeof ListarOcorrenciasDto>): Promise<Pagina<OcorrenciaViewApi>> {
    const depois = f.cursor ? decodificarCursor(f.cursor, CursorOcorrencias) : null;
    const filtros: SQL[] = [];
    if (f.status?.length) filtros.push(inArray(ocorrencia.status, f.status));
    if (f.tipo) filtros.push(eq(ocorrencia.tipo, f.tipo));
    if (f.unidadeId) filtros.push(eq(ocorrencia.unidadeId, f.unidadeId));
    if (depois) filtros.push(sql`(${ocorrencia.abertaEm}, ${ocorrencia.id}) < (${depois.t}::timestamptz, ${depois.id}::uuid)`);
    const linhas = await this.db.select().from(ocorrencia).where(filtros.length ? and(...filtros) : undefined)
      .orderBy(desc(ocorrencia.abertaEm), desc(ocorrencia.id)).limit(f.limite + 1);
    const pagina = linhas.slice(0, f.limite);
    const ultimo = pagina[pagina.length - 1];
    const proximo = linhas.length > f.limite && ultimo ? codificarCursor({ t: ultimo.abertaEm.toISOString(), id: ultimo.id }) : null;
    return new Pagina(await this.views(this.db, pagina), proximo);
  }

  obter(id: string) { return this.view(this.db, id); }

  async historico(id: string) { return (await this.view(this.db, id)).historicoStatus; }

  /** Eventos que existem (todos os ids pedidos), senão 404. */
  private async conferirEventos(tx: Tx, ids: string[]) {
    if (ids.length === 0) return;
    const achados = await tx.select({ id: eventoAcesso.id }).from(eventoAcesso).where(inArray(eventoAcesso.id, ids));
    if (achados.length !== ids.length) throw erroApi(404, 'EVENTO_NAO_ENCONTRADO', 'Evento vinculado não encontrado.');
  }

  /** RF-27 (abrir) e RF-28 (eventos na abertura, como o link do negado na entrada). */
  async criar(ctx: Contexto, i: z.infer<typeof NovaDto>): Promise<OcorrenciaViewApi> {
    const descricao = i.descricao.trim();
    if (!descricao) throw erroApi(422, 'DESCRICAO_OBRIGATORIA', 'Descreva a ocorrência.');
    const eventoIds = [...new Set(i.eventoIds)];
    try {
      const id = await transacaoComRetry(this.db, async (tx) => {
        // Ocorrência registra um fato: vale também em unidade desativada; só precisa existir.
        if (i.unidadeId) {
          const [u] = await tx.select({ id: unidade.id }).from(unidade).where(eq(unidade.id, i.unidadeId));
          if (!u) throw erroApi(404, 'UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada.');
        }
        await this.conferirEventos(tx, eventoIds);
        const agora = this.agora();
        const [o] = await tx.insert(ocorrencia).values({
          tipo: i.tipo, descricao, unidadeId: i.unidadeId, envolvidos: i.envolvidos.trim() || null, abertaPorId: ctx.ator.id, abertaEm: agora,
          atualizadoEm: agora,
        }).returning();
        if (eventoIds.length) {
          await tx.insert(ocorrenciaEvento).values(eventoIds.map((eventoId) => ({ ocorrenciaId: o!.id, eventoId, vinculadoPorId: ctx.ator.id, vinculadoEm: agora })));
        }
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'ocorrencia.criar', entidade: 'ocorrencia', registroId: o!.id, depois: { ...o, eventoIds } });
        return o!.id;
      });
      return await this.view(this.db, id);
    } catch (e) { throw traduzir(e); }
  }

  /** Ocorrência travada + regra do porteiro + encerrada final. Usada por status, eventos e anexos. */
  private async paraAlterar(tx: Tx, ctx: Contexto, id: string, travar = true) {
    const q = tx.select().from(ocorrencia).where(eq(ocorrencia.id, id));
    const [o] = travar ? await q.for('update') : await q;
    if (!o) throw erroApi(404, 'OCORRENCIA_NAO_ENCONTRADA', 'Ocorrência não encontrada.');
    if (ctx.ator.papel === 'porteiro' && o.abertaPorId !== ctx.ator.id) {
      throw new AcessoNegado('ocorrencia.operar', 'O porteiro só altera ocorrências que ele mesmo abriu.', 'SO_PROPRIA_OCORRENCIA');
    }
    if (o.status === 'encerrada') throw erroApi(409, 'OCORRENCIA_ENCERRADA', 'Ocorrência encerrada não pode ser alterada.');
    return o;
  }

  async alterarStatus(ctx: Contexto, id: string, status: Status): Promise<OcorrenciaViewApi> {
    try {
      await transacaoComRetry(this.db, async (tx) => {
        const antes = await this.paraAlterar(tx, ctx, id);
        if (PROXIMO[antes.status] !== status) {
          throw erroApi(422, 'TRANSICAO_INVALIDA', 'Transição de status inválida: o fluxo é aberta, em andamento e encerrada, nessa ordem.');
        }
        const agora = this.agora();
        await tx.insert(ocorrenciaStatusHistorico).values({ ocorrenciaId: id, de: antes.status, para: status, porId: ctx.ator.id, em: agora });
        const [depois] = await tx.update(ocorrencia).set({ status, atualizadoEm: agora }).where(eq(ocorrencia.id, id)).returning();
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'ocorrencia.alterarStatus', entidade: 'ocorrencia', registroId: id, antes, depois });
      });
      return await this.view(this.db, id);
    } catch (e) { throw traduzir(e); }
  }

  /** RF-28: acrescenta eventos (os já vinculados são ignorados). Qualquer operador (spec §5.2), menos em encerrada. */
  async vincularEventos(ctx: Contexto, id: string, ids: string[]): Promise<OcorrenciaViewApi> {
    const eventoIds = [...new Set(ids)];
    try {
      await transacaoComRetry(this.db, async (tx) => {
        const [o] = await tx.select().from(ocorrencia).where(eq(ocorrencia.id, id)).for('update');
        if (!o) throw erroApi(404, 'OCORRENCIA_NAO_ENCONTRADA', 'Ocorrência não encontrada.');
        if (o.status === 'encerrada') throw erroApi(409, 'OCORRENCIA_ENCERRADA', 'Ocorrência encerrada não pode ser alterada.');
        await this.conferirEventos(tx, eventoIds);
        const n = (await tx.select({ n: count() }).from(ocorrenciaEvento).where(eq(ocorrenciaEvento.ocorrenciaId, id)))[0]?.n ?? 0;
        const novos = await tx.insert(ocorrenciaEvento)
          .values(eventoIds.map((eventoId) => ({ ocorrenciaId: id, eventoId, vinculadoPorId: ctx.ator.id, vinculadoEm: this.agora() })))
          .onConflictDoNothing().returning({ eventoId: ocorrenciaEvento.eventoId });
        if (Number(n) + novos.length > 100) throw erroApi(422, 'LIMITE_EVENTOS', 'Uma ocorrência tem no máximo 100 eventos vinculados.');
        if (novos.length) {
          await this.auditoria.registrar(tx, {
            ator: ctx.ator, ip: ctx.ip, acao: 'ocorrencia.vincularEventos', entidade: 'ocorrencia', registroId: id,
            depois: { eventoIds: novos.map((x) => x.eventoId) },
          });
        }
      });
      return await this.view(this.db, id);
    } catch (e) { throw traduzir(e); }
  }

  /** Anexo cifrado. Checa tudo antes de gravar o arquivo e de novo, travado, depois; se a transação falhar, apaga o arquivo. */
  async anexar(ctx: Contexto, id: string, arquivo: ArquivoEnviado | undefined): Promise<OcorrenciaViewApi> {
    if (!arquivo?.buffer) throw erroApi(400, 'ARQUIVO_OBRIGATORIO', 'Envie o arquivo no campo "arquivo".');
    if (arquivo.size === 0) throw erroApi(422, 'ARQUIVO_VAZIO', 'O arquivo está vazio.');
    if (arquivo.size > ANEXO_MAX_BYTES) throw erroApi(413, 'ARQUIVO_GRANDE_DEMAIS', `O anexo passa de ${ANEXO_MAX_BYTES / 1024 / 1024} MB.`);
    const mime = tipoAnexoPorConteudo(arquivo.buffer);
    if (!mime) throw erroApi(415, 'TIPO_NAO_PERMITIDO', 'Tipo de arquivo não permitido: envie foto (JPEG ou PNG) ou PDF.');

    const regras = async (tx: Tx, travar: boolean) => {
      await this.paraAlterar(tx, ctx, id, travar);
      const n = (await tx.select({ n: count() }).from(ocorrenciaAnexo).where(eq(ocorrenciaAnexo.ocorrenciaId, id)))[0]?.n ?? 0;
      if (Number(n) >= ANEXO_MAX_POR_OCORRENCIA) {
        throw erroApi(422, 'LIMITE_ANEXOS', `Uma ocorrência tem no máximo ${ANEXO_MAX_POR_OCORRENCIA} anexos.`);
      }
    };
    // Checagem prévia, sem trava: não grava arquivo em disco para quem não pode anexar.
    await this.db.transaction((tx) => regras(tx, false));
    const g = await this.cofre.guardar(arquivo.buffer);
    try {
      await transacaoComRetry(this.db, async (tx) => {
        await regras(tx, true);
        await tx.insert(documento).values({
          id: g.id, tipo: 'anexo_ocorrencia', caminhoStorage: g.caminhoStorage, dekCifrada: g.dekCifrada, nonce: g.nonce, chaveVersao: g.chaveVersao,
          sha256Conteudo: g.sha256Conteudo, mime, tamanhoBytes: g.tamanhoBytes, enviadoPorId: ctx.ator.id, enviadoEm: this.agora(),
        });
        await tx.insert(ocorrenciaAnexo).values({ ocorrenciaId: id, documentoId: g.id });
        await this.auditoria.registrar(tx, {
          ator: ctx.ator, ip: ctx.ip, acao: 'ocorrencia.anexar', entidade: 'ocorrencia', registroId: id,
          // Metadados apenas: nem conteúdo, nem chave, nem nome original
          depois: { documentoId: g.id, mime, tamanhoBytes: g.tamanhoBytes, sha256Conteudo: g.sha256Conteudo },
        });
      });
    } catch (e) {
      await this.cofre.descartar(g.caminhoStorage);
      throw traduzir(e);
    }
    return this.view(this.db, id);
  }

  /** Conteúdo decifrado de um anexo DESTA ocorrência, com a leitura na trilha (`documento.ler`). */
  async conteudo(ctx: Contexto, ocorrenciaId: string, documentoId: string) {
    const a = await this.lerAnexo(ocorrenciaId, documentoId);
    await this.auditoria.registrar(this.db, {
      ator: ctx.ator, ip: ctx.ip, acao: 'documento.ler', entidade: 'documento', registroId: documentoId, depois: { ocorrenciaId },
    });
    return a;
  }

  /**
   * Conteúdo decifrado de um anexo DESTA ocorrência (o vínculo é conferido: id de documento de outra não serve), sem
   * trilha: quem chama registra (`conteudo` acima; o app do Master não registra o download desde 2026-11-01).
   */
  async lerAnexo(ocorrenciaId: string, documentoId: string) {
    const [d] = await this.db.select({ doc: documento }).from(ocorrenciaAnexo).innerJoin(documento, eq(documento.id, ocorrenciaAnexo.documentoId))
      .where(and(eq(ocorrenciaAnexo.ocorrenciaId, ocorrenciaId), eq(ocorrenciaAnexo.documentoId, documentoId)));
    if (!d) throw erroApi(404, 'ANEXO_NAO_ENCONTRADO', 'Anexo não encontrado nesta ocorrência.');
    const conteudo = await this.cofre.ler(d.doc);
    return { conteudo, mime: d.doc.mime, nome: nomeAnexo(documentoId, d.doc.mime) };
  }
}
