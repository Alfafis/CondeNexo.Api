// Regras de negócio puras (sem React, sem I/O). Usadas pela UI (para habilitar botões)
// e, principalmente, pela API (que é quem realmente decide).
import type {
  AutorizacaoPrevia, CategoriaPessoa, ConferenciaComprovante, Escala, Funcionario, MeioAutorizacao, PermanenciaView, Pessoa,
  Restricao, TipoVisita, VinculoUnidade,
} from './types';
import { DIA, DIAS_SEMANA_ABREV, HORA, fmtDuracao, fmtHora, hhmmParaMin, inicioDoDia, menosAnos, minutosDoDia, partes } from './time';

export const MIN_JUSTIFICATIVA = 15;
export const DIAS_ENCOMENDA_ATRASADA = 7;
export const HORAS_PERMANENCIA_ALERTA = 8;

// ----- Senha temporária (spec §5.1) ---------------------------------------------------------------------------------
// Criada pela administração (cadastro ou redefinição) e enviada por mensagem: vale 72 h. Constante de regra, não
// configuração de ambiente. A API grava o fim em usuario_sistema.senha_temporaria_expira_em.
export const SENHA_TEMPORARIA_VALIDADE_MS = 72 * HORA;

/**
 * Senha temporária vencida: troca pendente e prazo passado. Troca pendente SEM prazo gravado também conta como vencida
 * (falha fechada: linha escrita fora da API não vira senha eterna). Sem troca pendente, nunca.
 */
export function senhaTemporariaVencida(u: { deveTrocarSenha?: boolean; senhaTemporariaExpiraEm?: number | null }, agora: number): boolean {
  if (!u.deveTrocarSenha) return false;
  return u.senhaTemporariaExpiraEm == null || u.senhaTemporariaExpiraEm <= agora;
}

// ----- Anexos de ocorrência (RF-27, RNF-03, spec §9.2) -------------------------------------------------------------
// Os mesmos limites na tela (pré-validação) e na API (decisão). 4 MiB: a foto de celular comprimida e o PDF de um
// boletim cabem, e o corpo passa pelo proxy da Vercel em produção (limite de ~4,5 MB por requisição).
export const ANEXO_MAX_BYTES = 4 * 1024 * 1024;
export const ANEXO_MAX_POR_OCORRENCIA = 5;
/** Tipos aceitos e a extensão do nome de download. O nome original do arquivo não é guardado (pode ter dado pessoal). */
export const ANEXO_TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;
export type MimeAnexo = keyof typeof ANEXO_TIPOS;
export const ehMimeAnexo = (m: string): m is MimeAnexo => Object.prototype.hasOwnProperty.call(ANEXO_TIPOS, m);

/** Tipo pelo CONTEÚDO (assinatura dos primeiros bytes), nunca pelo nome ou pelo Content-Type que o cliente declara. */
export function tipoAnexoPorConteudo(b: Uint8Array): MimeAnexo | null {
  const comeca = (...xs: number[]) => b.length >= xs.length && xs.every((x, i) => b[i] === x);
  if (comeca(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (comeca(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (comeca(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  return null;
}

export interface ErroRegra { status: number; code: string; message: string }

/** CPF com dígito verificador (11 dígitos, sem máscara). */
export function cpfValido(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dig = (n: number) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dig(9) === Number(d[9]) && dig(10) === Number(d[10]);
}

export const justificativaValida = (t?: string | null) => (t ?? '').trim().length >= MIN_JUSTIFICATIVA;

// ----- Desativação do cadastro (RF-02) ----------------------------------------------------------------------------

/** Desativado: não entra, não recebe vínculo nem autorização prévia, some das buscas. O histórico continua. */
export const pessoaDesativada = (p: { desativadaEm?: number | null }) => p.desativadaEm != null;

export const ERRO_PESSOA_DESATIVADA: ErroRegra = {
  status: 422, code: 'PESSOA_DESATIVADA',
  message: 'Cadastro desativado: peça à administração ou ao síndico para reativá-lo antes de registrar.',
};

/**
 * Pode desativar? Ordem: estado do cadastro (409) -> motivo (422) -> o que prende a pessoa ao condomínio (422).
 * Autorizações prévias vigentes NÃO bloqueiam: são revogadas junto (spec §14, 2026-10-22).
 */
export function validarDesativacaoPessoa(
  p: { anonimizada: boolean; desativada: boolean },
  motivo: string | null | undefined,
  prende: { vinculoValido: boolean; dentro: boolean; funcionarioAtivo: boolean },
): ErroRegra | null {
  if (p.anonimizada) return { status: 409, code: 'PESSOA_ANONIMIZADA', message: 'Cadastro anonimizado não pode ser desativado.' };
  if (p.desativada) return { status: 409, code: 'PESSOA_JA_DESATIVADA', message: 'Este cadastro já está desativado.' };
  if (!justificativaValida(motivo)) return { status: 422, code: 'MOTIVO_OBRIGATORIO', message: `Informe o motivo da desativação (pelo menos ${MIN_JUSTIFICATIVA} caracteres).` };
  if (prende.dentro) return { status: 422, code: 'PESSOA_DENTRO', message: 'A pessoa consta como dentro do condomínio: registre a saída antes de desativar.' };
  if (prende.vinculoValido) return { status: 422, code: 'PESSOA_COM_VINCULO_VALIDO', message: 'A pessoa tem vínculo válido com uma unidade: encerre o vínculo antes de desativar.' };
  if (prende.funcionarioAtivo) return { status: 422, code: 'FUNCIONARIO_ATIVO', message: 'A pessoa é funcionário ativo: desative-a em Funcionários antes.' };
  return null;
}

// ----- Vínculo --------------------------------------------------------------------------------

/**
 * Vínculo válido = aprovado dentro da vigência OU legado dentro do prazo de regularização (RN-09).
 * Mesma regra para autorizar visitante por interfone ou celular e para retirar encomenda.
 * Datas de fim/prazo valem até o fim do dia.
 */
export function vinculoValido(v: VinculoUnidade, agora: number): boolean {
  if (v.status === 'aprovado') {
    if (v.vigenciaInicio !== null && agora < v.vigenciaInicio) return false;
    if (v.vigenciaFim !== null && agora >= v.vigenciaFim + DIA) return false;
    return true;
  }
  if (v.status === 'legado') return v.prazoRegularizacao !== null && agora < v.prazoRegularizacao + DIA;
  return false;
}

export const vinculosValidosDaUnidade = (vs: readonly VinculoUnidade[], unidadeId: string, agora: number) =>
  vs.filter((v) => v.unidadeId === unidadeId && vinculoValido(v, agora));

export const pessoaTemVinculoValido = (vs: readonly VinculoUnidade[], pessoaId: string, unidadeId: string, agora: number) =>
  vs.some((v) => v.pessoaId === pessoaId && v.unidadeId === unidadeId && vinculoValido(v, agora));

/**
 * RN-08: encomenda só é entregue a pessoa com vínculo válido na unidade de destino OU autorizada a retirar
 * por um morador com vínculo válido (`autorizada`). `rotulo` é o código da unidade, só para a mensagem.
 */
export function podeEntregarEncomenda(
  vs: readonly VinculoUnidade[], pessoaId: string, unidadeId: string, agora: number, autorizada = false, rotulo = 'unidade',
): { ok: true; por: 'vinculo' | 'autorizacao' } | { ok: false; motivo: string } {
  if (pessoaTemVinculoValido(vs, pessoaId, unidadeId, agora)) return { ok: true, por: 'vinculo' };
  if (autorizada) return { ok: true, por: 'autorizacao' };
  return { ok: false, motivo: `Esta pessoa não tem vínculo com a ${rotulo} nem autorização de retirada. Contate a unidade.` };
}

/**
 * Cadastro completo (pré-requisito para aprovar ou regularizar vínculo): CPF (não "sem CPF"), telefone e não anonimizado.
 * Dependente menor de idade (LGPD art. 14) num vínculo de `dependente` dispensa CPF e telefone.
 */
export const cadastroCompleto = (
  p?: Pick<Pessoa, 'semCpf' | 'documentoBusca' | 'telefone' | 'anonimizadaEm' | 'menorIdade'> | null,
  tipoVinculo?: string,
) => !!p && !p.semCpf && !p.anonimizadaEm
  && ((!!p.documentoBusca && /^\d{10,11}$/.test((p.telefone ?? '').replace(/\D/g, ''))) || (!!p.menorIdade && tipoVinculo === 'dependente'));

/** Legado com prazo de regularização vencido (RN-09): continua listado, em destaque, para revisão da administração. */
export const legadoVencido = (v: VinculoUnidade, agora: number) =>
  v.status === 'legado' && v.prazoRegularizacao !== null && agora >= v.prazoRegularizacao + DIA;

// Conferência do comprovante (RF-05). Mesmos limites dos CHECKs vinculo_conferencia_* do banco.
export const MAX_DESCRICAO_COMPROVANTE = 80;
export const MAX_OBSERVACAO_CONFERENCIA = 200;
/** Heurística anti-dado-pessoal (CHECK vinculo_conferencia_sem_numero_ck): 9+ dígitos seguidos, ignorando ". -", é CPF ou telefone. */
export const temNumeroDePessoa = (t: string) => /[0-9]{9}/.test(t.replace(/[. -]/g, ''));

export function validarConferencia(
  i: { tipo: string; descricao?: string; observacao?: string; data: number }, agora: number,
): ErroRegra | null {
  const e = (code: string, message: string): ErroRegra => ({ status: 422, code, message });
  if (!['escritura', 'contrato_compra_venda', 'contrato_locacao', 'outro'].includes(i.tipo)) return e('TIPO_COMPROVANTE_INVALIDO', 'Tipo de comprovante inválido.');
  const desc = (i.descricao ?? '').trim();
  const obs = (i.observacao ?? '').trim();
  if (i.tipo === 'outro' && !desc) return e('DESCRICAO_OBRIGATORIA', 'Descreva o comprovante quando o tipo for “Outro”.');
  if (desc.length > MAX_DESCRICAO_COMPROVANTE) return e('DESCRICAO_LONGA', `A descrição tem no máximo ${MAX_DESCRICAO_COMPROVANTE} caracteres.`);
  if (obs.length > MAX_OBSERVACAO_CONFERENCIA) return e('OBSERVACAO_LONGA', `A observação tem no máximo ${MAX_OBSERVACAO_CONFERENCIA} caracteres.`);
  if (temNumeroDePessoa(`${i.tipo === 'outro' ? desc : ''} ${obs}`)) {
    return e('DADO_PESSOAL_NA_CONFERENCIA', 'Não escreva CPF, telefone ou outro número pessoal na conferência: registre só o tipo do documento.');
  }
  if (i.data > agora) return e('DATA_FUTURA', 'A data da conferência não pode ser futura.');
  return null;
}

/** RN-02: aprovar exige conferência registrada (o cadastro completo é checado à parte); rejeitar exige justificativa. */
export function validarDecisaoVinculo(
  decisao: 'aprovar' | 'rejeitar', justificativa: string | undefined, conferencia: ConferenciaComprovante | null,
): ErroRegra | null {
  const j = (justificativa ?? '').trim();
  if (decisao === 'rejeitar' && j.length === 0) {
    return { status: 422, code: 'JUSTIFICATIVA_OBRIGATORIA', message: 'Rejeitar um vínculo exige justificativa.' };
  }
  if (decisao === 'aprovar' && !conferencia) {
    return { status: 422, code: 'CONFERENCIA_OBRIGATORIA', message: 'Registre a conferência do comprovante (RF-05) antes de aprovar o vínculo.' };
  }
  return null;
}

// ----- Restrição ------------------------------------------------------------------------------

/** Restrições vigentes (RF-16): não revogadas, não expiradas; as de escopo condomínio só depois de aprovadas. */
export function restricoesVigentes(
  rs: readonly Restricao[], pessoaId: string, unidadeId: string | null, agora: number,
): Restricao[] {
  // Restrição de condomínio vale mesmo sem unidade de destino (ex.: funcionário em escala).
  return rs.filter((r) => {
    if (r.pessoaId !== pessoaId || r.revogadaEm !== null || agora > r.validaAte) return false;
    if (r.escopo === 'condominio') return r.aprovadaEm !== null;
    return unidadeId !== null && r.unidadeId === unidadeId;
  });
}

// ----- Autorização prévia ---------------------------------------------------------------------

export type EstadoAutorizacao = 'valida' | 'fora_da_janela' | 'expirada' | 'ainda_nao_vale' | 'revogada';

/** Considera validade (data) e janela (dias da semana + horário) usando o relógio informado. */
export function estadoAutorizacaoPrevia(ap: AutorizacaoPrevia, agora: number): EstadoAutorizacao {
  if (ap.revogadaEm !== null) return 'revogada';
  if (agora > ap.validaAte) return 'expirada';
  if (agora < ap.validaDe) return 'ainda_nao_vale';
  const p = partes(agora);
  if (ap.diasSemana && !ap.diasSemana.includes(p.dow)) return 'fora_da_janela';
  if (ap.horaInicio && ap.horaFim) {
    const m = minutosDoDia(agora);
    if (m < hhmmParaMin(ap.horaInicio) || m > hhmmParaMin(ap.horaFim)) return 'fora_da_janela';
  }
  return 'valida';
}

export interface JanelaAutorizacao { inicio: number; fim: number }

/**
 * Primeira janela da autorização que intersecta [agora, agora + horizonteMs], no fuso de São Paulo (o mesmo de
 * `estadoAutorizacaoPrevia`). `inicio`/`fim` são os limites reais da janela (já recortados por validaDe/validaAte), sem
 * recorte em `agora`: janela em curso devolve `inicio <= agora`. O fim do horário é inclusivo até o fim do minuto, como
 * em `estadoAutorizacaoPrevia`. Sem horário, a janela é o dia inteiro. Revogada, expirada ou sem dia que case: null.
 * Janela que vira a meia-noite (horaFim < horaInicio) não existe (a API a recusa): devolve null.
 */
export function proximaJanelaAutorizacao(ap: AutorizacaoPrevia, agora: number, horizonteMs: number): JanelaAutorizacao | null {
  if (ap.revogadaEm !== null || horizonteMs < 0) return null;
  const limite = agora + horizonteMs;
  const comHora = !!(ap.horaInicio && ap.horaFim);
  const hIni = comHora ? hhmmParaMin(ap.horaInicio!) : 0;
  const hFim = comHora ? hhmmParaMin(ap.horaFim!) : 0;
  if (comHora && hFim < hIni) return null;
  for (let dia = inicioDoDia(agora); dia <= limite; dia += DIA) {
    if (ap.diasSemana && !ap.diasSemana.includes(partes(dia).dow)) continue;
    const ini = Math.max(comHora ? dia + hIni * 60_000 : dia, ap.validaDe);
    const fim = Math.min(comHora ? dia + hFim * 60_000 + 59_999 : dia + DIA - 1, ap.validaAte);
    if (ini <= fim && ini <= limite && fim >= agora) return { inicio: ini, fim };
  }
  return null;
}

const hAbrev = (s: string) => {
  const [h, m] = s.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
};

/** "seg a sex, 8h–18h" */
export function descreverJanela(ap: Pick<AutorizacaoPrevia, 'diasSemana' | 'horaInicio' | 'horaFim'>): string {
  let dias = 'todos os dias';
  const d = ap.diasSemana;
  if (d && d.length > 0 && d.length < 7) {
    const ord = [...d].sort((a, b) => a - b);
    const contiguo = ord.every((x, i) => i === 0 || x === ord[i - 1] + 1);
    dias = contiguo && ord.length > 2
      ? `${DIAS_SEMANA_ABREV[ord[0]]} a ${DIAS_SEMANA_ABREV[ord[ord.length - 1]]}`
      : ord.map((x) => DIAS_SEMANA_ABREV[x]).join(', ');
  }
  const horas = ap.horaInicio && ap.horaFim ? `, ${hAbrev(ap.horaInicio)}–${hAbrev(ap.horaFim)}` : '';
  return dias + horas;
}

/** "15h–17h" (para a mensagem de fora do horário). */
export const descreverHorario = (ap: Pick<AutorizacaoPrevia, 'horaInicio' | 'horaFim'>) =>
  ap.horaInicio && ap.horaFim ? `${hAbrev(ap.horaInicio)}–${hAbrev(ap.horaFim)}` : 'sem horário definido';

// ----- Meios de autorização -------------------------------------------------------------------

export type Destino = 'unidade' | 'area_comum';

/**
 * Meios em que um morador identificado (com vínculo válido na unidade) autoriza a entrada ou recusa a visita (RN-01,
 * UC02 A4). Mesmo conjunto dos CHECKs evento_morador_identificado_ck e evento_recusa_meio_ck no banco.
 */
export const MEIOS_COM_MORADOR = ['interfone', 'celular', 'morador_presente'] as const satisfies readonly MeioAutorizacao[];
export type MeioComMorador = (typeof MEIOS_COM_MORADOR)[number];
export const meioComMorador = (m: MeioAutorizacao | null | undefined): m is MeioComMorador =>
  !!m && (MEIOS_COM_MORADOR as readonly string[]).includes(m);

export function meiosAceitos(categoria: CategoriaPessoa, destino: Destino = 'unidade'): MeioAutorizacao[] {
  // RF-36: área comum (só prestador) não tem morador para autorizar: autorização prévia da administração ou exceção.
  if (destino === 'area_comum') return ['autorizacao_previa', 'excecao_porteiro'];
  const base: MeioAutorizacao[] = ['interfone', 'celular', 'morador_presente', 'autorizacao_previa', 'excecao_porteiro'];
  // Escala só existe para funcionário do condomínio (correção 5)
  return categoria === 'funcionario' ? [...base, 'escala'] : base;
}

/** RF-09: escala válida (mesmos CHECKs de `funcionario`): 1 a 7 dias entre 0 e 6, horas HH:MM diferentes. */
export function validarEscala(e: Escala): string | null {
  if (!Array.isArray(e.diasSemana) || e.diasSemana.length < 1 || e.diasSemana.length > 7) return 'Escolha de 1 a 7 dias da semana.';
  if (new Set(e.diasSemana).size !== e.diasSemana.length || e.diasSemana.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Dias da semana inválidos.';
  const hh = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hh.test(e.horaInicio) || !hh.test(e.horaFim)) return 'Informe início e fim no formato HH:MM.';
  if (e.horaInicio === e.horaFim) return 'O início e o fim da escala devem ser diferentes.';
  return null;
}

/**
 * RF-09: escala vigente no instante. Escala que atravessa a meia-noite (ex.: 22:00–06:00) vale no dia do
 * início do turno: a madrugada seguinte ainda pertence ao turno do dia anterior.
 */
export function escalaVigente(f: Funcionario | undefined, agora: number): boolean {
  if (!f || !f.ativo) return false;
  const p = partes(agora);
  const m = minutosDoDia(agora);
  const ini = hhmmParaMin(f.escala.horaInicio);
  const fim = hhmmParaMin(f.escala.horaFim);
  if (fim >= ini) return f.escala.diasSemana.includes(p.dow) && m >= ini && m <= fim;
  // Atravessa a meia-noite: parte da noite (dia do início) ou parte da madrugada (dia anterior ao atual)
  return (f.escala.diasSemana.includes(p.dow) && m >= ini) || (f.escala.diasSemana.includes((p.dow + 6) % 7) && m <= fim);
}

// ----- Entrada (RN-01, RF-13, RF-17, RN-07) ---------------------------------------------------

export interface DadosAutorizacao {
  categoriaPessoa: CategoriaPessoa;
  unidadeDestinoId?: string | null;
  /** RF-36: destino área comum (só prestador). */
  areaComumId?: string | null;
  autorizadoPorTipo?: MeioAutorizacao | null;
  autorizadoPorPessoaId?: string | null;
  autorizacaoPreviaId?: string | null;
  justificativa?: string | null;
  /** Pessoa cadastrada sem CPF: só entra por exceção do porteiro. */
  semCpf?: boolean;
}

export interface ContextoAutorizacao {
  /** Instante do acesso (no retroativo, a hora real informada). */
  quando: number;
  /** Pessoas com vínculo válido na unidade de destino. */
  moradoresValidosIds: ReadonlySet<string>;
  /** Autorizações prévias da pessoa para o destino (unidade ou área comum). */
  autorizacoes: readonly AutorizacaoPrevia[];
  funcionario?: Funcionario;
}

const e422 = (code: string, message: string): ErroRegra => ({ status: 422, code, message });

/** Valida o autorizador de uma entrada. Retorna null se estiver tudo certo. */
export function validarAutorizacaoEntrada(d: DadosAutorizacao, ctx: ContextoAutorizacao): ErroRegra | null {
  if (d.unidadeDestinoId && d.areaComumId) return e422('DESTINO_DUPLO', 'Informe a unidade OU a área comum, não as duas.');
  if (d.areaComumId && d.categoriaPessoa !== 'prestador') {
    return e422('AREA_COMUM_SO_PRESTADOR', 'Área comum só é destino de prestador de serviço (RF-36).');
  }
  if (d.categoriaPessoa !== 'funcionario' && !d.unidadeDestinoId && !d.areaComumId) {
    return e422('UNIDADE_OBRIGATORIA', 'Informe a unidade de destino.');
  }
  if (d.categoriaPessoa === 'morador') return null;
  const tipo = d.autorizadoPorTipo;
  if (!tipo) return e422('AUTORIZADO_POR_OBRIGATORIO', 'Informe quem autorizou a entrada (RN-01).');
  if (d.semCpf && tipo !== 'excecao_porteiro') {
    return e422('SEM_CPF_SO_EXCECAO', 'Pessoa cadastrada sem CPF só pode entrar por exceção do porteiro, com justificativa.');
  }
  if (!meiosAceitos(d.categoriaPessoa, d.areaComumId ? 'area_comum' : 'unidade').includes(tipo)) {
    return e422('MEIO_INVALIDO_PARA_TIPO', d.areaComumId
      ? 'Na área comum a entrada é por autorização prévia da administração ou exceção do porteiro.'
      : 'Este meio de autorização não se aplica ao tipo de pessoa.');
  }
  switch (tipo) {
    case 'interfone':
    case 'celular':
    case 'morador_presente':
      if (!d.autorizadoPorPessoaId) {
        return e422('AUTORIZADO_POR_SEM_IDENTIFICACAO', 'Informe o morador que autorizou (nome obrigatório).');
      }
      if (!ctx.moradoresValidosIds.has(d.autorizadoPorPessoaId)) {
        return e422('AUTORIZADOR_SEM_VINCULO', 'O autorizador não tem vínculo válido (aprovado ou legado no prazo) com a unidade.');
      }
      return null;
    case 'excecao_porteiro':
      return justificativaValida(d.justificativa)
        ? null
        : e422('JUSTIFICATIVA_OBRIGATORIA', `A exceção exige justificativa de pelo menos ${MIN_JUSTIFICATIVA} caracteres (RF-17).`);
    case 'autorizacao_previa': {
      const ap = ctx.autorizacoes.find((a) => a.id === d.autorizacaoPreviaId);
      if (!ap || estadoAutorizacaoPrevia(ap, ctx.quando) !== 'valida') {
        return e422('AUTORIZACAO_PREVIA_INVALIDA', 'Autorização prévia inexistente, vencida ou fora da janela de dias/horário (RN-07).');
      }
      return null;
    }
    case 'escala':
      return escalaVigente(ctx.funcionario, ctx.quando)
        ? null
        : e422('ESCALA_FORA_DO_HORARIO', 'O funcionário não está em horário de escala.');
  }
}

/** Ajuda para a UI: pode habilitar "Confirmar entrada"? */
export const podeConfirmarEntrada = (d: DadosAutorizacao, ctx: ContextoAutorizacao) =>
  validarAutorizacaoEntrada(d, ctx) === null;

// ----- Permanência e encomendas ---------------------------------------------------------------

export const permanenciaExcedida = (entradaEm: number, agora: number) =>
  agora - entradaEm > HORAS_PERMANENCIA_ALERTA * 3600 * 1000;

// Nunca negativo: o relógio da tela pode estar alguns segundos atrás do registro recém-criado.
export const diasDesde = (ts: number, agora: number) => Math.max(0, Math.floor((agora - ts) / DIA));
export const encomendaAtrasada = (recebidaEm: number, agora: number) => diasDesde(recebidaEm, agora) > DIAS_ENCOMENDA_ATRASADA;

// ----- Retenção (RNF-09, spec 9.1) ----------------------------------------------------------------

export const ANOS_RETENCAO = 3;

/** Término do vínculo para a retenção: encerrado_em; no rejeitado, a decisão. Vínculo ainda ativo não terminou. */
export function terminoVinculo(v: VinculoUnidade): number | null {
  if (v.status === 'encerrado') return v.encerradoEm ?? v.vigenciaFim;
  if (v.status === 'rejeitado') return v.decididoEm ?? v.solicitadoEm;
  return null;
}

/**
 * Pessoa elegível para anonimização automática (RNF-09):
 * - visitante/prestador: último acesso (ou o cadastro, se nunca entrou) há mais de 3 anos;
 * - morador: nenhum vínculo ativo (pendente, aprovado ou legado) e o último terminou há mais de 3 anos.
 * Funcionário e pessoa já anonimizada ficam de fora.
 */
export function elegivelRetencao(
  p: Pick<Pessoa, 'categoria' | 'anonimizadaEm' | 'criadoEm'>, vinculosDaPessoa: readonly VinculoUnidade[], ultimoAcesso: number | null, agora: number,
): boolean {
  if (p.anonimizadaEm) return false;
  const limite = menosAnos(agora, ANOS_RETENCAO);
  if (p.categoria === 'visitante' || p.categoria === 'prestador') {
    // Visitante que já teve vínculo ativo não é anonimizado como visitante
    if (vinculosDaPessoa.some((v) => terminoVinculo(v) === null)) return false;
    return (ultimoAcesso ?? p.criadoEm) < limite;
  }
  if (p.categoria === 'morador') {
    if (vinculosDaPessoa.length === 0) return (ultimoAcesso ?? p.criadoEm) < limite;
    const terminos = vinculosDaPessoa.map(terminoVinculo);
    if (terminos.some((t) => t === null)) return false;
    return Math.max(...(terminos as number[])) < limite;
  }
  return false;
}

// ----- Tempo de permanência por tipo de visita (tabela `permanencia`, FORA da cadeia de hash) -------------------------
// Decisão de 2026-10-23 (spec §14): o prazo é definido na entrada pelo tipo de visita e prorrogado em "+1h" pela
// portaria. Fica numa tabela append-only à parte (migração 0011): o evento_acesso, a canonização e o hash não mudam.
// Só visitante e prestador têm prazo; morador e funcionário não. `permanenciaExcedida` (8 h fixas) continua valendo
// para quem não tem prazo gravado (entradas de antes da migração), para a tela não perder o alerta.

/** Prazo padrão por tipo de visita, em minutos. */
export const PRAZO_PADRAO_MIN: Record<TipoVisita, number> = { visita: 240, entrega: 30, transporte_app: 15, servico: 480 };
/** "+1h": cada prorrogação. */
export const PRORROGACAO_MIN = 60;
/** Máximo de prorrogações por entrada (espelhado no CHECK `permanencia_ordem_ck` da migração 0011). */
export const MAX_PRORROGACOES = 4;
/** Teto do prazo contado da hora da entrada (espelhado no trigger `permanencia_antes_inserir` da migração 0011). */
export const PERMANENCIA_MAXIMA_MS = 12 * HORA;
/** A partir de quantos minutos antes do prazo a tela avisa "Vence em X min". */
export const AVISO_VENCIMENTO_MIN = 15;

export const temPrazoPermanencia = (c: CategoriaPessoa) => c === 'visitante' || c === 'prestador';
export const tipoVisitaPadrao = (c: CategoriaPessoa): TipoVisita => (c === 'prestador' ? 'servico' : 'visita');

/**
 * Prazo da entrada. Serviço com janela de horário (autorização prévia com hora fim): até a hora fim no dia da entrada,
 * se ainda não passou; senão o padrão do tipo. Sempre limitado a PERMANENCIA_MAXIMA_MS desde a entrada.
 */
export function prazoInicial(tipo: TipoVisita, entradaEm: number, horaFimJanela?: string | null): number {
  let prazo = entradaEm + PRAZO_PADRAO_MIN[tipo] * 60_000;
  if (tipo === 'servico' && horaFimJanela) {
    const fim = inicioDoDia(entradaEm) + hhmmParaMin(horaFimJanela) * 60_000;
    if (fim > entradaEm) prazo = fim;
  }
  return Math.min(prazo, entradaEm + PERMANENCIA_MAXIMA_MS);
}

export type EstadoPermanencia = 'no_prazo' | 'vence_em_breve' | 'expirado';

export function estadoPermanencia(prazoAte: number, agora: number): EstadoPermanencia {
  if (agora > prazoAte) return 'expirado';
  return prazoAte - agora <= AVISO_VENCIMENTO_MIN * 60_000 ? 'vence_em_breve' : 'no_prazo';
}

/** Texto para a tela: "Vence em 12min", "Expirado há 1h 05min" ou "Até 15:30". Minutos arredondados para cima no aviso. */
export function descreverPermanencia(prazoAte: number, agora: number): string {
  const estado = estadoPermanencia(prazoAte, agora);
  if (estado === 'expirado') return `Expirado há ${fmtDuracao(agora - prazoAte)}`;
  if (estado === 'vence_em_breve') return `Vence em ${fmtDuracao(Math.ceil((prazoAte - agora) / 60_000) * 60_000)}`;
  return `Até ${fmtHora(prazoAte)}`;
}

/**
 * Próximo prazo de uma prorrogação "+1h": a partir do prazo vigente, ou de agora se ele já venceu (o porteiro dá mais
 * uma hora a quem está lá dentro), limitado ao teto de 12 h desde a entrada. Recusa a partir da 4ª prorrogação ou
 * quando o teto já foi alcançado. "Ainda está dentro" é conferido pela API e pelo banco, não aqui.
 */
export function proximaProrrogacao(
  p: { entradaEm: number } & Pick<PermanenciaView, 'prazoAte' | 'prorrogacoes'>, agora: number,
): { ok: true; prazoAte: number } | { ok: false; erro: ErroRegra } {
  if (p.prorrogacoes >= MAX_PRORROGACOES) {
    return { ok: false, erro: e422('PRORROGACAO_LIMITE', `Limite de ${MAX_PRORROGACOES} prorrogações atingido para esta entrada.`) };
  }
  const teto = p.entradaEm + PERMANENCIA_MAXIMA_MS;
  const novo = Math.min(Math.max(p.prazoAte, agora) + PRORROGACAO_MIN * 60_000, teto);
  if (novo <= p.prazoAte || novo <= agora) {
    return { ok: false, erro: e422('PRORROGACAO_LIMITE', `A permanência já chegou ao máximo de ${PERMANENCIA_MAXIMA_MS / HORA} h desde a entrada.`) };
  }
  return { ok: true, prazoAte: novo };
}
