// Limite de tentativas de login (spec §5.1). Três contadores por janela (padrões de config.ts, ajustáveis por ambiente):
//   - login_ip (par login+IP): 10 falhas em 15 min bloqueiam ESSE par por 15 min;
//   - ip: 30 falhas em 15 min (qualquer login) bloqueiam o IP por 15 min;
//   - login: NUNCA bloqueia; só gradua o atraso crescente da resposta de falha (com teto, atrasoMaxMs).
// Sem bloqueio só por login de propósito: os logins do seed são públicos, e um bloqueio por login deixava qualquer um
// manter o porteiro fora do sistema indefinidamente. O preço: quem tem muitos IPs ganha 10 palpites por IP (limitados
// também pelos 30 do IP e pelo limite de requisições do nginx); a política de senha é que segura esse caso.
// O IP é o de `req.ip`, que com TRUST_PROXY=2 vem do X-Forwarded-For montado por Vercel -> nginx (docs/deploy.md): se
// o TRUST_PROXY estiver errado, ou se alguém chegar direto na VPS forjando o XFF, o par e o IP passam a ser do cliente.
//
// Persistente (tabela login_limite) e não em memória: com duas réplicas, um contador por processo dobraria o limite.
// A tentativa é RESERVADA (contada) antes de verificar a senha, num UPSERT atômico: N requisições paralelas não
// conseguem N palpites, porque a (máximo+1)ª já vê o contador acima do limite. No sucesso, a reserva é desfeita.
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, or, isNull, lte, sql } from 'drizzle-orm';
import { createHmac, hkdfSync } from 'node:crypto';
import { CONFIG, type Config } from '../config/config';
import { DB, type Db, type Executor } from '../database/database.module';
import { loginLimite } from '../db/schema';
import { atrasoDaFalha } from './login-sem-condominio';
import { chavesDe, CONDOMINIO, type CondominioResolvido } from '../saas/condominio';

export type TipoLimite = 'login' | 'ip' | 'login_ip';

/** Teto do contador: smallint estoura em 32767, e o contador `login` (que não bloqueia) pode crescer sem parar numa janela. */
export const TETO_FALHAS = 10_000;

export interface ChaveLimite {
  tipo: TipoLimite;
  chave: string;
}

export interface Reserva {
  chave: ChaveLimite;
  falhas: number;
  bloqueadoAte: Date | null;
}

export const normalizarLogin = (login: string) => login.trim().toLowerCase();

@Injectable()
export class LimiteLoginService {
  private subchave?: Buffer;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
  ) {}

  private hmac(texto: string): string {
    // Subchave dedicada (HKDF) da chave HMAC do CONDOMÍNIO (SAAS-04): a chave do CPF não é usada diretamente para outro
    // fim, e o mesmo login em dois condomínios dá chaves diferentes. Calculada no primeiro uso (a subárvore "sem
    // condomínio" constrói este serviço, mas nunca chega aqui).
    this.subchave ??= Buffer.from(hkdfSync('sha256', chavesDe(this.condominio).hmacCpf, Buffer.alloc(0), 'portaria/login_limite/v1', 32));
    return createHmac('sha256', this.subchave).update(texto, 'utf8').digest('hex');
  }

  /** HMAC, não SHA puro: o login digitado pode ser um CPF, e o espaço do CPF (e do IPv4) se percorre por força bruta. */
  chave(tipo: 'login' | 'ip', valor: string): ChaveLimite {
    const v = tipo === 'login' ? normalizarLogin(valor) : valor;
    return { tipo, chave: this.hmac(`${tipo}:${v}`) };
  }

  /**
   * Par login+IP: metade do HMAC do login + metade do HMAC do par (64 hex no total, o CHECK da coluna). O prefixo
   * do login deixa a redefinição de senha zerar todos os pares do alvo sem saber os IPs (zerarLogin). Sem IP
   * (não acontece atrás do Express com trust proxy, mas o tipo permite), o par degenera no login sozinho.
   */
  chavePar(login: string, ip: string | null): ChaveLimite {
    const l = normalizarLogin(login);
    return { tipo: 'login_ip', chave: this.prefixoPar(login) + this.hmac(`login_ip:${JSON.stringify([l, ip ?? ''])}`).slice(0, 32) };
  }

  private prefixoPar(login: string) {
    return this.chave('login', login).chave.slice(0, 32);
  }

  /** Máximo de falhas na janela; `login` sozinho não tem (nunca bloqueia). */
  maximo(tipo: TipoLimite) {
    return tipo === 'login_ip' ? this.config.login.maxFalhasLogin : tipo === 'ip' ? this.config.login.maxFalhasIp : Infinity;
  }

  /**
   * Conta a tentativa. Bloqueio vigente: não mexe no contador. Janela vencida ou bloqueio já expirado: recomeça em 1.
   * Instantes do relógio da API passados como texto + cast (Date cru em `sql` livre depende do driver).
   */
  async reservar(c: ChaveLimite, agora: Date): Promise<Reserva> {
    const t = agora.toISOString();
    const janela = this.config.login.janelaMin;
    const res = (await this.db.execute(sql`
      INSERT INTO login_limite AS l (tipo, chave, falhas, janela_inicio, bloqueado_ate, atualizado_em)
      VALUES (${c.tipo}, ${c.chave}, 1, ${t}::timestamptz, NULL, ${t}::timestamptz)
      ON CONFLICT (tipo, chave) DO UPDATE SET
        falhas = CASE
          WHEN l.bloqueado_ate > ${t}::timestamptz THEN l.falhas
          WHEN l.bloqueado_ate IS NOT NULL OR l.janela_inicio <= ${t}::timestamptz - make_interval(mins => ${janela}) THEN 1
          ELSE least(l.falhas + 1, ${TETO_FALHAS}) END,
        janela_inicio = CASE
          WHEN l.bloqueado_ate > ${t}::timestamptz THEN l.janela_inicio
          WHEN l.bloqueado_ate IS NOT NULL OR l.janela_inicio <= ${t}::timestamptz - make_interval(mins => ${janela}) THEN ${t}::timestamptz
          ELSE l.janela_inicio END,
        bloqueado_ate = CASE WHEN l.bloqueado_ate > ${t}::timestamptz THEN l.bloqueado_ate ELSE NULL END,
        atualizado_em = ${t}::timestamptz
      RETURNING falhas, bloqueado_ate`)) as unknown as { rows: { falhas: number | string; bloqueado_ate: string | Date | null }[] };
    const linha = res.rows[0]!;
    return { chave: c, falhas: Number(linha.falhas), bloqueadoAte: linha.bloqueado_ate ? new Date(linha.bloqueado_ate) : null };
  }

  /**
   * Bloqueada se há bloqueio vigente ou se a tentativa passou do máximo (concorrência antes do bloqueio gravar).
   * `login` nunca: inclusive um `bloqueado_ate` deixado pela imagem anterior (antes da 0008) é ignorado.
   */
  estaBloqueada(r: Reserva, agora: Date): boolean {
    if (r.chave.tipo === 'login') return false;
    return (r.bloqueadoAte !== null && r.bloqueadoAte > agora) || r.falhas > this.maximo(r.chave.tipo);
  }

  /**
   * Depois de uma falha verificada: ao atingir o máximo, grava o bloqueio. Devolve o fim do bloqueio só se ESTA chamada
   * o criou (para o auth.bloqueio sair uma vez, mesmo com requisições concorrentes).
   */
  async bloquearSeAtingiu(r: Reserva, agora: Date): Promise<Date | null> {
    if (r.falhas < this.maximo(r.chave.tipo)) return null;
    const ate = new Date(agora.getTime() + this.bloqueioMs());
    const linhas = await this.db.update(loginLimite)
      .set({ bloqueadoAte: ate, atualizadoEm: agora })
      .where(and(eq(loginLimite.tipo, r.chave.tipo), eq(loginLimite.chave, r.chave.chave),
        or(isNull(loginLimite.bloqueadoAte), lte(loginLimite.bloqueadoAte, agora))))
      .returning({ tipo: loginLimite.tipo });
    return linhas.length ? ate : null;
  }

  /** Login com sucesso: zera os contadores do login e do par e desfaz a reserva do IP (sem zerar: outras contas no mesmo IP). */
  async sucesso(login: ChaveLimite, par: ChaveLimite, ip: ChaveLimite | null, agora: Date): Promise<void> {
    await this.zerar(this.db, login, agora);
    await this.zerar(this.db, par, agora);
    if (ip) {
      await this.db.update(loginLimite)
        .set({ falhas: sql`greatest(${loginLimite.falhas} - 1, 0)`, atualizadoEm: agora })
        .where(and(eq(loginLimite.tipo, ip.tipo), eq(loginLimite.chave, ip.chave)));
    }
  }

  /**
   * Zera o contador do login e TODOS os pares login+IP dele (prefixo da chave), sem saber os IPs. Usado pela redefinição
   * de senha (desbloqueia o alvo) e pela troca de senha, dentro da transação delas.
   */
  async zerarLogin(exec: Executor, login: string, agora: Date): Promise<void> {
    await this.zerar(exec, this.chave('login', login), agora);
    await exec.update(loginLimite)
      .set({ falhas: 0, janelaInicio: agora, bloqueadoAte: null, atualizadoEm: agora })
      .where(and(eq(loginLimite.tipo, 'login_ip'), sql`left(${loginLimite.chave}, 32) = ${this.prefixoPar(login)}`));
  }

  async zerar(exec: Executor, c: ChaveLimite, agora: Date): Promise<void> {
    await exec.update(loginLimite)
      .set({ falhas: 0, janelaInicio: agora, bloqueadoAte: null, atualizadoEm: agora })
      .where(and(eq(loginLimite.tipo, c.tipo), eq(loginLimite.chave, c.chave)));
  }

  bloqueioMs() {
    return this.config.login.bloqueioMin * 60_000;
  }

  /** Atraso crescente das falhas (pelo contador do LOGIN, de qualquer IP): base * 2^(n-1), com teto. */
  atraso(falhas: number): number {
    return atrasoDaFalha(this.config.login, falhas);
  }
}
