// Parâmetros de regra que a tela precisa CONHECER para montar formulário e texto (mínimo de justificativa, limites de
// anexo, prazos padrão), servidos como dado: o front não tem cópia das constantes. São as mesmas constantes que a API
// aplica ao validar (../dominio/rules): mudar aqui é mudar a regra, e a tela acompanha sem deploy próprio.
import { Controller, Get, Module } from '@nestjs/common';
import { Autenticado } from '../auth/decorators';
import {
  ANEXO_MAX_BYTES, ANEXO_MAX_POR_OCORRENCIA, ANEXO_TIPOS, MAX_DESCRICAO_COMPROVANTE, MAX_OBSERVACAO_CONFERENCIA, MEIOS_COM_MORADOR,
  MIN_JUSTIFICATIVA, PRAZO_PADRAO_MIN, type MimeAnexo,
} from '../dominio/rules';
import type { MeioAutorizacao, TipoVisita } from '../dominio/types';

export interface ParametrosRegra {
  /** Mínimo de caracteres (sem espaços nas pontas) de toda justificativa: exceção, correção, decisão, LGPD (RF-17, RN-04). */
  justificativaMin: number;
  /** Meios em que um morador identificado autoriza ou recusa (RN-01, UC02 A4): a tela pede o morador nesses. */
  meiosComMorador: MeioAutorizacao[];
  /** Prazo padrão de permanência por tipo de visita, em minutos (texto "prazo 4h" da escolha do tipo). */
  prazoPadraoMin: Record<TipoVisita, number>;
  /** Anexo de ocorrência (RF-27): a API confere o conteúdo de novo (assinatura do arquivo, não só o tipo declarado). */
  anexo: { maxBytes: number; maxPorOcorrencia: number; tipos: MimeAnexo[] };
  /** Conferência de comprovante do vínculo: tamanho máximo da descrição (tipo "outro") e da observação. */
  comprovante: { descricaoMax: number; observacaoMax: number };
}

export const PARAMETROS: ParametrosRegra = {
  justificativaMin: MIN_JUSTIFICATIVA,
  meiosComMorador: [...MEIOS_COM_MORADOR],
  prazoPadraoMin: { ...PRAZO_PADRAO_MIN },
  anexo: { maxBytes: ANEXO_MAX_BYTES, maxPorOcorrencia: ANEXO_MAX_POR_OCORRENCIA, tipos: Object.keys(ANEXO_TIPOS) as MimeAnexo[] },
  comprovante: { descricaoMax: MAX_DESCRICAO_COMPROVANTE, observacaoMax: MAX_OBSERVACAO_CONFERENCIA },
};

@Controller('parametros')
export class ParametrosController {
  /** Qualquer usuário logado (inclusive com troca de senha pendente: a tela de troca não usa, mas não há o que esconder). */
  @Get()
  @Autenticado({ permiteTrocaPendente: true })
  obter(): ParametrosRegra {
    return PARAMETROS;
  }
}

@Module({ controllers: [ParametrosController] })
export class ParametrosModule {}
