// Cadastro de pessoas (RF-02, RN-10, LGPD art. 18). Regras do cadastro e da edição:
// - nome, telefone (10 ou 11 dígitos, com DDD) e CPF obrigatórios; CPF validado pelo dígito verificador;
// - exceção "menor de idade" (LGPD art. 14, minimização): dependente menor, só morador, pode vir sem CPF e sem telefone.
//   Com CPF, valem a validação, a máscara e o HMAC único de sempre; sem CPF, a deduplicação é pelo nome entre os menores
//   sem CPF. Não é "sem CPF" (que só entra por exceção do porteiro): o menor entra como morador. Ao deixar de ser menor
//   (edição `menorIdade: false`), CPF e telefone passam a ser obrigatórios;
// - o CPF não é guardado: só a máscara e o HMAC (documento_busca), único -> 409 PESSOA_DUPLICADA (tradução do 23505);
// - exceção "sem CPF": nome e telefone continuam obrigatórios, e a deduplicação é por nome + telefone;
// - prestador exige empresa (RF-36); porteiro só cadastra visitante e prestador (pessoa.cadastrar_morador);
// - correção (pessoa.editar, SI/AD) grava antes e depois no audit_log (snapshot sem HMAC e com telefone mascarado);
// - desativar/reativar (pessoa.desativar, SI/AD; spec §14 2026-10-22): não exclui. Bloqueia com a pessoa dentro, com
//   vínculo válido (ou aprovado com vigência futura) ou funcionário ativo; revoga na mesma transação as autorizações
//   prévias vigentes ou futuras dela;
// - duplicata (409 PESSOA_DUPLICADA) devolve `detalhes: { desativada, pessoaId? }` para a tela oferecer "Usar o cadastro
//   existente" ou "Reativar" em vez de beco sem saída. O id só vai a quem já acharia a pessoa pela busca normal
//   (pessoa.ver; desativada não aparece na busca, então aí só para quem pode reativar, pessoa.desativar).
// O CPF digitado só existe nesta requisição: nunca vai para log, trilha ou resposta.
import { Inject, Injectable } from '@nestjs/common';
import { pode } from '../dominio/rbac';
import { cpfValido, validarDesativacaoPessoa } from '../dominio/rules';
import type { Papel, TipoVinculo } from '../dominio/types';
import { codigoUnidade } from '../dominio/units';
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { chavesDe, CONDOMINIO, type CondominioResolvido } from '../tenancy/condominio';
import { diaBrt } from '../comum/datas';
import { AcessoNegado, codigoPg, erroApi } from '../comum/erros';
import { codificarCursor, cursorInvalido, decodificarCursor, Pagina } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db, type Executor } from '../database/database.module';
import { documentoBusca } from '../db/cpf';
import { mascaraParaCpf } from './formato-cpf';
import { autorizacaoPrevia, eventoAcesso, funcionario, pessoa, unidade, vinculoUnidade } from '../db/schema';
import { filtroEfetivo, semSaidaSql } from '../eventos/efetivo';
import { vinculoValidoSql } from '../vinculos/vinculo-valido';
import { carregarVinculos } from '../vinculos/vinculo-view';
import { BuscaService, nomeSemAcentoSql, normalizar } from './busca.service';
import {
  colunasPessoa, paraPessoaApi, veDesativadas, veMotivoDesativacao, veRestricao, type LinhaPessoa, type PessoaApi,
} from './pessoa-view';

type Categoria = (typeof pessoa.categoria.enumValues)[number];

export interface NovaPessoa {
  nome: string; documento?: string; telefone?: string; categoria: Categoria; empresa?: string; servico?: string; semCpf?: boolean;
  menorIdade?: boolean;
}
export interface EdicaoPessoa {
  nome?: string; telefone?: string; documento?: string; empresa?: string | null; servico?: string | null; menorIdade?: boolean;
}

const soDigitos = (s: string) => s.replace(/\D/g, '');
const telefoneValido = (t: string) => /^\d{10,11}$/.test(soDigitos(t));
const vazioParaNulo = (s: string | null | undefined) => (s ?? '').trim() || null;

const duplicada = () => erroApi(409, 'PESSOA_DUPLICADA', 'Já existe cadastro com este CPF.');

/**
 * Duplicata com detalhes (mesmo código: clientes antigos tratam igual). Ativa: o id vai a quem tem pessoa.ver (a busca
 * pelo CPF, ou pelo nome no caso sem CPF/menor, já mostraria a pessoa a esse perfil). Desativada: some da busca, então o
 * id só vai a quem pode reativar (pessoa.desativar); o porteiro recebe só a orientação.
 */
function duplicadaCom(mensagem: string, igual: { id: string; desativadaEm: Date | null }, papel: Papel | undefined) {
  if (!igual.desativadaEm) return erroApi(409, 'PESSOA_DUPLICADA', mensagem, { desativada: false, ...(pode(papel, 'pessoa.ver') ? { pessoaId: igual.id } : {}) });
  return pode(papel, 'pessoa.desativar')
    ? erroApi(409, 'PESSOA_DUPLICADA', `${mensagem} O cadastro está desativado: reative-o em vez de cadastrar de novo.`, { desativada: true, pessoaId: igual.id })
    : erroApi(409, 'PESSOA_DUPLICADA', `${mensagem} O cadastro está desativado: peça à administração ou ao síndico para reativá-lo.`, { desativada: true });
}

/** Ordem de prioridade do "vínculo principal" na lista do Cadastro */
const PRIORIDADE = ['aprovado', 'legado', 'pendente', 'rejeitado', 'encerrado'] as const;

/**
 * Só o id da última pessoa: o cursor passa inteiro pela leitura do Master, e com o nome dentro ele entregava o nome completo
 * que os itens mostram mascarado. O formato antigo `{ n, id }` ainda vale (quem paginava na hora da troca), com o `n` ignorado.
 */
const CursorPessoas = z.union([z.strictObject({ id: z.uuid() }), z.strictObject({ n: z.string().max(400), id: z.uuid() })]);

@Injectable()
export class PessoasService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(BuscaService) private readonly busca: BuscaService,
  ) {}

  /**
   * Valida e monta os valores de uma pessoa nova (também usado por funcionários). Lança 422/409 legíveis antes de
   * qualquer INSERT; a unicidade do CPF é garantida de novo pelo índice único (corrida -> 23505 -> 409).
   */
  async valoresNovaPessoa(exec: Executor, i: NovaPessoa, agora: Date, ator?: Contexto['ator']) {
    const recusar = (igual: { id: string; desativadaEm: Date | null }, mensagem: string) => { throw duplicadaCom(mensagem, igual, ator?.papel); };
    const nome = i.nome.trim();
    if (!nome) throw erroApi(422, 'NOME_OBRIGATORIO', 'Informe o nome.');
    const menor = !!i.menorIdade;
    if (menor && i.categoria !== 'morador') throw erroApi(422, 'MENOR_SO_MORADOR', 'Só dependente morador pode ser cadastrado como menor de idade.');
    if (menor && i.semCpf) throw erroApi(422, 'MENOR_SEM_CPF_EXCECAO', 'Menor de idade não usa a exceção “sem CPF”: deixe o CPF em branco se ele não tiver.');
    const telDigitado = soDigitos(i.telefone ?? '');
    if (!(menor && !telDigitado) && !telefoneValido(telDigitado)) throw erroApi(422, 'TELEFONE_INVALIDO', 'Informe o telefone com DDD (10 ou 11 dígitos).');
    if (i.categoria === 'prestador' && !(i.empresa ?? '').trim()) throw erroApi(422, 'EMPRESA_OBRIGATORIA', 'Prestador exige empresa (RF-36).');
    const telefone = telDigitado || null;
    let mascarado: string | null = null;
    let busca: string | null = null;
    if (menor && !soDigitos(i.documento ?? '')) {
      // Menor sem CPF: sem chave única; evita o cadastro em dobro pelo nome entre os menores sem CPF.
      const [igual] = await exec.select({ id: pessoa.id, desativadaEm: pessoa.desativadaEm }).from(pessoa)
        .where(and(eq(pessoa.menorIdade, true), sql`${pessoa.documentoBusca} IS NULL`, sql`${pessoa.anonimizadaEm} IS NULL`, sql`${nomeSemAcentoSql()} = ${normalizar(nome)}`)).limit(1);
      if (igual) recusar(igual, 'Já existe cadastro de menor sem CPF com este nome.');
    } else if (i.semCpf) {
      // Sem CPF não há chave única: evita o cadastro em dobro por nome + telefone.
      const [igual] = await exec.select({ id: pessoa.id, desativadaEm: pessoa.desativadaEm }).from(pessoa)
        .where(and(eq(pessoa.semCpf, true), eq(pessoa.telefone, telefone!), sql`${nomeSemAcentoSql()} = ${normalizar(nome)}`)).limit(1);
      if (igual) recusar(igual, 'Já existe cadastro sem CPF com este nome e telefone.');
    } else {
      const cpf = soDigitos(i.documento ?? '');
      if (!cpf) throw erroApi(422, 'DOCUMENTO_OBRIGATORIO', 'Informe o CPF.');
      if (!cpfValido(cpf)) throw erroApi(422, 'CPF_INVALIDO', 'CPF inválido (confira os dígitos).');
      mascarado = await mascaraParaCpf(exec, cpf, null); // cadastro novo: formato novo (salvo a regra anti-reconstrução)
      busca = documentoBusca(cpf, chavesDe(this.condominio).hmacCpf);
      const [existe] = await exec.select({ id: pessoa.id, desativadaEm: pessoa.desativadaEm }).from(pessoa).where(eq(pessoa.documentoBusca, busca)).limit(1);
      if (existe) recusar(existe, 'Já existe cadastro com este CPF.');
    }
    return {
      nome, categoria: i.categoria, semCpf: !!i.semCpf, menorIdade: menor, documentoMascarado: mascarado, documentoBusca: busca, telefone,
      empresa: vazioParaNulo(i.empresa), servico: vazioParaNulo(i.servico), criadoEm: agora, atualizadoEm: agora,
    };
  }

  async criar(ctx: Contexto, i: NovaPessoa): Promise<PessoaApi> {
    // Porteiro: só visitante e prestador. O 403 sai com a ação tentada (o filtro grava acesso.negado).
    if ((i.categoria === 'morador' || i.categoria === 'funcionario') && !pode(ctx.ator.papel, 'pessoa.cadastrar_morador')) {
      throw new AcessoNegado('pessoa.cadastrar_morador', 'Seu perfil só cadastra visitante e prestador.');
    }
    const agora = this.relogio.agora();
    try {
      return await this.db.transaction(async (tx) => {
        const valores = await this.valoresNovaPessoa(tx, i, agora, ctx.ator);
        const [nova] = await tx.insert(pessoa).values(valores).returning(colunasPessoa);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'pessoa.criar', entidade: 'pessoa', registroId: nova!.id, depois: nova });
        return paraPessoaApi(nova!);
      });
    } catch (e) {
      if (codigoPg(e) === '23505') throw duplicada();
      throw e;
    }
  }

  /** RN-09 e LGPD art. 18 (correção). Campo ausente não muda; CPF informado tira a pessoa de "sem CPF". */
  async editar(ctx: Contexto, id: string, i: EdicaoPessoa): Promise<PessoaApi> {
    const agora = this.relogio.agora();
    try {
      return await this.db.transaction(async (tx) => {
        const [antes] = await tx.select(colunasPessoa).from(pessoa).where(eq(pessoa.id, id)).for('update');
        if (!antes) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
        if (antes.anonimizadaEm) throw erroApi(409, 'PESSOA_ANONIMIZADA', 'Cadastro anonimizado não pode ser editado.');
        const motivo = veMotivoDesativacao(ctx.ator.papel);
        const mudancas: Partial<typeof pessoa.$inferInsert> = {};
        if (i.nome !== undefined) {
          const nome = i.nome.trim();
          if (!nome) throw erroApi(422, 'NOME_OBRIGATORIO', 'Informe o nome.');
          if (nome !== antes.nome) mudancas.nome = nome;
        }
        if (i.telefone !== undefined) {
          if (!telefoneValido(i.telefone)) throw erroApi(422, 'TELEFONE_INVALIDO', 'Informe o telefone com DDD (10 ou 11 dígitos).');
          const tel = soDigitos(i.telefone);
          if (tel !== antes.telefone) mudancas.telefone = tel;
        }
        if (i.documento !== undefined && soDigitos(i.documento) !== '') {
          const cpf = soDigitos(i.documento);
          if (!cpfValido(cpf)) throw erroApi(422, 'CPF_INVALIDO', 'CPF inválido (confira os dígitos).');
          const busca = documentoBusca(cpf, chavesDe(this.condominio).hmacCpf);
          const [outra] = await tx.select({ id: pessoa.id }).from(pessoa).where(eq(pessoa.documentoBusca, busca)).limit(1);
          if (outra && outra.id !== id) throw duplicada();
          if (!outra) {
            mudancas.documentoBusca = busca;
            // Formato de quem já tem máscara se mantém (antigo gera antigo); sem máscara, a regra do cadastro novo.
            mudancas.documentoMascarado = await mascaraParaCpf(tx, cpf, antes.documentoMascarado);
            mudancas.semCpf = false;
          }
        }
        if (i.menorIdade !== undefined && i.menorIdade !== antes.menorIdade) {
          if (i.menorIdade && (antes.categoria !== 'morador' || antes.semCpf)) {
            throw erroApi(422, 'MENOR_SO_MORADOR', 'Só morador com CPF (ou sem CPF por ser menor) pode ser marcado como menor de idade.');
          }
          mudancas.menorIdade = i.menorIdade;
        }
        const menorFinal = mudancas.menorIdade ?? antes.menorIdade;
        if (!menorFinal && !antes.semCpf && !antes.importacaoId) {
          // Deixou de ser menor (ou nunca foi): CPF e telefone obrigatórios, como no cadastro.
          if (!(mudancas.documentoBusca ?? antes.documentoMascarado)) throw erroApi(422, 'DOCUMENTO_OBRIGATORIO', 'Informe o CPF: só dependente menor de idade fica sem CPF.');
          if (!(mudancas.telefone ?? antes.telefone)) throw erroApi(422, 'TELEFONE_INVALIDO', 'Informe o telefone com DDD: só dependente menor de idade fica sem telefone.');
        }
        if (i.empresa !== undefined && vazioParaNulo(i.empresa) !== antes.empresa) mudancas.empresa = vazioParaNulo(i.empresa);
        if (i.servico !== undefined && vazioParaNulo(i.servico) !== antes.servico) mudancas.servico = vazioParaNulo(i.servico);
        const empresaFinal = 'empresa' in mudancas ? mudancas.empresa : antes.empresa;
        if (antes.categoria === 'prestador' && !(empresaFinal ?? '').trim()) throw erroApi(422, 'EMPRESA_OBRIGATORIA', 'Prestador exige empresa (RF-36).');
        if (Object.keys(mudancas).length === 0) return paraPessoaApi(antes, { motivoDesativacao: motivo }); // nada mudou: sem trilha
        const [depois] = await tx.update(pessoa).set({ ...mudancas, atualizadoEm: agora }).where(eq(pessoa.id, id)).returning(colunasPessoa);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'pessoa.editar', entidade: 'pessoa', registroId: id, antes, depois });
        return paraPessoaApi(depois!, { motivoDesativacao: motivo });
      });
    } catch (e) {
      if (codigoPg(e) === '23505') throw duplicada();
      throw e;
    }
  }

  /**
   * Lista do Cadastro: ordem nome + id (keyset). Filtro por texto NÃO entra aqui (pode ser CPF): é a busca por POST.
   * Desativados ficam de fora, salvo `incluirDesativadas` ("mostrar desativados" da tela).
   * `restricao` (selo) só para quem vê restrições (`veRestricao`); para os demais o campo não vem.
   */
  async listar(papel: Papel, f: { limite: number; cursor?: string; categoria?: Categoria; incluirDesativadas?: boolean }) {
    const agora = this.relogio.agora();
    const hoje = diaBrt(agora);
    const depois = f.cursor ? decodificarCursor(f.cursor, CursorPessoas) : null;
    // Âncora pela chave primária, sem os filtros da lista: se sumiu, 400 (a subconsulta direta viraria NULL e uma página vazia calada).
    // Limite aceito: vale o nome ATUAL da âncora. Se a última linha da página anterior for renomeada ou anonimizada antes da próxima
    // página, a posição muda (pula ou repete linhas) até um refresh. Posição congelada exigiria cifrar o `{n,id}` (AEAD), não expor o nome.
    let ancora: string | null = null;
    if (depois) {
      const [a] = await this.db.select({ nome: pessoa.nome }).from(pessoa).where(eq(pessoa.id, depois.id)).limit(1);
      if (!a) throw cursorInvalido();
      ancora = a.nome;
    }
    const filtros: SQL[] = [];
    if (f.categoria) filtros.push(eq(pessoa.categoria, f.categoria));
    // Desativados só para quem tem a tela Cadastro (a portaria nunca os vê, mesmo que mande o parâmetro).
    if (!(f.incluirDesativadas && veDesativadas(papel))) filtros.push(isNull(pessoa.desativadaEm));
    if (depois && ancora !== null) filtros.push(sql`(${pessoa.nome}, ${pessoa.id}) > (${ancora}, ${depois.id}::uuid)`);
    const linhas = await this.db.select(colunasPessoa).from(pessoa)
      .where(filtros.length ? and(...filtros) : undefined)
      .orderBy(asc(pessoa.nome), asc(pessoa.id))
      .limit(f.limite + 1);
    const pagina = linhas.slice(0, f.limite);
    const ids = pagina.map((p) => p.id);
    const comRestricao = veRestricao(papel);
    const [validas, ultimos, principais, restricoes] = await Promise.all([
      this.busca.unidadesValidas(ids, hoje), this.busca.ultimosAcessos(ids), this.vinculosPrincipais(ids),
      comRestricao ? this.busca.resumosRestricao(ids, agora) : null,
    ]);
    const ultimo = pagina[pagina.length - 1];
    const proximo = linhas.length > f.limite && ultimo ? codificarCursor({ id: ultimo.id }) : null;
    return new Pagina(pagina.map((p) => {
      const us = validas.get(p.id) ?? [];
      return {
        ...paraPessoaApi(p),
        ultimoAcesso: this.busca.textoUltimoAcesso(ultimos.get(p.id), agora),
        unidadesVinculadas: us.map((u) => u.id),
        unidadesVinculadasCodigos: us.map((u) => codigoUnidade(u)),
        vinculoPrincipal: principais.get(p.id) ?? null,
        ...(restricoes ? { restricao: restricoes.get(p.id) ?? null } : {}),
      };
    }), proximo);
  }

  /** Um vínculo por pessoa (aprovado > legado > pendente > rejeitado > encerrado), para a coluna da lista. */
  private async vinculosPrincipais(ids: string[]) {
    type Principal = { id: string; unidadeId: string; unidadeCodigo: string; tipo: TipoVinculo; status: (typeof PRIORIDADE)[number] };
    const mapa = new Map<string, Principal>();
    if (!ids.length) return mapa;
    const linhas = await this.db.select({
      pessoaId: vinculoUnidade.pessoaId, id: vinculoUnidade.id, unidadeId: vinculoUnidade.unidadeId, tipo: vinculoUnidade.tipo,
      status: vinculoUnidade.status, bloco: unidade.bloco, numero: unidade.numero,
    }).from(vinculoUnidade).innerJoin(unidade, eq(unidade.id, vinculoUnidade.unidadeId))
      .where(inArray(vinculoUnidade.pessoaId, ids))
      .orderBy(asc(vinculoUnidade.registradoEm), asc(vinculoUnidade.id));
    for (const l of linhas) {
      const atual = mapa.get(l.pessoaId);
      if (!atual || PRIORIDADE.indexOf(l.status) < PRIORIDADE.indexOf(atual.status)) {
        mapa.set(l.pessoaId, { id: l.id, unidadeId: l.unidadeId, unidadeCodigo: codigoUnidade({ bloco: l.bloco, numero: l.numero }), tipo: l.tipo, status: l.status });
      }
    }
    return mapa;
  }

  /**
   * Ficha: pessoa, funcionário (se for) e vínculos. `eventos` continua null aqui: os últimos acessos vêm do módulo de
   * eventos (`GET /eventos-acesso?pessoaId=`), que o adaptador do front chama em paralelo (sem acoplar os módulos).
   * `papel`: de quem lê (o motivo da desativação só para quem pode desativar). O app do Master lê com a visão do síndico.
   */
  async ficha(papel: Papel, id: string) {
    const hoje = diaBrt(this.relogio.agora());
    const [p] = await this.db.select(colunasPessoa).from(pessoa).where(eq(pessoa.id, id));
    if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
    const [f] = await this.db.select().from(funcionario).where(eq(funcionario.pessoaId, id));
    const vinculos = await carregarVinculos(this.db, eq(vinculoUnidade.pessoaId, id), hoje);
    return {
      pessoa: paraPessoaApi(p as LinhaPessoa, { motivoDesativacao: veMotivoDesativacao(papel) }),
      funcionario: f ? {
        pessoaId: f.pessoaId, funcao: f.funcao, ativo: f.ativo,
        escala: { diasSemana: f.diasSemana, horaInicio: f.horaInicio.slice(0, 5), horaFim: f.horaFim.slice(0, 5) },
      } : null,
      vinculos,
      eventos: null,
    };
  }

  /**
   * O que o "Revelar" do app do Master devolve de UMA pessoa (Fase B, 2026-11-01): nome e telefone completos, o documento
   * como a ficha mostra (o CPF não é armazenado: só a máscara existe) e o motivo da desativação. Exceção única à regra de
   * pessoa-view.ts ("telefone completo nunca sai"): só esta função, chamada só pelo AcessoPlataformaService.revelar, que
   * limita e registra em plataforma_audit. Nenhum papel do condomínio chega aqui.
   */
  async paraRevelarNaPlataforma(id: string) {
    const [p] = await this.db.select(colunasPessoa).from(pessoa).where(eq(pessoa.id, id));
    if (!p) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
    const v = paraPessoaApi(p as LinhaPessoa, { motivoDesativacao: true });
    return { id: v.id, nome: v.nome, documentoMascarado: v.documentoMascarado, telefone: p.telefone, desativacaoMotivo: v.desativacaoMotivo ?? null };
  }

  // ----- Desativação (RF-02) ---------------------------------------------------------------------------------------

  /**
   * Desativa o cadastro (não exclui). A pessoa é travada com FOR UPDATE, que conflita com o FOR NO KEY UPDATE da entrada
   * e com o FOR SHARE de quem cria vínculo ou autorização para ela: ou a outra escrita termina antes (e é vista aqui:
   * "dentro", vínculo), ou espera e vê a pessoa desativada. Autorizações prévias vigentes ou futuras são revogadas
   * na mesma transação; a trilha de cada revogação diz a origem (`motivo: 'desativacao_da_pessoa'`), e o texto do
   * motivo fica só na linha `pessoa.desativar` (redigível na anonimização).
   */
  async desativar(ctx: Contexto, id: string, motivo: string): Promise<PessoaApi & { autorizacoesRevogadas: number }> {
    const agora = this.relogio.agora();
    const hoje = diaBrt(agora);
    return this.db.transaction(async (tx) => {
      const [antes] = await tx.select(colunasPessoa).from(pessoa).where(eq(pessoa.id, id)).for('update');
      if (!antes) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
      const [dentro] = await tx.select({ id: eventoAcesso.id }).from(eventoAcesso)
        .where(and(eq(eventoAcesso.tipo, 'entrada'), filtroEfetivo('pessoa_id', (x) => sql`${x} = ${id}::uuid`), semSaidaSql())).limit(1);
      // Válido hoje, ou aprovado com vigência que ainda vai começar (viraria morador válido desativado).
      const [vinculo] = await tx.select({ id: vinculoUnidade.id }).from(vinculoUnidade).where(and(eq(vinculoUnidade.pessoaId, id),
        sql`(${vinculoValidoSql(hoje)} OR (${vinculoUnidade.status} = 'aprovado' AND ${vinculoUnidade.vigenciaInicio} > ${hoje}::date))`)).limit(1);
      const [func] = await tx.select({ ativo: funcionario.ativo }).from(funcionario).where(eq(funcionario.pessoaId, id));
      const erro = validarDesativacaoPessoa(
        { anonimizada: !!antes.anonimizadaEm, desativada: !!antes.desativadaEm }, motivo,
        { dentro: !!dentro, vinculoValido: !!vinculo, funcionarioAtivo: !!func?.ativo },
      );
      if (erro) throw erroApi(erro.status, erro.code, erro.message);
      const [depois] = await tx.update(pessoa).set({
        desativadaEm: agora, desativadaPorId: ctx.ator.id, desativacaoMotivo: motivo.trim(), atualizadoEm: agora,
      }).where(eq(pessoa.id, id)).returning(colunasPessoa);
      const revogadas = await tx.update(autorizacaoPrevia).set({ revogadaEm: agora, revogadaPorId: ctx.ator.id })
        .where(and(eq(autorizacaoPrevia.pessoaId, id), isNull(autorizacaoPrevia.revogadaEm), gte(autorizacaoPrevia.validaAte, agora)))
        .returning();
      await this.auditoria.registrar(tx, {
        ator: ctx.ator, ip: ctx.ip, acao: 'pessoa.desativar', entidade: 'pessoa', registroId: id, antes,
        depois: { ...depois, autorizacoesRevogadas: revogadas.map((a) => a.id) },
      });
      if (revogadas.length) {
        await this.auditoria.registrarVarios(tx, revogadas.map((a) => ({
          ator: ctx.ator, ip: ctx.ip, acao: 'autorizacao.revogar', entidade: 'autorizacao_previa', registroId: a.id,
          antes: { ...a, revogadaEm: null, revogadaPorId: null }, depois: { ...a, motivo: 'desativacao_da_pessoa', pessoaDesativadaId: id },
        })));
      }
      return { ...paraPessoaApi(depois!, { motivoDesativacao: true }), autorizacoesRevogadas: revogadas.length };
    });
  }

  /** Reativa: limpa os três campos. As autorizações revogadas na desativação NÃO voltam (revogação é final). */
  async reativar(ctx: Contexto, id: string): Promise<PessoaApi> {
    const agora = this.relogio.agora();
    return this.db.transaction(async (tx) => {
      const [antes] = await tx.select(colunasPessoa).from(pessoa).where(eq(pessoa.id, id)).for('update');
      if (!antes) throw erroApi(404, 'PESSOA_NAO_ENCONTRADA', 'Pessoa não encontrada.');
      if (antes.anonimizadaEm) throw erroApi(409, 'PESSOA_ANONIMIZADA', 'Cadastro anonimizado não pode ser reativado: faça um novo cadastro.');
      if (!antes.desativadaEm) throw erroApi(409, 'PESSOA_JA_ATIVA', 'Este cadastro já está ativo.');
      const [depois] = await tx.update(pessoa).set({ desativadaEm: null, desativadaPorId: null, desativacaoMotivo: null, atualizadoEm: agora })
        .where(and(eq(pessoa.id, id), isNotNull(pessoa.desativadaEm))).returning(colunasPessoa);
      await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'pessoa.reativar', entidade: 'pessoa', registroId: id, antes, depois });
      return paraPessoaApi(depois!, { motivoDesativacao: true });
    });
  }
}
