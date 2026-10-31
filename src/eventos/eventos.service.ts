// Registro de acesso (RF-12, RF-13, RF-16, RF-17, RF-35, RN-01, RN-04, RN-07, RN-11, UC02 A4). Ordem das
// validações:
//   pessoa (404, anonimizada, desativada) -> unidade/área para novo uso (UNIDADE_INATIVA) -> instante (retroativo) -> categoria
//   efetiva ("morador" sem vínculo válido vira visitante) -> RESTRIÇÃO VIGENTE (grava "negado" e responde 422 com o id)
//   -> autorização (RN-01, RF-17, RN-07, escala, RF-36) -> "já está dentro" -> grava.
// O evento é append-only e calculado no banco: o trigger evento_acesso_antes_inserir trava a cabeça da cadeia, numera,
// carimba registrado_em com o relógio do servidor e calcula o hash. A API só monta a linha (só ids; nomes por join).
//
// Concorrência:
// - entrada da MESMA pessoa: a pessoa é travada com FOR NO KEY UPDATE (não conflita com o FOR KEY SHARE das FKs de
//   outros eventos), então a segunda espera a primeira e vê "já está dentro";
// - saída dupla: índice único evento_saida_unica_uq -> 409 SAIDA_JA_REGISTRADA;
// - correção do mesmo evento: advisory lock da transação (app_rw não tem UPDATE em evento_acesso, então não há
//   SELECT ... FOR UPDATE), para a segunda correção acumular sobre a primeira;
// - 40001/40P01: a transação inteira é repetida (transacaoComRetry). O "negado" é gravado numa transação que COMMITA
//   antes do 422: nunca é repetido nem duplicado.
import { Inject, Injectable } from '@nestjs/common';
import { pode } from '../dominio/rbac';
import {
  ERRO_PESSOA_DESATIVADA, MIN_JUSTIFICATIVA, justificativaValida, prazoInicial, proximaProrrogacao, restricoesVigentes, temPrazoPermanencia,
  meioComMorador, tipoVisitaPadrao, validarAutorizacaoEntrada, type MeioComMorador,
  escalaVigente, estadoAutorizacaoPrevia, meiosAceitos, type EstadoAutorizacao,
} from '../dominio/rules';
import { inicioDoDia, fimDoDia, partes } from '../dominio/time';
import type {
  CategoriaPessoa, EventoView, Funcionario, MeioAutorizacao, PermanenciaView, Restricao, TipoVisita, ValoresCorrecao, VeiculoAcesso,
} from '../dominio/types';
import { CAMPOS_CORRIGIVEIS } from '../dominio/types';
import { PORTARIA_SOCIAL } from '../dominio/units';
import { normalizarPlaca } from '../dominio/cpf';
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { diaBrt } from '../comum/datas';
import { AcessoNegado, codigoPg, constraintPg, erroApi } from '../comum/erros';
import { codificarCursor, decodificarCursor, Pagina } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { transacaoComRetry } from '../comum/transacao';
import { DB, type Db, type Executor, type Tx } from '../database/database.module';
import {
  areaComum, autorizacaoPrevia, encomenda, eventoAcesso, funcionario, ocorrencia, permanencia, pessoa, pontoAcesso, restricao, unidade,
  vinculoUnidade,
} from '../db/schema';
import { nomeSemAcentoSql, normalizar } from '../pessoas/busca.service';
import { UnidadesService } from '../unidades/unidades.service';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';
import {
  correcaoDoBanco, correcaoParaBanco, ehExcecaoSql, efetivoSql, filtroEfetivo, type LinhaEvento, paraDominio, semSaidaSql,
} from './efetivo';
import { montarViews } from './evento-view';
import { montarRestricoesView, paraAutorizacaoDominio, paraRestricaoDominio } from './conversoes';

/** Tolerância para `ocorrido_em` informado num registro que não é retroativo (o relógio que vale é o do servidor). */
const TOLERANCIA_MS = 5 * 60_000;

export interface NovoEvento {
  pessoaId: string;
  unidadeDestinoId: string | null;
  areaComumId?: string | null;
  autorizadoPorTipo?: MeioAutorizacao | null;
  autorizadoPorPessoaId?: string | null;
  autorizacaoPreviaId?: string | null;
  justificativa?: string | null;
  retroativo?: boolean;
  ocorridoEm?: number | null;
  observacao?: string | null;
  formularioContingencia?: string | null;
  /** Só visitante/prestador (padrão: visita / serviço); ignorado para morador e funcionário, que não têm prazo. */
  tipoVisita?: TipoVisita | null;
  /** Veículo com que a pessoa chegou (nulo/ausente = a pé). Placa obrigatória se informado; modelo e cor opcionais. */
  veiculo?: { placa: string; modelo?: string | null; cor?: string | null } | null;
}
/** Rascunho da entrada para a avaliação (POST /eventos-acesso/avaliacao): os campos que a regra lê, sem veículo nem textos. */
export type RascunhoEntrada = Pick<NovoEvento, 'pessoaId' | 'unidadeDestinoId' | 'areaComumId' | 'autorizadoPorTipo' | 'autorizadoPorPessoaId'
  | 'autorizacaoPreviaId' | 'justificativa' | 'retroativo' | 'ocorridoEm' | 'tipoVisita'>;

/**
 * Resultado da avaliação de uma entrada ainda não registrada: o que a tela usa para montar as opções e habilitar
 * "Confirmar entrada", calculado pelas MESMAS funções que `criarEntrada` aplica ao gravar (e que ela aplica de novo).
 */
export interface AvaliacaoEntrada {
  /** Categoria efetiva no instante: "morador" sem vínculo válido no destino vira visitante (RN-01/RN-02). */
  categoria: CategoriaPessoa;
  /** Meios de autorização aceitos para a categoria efetiva e o destino (unidade ou área comum). */
  meiosAceitos: MeioAutorizacao[];
  /** Autorizações prévias da pessoa para o destino, com o estado no instante do acesso. */
  autorizacoes: { id: string; estado: EstadoAutorizacao }[];
  /** Funcionário em horário de escala no instante (null: não é funcionário). */
  emEscala: boolean | null;
  /** Tipo de visita padrão da categoria (null: categoria sem prazo de permanência, morador e funcionário). */
  tipoVisitaPadrao: TipoVisita | null;
  /** Prazo de permanência que a entrada teria (null: sem prazo). */
  prazoAte: number | null;
  /** O motivo da recusa, se a entrada fosse registrada agora (null: a autorização está completa e válida). */
  erro: { code: string; message: string } | null;
}

export interface NovaRecusa {
  pessoaId: string; unidadeDestinoId: string; meio: MeioComMorador; moradorPessoaId: string;
  observacao?: string | null; retroativo?: boolean; ocorridoEm?: number | null; formularioContingencia?: string | null;
}
export interface OpcoesSaida { observacao?: string | null; retroativo?: boolean; ocorridoEm?: number | null; formularioContingencia?: string | null }
export interface NovaCorrecao { justificativa: string; observacao?: string | null; valores?: Partial<ValoresCorrecao> }

export interface FiltroEventos {
  eventoId?: string; de?: number; ate?: number; unidadeId?: string; pessoaId?: string; pessoa?: string; operadorId?: string;
  /** Placa (parcial, ≥3 caracteres alfanuméricos). Só no corpo de POST: é dado pessoal. Ver `filtros()`. */
  placa?: string;
  tipo?: LinhaEvento['tipo']; meio?: MeioAutorizacao; somenteExcecoes?: boolean; somenteRetroativos?: boolean;
  excluirTipos?: LinhaEvento['tipo'][];
}

const CursorSeq = z.strictObject({ s: z.number().int().positive() });

/** Erro do banco num evento -> 409/422 legível, sem a mensagem do driver (que cita ids e valores). */
export function traduzirErroEvento(e: unknown): unknown {
  const pg = codigoPg(e);
  if (!pg) return e;
  const c = constraintPg(e);
  if (pg === '23505' && c === 'evento_saida_unica_uq') return erroApi(409, 'SAIDA_JA_REGISTRADA', 'A saída desta entrada já foi registrada.');
  if (pg === '23505' && c === 'permanencia_evento_ordem_uq') return erroApi(409, 'PRORROGACAO_CONCORRENTE', 'Outra prorrogação desta entrada acabou de ser registrada. Atualize a tela.');
  if (pg === '23503') return erroApi(422, 'REFERENCIA_INVALIDA', 'Pessoa, unidade, área ou autorização informada não existe.');
  if (pg !== '23514') return e;
  switch (c) {
    case 'evento_retroativo_tempo_ck': return erroApi(422, 'DATA_INCONSISTENTE', 'Lançamento retroativo exige data e hora reais anteriores ao momento atual.');
    case 'evento_retroativo_formulario_ck': return erroApi(422, 'FORMULARIO_OBRIGATORIO', 'Registro retroativo exige o número do formulário de contingência.');
    case 'evento_rf17_excecao_ck': return erroApi(422, 'JUSTIFICATIVA_OBRIGATORIA', `A exceção exige justificativa de pelo menos ${MIN_JUSTIFICATIVA} caracteres (RF-17).`);
    case 'evento_correcao_justificada_ck': return erroApi(422, 'JUSTIFICATIVA_OBRIGATORIA', `A correção exige justificativa de pelo menos ${MIN_JUSTIFICATIVA} caracteres (RN-04).`);
    case 'evento_rn01_autorizado_por_ck': return erroApi(422, 'AUTORIZADO_POR_OBRIGATORIO', 'Informe quem autorizou a entrada (RN-01).');
    case 'evento_morador_identificado_ck': return erroApi(422, 'AUTORIZADO_POR_SEM_IDENTIFICACAO', 'Informe o morador que autorizou (nome obrigatório).');
    case 'evento_destino_obrigatorio_ck': return erroApi(422, 'UNIDADE_OBRIGATORIA', 'Informe a unidade de destino.');
    case 'evento_area_comum_prestador_ck': return erroApi(422, 'AREA_COMUM_SO_PRESTADOR', 'Área comum só é destino de prestador de serviço (RF-36).');
    case 'evento_prestador_ck': return erroApi(422, 'PRESTADOR_SEM_EMPRESA', 'Prestador precisa ter empresa no cadastro.');
    case 'evento_autorizacao_previa_ref_ck': return erroApi(422, 'AUTORIZACAO_PREVIA_INVALIDA', 'Autorização prévia inexistente, vencida ou fora da janela de dias/horário (RN-07).');
    case 'evento_escala_ck': return erroApi(422, 'MEIO_INVALIDO_PARA_TIPO', 'Este meio de autorização não se aplica ao tipo de pessoa.');
    case 'permanencia_ordem_ck': return erroApi(422, 'PRORROGACAO_LIMITE', 'Limite de prorrogações atingido para esta entrada.');
    case 'evento_veiculo_placa_ck': return erroApi(422, 'PLACA_INVALIDA', 'Placa fora do padrão antigo ou Mercosul.');
    case 'evento_veiculo_detalhe_ck': return erroApi(422, 'VEICULO_INVALIDO', 'Informe a placa do veículo; modelo e cor são opcionais.');
    case undefined: {
      // RAISE do trigger (sem constraint). A mensagem é nossa (migração 0001) e só é lida aqui, nunca devolvida.
      const m = String((e as { cause?: { message?: unknown } }).cause?.message ?? (e as { message?: unknown }).message ?? '');
      if (/corrige|correção/i.test(m)) return erroApi(422, 'CORRECAO_DE_CORRECAO', 'Não é possível corrigir uma correção: corrija o evento original.');
      if (/sem CPF/i.test(m)) return erroApi(422, 'SEM_CPF_SO_EXCECAO', 'Pessoa cadastrada sem CPF só pode entrar por exceção do porteiro, com justificativa.');
      if (/data corrigida|ISO 8601/i.test(m)) return erroApi(422, 'DATA_INCONSISTENTE', 'A data e hora corrigidas devem ser anteriores ao momento atual.');
      if (/saída precisa/i.test(m)) return erroApi(404, 'ENTRADA_NAO_ENCONTRADA', 'Entrada não encontrada.');
      // Trigger permanencia_antes_inserir (migração 0011)
      if (/já saiu/i.test(m)) return erroApi(422, 'PESSOA_JA_SAIU', 'A saída desta pessoa já foi registrada: não há permanência a prorrogar.');
      if (/permanência|prorrogação/i.test(m)) return erroApi(422, 'PERMANENCIA_INVALIDA', 'O prazo de permanência não foi aceito. Atualize a tela e tente de novo.');
      return erroApi(409, 'TRANSICAO_INVALIDA', 'O registro não foi aceito no estado atual. Atualize a tela e tente de novo.');
    }
    default: return erroApi(422, 'REGRA_VIOLADA', 'Os dados violam uma regra do registro de acesso.');
  }
}

/** RNF-05: coerência entre ocorrido_em e registrado_em; retroativo exige formulário de papel. */
function resolverInstante(i: { retroativo?: boolean; ocorridoEm?: number | null; formularioContingencia?: string | null }, n: number, minimo?: number) {
  let quando = n;
  if (i.retroativo) {
    if (!i.ocorridoEm || i.ocorridoEm >= n) throw erroApi(422, 'DATA_INCONSISTENTE', 'Lançamento retroativo exige data e hora reais anteriores ao momento atual.');
    if (minimo !== undefined && i.ocorridoEm < minimo) throw erroApi(422, 'DATA_INCONSISTENTE', 'A saída retroativa não pode ser anterior à entrada.');
    quando = i.ocorridoEm;
  } else if (i.ocorridoEm && Math.abs(i.ocorridoEm - n) > TOLERANCIA_MS) {
    throw erroApi(422, 'DATA_INCONSISTENTE', 'Registro que não é retroativo deve ter data e hora atuais.');
  }
  const formulario = i.formularioContingencia?.trim() || null;
  if (i.retroativo && !formulario) throw erroApi(422, 'FORMULARIO_OBRIGATORIO', 'Registro retroativo exige o número do formulário de contingência.');
  return { quando, formulario: i.retroativo ? formulario : null };
}

/** Veículo da entrada -> colunas (a pé: os três nulos). Placa no padrão antigo ou Mercosul; modelo e cor aparados, vazio = nulo. */
export function colunasVeiculo(v: NovoEvento['veiculo']) {
  if (!v) return { veiculoPlaca: null, veiculoModelo: null, veiculoCor: null };
  const placa = normalizarPlaca(v.placa);
  if (!placa) throw erroApi(422, 'PLACA_INVALIDA', 'Placa fora do padrão antigo ou Mercosul.');
  return { veiculoPlaca: placa, veiculoModelo: v.modelo?.trim() || null, veiculoCor: v.cor?.trim() || null };
}

type Resultado = { tipo: 'evento'; linha: LinhaEvento; prazo: PermanenciaView | null } | { tipo: 'negado'; linha: LinhaEvento; restricoes: Restricao[]; destino: string };

@Injectable()
export class EventosService {
  private pontoPadrao: string | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(UnidadesService) private readonly unidades: UnidadesService,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
  ) {}

  private agora() { return this.relogio.agora().getTime(); }

  /** Ponto de acesso único do MVP (portaria social, do seed). */
  private async ponto(exec: Executor): Promise<string> {
    if (this.pontoPadrao) return this.pontoPadrao;
    const [p] = await exec.select({ id: pontoAcesso.id }).from(pontoAcesso).where(eq(pontoAcesso.nome, PORTARIA_SOCIAL));
    if (!p) throw erroApi(500, 'ERRO_INTERNO', 'Ponto de acesso não configurado (rode o seed de estrutura).');
    this.pontoPadrao = p.id;
    return p.id;
  }

  private exigirRetroativo(ctx: Contexto, retroativo?: boolean) {
    if (retroativo && !pode(ctx.ator.papel, 'evento.retroativo')) throw new AcessoNegado('evento.retroativo');
  }

  private async inserir(tx: Tx, valores: typeof eventoAcesso.$inferInsert): Promise<LinhaEvento> {
    const [l] = await tx.insert(eventoAcesso).values(valores).returning();
    return l!;
  }

  /** Executa a escrita na transação com retry e traduz o erro do banco. */
  private async escrever<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await transacaoComRetry(this.db, fn); } catch (e) { throw traduzirErroEvento(e); }
  }

  private async view(linha: LinhaEvento): Promise<EventoView> {
    return (await montarViews(this.db, [linha]))[0]!;
  }

  // ----- Leituras usadas pela regra ----------------------------------------------------------------------------------

  /** Pessoas com vínculo válido na unidade no dia do acesso (mesma regra de `vinculosValidosDaUnidade`). */
  private async moradoresValidos(exec: Executor, unidadeId: string, quando: number): Promise<Set<string>> {
    const ls = await exec.select({ p: vinculoUnidade.pessoaId }).from(vinculoUnidade)
      .where(and(eq(vinculoUnidade.unidadeId, unidadeId), vinculoValidoSql(diaBrt(new Date(quando)))));
    return new Set(ls.map((l) => l.p));
  }

  private async temVinculoValido(exec: Executor, pessoaId: string, unidadeId: string | null, quando: number): Promise<boolean> {
    const filtros: SQL[] = [eq(vinculoUnidade.pessoaId, pessoaId), vinculoValidoSql(diaBrt(new Date(quando)))];
    if (unidadeId) filtros.push(eq(vinculoUnidade.unidadeId, unidadeId));
    const [l] = await exec.select({ id: vinculoUnidade.id }).from(vinculoUnidade).where(and(...filtros)).limit(1);
    return !!l;
  }

  /** "morador" sem vínculo válido (na unidade de destino) é tratado como visitante (RN-01/RN-02). */
  private async categoriaEfetiva(exec: Executor, p: { id: string; categoria: CategoriaPessoa }, unidadeId: string | null | undefined, quando: number) {
    if (p.categoria !== 'morador') return p.categoria;
    return (await this.temVinculoValido(exec, p.id, unidadeId ?? null, quando)) ? 'morador' : 'visitante';
  }

  /** Restrições não revogadas da pessoa (a vigência é decidida por `restricoesVigentes`, a regra do domain). */
  async restricoesDaPessoa(exec: Executor, pessoaId: string): Promise<Restricao[]> {
    const ls = await exec.select().from(restricao).where(and(eq(restricao.pessoaId, pessoaId), isNull(restricao.revogadaEm)));
    return ls.map(paraRestricaoDominio);
  }

  private async funcionarioDe(exec: Executor, pessoaId: string): Promise<Funcionario | undefined> {
    const [f] = await exec.select().from(funcionario).where(eq(funcionario.pessoaId, pessoaId));
    return f ? {
      pessoaId: f.pessoaId, funcao: f.funcao, ativo: f.ativo,
      escala: { diasSemana: f.diasSemana, horaInicio: f.horaInicio.slice(0, 5), horaFim: f.horaFim.slice(0, 5) },
    } : undefined;
  }

  /** "Já está dentro": entrada (pessoa efetiva) sem saída. */
  private async estaDentro(exec: Executor, pessoaId: string): Promise<boolean> {
    const [l] = await exec.select({ id: eventoAcesso.id }).from(eventoAcesso)
      .where(and(eq(eventoAcesso.tipo, 'entrada'), filtroEfetivo('pessoa_id', (x) => sql`${x} = ${pessoaId}::uuid`), semSaidaSql()))
      .limit(1);
    return !!l;
  }

  /**
   * Avalia o rascunho de uma entrada sem gravar nada (sem trava, sem trilha): categoria efetiva, meios aceitos, estado
   * das autorizações prévias, escala, prazo de permanência e o erro de autorização que `criarEntrada` daria. Não confere
   * restrição (a tela consulta /restricoes/verificar e o registro grava o "negado") nem "já está dentro".
   */
  async avaliarEntrada(ctx: Contexto, i: RascunhoEntrada): Promise<AvaliacaoEntrada> {
    this.exigirRetroativo(ctx, i.retroativo);
    const n = this.agora();
    const [p] = await this.db.select({ id: pessoa.id, categoria: pessoa.categoria, semCpf: pessoa.semCpf, anonimizadaEm: pessoa.anonimizadaEm,
      desativadaEm: pessoa.desativadaEm }).from(pessoa).where(eq(pessoa.id, i.pessoaId));
    if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
    // Instante como no registro, sem exigir o formulário de contingência (é rascunho): retroativo vale a hora informada.
    const quando = i.retroativo && i.ocorridoEm && i.ocorridoEm < n ? i.ocorridoEm : n;
    const categoria = await this.categoriaEfetiva(this.db, p, i.unidadeDestinoId, quando);
    const autorizacoes = i.areaComumId || i.unidadeDestinoId
      ? (await this.db.select().from(autorizacaoPrevia).where(and(
        eq(autorizacaoPrevia.pessoaId, p.id), isNull(autorizacaoPrevia.revogadaEm),
        i.areaComumId ? eq(autorizacaoPrevia.areaComumId, i.areaComumId) : eq(autorizacaoPrevia.unidadeId, i.unidadeDestinoId!),
      ))).map(paraAutorizacaoDominio)
      : [];
    const func = categoria === 'funcionario' ? await this.funcionarioDe(this.db, p.id) : undefined;
    const regra = p.anonimizadaEm ? { code: 'PESSOA_ANONIMIZADA', message: 'Cadastro anonimizado: faça um novo cadastro.' }
      : p.desativadaEm ? { code: ERRO_PESSOA_DESATIVADA.code, message: ERRO_PESSOA_DESATIVADA.message }
        : validarAutorizacaoEntrada({ ...i, categoriaPessoa: categoria, semCpf: p.semCpf }, {
          quando,
          moradoresValidosIds: i.unidadeDestinoId ? await this.moradoresValidos(this.db, i.unidadeDestinoId, quando) : new Set(),
          autorizacoes,
          funcionario: func,
        });
    const padrao = temPrazoPermanencia(categoria) ? tipoVisitaPadrao(categoria) : null;
    const tipo = padrao ? i.tipoVisita ?? padrao : null;
    const janela = i.autorizadoPorTipo === 'autorizacao_previa' ? autorizacoes.find((a) => a.id === i.autorizacaoPreviaId)?.horaFim : null;
    return {
      categoria,
      meiosAceitos: meiosAceitos(categoria, i.areaComumId ? 'area_comum' : 'unidade'),
      autorizacoes: autorizacoes.map((a) => ({ id: a.id, estado: estadoAutorizacaoPrevia(a, quando) })),
      emEscala: categoria === 'funcionario' ? escalaVigente(func, quando) : null,
      tipoVisitaPadrao: padrao,
      prazoAte: tipo ? prazoInicial(tipo, quando, janela) : null,
      erro: regra ? { code: regra.code, message: regra.message } : null,
    };
  }

  // ----- Escritas ----------------------------------------------------------------------------------------------------

  async criarEntrada(ctx: Contexto, i: NovoEvento): Promise<EventoView> {
    this.exigirRetroativo(ctx, i.retroativo);
    // Veículo: só na entrada autorizada. O "negado" (restrição) não grava veículo: a pessoa não entrou (minimização).
    const veiculo = colunasVeiculo(i.veiculo);
    const n = this.agora();
    const r = await this.escrever(async (tx): Promise<Resultado> => {
      // FOR NO KEY UPDATE: serializa entradas da mesma pessoa sem bloquear as FKs (FOR KEY SHARE) de outros eventos.
      const [p] = await tx.select({ id: pessoa.id, nome: pessoa.nome, categoria: pessoa.categoria, semCpf: pessoa.semCpf, anonimizadaEm: pessoa.anonimizadaEm,
        desativadaEm: pessoa.desativadaEm, empresa: pessoa.empresa, servico: pessoa.servico }).from(pessoa).where(eq(pessoa.id, i.pessoaId)).for('no key update');
      if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
      if (p.anonimizadaEm) throw erroApi(422, 'PESSOA_ANONIMIZADA', 'Cadastro anonimizado: faça um novo cadastro.');
      // RF-02: desativado não entra (nem retroativo). O FOR NO KEY UPDATE acima espera a desativação concorrente (FOR UPDATE).
      if (p.desativadaEm) throw erroApi(ERRO_PESSOA_DESATIVADA.status, ERRO_PESSOA_DESATIVADA.code, ERRO_PESSOA_DESATIVADA.message);
      const un = i.unidadeDestinoId ? await this.unidades.paraNovoUso(tx, i.unidadeDestinoId) : null;
      const area = i.areaComumId ? await this.areaParaNovoUso(tx, i.areaComumId) : null;
      const { quando, formulario } = resolverInstante(i, n);
      const categoria = await this.categoriaEfetiva(tx, p, i.unidadeDestinoId, quando);
      const ehPrestador = categoria === 'prestador';
      // RF-36: o evento guarda empresa e serviço do cadastro (só prestador)
      const prestacao = { empresa: ehPrestador ? p.empresa ?? null : null, servico: ehPrestador ? p.servico ?? null : null };
      if (area && !ehPrestador) throw erroApi(422, 'AREA_COMUM_SO_PRESTADOR', 'Área comum só é destino de prestador de serviço (RF-36).');
      const ponto = await this.ponto(tx);

      // RF-16: restrição vigente BLOQUEIA. A tentativa vira evento "negado" na trilha (commitado antes do 422).
      const rs = restricoesVigentes(await this.restricoesDaPessoa(tx, p.id), p.id, i.unidadeDestinoId ?? null, quando);
      if (rs.length > 0) {
        const linha = await this.inserir(tx, {
          tipo: 'negado', categoriaPessoa: categoria, pessoaId: p.id, unidadeDestinoId: un?.id ?? null, areaComumId: area?.id ?? null,
          pontoAcessoId: ponto, restricaoId: rs[0]!.id, operadorId: ctx.ator.id, operadorPapel: ctx.ator.papel, ocorridoEm: new Date(quando),
          retroativo: !!i.retroativo, formularioContingencia: formulario, observacao: i.observacao?.trim() || null,
        });
        return { tipo: 'negado', linha, restricoes: rs, destino: un ? `para ${this.unidades.rotulo(un)}` : 'no condomínio' };
      }

      // RN-01, RF-17, RN-07, escala, RF-36 (função pura do domain, a mesma que a tela usa para habilitar o botão)
      const autorizacoes = (await tx.select().from(autorizacaoPrevia).where(and(
        eq(autorizacaoPrevia.pessoaId, p.id), isNull(autorizacaoPrevia.revogadaEm),
        area ? eq(autorizacaoPrevia.areaComumId, area.id) : i.unidadeDestinoId ? eq(autorizacaoPrevia.unidadeId, i.unidadeDestinoId) : sql`false`,
      )).for('share')).map(paraAutorizacaoDominio); // FOR SHARE: a revogação concorrente espera este registro
      const erro = validarAutorizacaoEntrada({ ...i, categoriaPessoa: categoria, semCpf: p.semCpf }, {
        quando,
        moradoresValidosIds: un ? await this.moradoresValidos(tx, un.id, quando) : new Set(),
        autorizacoes,
        funcionario: categoria === 'funcionario' ? await this.funcionarioDe(tx, p.id) : undefined,
      });
      if (erro) throw erroApi(erro.status, erro.code, erro.message);

      if (!i.retroativo && await this.estaDentro(tx, p.id)) {
        throw erroApi(409, 'JA_ESTA_DENTRO', `${p.nome} já consta como dentro do condomínio. Registre a saída antes.`);
      }

      let autPessoaId = i.autorizadoPorPessoaId ?? null;
      // Autorização prévia: o autorizador é o morador que pediu (nulo se sem solicitante ou área comum)
      if (i.autorizadoPorTipo === 'autorizacao_previa') autPessoaId = autorizacoes.find((a) => a.id === i.autorizacaoPreviaId)?.solicitadaPorPessoaId ?? null;
      if (i.autorizadoPorTipo === 'excecao_porteiro' || i.autorizadoPorTipo === 'escala') autPessoaId = null;
      if (categoria === 'morador' && !i.autorizadoPorTipo) autPessoaId = null;

      const linha = await this.inserir(tx, {
        tipo: 'entrada', categoriaPessoa: categoria, pessoaId: p.id, unidadeDestinoId: un?.id ?? null, areaComumId: area?.id ?? null,
        pontoAcessoId: ponto, autorizadoPorTipo: i.autorizadoPorTipo ?? null, autorizadoPorPessoaId: autPessoaId,
        autorizacaoPreviaId: i.autorizadoPorTipo === 'autorizacao_previa' ? i.autorizacaoPreviaId ?? null : null,
        justificativa: i.autorizadoPorTipo === 'excecao_porteiro' ? (i.justificativa ?? '').trim() : null,
        operadorId: ctx.ator.id, operadorPapel: ctx.ator.papel, ocorridoEm: new Date(quando), retroativo: !!i.retroativo,
        formularioContingencia: formulario, observacao: i.observacao?.trim() || null, ...prestacao, ...veiculo,
      });
      // Prazo de permanência (tabela à parte, fora do hash) na MESMA transação: sem evento sem prazo nem prazo sem evento.
      // Conta do ocorrido_em gravado (relógio do banco, ou a hora real no retroativo).
      let prazo: PermanenciaView | null = null;
      if (temPrazoPermanencia(categoria)) {
        const tipo = i.tipoVisita ?? tipoVisitaPadrao(categoria);
        const janela = i.autorizadoPorTipo === 'autorizacao_previa' ? autorizacoes.find((a) => a.id === i.autorizacaoPreviaId)?.horaFim : null;
        const [pz] = await tx.insert(permanencia).values({
          eventoEntradaId: linha.id, ordem: 0, tipoVisita: tipo, prazoAte: new Date(prazoInicial(tipo, linha.ocorridoEm.getTime(), janela)),
          motivo: 'entrada', definidoPorId: ctx.ator.id,
        }).returning();
        prazo = { tipoVisita: pz!.tipoVisita, prazoAte: pz!.prazoAte.getTime(), prorrogacoes: 0 };
      }
      return { tipo: 'evento', linha, prazo };
    });

    const v = await this.view(r.linha);
    if (r.tipo === 'negado') {
      const restricoes = await montarRestricoesView(this.db, r.restricoes);
      throw erroApi(422, 'PESSOA_EM_RESTRICAO', `Entrada não permitida ${r.destino}: ${r.restricoes[0]!.motivo}.`, {
        eventoId: v.id, codigo: v.codigo, restricoes,
      });
    }
    return { ...v, permanencia: r.prazo };
  }

  /**
   * Prorrogação "+1h" do prazo de permanência (linha nova na `permanencia`; nada muda no evento nem na cadeia).
   * Só com a pessoa ainda dentro (sem saída). Limites: 4 prorrogações e 12 h desde a entrada (`proximaProrrogacao`).
   * Duas prorrogações simultâneas: o índice único (evento, ordem) recusa a segunda com 409. Grava a trilha
   * (`permanencia.prorrogar`) na mesma transação.
   */
  async prorrogarPermanencia(ctx: Contexto, entradaId: string): Promise<PermanenciaView & { eventoId: string }> {
    const n = this.agora();
    return this.escrever(async (tx) => {
      const [ent] = await tx.select({ id: eventoAcesso.id, tipo: eventoAcesso.tipo, ocorridoEm: eventoAcesso.ocorridoEm })
        .from(eventoAcesso).where(eq(eventoAcesso.id, entradaId));
      if (!ent || ent.tipo !== 'entrada') throw erroApi(404, 'ENTRADA_NAO_ENCONTRADA', 'Entrada não encontrada.');
      const [saiu] = await tx.select({ id: eventoAcesso.id }).from(eventoAcesso)
        .where(and(eq(eventoAcesso.tipo, 'saida'), eq(eventoAcesso.refereEventoId, ent.id)));
      if (saiu) throw erroApi(422, 'PESSOA_JA_SAIU', 'A saída desta pessoa já foi registrada: não há permanência a prorrogar.');
      const [vig] = await tx.select().from(permanencia).where(eq(permanencia.eventoEntradaId, ent.id)).orderBy(desc(permanencia.ordem)).limit(1);
      if (!vig) throw erroApi(422, 'SEM_PRAZO_PERMANENCIA', 'Esta entrada não tem prazo de permanência (morador, funcionário ou entrada anterior ao controle de prazo).');
      const r = proximaProrrogacao({ entradaEm: ent.ocorridoEm.getTime(), prazoAte: vig.prazoAte.getTime(), prorrogacoes: vig.ordem }, n);
      if (!r.ok) throw erroApi(r.erro.status, r.erro.code, r.erro.message);
      const [nova] = await tx.insert(permanencia).values({
        eventoEntradaId: ent.id, ordem: vig.ordem + 1, tipoVisita: vig.tipoVisita, prazoAte: new Date(r.prazoAte),
        motivo: 'prorrogacao', definidoPorId: ctx.ator.id,
      }).returning();
      await this.auditoria.registrar(tx, {
        ator: ctx.ator, ip: ctx.ip, acao: 'permanencia.prorrogar', entidade: 'permanencia', registroId: nova!.id, antes: vig, depois: nova,
      });
      return { eventoId: ent.id, tipoVisita: nova!.tipoVisita, prazoAte: nova!.prazoAte.getTime(), prorrogacoes: nova!.ordem };
    });
  }

  /** Prazo vigente (linha de maior ordem) de cada entrada da lista. Entrada sem linha fica fora do mapa. */
  private async prazosVigentes(ids: string[]): Promise<Map<string, PermanenciaView>> {
    if (ids.length === 0) return new Map();
    const ls = await this.db.selectDistinctOn([permanencia.eventoEntradaId], {
      id: permanencia.eventoEntradaId, tipoVisita: permanencia.tipoVisita, prazoAte: permanencia.prazoAte, ordem: permanencia.ordem,
    }).from(permanencia).where(inArray(permanencia.eventoEntradaId, ids)).orderBy(permanencia.eventoEntradaId, desc(permanencia.ordem));
    return new Map(ls.map((l) => [l.id, { tipoVisita: l.tipoVisita, prazoAte: l.prazoAte.getTime(), prorrogacoes: l.ordem }]));
  }

  private async areaParaNovoUso(exec: Executor, id: string) {
    const [a] = await exec.select().from(areaComum).where(eq(areaComum.id, id)).for('share');
    if (!a) throw erroApi(404, 'AREA_COMUM_NAO_ENCONTRADA', 'Área comum não encontrada.');
    if (!a.ativo) throw erroApi(422, 'AREA_COMUM_INATIVA', `A área comum ${a.nome} está desativada.`);
    return a;
  }

  /** UC02 A4: o morador recusou a visita. Fica na trilha como evento "recusado", sem entrada. */
  async registrarRecusa(ctx: Contexto, i: NovaRecusa): Promise<EventoView> {
    this.exigirRetroativo(ctx, i.retroativo);
    const n = this.agora();
    const linha = await this.escrever(async (tx) => {
      const [p] = await tx.select({ id: pessoa.id, categoria: pessoa.categoria }).from(pessoa).where(eq(pessoa.id, i.pessoaId));
      if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
      await this.unidades.paraNovoUso(tx, i.unidadeDestinoId);
      if (!meioComMorador(i.meio)) throw erroApi(422, 'MEIO_INVALIDO_PARA_TIPO', 'A recusa só se registra por interfone, celular ou morador presente.');
      const { quando, formulario } = resolverInstante(i, n);
      if (!(await this.temVinculoValido(tx, i.moradorPessoaId, i.unidadeDestinoId, quando))) {
        throw erroApi(422, 'AUTORIZADOR_SEM_VINCULO', 'O morador que recusou não tem vínculo válido (aprovado ou legado no prazo) com a unidade.');
      }
      return this.inserir(tx, {
        tipo: 'recusado', categoriaPessoa: await this.categoriaEfetiva(tx, p, i.unidadeDestinoId, quando), pessoaId: p.id,
        unidadeDestinoId: i.unidadeDestinoId, pontoAcessoId: await this.ponto(tx), autorizadoPorTipo: i.meio, autorizadoPorPessoaId: i.moradorPessoaId,
        operadorId: ctx.ator.id, operadorPapel: ctx.ator.papel, ocorridoEm: new Date(quando), retroativo: !!i.retroativo,
        formularioContingencia: formulario, observacao: i.observacao?.trim() || null,
      });
    });
    return this.view(linha);
  }

  /** A saída é um NOVO evento ligado à entrada; a entrada não é alterada (RN-04). Retroativa: hora real entre a entrada e agora. */
  async registrarSaida(ctx: Contexto, entradaId: string, o: OpcoesSaida): Promise<EventoView> {
    this.exigirRetroativo(ctx, o.retroativo);
    const n = this.agora();
    const linha = await this.escrever(async (tx) => {
      const [ent] = await tx.select().from(eventoAcesso).where(eq(eventoAcesso.id, entradaId));
      if (!ent || ent.tipo !== 'entrada') throw erroApi(404, 'ENTRADA_NAO_ENCONTRADA', 'Entrada não encontrada.');
      const [jaSaiu] = await tx.select({ id: eventoAcesso.id }).from(eventoAcesso)
        .where(and(eq(eventoAcesso.tipo, 'saida'), eq(eventoAcesso.refereEventoId, ent.id)));
      if (jaSaiu) throw erroApi(409, 'SAIDA_JA_REGISTRADA', 'A saída desta entrada já foi registrada.');
      const base = await this.efetivo(tx, paraDominio(ent));
      const { quando, formulario } = resolverInstante(o, n, base.ocorridoEm);
      return this.inserir(tx, {
        tipo: 'saida', categoriaPessoa: ent.categoriaPessoa, pessoaId: base.pessoaId, unidadeDestinoId: base.unidadeDestinoId,
        areaComumId: base.areaComumId, pontoAcessoId: await this.ponto(tx), operadorId: ctx.ator.id, operadorPapel: ctx.ator.papel,
        ocorridoEm: new Date(quando), retroativo: !!o.retroativo, refereEventoId: ent.id, formularioContingencia: formulario,
        observacao: o.observacao?.trim() || null,
      });
    });
    return this.view(linha);
  }

  /** Evento com os valores efetivos (original + última correção). */
  private async efetivo(exec: Executor, e: ReturnType<typeof paraDominio>) {
    const [c] = await exec.select({ v: eventoAcesso.correcaoValores }).from(eventoAcesso)
      .where(and(eq(eventoAcesso.tipo, 'correcao'), eq(eventoAcesso.corrigeEventoId, e.id))).orderBy(desc(eventoAcesso.seq)).limit(1);
    const cv = correcaoDoBanco(c?.v ?? null);
    return cv ? { ...e, ...cv } : e;
  }

  /**
   * RN-04: correção é um evento novo; não se corrige uma correção. `correcao_valores` carrega o ACUMULADO das correções
   * anteriores (a última é a que vale). Sem valores: só anotação (justificativa e observação).
   */
  async corrigir(ctx: Contexto, id: string, i: NovaCorrecao): Promise<EventoView> {
    const n = this.agora();
    const linha = await this.escrever(async (tx) => {
      // Serializa correções do mesmo evento (sem UPDATE em evento_acesso, não há FOR UPDATE para app_rw).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`correcao:${id}`}, 0))`);
      const [orig] = await tx.select().from(eventoAcesso).where(eq(eventoAcesso.id, id));
      if (!orig) throw erroApi(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado.');
      if (orig.tipo === 'correcao') throw erroApi(422, 'CORRECAO_DE_CORRECAO', 'Não é possível corrigir uma correção: corrija o evento original.');
      if (!justificativaValida(i.justificativa)) {
        throw erroApi(422, 'JUSTIFICATIVA_OBRIGATORIA', `A correção exige justificativa de pelo menos ${MIN_JUSTIFICATIVA} caracteres (RN-04).`);
      }
      const [anterior] = await tx.select({ v: eventoAcesso.correcaoValores }).from(eventoAcesso)
        .where(and(eq(eventoAcesso.tipo, 'correcao'), eq(eventoAcesso.corrigeEventoId, id))).orderBy(desc(eventoAcesso.seq)).limit(1);
      const acumulado = correcaoDoBanco(anterior?.v ?? null) ?? {};
      const atual = { ...paraDominio(orig), ...acumulado };
      const v = i.valores ?? {};
      const novos: Partial<ValoresCorrecao> = {};
      const existe = async (pid: string) => !!(await tx.select({ id: pessoa.id }).from(pessoa).where(eq(pessoa.id, pid)))[0];
      if (v.unidadeDestinoId !== undefined) {
        if (atual.areaComumId) throw erroApi(422, 'DESTINO_AREA_COMUM', 'Evento em área comum não tem unidade de destino para corrigir.');
        if (v.unidadeDestinoId === null && atual.categoriaPessoa !== 'funcionario') throw erroApi(422, 'UNIDADE_OBRIGATORIA', 'Informe a unidade de destino.');
        if (v.unidadeDestinoId !== null) {
          // 404; unidade inativa vale (corrige o histórico). Pela `tx`: no PGlite (uma conexão) outra consulta trava.
          const [u] = await tx.select({ id: unidade.id }).from(unidade).where(eq(unidade.id, v.unidadeDestinoId));
          if (!u) throw erroApi(404, 'UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada.');
        }
        novos.unidadeDestinoId = v.unidadeDestinoId;
      }
      if (v.ocorridoEm !== undefined) {
        if (!Number.isFinite(v.ocorridoEm) || v.ocorridoEm >= n) throw erroApi(422, 'DATA_INCONSISTENTE', 'A data e hora corrigidas devem ser anteriores ao momento atual.');
        novos.ocorridoEm = v.ocorridoEm;
      }
      if (v.pessoaId !== undefined) {
        if (!(await existe(v.pessoaId))) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
        novos.pessoaId = v.pessoaId;
      }
      if (v.autorizadoPorPessoaId !== undefined) {
        // Autorizador é pessoa (id), nunca nome livre (spec §4.4)
        if (v.autorizadoPorPessoaId !== null && !(await existe(v.autorizadoPorPessoaId))) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Autorizador não encontrado.');
        if (v.autorizadoPorPessoaId === null && meioComMorador(atual.autorizadoPorTipo)) {
          throw erroApi(422, 'AUTORIZADOR_OBRIGATORIO', 'Informe o morador que autorizou.');
        }
        novos.autorizadoPorPessoaId = v.autorizadoPorPessoaId;
      }
      const juntos: Partial<ValoresCorrecao> = { ...acumulado, ...novos };
      const canonico: Partial<ValoresCorrecao> = {};
      for (const k of CAMPOS_CORRIGIVEIS) if (k in juntos) (canonico as Record<string, unknown>)[k] = juntos[k];
      return this.inserir(tx, {
        tipo: 'correcao', categoriaPessoa: atual.categoriaPessoa, pessoaId: atual.pessoaId, unidadeDestinoId: atual.unidadeDestinoId,
        areaComumId: atual.areaComumId, pontoAcessoId: orig.pontoAcessoId, justificativa: i.justificativa.trim(),
        operadorId: ctx.ator.id, operadorPapel: ctx.ator.papel, ocorridoEm: new Date(n), retroativo: false, corrigeEventoId: orig.id,
        observacao: i.observacao?.trim() || null,
        correcaoValores: Object.keys(canonico).length > 0 ? correcaoParaBanco(canonico) : null,
      });
    });
    return this.view(linha);
  }

  // ----- Consultas ---------------------------------------------------------------------------------------------------

  /** Filtros pelos VALORES EFETIVOS, devolvendo o registro gravado. */
  private filtros(f: FiltroEventos): SQL[] {
    const w: SQL[] = [];
    if (f.eventoId) w.push(eq(eventoAcesso.id, f.eventoId));
    if (f.de !== undefined) w.push(filtroEfetivo('ocorrido_em', (x) => sql`${x} >= ${new Date(f.de!).toISOString()}::timestamptz`));
    if (f.ate !== undefined) w.push(filtroEfetivo('ocorrido_em', (x) => sql`${x} <= ${new Date(f.ate!).toISOString()}::timestamptz`));
    if (f.unidadeId) w.push(filtroEfetivo('unidade_destino_id', (x) => sql`${x} = ${f.unidadeId}::uuid`));
    if (f.pessoaId) w.push(filtroEfetivo('pessoa_id', (x) => sql`${x} = ${f.pessoaId}::uuid`));
    if (f.pessoa?.trim()) {
      const q = `%${normalizar(f.pessoa).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      w.push(sql`EXISTS (SELECT 1 FROM ${pessoa} WHERE ${pessoa.id} = ${efetivoSql('pessoa_id')} AND ${nomeSemAcentoSql()} LIKE ${q})`);
    }
    // Placa: gravada só na ENTRADA e não corrigível (sem filtroEfetivo). A saída não tem placa própria: entra pelo
    // `refere_evento_id` da entrada. Menos de 3 caracteres: ignora (não erro), para não varrer a trilha com "A".
    const placa = f.placa?.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (placa && placa.length >= 3) {
      const q = `%${placa.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      w.push(sql`(${eventoAcesso.veiculoPlaca} LIKE ${q} OR (${eventoAcesso.tipo} = 'saida' AND EXISTS (
        SELECT 1 FROM evento_acesso ent WHERE ent.id = ${eventoAcesso.refereEventoId} AND ent.veiculo_placa LIKE ${q})))`);
    }
    if (f.operadorId) w.push(eq(eventoAcesso.operadorId, f.operadorId));
    if (f.tipo) w.push(eq(eventoAcesso.tipo, f.tipo));
    if (f.excluirTipos?.length) w.push(sql`${eventoAcesso.tipo} NOT IN (${sql.join(f.excluirTipos.map((t) => sql`${t}`), sql`, `)})`);
    if (f.meio) w.push(eq(eventoAcesso.autorizadoPorTipo, f.meio));
    if (f.somenteExcecoes) w.push(ehExcecaoSql());
    if (f.somenteRetroativos) w.push(eq(eventoAcesso.retroativo, true));
    return w;
  }

  /** Página por seq decrescente (mais recentes primeiro). */
  async listar(f: FiltroEventos & { limite: number; cursor?: string }): Promise<Pagina<EventoView>> {
    const w = this.filtros(f);
    if (f.cursor) w.push(lt(eventoAcesso.seq, decodificarCursor(f.cursor, CursorSeq).s));
    const linhas = await this.db.select().from(eventoAcesso).where(w.length ? and(...w) : undefined).orderBy(desc(eventoAcesso.seq)).limit(f.limite + 1);
    const pagina = linhas.slice(0, f.limite);
    const ultimo = pagina[pagina.length - 1];
    return new Pagina(await montarViews(this.db, pagina), linhas.length > f.limite && ultimo ? codificarCursor({ s: ultimo.seq }) : null);
  }

  /** Para exportação e verificação: as linhas cruas que casam com o filtro, em ordem de seq, até `teto` + 1. */
  async linhas(f: FiltroEventos, teto: number): Promise<LinhaEvento[]> {
    const w = this.filtros(f);
    return this.db.select().from(eventoAcesso).where(w.length ? and(...w) : undefined).orderBy(asc(eventoAcesso.seq)).limit(teto + 1);
  }

  async obter(id: string): Promise<EventoView> {
    const [l] = await this.db.select().from(eventoAcesso).where(eq(eventoAcesso.id, id));
    if (!l) throw erroApi(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado.');
    return this.view(l);
  }

  /** Correções do evento, da mais antiga para a mais nova (linha do tempo da gaveta). */
  async correcoesDe(id: string): Promise<EventoView[]> {
    const ls = await this.db.select().from(eventoAcesso)
      .where(and(eq(eventoAcesso.tipo, 'correcao'), eq(eventoAcesso.corrigeEventoId, id))).orderBy(asc(eventoAcesso.seq)).limit(100);
    return montarViews(this.db, ls);
  }

  /** RF-20: entradas sem saída, por seq decrescente (o adaptador ordena pela hora efetiva). */
  async presentes(p: { limite: number; cursor?: string }): Promise<Pagina<EventoView>> {
    const w: SQL[] = [eq(eventoAcesso.tipo, 'entrada'), semSaidaSql()];
    if (p.cursor) w.push(lt(eventoAcesso.seq, decodificarCursor(p.cursor, CursorSeq).s));
    const linhas = await this.db.select().from(eventoAcesso).where(and(...w)).orderBy(desc(eventoAcesso.seq)).limit(p.limite + 1);
    const pagina = linhas.slice(0, p.limite);
    const ultimo = pagina[pagina.length - 1];
    const [views, prazos] = await Promise.all([montarViews(this.db, pagina), this.prazosVigentes(pagina.map((l) => l.id))]);
    // "+1h" possível agora? Mesma regra da prorrogação (`proximaProrrogacao`), contada da entrada gravada.
    const n = this.agora();
    const entradaEm = new Map(pagina.map((l) => [l.id, l.ocorridoEm.getTime()]));
    const comProximo = (id: string): PermanenciaView | null => {
      const pz = prazos.get(id);
      if (!pz) return null;
      const r = proximaProrrogacao({ entradaEm: entradaEm.get(id)!, prazoAte: pz.prazoAte, prorrogacoes: pz.prorrogacoes }, n);
      return { ...pz, proximoPrazo: r.ok ? r.prazoAte : null };
    };
    return new Pagina(views.map((v) => ({ ...v, permanencia: comProximo(v.id) })), linhas.length > p.limite && ultimo ? codificarCursor({ s: ultimo.seq }) : null);
  }

  /**
   * "Mesmo veículo da última visita": o veículo da última ENTRADA com veículo da pessoa (pessoa efetiva, depois de
   * correção), pela ordem da cadeia. Nulo se nunca veio de veículo ou se o cadastro foi anonimizado (o evento guarda a
   * placa até a retenção, mas ela não é mais oferecida para preencher).
   */
  async ultimoVeiculo(pessoaId: string): Promise<{ veiculo: VeiculoAcesso | null }> {
    const [p] = await this.db.select({ anonimizadaEm: pessoa.anonimizadaEm }).from(pessoa).where(eq(pessoa.id, pessoaId));
    if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
    if (p.anonimizadaEm) return { veiculo: null };
    const [l] = await this.db.select({ placa: eventoAcesso.veiculoPlaca, modelo: eventoAcesso.veiculoModelo, cor: eventoAcesso.veiculoCor })
      .from(eventoAcesso)
      .where(and(eq(eventoAcesso.tipo, 'entrada'), sql`${eventoAcesso.veiculoPlaca} IS NOT NULL`,
        filtroEfetivo('pessoa_id', (x) => sql`${x} = ${pessoaId}::uuid`)))
      .orderBy(desc(eventoAcesso.seq)).limit(1);
    return { veiculo: l?.placa ? { placa: l.placa, modelo: l.modelo, cor: l.cor } : null };
  }

  /** RF-29: resumo da passagem de turno (contagens por tipo de evento). */
  async resumoTurno() {
    const n = this.agora();
    const ini = new Date(inicioDoDia(n)).toISOString();
    const fim = new Date(fimDoDia(n)).toISOString();
    const dow = partes(n).dow;
    const total = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
    const [pessoasDentro, encomendasPendentes, ocorrenciasAbertas, autorizacoesHoje, excecoesHoje, restricoesPendentes] = await Promise.all([
      total(this.db.select({ n: count() }).from(eventoAcesso).where(and(eq(eventoAcesso.tipo, 'entrada'), semSaidaSql()))),
      total(this.db.select({ n: count() }).from(encomenda).where(isNull(encomenda.retiradaEm))),
      total(this.db.select({ n: count() }).from(ocorrencia).where(ne(ocorrencia.status, 'encerrada'))),
      total(this.db.select({ n: count() }).from(autorizacaoPrevia).where(and(isNull(autorizacaoPrevia.revogadaEm),
        sql`${autorizacaoPrevia.validaDe} <= ${fim}::timestamptz`, sql`${autorizacaoPrevia.validaAte} >= ${ini}::timestamptz`,
        sql`(${autorizacaoPrevia.diasSemana} IS NULL OR ${dow}::smallint = ANY(${autorizacaoPrevia.diasSemana}))`))),
      total(this.db.select({ n: count() }).from(eventoAcesso).where(and(ehExcecaoSql(), filtroEfetivo('ocorrido_em', (x) => sql`${x} >= ${ini}::timestamptz`)))),
      total(this.db.select({ n: count() }).from(restricao).where(and(eq(restricao.escopo, 'condominio'), isNull(restricao.aprovadaEm), isNull(restricao.revogadaEm)))),
    ]);
    return { pessoasDentro, encomendasPendentes, ocorrenciasAbertas, autorizacoesHoje, excecoesHoje, restricoesPendentes };
  }
}
