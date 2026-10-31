// Verificador INDEPENDENTE da cadeia de hash da trilha de acessos (RF-32, RF-37; spec §4.3 e §4.7).
// A serialização canônica (v1 e v2, a v2 com o veículo da entrada) e o verificador vivem em ../dominio/hashChain (fonte única, WebCrypto), e são os
// mesmos usados pela exportação verificável. Aqui fica só o mapeamento da linha do Drizzle.
// O trigger `evento_acesso_antes_inserir` reproduz a mesma serialização em SQL (`evento_acesso_canonico`).
import { camposVeiculo, type EventoExportado } from '../dominio/hashChain';

export {
  CAMPOS_CANONICOS_V1, CAMPOS_CANONICOS_V2, CHAVES_CORRECAO_V1, FORMATO_HASH, FORMATO_HASH_VEICULO, calcularHashExportado, hashGenese,
  jsonCanonico, jsonCanonicoV1, sha256Hex, verificarCadeia,
} from '../dominio/hashChain';
export type { Ancora, EventoExportado, ResultadoVerificacao } from '../dominio/hashChain';

/** Linha do Drizzle (`typeof eventoAcesso.$inferSelect`) -> formato de exportação. */
export function paraExportacao(r: {
  formatoHash: number; seq: number; id: string; tipo: string; categoriaPessoa: string; pessoaId: string;
  unidadeDestinoId: string | null; areaComumId: string | null; pontoAcessoId: string; autorizadoPorTipo: string | null;
  autorizadoPorPessoaId: string | null; autorizacaoPreviaId: string | null; justificativa: string | null;
  restricaoId: string | null; operadorId: string; operadorPapel: string; ocorridoEm: Date; registradoEm: Date;
  retroativo: boolean; formularioContingencia: string | null; refereEventoId: string | null; corrigeEventoId: string | null;
  correcaoValores: Record<string, string | null> | null; empresa: string | null; servico: string | null;
  observacao: string | null; veiculoPlaca?: string | null; veiculoModelo?: string | null; veiculoCor?: string | null;
  hashAnterior: string; hash: string;
}): EventoExportado {
  return {
    v: r.formatoHash, seq: r.seq, id: r.id, tipo: r.tipo, categoria_pessoa: r.categoriaPessoa, pessoa_id: r.pessoaId,
    unidade_destino_id: r.unidadeDestinoId, area_comum_id: r.areaComumId, ponto_acesso_id: r.pontoAcessoId,
    autorizado_por_tipo: r.autorizadoPorTipo, autorizado_por_pessoa_id: r.autorizadoPorPessoaId,
    autorizacao_previa_id: r.autorizacaoPreviaId, justificativa: r.justificativa, restricao_id: r.restricaoId,
    operador_id: r.operadorId, operador_papel: r.operadorPapel, ocorrido_em: r.ocorridoEm.toISOString(),
    registrado_em: r.registradoEm.toISOString(), retroativo: r.retroativo, formulario_contingencia: r.formularioContingencia,
    refere_evento_id: r.refereEventoId, corrige_evento_id: r.corrigeEventoId, correcao_valores: r.correcaoValores,
    empresa: r.empresa, servico: r.servico, observacao: r.observacao,
    ...camposVeiculo(r.formatoHash, r.veiculoPlaca, r.veiculoModelo, r.veiculoCor),
    hash_anterior: r.hashAnterior, hash: r.hash,
  };
}
