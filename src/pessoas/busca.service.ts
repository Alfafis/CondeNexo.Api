// Busca de pessoas (RF-18, RF-34) e busca global do topo. Regras:
//   nome     sem acento e sem caixa, por substring (ILIKE; a spec §3.5 deixa pg_trgm para quando a medição pedir);
//   CPF      11 dígitos: igualdade pelo HMAC (documento_busca, chave PORTARIA_HMAC_CPF_KEY), nos dois formatos de máscara;
//            3 a 10 dígitos: só os dígitos VISÍVEIS do mascarado (o mesmo que a tela já mostra; o resto não existe no banco):
//            - formato novo "123.45*.***-**" (cadastro desde 2026-10-24): pelo COMEÇO. Até 5 dígitos, prefixo; com mais,
//              os 5 primeiros do termo precisam ser os visíveis (os seguintes não dá para conferir);
//            - formato antigo "***.456.789-**" (quem já estava cadastrado): parcial em qualquer ponto dos 6 do meio;
//   unidade  "A-32", "a 32" (e o antigo "T4-32"): pessoas com vínculo pendente, aprovado ou legado nela;
//   placa    4+ caracteres: pessoas com vínculo VÁLIDO na unidade do veículo ativo e quem está DENTRO agora tendo
//            entrado com veículo dessa placa (entrada sem saída; pessoa efetiva). Visitante que já saiu não é achado pela
//            placa: a busca não vira histórico de placas (a trilha tem o filtro próprio);
//   ordem    nome exato, começa com, contém, outros critérios; depois alfabética.
// Anonimizada nunca aparece; desativada (RF-02) só com `incluirDesativadas` (tela Cadastro), nunca na busca do topo. O CPF digitado só existe nesta requisição: vem no CORPO de um POST (não na URL, que
// proxies registram), não é logado (log em allowlist) e leitura não grava trilha.
import { Inject, Injectable } from '@nestjs/common';
import { DIGITOS_VISIVEIS_CPF } from '../dominio/cpf';
import { fmtData, fmtHora } from '../dominio/time';
import { codigoUnidade, leiturasDoCodigo } from '../dominio/units';
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { chavesDe, CONDOMINIO, type CondominioResolvido } from '../tenancy/condominio';
import { diaBrt } from '../comum/datas';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db } from '../database/database.module';
import { documentoBusca } from '../db/cpf';
import { areaComum, eventoAcesso, pessoa, restricao, unidade, veiculo, vinculoUnidade } from '../db/schema';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';
import { ORDEM_UNIDADES } from '../unidades/ordem';
import { efetivoSql, semSaidaSql } from '../eventos/efetivo';
import type { RestricaoResumoApi } from './pessoa-view';

/** Pessoa como a busca devolve: sem telefone e sem documento_busca (minimização; a ficha completa é outra rota). */
export interface PessoaBusca {
  id: string;
  nome: string;
  documentoTipo: 'cpf';
  /** "123.45*.***-**", "***.456.789-**" (formato antigo) ou "(sem CPF)". */
  documentoMascarado: string;
  semCpf: boolean;
  categoria: (typeof pessoa.categoria.enumValues)[number];
  empresa?: string;
  servico?: string;
  importacaoId?: string;
  /** Cadastro desativado (só aparece com `incluirDesativadas`). */
  desativadaEm: number | null;
  ultimoAcesso: string;
  unidadesVinculadas: string[];
  unidadesVinculadasCodigos: string[];
  /** Selo do Cadastro (mesma regra da lista): só para quem vê restrições (`veRestricao`); para os demais não vem. */
  restricao?: RestricaoResumoApi | null;
}

export interface ResultadoBusca { pessoas: PessoaBusca[]; temMais: boolean }

// Acentos do português (e vizinhos) nas duas caixas. `lower` sozinho não basta: com collation C (PGlite) ele só
// converte ASCII. O alvo é derivado por NFD, o mesmo que o `norm` do front faz no navegador.
const COM_ACENTO = 'áàâãäåéèêëíìîïóòôõöúùûüçñýÿÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ';
const SEM_ACENTO = [...COM_ACENTO].map((c) => c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()).join('');

/** Normalização do lado do JavaScript (igual à do SQL acima): sem acento, minúscula, sem espaço nas pontas. */
export const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Escapa os curingas do LIKE (o escape padrão do Postgres é a barra invertida). */
const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const SEM_CPF = '(sem CPF)';

/** Nome sem acento e minúsculo no SQL (mesma normalização de `normalizar`). */
export const nomeSemAcentoSql = (col: SQL | typeof pessoa.nome = pessoa.nome): SQL => sql`translate(lower(${col}), ${COM_ACENTO}, ${SEM_ACENTO})`;

@Injectable()
export class BuscaService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
  ) {}

  /** Nome normalizado no SQL. Calculado por linha (sem índice): com milhares de pessoas a varredura custa milissegundos. */
  private nomeNormalizado(): SQL {
    return nomeSemAcentoSql();
  }

  async pessoas(q: string, o: { limite: number; semMoradores?: boolean; incluirDesativadas?: boolean; restricao?: boolean }): Promise<ResultadoBusca> {
    const consulta = q.trim();
    const nq = normalizar(consulta);
    if (!nq) return { pessoas: [], temMais: false };
    const agora = this.relogio.agora();
    const hoje = diaBrt(agora);
    const valido = vinculoValidoSql(hoje);
    const digitos = consulta.replace(/\D/g, '');
    const placa = consulta.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const nome = this.nomeNormalizado();
    const padrao = `%${escaparLike(nq)}%`;

    const criterios: SQL[] = [sql`${nome} LIKE ${padrao}`];
    if (digitos.length === 11) {
      criterios.push(eq(pessoa.documentoBusca, documentoBusca(digitos, chavesDe(this.condominio).hmacCpf)));
    } else if (digitos.length >= 3) {
      const visiveis = sql`regexp_replace(coalesce(${pessoa.documentoMascarado}, ''), '[^0-9]', '', 'g')`;
      criterios.push(sql`(CASE WHEN ${pessoa.documentoMascarado} LIKE '***.%' THEN ${visiveis} LIKE ${`%${digitos}%`}
        ELSE ${visiveis} LIKE ${`${digitos.slice(0, DIGITOS_VISIVEIS_CPF.inicio)}%`} END)`);
    }
    // "A-32"; o antigo "T4-32" também casa com o bloco "4" (todas as leituras do código).
    const cods = leiturasDoCodigo(consulta);
    if (cods.length) {
      const pares = or(...cods.map((c) => and(eq(unidade.bloco, c.bloco), eq(unidade.numero, c.numero))));
      criterios.push(sql`${pessoa.id} IN (SELECT ${vinculoUnidade.pessoaId} FROM ${vinculoUnidade}
        JOIN ${unidade} ON ${unidade.id} = ${vinculoUnidade.unidadeId}
        WHERE ${pares} AND ${vinculoUnidade.status} IN ('pendente', 'aprovado', 'legado'))`);
    }
    if (placa.length >= 4) {
      criterios.push(sql`${pessoa.id} IN (SELECT ${vinculoUnidade.pessoaId} FROM ${vinculoUnidade}
        JOIN ${veiculo} ON ${veiculo.unidadeId} = ${vinculoUnidade.unidadeId}
        WHERE ${veiculo.ativo} AND ${veiculo.placa} LIKE ${`%${escaparLike(placa)}%`} AND ${valido})`);
      // Presentes que entraram com essa placa. A subconsulta é só sobre evento_acesso: as referências da linha
      // ("evento_acesso"."id" em semSaidaSql/efetivoSql) são dela, não da pessoa externa.
      criterios.push(sql`${pessoa.id} IN (SELECT ${efetivoSql('pessoa_id')} FROM ${eventoAcesso}
        WHERE ${eventoAcesso.tipo} = 'entrada' AND ${eventoAcesso.veiculoPlaca} LIKE ${`%${escaparLike(placa)}%`} AND ${semSaidaSql()})`);
    }
    const filtros: SQL[] = [isNull(pessoa.anonimizadaEm), or(...criterios)!];
    if (!o.incluirDesativadas) filtros.push(isNull(pessoa.desativadaEm));
    // Portaria: quem tem vínculo válido em alguma unidade é morador, qualquer que seja a categoria gravada.
    if (o.semMoradores) {
      // Referência explícita à linha externa (o Drizzle pode escrever a coluna sem o nome da tabela numa consulta simples).
      filtros.push(sql`NOT EXISTS (SELECT 1 FROM ${vinculoUnidade} WHERE ${vinculoUnidade.pessoaId} = ${sql.raw('"pessoa"."id"')} AND ${valido})`);
    }
    const rank = sql`CASE WHEN ${nome} = ${nq} THEN 0 WHEN ${nome} LIKE ${`${escaparLike(nq)}%`} THEN 1
      WHEN ${nome} LIKE ${padrao} THEN 2 ELSE 3 END`;
    const linhas = await this.db.select({
      id: pessoa.id, nome: pessoa.nome, categoria: pessoa.categoria, semCpf: pessoa.semCpf,
      documentoMascarado: pessoa.documentoMascarado, empresa: pessoa.empresa, servico: pessoa.servico, importacaoId: pessoa.importacaoId,
      desativadaEm: pessoa.desativadaEm,
    }).from(pessoa)
      .where(and(...filtros))
      .orderBy(asc(rank), asc(nome), asc(pessoa.nome), asc(pessoa.id))
      .limit(o.limite + 1);

    const pagina = linhas.slice(0, o.limite);
    const ids = pagina.map((p) => p.id);
    const [vinculos, ultimos, restricoes] = await Promise.all([
      this.unidadesValidas(ids, hoje), this.ultimosAcessos(ids), o.restricao ? this.resumosRestricao(ids, agora) : null,
    ]);
    return {
      temMais: linhas.length > o.limite,
      pessoas: pagina.map((p): PessoaBusca => {
        const us = vinculos.get(p.id) ?? [];
        return {
          id: p.id, nome: p.nome, documentoTipo: 'cpf', categoria: p.categoria, semCpf: p.semCpf,
          documentoMascarado: p.semCpf ? SEM_CPF : (p.documentoMascarado ?? SEM_CPF),
          ...(p.empresa ? { empresa: p.empresa } : {}), ...(p.servico ? { servico: p.servico } : {}),
          ...(p.importacaoId ? { importacaoId: p.importacaoId } : {}),
          desativadaEm: p.desativadaEm ? p.desativadaEm.getTime() : null,
          ultimoAcesso: this.textoUltimoAcesso(ultimos.get(p.id), agora),
          unidadesVinculadas: us.map((u) => u.id), unidadesVinculadasCodigos: us.map((u) => codigoUnidade(u)),
          ...(restricoes ? { restricao: restricoes.get(p.id) ?? null } : {}),
        };
      }),
    };
  }

  /** Busca do topo: até 6 pessoas (2+ caracteres) e as unidades pelo código ou pela placa. Sem selo de restrição. */
  async global(q: string) {
    const consulta = q.trim();
    const { pessoas, temMais } = consulta.length >= 2 ? await this.pessoas(consulta, { limite: 6 }) : { pessoas: [], temMais: false };
    const unidades: { id: string; motivo: string }[] = [];
    for (const cod of leiturasDoCodigo(consulta)) { // a primeira leitura que existir ("T4-32": bloco "T4", senão "4")
      const [u] = await this.db.select({ id: unidade.id, ativo: unidade.ativo }).from(unidade)
        .where(and(eq(unidade.bloco, cod.bloco), eq(unidade.numero, cod.numero)));
      if (u) { unidades.push({ id: u.id, motivo: u.ativo ? 'Unidade' : 'Unidade (desativada)' }); break; }
    }
    const placa = consulta.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (placa.length >= 3) {
      const vs = await this.db.select({ unidadeId: veiculo.unidadeId, placa: veiculo.placa, modelo: veiculo.modelo }).from(veiculo)
        .where(and(eq(veiculo.ativo, true), sql`${veiculo.placa} LIKE ${`%${escaparLike(placa)}%`}`))
        .orderBy(asc(veiculo.placa)).limit(6);
      for (const v of vs) unidades.push({ id: v.unidadeId, motivo: `Placa ${v.placa.slice(0, 3)}-${v.placa.slice(3)} · ${v.modelo}` });
    }
    return { pessoas, unidades, temMaisPessoas: temMais };
  }

  /** Unidades com vínculo válido de cada pessoa (uma consulta para a página toda, sem N+1). */
  async unidadesValidas(ids: string[], hoje: string) {
    const mapa = new Map<string, { id: string; bloco: string; numero: string }[]>();
    if (!ids.length) return mapa;
    const linhas = await this.db.select({ pessoaId: vinculoUnidade.pessoaId, id: unidade.id, bloco: unidade.bloco, numero: unidade.numero })
      .from(vinculoUnidade).innerJoin(unidade, eq(unidade.id, vinculoUnidade.unidadeId))
      .where(and(inArray(vinculoUnidade.pessoaId, ids), vinculoValidoSql(hoje)))
      .orderBy(...ORDEM_UNIDADES);
    for (const l of linhas) mapa.set(l.pessoaId, [...(mapa.get(l.pessoaId) ?? []), { id: l.id, bloco: l.bloco, numero: l.numero }]);
    return mapa;
  }

  /**
   * Selo de restrição (lista e busca do Cadastro). Uma consulta por página: restrições não revogadas e não vencidas
   * das pessoas. Ativa (de unidade, ou de condomínio aprovada) prevalece sobre pendente; entre as ativas, a de
   * condomínio vem antes (vale para todas as unidades).
   */
  async resumosRestricao(ids: string[], agora: Date) {
    const mapa = new Map<string, RestricaoResumoApi>();
    if (!ids.length) return mapa;
    const linhas = await this.db.select({
      pessoaId: restricao.pessoaId, escopo: restricao.escopo, aprovadaEm: restricao.aprovadaEm, bloco: unidade.bloco, numero: unidade.numero,
    }).from(restricao).leftJoin(unidade, eq(unidade.id, restricao.unidadeId))
      .where(and(inArray(restricao.pessoaId, ids), isNull(restricao.revogadaEm), gte(restricao.validaAte, agora)))
      .orderBy(asc(restricao.cadastradaEm), asc(restricao.id));
    const ativas = new Map<string, typeof linhas>(), pendentes = new Map<string, typeof linhas>();
    for (const l of linhas) {
      const alvo = l.escopo === 'condominio' && !l.aprovadaEm ? pendentes : ativas;
      alvo.set(l.pessoaId, [...(alvo.get(l.pessoaId) ?? []), l]);
    }
    const codigo = (l: (typeof linhas)[number]) => (l.bloco !== null && l.numero !== null ? codigoUnidade({ bloco: l.bloco, numero: l.numero }) : null);
    for (const [pid, ls] of ativas) {
      const doCondominio = ls.find((l) => l.escopo === 'condominio');
      mapa.set(pid, { estado: 'ativa', unidadeCodigo: doCondominio ? null : codigo(ls[0]!), total: ls.length });
    }
    for (const [pid, ls] of pendentes) {
      if (!mapa.has(pid)) mapa.set(pid, { estado: 'pendente', unidadeCodigo: null, total: ls.length });
    }
    return mapa;
  }

  /**
   * Último acesso (entrada, negado ou recusado) de cada pessoa, pela ordem da cadeia (seq).
   * Limitação conhecida: usa os valores gravados no evento, não os efetivos depois de uma correção (o módulo de
   * registro de acesso traz a view de valores efetivos).
   */
  async ultimosAcessos(ids: string[]) {
    type Ultimo = { tipo: string; ocorridoEm: Date; bloco: string | null; numero: string | null; area: string | null };
    const mapa = new Map<string, Ultimo>();
    if (!ids.length) return mapa;
    const linhas = await this.db.selectDistinctOn([eventoAcesso.pessoaId], {
      pessoaId: eventoAcesso.pessoaId, tipo: eventoAcesso.tipo, ocorridoEm: eventoAcesso.ocorridoEm,
      bloco: unidade.bloco, numero: unidade.numero, area: areaComum.nome,
    }).from(eventoAcesso)
      .leftJoin(unidade, eq(unidade.id, eventoAcesso.unidadeDestinoId))
      .leftJoin(areaComum, eq(areaComum.id, eventoAcesso.areaComumId))
      .where(and(inArray(eventoAcesso.pessoaId, ids), notInArray(eventoAcesso.tipo, ['saida', 'correcao'])))
      .orderBy(eventoAcesso.pessoaId, desc(eventoAcesso.seq));
    for (const l of linhas) mapa.set(l.pessoaId, l);
    return mapa;
  }

  /** "Hoje 14:32 · D-32", "08/10 · Salão de festas (negado)" ou "Sem acessos". */
  textoUltimoAcesso(u: { tipo: string; ocorridoEm: Date; bloco: string | null; numero: string | null; area: string | null } | undefined, agora: Date) {
    if (!u) return 'Sem acessos';
    const t = u.ocorridoEm.getTime();
    const quando = fmtData(agora.getTime()) === fmtData(t) ? `Hoje ${fmtHora(t)}` : fmtData(t).slice(0, 5);
    const destino = u.bloco !== null && u.numero !== null ? codigoUnidade({ bloco: u.bloco, numero: u.numero }) : u.area;
    return `${quando}${destino ? ` · ${destino}` : ''}${u.tipo === 'negado' ? ' (negado)' : u.tipo === 'recusado' ? ' (recusado)' : ''}`;
  }
}
