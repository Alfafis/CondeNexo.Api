// Leitura dos dados de um condomínio pelo app do Master (docs/05_arquitetura_saas.md SAAS-09, F5 entrega 2). PONTO ÚNICO:
// é o único lugar de src/plataforma que obtém a subárvore de injeção de um condomínio (teste de arquitetura em
// test/master-leitura.test.ts). Para cada requisição de /plataforma/condominios/:id/...:
//
//   0. exige o motivo vigente (`X-Motivo-Token`, motivo-leitura.ts) ANTES de qualquer outra coisa: sem ele, 403
//      `MOTIVO_NECESSARIO` e nada é resolvido nem lido;
//   1. resolve o condomínio (ativo, suspenso ou encerrado; `provisionando` 409; `excluido` ou desconhecido 404);
//   2. obtém a subárvore durável dele, a MESMA das requisições do condomínio e dos jobs (`contextoDoJob`): os serviços
//      leem pelo pool `app_rw` daquele banco. O `app_plataforma` continua sem CONNECT nos bancos de condomínio;
//   3. chama o serviço existente (as mesmas views e máscaras que o síndico recebe) e minimiza a resposta: nome de
//      terceiro mascarado, texto livre oculto, placa mascarada (minimizacao.ts; o caminho do síndico não muda);
//   4. grava UMA linha no `audit_log` DAQUELE condomínio (`plataforma.ler` ou `plataforma.exportar`, quem =
//      `plataforma/<e-mail>`, `depois = { rota, metodo, status, master_usuario_id, motivo: { categoria, texto } }`, sem corpo nem filtros) e uma
//      em `plataforma_audit` (sem dado de morador nem id de registro do condomínio; do motivo, só a `categoria`);
//   5. só então devolve o dado. Falhou qualquer das duas gravações: 503 e o dado não sai.
//
// A linha é gravada DEPOIS da leitura e ANTES da resposta, para levar o status de verdade (200, 404...). As duas
// gravações estão em bancos diferentes, sem transação comum: se a do condomínio entra e a da plataforma falha, fica a do
// condomínio (o controle externo, visto pelo síndico) e o Master recebe 503. Leitura que falha (404 de um id
// inexistente) também é registrada, com o status.
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
// plataforma gravada (a plataforma registraria uma ação que não aconteceu: sobra registro, nunca falta).
import { HttpException, Inject, Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Tx } from '../database/database.module';
import { type EfeitoSindico, type OperacaoSindico, type ResultadoSindico, UsuariosService } from '../usuarios/usuarios.service';
import { AuthMasterService } from './auth-master.service';
import { codigoPg, erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { DB, type Db } from '../database/database.module';
import { contextoDoJob } from '../tenancy/contexto';
import { type DbPlataforma, PLATAFORMA_DB } from '../plataforma/plataforma-db';
import { ResolvedorCondominio } from '../tenancy/resolvedor';
import { minimizarLeituraPlataforma } from './minimizacao';
import { CABECALHO_MOTIVO, type MotivoLeitura, MotivoLeituraService } from './motivo-leitura';
import type { AuthMaster } from './tipos';
import { registrarPlataforma } from './trilha-plataforma';

/** O que foi lido: a entidade (nome da tabela) e, quando a rota é de um registro, o id dele. */
export interface AlvoLeitura {
  entidade: string;
  registroId?: string | null;
  /** Download, CSV, JSONL ou anexo: `plataforma.exportar` em vez de `plataforma.ler`. */
  exportar?: boolean;
}

/** Serviço resolvido na subárvore do condomínio lido. */
export type Servicos = <T>(token: Type<T>) => Promise<T>;

export const MENSAGEM_TRILHA_INDISPONIVEL = 'Não foi possível registrar a consulta na trilha do condomínio. Nada foi mostrado; tente de novo.';
export const MENSAGEM_TRILHA_MOTIVO = 'Não foi possível registrar o motivo na trilha da plataforma. Tente de novo.';
/** Uma mensagem só, qualquer que seja a causa (sem token, vencido, de outra sessão, de outro condomínio, adulterado). */
export const MENSAGEM_MOTIVO_NECESSARIO = 'Informe o motivo da consulta a este condomínio para continuar.';
export const MENSAGEM_TRILHA_ESCRITA = 'Não foi possível registrar a ação na trilha do condomínio. Nada foi alterado; tente de novo.';

/** O que acompanha toda escrita do Master: motivo (vai para a trilha) e a senha dele (só verificada, nunca gravada). */
export interface ProtecaoEscrita { motivo: string; senhaMaster: string }

/** Erro da gravação da trilha dentro da transação (distingue de erro de regra, que sai como está). */
class FalhaTrilha extends Error {
  constructor(readonly causa: unknown) { super('falha na trilha'); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rota sem o prefixo comum (`/api/v1/plataforma/condominios/:id`): o padrão, nunca a URL (sem query string). */
export function rotaDaLeitura(req: Request): string | null {
  const padrao = req.route?.path ? `${req.baseUrl ?? ''}${String(req.route.path)}` : null;
  return padrao ? padrao.replace(/^.*\/plataforma\/condominios\/:id/i, '') || '/' : null;
}

const statusDe = (e: unknown) => (e instanceof HttpException ? e.getStatus() : 500);

@Injectable()
export class AcessoPlataformaService {
  constructor(
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(AuthMasterService) private readonly auth: AuthMasterService,
    @Inject(MotivoLeituraService) private readonly motivos: MotivoLeituraService,
  ) {}

  /** Mesmas regras de estado da leitura: ativo, suspenso e encerrado leem; `provisionando` 409; `excluido`/desconhecido 404. */
  private async paraLeitura(condominioId: string) {
    const r = await this.resolvedor.paraPlataforma(condominioId);
    if (r.tipo === 'inexistente') throw erroApi(404, 'NAO_ENCONTRADO', 'Condomínio não encontrado.');
    if (r.tipo === 'provisionando') throw erroApi(409, 'CONDOMINIO_PROVISIONANDO', 'O condomínio ainda está em provisionamento: não há dados para ler.');
    return r.condominio;
  }

  /**
   * POST /plataforma/condominios/:id/motivo: emite o token do motivo (30 min, esta sessão, este condomínio). A linha
   * `condominio.motivo` da plataforma_audit leva só a categoria; o texto vai no token e, a cada leitura, para o audit_log
   * do condomínio. Falhou a trilha: 503 e o token não sai.
   */
  async emitirMotivo(m: AuthMaster, req: Request, condominioId: string, motivo: MotivoLeitura): Promise<{ token: string; expiraEm: Date }> {
    const c = await this.paraLeitura(condominioId);
    const emitido = this.motivos.emitir(m.sessaoId, c.id, motivo);
    try {
      await registrarPlataforma(this.db, {
        masterUsuarioId: m.usuario.id, acao: 'condominio.motivo', condominioId: c.id,
        detalhes: { categoria: motivo.categoria, rota: rotaDaLeitura(req), metodo: req.method, ip: m.ip },
      });
    } catch (e) {
      log('error', 'plataforma.falha_trilha_motivo', { request_id: req.requestId, condominio_id: c.id, codigo_pg: codigoPg(e), erro: e instanceof Error ? e.name : 'erro' });
      throw erroApi(503, 'TRILHA_INDISPONIVEL', MENSAGEM_TRILHA_MOTIVO);
    }
    return emitido;
  }

  async ler<T>(m: AuthMaster, req: Request, condominioId: string, alvo: AlvoLeitura, fn: (s: Servicos) => Promise<T>): Promise<T> {
    // 0. Motivo vigente antes de tudo (só criptografia, nenhum banco). A causa da recusa não sai na resposta.
    const motivo = this.motivos.validar(req.headers[CABECALHO_MOTIVO], m.sessaoId, condominioId);
    if (!motivo) throw erroApi(403, 'MOTIVO_NECESSARIO', MENSAGEM_MOTIVO_NECESSARIO);
    const c = await this.paraLeitura(condominioId);
    const arvore = contextoDoJob(this.moduleRef, c);
    const servico: Servicos = (t) => this.moduleRef.resolve(t, arvore, { strict: false });

    let resultado: { ok: true; valor: T } | { ok: false; erro: unknown };
    try {
      // Minimiza aqui, antes da trilha: se falhar, a linha leva o status do erro e nada sai.
      resultado = { ok: true, valor: minimizarLeituraPlataforma(await fn(servico)) };
    } catch (erro) {
      resultado = { ok: false, erro };
    }

    const exportar = !!alvo.exportar;
    const rota = rotaDaLeitura(req);
    const status = resultado.ok ? 200 : statusDe(resultado.erro);
    const registroId = alvo.registroId && UUID.test(alvo.registroId) ? alvo.registroId : null;
    try {
      const dbCondominio = await servico<Db>(DB as unknown as Type<Db>);
      await this.auditoria.registrarPlataforma(dbCondominio, {
        email: m.usuario.email, acao: exportar ? 'plataforma.exportar' : 'plataforma.ler', entidade: alvo.entidade, registroId,
        ip: m.ip, depois: { rota, metodo: req.method, status, masterUsuarioId: m.usuario.id, motivo: { categoria: motivo.categoria, texto: motivo.texto } },
      });
      await registrarPlataforma(this.db, {
        masterUsuarioId: m.usuario.id, acao: exportar ? 'condominio.exportar' : 'condominio.ler', condominioId: c.id,
        // Só a categoria do motivo: o texto livre pode citar morador (a plataforma não tem redação LGPD).
        detalhes: { entidade: alvo.entidade, rota, metodo: req.method, status, ip: m.ip, categoria: motivo.categoria },
      });
    } catch (e) {
      log('error', 'plataforma.falha_trilha_leitura', { request_id: req.requestId, condominio_id: c.id, codigo_pg: codigoPg(e), erro: e instanceof Error ? e.name : 'erro' });
      throw erroApi(503, 'TRILHA_INDISPONIVEL', MENSAGEM_TRILHA_INDISPONIVEL);
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
    const arvore = contextoDoJob(this.moduleRef, c);
    const usuarios = await this.moduleRef.resolve(UsuariosService, arvore, { strict: false });
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
}
