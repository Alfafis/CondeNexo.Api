// Provisionamento de condomínio novo (docs/05_arquitetura_saas.md SAAS-10, "Provisionamento"; CLI em
// src/cli/provisionar-condominio.ts). De ponta a ponta, e RETOMÁVEL: cada passo confere o que já existe antes de criar,
// e o condomínio só vira `ativo` depois da verificação final. Falhou no meio: fica `provisionando` (a API não o atende,
// o laço de migração e o backup não o veem) e rodar de novo com a MESMA entrada continua de onde parou.
//
//   1. plataforma (app_plataforma): linha em `condominio` (status provisionando, banco `portaria_<8>` sorteado) e as
//      duas chaves (HMAC do CPF e KEK, 32 bytes aleatórios cada) embrulhadas pela chave mestra, numa transação. Na
//      retomada, confere que a entrada é a mesma e que as chaves desembrulham.
//   2. cluster (app_provisionador): CREATE DATABASE ... OWNER app_migrator (template0), REVOKE de PUBLIC e CONNECT só
//      para app_migrator e app_rw: os mesmos GRANTs do piloto (db/bootstrap/00_roles.sh). Banco que já existe com
//      outro dono: recusa (não é nosso).
//   3. migrações do condomínio (app_migrator), as mesmas pastas do laço `migrar-bancos.mjs`.
//   4. dados (app_rw, uma transação): `configuracao` (agrupamento), as unidades (da grade `estrutura` ou da lista
//      explícita `unidades`), ponto de acesso,
//      áreas comuns e o primeiro síndico com senha temporária (troca obrigatória no primeiro login, validade de 72 h),
//      com audit_log de ator nulo e nome NOME_PROVISIONAMENTO. Na retomada, a senha do síndico é REGERADA (a anterior
//      nunca foi entregue: a senha só sai depois do passo 6).
//   5. verificação: unidades, configuração, síndico, cabeça da cadeia na gênese, migrações todas aplicadas, CONNECT.
//   6. ativação (app_plataforma): status provisionando -> ativo + plataforma_audit `condominio.provisionar`.
//
// Condomínio já ativo com a mesma entrada: nada muda (`ja_provisionado`), e nenhuma senha é impressa. Com
// `novaSenhaSindico`, gera outra temporária SÓ se o síndico ainda não entrou nenhuma vez (a de 72 h venceu antes do uso).
//
// Nada aqui imprime ou devolve chave em claro; a senha temporária volta UMA vez no resultado, para a CLI mostrar.
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CODIGO_CONDOMINIO, LOGIN_SINDICO, UFS } from '../dominio/condominio';
import { MODULOS_PADRAO } from '../dominio/modulos';
import { SENHA_TEMPORARIA_VALIDADE_MS } from '../dominio/rules';
import {
  type Agrupamento, AGRUPAMENTOS, AREAS_COMUNS_INICIAIS, codigoUnidade, compararUnidades, type EstruturaUnidade, FORMATO_BLOCO,
  FORMATO_NUMERO, gerarUnidades, LIMITE_UNIDADES, PORTARIA_SOCIAL,
} from '../dominio/units';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { colunasGestao } from '../auth/auth.service';
import type { Db, Tx } from '../database/database.module';
import { NOME_BANCO } from '../database/registro-bancos';
import * as s from '../db/schema';
import { type ChaveMestra, desembrulhar, embrulhar, ErroChave, impressaoDigital } from './chave-mestra';
import type { DbPlataforma } from './registrar-piloto';
import * as sp from './schema-plataforma';

/** Nome na trilha do condomínio (audit_log.usuario_nome) do que a CLI grava, no padrão de NOME_AGENDADOR. */
export const NOME_PROVISIONAMENTO = 'Plataforma (provisionamento)';
/** Dono de todo banco de condomínio (como o `portaria` do piloto). */
export const DONO_BANCO = 'app_migrator';

export class ErroProvisionamento extends Error {}

// ----- Entrada ------------------------------------------------------------------------------------------------------

const EnumAgrupamento = z.enum(AGRUPAMENTOS as unknown as ['Bloco', 'Torre']);

/** Grade declarativa (número = andar × 10 + final), como o ESTRUTURA_PADRAO do domain. */
const Estrutura = z.strictObject({
  agrupamento: EnumAgrupamento,
  blocos: z.array(z.string()).min(1).max(60),
  andares: z.array(z.number().int()).min(1).max(10),
  finais: z.array(z.number().int()).min(1).max(9),
  ausentes: z.array(z.string()).max(500).default([]),
});

/**
 * Lista explícita (lista colada ou planilha na tela do Master; `lerListaUnidades` do domain). Mesmas regras dos CHECKs
 * `unidade_bloco_ck` e `unidade_numero_ck` (FORMATO_BLOCO e FORMATO_NUMERO): o bloco vira maiúsculo; o número tem de vir
 * canônico ("03", "32", "101"), para "3" e "03" nunca virarem duas linhas iguais por engano.
 */
const UnidadeLista = z.strictObject({
  bloco: z.string().trim().toUpperCase().regex(FORMATO_BLOCO, 'bloco: 1 a 3 letras ou dígitos'),
  numero: z.string().trim().regex(FORMATO_NUMERO, 'número: só dígitos (até 4), maior que zero, com 2 dígitos no mínimo (ex.: 03, 32, 101)'),
});

/**
 * Formato do arquivo JSON da CLI e do corpo de POST /plataforma/condominios (exemplos em docs/deploy.md, seção 16.2).
 * Só dado do condomínio e do síndico. As unidades vêm por UM de dois caminhos: `estrutura` (grade) ou `unidades` (lista
 * explícita, com o `agrupamento` neste nível).
 */
export const EntradaJson = z.strictObject({
  codigo: z.string().trim().toLowerCase().regex(CODIGO_CONDOMINIO, 'código: 3 a 31 caracteres, a-z, 0-9 e hífen, começando por letra'),
  nome: z.string().trim().min(1).max(200),
  cidade: z.string().trim().min(1).max(100),
  uf: z.string().trim().toUpperCase().refine((u) => (UFS as readonly string[]).includes(u), 'UF inválida'),
  plano: z.string().trim().min(1).max(40).default('padrao'),
  /** Bloco ou Torre: obrigatório com `unidades`; com `estrutura`, opcional e igual ao `estrutura.agrupamento`. */
  agrupamento: EnumAgrupamento.optional().describe('Obrigatório com `unidades`; com `estrutura`, opcional e igual a `estrutura.agrupamento`.'),
  estrutura: Estrutura.optional().describe('Grade (número = andar × 10 + final). Exatamente um de `estrutura` ou `unidades`.'),
  unidades: z.array(UnidadeLista).min(1).max(LIMITE_UNIDADES).optional()
    .describe('Lista explícita, sem repetidas (bloco maiúsculo; número canônico: "03", "32", "101"). Exatamente um de `estrutura` ou `unidades`.'),
  areasComuns: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  // Mesmas regras do cadastro de usuário da API (usuarios.controller.ts).
  sindico: z.strictObject({
    nome: z.string().trim().min(3).max(120),
    login: z.string().trim().toLowerCase().regex(LOGIN_SINDICO, 'login do síndico: 3 a 40 caracteres, começando por letra (a-z, 0-9, ".", "-", "_")'),
  }),
}).superRefine((e, ctx) => {
  if (!e.estrutura === !e.unidades) {
    ctx.addIssue({ code: 'custom', path: ['unidades'], message: 'informe exatamente um: `estrutura` (grade) ou `unidades` (lista)' });
  }
  if (e.unidades && !e.agrupamento) ctx.addIssue({ code: 'custom', path: ['agrupamento'], message: 'obrigatório com `unidades` (Bloco ou Torre)' });
  if (e.estrutura && e.agrupamento && e.agrupamento !== e.estrutura.agrupamento) {
    ctx.addIssue({ code: 'custom', path: ['agrupamento'], message: 'diferente de `estrutura.agrupamento`' });
  }
  if (e.unidades) {
    const vistas = new Set<string>();
    let repetidas = 0;
    e.unidades.forEach((u, i) => {
      const c = codigoUnidade(u);
      if (!vistas.has(c)) { vistas.add(c); return; }
      // Até 5 apontadas: a lista pode ter milhares, e a resposta de erro não precisa repetir todas.
      if (++repetidas <= 5) ctx.addIssue({ code: 'custom', path: ['unidades', i], message: `unidade repetida: ${c}` });
    });
  }
});

export interface EntradaProvisionamento {
  codigo: string;
  nome: string;
  cidade: string;
  uf: string;
  plano: string;
  agrupamento: Agrupamento;
  /** Unidades a criar, normalizadas, únicas e ordenadas: geradas da grade `estrutura` ou a lista `unidades`. */
  unidades: EstruturaUnidade[];
  areasComuns: string[];
  sindico: { nome: string; login: string };
}

/**
 * JSON lido -> entrada validada, com as unidades JÁ resolvidas (a grade é gerada aqui): tudo é recusado antes de tocar
 * em qualquer banco.
 */
export function validarEntrada(bruto: unknown): EntradaProvisionamento {
  const r = EntradaJson.safeParse(bruto);
  if (!r.success) {
    const problemas = r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);
    throw new ErroProvisionamento(`entrada inválida: ${problemas.join('; ')}`);
  }
  const { estrutura, unidades: lista, agrupamento: informado, areasComuns, ...resto } = r.data;
  let unidades: EstruturaUnidade[];
  let agrupamento: Agrupamento;
  if (estrutura) {
    try {
      unidades = gerarUnidades(estrutura);
    } catch (erro) {
      throw new ErroProvisionamento(`entrada inválida: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
    agrupamento = estrutura.agrupamento;
  } else {
    // O schema já garantiu: lista presente, formato dos CHECKs, sem repetidas, até LIMITE_UNIDADES, agrupamento informado.
    unidades = lista!.map((u) => ({ bloco: u.bloco, numero: u.numero })).sort(compararUnidades);
    agrupamento = informado!;
  }
  const areas = areasComuns ?? [...AREAS_COMUNS_INICIAIS];
  if (new Set(areas.map((a) => a.toLowerCase())).size !== areas.length) throw new ErroProvisionamento('entrada inválida: área comum repetida');
  return { ...resto, agrupamento, unidades, areasComuns: areas };
}

/** Blocos distintos das unidades, na ordem delas (trilha do provisionamento). */
const blocosDe = (us: readonly EstruturaUnidade[]) => [...new Set(us.map((u) => u.bloco))];

// ----- Portas (o que muda entre produção, Postgres real e PGlite) ----------------------------------------------------

/** Operações de cluster, como app_provisionador (conectado ao banco `postgres`). */
export interface Cluster {
  /** Dono do banco, ou null se não existe. */
  donoDoBanco(banco: string): Promise<string | null>;
  /** CREATE DATABASE <banco> OWNER app_migrator TEMPLATE template0. */
  criarBanco(banco: string): Promise<void>;
  /** REVOKE ALL FROM PUBLIC; GRANT CONNECT a app_migrator e app_rw (idempotente). */
  restringirConexao(banco: string): Promise<void>;
  /** Quem pode conectar (verificação final). */
  conexoes(banco: string): Promise<{ appRw: boolean; appPlataforma: boolean; publico: boolean }>;
}

export interface Portas {
  /** Banco plataforma como app_plataforma. */
  plataforma: DbPlataforma;
  cluster: Cluster;
  /** Aplica as migrações do condomínio (app_migrator) e devolve quantas constam como aplicadas e quantas existem. */
  migrar(banco: string): Promise<{ aplicadas: number; esperadas: number }>;
  /** Executor do banco do condomínio como app_rw. */
  dados(banco: string): Db;
  mestra: ChaveMestra;
  /** argon2id com os parâmetros da API (a CLI usa PADROES_ARGON2). */
  hashSenha(senha: string): Promise<string>;
  gerarSenha(): string;
  agora?: () => Date;
  /** 8 caracteres [a-z0-9] do nome do banco (padrão: aleatório). */
  sufixoBanco?: () => string;
}

export interface OpcoesProvisionamento {
  /** Condomínio já ativo: gera outra senha temporária para o síndico que ainda não entrou nenhuma vez. */
  novaSenhaSindico?: boolean;
  /**
   * Quem pediu pela tela do Master (F5, entrega 1): vira o ator da linha `condominio.provisionar` de `plataforma_audit`
   * (gravada na MESMA transação da ativação) e `detalhes.origem = 'plataforma'`. Ausente: CLI (`origem = 'cli'`, ator nulo).
   */
  masterUsuarioId?: string;
}

export interface ResultadoProvisionamento {
  situacao: 'provisionado' | 'retomado' | 'ja_provisionado' | 'nova_senha_sindico';
  condominioId: string;
  codigo: string;
  banco: string;
  unidades: number;
  migracoes: number;
  modulos: string[];
  chaves: { tipo: sp.TipoChave; versao: number; mestraVersao: number; impressao: string }[];
  /** Só quando uma senha foi gerada nesta execução. A CLI mostra uma vez e não grava. */
  sindico?: { login: string; senhaTemporaria: string; expiraEm: string };
}

const ALFABETO_BANCO = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function sufixoAleatorio(): string {
  const b = randomBytes(8);
  return [...b].map((x) => ALFABETO_BANCO[x % ALFABETO_BANCO.length]).join('');
}

// ----- Passo 1: plataforma -------------------------------------------------------------------------------------------

interface Registro { id: string; banco: string; status: string; modulos: string[]; novo: boolean }

async function registrar(p: Portas, e: EntradaProvisionamento): Promise<Registro> {
  return p.plataforma.transaction(async (tx) => {
    const [atual] = await tx.select().from(sp.condominio).where(eq(sp.condominio.codigo, e.codigo));
    if (atual) {
      const diferencas = (['nome', 'cidade', 'uf', 'plano'] as const).filter((k) => atual[k] !== e[k]);
      if (diferencas.length) {
        throw new ErroProvisionamento(`o código ${e.codigo} já está cadastrado com outro ${diferencas.join(', ')}: nada foi alterado `
          + '(corrigir a entrada; renomear é tela do Master, fase F5)');
      }
      if (atual.status !== 'provisionando' && atual.status !== 'ativo') {
        throw new ErroProvisionamento(`o condomínio ${e.codigo} está ${atual.status}: provisionamento recusado`);
      }
      if (atual.banco === 'portaria') throw new ErroProvisionamento('o piloto não se provisiona por aqui (registrar-piloto)');
      return { id: atual.id, banco: atual.banco, status: atual.status, modulos: atual.modulos, novo: false };
    }
    const banco = `portaria_${(p.sufixoBanco ?? sufixoAleatorio)()}`;
    if (!NOME_BANCO.test(banco) || banco === 'portaria') throw new ErroProvisionamento('nome de banco sorteado fora do formato');
    const [c] = await tx.insert(sp.condominio).values({
      codigo: e.codigo, nome: e.nome, banco, status: 'provisionando', plano: e.plano, cidade: e.cidade, uf: e.uf,
      modulos: [...MODULOS_PADRAO],
    }).returning({ id: sp.condominio.id, modulos: sp.condominio.modulos });
    for (const tipo of sp.TIPOS_CHAVE) {
      const chave = randomBytes(32);
      try {
        await tx.insert(sp.condominioChave).values({ condominioId: c!.id, tipo, versao: 1, ...embrulhar(p.mestra, { condominioId: c!.id, tipo, versao: 1 }, chave), ativa: true });
      } finally {
        chave.fill(0);
      }
    }
    return { id: c!.id, banco, status: 'provisionando', modulos: c!.modulos, novo: true };
  });
}

/** As duas chaves ativas existem e desembrulham com a mestra do ambiente (ida e volta). Devolve só as impressões. */
async function conferirChaves(p: Portas, condominioId: string): Promise<ResultadoProvisionamento['chaves']> {
  const linhas = await p.plataforma.select().from(sp.condominioChave)
    .where(and(eq(sp.condominioChave.condominioId, condominioId), eq(sp.condominioChave.ativa, true)));
  const saida: ResultadoProvisionamento['chaves'] = [];
  for (const tipo of sp.TIPOS_CHAVE) {
    const l = linhas.find((x) => x.tipo === tipo);
    if (!l) throw new ErroProvisionamento(`condomínio sem chave ativa de ${tipo} na plataforma: conferir à mão`);
    const claro = desembrulhar(p.mestra, { condominioId, tipo, versao: l.versao }, l);
    try {
      if (claro.length !== 32) throw new ErroChave(`chave ${tipo} com tamanho inesperado`);
      saida.push({ tipo, versao: l.versao, mestraVersao: l.mestraVersao, impressao: impressaoDigital(claro) });
    } finally {
      claro.fill(0);
    }
  }
  return saida;
}

// ----- Passo 2: cluster ----------------------------------------------------------------------------------------------

async function prepararBanco(p: Portas, banco: string) {
  const dono = await p.cluster.donoDoBanco(banco);
  if (dono === null) await p.cluster.criarBanco(banco);
  else if (dono !== DONO_BANCO) throw new ErroProvisionamento(`o banco ${banco} já existe com outro dono (${dono}): não é deste provisionamento`);
  await p.cluster.restringirConexao(banco);
}

// ----- Passo 4: dados ------------------------------------------------------------------------------------------------

/** Diferença entre conjuntos de unidades, para a mensagem (no máximo 5 de cada lado). */
function diferencaUnidades(banco: Set<string>, esperado: Set<string>) {
  const falta = [...esperado].filter((x) => !banco.has(x)).slice(0, 5);
  const sobra = [...banco].filter((x) => !esperado.has(x)).slice(0, 5);
  return `faltam ${falta.join(', ') || 'nenhuma'}; sobram ${sobra.join(', ') || 'nenhuma'}`;
}

const ATOR_PROVISIONAMENTO = { ator: null, nomeInformado: NOME_PROVISIONAMENTO } as const;

interface SenhaGerada { senhaTemporaria: string; senhaHash: string; expiraEm: Date; agora: Date }

async function novaSenha(p: Portas): Promise<SenhaGerada> {
  const agora = (p.agora ?? (() => new Date()))();
  const senhaTemporaria = p.gerarSenha();
  const senhaHash = await p.hashSenha(senhaTemporaria); // fora da transação (argon2 leva centenas de ms)
  return { senhaTemporaria, senhaHash, expiraEm: new Date(agora.getTime() + SENHA_TEMPORARIA_VALIDADE_MS), agora };
}

/**
 * Síndico com a senha temporária `g`: cria, ou (retomada / pedido explícito) troca a senha de quem NUNCA entrou.
 * Quem já entrou: recusa (a senha dele é dele; "trocar senha" na própria tela).
 */
async function gravarSindico(tx: Tx, e: EntradaProvisionamento, banco: string, g: SenhaGerada) {
  const auditoria = new AuditoriaService();
  const [atual] = await tx.select().from(s.usuarioSistema).where(sql`lower(${s.usuarioSistema.login}) = ${e.sindico.login}`);
  if (!atual) {
    const [novo] = await tx.insert(s.usuarioSistema).values({
      nome: e.sindico.nome, login: e.sindico.login, papel: 'sindico', senhaHash: g.senhaHash, deveTrocarSenha: true,
      senhaTemporariaExpiraEm: g.expiraEm, criadoEm: g.agora, atualizadoEm: g.agora,
    }).returning(colunasGestao);
    await auditoria.registrar(tx, { ...ATOR_PROVISIONAMENTO, acao: 'usuario.criar', entidade: 'usuario_sistema', registroId: novo!.id, depois: novo });
    return;
  }
  if (atual.papel !== 'sindico' || !atual.ativo) {
    throw new ErroProvisionamento(`o login ${e.sindico.login} já existe no banco ${banco} e não é um síndico ativo: conferir à mão`);
  }
  if (!atual.deveTrocarSenha || atual.ultimoAcesso !== null) {
    throw new ErroProvisionamento(`o síndico ${e.sindico.login} já entrou no sistema: a senha dele não é trocada por aqui`);
  }
  const [d] = await tx.update(s.usuarioSistema)
    .set({ senhaHash: g.senhaHash, deveTrocarSenha: true, senhaTemporariaExpiraEm: g.expiraEm, senhaAlteradaEm: g.agora, atualizadoEm: g.agora })
    .where(eq(s.usuarioSistema.id, atual.id)).returning(colunasGestao);
  await auditoria.registrar(tx, { ...ATOR_PROVISIONAMENTO, acao: 'usuario.redefinir_senha', entidade: 'usuario_sistema', registroId: atual.id, depois: d });
}

/** Configuração, unidades, ponto de acesso, áreas comuns e síndico, numa transação (app_rw). Devolve a senha gerada. */
async function gravarDados(p: Portas, banco: string, e: EntradaProvisionamento): Promise<SenhaGerada> {
  const esperadas = e.unidades;
  const g = await novaSenha(p);
  await p.dados(banco).transaction(async (tx) => {
    const [conf] = await tx.select().from(s.configuracao);
    if (!conf) {
      await tx.insert(s.configuracao).values({ agrupamento: e.agrupamento });
    } else if (conf.agrupamento !== e.agrupamento) {
      throw new ErroProvisionamento(`o banco ${banco} já tem agrupamento ${conf.agrupamento}, a entrada diz ${e.agrupamento}`);
    }

    // Banco vazio recebe as unidades; banco com unidades (retomada) precisa ter exatamente o mesmo conjunto, venha ele da
    // grade ou da lista (a comparação é por código "A-101", então a mesma lista em outra ordem também retoma).
    const existentes = await tx.select({ bloco: s.unidade.bloco, numero: s.unidade.numero }).from(s.unidade);
    const noBanco = new Set(existentes.map(codigoUnidade));
    const alvo = new Set(esperadas.map(codigoUnidade));
    if (!existentes.length) {
      // Em lotes: milhares de linhas num INSERT só passariam do limite de parâmetros do protocolo (65535).
      for (let i = 0; i < esperadas.length; i += 1000) {
        await tx.insert(s.unidade).values(esperadas.slice(i, i + 1000).map((u) => ({ bloco: u.bloco, numero: u.numero })));
      }
      await new AuditoriaService().registrar(tx, {
        ...ATOR_PROVISIONAMENTO, acao: 'condominio.provisionar', entidade: 'configuracao', registroId: null,
        depois: { agrupamento: e.agrupamento, unidades: esperadas.length, blocos: blocosDe(esperadas), areas_comuns: e.areasComuns, ponto_acesso: PORTARIA_SOCIAL },
      });
    } else if (noBanco.size !== alvo.size || [...alvo].some((x) => !noBanco.has(x))) {
      throw new ErroProvisionamento(`o banco ${banco} já tem outra estrutura de unidades (${diferencaUnidades(noBanco, alvo)}): nada foi alterado`);
    }
    await tx.insert(s.pontoAcesso).values({ nome: PORTARIA_SOCIAL }).onConflictDoNothing({ target: s.pontoAcesso.nome });
    await tx.insert(s.areaComum).values(e.areasComuns.map((nome) => ({ nome }))).onConflictDoNothing({ target: s.areaComum.nome });
    await gravarSindico(tx, e, banco, g);
  });
  return g;
}

// ----- Passo 5: verificação ------------------------------------------------------------------------------------------

async function verificar(p: Portas, banco: string, e: EntradaProvisionamento, migracoes: { aplicadas: number; esperadas: number }) {
  const problemas: string[] = [];
  if (migracoes.aplicadas !== migracoes.esperadas) problemas.push(`migrações: ${migracoes.aplicadas} aplicadas de ${migracoes.esperadas}`);
  const db = p.dados(banco);
  const [conf] = await db.select().from(s.configuracao);
  if (conf?.agrupamento !== e.agrupamento) problemas.push('configuracao ausente ou diferente');
  const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(s.unidade);
  const esperadas = e.unidades.length;
  if (n !== esperadas) problemas.push(`unidades: ${n} no banco, ${esperadas} na entrada`);
  const [sind] = await db.select({ papel: s.usuarioSistema.papel, ativo: s.usuarioSistema.ativo })
    .from(s.usuarioSistema).where(sql`lower(${s.usuarioSistema.login}) = ${e.sindico.login}`);
  if (sind?.papel !== 'sindico' || !sind.ativo) problemas.push('síndico ausente ou inativo');
  const [cab] = await db.select().from(s.eventoAcessoCadeia);
  if (!cab) problemas.push('cabeça da cadeia ausente (migração 0001)');
  const [{ eventos }] = await db.select({ eventos: sql<number>`count(*)`.mapWith(Number) }).from(s.eventoAcesso);
  if (cab && eventos === 0 && cab.ultimoSeq !== 0) problemas.push('cabeça da cadeia fora da gênese num banco sem eventos');
  const c = await p.cluster.conexoes(banco);
  if (!c.appRw || c.appPlataforma || c.publico) problemas.push(`CONNECT fora do padrão (app_rw=${c.appRw}, app_plataforma=${c.appPlataforma}, PUBLIC=${c.publico})`);
  if (problemas.length) throw new ErroProvisionamento(`verificação final falhou (o condomínio continua provisionando): ${problemas.join('; ')}`);
  return n;
}

// ----- Orquestração --------------------------------------------------------------------------------------------------

export async function provisionar(p: Portas, e: EntradaProvisionamento, o: OpcoesProvisionamento = {}): Promise<ResultadoProvisionamento> {
  const reg = await registrar(p, e);
  const chaves = await conferirChaves(p, reg.id);
  const base = { condominioId: reg.id, codigo: e.codigo, banco: reg.banco, modulos: reg.modulos, chaves };
  const sindico = (g: SenhaGerada) => ({ login: e.sindico.login, senhaTemporaria: g.senhaTemporaria, expiraEm: g.expiraEm.toISOString() });

  if (reg.status === 'ativo') {
    // Já ativo: o condomínio está em uso (a estrutura pode ter mudado pelo CRUD, as migrações são do laço de deploy).
    // Sem a opção, só leitura. Com ela, só a senha do síndico que nunca entrou.
    const [{ n }] = await p.dados(reg.banco).select({ n: sql<number>`count(*)`.mapWith(Number) }).from(s.unidade);
    if (!o.novaSenhaSindico) return { situacao: 'ja_provisionado', ...base, unidades: n, migracoes: 0 };
    const g = await novaSenha(p);
    await p.dados(reg.banco).transaction((tx) => gravarSindico(tx, e, reg.banco, g));
    return { situacao: 'nova_senha_sindico', ...base, unidades: n, migracoes: 0, sindico: sindico(g) };
  }
  if (o.novaSenhaSindico) throw new ErroProvisionamento('--nova-senha-sindico só vale para condomínio já ativo (este está provisionando: rode sem a opção)');

  await prepararBanco(p, reg.banco);
  const migracoes = await p.migrar(reg.banco);
  const g = await gravarDados(p, reg.banco, e);
  const unidades = await verificar(p, reg.banco, e, migracoes);

  await p.plataforma.transaction(async (tx) => {
    const ativado = await tx.update(sp.condominio).set({ status: 'ativo' })
      .where(and(eq(sp.condominio.id, reg.id), eq(sp.condominio.status, 'provisionando'))).returning({ id: sp.condominio.id });
    if (!ativado.length) throw new ErroProvisionamento('o condomínio saiu de provisionando durante a execução: conferir à mão');
    await tx.insert(sp.plataformaAudit).values({
      acao: 'condominio.provisionar', condominioId: reg.id, masterUsuarioId: o.masterUsuarioId ?? null,
      detalhes: {
        origem: o.masterUsuarioId ? 'plataforma' : 'cli', banco: reg.banco, unidades, migracoes: migracoes.aplicadas, modulos: reg.modulos, retomado: !reg.novo,
        chaves: chaves.map(({ tipo, versao, mestraVersao }) => ({ tipo, versao, mestraVersao })),
      },
    });
  });
  return { situacao: reg.novo ? 'provisionado' : 'retomado', ...base, unidades, migracoes: migracoes.aplicadas, sindico: sindico(g) };
}
