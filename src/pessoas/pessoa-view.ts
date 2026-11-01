// Pessoa como a API devolve (minimização, LGPD art. 6º, III):
// - documento_busca (HMAC do CPF) NUNCA sai da API;
// - telefone completo NUNCA sai da API (decisão de 2026-10-24): nem na ficha, nem nas respostas de escrita, para
//   nenhum papel. Só `telefoneMascarado`; a correção do cadastro envia o número novo sem precisar ler o atual.
//   Exceção desde 2026-11-01 (Fase B, decisão do dono do produto): o "Revelar" do app do Master, um registro por vez,
//   com limite e linha em plataforma_audit (PessoasService.paraRevelarNaPlataforma). Nenhum papel do condomínio.
import { pode } from '../dominio/rbac';
import type { Papel } from '../dominio/types';
import { mascararTelefone } from '../auditoria/snapshot';
import { pessoa } from '../db/schema';

export const SEM_CPF = '(sem CPF)';
export const ANONIMIZADO = '(anonimizado)';
export const MENOR_SEM_CPF = '(menor, sem CPF)';

/** Colunas lidas para montar a PessoaApi. `temCpf` no lugar do HMAC: o valor do HMAC não sai do banco. */
export const colunasPessoa = {
  id: pessoa.id, nome: pessoa.nome, categoria: pessoa.categoria, semCpf: pessoa.semCpf, menorIdade: pessoa.menorIdade,
  documentoMascarado: pessoa.documentoMascarado, telefone: pessoa.telefone, empresa: pessoa.empresa, servico: pessoa.servico,
  importacaoId: pessoa.importacaoId, anonimizadaEm: pessoa.anonimizadaEm, desativadaEm: pessoa.desativadaEm,
  desativacaoMotivo: pessoa.desativacaoMotivo, criadoEm: pessoa.criadoEm,
};

export type LinhaPessoa = {
  id: string; nome: string; categoria: (typeof pessoa.categoria.enumValues)[number]; semCpf: boolean; menorIdade: boolean;
  documentoMascarado: string | null; telefone: string | null; empresa: string | null; servico: string | null;
  importacaoId: string | null; anonimizadaEm: Date | null; desativadaEm: Date | null; desativacaoMotivo: string | null; criadoEm: Date;
};

export interface PessoaApi {
  id: string;
  nome: string;
  documentoTipo: 'cpf';
  categoria: LinhaPessoa['categoria'];
  semCpf: boolean;
  /** Dependente menor de idade (art. 14): CPF e telefone opcionais. */
  menorIdade: boolean;
  documentoMascarado: string;
  telefoneMascarado: string | null;
  empresa?: string;
  servico?: string;
  importacaoId?: string;
  anonimizadaEm: number | null;
  /** Cadastro desativado (RF-02). */
  desativadaEm: number | null;
  /** Só na ficha e nas respostas de escrita, para quem pode desativar (SI, AD): texto livre do operador. */
  desativacaoMotivo?: string;
  criadoEm: number;
}

/** Motivo da desativação só para quem pode desativar/reativar (SI, AD). */
export const veMotivoDesativacao = (papel: Papel) => pode(papel, 'pessoa.desativar');

/** Selo de restrição (lista e busca do Cadastro): a mesma permissão das rotas de restrição (unidade.ver). */
export const veRestricao = (papel: Papel) => pode(papel, 'unidade.ver');

/**
 * Resumo para o selo da lista e da busca, sem motivo (texto livre sensível). `ativa`: vigente (de unidade, ou de condomínio
 * aprovada); `pendente`: de condomínio aguardando o síndico. `unidadeCodigo` null: vale para todo o condomínio
 * (sempre null na pendente). `total`: quantas no mesmo estado.
 */
export interface RestricaoResumoApi { estado: 'ativa' | 'pendente'; unidadeCodigo: string | null; total: number }

export function paraPessoaApi(p: LinhaPessoa, o: { motivoDesativacao?: boolean } = {}): PessoaApi {
  const documento = p.anonimizadaEm ? ANONIMIZADO : p.semCpf ? SEM_CPF : (p.documentoMascarado ?? (p.menorIdade ? MENOR_SEM_CPF : SEM_CPF));
  return {
    id: p.id, nome: p.nome, documentoTipo: 'cpf', categoria: p.categoria, semCpf: p.semCpf, menorIdade: p.menorIdade, documentoMascarado: documento,
    telefoneMascarado: p.telefone ? mascararTelefone(p.telefone) : null,
    ...(p.empresa ? { empresa: p.empresa } : {}),
    ...(p.servico ? { servico: p.servico } : {}),
    ...(p.importacaoId ? { importacaoId: p.importacaoId } : {}),
    anonimizadaEm: p.anonimizadaEm ? p.anonimizadaEm.getTime() : null,
    desativadaEm: p.desativadaEm ? p.desativadaEm.getTime() : null,
    ...(o.motivoDesativacao && p.desativacaoMotivo ? { desativacaoMotivo: p.desativacaoMotivo } : {}),
    criadoEm: p.criadoEm.getTime(),
  };
}

/**
 * Cadastro completo (pré-requisito para aprovar ou regularizar vínculo, RN-02): mesma regra de `cadastroCompleto` do
 * domain (CPF, não "sem CPF", telefone com DDD e não anonimizada). `temCpf` = documento_busca preenchido.
 * Exceção (LGPD art. 14, minimização): dependente menor de idade num vínculo do tipo `dependente` dispensa CPF e
 * telefone. Num vínculo de proprietário ou inquilino, o menor precisa do cadastro completo como qualquer pessoa.
 */
export const cadastroCompletoDe = (
  p: { semCpf: boolean; anonimizadaEm: Date | null; telefone: string | null; temCpf: boolean; menorIdade?: boolean },
  tipoVinculo?: string,
) => !p.semCpf && !p.anonimizadaEm
  && ((p.temCpf && /^\d{10,11}$/.test(p.telefone ?? '')) || (!!p.menorIdade && tipoVinculo === 'dependente'));
