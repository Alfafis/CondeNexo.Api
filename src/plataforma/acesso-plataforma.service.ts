// Acesso do app do Master aos dados de um condomínio (docs/05_arquitetura_saas.md SAAS-09, revisada na Fase B em
// 2026-11-01). PONTO ÚNICO: é o único lugar de src/plataforma que obtém a subárvore de injeção de um condomínio (teste de
// arquitetura em test/master-leitura.test.ts). Três caminhos:
//
// LEITURA (`ler`, GET /plataforma/condominios/:id/...), desde 2026-11-01 SEM motivo e SEM trilha (decisão do dono do
// produto, risco aceito: a plataforma não registra mais quem leu listas e fichas):
//   1. resolve o condomínio (ativo, suspenso ou encerrado; `provisionando` 409; `excluido` ou desconhecido 404);
//   2. obtém a subárvore durável dele, a MESMA das requisições do condomínio e dos jobs (`contextoDoJob`): os serviços
//      leem pelo pool `app_rw` daquele banco. O `app_plataforma` continua sem CONNECT nos bancos de condomínio;
//   3. chama o serviço existente (as mesmas views do síndico) e minimiza a resposta (minimizacao.ts: nome de terceiro
//      mascarado, texto livre oculto, placa mascarada). Nada é gravado em `audit_log` nem em `plataforma_audit`.
//   As linhas `plataforma.ler`/`plataforma.exportar` e `condominio.ler`/`condominio.exportar`/`condominio.motivo` de
//   antes continuam onde estão (append-only): nada é apagado.
//
// REVELAR (`revelar`, POST .../<entidade>/:registroId/revelar): o valor completo dos campos que a leitura esconde, UM
// registro por vez. Na ordem: limite por usuário (`PLATAFORMA_REVELAR_POR_MINUTO`, em memória; estourou, 429 com
// Retry-After e nada lido nem gravado), situação do condomínio, leitura pelo serviço, UMA linha `condominio.revelar` em
// `plataforma_audit` (entidade, id do registro, rota, método, status e IP; nunca o valor) e só então a resposta. Falhou a
// gravação: 503 e o valor não sai. Nada vai para o `audit_log` do condomínio (o síndico não vê, decisão fechada).
//
// O ModuloGuard não se aplica aqui (rota da plataforma): o dado de um módulo desligado continua existindo e o Master o lê
// para suporte e exportação de fim de contrato (SAAS-19).
//
// ESCRITA (§5.5, a única do Master em dado de condomínio): `alterarSindico`, só sobre usuários `sindico`. Mesmo ponto
// único, com mais três travas antes de mexer em qualquer coisa: reautenticação (a senha do Master de novo, sob o limite do
// login), motivo escrito e condomínio `ativo` ou `suspenso` (`encerrado` 409, `provisionando` 409, `excluido` 404). A
// mudança e a linha `plataforma.usuario_*` do audit_log do condomínio vão na MESMA transação do banco do condomínio; a
// linha de `plataforma_audit` é gravada DENTRO dela, antes do COMMIT (outro banco, sem transação comum). Falhou
// qualquer das duas: rollback, 503 e nada muda. Janela que sobra: COMMIT do condomínio falhar depois da linha da
// plataforma gravada (a plataforma registraria uma ação que não aconteceu: sobra registro, nunca falta). As ações que
// EMITEM credencial de síndico continuam com a senha do Master e o motivo (decisão da Fase C1: a D10 do spec não vale
// nesta fase).
//
// ESCRITA COMUM (`escrever`, Fase C1, spec 2026-11-01-fase-c-escrita-master-design D1): o Master altera dado do
// condomínio pelos MESMOS serviços do síndico, sem senha nem motivo. Ordem FIXA (o teste de arquitetura a confere):
//   1. limite por minuto do usuário (`PLATAFORMA_ESCRITAS_POR_MINUTO`, memória; conta toda tentativa, inclusive as que
//      dão erro de regra; estourou: 429 com Retry-After e nada lido nem gravado);
//   2. situação (`ativo`/`suspenso` escrevem; `encerrado` 409; `provisionando` 409; `excluido` 404) e módulo da entidade
//      (desligado: 409 MODULO_DESLIGADO; a leitura continua liberada);
//   3. classe `destrutiva`/`credencial`: limite DIÁRIO durável (contado em plataforma_audit) e uma linha prévia
//      `condominio.destrutiva`/`condominio.credencial` gravada ANTES (falhou: 503 e nada acontece). Nenhuma rota da C1
//      usa estas classes; o caminho existe para as fases seguintes;
//   4. usuário técnico do condomínio (UsuariosService.garantirTecnicoPlataforma: um SELECT; cria na primeira vez);
//   5. contexto da plataforma (`ator` = o técnico, nome `plataforma/<e-mail>`), montado SÓ aqui;
//   6. o serviço existente, que faz regras, transação e a linha do audit_log na MESMA transação;
//   7. uma linha `condominio.escrever` em plataforma_audit com o status real. Falhou: log de erro e a resposta sai
//      assim mesmo (a mudança já teve COMMIT; um 503 aqui faria o Master repetir e duplicar);
//   8. resposta minimizada, como a leitura (PATCH sem mudança devolve o registro: não pode virar um Revelar sem limite).
import { HttpException, Inject, Injectable, type Type } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Tx } from '../database/database.module';
import { type EfeitoSindico, LOGIN_TECNICO_PLATAFORMA, type OperacaoSindico, type ResultadoSindico, UsuariosService } from '../usuarios/usuarios.service';
import type { Contexto } from '../auth/tipos';
import { type Modulo, ROTULO_MODULO } from '../dominio/modulos';
import { AuthMasterService } from './auth-master.service';
import { codigoPg, erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { CONFIG, type Config } from '../config/config';
import type { CondominioResolvido } from '../tenancy/condominio';
import { contextoDoJob } from '../tenancy/contexto';
import { type DbPlataforma, PLATAFORMA_DB } from '../plataforma/plataforma-db';
import { ResolvedorCondominio } from '../tenancy/resolvedor';
import { LimiteTaxaPublico } from '../selo/publico';
import { minimizarLeituraPlataforma } from './minimizacao';
import type { AuthMaster } from './tipos';
import { registrarPlataforma } from './trilha-plataforma';
import { plataformaAudit } from './schema-plataforma';

/** Serviço resolvido na subárvore do condomínio lido. */
export type Servicos = <T>(token: Type<T>) => Promise<T>;

/** Entidades com "Revelar" (uma rota por entidade, revelar-master.controller.ts). */
export const ENTIDADES_REVELAR = ['pessoa', 'veiculo', 'ocorrencia', 'encomenda'] as const;
export type EntidadeRevelar = (typeof ENTIDADES_REVELAR)[number];

/** Janela do limite do Revelar (o máximo vem de Config.plataforma.revelarPorMinuto). */
export const JANELA_REVELAR_MS = 60_000;

export const MENSAGEM_TRILHA_REVELAR = 'Não foi possível registrar a revelação na trilha da plataforma. Nada foi mostrado; tente de novo.';
export const MENSAGEM_TRILHA_ESCRITA = 'Não foi possível registrar a ação na trilha do condomínio. Nada foi alterado; tente de novo.';

/** O que acompanha toda escrita do Master: motivo (vai para a trilha) e a senha dele (só verificada, nunca gravada). */
export interface ProtecaoEscrita { motivo: string; senhaMaster: string }

/** Janela do limite de escrita por minuto (o máximo vem de Config.plataforma.escritasPorMinuto). */
export const JANELA_ESCRITA_MS = 60_000;
/** Janela dos limites diários duráveis (destrutivas e credenciais). */
export const JANELA_DIARIA_MS = 24 * 3600_000;

/** Entidades que o Master escreve pelo `escrever` (uma por fase; C1: unidade). Vai em `detalhes.entidade`. */
export const ENTIDADES_ESCRITA = ['unidade'] as const;
export type EntidadeEscrita = (typeof ENTIDADES_ESCRITA)[number];

/**
 * Classe da escrita (spec D6). `comum`: só o limite por minuto. `credencial` e `destrutiva`: também o limite diário
 * durável e a linha prévia fail-closed. Confirmação digitada (destrutiva) chega com a C5.
 */
export type ClasseEscrita = 'comum' | 'credencial' | 'destrutiva';

export interface AlvoEscrita {
  entidade: EntidadeEscrita;
  /** Verbo da operação (`criar`, `editar`, `desativar`, `reativar`...), só para a trilha da plataforma. */
  operacao: string;
  /** uuid do registro; em criação, vem do retorno do serviço (`id`). */
  registroId?: string;
  /** Módulo opcional da entidade (D4); o núcleo (unidades, pessoas...) não declara. */
  modulo?: Modulo;
  classe: ClasseEscrita;
}

export const MENSAGEM_TRILHA_PREVIA = 'Não foi possível registrar a ação na trilha da plataforma. Nada foi alterado; tente de novo.';

/** Erro da gravação da trilha dentro da transação (distingue de erro de regra, que sai como está). */
class FalhaTrilha extends Error {
  constructor(readonly causa: unknown) { super('falha na trilha'); }
}

/** Rota sem o prefixo comum (`/api/v1/plataforma/condominios/:id`): o padrão, nunca a URL (sem query string). */
export function rotaDaLeitura(req: Request): string | null {
  const padrao = req.route?.path ? `${req.baseUrl ?? ''}${String(req.route.path)}` : null;
  return padrao ? padrao.replace(/^.*\/plataforma\/condominios\/:id/i, '') || '/' : null;
}

const statusDe = (e: unknown) => (e instanceof HttpException ? e.getStatus() : 500);
/** O Nest só aplica o @HttpCode depois do handler: criação é 201 (as rotas de criar declaram @HttpCode(201)), o resto 200. */
const statusSucesso = (alvo: { operacao: string }) => (alvo.operacao === 'criar' ? 201 : 200);

@Injectable()
export class AcessoPlataformaService {
  /** Por usuário da plataforma; poucos usuários, então o teto de chaves é folgado. */
  private readonly limiteRevelar: LimiteTaxaPublico;
  private readonly limiteEscrita: LimiteTaxaPublico;
  private readonly porDia: Record<Exclude<ClasseEscrita, 'comum'>, number>;

  constructor(
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(AuthMasterService) private readonly auth: AuthMasterService,
    @Inject(CONFIG) config: Config,
    @Inject(RELOGIO) private readonly relogio: Relogio,
  ) {
    this.limiteRevelar = new LimiteTaxaPublico(config.plataforma.revelarPorMinuto, JANELA_REVELAR_MS, 1000);
    this.limiteEscrita = new LimiteTaxaPublico(config.plataforma.escritasPorMinuto, JANELA_ESCRITA_MS, 1000);
    this.porDia = { destrutiva: config.plataforma.destrutivasPorDia, credencial: config.plataforma.credenciaisPorDia };
  }

  /** Mesmas regras de estado da leitura: ativo, suspenso e encerrado leem; `provisionando` 409; `excluido`/desconhecido 404. */
  private async paraLeitura(condominioId: string) {
    const r = await this.resolvedor.paraPlataforma(condominioId);
    if (r.tipo === 'inexistente') throw erroApi(404, 'NAO_ENCONTRADO', 'Condomínio não encontrado.');
    if (r.tipo === 'provisionando') throw erroApi(409, 'CONDOMINIO_PROVISIONANDO', 'O condomínio ainda está em provisionamento: não há dados para ler.');
    return r.condominio;
  }

  private servicosDe(c: CondominioResolvido): Servicos {
    const arvore = contextoDoJob(this.moduleRef, c);
    return (t) => this.moduleRef.resolve(t, arvore, { strict: false });
  }

  /** Leitura do Master: sem motivo, sem trilha, minimizada. Ver o cabeçalho deste arquivo. */
  async ler<T>(condominioId: string, fn: (s: Servicos) => Promise<T>): Promise<T> {
    const c = await this.paraLeitura(condominioId);
    return minimizarLeituraPlataforma(await fn(this.servicosDe(c)));
  }

  /** "Revelar" um registro: valor completo, com limite e uma linha em plataforma_audit. Ver o cabeçalho deste arquivo. */
  async revelar<T>(m: AuthMaster, req: Request, condominioId: string, alvo: { entidade: EntidadeRevelar; registroId: string },
    fn: (s: Servicos) => Promise<T>): Promise<T> {
    // 1. Limite antes de tudo (só memória): estourou, nada é lido nem gravado.
    const vez = this.limiteRevelar.consumir(m.usuario.id, this.relogio.agora().getTime());
    if (!vez.ok) {
      // O filtro de erro preserva os cabeçalhos já gravados (como no 429 dos selos públicos).
      req.res?.setHeader('Retry-After', String(vez.retryAfterSeg));
      throw erroApi(429, 'REVELACOES_EXCEDIDAS', 'Muitas revelações em pouco tempo. Aguarde e tente de novo.');
    }
    // 2. Situação do condomínio.
    const c = await this.paraLeitura(condominioId);
    // 3. A leitura, sem minimizar (é o ponto do Revelar).
    let resultado: { ok: true; valor: T } | { ok: false; erro: unknown };
    try {
      resultado = { ok: true, valor: await fn(this.servicosDe(c)) };
    } catch (erro) {
      resultado = { ok: false, erro };
    }
    // 4. A linha da plataforma, com o status de verdade (404 também), antes de qualquer valor sair.
    try {
      await registrarPlataforma(this.db, {
        masterUsuarioId: m.usuario.id, acao: 'condominio.revelar', condominioId: c.id,
        detalhes: { entidade: alvo.entidade, registro_id: alvo.registroId, rota: rotaDaLeitura(req), metodo: req.method, status: resultado.ok ? 200 : statusDe(resultado.erro), ip: m.ip },
      });
    } catch (e) {
      log('error', 'plataforma.falha_trilha_revelar', { request_id: req.requestId, condominio_id: c.id, codigo_pg: codigoPg(e), erro: e instanceof Error ? e.name : 'erro' });
      throw erroApi(503, 'TRILHA_INDISPONIVEL', MENSAGEM_TRILHA_REVELAR);
    }
    if (!resultado.ok) throw resultado.erro;
    return resultado.valor;
  }

  /** Ação do Master sobre um síndico do condomínio (§5.5). Ver o cabeçalho deste arquivo. */
  async alterarSindico(m: AuthMaster, req: Request, condominioId: string, p: ProtecaoEscrita, op: OperacaoSindico): Promise<ResultadoSindico> {
    const acao = `plataforma.${op.tipo === 'criar' ? 'usuario_criar' : `usuario_${op.tipo}`}`;
    // 1. Reautenticação antes de tudo: com a senha errada, nem o condomínio é resolvido.
    await this.auth.reautenticar(m, p.senhaMaster, { acao, condominioId });
    // 2. Só condomínio em operação recebe escrita.
    const r = await this.resolvedor.paraPlataforma(condominioId);
    if (r.tipo === 'inexistente') throw erroApi(404, 'NAO_ENCONTRADO', 'Condomínio não encontrado.');
    if (r.tipo === 'provisionando') throw erroApi(409, 'CONDOMINIO_PROVISIONANDO', 'O condomínio ainda está em provisionamento.');
    if (r.status !== 'ativo' && r.status !== 'suspenso') {
      throw erroApi(409, 'CONDOMINIO_ENCERRADO', 'Contrato encerrado: os dados do condomínio são só para leitura.');
    }
    const c = r.condominio;
    const usuarios = await this.servicosDe(c)(UsuariosService);
    const rota = rotaDaLeitura(req);
    const motivo = p.motivo.trim();

    // 3. Mudança + trilha do condomínio na mesma transação; trilha da plataforma antes do COMMIT.
    const registrar = async (tx: Tx, efeitos: EfeitoSindico[]) => {
      try {
        for (const e of efeitos) {
          await this.auditoria.registrarPlataforma(tx, {
            email: m.usuario.email, acao: `plataforma.${e.acao}`, entidade: 'usuario_sistema', registroId: e.usuario.id, ip: m.ip,
            depois: { motivo, rota, metodo: req.method, masterUsuarioId: m.usuario.id, ...e.mudou },
          });
        }
        for (const e of efeitos) {
          // Sem o motivo (texto livre que pode citar morador; a plataforma não tem redação LGPD) nem nome/login: o id do
          // usuário afetado liga esta linha à do condomínio, onde está o resto.
          await registrarPlataforma(this.db, {
            masterUsuarioId: m.usuario.id, acao: `condominio.sindico_${e.acao.replace(/^usuario_/, '')}`, condominioId: c.id,
            detalhes: { usuario_id: e.usuario.id, rota, metodo: req.method, ip: m.ip },
          });
        }
      } catch (erro) {
        throw new FalhaTrilha(erro);
      }
    };
    try {
      return await usuarios.sindicoPelaPlataforma(op, registrar);
    } catch (e) {
      if (!(e instanceof FalhaTrilha)) throw e;
      log('error', 'plataforma.falha_trilha_escrita', { request_id: req.requestId, condominio_id: c.id, codigo_pg: codigoPg(e.causa), erro: e.causa instanceof Error ? e.causa.name : 'erro' });
      throw erroApi(503, 'TRILHA_INDISPONIVEL', MENSAGEM_TRILHA_ESCRITA);
    }
  }

  // ----- Escrita comum (Fase C1) -----------------------------------------------------------------------------------

  /** Escrita do Master pelo serviço do condomínio. Ver o cabeçalho deste arquivo (ESCRITA COMUM) para a ordem. */
  async escrever<T>(m: AuthMaster, req: Request, condominioId: string, alvo: AlvoEscrita,
    fn: (s: Servicos, ctx: Contexto) => Promise<T>): Promise<T> {
    // 1. Limite por minuto antes de tudo (memória): estourou, nada é lido nem gravado.
    const vez = this.limiteEscrita.consumir(m.usuario.id, this.relogio.agora().getTime());
    if (!vez.ok) {
      req.res?.setHeader('Retry-After', String(vez.retryAfterSeg));
      throw erroApi(429, 'ESCRITAS_EXCEDIDAS', 'Muitas alterações em pouco tempo. Aguarde e tente de novo.');
    }
    // 2. Situação do condomínio e módulo da entidade.
    const c = await this.paraEscrita(condominioId);
    await this.exigirModulo(c, alvo);
    // 3. Destrutiva/credencial: limite diário durável e linha prévia fail-closed.
    if (alvo.classe !== 'comum') await this.previaDiaria(m, req, c, alvo, alvo.classe);
    // 4. e 5. Usuário técnico e o contexto da plataforma (montado só aqui).
    const ctx = await this.contextoPlataforma(m, c);
    // 6. O serviço de sempre (regras, transação, audit_log do condomínio).
    let resultado: { ok: true; valor: T } | { ok: false; erro: unknown };
    try {
      resultado = { ok: true, valor: await fn(this.servicosDe(c), ctx) };
    } catch (erro) {
      resultado = { ok: false, erro };
    }
    // 7. A linha da plataforma, com o status real. Depois do COMMIT: falhar aqui não desfaz nada nem troca a resposta.
    const criado = resultado.ok ? (resultado.valor as { id?: unknown } | null)?.id : undefined;
    try {
      await registrarPlataforma(this.db, {
        masterUsuarioId: m.usuario.id, acao: 'condominio.escrever', condominioId: c.id,
        detalhes: {
          entidade: alvo.entidade, operacao: alvo.operacao, registro_id: alvo.registroId ?? (typeof criado === 'string' ? criado : null),
          rota: rotaDaLeitura(req), metodo: req.method, status: resultado.ok ? statusSucesso(alvo) : statusDe(resultado.erro), ip: m.ip,
        },
      });
    } catch (e) {
      log('error', 'plataforma.falha_trilha_escrita', { request_id: req.requestId, condominio_id: c.id, codigo_pg: codigoPg(e), erro: e instanceof Error ? e.name : 'erro' });
    }
    if (!resultado.ok) throw resultado.erro;
    // 8. Resposta minimizada, como a leitura.
    return minimizarLeituraPlataforma(resultado.valor);
  }

  /** Só `ativo` e `suspenso` escrevem (D3). */
  private async paraEscrita(condominioId: string): Promise<CondominioResolvido> {
    const r = await this.resolvedor.paraPlataforma(condominioId);
    if (r.tipo === 'inexistente') throw erroApi(404, 'NAO_ENCONTRADO', 'Condomínio não encontrado.');
    if (r.tipo === 'provisionando') throw erroApi(409, 'CONDOMINIO_PROVISIONANDO', 'O condomínio ainda está em provisionamento.');
    if (r.status !== 'ativo' && r.status !== 'suspenso') {
      throw erroApi(409, 'CONDOMINIO_ENCERRADO', 'Contrato encerrado: os dados do condomínio são só para leitura.');
    }
    return r.condominio;
  }

  /** Módulo desligado: o síndico não vê nem corrige esse dado; o Master liga o módulo antes, se quiser (D4). */
  private async exigirModulo(c: CondominioResolvido, alvo: AlvoEscrita) {
    if (!alvo.modulo) return;
    if (!(await this.resolvedor.modulosDe(c.id)).includes(alvo.modulo)) {
      throw erroApi(409, 'MODULO_DESLIGADO', `O módulo ${ROTULO_MODULO[alvo.modulo]} está desligado neste condomínio. Ligue-o no Cadastro antes de alterar.`);
    }
  }

  /**
   * Limite diário durável (D7) e a linha prévia. A contagem e a gravação vão na mesma transação do banco plataforma, sob
   * um advisory lock por usuário: duas abas não passam juntas do limite. 0 no limite desliga a classe.
   */
  private async previaDiaria(m: AuthMaster, req: Request, c: CondominioResolvido, alvo: AlvoEscrita, classe: Exclude<ClasseEscrita, 'comum'>) {
    const maximo = this.porDia[classe];
    if (maximo === 0) {
      throw erroApi(409, 'ACAO_DESLIGADA', classe === 'destrutiva'
        ? 'Ações irreversíveis estão desligadas na plataforma (ligue o 2º fator e o limite antes).'
        : 'A emissão de credenciais está desligada na plataforma.');
    }
    const acao = `condominio.${classe}`;
    const agora = this.relogio.agora().getTime();
    const desde = new Date(agora - JANELA_DIARIA_MS);
    let espera: number | null = null;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plataforma:${acao}:${m.usuario.id}`}))`);
        const [l] = await tx.select({ n: sql<number>`count(*)::int`, primeira: sql<Date | string | null>`min(${plataformaAudit.em})` }).from(plataformaAudit)
          .where(and(eq(plataformaAudit.masterUsuarioId, m.usuario.id), eq(plataformaAudit.acao, acao), gte(plataformaAudit.em, desde)));
        if ((l?.n ?? 0) >= maximo) {
          const primeira = l?.primeira ? new Date(l.primeira).getTime() : agora;
          espera = Math.max(1, Math.ceil((primeira + JANELA_DIARIA_MS - agora) / 1000));
          return;
        }
        await registrarPlataforma(tx, {
          masterUsuarioId: m.usuario.id, acao, condominioId: c.id,
          detalhes: { entidade: alvo.entidade, operacao: alvo.operacao, registro_id: alvo.registroId ?? null, ip: m.ip },
        });
      });
    } catch (e) {
      log('error', 'plataforma.falha_trilha_previa', { request_id: req.requestId, condominio_id: c.id, codigo_pg: codigoPg(e), erro: e instanceof Error ? e.name : 'erro' });
      throw erroApi(503, 'TRILHA_INDISPONIVEL', MENSAGEM_TRILHA_PREVIA);
    }
    if (espera !== null) {
      req.res?.setHeader('Retry-After', String(espera));
      throw erroApi(429, 'LIMITE_DIARIO_EXCEDIDO', 'Limite diário desta ação atingido. Tente de novo mais tarde.');
    }
  }

  /** O ator da plataforma nos serviços do condomínio: o usuário técnico, com o e-mail do Master no nome da trilha. */
  // Sem cache do id em memória (divergência consciente do spec): um SELECT por escrita é barato e um cache ficaria
  // velho se o banco do condomínio fosse trocado sob o processo (restauração de backup, o reset do servidor de e2e).
  private async contextoPlataforma(m: AuthMaster, c: CondominioResolvido): Promise<Contexto> {
    const id = await (await this.servicosDe(c)(UsuariosService)).garantirTecnicoPlataforma(m.usuario.email, m.ip);
    return {
      ator: { id, papel: 'administracao', nome: `plataforma/${m.usuario.email}`.replace(/[\r\n\t]+/g, ' ').slice(0, 300), login: LOGIN_TECNICO_PLATAFORMA, deveTrocarSenha: false },
      sessaoId: m.sessaoId, ip: m.ip,
    };
  }
}
