import type { PessoaApi } from '../pessoas/pessoa-view';

export interface Escala { diasSemana: number[]; horaInicio: string; horaFim: string }
export interface FuncionarioApi {
  pessoaId: string; funcao: string; escala: Escala; ativo: boolean; pessoa: PessoaApi; emEscalaAgora: boolean;
}
