// Tipos de domínio. Espelham as tabelas do schema (src/db/schema.ts, spec seção 3).
// Convenção: nomes do domínio em português (EventoAcesso, VinculoUnidade...), campos em camelCase.
// Todos os instantes são epoch em milissegundos (UTC); a exibição usa o fuso de São Paulo.
// As entidades guardam só ids de usuário e de pessoa; os nomes são resolvidos nas views (o banco faz join).

export type Papel = 'sindico' | 'administracao' | 'porteiro' | 'auditor';
export const ROTULO_PAPEL: Record<Papel, string> = {
  sindico: 'Síndico', administracao: 'Administração', porteiro: 'Porteiro', auditor: 'Auditor',
};

export type CategoriaPessoa = 'morador' | 'visitante' | 'prestador' | 'funcionario';
export const ROTULO_CATEGORIA: Record<CategoriaPessoa, string> = {
  morador: 'Morador', visitante: 'Visitante', prestador: 'Prestador', funcionario: 'Funcionário',
};
/** Só CPF (decisão de produto). Pessoa sem CPF usa `semCpf` e só entra por exceção do porteiro. */
export type TipoDocumento = 'cpf';

/** Unidade (RF-01). `id` é uuid; o código "A-32" é derivado de bloco e número (`codigoUnidade`). */
export interface Unidade {
  id: string;
  /** 1 a 3 letras maiúsculas ou dígitos ("A", "4", "B2"; CHECK do schema). */
  bloco: string;
  /** Só dígitos, mínimo 2 ("03", "32"; CHECK do schema). */
  numero: string;
  ativo: boolean;
}

/** Área comum atendida por prestador (RF-36). */
export interface AreaComum { id: string; nome: string; ativo: boolean }

/** Ponto de acesso. Hoje só existe a portaria social (seed). */
export interface PontoAcesso { id: string; nome: string; ativo: boolean }

export interface Pessoa {
  id: string;
  nome: string;
  documentoTipo: TipoDocumento;
  /** Sempre mascarado (ex.: 123.45*.***-** ou, no formato antigo, ***.456.789-**), "(sem CPF)" ou "(anonimizado)". O CPF nunca é guardado. */
  documentoMascarado: string;
  /** HMAC-SHA256 hex dos 11 dígitos do CPF (mesmo algoritmo de src/db/cpf.ts): busca exata e deduplicação. */
  documentoBusca?: string;
  /** Cadastro sem CPF (exceção): só entra por `excecao_porteiro` e não pode ter vínculo aprovado. */
  semCpf?: boolean;
  /** Dependente menor de idade (LGPD art. 14): CPF e telefone opcionais; no vínculo de dependente, o cadastro já é completo. */
  menorIdade?: boolean;
  /** Só dígitos, com DDD (10 ou 11). Ausente apenas em importado (legado), anonimizado ou menor de idade. */
  telefone?: string;
  /** API real: '(**) *****-1234' nas listas e para quem não pode editar o cadastro (o telefone completo não vem). */
  telefoneMascarado?: string;
  categoria: CategoriaPessoa;
  empresa?: string;
  servico?: string;
  /** Origem do cadastro legado (importação da planilha). */
  importacaoId?: string;
  /** Preenchido pela anonimização (LGPD): nome genérico, sem documento, telefone, empresa e serviço. */
  anonimizadaEm?: number | null;
  /** Cadastro desativado (RF-02): some das buscas e não entra; o histórico fica. Nulo/ausente = ativo. */
  desativadaEm?: number | null;
  /** Só na ficha, para quem pode desativar (SI, AD). */
  desativacaoMotivo?: string | null;
  criadoEm: number;
}

export interface Escala { diasSemana: number[]; horaInicio: string; horaFim: string }

export interface Funcionario {
  pessoaId: string;
  funcao: string;
  escala: Escala;
  ativo: boolean;
}

export type TipoVinculo = 'proprietario' | 'inquilino' | 'dependente';
export const ROTULO_VINCULO: Record<TipoVinculo, string> = {
  proprietario: 'Proprietário', inquilino: 'Inquilino', dependente: 'Dependente',
};
export type StatusVinculo = 'pendente' | 'aprovado' | 'rejeitado' | 'encerrado' | 'legado';
export const ROTULO_STATUS_VINCULO: Record<StatusVinculo, string> = {
  pendente: 'Pendente', aprovado: 'Aprovado', rejeitado: 'Rejeitado', encerrado: 'Encerrado', legado: 'Legado',
};

/** Tipo do comprovante de vínculo conferido pela administração (RF-05; enum tipo_comprovante do banco). */
export type TipoComprovante = 'escritura' | 'contrato_compra_venda' | 'contrato_locacao' | 'outro';
export const ROTULO_COMPROVANTE: Record<TipoComprovante, string> = {
  escritura: 'Escritura', contrato_compra_venda: 'Contrato de compra e venda', contrato_locacao: 'Contrato de locação', outro: 'Outro',
};
/**
 * Registro da conferência do comprovante (RF-05). O arquivo NÃO é guardado (LGPD art. 6º, III): só tipo, data e
 * quem conferiu. `observacao` é curta e sem dado pessoal (nada de CPF, telefone ou nome de terceiro).
 * Colunas conferencia_* de vinculo_unidade.
 */
export interface ConferenciaComprovante {
  tipoDocumento: TipoComprovante;
  /** Obrigatória se, e somente se, tipoDocumento = 'outro'. */
  descricao?: string;
  /** Início do dia (BRT) em que o comprovante foi conferido. */
  data: number;
  conferidoPorId: string;
  observacao?: string;
}

export interface VinculoUnidade {
  id: string;
  pessoaId: string;
  unidadeId: string;
  tipo: TipoVinculo;
  status: StatusVinculo;
  vigenciaInicio: number | null;
  vigenciaFim: number | null; // null = indeterminada
  prazoRegularizacao: number | null; // obrigatório se legado (RN-09)
  /** Conferência do comprovante (RF-05). Obrigatória para aprovar e para regularizar legado (RN-02, RN-09). */
  conferencia: ConferenciaComprovante | null;
  /** Origem do pedido em texto (ex.: "a pedido de Carla Mendes"). Quem registrou é `registradoPorId`. */
  solicitadoPor: string;
  solicitadoEm: number;
  /** Usuário que registrou o vínculo (no legado, quem executou a importação). */
  registradoPorId: string;
  importacaoId?: string;
  nota?: string;
  decididoPorId?: string;
  decididoEm?: number;
  justificativa?: string;
  /** Preenchido se, e somente se, encerrado (RF-07; marco da retenção do morador). */
  encerradoEm: number | null;
}

export interface Veiculo { id: string; unidadeId: string; placa: string; modelo: string; cor: string; /** Ausente = ativo. */ ativo?: boolean }

export interface AutorizacaoPrevia {
  id: string;
  /** Destino: unidade OU área comum (exatamente um). */
  unidadeId: string | null;
  areaComumId: string | null;
  pessoaId: string;
  validaDe: number;
  validaAte: number; // obrigatória (RN-07)
  diasSemana: number[] | null; // 0 = domingo ... 6 = sábado; null = todos
  horaInicio: string | null; // "HH:MM"
  horaFim: string | null;
  cadastradaPorId: string;
  cadastradaEm: number;
  /** Morador que pediu (unidade). Nulo na área comum e no "sem solicitante". */
  solicitadaPorPessoaId: string | null;
  /** Unidade sem morador solicitante: exige `justificativa` e conta como exceção de quem cadastrou. */
  semSolicitante: boolean;
  justificativa: string | null;
  revogadaEm: number | null;
  revogadaPorId: string | null;
}

export interface Restricao {
  id: string;
  escopo: 'unidade' | 'condominio';
  unidadeId: string | null; // unidade de origem do pedido (obrigatória se escopo = unidade)
  pessoaId: string;
  motivo: string;
  validaAte: number;
  cadastradaPorId: string;
  cadastradaEm: number;
  /** Morador que pediu: obrigatório no escopo unidade, opcional no condomínio. */
  solicitadaPorPessoaId: string | null;
  aprovadaPorId: string | null; // escopo condomínio exige síndico (RN-06)
  aprovadaEm: number | null;
  revogadaEm: number | null;
  revogadaPorId: string | null;
}

export type TipoEvento = 'entrada' | 'saida' | 'negado' | 'correcao' | 'recusado';
// 'celular': WhatsApp ou ligação para o celular do morador quando ele não atende o interfone (questionário 22/10/2026).
// Mesma regra do interfone (morador identificado, com vínculo válido); não é exceção.
export type MeioAutorizacao = 'interfone' | 'celular' | 'morador_presente' | 'autorizacao_previa' | 'excecao_porteiro' | 'escala';
export const ROTULO_MEIO: Record<MeioAutorizacao, string> = {
  interfone: 'Interfone',
  celular: 'Celular (WhatsApp ou ligação)',
  morador_presente: 'Morador presente na portaria',
  autorizacao_previa: 'Autorização prévia',
  excecao_porteiro: 'Exceção do porteiro',
  escala: 'Escala',
};
export const ROTULO_MEIO_CURTO: Record<MeioAutorizacao, string> = {
  interfone: 'Interfone', celular: 'Celular', morador_presente: 'Morador presente', autorizacao_previa: 'Autorização prévia',
  excecao_porteiro: 'Exceção', escala: 'Escala',
};

/**
 * Valores que uma correção substitui (spec 4.4). Mesmo conjunto de `correcao_valores` no banco, em camelCase e
 * com instante em epoch ms; a serialização canônica (hashChain.ts) converte para snake_case e ISO.
 */
export interface ValoresCorrecao {
  unidadeDestinoId: string | null;
  ocorridoEm: number;
  pessoaId: string;
  autorizadoPorPessoaId: string | null;
}
/** Ordem canônica (igual a CHAVES_CORRECAO_V1 em snake_case). */
export const CAMPOS_CORRIGIVEIS = ['unidadeDestinoId', 'ocorridoEm', 'pessoaId', 'autorizadoPorPessoaId'] as const;

/**
 * Evento de acesso: APPEND-ONLY. Nunca é alterado; saída e correção são novos eventos.
 * Mesmas colunas de `evento_acesso`. Não há código nem nome copiado: o código de exibição deriva de `seq`
 * (`codigoEvento`) e os nomes vêm das views.
 */
export interface EventoAcesso {
  id: string;
  seq: number;
  /** Versão da serialização canônica do hash: 1 sem veículo, 2 entrada com veículo (hashChain.ts). */
  formatoHash: number;
  tipo: TipoEvento;
  categoriaPessoa: CategoriaPessoa;
  pessoaId: string;
  /** Destino: unidade OU área comum (área comum só para prestador, RF-36). */
  unidadeDestinoId: string | null;
  areaComumId: string | null;
  pontoAcessoId: string;
  autorizadoPorTipo: MeioAutorizacao | null;
  autorizadoPorPessoaId: string | null;
  autorizacaoPreviaId: string | null;
  justificativa: string | null;
  restricaoId: string | null;
  operadorId: string;
  /** Papel do operador no momento do registro (entra no hash). */
  operadorPapel: Papel;
  ocorridoEm: number;
  registradoEm: number;
  retroativo: boolean;
  /** Saída aponta para a entrada. */
  refereEventoId: string | null;
  /** Correção aponta para o evento corrigido (RN-04). */
  corrigeEventoId: string | null;
  observacao: string | null;
  /** Nº do formulário de papel (contingência). Obrigatório em registro retroativo; entra no hash. */
  formularioContingencia: string | null;
  /** Correção: valores substituídos (acumulado das correções anteriores), ou null se for só anotação. */
  correcaoValores: Partial<ValoresCorrecao> | null;
  /** Só prestador: copiados do cadastro no momento da entrada (RF-36). */
  empresa: string | null;
  servico: string | null;
  /**
   * Veículo com que a pessoa chegou (só entrada; entra no hash, formato 2). Placa em maiúsculas sem hífen
   * (antiga ou Mercosul); modelo e cor opcionais. A pé: os três nulos. Não é corrigível (fora de correcao_valores).
   */
  veiculoPlaca: string | null;
  veiculoModelo: string | null;
  veiculoCor: string | null;
  hashAnterior: string;
  hash: string;
}

/** Veículo de um acesso, para exibição (placa sem hífen, como gravada). */
export interface VeiculoAcesso { placa: string; modelo: string | null; cor: string | null }

/** Evento com nomes resolvidos para exibição (a trilha guarda apenas IDs). */
export interface EventoView extends EventoAcesso {
  /** Código de exibição derivado de `seq` (EV-000123). Não é gravado. */
  codigo: string;
  pessoaNome: string;
  operadorNome: string;
  /** Código da unidade ("A-32") ou nome da área comum. */
  unidadeRotulo: string | null;
  areaComumNome: string | null;
  pontoAcessoNome: string;
  /**
   * Quem autorizou, resolvido pelo id (interfone, celular, morador presente, recusa e autorização prévia com solicitante).
   * Autorização sem solicitante: "Sem solicitante — cadastrada por <usuário>"; área comum: "Área comum — cadastrada por <usuário>".
   */
  autorizadoPorNome: string | null;
  /**
   * Veículo do acesso: o da própria entrada ou, numa saída, o da entrada a que ela se refere (a saída não grava
   * veículo). Nulo a pé e nos demais tipos.
   */
  veiculo: VeiculoAcesso | null;
  /** Para entradas: a saída vinculada, se houver. */
  saida: { id: string; codigo: string; em: number } | null;
  /** Para entradas sem saída ainda. */
  dentro: boolean;
  /** Para saídas: código da entrada. */
  entradaCodigo: string | null;
  /** Se houver correção com valores, os campos acima já vêm EFETIVOS; aqui ficam os valores originais substituídos. */
  valoresOriginais: Partial<ValoresCorrecao> | null;
  /** Última correção aplicada a este evento (original + última correção). */
  correcao: { id: string; codigo: string; em: number; justificativa: string | null; observacao: string | null; operadorNome: string } | null;
  /** Para eventos de correção: os valores que ela substitui. */
  valoresCorrigidos: Partial<ValoresCorrecao> | null;
  /** Nomes para exibir a pessoa original (evento corrigido) e a pessoa corrigida (evento de correção). */
  pessoaNomeOriginal: string | null;
  pessoaNomeCorrigida: string | null;
  /** Nomes do autorizador original (evento corrigido) e corrigido (evento de correção). */
  autorizadoPorNomeOriginal: string | null;
  autorizadoPorNomeCorrigido: string | null;
  /** Entrada por autorização prévia cadastrada sem solicitante (conta como exceção). */
  autorizacaoSemSolicitante: boolean;
  /**
   * Prazo de permanência vigente (tabela `permanencia`, fora da cadeia de hash). Só na listagem de presentes
   * (`GET /acessos/presentes`); nulo para morador, funcionário e entradas anteriores à migração 0011.
   */
  permanencia?: PermanenciaView | null;
}

export interface Encomenda {
  id: string;
  codigo: string;
  unidadeId: string;
  destinatario: string;
  transportadora: string;
  codigoRastreio: string;
  recebidaPorId: string;
  recebidaEm: number;
  unidadeConfirmada: boolean;
  retiradaEm: number | null;
  retiradaPorPessoaId: string | null;
  retiradaRegistradaPorId: string | null;
  /** Preenchido quando quem retirou não tem vínculo e foi autorizado por morador (RN-08). */
  retiradaAutorizacaoId: string | null;
}

/** Autorização de retirada dada por morador com vínculo válido (RN-08: "ou a pessoa autorizada por ela"). */
export interface AutorizacaoRetirada {
  id: string;
  encomendaId: string;
  pessoaAutorizadaId: string;
  solicitantePessoaId: string;
  registradaPorId: string;
  registradaEm: number;
}

export type TipoOcorrencia = 'conflito' | 'tentativa_acesso_indevido' | 'dano' | 'encomenda' | 'outro';
export const ROTULO_TIPO_OCORRENCIA: Record<TipoOcorrencia, string> = {
  conflito: 'Conflito', tentativa_acesso_indevido: 'Tentativa de acesso indevido', dano: 'Dano',
  encomenda: 'Encomenda', outro: 'Outro',
};
export type StatusOcorrencia = 'aberta' | 'em_andamento' | 'encerrada';
export const ROTULO_STATUS_OCORRENCIA: Record<StatusOcorrencia, string> = {
  aberta: 'Aberta', em_andamento: 'Em andamento', encerrada: 'Encerrada',
};

export interface MudancaStatusOcorrencia { de: StatusOcorrencia; para: StatusOcorrencia; porId: string; em: number }

export interface Ocorrencia {
  id: string;
  codigo: string; // OC-2026-047
  tipo: TipoOcorrencia;
  descricao: string;
  unidadeId: string | null; // null = área comum
  envolvidos: string;
  abertaPorId: string;
  abertaEm: number;
  status: StatusOcorrencia;
  /** Quem e quando de cada mudança de status. */
  historicoStatus: MudancaStatusOcorrencia[];
  anexos: string[];
  eventoIds: string[];
}

export interface UsuarioSistema {
  id: string;
  nome: string;
  login: string;
  papel: Papel;
  ativo: boolean;
  ultimoAcesso: number | null;
  /** Troca de senha pendente (senha temporária criada pela administração). Ausente onde a API não informa. */
  deveTrocarSenha?: boolean;
  /** Fim da validade da senha temporária (ms). Só na gestão de usuários; null sem troca pendente. */
  senhaTemporariaExpiraEm?: number | null;
}

export type StatusImportacao = 'analisada' | 'confirmada' | 'cancelada';

/** Importação da planilha (RF-11). As linhas não ficam aqui: só contagens (como no schema). */
export interface Importacao {
  id: string;
  arquivoNome: string;
  arquivoSha256: string;
  status: StatusImportacao;
  lidas: number;
  importaveis: number;
  rejeitadas: number;
  avisos: number;
  importados: number | null;
  reaproveitados: number | null;
  prazoRegularizacao: number;
  executadaPorId: string;
  analisadaEm: number;
  confirmadaEm: number | null;
}

/** Trilha de alterações do sistema (append-only), distinta da trilha de acessos com hash. */
export interface RegistroAlteracao {
  id: string;
  seq: number;
  em: number;
  usuarioId: string | null; // null: falha de login com usuário inexistente
  usuarioNome: string;
  usuarioPapel: Papel | null;
  acao: string; // ex.: 'pessoa.criar'
  entidade: string;
  registroId: string;
  /** Snapshots com CPF/telefone mascarados. */
  antes: Record<string, unknown> | null;
  depois: Record<string, unknown> | null;
  /** Preenchido pela redação LGPD (única alteração permitida, como `lgpd_redigir_audit_pessoa`). */
  redigidoEm?: number | null;
}

// ----- Tempo de permanência (prazo por tipo de visita, spec §14 2026-10-23) ----------------------------------------
// Fica FORA da cadeia de hash: tabela `permanencia` (append-only, à parte do evento_acesso). Só visitante e prestador.

export type TipoVisita = 'visita' | 'entrega' | 'transporte_app' | 'servico';
export const TIPOS_VISITA: readonly TipoVisita[] = ['visita', 'entrega', 'transporte_app', 'servico'];
export const ROTULO_TIPO_VISITA: Record<TipoVisita, string> = {
  visita: 'Visita', entrega: 'Entregador', transporte_app: 'Motorista de app', servico: 'Serviço',
};

/** Prazo vigente de uma entrada (a linha mais recente da `permanencia`). */
export interface PermanenciaView {
  tipoVisita: TipoVisita;
  /** Epoch ms. */
  prazoAte: number;
  /** Quantas prorrogações já foram feitas (0 = só o prazo da entrada). */
  prorrogacoes: number;
  /**
   * Só na lista de presentes: o prazo que um "+1h" daria no instante da resposta (`proximaProrrogacao`), ou null se o
   * limite (4 prorrogações ou 12 h desde a entrada) já foi alcançado. A prorrogação em si decide de novo.
   */
  proximoPrazo?: number | null;
}
