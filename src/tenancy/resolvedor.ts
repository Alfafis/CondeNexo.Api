// ResolvedorCondominio (docs/05_arquitetura_saas.md SAAS-03/04, fase F2): o único serviço que lê o banco `plataforma`
// em nome da parte de condomínio. Traduz código do login ou id do cookie em `CondominioResolvido` (banco + chaves
// desembrulhadas) e confere tudo no boot.
//
// - Cache em memória da tabela `condominio` (só id, código, nome, banco, status, módulos: colunas não pessoais). Renovado
//   a cada RENOVAR_MS (status novo, como `suspenso`, e módulo desligado valem em até 1 min) e, num código ou id
//   desconhecido, no máximo uma vez a cada RECARGA_MIN_MS: código inventado em rajada não vira uma consulta à plataforma
//   por requisição. O app do Master invalida o cache deste processo ao mudar módulos (`invalidar`).
// - Plataforma fora do ar na renovação: fica com o cache anterior (o log registra). Sem cache, nada é resolvido e as
//   rotas de condomínio falham fechadas.
// - Chaves: desembrulhadas na primeira resolução do condomínio e guardadas em memória (SAAS-04). Rotação de chave do
//   condomínio (F7) exigirá reiniciar a API ou invalidar este cache.
//
// Boot (onModuleInit; erro aqui derruba o processo antes de abrir a porta):
//   1. há pelo menos um condomínio atendido, e o piloto, se SAAS_PILOTO_PADRAO=true;
//   2. as chaves de todo condomínio atendido desembrulham com a chave mestra do ambiente;
//   3. transição: se o ambiente ainda tem PORTARIA_HMAC_CPF_KEY / PORTARIA_KEK(_VERSAO), elas têm de ser byte a byte as
//      do piloto na plataforma (divergência = alguém trocou uma das duas, e a API leria CPF e anexos com a chave errada);
//   4. cada versão da KEK de cada condomínio abre a DEK de um documento existente dele naquela versão, se houver (prova
//      que a KEK é a que cifrou; durante a rotação da KEK há anexo em mais de uma versão).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { CODIGO_CONDOMINIO as CODIGO } from '../dominio/condominio';
import { MODULOS, type Modulo } from '../dominio/modulos';
import { AGRUPAMENTOS, type Agrupamento, ESTRUTURA_PADRAO } from '../dominio/units';
import { log } from '../comum/log';
import { CONFIG, type Config } from '../config/config';
import { REGISTRO_BANCOS, type RegistroBancos } from '../database/registro-bancos';
import { configuracao, documento } from '../db/schema';
import { kekAbreDek } from '../documentos/cofre';
import { type ChaveMestra, desembrulhar, ErroChave, mesmaChave } from '../plataforma/chave-mestra';
import { type CondominioResolvido, STATUS_ATENDIDOS, type StatusAtendido } from './condominio';
import { CHAVE_MESTRA, type DbPlataforma, PLATAFORMA_DB } from '../plataforma/plataforma-db';
import { BANCO_PILOTO } from '../plataforma/registrar-piloto';
import * as sp from '../plataforma/schema-plataforma';

export const RENOVAR_MS = 60_000;
export const RECARGA_MIN_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Linha { id: string; codigo: string; nome: string; banco: string; status: string; modulos: string[] }

/**
 * Status em que o app do Master LÊ os dados do condomínio (SAAS-09, F5 entrega 2): os atendidos e o `encerrado`, cujo
 * banco ainda existe até a exclusão (suporte e exportação de fim de contrato, SAAS-11). `provisionando` ainda não tem
 * dado; `excluido` não tem mais banco.
 */
export const STATUS_LEITURA_PLATAFORMA = ['ativo', 'suspenso', 'encerrado'] as const;

export type ResolucaoPlataforma =
  | { tipo: 'ok'; condominio: CondominioResolvido; status: string }
  | { tipo: 'inexistente' }
  | { tipo: 'provisionando' };

export interface Resolucao {
  condominio: CondominioResolvido;
  status: StatusAtendido;
}

const atendido = (s: string): s is StatusAtendido => (STATUS_ATENDIDOS as readonly string[]).includes(s);

/**
 * Transição da F2: as chaves que ainda estão no ambiente têm de ser as do piloto na plataforma. Ausentes no ambiente:
 * nada a conferir (o fallback para o ambiente não existe; as chaves em uso são sempre as da plataforma).
 */
export function conferirChavesDoAmbiente(amb: Config['saas']['chavesAmbiente'], piloto: CondominioResolvido | undefined): string[] {
  const conferidas: string[] = [];
  if (!amb.hmacCpf && !amb.kek && amb.kekVersao === null) return conferidas;
  if (!piloto) throw new ErroChave('chaves do ambiente (PORTARIA_HMAC_CPF_KEY/PORTARIA_KEK) sem o piloto registrado na plataforma');
  if (amb.hmacCpf) {
    if (!mesmaChave(amb.hmacCpf, piloto.chaves.hmacCpf)) throw new ErroChave('PORTARIA_HMAC_CPF_KEY difere da chave hmac_cpf do piloto na plataforma: boot recusado');
    conferidas.push('hmac_cpf');
  }
  if (amb.kek) {
    if (!mesmaChave(amb.kek, piloto.chaves.kek)) throw new ErroChave('PORTARIA_KEK difere da KEK ativa do piloto na plataforma: boot recusado');
    conferidas.push('kek_documentos');
  }
  if (amb.kekVersao !== null) {
    if (amb.kekVersao !== piloto.chaves.kekVersao) {
      throw new ErroChave(`PORTARIA_KEK_VERSAO=${amb.kekVersao}, mas a KEK ativa do piloto na plataforma é a v${piloto.chaves.kekVersao}: boot recusado`);
    }
    conferidas.push('kek_versao');
  }
  return conferidas;
}

@Injectable()
export class ResolvedorCondominio implements OnModuleInit {
  private porId = new Map<string, Linha>();
  private porCodigo = new Map<string, string>();
  private carregadoEm = 0;
  private recarga: Promise<void> | null = null;
  private readonly resolvidos = new Map<string, Promise<CondominioResolvido>>();

  constructor(
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(CHAVE_MESTRA) private readonly mestra: ChaveMestra,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(REGISTRO_BANCOS) private readonly registro: RegistroBancos,
  ) {}

  async onModuleInit() {
    await this.recarregar();
    await this.conferirNoBoot();
  }

  private recarregar(): Promise<void> {
    this.recarga ??= (async () => {
      try {
        const linhas = await this.db.select({
          id: sp.condominio.id, codigo: sp.condominio.codigo, nome: sp.condominio.nome, banco: sp.condominio.banco, status: sp.condominio.status,
          modulos: sp.condominio.modulos,
        }).from(sp.condominio);
        this.porId = new Map(linhas.map((l) => [l.id, l]));
        this.porCodigo = new Map(linhas.map((l) => [l.codigo, l.id]));
        this.carregadoEm = Date.now();
      } finally {
        this.recarga = null;
      }
    })();
    return this.recarga;
  }

  /** Renova o cache se venceu (ou, num miss, se a última carga tem mais de RECARGA_MIN_MS). Erro: mantém o anterior. */
  private async renovar(miss: boolean) {
    const idade = Date.now() - this.carregadoEm;
    if (idade < (miss ? RECARGA_MIN_MS : RENOVAR_MS)) return;
    try {
      await this.recarregar();
    } catch {
      // Só o evento: a mensagem do driver pode trazer o host. O cache anterior continua valendo.
      this.carregadoEm = Date.now() - RENOVAR_MS + RECARGA_MIN_MS; // tenta de novo em alguns segundos, não a cada requisição
      log('error', 'saas.plataforma_indisponivel');
    }
  }

  private async resolverLinha(l: Linha | undefined): Promise<Resolucao | null> {
    if (!l || !atendido(l.status)) return null;
    return { condominio: await this.resolver(l), status: l.status };
  }

  async porCodigoDoLogin(codigo: string): Promise<Resolucao | null> {
    const c = codigo.trim().toLowerCase();
    if (!CODIGO.test(c)) return null;
    await this.renovar(false);
    if (!this.porCodigo.has(c)) await this.renovar(true);
    return this.resolverLinha(this.porId.get(this.porCodigo.get(c) ?? ''));
  }

  async porIdDoCookie(id: string): Promise<Resolucao | null> {
    if (!UUID.test(id)) return null;
    await this.renovar(false);
    if (!this.porId.has(id)) await this.renovar(true);
    return this.resolverLinha(this.porId.get(id));
  }

  async piloto(): Promise<Resolucao | null> {
    await this.renovar(false);
    return this.resolverLinha([...this.porId.values()].find((l) => l.banco === BANCO_PILOTO));
  }

  /**
   * Condomínios atendidos (ativo e suspenso), para o agendador e o /saude. Isolado por condomínio: um cuja chave não
   * desembrulha (ou cuja 1ª resolução pegou a plataforma fora) vai para `falhas` (só o id, no log) e os outros seguem.
   */
  async atendidosComFalhas(): Promise<{ resolvidos: Resolucao[]; falhas: string[] }> {
    await this.renovar(false);
    const resolvidos: Resolucao[] = [];
    const falhas: string[] = [];
    for (const l of this.porId.values()) {
      try {
        const x = await this.resolverLinha(l);
        if (x) resolvidos.push(x);
      } catch (e) {
        falhas.push(l.id);
        log('error', 'saas.condominio_indisponivel', { condominio_id: l.id, erro: e instanceof Error ? e.name : 'erro' });
      }
    }
    return { resolvidos, falhas };
  }

  /**
   * Módulos ligados do condomínio (SAAS-19), do cache renovado a cada RENOVAR_MS: desligar vale em até 1 min sem
   * reiniciar. Condomínio fora do cache (não deveria acontecer numa requisição autenticada): nenhum, falha fechada.
   */
  async modulosDe(id: string): Promise<Modulo[]> {
    await this.renovar(false);
    const l = this.porId.get(id);
    return l ? MODULOS.filter((m) => l.modulos.includes(m)) : [];
  }

  /** A próxima consulta recarrega a tabela `condominio` (o Master acabou de mudar módulos neste processo). */
  invalidar(): void {
    this.carregadoEm = 0;
  }

  /**
   * Condomínio para a leitura do app do Master (SAAS-09): também o `encerrado` (STATUS_LEITURA_PLATAFORMA). Id
   * desconhecido ou `excluido`: inexistente (404). Mesmas chaves e mesmo banco da subárvore das requisições dele.
   */
  async paraPlataforma(id: string): Promise<ResolucaoPlataforma> {
    if (!UUID.test(id)) return { tipo: 'inexistente' };
    await this.renovar(false);
    if (!this.porId.has(id)) await this.renovar(true);
    const l = this.porId.get(id);
    if (!l) return { tipo: 'inexistente' };
    if (l.status === 'provisionando') return { tipo: 'provisionando' };
    if (!(STATUS_LEITURA_PLATAFORMA as readonly string[]).includes(l.status)) return { tipo: 'inexistente' };
    return { tipo: 'ok', condominio: await this.resolver(l), status: l.status };
  }

  async atendidos(): Promise<Resolucao[]> {
    return (await this.atendidosComFalhas()).resolvidos;
  }

  /** Prova de que o app_plataforma lê a plataforma (healthcheck). */
  async pingPlataforma(): Promise<void> {
    await this.db.execute(sql`select 1 from condominio limit 1`);
  }

  /** Banco + chaves desembrulhadas; uma vez por condomínio (promessa compartilhada; falha não fica em cache). */
  private resolver(l: Linha): Promise<CondominioResolvido> {
    let p = this.resolvidos.get(l.id);
    if (!p) {
      p = this.desembrulharChaves(l);
      this.resolvidos.set(l.id, p);
      p.catch(() => this.resolvidos.delete(l.id));
    }
    return p;
  }

  private async desembrulharChaves(l: Linha): Promise<CondominioResolvido> {
    const linhas = await this.db.select().from(sp.condominioChave).where(eq(sp.condominioChave.condominioId, l.id));
    const abrir = (k: (typeof linhas)[number]) => desembrulhar(this.mestra, { condominioId: l.id, tipo: k.tipo as sp.TipoChave, versao: k.versao }, k);
    const ativa = (tipo: sp.TipoChave) => {
      const k = linhas.find((x) => x.tipo === tipo && x.ativa);
      if (!k) throw new ErroChave(`condomínio ${l.codigo} sem chave ativa de ${tipo} na plataforma`);
      return { claro: abrir(k), versao: k.versao };
    };
    const hmac = ativa('hmac_cpf');
    const kek = ativa('kek_documentos');
    // Todas as versões da KEK (rotação, cli/rotacionar-chaves): o anexo é lido pela versão gravada nele. Uma versão
    // anterior que não desembrulha derruba a resolução como a ativa (a rotação da mestra re-embrulha todas as linhas).
    const keks = new Map<number, Buffer>([[kek.versao, kek.claro]]);
    for (const k of linhas) if (k.tipo === 'kek_documentos' && !k.ativa) keks.set(k.versao, abrir(k));
    for (const [v, c] of keks) if (c.length !== 32) throw new ErroChave(`condomínio ${l.codigo}: KEK v${v} com tamanho diferente de 32 bytes`);
    const agrupamento = await this.agrupamentoDo(l);
    return {
      id: l.id, codigo: l.codigo, nome: l.nome, banco: l.banco, piloto: l.banco === BANCO_PILOTO, agrupamento,
      chaves: { hmacCpf: hmac.claro, kek: kek.claro, kekVersao: kek.versao, keks },
    };
  }

  /**
   * Agrupamento da `configuracao` do banco do condomínio (linha gravada pelo provisionamento). Sem a linha (o piloto,
   * que nasceu antes da tabela): o padrão de antes. Erro de leitura sobe: a resolução falha e não fica em cache.
   */
  private async agrupamentoDo(l: Linha): Promise<Agrupamento> {
    const [c] = await this.registro.db(l.banco).select({ agrupamento: configuracao.agrupamento }).from(configuracao).limit(1);
    if (!c) return ESTRUTURA_PADRAO.agrupamento;
    if (!(AGRUPAMENTOS as readonly string[]).includes(c.agrupamento)) throw new ErroChave(`condomínio ${l.codigo}: agrupamento desconhecido na configuração`);
    return c.agrupamento as Agrupamento;
  }

  private async conferirNoBoot() {
    const linhas = [...this.porId.values()].filter((l) => atendido(l.status));
    if (!linhas.length) throw new ErroChave('nenhum condomínio ativo ou suspenso no banco plataforma (registrar o piloto: docs/deploy.md, seção 12)');
    const resolvidos: CondominioResolvido[] = [];
    for (const l of linhas) resolvidos.push(await this.resolver(l));
    const piloto = resolvidos.find((c) => c.piloto);
    if (this.config.saas.pilotoPadrao && !piloto) throw new ErroChave('SAAS_PILOTO_PADRAO=true, mas o piloto (banco portaria) não está ativo na plataforma');
    const conferidas = conferirChavesDoAmbiente(this.config.saas.chavesAmbiente, piloto);
    let deks = 0;
    for (const c of resolvidos) {
      for (const [versao, kek] of c.chaves.keks) {
        const [d] = await this.registro.db(c.banco).select({ id: documento.id, dekCifrada: documento.dekCifrada, chaveVersao: documento.chaveVersao })
          .from(documento).where(eq(documento.chaveVersao, versao)).limit(1);
        if (!d) continue;
        if (!kekAbreDek(kek, d)) throw new ErroChave(`a KEK v${versao} do condomínio ${c.codigo} não abre a DEK de um anexo existente: boot recusado`);
        deks++;
      }
    }
    log('info', 'saas.boot', { detalhe: `condominios=${resolvidos.length} piloto=${piloto ? 'sim' : 'nao'} ambiente=${conferidas.join('+') || 'ausente'} deks_conferidas=${deks}` });
  }
}
