// Direitos do titular (LGPD art. 18; spec §9.3): exportação dos dados da pessoa e anonimização a pedido.
//
// Exportação (SI/AD): formato `portaria-parque/lgpd-exportacao`, versão 2 (a 2 acrescentou restrições, autorizações,
// encomendas e ocorrências que citam a pessoa; decisão 33 da spec §14). Decisões de minimização:
//  - CPF: só a máscara. O número não é guardado (spec §14 nº 18): não há o que devolver além dela.
//  - HMAC do CPF (`documento_busca`): fora. É um código de busca derivado, não um dado que o titular forneceu; no arquivo
//    só serviria para cruzar o titular com o banco por quem tivesse a chave.
//  - Telefone: mascarado (últimos 4 dígitos). O arquivo sai do sistema (é entregue impresso ou por e-mail)
//    e a conferência de identidade no balcão é fraca; o titular conhece o próprio número e o corrige pela administração.
//    A §9.3 pede "dados cadastrais", sem exigir o número completo; o arquivo diz que ele é mantido e como conferi-lo.
//  - Eventos: só os da própria pessoa (data, ponto, unidade ou área, meio e, na entrada, o veículo informado: placa,
//    modelo, cor). Eventos em que ela AUTORIZOU a entrada de outra pessoa são dados de terceiros e ficam fora.
//  - Documentos: metadados (tipo, tamanho, data, eliminação), nunca o conteúdo.
//  - Restrições e autorizações prévias: as que são SOBRE a pessoa e as que ela PEDIU, com destino, datas e situação. Sem
//    o texto livre (motivo, justificativa), que cita terceiros, e sem a identidade do outro lado (quem pediu, quem foi
//    autorizado). O texto pode ser consultado na administração.
//  - Encomendas: as que ela retirou, as autorizações de retirada em que aparece, e as que têm o NOME dela no
//    destinatário (busca acento-insensível do nome completo, `lgpd_padrao_nome`, ou nome igual).
//  - Ocorrências: as ligadas a eventos dela e as que citam o nome completo no texto; só código, tipo, situação e datas
//    (o texto cita terceiros).
// A exportação vai para o audit_log (`lgpd.exportar`) com o solicitante (o ator) e só contagens.
//
// Anonimização (SI): só sem vínculo válido (mesma regra de `vinculoValido` do domain), feita pela função
// `lgpd_anonimizar_titular` (migração 0007), numa transação só: dados pessoais, foto, redação do audit_log da pessoa,
// texto livre ligado a ela por id (substituído), o nome completo dela em texto livre sem FK (trocado por
// "[anonimizado]", salvo nome curto ou homônimo) e o registro em retencao_execucao. A foto é apagada do volume depois do
// COMMIT, e o pedido é registrado (só ids) no banco plataforma, para sobreviver a um restore (`reaplicar`).
// Os eventos ficam até completar 3 anos (art. 16, I, e art. 7º, VI); o texto livre e o veículo da entrada (placa, modelo,
// cor; 0013) entram no hash e não mudam: a anonimização não os toca, e eles saem junto com o evento na retenção.
import { Inject, Injectable } from '@nestjs/common';
import { codigoUnidade } from '../dominio/units';
import { ROTULO_CATEGORIA, ROTULO_MEIO } from '../dominio/types';
import { and, asc, eq, inArray, isNotNull, max, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type Ator, AuditoriaService } from '../auditoria/auditoria.service';
import { mascararTelefone } from '../auditoria/snapshot';
import type { Contexto } from '../auth/tipos';
import { diaBrt } from '../comum/datas';
import { codigoPg, erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db, type Tx } from '../database/database.module';
import {
  areaComum, autorizacaoPrevia, autorizacaoRetirada, documento, encomenda, eventoAcesso, ocorrencia, ocorrenciaAnexo, ocorrenciaEvento, pessoa,
  restricao, unidade, usuarioSistema, veiculo, vinculoUnidade,
} from '../db/schema';
import { CofreDocumentos } from '../documentos/cofre';
import { log } from '../comum/log';
import { CONDOMINIO, type CondominioResolvido } from '../saas/condominio';
import { RegistroAnonimizacoes } from '../saas/registro-anonimizacao';
import { codigoEncomenda } from '../encomendas/encomendas.module';
import { montarViews } from '../eventos/evento-view';
import { EventosService } from '../eventos/eventos.service';
import { codigoOcorrencia } from '../ocorrencias/ocorrencias.module';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';

/** Teto de eventos numa exportação de titular (o mesmo da exportação da trilha). */
const TETO_EVENTOS = 20_000;
const BRT_MS = 3 * 3600 * 1000;
const isoSP = (d: Date | null | undefined) => (d ? new Date(d.getTime() - BRT_MS).toISOString().replace('Z', '-03:00') : null);
const carimbo = (d: Date) => new Date(d.getTime() - BRT_MS).toISOString().slice(0, 10);
export const ANOS_RETENCAO = 3;
export const somarAnos = (d: Date, anos: number) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + anos); return x; };

/** O que `lgpd_anonimizar_titular` devolve (contagens, sem dado pessoal). */
export interface LimpezaTitular {
  registrosRedigidos: number;
  /** substituido: o nome completo foi procurado e trocado; nome_curto: não procurado (uma palavra, ou curto demais);
   *  homonimo: não trocado, porque outra pessoa ou operador tem nome igual ou que o contém. */
  textoLivre: 'substituido' | 'nome_curto' | 'homonimo';
  vinculos: number; restricoes: number; autorizacoes: number; encomendas: number; ocorrencias: number; importacao: number;
  trilhaTexto: number; eventosComTexto: number;
}

/**
 * O que fica depois da anonimização e por quê, na medida do que a função fez de fato (vai para a resposta e, dali, ao
 * titular). Não promete o que não foi feito: o caso "nome curto" e o "homônimo" pedem revisão manual.
 */
export function retidoDe(l: LimpezaTitular): string[] {
  const r = [
    'Eventos de acesso em que a pessoa aparece ficam até completar 3 anos de cada evento, por exercício regular de direitos (LGPD art. 16, I, e art. 7º, VI). Neles ela é referida por um identificador interno, e o nome exibido passa a ser “Pessoa anonimizada”. O veículo informado nas entradas (placa, modelo e cor) faz parte do selo de integridade do evento e também só sai junto com ele.',
    l.eventosComTexto > 0
      ? `${l.eventosComTexto} desses eventos têm o nome dela escrito no texto livre (justificativa, observação ou formulário de contingência). Esse texto faz parte do selo de integridade da trilha e só sai junto com o evento, ao fim dos 3 anos.`
      : 'O texto livre dos eventos (justificativa, observação, formulário de contingência) faz parte do selo de integridade da trilha e só sai junto com o evento, ao fim dos 3 anos. Nele, o nome completo dela não foi encontrado.',
    'Vínculos, restrições, autorizações e encomendas continuam existindo, ligados a ela só pelo identificador; o texto livre desses registros que era sobre ela (nota, justificativa, observação, motivo) foi substituído por “Removido na anonimização (LGPD)”.',
  ];
  if (l.textoLivre === 'substituido') {
    const n = l.encomendas + l.ocorrencias + l.importacao + l.trilhaTexto;
    r.push(`O nome completo foi trocado por “[anonimizado]” no texto livre de outros registros (encomendas, ocorrências, importação e trilha de alterações): ${n} registro(s). Menção por apelido, só o primeiro nome, abreviação ou com erro de digitação não é encontrada automaticamente e precisa de revisão da administração.`);
  } else if (l.textoLivre === 'nome_curto') {
    r.push('O nome tem uma palavra só (ou é curto demais) e por isso NÃO foi procurado no texto livre de outros registros (encomendas, ocorrências, importação, trilha): as menções precisam de revisão manual da administração.');
  } else {
    r.push('Outra pessoa ou operador tem nome igual (ou que contém este nome); para não apagar a menção a um terceiro, o nome NÃO foi trocado no texto livre de outros registros (encomendas, ocorrências, importação, trilha): as menções precisam de revisão manual da administração.');
  }
  r.push('O atendimento do pedido fica registrado, só com identificadores, fora do banco do condomínio, para ser reaplicado se um backup anterior for restaurado.');
  return r;
}

export interface ResultadoAnonimizacaoApi {
  pessoaId: string; registrosRedigidos: number; retido: string[]; eventosRetidos: number; retidoAte: string | null; documentosEliminados: number;
  limpeza: LimpezaTitular;
}

export interface ResultadoReaplicacao {
  /** Pedidos registrados na plataforma para este condomínio. */
  registradas: number;
  /** Pessoas que estavam com dados pessoais (restore) e foram anonimizadas de novo. */
  reaplicadas: string[];
  /** Registradas que não existem neste banco (backup anterior ao cadastro): nada a fazer. */
  inexistentes: number;
  /** Reaplicadas que, no banco restaurado, ainda têm vínculo válido: conferir e encerrar à mão. */
  comVinculoValido: string[];
}

const conferente = alias(usuarioSistema, 'conferente');

@Injectable()
export class LgpdService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(EventosService) private readonly eventos: EventosService,
    @Inject(CofreDocumentos) private readonly cofre: CofreDocumentos,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
    @Inject(RegistroAnonimizacoes) private readonly registro: RegistroAnonimizacoes,
  ) {}

  // ----- Acesso (art. 18, II) --------------------------------------------------------------------------------------

  async exportar(ctx: Contexto, id: string) {
    const [p] = await this.db.select().from(pessoa).where(eq(pessoa.id, id));
    if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
    const hoje = diaBrt(this.relogio.agora());

    const vinculos = await this.db.select({ v: vinculoUnidade, bloco: unidade.bloco, numero: unidade.numero, conferidoPor: conferente.nome })
      .from(vinculoUnidade).innerJoin(unidade, eq(unidade.id, vinculoUnidade.unidadeId))
      .leftJoin(conferente, eq(conferente.id, vinculoUnidade.conferidoPorId))
      .where(eq(vinculoUnidade.pessoaId, id)).orderBy(asc(vinculoUnidade.registradoEm), asc(vinculoUnidade.id));
    // Veículos: os das unidades em que a pessoa tem vínculo válido hoje (o veículo é da unidade, não da pessoa)
    const unidadesValidas = (await this.db.select({ u: vinculoUnidade.unidadeId }).from(vinculoUnidade)
      .where(and(eq(vinculoUnidade.pessoaId, id), vinculoValidoSql(hoje)))).map((x) => x.u);
    const veiculos = unidadesValidas.length
      ? await this.db.select({ placa: veiculo.placa, modelo: veiculo.modelo, cor: veiculo.cor, bloco: unidade.bloco, numero: unidade.numero })
        .from(veiculo).innerJoin(unidade, eq(unidade.id, veiculo.unidadeId))
        .where(and(inArray(veiculo.unidadeId, unidadesValidas), eq(veiculo.ativo, true))).orderBy(asc(veiculo.placa))
      : [];

    const linhas = await this.eventos.linhas({ pessoaId: id, excluirTipos: ['correcao'] }, TETO_EVENTOS);
    if (linhas.length > TETO_EVENTOS) {
      throw erroApi(422, 'EXPORTACAO_GRANDE', `A pessoa tem mais de ${TETO_EVENTOS.toLocaleString('pt-BR')} eventos; exporte a trilha por período.`);
    }
    const eventos = await montarViews(this.db, linhas); // valores efetivos (correções aplicadas)

    const encomendas = await this.db.select({ numero: encomenda.numero, recebidaEm: encomenda.recebidaEm, retiradaEm: encomenda.retiradaEm, bloco: unidade.bloco, numero2: unidade.numero })
      .from(encomenda).innerJoin(unidade, eq(unidade.id, encomenda.unidadeId))
      .where(eq(encomenda.retiradaPorPessoaId, id)).orderBy(asc(encomenda.retiradaEm));

    // Nome procurável em texto livre (o mesmo padrão da anonimização). Pessoa anonimizada: o nome é genérico, não se procura.
    const padrao = p.anonimizadaEm ? null
      : ((await this.db.execute(sql`SELECT lgpd_padrao_nome(${p.nome}) AS p`)) as unknown as { rows: { p: string | null }[] }).rows[0]?.p ?? null;
    const citaNome = (col: typeof encomenda.destinatario | typeof ocorrencia.descricao | typeof ocorrencia.envolvidos) => (p.anonimizadaEm
      ? sql`false`
      : padrao
        ? sql`(${col} ~* ${padrao} OR lgpd_nome_normalizado(${col}) = lgpd_nome_normalizado(${p.nome}))`
        : sql`lgpd_nome_normalizado(${col}) = lgpd_nome_normalizado(${p.nome})`);

    const encomendasCitadas = await this.db.select({ numero: encomenda.numero, destinatario: encomenda.destinatario, recebidaEm: encomenda.recebidaEm, retiradaEm: encomenda.retiradaEm, bloco: unidade.bloco, numero2: unidade.numero })
      .from(encomenda).innerJoin(unidade, eq(unidade.id, encomenda.unidadeId))
      .where(citaNome(encomenda.destinatario)).orderBy(asc(encomenda.recebidaEm));
    const autRetirada = await this.db.select({ numero: encomenda.numero, autorizada: autorizacaoRetirada.pessoaAutorizadaId, registradaEm: autorizacaoRetirada.registradaEm })
      .from(autorizacaoRetirada).innerJoin(encomenda, eq(encomenda.id, autorizacaoRetirada.encomendaId))
      .where(or(eq(autorizacaoRetirada.pessoaAutorizadaId, id), eq(autorizacaoRetirada.solicitantePessoaId, id))).orderBy(asc(autorizacaoRetirada.registradaEm));

    const restricoes = await this.db.select({ r: restricao, bloco: unidade.bloco, numero: unidade.numero }).from(restricao)
      .leftJoin(unidade, eq(unidade.id, restricao.unidadeId))
      .where(or(eq(restricao.pessoaId, id), eq(restricao.solicitadaPorPessoaId, id))).orderBy(asc(restricao.cadastradaEm));
    const autorizacoes = await this.db.select({ a: autorizacaoPrevia, bloco: unidade.bloco, numero: unidade.numero, area: areaComum.nome }).from(autorizacaoPrevia)
      .leftJoin(unidade, eq(unidade.id, autorizacaoPrevia.unidadeId)).leftJoin(areaComum, eq(areaComum.id, autorizacaoPrevia.areaComumId))
      .where(or(eq(autorizacaoPrevia.pessoaId, id), eq(autorizacaoPrevia.solicitadaPorPessoaId, id))).orderBy(asc(autorizacaoPrevia.cadastradaEm));

    // Ocorrências: ligadas a eventos dela ou com o nome no texto. Só metadados (o texto cita terceiros).
    const idsOcorrencias = new Map<string, Set<'evento' | 'texto'>>();
    const marcar = (oid: string, como: 'evento' | 'texto') => { const x = idsOcorrencias.get(oid) ?? new Set(); x.add(como); idsOcorrencias.set(oid, x); };
    for (let i = 0; i < linhas.length; i += 1000) {
      const ls = await this.db.selectDistinct({ o: ocorrenciaEvento.ocorrenciaId }).from(ocorrenciaEvento)
        .where(inArray(ocorrenciaEvento.eventoId, linhas.slice(i, i + 1000).map((l) => l.id)));
      for (const l of ls) marcar(l.o, 'evento');
    }
    for (const l of await this.db.select({ o: ocorrencia.id }).from(ocorrencia).where(or(citaNome(ocorrencia.descricao), citaNome(ocorrencia.envolvidos)))) marcar(l.o, 'texto');
    const ocorrencias = idsOcorrencias.size
      ? await this.db.select({ o: ocorrencia, bloco: unidade.bloco, numero: unidade.numero }).from(ocorrencia)
        .leftJoin(unidade, eq(unidade.id, ocorrencia.unidadeId)).where(inArray(ocorrencia.id, [...idsOcorrencias.keys()])).orderBy(asc(ocorrencia.abertaEm))
      : [];

    // Documentos: a foto (se houver) e os anexos das ocorrências ligadas a eventos da pessoa. Só metadados.
    const docs: { id: string; tipo: string; origem: string; mime: string; tamanhoBytes: number; enviadoEm: string | null; eliminadoEm: string | null }[] = [];
    if (p.fotoDocumentoId) {
      const [f] = await this.db.select().from(documento).where(eq(documento.id, p.fotoDocumentoId));
      if (f) docs.push({ id: f.id, tipo: 'foto', origem: 'cadastro', mime: f.mime, tamanhoBytes: f.tamanhoBytes, enviadoEm: isoSP(f.enviadoEm), eliminadoEm: isoSP(f.eliminadoEm) });
    }
    const idsEventos = linhas.map((l) => l.id);
    if (idsEventos.length) {
      for (let i = 0; i < idsEventos.length; i += 1000) {
        const anexos = await this.db.selectDistinct({ d: documento, numero: ocorrencia.numero, abertaEm: ocorrencia.abertaEm }).from(ocorrenciaEvento)
          .innerJoin(ocorrencia, eq(ocorrencia.id, ocorrenciaEvento.ocorrenciaId))
          .innerJoin(ocorrenciaAnexo, eq(ocorrenciaAnexo.ocorrenciaId, ocorrencia.id))
          .innerJoin(documento, eq(documento.id, ocorrenciaAnexo.documentoId))
          .where(inArray(ocorrenciaEvento.eventoId, idsEventos.slice(i, i + 1000)));
        for (const a of anexos) {
          if (docs.some((d) => d.id === a.d.id)) continue;
          docs.push({
            id: a.d.id, tipo: 'anexo_ocorrencia', origem: `ocorrência ${codigoOcorrencia(a.numero, a.abertaEm)}`, mime: a.d.mime,
            tamanhoBytes: a.d.tamanhoBytes, enviadoEm: isoSP(a.d.enviadoEm), eliminadoEm: isoSP(a.d.eliminadoEm),
          });
        }
      }
    }

    const agora = this.relogio.agora();
    const unidadeOuNulo = (bloco: string | null, numero: string | null) => (bloco && numero ? codigoUnidade({ bloco, numero }) : null);
    const situacao = (x: { revogadaEm: Date | null; validaAte: Date }) => (x.revogadaEm ? 'revogada' : x.validaAte.getTime() < agora.getTime() ? 'vencida' : 'vigente');
    const conteudo = {
      tipo: 'portaria-parque/lgpd-exportacao', versao: 2, geradoEm: isoSP(agora), geradoPor: ctx.ator.nome,
      titular: {
        id: p.id, nome: p.nome, categoria: ROTULO_CATEGORIA[p.categoria],
        cpf: p.anonimizadaEm ? '(anonimizado)' : p.semCpf ? '(sem CPF)' : p.documentoMascarado, semCpf: p.semCpf,
        telefone: p.telefone ? mascararTelefone(p.telefone) : null, empresa: p.empresa, servico: p.servico, menorIdade: p.menorIdade,
        cadastradoEm: isoSP(p.criadoEm), anonimizadaEm: isoSP(p.anonimizadaEm),
      },
      vinculos: vinculos.map(({ v, bloco, numero, conferidoPor }) => ({
        unidade: codigoUnidade({ bloco, numero }), tipo: v.tipo, status: v.status, vigenciaInicio: v.vigenciaInicio, vigenciaFim: v.vigenciaFim,
        prazoRegularizacao: v.prazoRegularizacao, decididoEm: isoSP(v.decididoEm), encerradoEm: isoSP(v.encerradoEm),
        comprovanteConferido: v.conferenciaTipoDocumento
          ? { tipo: v.conferenciaTipoDocumento, descricao: v.conferenciaDescricao, data: v.conferenciaData, conferidoPor: conferidoPor ?? null }
          : null,
      })),
      veiculos: veiculos.map((x) => ({ unidade: codigoUnidade({ bloco: x.bloco, numero: x.numero }), placa: `${x.placa.slice(0, 3)}-${x.placa.slice(3)}`, modelo: x.modelo, cor: x.cor })),
      eventos: eventos.map((e) => ({
        codigo: e.codigo, tipo: e.tipo, ocorridoEm: isoSP(new Date(e.ocorridoEm)), pontoAcesso: e.pontoAcessoNome,
        unidade: e.unidadeDestinoId ? e.unidadeRotulo : null, areaComum: e.areaComumNome,
        meio: e.autorizadoPorTipo ? ROTULO_MEIO[e.autorizadoPorTipo] : null, retroativo: e.retroativo,
        veiculo: e.veiculoPlaca ? { placa: `${e.veiculoPlaca.slice(0, 3)}-${e.veiculoPlaca.slice(3)}`, modelo: e.veiculoModelo, cor: e.veiculoCor } : null,
      })),
      encomendasRetiradas: encomendas.map((x) => ({
        codigo: codigoEncomenda(x.numero), unidade: codigoUnidade({ bloco: x.bloco, numero: x.numero2 }), recebidaEm: isoSP(x.recebidaEm), retiradaEm: isoSP(x.retiradaEm),
      })),
      encomendasComONome: encomendasCitadas.map((x) => ({
        codigo: codigoEncomenda(x.numero), unidade: codigoUnidade({ bloco: x.bloco, numero: x.numero2 }), destinatario: x.destinatario,
        recebidaEm: isoSP(x.recebidaEm), retiradaEm: isoSP(x.retiradaEm),
      })),
      autorizacoesDeRetirada: autRetirada.map((x) => ({
        encomenda: codigoEncomenda(x.numero), papel: x.autorizada === id ? 'autorizada a retirar' : 'autorizou outra pessoa', registradaEm: isoSP(x.registradaEm),
      })),
      restricoes: restricoes.map(({ r: x, bloco, numero }) => ({
        papel: x.pessoaId === id ? 'restrição sobre a pessoa' : 'restrição pedida pela pessoa',
        escopo: x.escopo, unidade: unidadeOuNulo(bloco, numero), cadastradaEm: isoSP(x.cadastradaEm), validaAte: isoSP(x.validaAte),
        aprovadaEm: isoSP(x.aprovadaEm), revogadaEm: isoSP(x.revogadaEm), situacao: situacao(x),
      })),
      autorizacoesPrevias: autorizacoes.map(({ a: x, bloco, numero, area }) => ({
        papel: x.pessoaId === id ? 'pessoa autorizada' : 'autorização pedida pela pessoa',
        destino: unidadeOuNulo(bloco, numero) ?? area, validaDe: isoSP(x.validaDe), validaAte: isoSP(x.validaAte),
        diasSemana: x.diasSemana, horaInicio: x.horaInicio, horaFim: x.horaFim, semSolicitante: x.semSolicitante,
        cadastradaEm: isoSP(x.cadastradaEm), revogadaEm: isoSP(x.revogadaEm), situacao: situacao(x),
      })),
      ocorrencias: ocorrencias.map(({ o, bloco, numero }) => ({
        codigo: codigoOcorrencia(o.numero, o.abertaEm), tipo: o.tipo, status: o.status, abertaEm: isoSP(o.abertaEm),
        unidade: unidadeOuNulo(bloco, numero), relacao: [...(idsOcorrencias.get(o.id) ?? [])].sort(),
      })),
      documentos: docs,
      observacoes: [
        'O número do CPF não é armazenado (só a máscara e um código de busca irreversível, que não consta deste arquivo).',
        'Telefone exibido mascarado; o número completo é mantido e pode ser conferido ou corrigido presencialmente na administração.',
        'Arquivos (foto, anexos) aparecem só com os metadados; o conteúdo pode ser consultado na administração.',
        'Restrições, autorizações e ocorrências aparecem sem o texto livre (motivo, justificativa, descrição) e sem a identidade de outras pessoas, porque citam terceiros; o texto pode ser consultado na administração.',
        'Encomendas e ocorrências “com o nome” foram encontradas pelo nome completo escrito no texto; menção por apelido ou abreviação não aparece aqui.',
        'Eventos de acesso, trilha de alterações e registros de conferência são mantidos por 3 anos (exercício regular de direitos).',
      ],
    };
    await this.auditoria.registrar(this.db, {
      ator: ctx.ator, ip: ctx.ip, acao: 'lgpd.exportar', entidade: 'pessoa', registroId: p.id,
      depois: {
        vinculos: vinculos.length, veiculos: veiculos.length, eventos: eventos.length, encomendas: encomendas.length, documentos: docs.length,
        encomendasComONome: encomendasCitadas.length, autorizacoesDeRetirada: autRetirada.length, restricoes: restricoes.length,
        autorizacoesPrevias: autorizacoes.length, ocorrencias: ocorrencias.length,
      },
    });
    return { nomeArquivo: `lgpd-${p.id.slice(0, 8)}-${carimbo(agora)}.json`, conteudo: `${JSON.stringify(conteudo, null, 2)}\n`, quantidade: eventos.length };
  }

  // ----- Eliminação (art. 18, VI) ----------------------------------------------------------------------------------

  /** A pedido (SI). 404, 409 (já anonimizada) ou 422 (vínculo válido); o resto do trabalho é de `anonimizarNaTx`. */
  async anonimizar(ctx: Contexto, id: string): Promise<ResultadoAnonimizacaoApi> {
    const hoje = diaBrt(this.relogio.agora());
    const r = await this.db.transaction(async (tx) => {
      const [p] = await tx.select({ id: pessoa.id, anonimizadaEm: pessoa.anonimizadaEm }).from(pessoa).where(eq(pessoa.id, id)).for('update');
      if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
      if (p.anonimizadaEm) throw erroApi(409, 'PESSOA_JA_ANONIMIZADA', 'Esta pessoa já foi anonimizada.');
      const [valido] = await tx.select({ id: vinculoUnidade.id }).from(vinculoUnidade)
        .where(and(eq(vinculoUnidade.pessoaId, id), vinculoValidoSql(hoje))).limit(1);
      if (valido) throw erroApi(422, 'PESSOA_COM_VINCULO_VALIDO', 'A pessoa tem vínculo válido com uma unidade: encerre o vínculo antes de anonimizar.');
      return this.anonimizarNaTx(tx, { ator: ctx.ator, ip: ctx.ip }, id, 'pedido');
    });
    const eliminados = await this.apagarArquivos(r.arquivos);
    await this.registrarFora([{ pessoaId: id, motivo: 'pedido', anonimizadaEm: this.relogio.agora() }]);
    const retidos = await this.eventosRetidos(id);
    return { pessoaId: id, registrosRedigidos: r.registrosRedigidos, retido: retidoDe(r.limpeza), ...retidos, documentosEliminados: eliminados, limpeza: r.limpeza };
  }

  /**
   * Registro na plataforma DEPOIS do commit (sem transação distribuída). Falha não desfaz nem esconde a anonimização,
   * que já vale: vai ao log, e a retenção diária copia de `retencao_execucao` o que faltar (`sincronizarRegistro`).
   */
  async registrarFora(itens: { pessoaId: string; motivo: 'pedido' | 'retencao'; anonimizadaEm: Date }[]): Promise<boolean> {
    if (!itens.length) return true;
    if (!this.condominio) { log('error', 'lgpd.registro_sem_condominio'); return false; }
    try {
      await this.registro.registrar(this.condominio.id, itens);
      return true;
    } catch (e) {
      log('error', 'lgpd.registro_plataforma_falhou', { condominio_id: this.condominio.id, erro: e instanceof Error ? e.name : 'erro' });
      return false;
    }
  }

  /** Copia para a plataforma toda anonimização que o banco do condomínio registrou (idempotente). Devolve as novas. */
  async sincronizarRegistro(): Promise<number> {
    if (!this.condominio) throw new Error('sincronizarRegistro sem condomínio');
    const linhas = ((await this.db.execute(sql`
      SELECT DISTINCT ON (detalhes ->> 'pessoa_id') (detalhes ->> 'pessoa_id') AS pessoa_id, detalhes ->> 'motivo' AS motivo, executada_em
        FROM retencao_execucao WHERE tipo = 'pessoas' AND detalhes ? 'pessoa_id'
       ORDER BY detalhes ->> 'pessoa_id', executada_em`)) as unknown as { rows: { pessoa_id: string; motivo: string; executada_em: Date | string }[] }).rows;
    return this.registro.registrar(this.condominio.id, linhas
      .filter((l) => l.motivo === 'pedido' || l.motivo === 'retencao')
      .map((l) => ({ pessoaId: l.pessoa_id, motivo: l.motivo as 'pedido' | 'retencao', anonimizadaEm: new Date(l.executada_em) })));
  }

  /**
   * Depois de um restore (docs/deploy.md, seção 9): anonimiza de novo quem a plataforma registra como anonimizado e,
   * no banco restaurado, voltou a ter dados pessoais. Ignora a regra do vínculo válido (o pedido já foi atendido), mas
   * devolve quem ainda tem vínculo válido no banco restaurado, para a administração conferir. Idempotente.
   */
  async reaplicar(quem: { ator: Ator | null; ip?: string | null; nomeInformado?: string }): Promise<ResultadoReaplicacao> {
    if (!this.condominio) throw new Error('reaplicar sem condomínio');
    const registradas = await this.registro.doCondominio(this.condominio.id);
    const r: ResultadoReaplicacao = { registradas: registradas.length, reaplicadas: [], inexistentes: 0, comVinculoValido: [] };
    if (!registradas.length) return r;
    const hoje = diaBrt(this.relogio.agora());
    const estado = new Map<string, Date | null>();
    for (let i = 0; i < registradas.length; i += 1000) {
      const ls = await this.db.select({ id: pessoa.id, anonimizadaEm: pessoa.anonimizadaEm }).from(pessoa)
        .where(inArray(pessoa.id, registradas.slice(i, i + 1000).map((x) => x.pessoaId)));
      for (const l of ls) estado.set(l.id, l.anonimizadaEm);
    }
    for (const x of registradas) {
      if (!estado.has(x.pessoaId)) { r.inexistentes++; continue; }
      if (estado.get(x.pessoaId)) continue;
      const feito = await this.db.transaction(async (tx) => {
        const [p] = await tx.select({ anonimizadaEm: pessoa.anonimizadaEm }).from(pessoa).where(eq(pessoa.id, x.pessoaId)).for('update');
        if (!p || p.anonimizadaEm) return null;
        const [valido] = await tx.select({ id: vinculoUnidade.id }).from(vinculoUnidade)
          .where(and(eq(vinculoUnidade.pessoaId, x.pessoaId), vinculoValidoSql(hoje))).limit(1);
        const a = await this.anonimizarNaTx(tx, quem, x.pessoaId, x.motivo, { reaplicacao: true });
        return { ...a, comVinculo: !!valido };
      });
      if (!feito) continue;
      await this.apagarArquivos(feito.arquivos);
      r.reaplicadas.push(x.pessoaId);
      if (feito.comVinculo) r.comVinculoValido.push(x.pessoaId);
    }
    if (r.reaplicadas.length) {
      await this.auditoria.registrar(this.db, { ...quem, acao: 'lgpd.reaplicar', entidade: 'pessoa', depois: r });
      log('warn', 'lgpd.anonimizacoes_reaplicadas', { condominio_id: this.condominio.id, detalhe: `reaplicadas=${r.reaplicadas.length} com_vinculo_valido=${r.comVinculoValido.length}` });
    }
    return r;
  }

  /**
   * Anonimiza dentro da transação do chamador, com a pessoa já travada e a regra já conferida. Devolve os arquivos a
   * apagar DEPOIS do commit (apagar antes perderia o arquivo num rollback).
   */
  async anonimizarNaTx(
    tx: Tx, quem: { ator: Ator | null; ip?: string | null; nomeInformado?: string }, id: string, motivo: 'pedido' | 'retencao',
    o: { reaplicacao?: boolean } = {},
  ) {
    const [foto] = await tx.select({ caminho: documento.caminhoStorage }).from(pessoa)
      .innerJoin(documento, eq(documento.id, pessoa.fotoDocumentoId)).where(and(eq(pessoa.id, id), isNotNull(pessoa.fotoDocumentoId)));
    let limpeza: LimpezaTitular;
    try {
      const res = (await tx.execute(sql`SELECT lgpd_anonimizar_titular(${id}::uuid, ${motivo}) AS r`)) as unknown as { rows: { r: LimpezaTitular | string }[] };
      const bruto = res.rows[0]?.r;
      limpeza = typeof bruto === 'string' ? JSON.parse(bruto) as LimpezaTitular : bruto!;
    } catch (e) {
      // Corrida com outra anonimização (a função reconfere com a linha travada): mensagem legível, sem o texto do driver.
      if (codigoPg(e) === '23514') throw erroApi(409, 'PESSOA_JA_ANONIMIZADA', 'Esta pessoa já foi anonimizada.');
      throw e;
    }
    // Registrado DEPOIS da redação: este registro não tem dado pessoal (motivo, contagens e os campos removidos).
    await this.auditoria.registrar(tx, {
      ator: quem.ator, ip: quem.ip, nomeInformado: quem.nomeInformado, acao: 'lgpd.anonimizar', entidade: 'pessoa', registroId: id,
      depois: {
        motivo, ...(o.reaplicacao ? { reaplicacao: true } : {}), ...limpeza,
        campos: ['nome', 'documento_mascarado', 'documento_busca', 'telefone', 'empresa', 'servico', 'foto_documento_id'], fotoEliminada: !!foto,
      },
    });
    return { registrosRedigidos: limpeza.registrosRedigidos, limpeza, arquivos: foto ? [foto.caminho] : [] };
  }

  /** Apaga do volume os arquivos de documentos já marcados como eliminados. Falha = fica para a varredura de órfãos. */
  async apagarArquivos(caminhos: string[]): Promise<number> {
    let n = 0;
    for (const c of caminhos) if (await this.cofre.eliminar(c)) n++;
    return n;
  }

  /** Eventos em que a pessoa aparece (como pessoa ou autorizadora) e o dia em que o último completa 3 anos. */
  private async eventosRetidos(id: string): Promise<{ eventosRetidos: number; retidoAte: string | null }> {
    const [r] = await this.db.select({ n: sql<number>`count(*)`.mapWith(Number), ultimo: max(eventoAcesso.registradoEm) }).from(eventoAcesso)
      .where(or(eq(eventoAcesso.pessoaId, id), eq(eventoAcesso.autorizadoPorPessoaId, id)));
    const ultimo = r?.ultimo ? new Date(r.ultimo) : null;
    return { eventosRetidos: r?.n ?? 0, retidoAte: ultimo ? diaBrt(somarAnos(ultimo, ANOS_RETENCAO)) : null };
  }
}
