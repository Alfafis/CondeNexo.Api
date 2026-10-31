// Retenção (RNF-09; requisitos seção 7; spec §9.1). Roda pelo agendador (uma vez por dia), pelo CLI ou sob demanda
// (`POST /lgpd/retencao`, SI). Cada passo é idempotente: rodar duas vezes seguidas não faz nada na segunda.
//
// O que a seção 7 define e o job aplica:
//  1. Pessoas: visitante/prestador com mais de 3 anos sem acesso (ou do cadastro, se nunca entrou) e morador cujo último
//     vínculo terminou há mais de 3 anos são ANONIMIZADOS (mesma regra de `elegivelRetencao` do domain).
//  2. Foto: eliminada ao fim do vínculo (morador sem vínculo vigente). Hoje a API não recebe foto; a regra fica pronta.
//  3. Eventos de acesso: 3 anos a partir do registro. Descarta o PREFIXO da cadeia, e só até um seq que tenha selo
//     (`retencao_descartar_eventos` confere o selo, o prazo pelo relógio do banco e trava a cabeça). Evento vencido depois
//     do último selo elegível fica para a próxima execução e é contado em `eventosVencidosSemSelo`.
//  4. Trilha de alterações: 3 anos a partir do registro (`retencao_descartar_audit`).
//  5. Veículo: apagado 3 anos depois da desativação (`retencao_eliminar_veiculos`, 0007; fato gerador `desativado_em`).
//  6. Operador: nome e login genéricos 3 anos depois da desativação (`retencao_anonimizar_operadores`, 0007).
//  7. Sessão: IP e navegador apagados 90 dias depois do último uso (`retencao_limpar_sessoes`, 0007; spec 9.4).
// Antes de tudo, a reaplicação das anonimizações registradas na plataforma (restore, `LgpdService.reaplicar`), e no
// fim a cópia para a plataforma das anonimizações deste banco que ainda não estão lá (`sincronizarRegistro`). Falha na
// plataforma não para a retenção: vai ao resultado (`registroExterno`) e ao log.
// O que a seção 7 NÃO define (spec §14, decisão em aberto, sem prazo inventado):
//  - anexos de ocorrência: só são eliminados se `RETENCAO_ANEXO_OCORRENCIA_ANOS` estiver definido (contado do encerramento
//    da ocorrência); sem ele, nada sai por prazo.
//  - funcionário: a seção 7 define prazo (contrato + 3 anos), mas o modelo não guarda a data do desligamento (§14).
// Por fim, a varredura do volume de documentos: apaga arquivo de documento já eliminado (a remoção de antes falhou),
// arquivo sem registro (queda entre gravar e commitar, com mais de 1 hora) e temporário velho; registro ativo sem arquivo
// só é contado e logado (é perda de dado, não lixo: ninguém apaga o registro por conta própria).
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type Ator, AuditoriaService } from '../auditoria/auditoria.service';
import { log } from '../comum/log';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { CONFIG, type Config } from '../config/config';
import { DB, type Db, type Tx } from '../database/database.module';
import { auditLog, documento, pessoa } from '../db/schema';
import { CofreDocumentos } from '../documentos/cofre';
import { ANOS_RETENCAO, LgpdService, somarAnos } from './lgpd.service';

/** Arquivo sem registro só é apagado depois disso: pode ser um upload entre o rename e o COMMIT. */
const IDADE_MINIMA_ORFAO_MS = 60 * 60 * 1000;

export interface ResultadoRetencaoApi {
  visitantesPrestadores: number;
  moradores: number;
  registrosRedigidos: number;
  pessoaIds: string[];
  eventosDescartados: number;
  eventosVencidosSemSelo: number;
  trilhaDescartada: number;
  fotosEliminadas: number;
  anexosEliminados: number;
  prazoAnexosDefinido: boolean;
  arquivosOrfaosRemovidos: number;
  registrosSemArquivo: number;
  veiculosEliminados: number;
  operadoresAnonimizados: number;
  sessoesLimpas: number;
  /** Anonimizações registradas na plataforma refeitas neste banco (depois de um restore). */
  anonimizacoesReaplicadas: number;
  /** Reaplicadas que ainda têm vínculo válido no banco restaurado (ids, para conferência). */
  reaplicadasComVinculoValido: string[];
  /** 'ok' ou 'falhou' (plataforma fora): a reaplicação e a cópia ficam para a próxima execução. */
  registroExterno: 'ok' | 'falhou';
}

type Rows<T> = { rows: T[] };

/**
 * Pessoas elegíveis (espelho de `elegivelRetencao` em ../dominio/rules):
 *  - nenhum vínculo sem término (pendente, aprovado ou legado);
 *  - morador COM vínculos: o término mais recente (encerrado_em; no rejeitado, a decisão ou o registro) antes do limite;
 *  - os demais (e morador sem vínculo): o último acesso (registrado_em, contando correções que apontam para a pessoa)
 *    ou, se nunca entrou, o cadastro, antes do limite.
 * `soId` restringe a uma pessoa (reconferência dentro da transação, com a linha travada).
 */
function elegiveisSql(limite: Date, soId?: string) {
  return sql`
    WITH ultimo_acesso AS (
      SELECT x.id, max(x.em) AS em FROM (
        SELECT pessoa_id AS id, max(registrado_em) AS em FROM evento_acesso GROUP BY pessoa_id
        UNION ALL
        SELECT (correcao_valores ->> 'pessoa_id')::uuid, max(registrado_em) FROM evento_acesso
         WHERE tipo = 'correcao' AND correcao_valores ->> 'pessoa_id' IS NOT NULL GROUP BY 1
      ) x GROUP BY x.id
    ), termino AS (
      SELECT pessoa_id AS id,
             bool_or(status IN ('pendente', 'aprovado', 'legado')) AS algum_ativo,
             max(CASE WHEN status = 'encerrado' THEN encerrado_em ELSE coalesce(decidido_em, registrado_em) END) AS em
        FROM vinculo_unidade GROUP BY pessoa_id
    )
    SELECT p.id, p.categoria FROM pessoa p
      LEFT JOIN ultimo_acesso u ON u.id = p.id
      LEFT JOIN termino t ON t.id = p.id
     WHERE p.anonimizada_em IS NULL
       AND p.categoria IN ('visitante', 'prestador', 'morador')
       AND coalesce(t.algum_ativo, false) = false
       AND CASE WHEN p.categoria = 'morador' AND t.id IS NOT NULL THEN t.em < ${limite.toISOString()}::timestamptz
                ELSE coalesce(u.em, p.criado_em) < ${limite.toISOString()}::timestamptz END
       ${soId ? sql`AND p.id = ${soId}::uuid` : sql``}
     ORDER BY p.id`;
}

@Injectable()
export class RetencaoService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(LgpdService) private readonly lgpd: LgpdService,
    @Inject(CofreDocumentos) private readonly cofre: CofreDocumentos,
  ) {}

  /** Uma execução completa. Quem chama segura a trava de job (TravaJobs). */
  async aplicar(quem: { ator: Ator | null; ip?: string | null; nomeInformado?: string }): Promise<ResultadoRetencaoApi> {
    const agora = this.relogio.agora();
    const limitePessoas = somarAnos(agora, -ANOS_RETENCAO);
    const r: ResultadoRetencaoApi = {
      visitantesPrestadores: 0, moradores: 0, registrosRedigidos: 0, pessoaIds: [], eventosDescartados: 0, eventosVencidosSemSelo: 0,
      trilhaDescartada: 0, fotosEliminadas: 0, anexosEliminados: 0, prazoAnexosDefinido: this.config.retencao.anexoOcorrenciaAnos !== null,
      arquivosOrfaosRemovidos: 0, registrosSemArquivo: 0, veiculosEliminados: 0, operadoresAnonimizados: 0, sessoesLimpas: 0,
      anonimizacoesReaplicadas: 0, reaplicadasComVinculoValido: [], registroExterno: 'ok',
    };
    const n = async (q: ReturnType<typeof sql>) => Number(((await this.db.execute(q)) as unknown as Rows<{ n: number | string }>).rows[0]?.n ?? 0);

    // 0. Restore: o que a plataforma registra como anonimizado e aqui voltou a ter dados pessoais.
    try {
      const x = await this.lgpd.reaplicar(quem);
      r.anonimizacoesReaplicadas = x.reaplicadas.length;
      r.reaplicadasComVinculoValido = x.comVinculoValido;
    } catch (e) {
      r.registroExterno = 'falhou';
      log('error', 'retencao.reaplicacao_falhou', { erro: e instanceof Error ? e.name : 'erro' });
    }

    // 1. Pessoas: uma transação por pessoa (uma falha não desfaz as outras), reconferida com a linha travada.
    const candidatas = ((await this.db.execute(elegiveisSql(limitePessoas))) as unknown as Rows<{ id: string; categoria: string }>).rows;
    for (const c of candidatas) {
      const feito = await this.db.transaction(async (tx) => {
        await tx.select({ id: pessoa.id }).from(pessoa).where(eq(pessoa.id, c.id)).for('update');
        const ainda = ((await tx.execute(elegiveisSql(limitePessoas, c.id))) as unknown as Rows<{ id: string }>).rows;
        if (!ainda.length) return null; // ganhou vínculo ou acesso entre a lista e agora
        return this.lgpd.anonimizarNaTx(tx, quem, c.id, 'retencao');
      });
      if (!feito) continue;
      if (c.categoria === 'morador') r.moradores++; else r.visitantesPrestadores++;
      r.pessoaIds.push(c.id);
      r.registrosRedigidos += feito.registrosRedigidos;
      // a foto, se havia, já está marcada como eliminada: o arquivo sai na varredura do passo 7
    }

    // 2. Foto ao fim do vínculo: morador com foto, sem vínculo pendente/aprovado/legado e com algum vínculo terminado.
    const fotos = ((await this.db.execute(sql`
      SELECT p.id, p.foto_documento_id AS doc FROM pessoa p
       WHERE p.foto_documento_id IS NOT NULL AND p.anonimizada_em IS NULL AND p.categoria = 'morador'
         AND EXISTS (SELECT 1 FROM vinculo_unidade v WHERE v.pessoa_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM vinculo_unidade v WHERE v.pessoa_id = p.id AND v.status IN ('pendente', 'aprovado', 'legado'))`)) as unknown as Rows<{ id: string; doc: string }>).rows;
    if (fotos.length) {
      r.fotosEliminadas = await this.db.transaction(async (tx) => {
        await tx.update(pessoa).set({ fotoDocumentoId: null, atualizadoEm: agora }).where(inArray(pessoa.id, fotos.map((f) => f.id)));
        const n = await this.eliminarDocumentos(tx, fotos.map((f) => f.doc), 'foto_fim_vinculo');
        await this.auditoria.registrar(tx, { ...quem, acao: 'lgpd.eliminarFoto', entidade: 'documento', depois: { pessoaIds: fotos.map((f) => f.id), documentos: n } });
        return n;
      });
    }

    // 3. Eventos: o maior seq SELADO cujo prefixo inteiro já venceu (registrado_em é monotônico em seq; o evento selado é
    //    o mais novo do prefixo). O prazo é o do relógio do banco, o mesmo que a função confere.
    const corte = ((await this.db.execute(sql`
      SELECT max(s.ultimo_seq) AS seq FROM selo_cadeia s
        JOIN evento_acesso e ON e.seq = s.ultimo_seq AND e.hash = s.ultimo_hash
       WHERE e.registrado_em < now() - interval '3 years'`)) as unknown as Rows<{ seq: string | number | null }>).rows[0]?.seq;
    if (corte !== null && corte !== undefined) {
      const res = (await this.db.execute(sql`SELECT retencao_descartar_eventos(${Number(corte)}::bigint) AS n`)) as unknown as Rows<{ n: number | string }>;
      r.eventosDescartados = Number(res.rows[0]?.n ?? 0);
    }
    r.eventosVencidosSemSelo = Number(((await this.db.execute(sql`
      SELECT count(*) AS n FROM evento_acesso WHERE registrado_em < now() - interval '3 years'`)) as unknown as Rows<{ n: number | string }>).rows[0]?.n ?? 0);
    if (r.eventosVencidosSemSelo) log('warn', 'retencao.eventos_sem_selo', { detalhe: `${r.eventosVencidosSemSelo} vencidos aguardando selo no ponto de corte` });

    // 4. Trilha de alterações com mais de 3 anos.
    r.trilhaDescartada = Number(((await this.db.execute(sql`SELECT retencao_descartar_audit() AS n`)) as unknown as Rows<{ n: number | string }>).rows[0]?.n ?? 0);

    // 5. Anexos de ocorrência: só com prazo definido (decisão em aberto), contado do encerramento da ocorrência.
    const anos = this.config.retencao.anexoOcorrenciaAnos;
    if (anos !== null) {
      const limite = somarAnos(agora, -anos);
      const vencidos = ((await this.db.execute(sql`
        SELECT a.documento_id AS doc FROM ocorrencia_anexo a
          JOIN ocorrencia o ON o.id = a.ocorrencia_id
          JOIN documento d ON d.id = a.documento_id
         WHERE o.status = 'encerrada' AND d.eliminado_em IS NULL
           AND (SELECT max(h.em) FROM ocorrencia_status_historico h WHERE h.ocorrencia_id = o.id AND h.para = 'encerrada')
               < ${limite.toISOString()}::timestamptz`)) as unknown as Rows<{ doc: string }>).rows;
      if (vencidos.length) {
        r.anexosEliminados = await this.db.transaction((tx) => this.eliminarDocumentos(tx, vencidos.map((v) => v.doc), 'anexo_ocorrencia'));
      }
    }

    // 6. Veículos, operadores e sessões (0007): prazo e fato gerador conferidos pelo relógio do banco, na função.
    r.veiculosEliminados = await n(sql`SELECT retencao_eliminar_veiculos() AS n`);
    r.operadoresAnonimizados = await n(sql`SELECT retencao_anonimizar_operadores() AS n`);
    r.sessoesLimpas = await n(sql`SELECT retencao_limpar_sessoes() AS n`);

    // 7. Volume de documentos.
    Object.assign(r, await this.varrerVolume(agora));

    // 8. Registro fora do banco: tudo o que retencao_execucao tem e a plataforma ainda não (inclui as de hoje).
    try {
      await this.lgpd.sincronizarRegistro();
    } catch (e) {
      r.registroExterno = 'falhou';
      log('error', 'retencao.registro_plataforma_falhou', { erro: e instanceof Error ? e.name : 'erro' });
    }

    await this.auditoria.registrar(this.db, { ...quem, acao: 'lgpd.retencao', entidade: 'retencao_execucao', depois: r });
    return r;
  }

  private async eliminarDocumentos(tx: Tx, ids: string[], motivo: 'foto_fim_vinculo' | 'anexo_ocorrencia') {
    const res = (await tx.execute(sql`SELECT retencao_eliminar_documentos(${`{${ids.join(',')}}`}::uuid[], ${motivo}) AS n`)) as unknown as Rows<{ n: number | string }>;
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Apaga arquivo de documento eliminado e órfão velho; conta (e loga) registro ativo sem arquivo. */
  async varrerVolume(agora: Date): Promise<{ arquivosOrfaosRemovidos: number; registrosSemArquivo: number }> {
    const arquivos = await this.cofre.listar();
    const ids = [...new Set(arquivos.filter((a) => !a.temporario).map((a) => a.id))];
    const registros = new Map<string, { eliminado: boolean }>();
    for (let i = 0; i < ids.length; i += 1000) {
      const ls = await this.db.select({ id: documento.id, eliminadoEm: documento.eliminadoEm }).from(documento).where(inArray(documento.id, ids.slice(i, i + 1000)));
      for (const l of ls) registros.set(l.id, { eliminado: !!l.eliminadoEm });
    }
    let orfaos = 0;
    for (const a of arquivos) {
      const velho = agora.getTime() - a.modificadoEm > IDADE_MINIMA_ORFAO_MS;
      const reg = registros.get(a.id);
      const apagar = a.temporario ? velho : reg ? reg.eliminado : velho;
      if (apagar && (await this.cofre.eliminar(a.nome))) orfaos++;
    }
    // Registro ativo cujo arquivo não está no volume (o caminho é `<id>.bin`, gerado pelo cofre).
    const presentes = new Set(arquivos.filter((a) => !a.temporario).map((a) => a.nome));
    const ativos = await this.db.select({ id: documento.id, caminho: documento.caminhoStorage }).from(documento).where(isNull(documento.eliminadoEm));
    const semArquivo = ativos.filter((d) => !presentes.has(d.caminho));
    for (const d of semArquivo.slice(0, 20)) log('error', 'documento.registro_sem_arquivo', { detalhe: d.id });
    return { arquivosOrfaosRemovidos: orfaos, registrosSemArquivo: semArquivo.length };
  }

  /** Última execução registrada (audit_log `lgpd.retencao`), para a tela. */
  async ultima() {
    const [l] = await this.db.select().from(auditLog).where(and(eq(auditLog.acao, 'lgpd.retencao'), isNotNull(auditLog.depois)))
      .orderBy(desc(auditLog.seq)).limit(1);
    if (!l) return { ultima: null };
    // O snapshot do audit_log grava as chaves em snake_case; a tela recebe o mesmo formato do POST (camelCase).
    // O snapshot é o próprio resultado do POST gravado pela execução (`aplicar`): a forma é a de ResultadoRetencaoApi.
    const resultado = Object.fromEntries(Object.entries(l.depois as Record<string, unknown>)
      .map(([k, v]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), v])) as unknown as ResultadoRetencaoApi;
    return { ultima: { em: l.em.getTime(), porNome: l.usuarioNome, resultado } };
  }
}
