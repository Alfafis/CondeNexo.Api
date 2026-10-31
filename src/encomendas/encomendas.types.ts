

/** Formato da view de encomenda (instantes em epoch ms; transportadora e rastreio vazios como ''). */
export interface EncomendaViewApi {
  id: string; codigo: string; unidadeId: string; destinatario: string; transportadora: string; codigoRastreio: string;
  recebidaPorId: string; recebidaEm: number; unidadeConfirmada: boolean;
  retiradaEm: number | null; retiradaPorPessoaId: string | null; retiradaRegistradaPorId: string | null; retiradaAutorizacaoId: string | null;
  unidadeCodigo: string; recebidaPorNome: string; retiradaPorNome: string | null; retiradaRegistradaPorNome: string | null;
  /** Aguardando retirada há mais de DIAS_ENCOMENDA_ATRASADA dias inteiros (`encomendaAtrasada`) no instante da resposta. */
  atrasada: boolean;
  autorizacoes: {
    id: string; encomendaId: string; pessoaAutorizadaId: string; solicitantePessoaId: string; registradaPorId: string; registradaEm: number;
    pessoaNome: string; solicitanteNome: string;
  }[];
}
