// Importação da planilha de moradores (RF-11, RN-09). Regras:
// - unidade inexistente ou desativada e nome ausente: erro, linha não importada;
// - duplicidade NA PLANILHA (mesmo CPF válido na mesma unidade; sem CPF, mesmo nome na mesma unidade): aviso, consolidado;
// - sem CPF ou CPF inválido: aviso; importa como legado "sem CPF" (o número inválido não é gravado);
// - deduplicação com o banco: pelo HMAC do CPF; sem CPF, pelo nome na MESMA unidade (nunca só pelo nome);
// - quem já tem vínculo ativo ou pendente na unidade é reaproveitado, sem duplicar;
// - o resto vira pessoa (se ainda não existe) + vínculo LEGADO com prazo de regularização (RN-09: definido em assembleia,
//   `IMPORTACAO_PRAZO_LEGADO_DIAS`, padrão 90 dias; ver config.ts).
//
// As linhas têm CPF em claro, e por isso a API NÃO as guarda entre a análise e a confirmação (nem em memória): o cliente
// reenvia as linhas no confirmar, e a API confere o HMAC delas com o gravado na análise (`arquivo_sha256` guarda
// HMAC-SHA256 com a chave do CPF, não SHA puro: o SHA de uma planilha de uma linha se reverteria por força bruta).
// A confirmação reprocessa as linhas contra o banco de AGORA, na mesma transação das escritas.
import { createHmac, randomUUID } from 'node:crypto';
import { Body, Controller, HttpCode, Inject, Injectable, Module, Param, Post } from '@nestjs/common';
import { cpfValido } from '../dominio/rules';
import { codigoUnidade, leiturasDoBloco, normalizarNumero } from '../dominio/units';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService, type EntradaAuditoria } from '../auditoria/auditoria.service';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { chavesDe, CONDOMINIO, type CondominioResolvido } from '../saas/condominio';
import { CONFIG, type Config } from '../config/config';
import { diaBrt, somarDias } from '../comum/datas';
import { codigoPg, erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { DB, type Db, type Executor } from '../database/database.module';
import { documentoBusca, mascararCpf } from '../db/cpf';
import { formatoParaCpf, mascarasAntigasEmUso } from '../pessoas/formato-cpf';
import { importacao, importacaoInconsistencia, pessoa, unidade, vinculoUnidade } from '../db/schema';
import { normalizar } from '../pessoas/busca.service';
import { Modulo } from '../saas/modulo.guard';

const MAX_LINHAS = 3000;
const LOTE = 400;

const Linha = z.strictObject({
  linha: z.number().int().min(0).max(1_000_000),
  bloco: z.string().max(20), unidade: z.string().max(20), nome: z.string().max(150),
  documento: z.string().max(30), telefone: z.string().max(30), tipo: z.string().max(40).optional(),
});
type LinhaPlanilha = z.infer<typeof Linha>;
const AnaliseDto = z.strictObject({ arquivo: z.string().trim().min(1).max(200), linhas: z.array(Linha).min(1).max(MAX_LINHAS) });
const ConfirmacaoDto = z.strictObject({ linhas: z.array(Linha).min(1).max(MAX_LINHAS) });

interface Inconsistencia { linha: number; codigo: string; mensagem: string; tipo: 'erro' | 'aviso' }
interface LinhaValida {
  l: LinhaPlanilha; unidadeId: string; codigo: string; nome: string;
  /** HMAC do CPF válido; nulo = sem CPF (ou CPF inválido, que não é gravado). */
  hmac: string | null; mascarado: string | null; telefone: string | null;
  tipo: 'proprietario' | 'inquilino' | 'dependente';
  existenteId: string | null; reaproveitar: boolean;
}

const soDigitos = (s: string) => s.replace(/\D/g, '');
const tipoDaLinha = (t?: string) => (/inquil/i.test(t ?? '') ? 'inquilino' : /depend/i.test(t ?? '') ? 'dependente' : 'proprietario') as LinhaValida['tipo'];
const ATIVOS = ['pendente', 'aprovado', 'legado'] as const;
const em = <T>(xs: T[], n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Documento da amostra devolvida: nunca o CPF em claro (a tela já tem as linhas que leu). Não é gravado. */
function documentoMascarado(doc: string) {
  const d = soDigitos(doc);
  if (!d) return '';
  return d.length === 11 ? mascararCpf(d) : d.replace(/\d/g, '•');
}

@Injectable()
export class ImportacaoService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
  ) {}

  /** HMAC das linhas em forma canônica (ordem fixa de campos), com separação de domínio da chave do CPF. */
  private impressao(linhas: LinhaPlanilha[]) {
    const canon = JSON.stringify(linhas.map((l) => [l.linha, l.bloco, l.unidade, l.nome, l.documento, l.telefone, l.tipo ?? null]));
    return createHmac('sha256', chavesDe(this.condominio).hmacCpf).update(`importacao:v1|${canon}`, 'utf8').digest('hex');
  }

  /** Regras da planilha contra o estado atual do banco (`exec`: a transação da confirmação, ou o pool na análise). */
  private async analisarLinhas(exec: Executor, linhas: LinhaPlanilha[]) {
    const unidades = await exec.select({ id: unidade.id, bloco: unidade.bloco, numero: unidade.numero }).from(unidade).where(eq(unidade.ativo, true));
    const porCodigo = new Map(unidades.map((u) => [codigoUnidade(u), u]));
    const inc: Inconsistencia[] = [];
    const candidatas: Omit<LinhaValida, 'existenteId' | 'reaproveitar'>[] = [];
    const vistos = new Set<string>();
    const antigasEmUso = await mascarasAntigasEmUso(exec); // uma consulta para o lote (regra anti-reconstrução)
    let duplicadas = 0;
    for (const l of linhas) {
      // "A", "Bloco A", "4" ou o antigo "T4"; número só com dígitos e normalizado ("3" -> "03"), como no cadastro.
      const numero = normalizarNumero(l.unidade.replace(/\D/g, ''));
      const un = leiturasDoBloco(l.bloco).map((bloco) => porCodigo.get(codigoUnidade({ bloco, numero }))).find(Boolean);
      if (!un) { inc.push({ linha: l.linha, codigo: 'UNIDADE_INEXISTENTE', mensagem: `Unidade ${l.bloco}/${l.unidade} não existe no condomínio (ou está desativada). Linha não importada.`, tipo: 'erro' }); continue; }
      const nome = l.nome.trim();
      if (!nome) { inc.push({ linha: l.linha, codigo: 'NOME_AUSENTE', mensagem: 'Nome ausente. Linha não importada.', tipo: 'erro' }); continue; }
      const codigo = codigoUnidade(un);
      const dig = soDigitos(l.documento);
      const cpfOk = cpfValido(dig);
      const hmac = cpfOk ? documentoBusca(dig, chavesDe(this.condominio).hmacCpf) : null;
      const chave = hmac ? `cpf|${hmac}|${un.id}` : `${normalizar(nome)}|${un.id}`;
      if (vistos.has(chave)) {
        duplicadas++;
        inc.push({ linha: l.linha, codigo: 'DUPLICIDADE_PLANILHA', mensagem: `${nome} aparece duas vezes na unidade ${codigo}. Consolidado.`, tipo: 'aviso' });
        continue;
      }
      vistos.add(chave);
      if (!dig) inc.push({ linha: l.linha, codigo: 'DOC_AUSENTE', mensagem: `${nome}: sem CPF. Importado como legado, pendente de regularização (RN-09).`, tipo: 'aviso' });
      else if (!cpfOk) inc.push({ linha: l.linha, codigo: 'DOC_INVALIDO', mensagem: `${nome}: CPF inválido. O número não será gravado; importado como legado, pendente de regularização (RN-09).`, tipo: 'aviso' });
      const tel = soDigitos(l.telefone);
      const telOk = /^\d{10,11}$/.test(tel);
      if (l.telefone.trim() && !telOk) inc.push({ linha: l.linha, codigo: 'TELEFONE_INVALIDO', mensagem: `${nome}: telefone fora do padrão (DDD + 8 ou 9 dígitos). Importado sem telefone.`, tipo: 'aviso' });
      candidatas.push({ l, unidadeId: un.id, codigo, nome, hmac, mascarado: cpfOk ? mascararCpf(dig, formatoParaCpf(dig, null, antigasEmUso)) : null, telefone: telOk ? tel : null, tipo: tipoDaLinha(l.tipo) });
    }

    // Quem já existe: pelo HMAC; sem CPF, pelo nome normalizado com algum vínculo NA MESMA unidade (nunca só pelo nome).
    const porHmac = new Map<string, string>();
    // RF-02: cadastro desativado não recebe vínculo (nem legado): a linha é recusada, com a orientação de reativar.
    const desativadas = new Set<string>();
    for (const lote of em([...new Set(candidatas.flatMap((c) => (c.hmac ? [c.hmac] : [])))])) {
      for (const p of await exec.select({ id: pessoa.id, h: pessoa.documentoBusca, d: pessoa.desativadaEm }).from(pessoa).where(inArray(pessoa.documentoBusca, lote))) {
        porHmac.set(p.h!, p.id);
        if (p.d) desativadas.add(p.id);
      }
    }
    const unidadesSemCpf = [...new Set(candidatas.filter((c) => !c.hmac).map((c) => c.unidadeId))];
    const porNomeNaUnidade = new Map<string, string>();
    for (const lote of em(unidadesSemCpf)) {
      const ls = await exec.select({ pessoaId: vinculoUnidade.pessoaId, unidadeId: vinculoUnidade.unidadeId, nome: pessoa.nome, d: pessoa.desativadaEm })
        .from(vinculoUnidade).innerJoin(pessoa, eq(pessoa.id, vinculoUnidade.pessoaId)).where(inArray(vinculoUnidade.unidadeId, lote));
      for (const x of ls) {
        const k = `${x.unidadeId}|${normalizar(x.nome)}`;
        if (!porNomeNaUnidade.has(k)) porNomeNaUnidade.set(k, x.pessoaId);
        if (x.d) desativadas.add(x.pessoaId);
      }
    }
    const existentes = candidatas.map((c) => (c.hmac ? porHmac.get(c.hmac) : porNomeNaUnidade.get(`${c.unidadeId}|${normalizar(c.nome)}`)) ?? null);
    const ativos = new Set<string>();
    for (const lote of em([...new Set(existentes.filter((x): x is string => !!x))])) {
      const ls = await exec.select({ pessoaId: vinculoUnidade.pessoaId, unidadeId: vinculoUnidade.unidadeId }).from(vinculoUnidade)
        .where(and(inArray(vinculoUnidade.pessoaId, lote), inArray(vinculoUnidade.status, [...ATIVOS])));
      for (const x of ls) ativos.add(`${x.pessoaId}|${x.unidadeId}`);
    }
    const validas: LinhaValida[] = candidatas.flatMap((c, i) => {
      const existenteId = existentes[i] ?? null;
      if (existenteId && desativadas.has(existenteId)) {
        inc.push({ linha: c.l.linha, codigo: 'PESSOA_DESATIVADA', mensagem: `${c.nome}: cadastro desativado. Reative a pessoa (ficha, em Pessoas) e importe de novo. Linha não importada.`, tipo: 'erro' });
        return [];
      }
      const reaproveitar = !!existenteId && ativos.has(`${existenteId}|${c.unidadeId}`);
      if (reaproveitar) inc.push({ linha: c.l.linha, codigo: 'DUPLICIDADE_BANCO', mensagem: `${c.nome} já possui vínculo com ${c.codigo}. Reaproveitado, sem duplicar.`, tipo: 'aviso' });
      return [{ ...c, existenteId, reaproveitar }];
    });
    inc.sort((a, b) => a.linha - b.linha);
    return { inconsistencias: inc, validas, rejeitadas: linhas.length - validas.length - duplicadas };
  }

  async analisar(ctx: Contexto, i: z.infer<typeof AnaliseDto>) {
    const agora = this.relogio.agora();
    const prazo = somarDias(diaBrt(agora), this.config.importacao.prazoLegadoDias);
    return this.db.transaction(async (tx) => {
      const r = await this.analisarLinhas(tx, i.linhas);
      const avisos = r.inconsistencias.filter((x) => x.tipo === 'aviso').length;
      const [imp] = await tx.insert(importacao).values({
        arquivoNome: i.arquivo, arquivoSha256: this.impressao(i.linhas), status: 'analisada',
        lidas: i.linhas.length, importaveis: r.validas.length, rejeitadas: r.rejeitadas, avisos,
        prazoRegularizacao: prazo, executadaPorId: ctx.ator.id, analisadaEm: agora,
      }).returning();
      for (const lote of em(r.inconsistencias, LOTE)) await tx.insert(importacaoInconsistencia).values(lote.map((x) => ({ importacaoId: imp!.id, ...x })));
      await this.auditoria.registrar(tx, {
        ator: ctx.ator, ip: ctx.ip, acao: 'importacao.analisar', entidade: 'importacao', registroId: imp!.id,
        depois: { arquivoNome: imp!.arquivoNome, status: imp!.status, lidas: imp!.lidas, importaveis: imp!.importaveis, rejeitadas: imp!.rejeitadas, avisos },
      });
      return {
        id: imp!.id, arquivo: imp!.arquivoNome, status: imp!.status, lidas: imp!.lidas, importaveis: imp!.importaveis,
        rejeitadas: imp!.rejeitadas, avisos, inconsistencias: r.inconsistencias,
        amostra: i.linhas.slice(0, 8).map((l) => ({ ...l, documento: documentoMascarado(l.documento) })),
        prazoRegularizacao: prazo,
      };
    });
  }

  async confirmar(ctx: Contexto, id: string, linhas: LinhaPlanilha[]) {
    const agora = this.relogio.agora();
    try {
      return await this.db.transaction(async (tx) => {
        const [imp] = await tx.select().from(importacao).where(eq(importacao.id, id)).for('update');
        if (!imp) throw erroApi(404, 'IMPORTACAO_NAO_ENCONTRADA', 'Análise de importação não encontrada. Envie o arquivo novamente.');
        if (imp.status !== 'analisada') throw erroApi(409, 'IMPORTACAO_JA_CONFIRMADA', 'Esta importação já foi confirmada ou cancelada.');
        if (this.impressao(linhas) !== imp.arquivoSha256) {
          throw erroApi(409, 'IMPORTACAO_DIVERGENTE', 'As linhas enviadas não são as da análise. Envie o arquivo novamente.');
        }
        const r = await this.analisarLinhas(tx, linhas);
        const criadasPorHmac = new Map<string, string>();
        const pessoas: (typeof pessoa.$inferInsert)[] = [];
        const vinculos: (typeof vinculoUnidade.$inferInsert)[] = [];
        let reaproveitados = 0;
        for (const x of r.validas) {
          if (x.reaproveitar) { reaproveitados++; continue; }
          let pessoaId = x.existenteId ?? (x.hmac ? criadasPorHmac.get(x.hmac) : undefined);
          if (!pessoaId) {
            pessoaId = randomUUID();
            if (x.hmac) criadasPorHmac.set(x.hmac, pessoaId);
            pessoas.push({
              id: pessoaId, nome: x.nome, categoria: 'morador', semCpf: !x.hmac, documentoMascarado: x.mascarado, documentoBusca: x.hmac,
              telefone: x.telefone, importacaoId: id, criadoEm: agora, atualizadoEm: agora,
            });
          }
          vinculos.push({
            id: randomUUID(), pessoaId, unidadeId: x.unidadeId, tipo: x.tipo, status: 'legado', prazoRegularizacao: imp.prazoRegularizacao,
            registradoPorId: ctx.ator.id, registradoEm: agora, importacaoId: id, atualizadoEm: agora,
          });
        }
        for (const lote of em(pessoas, LOTE)) await tx.insert(pessoa).values(lote);
        for (const lote of em(vinculos, LOTE)) await tx.insert(vinculoUnidade).values(lote);
        const [depois] = await tx.update(importacao).set({ status: 'confirmada', importados: vinculos.length, reaproveitados, confirmadaEm: agora })
          .where(eq(importacao.id, id)).returning();
        const trilha: EntradaAuditoria[] = [
          ...pessoas.map((p) => ({ ator: ctx.ator, ip: ctx.ip, acao: 'pessoa.criar', entidade: 'pessoa', registroId: p.id!, depois: { ...p, origem: 'importacao' } })),
          ...vinculos.map((v) => ({ ator: ctx.ator, ip: ctx.ip, acao: 'vinculo.criar', entidade: 'vinculo_unidade', registroId: v.id!, depois: { ...v, origem: 'importacao' } })),
          { ator: ctx.ator, ip: ctx.ip, acao: 'importacao.confirmar', entidade: 'importacao', registroId: id, antes: { status: imp.status }, depois: { status: depois!.status, importados: depois!.importados, reaproveitados } },
        ];
        await this.auditoria.registrarVarios(tx, trilha);
        return { importados: vinculos.length, reaproveitados, prazoRegularizacao: imp.prazoRegularizacao };
      });
    } catch (e) {
      // Outra escrita criou a mesma pessoa ou vínculo entre a leitura e o INSERT: nada foi gravado.
      if (codigoPg(e) === '23505') throw erroApi(409, 'IMPORTACAO_CONFLITO', 'Outro cadastro foi feito ao mesmo tempo. Confirme a importação de novo.');
      throw e;
    }
  }
}

@Modulo('importacao')
@Controller('importacoes')
export class ImportacaoController {
  constructor(@Inject(ImportacaoService) private readonly importacao: ImportacaoService) {}

  @Post()
  @Acao('importacao.executar')
  analisar(@Ctx() ctx: Contexto, @Body(new ZodPipe(AnaliseDto)) b: z.infer<typeof AnaliseDto>) { return this.importacao.analisar(ctx, b); }

  @Post(':id/confirmar')
  @Acao('importacao.executar')
  @HttpCode(200)
  confirmar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(ConfirmacaoDto)) b: z.infer<typeof ConfirmacaoDto>) {
    return this.importacao.confirmar(ctx, id, b.linhas);
  }
}

@Module({ controllers: [ImportacaoController], providers: [ImportacaoService] })
export class ImportacaoModule {}
