import { statusOcorrencia, tipoOcorrencia } from '../db/schema';

export type Status = (typeof statusOcorrencia.enumValues)[number];
export type TipoOcorrencia = (typeof tipoOcorrencia.enumValues)[number];

export interface AnexoViewApi { id: string; nome: string; mime: string; tamanhoBytes: number; enviadoEm: number; enviadoPorNome: string }
/** Formato da view de ocorrência, mais `documentos` (anexos com id para download). */
export interface OcorrenciaViewApi {
  id: string; codigo: string; tipo: TipoOcorrencia; descricao: string; unidadeId: string | null; envolvidos: string;
  abertaPorId: string; abertaEm: number; status: Status; abertaPorNome: string; unidadeCodigo: string | null;
  historicoStatus: { de: Status; para: Status; porId: string; em: number; porNome: string }[];
  anexos: string[]; eventoIds: string[]; documentos: AnexoViewApi[];
}

/** Arquivo como o multer (memória) entrega; só os campos usados. O nome e o mimetype do cliente são ignorados. */
export interface ArquivoEnviado { buffer: Buffer; size: number }
