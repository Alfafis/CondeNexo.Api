// Gestão de usuários do sistema (spec §5.2, RNF-04): usuario.gerenciar (SI, AD); alvo ou papel "síndico" exige
// também usuario.gerenciar_sindico (só SI). Ninguém desativa, rebaixa ou redefine a si mesmo por aqui.
// Toda resposta daqui leva senhaTemporariaExpiraEm (colunasGestao): todas as rotas exigem usuario.gerenciar.
import { Inject, Injectable } from '@nestjs/common';
import { pode, type Acao } from '../dominio/rbac';
import { SENHA_TEMPORARIA_VALIDADE_MS } from '../dominio/rules';
import type { Papel } from '../dominio/types';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { colunasGestao, paraGestao, type UsuarioGerenciado } from '../auth/auth.service';
import { LimiteLoginService } from '../auth/limite-login.service';
import { SenhaService } from '../auth/senha.service';
import { SessaoService } from '../auth/sessao.service';
import type { Contexto } from '../auth/tipos';
import { AcessoNegado, codigoPg, erroApi } from '../comum/erros';
import { codificarCursor, decodificarCursor, Pagina, type Paginacao } from '../comum/pagina';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db, type Tx } from '../database/database.module';
import { usuarioSistema } from '../db/schema';

type Alvo = Awaited<ReturnType<UsuariosService['travarAlvo']>>;

/** Ações do app do Master sobre síndicos (docs/05_arquitetura_saas.md §5.5). */
export type OperacaoSindico =
  | { tipo: 'criar'; nome: string; login: string }
  | { tipo: 'trocar'; id: string; nome: string; login: string }
  | { tipo: 'redefinir_senha'; id: string }
  | { tipo: 'desativar'; id: string }
  | { tipo: 'reativar'; id: string };

/**
 * Um usuário afetado por uma ação do Master: vira UMA linha `plataforma.usuario_<acao>` no audit_log do condomínio (a
 * troca afeta dois: o novo, que `entrou`, e o antigo, que `saiu`). `mudou` vai para o `depois` da linha: nunca hash nem
 * senha (o snapshot da auditoria ainda remove qualquer chave de senha, por garantia).
 */
export interface EfeitoSindico {
  acao: 'usuario_criar' | 'usuario_trocar' | 'usuario_redefinir_senha' | 'usuario_desativar' | 'usuario_reativar';
  usuario: UsuarioGerenciado;
  mudou: Record<string, unknown>;
}

export interface ResultadoSindico {
  usuario: UsuarioGerenciado;
  /** Na troca: o síndico que saiu. */
  substituido?: UsuarioGerenciado;
  /** Criar, trocar e nova senha: sai UMA vez nesta resposta, nunca gravada em claro. */
  senhaTemporaria?: string;
  expiraEm?: string;
}

const ehSindico = (u: { papel: Papel }) => u.papel === 'sindico';

/** Chave do cursor = chave de ordenação (nome, id) do último item: estável mesmo com inserção concorrente. */
const CursorUsuarios = z.strictObject({ n: z.string(), i: z.uuid() });

@Injectable()
export class UsuariosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(SenhaService) private readonly senhas: SenhaService,
    @Inject(SessaoService) private readonly sessoes: SessaoService,
    @Inject(LimiteLoginService) private readonly limite: LimiteLoginService,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * O guard decidiu com o papel lido no início da requisição. Dentro da transação, o ator é relido com FOR UPDATE:
   * fecha a janela em que ele foi desativado ou rebaixado nesse meio tempo, e serializa ações cruzadas (dois
   * síndicos desativando um ao outro: um deles recebe deadlock e nenhum sistema fica sem síndico ativo).
   */
  private async revalidarAtor(tx: Tx, ctx: Contexto, acao: Acao) {
    const [eu] = await tx.select({ papel: usuarioSistema.papel, ativo: usuarioSistema.ativo }).from(usuarioSistema)
      .where(eq(usuarioSistema.id, ctx.ator.id)).for('update');
    if (!eu?.ativo || !pode(eu.papel, acao)) throw new AcessoNegado(acao);
    return eu.papel;
  }

  private async travarAlvo(tx: Tx, id: string) {
    const [x] = await tx.select(colunasGestao).from(usuarioSistema).where(eq(usuarioSistema.id, id)).for('update');
    if (!x) throw erroApi(404, 'USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado.');
    return x;
  }

  /** Administração não mexe em síndico (spec §5.2). */
  private exigirGestaoDeSindico(papelAtor: Papel, alvoOuNovo: Papel[]) {
    if (alvoOuNovo.includes('sindico') && !pode(papelAtor, 'usuario.gerenciar_sindico')) {
      throw new AcessoNegado('usuario.gerenciar_sindico', 'Só o síndico gerencia usuários com o papel de síndico.');
    }
  }

  private naoSiMesmo(ctx: Contexto, id: string, codigo: string, mensagem: string) {
    if (ctx.ator.id === id) throw erroApi(422, codigo, mensagem);
  }

  async listar(p: Paginacao): Promise<Pagina<UsuarioGerenciado>> {
    const depois = p.cursor ? decodificarCursor(p.cursor, CursorUsuarios) : null;
    const linhas = await this.db.select(colunasGestao).from(usuarioSistema)
      .where(depois ? sql`(${usuarioSistema.nome}, ${usuarioSistema.id}) > (${depois.n}, ${depois.i}::uuid)` : undefined)
      .orderBy(asc(usuarioSistema.nome), asc(usuarioSistema.id))
      .limit(p.limite + 1); // um a mais: diz se há próxima página sem COUNT
    const pagina = linhas.slice(0, p.limite);
    const ultimo = pagina[pagina.length - 1];
    const proximo = linhas.length > p.limite && ultimo ? codificarCursor({ n: ultimo.nome, i: ultimo.id }) : null;
    return new Pagina(pagina.map((u) => paraGestao(u, this.relogio.agora())), proximo);
  }

  async criar(ctx: Contexto, i: { nome: string; login: string; papel: Papel }) {
    this.exigirGestaoDeSindico(ctx.ator.papel, [i.papel]);
    const senhaTemporaria = this.senhas.gerarTemporaria();
    const senhaHash = await this.senhas.gerarHash(senhaTemporaria); // fora da transação
    const agora = this.relogio.agora();
    const senhaTemporariaExpiraEm = new Date(agora.getTime() + SENHA_TEMPORARIA_VALIDADE_MS);
    try {
      const usuario = await this.db.transaction(async (tx) => {
        const papelAtor = await this.revalidarAtor(tx, ctx, 'usuario.gerenciar');
        this.exigirGestaoDeSindico(papelAtor, [i.papel]);
        const [novo] = await tx.insert(usuarioSistema).values({
          nome: i.nome, login: i.login, papel: i.papel, senhaHash, deveTrocarSenha: true, senhaTemporariaExpiraEm,
          criadoEm: agora, atualizadoEm: agora,
        }).returning(colunasGestao);
        await this.auditoria.registrar(tx, {
          ator: ctx.ator, acao: 'usuario.criar', entidade: 'usuario_sistema', registroId: novo!.id, ip: ctx.ip, depois: novo,
        });
        return novo!;
      });
      return { usuario: paraGestao(usuario, this.relogio.agora()), senhaTemporaria };
    } catch (e) {
      // Aqui a transação já terminou (rollback): traduzir o erro não depende de consultar o banco.
      if (codigoPg(e) === '23505') throw erroApi(409, 'LOGIN_EXISTENTE', 'Já existe um usuário com este login.');
      throw e;
    }
  }

  /** Escrita padrão sobre um alvo: revalida o ator, trava o alvo, aplica `fn` e audita antes/depois. */
  private async alterar(
    ctx: Contexto, id: string, acaoAuditoria: string, novoPapel: Papel | null,
    fn: (tx: Tx, alvo: Alvo, agora: Date) => Promise<Alvo | null>,
  ) {
    const agora = this.relogio.agora();
    return this.db.transaction(async (tx) => {
      const papelAtor = await this.revalidarAtor(tx, ctx, 'usuario.gerenciar');
      const antes = await this.travarAlvo(tx, id);
      this.exigirGestaoDeSindico(papelAtor, novoPapel ? [antes.papel, novoPapel] : [antes.papel]);
      const depois = await fn(tx, antes, agora);
      if (!depois) return paraGestao(antes, this.relogio.agora()); // nada mudou: sem linha de auditoria
      await this.auditoria.registrar(tx, {
        ator: ctx.ator, acao: acaoAuditoria, entidade: 'usuario_sistema', registroId: id, ip: ctx.ip, antes, depois,
      });
      return paraGestao(depois, this.relogio.agora());
    });
  }

  desativar(ctx: Contexto, id: string) {
    this.naoSiMesmo(ctx, id, 'AUTO_DESATIVACAO', 'Você não pode desativar o próprio usuário.');
    return this.alterar(ctx, id, 'usuario.desativar', null, async (tx, alvo, agora) => {
      if (!alvo.ativo) return null;
      // desativado_em: fato gerador da retenção do operador ("enquanto ativo + 3 anos", 0007).
      const [d] = await tx.update(usuarioSistema).set({ ativo: false, desativadoEm: agora, atualizadoEm: agora }).where(eq(usuarioSistema.id, id)).returning(colunasGestao);
      // Desativar derruba as sessões abertas na mesma transação (o guard também recusa usuário inativo).
      await this.sessoes.revogarDoUsuario(tx, id, 'desativacao', agora);
      return d!;
    });
  }

  reativar(ctx: Contexto, id: string) {
    return this.alterar(ctx, id, 'usuario.reativar', null, async (tx, alvo, agora) => {
      if (alvo.ativo) return null;
      // Operador anonimizado pela retenção não volta: nome e login são genéricos (cadastre um usuário novo).
      const [r] = await tx.select({ anonimizadoEm: usuarioSistema.anonimizadoEm }).from(usuarioSistema).where(eq(usuarioSistema.id, id));
      if (r?.anonimizadoEm) throw erroApi(409, 'USUARIO_ANONIMIZADO', 'Usuário anonimizado pela retenção (LGPD) não pode ser reativado. Cadastre um usuário novo.');
      const [d] = await tx.update(usuarioSistema).set({ ativo: true, desativadoEm: null, atualizadoEm: agora }).where(eq(usuarioSistema.id, id)).returning(colunasGestao);
      return d!;
    });
  }

  alterarPapel(ctx: Contexto, id: string, papel: Papel) {
    this.naoSiMesmo(ctx, id, 'AUTO_ALTERACAO_PAPEL', 'Ninguém altera o próprio papel.');
    this.exigirGestaoDeSindico(ctx.ator.papel, [papel]);
    return this.alterar(ctx, id, 'usuario.alterar_papel', papel, async (tx, alvo, agora) => {
      if (alvo.papel === papel) return null;
      // O papel é lido a cada requisição pelo SessaoGuard: a mudança vale já na próxima, sem revogar sessão.
      const [d] = await tx.update(usuarioSistema).set({ papel, atualizadoEm: agora }).where(eq(usuarioSistema.id, id)).returning(colunasGestao);
      return d!;
    });
  }

  async redefinirSenha(ctx: Contexto, id: string) {
    this.naoSiMesmo(ctx, id, 'AUTO_REDEFINICAO', 'Para mudar a própria senha, use "trocar senha".');
    const senhaTemporaria = this.senhas.gerarTemporaria();
    const senhaHash = await this.senhas.gerarHash(senhaTemporaria);
    const usuario = await this.alterar(ctx, id, 'usuario.redefinir_senha', null, async (tx, alvo, agora) => {
      // Nova temporária, novo prazo de 72 h (a redefinição é também o jeito de renovar uma temporária vencida).
      const senhaTemporariaExpiraEm = new Date(agora.getTime() + SENHA_TEMPORARIA_VALIDADE_MS);
      const [d] = await tx.update(usuarioSistema)
        .set({ senhaHash, deveTrocarSenha: true, senhaTemporariaExpiraEm, senhaAlteradaEm: agora, atualizadoEm: agora })
        .where(eq(usuarioSistema.id, id)).returning(colunasGestao);
      await this.sessoes.revogarDoUsuario(tx, id, 'redefinicao_senha', agora);
      await this.limite.zerarLogin(tx, alvo.login, agora); // desbloqueia o alvo em todos os IPs
      return d!;
    });
    return { usuario, senhaTemporaria };
  }

  /** Síndicos do condomínio (ativos e desativados), para a aba "Síndicos" do app do Master. Sem nada de senha. */
  async sindicos(): Promise<UsuarioGerenciado[]> {
    const l = await this.db.select(colunasGestao).from(usuarioSistema).where(eq(usuarioSistema.papel, 'sindico'))
      .orderBy(asc(usuarioSistema.nome), asc(usuarioSistema.id));
    return l.map((u) => paraGestao(u, this.relogio.agora()));
  }

  /**
   * Ação do app do Master sobre um síndico (§5.5). O ator NÃO é usuário do condomínio (SAAS-07): quem decide se ele
   * pode é a guarda da plataforma (`condominio.sindicos`) e a reautenticação, feitas antes. Aqui, numa transação do
   * banco do condomínio: trava TODOS os síndicos (ordem por id: serializa ações concorrentes sobre síndicos e protege a
   * regra do "último síndico ativo"), confere o alvo, aplica a mudança e chama `registrar(tx, efeitos)`, que grava a trilha
   * (audit_log nesta `tx` e plataforma_audit). Falhou `registrar`: rollback e nada muda.
   */
  async sindicoPelaPlataforma(op: OperacaoSindico, registrar: (tx: Tx, efeitos: EfeitoSindico[]) => Promise<void>): Promise<ResultadoSindico> {
    const comSenha = op.tipo === 'criar' || op.tipo === 'trocar' || op.tipo === 'redefinir_senha';
    const senhaTemporaria = comSenha ? this.senhas.gerarTemporaria() : undefined;
    const senhaHash = senhaTemporaria ? await this.senhas.gerarHash(senhaTemporaria) : undefined; // fora da transação
    const agora = this.relogio.agora();
    const expira = new Date(agora.getTime() + SENHA_TEMPORARIA_VALIDADE_MS);
    const comoTemporaria = { senhaHash: senhaHash!, deveTrocarSenha: true, senhaTemporariaExpiraEm: expira, senhaAlteradaEm: agora, atualizadoEm: agora };
    try {
      const r = await this.db.transaction(async (tx) => {
        const sindicos = await tx.select(colunasGestao).from(usuarioSistema).where(eq(usuarioSistema.papel, 'sindico'))
          .orderBy(asc(usuarioSistema.id)).for('update');
        let alvo: Alvo | undefined;
        if (op.tipo !== 'criar') {
          alvo = sindicos.find((x) => x.id === op.id);
          if (!alvo) {
            // Não é síndico (ou não existe): o Master só age sobre síndicos.
            const [x] = await tx.select({ papel: usuarioSistema.papel }).from(usuarioSistema).where(eq(usuarioSistema.id, op.id));
            if (!x) throw erroApi(404, 'USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado.');
            throw erroApi(422, 'USUARIO_NAO_SINDICO', 'A plataforma só age sobre usuários com o papel de síndico.');
          }
        }
        const novoSindico = async (nome: string, login: string) => {
          const [novo] = await tx.insert(usuarioSistema).values({
            nome, login, papel: 'sindico', ...comoTemporaria, senhaAlteradaEm: null, criadoEm: agora,
          }).returning(colunasGestao);
          return novo!;
        };
        const desativar = async (a: Alvo) => {
          const [d] = await tx.update(usuarioSistema).set({ ativo: false, desativadoEm: agora, atualizadoEm: agora })
            .where(eq(usuarioSistema.id, a.id)).returning(colunasGestao);
          return { usuario: d!, sessoesRevogadas: await this.sessoes.revogarDoUsuario(tx, a.id, 'desativacao', agora) };
        };
        const quem = (u: Alvo) => ({ nome: u.nome, login: u.login, papel: u.papel });

        let res: ResultadoSindico;
        let efeitos: EfeitoSindico[];
        switch (op.tipo) {
          case 'criar': {
            const novo = await novoSindico(op.nome, op.login);
            res = { usuario: paraGestao(novo, this.relogio.agora()) };
            efeitos = [{ acao: 'usuario_criar', usuario: res.usuario, mudou: { usuario: quem(novo), ativo: true, deve_trocar_senha: true } }];
            break;
          }
          case 'trocar': {
            if (!alvo!.ativo) throw erroApi(422, 'SINDICO_DESATIVADO', 'Este síndico já está desativado: use "Adicionar síndico" ou "Reativar".');
            const novo = await novoSindico(op.nome, op.login);
            const saiu = await desativar(alvo!);
            res = { usuario: paraGestao(novo, this.relogio.agora()), substituido: paraGestao(saiu.usuario, this.relogio.agora()) };
            efeitos = [
              { acao: 'usuario_trocar', usuario: res.usuario, mudou: { troca: 'entrou', usuario: quem(novo), substitui_usuario_id: alvo!.id, ativo: true, deve_trocar_senha: true } },
              { acao: 'usuario_trocar', usuario: res.substituido!, mudou: { troca: 'saiu', usuario: quem(alvo!), substituido_por_usuario_id: novo.id, ativo: { antes: true, depois: false }, sessoes_revogadas: saiu.sessoesRevogadas } },
            ];
            break;
          }
          case 'redefinir_senha': {
            if (!alvo!.ativo) throw erroApi(422, 'USUARIO_DESATIVADO', 'Usuário desativado: reative antes de gerar uma nova senha.');
            const [d] = await tx.update(usuarioSistema).set(comoTemporaria).where(eq(usuarioSistema.id, alvo!.id)).returning(colunasGestao);
            const revogadas = await this.sessoes.revogarDoUsuario(tx, alvo!.id, 'redefinicao_senha', agora);
            await this.limite.zerarLogin(tx, alvo!.login, agora); // desbloqueia o alvo em todos os IPs, como a tela de Usuários
            res = { usuario: paraGestao(d!, this.relogio.agora()) };
            efeitos = [{ acao: 'usuario_redefinir_senha', usuario: res.usuario, mudou: { usuario: quem(alvo!), deve_trocar_senha: true, senha_temporaria_expira_em: expira, sessoes_revogadas: revogadas } }];
            break;
          }
          case 'desativar': {
            if (!alvo!.ativo) throw erroApi(422, 'USUARIO_JA_DESATIVADO', 'Este síndico já está desativado.');
            if (!sindicos.some((x) => x.ativo && x.id !== alvo!.id)) {
              throw erroApi(422, 'ULTIMO_SINDICO_ATIVO', 'É o único síndico ativo do condomínio. Para substituí-lo, use "Trocar".');
            }
            const saiu = await desativar(alvo!);
            res = { usuario: paraGestao(saiu.usuario, this.relogio.agora()) };
            efeitos = [{ acao: 'usuario_desativar', usuario: res.usuario, mudou: { usuario: quem(alvo!), ativo: { antes: true, depois: false }, sessoes_revogadas: saiu.sessoesRevogadas } }];
            break;
          }
          case 'reativar': {
            if (alvo!.ativo) throw erroApi(422, 'USUARIO_JA_ATIVO', 'Este síndico já está ativo.');
            const [x] = await tx.select({ anonimizadoEm: usuarioSistema.anonimizadoEm }).from(usuarioSistema).where(eq(usuarioSistema.id, alvo!.id));
            if (x?.anonimizadoEm) throw erroApi(409, 'USUARIO_ANONIMIZADO', 'Usuário anonimizado pela retenção (LGPD) não pode ser reativado. Adicione um síndico novo.');
            const [d] = await tx.update(usuarioSistema).set({ ativo: true, desativadoEm: null, atualizadoEm: agora })
              .where(eq(usuarioSistema.id, alvo!.id)).returning(colunasGestao);
            res = { usuario: paraGestao(d!, this.relogio.agora()) };
            efeitos = [{ acao: 'usuario_reativar', usuario: res.usuario, mudou: { usuario: quem(alvo!), ativo: { antes: false, depois: true } } }];
            break;
          }
        }
        if (efeitos.some((e) => !ehSindico(e.usuario))) throw new Error('ação do Master sobre usuário que não é síndico'); // defesa
        await registrar(tx, efeitos);
        return res;
      });
      return senhaTemporaria ? { ...r, senhaTemporaria, expiraEm: expira.toISOString() } : r;
    } catch (e) {
      // A transação já terminou (rollback): traduzir não consulta o banco.
      if (codigoPg(e) === '23505') {
        throw erroApi(409, 'LOGIN_EXISTENTE', 'Já existe um usuário com este login.', [{ field: 'login', message: 'Já existe um usuário com este login.' }]);
      }
      throw e;
    }
  }
}
