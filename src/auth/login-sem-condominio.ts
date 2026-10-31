// Login sem condomínio resolvido (código do condomínio inexistente, fora de ativo/suspenso, ou transição desligada).
// Não há banco onde contar a tentativa, mas a resposta tem de ser INDISTINGUÍVEL da de um condomínio existente com
// login inexistente (senão o código do login vira oráculo de "quem é cliente", SAAS-05): mesmo argon2 (fictício), mesmo
// atraso crescente pelo número de falhas do LOGIN, mesmo bloqueio (429 com Retry-After) ao passar do máximo pelo par
// login+IP ou pelo IP (o login sozinho nunca bloqueia), com os mesmos parâmetros (config.login). Por isso o contador
// abaixo é o algoritmo de
// limite-login.service.ts (reservar / estaBloqueada / bloquearSeAtingiu) em memória, por processo.
//
// Memória: no máximo MAX_CHAVES chaves; cheio, descarta as de janela vencida e sem bloqueio; ainda cheio, recomeça do
// zero (quem enche o mapa paga um argon2 por chave nova, e o pior caso é zerar contadores, não bloquear inocentes).
import { Inject, Injectable } from '@nestjs/common';
import { setTimeout as esperar } from 'node:timers/promises';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { CONFIG, type Config } from '../config/config';
import { normalizarLogin, TETO_FALHAS } from './limite-login.service';
import { SenhaService } from './senha.service';

/** A espera do atraso crescente, num ponto só (os testes a observam para comparar os dois caminhos). */
@Injectable()
export class EsperaLogin {
  async esperar(ms: number): Promise<void> {
    if (ms > 0) await esperar(ms);
  }
}

/** Atraso crescente das falhas: base * 2^(n-1), com teto (o mesmo de LimiteLoginService.atraso). */
export function atrasoDaFalha(c: Config['login'], falhas: number): number {
  if (c.atrasoBaseMs <= 0) return 0;
  return Math.min(c.atrasoMaxMs, c.atrasoBaseMs * 2 ** Math.max(0, falhas - 1));
}

interface Contador { falhas: number; janelaInicio: number; bloqueadoAte: number | null }
type Tipo = 'login' | 'ip' | 'login_ip';

const MAX_CHAVES = 20_000;

export type ResultadoSemCondominio = { motivo: 'credenciais' } | { motivo: 'bloqueado'; ate: Date };

@Injectable()
export class LoginSemCondominio {
  private readonly contadores = new Map<string, Contador>();

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(SenhaService) private readonly senhas: SenhaService,
    @Inject(EsperaLogin) private readonly espera: EsperaLogin,
  ) {}

  /** O mesmo de LimiteLoginService.maximo: `login` sozinho nunca bloqueia. */
  private maximo(t: Tipo) { return t === 'login_ip' ? this.config.login.maxFalhasLogin : t === 'ip' ? this.config.login.maxFalhasIp : Infinity; }
  private bloqueioMs() { return this.config.login.bloqueioMin * 60_000; }

  private abrirEspaco(agora: number) {
    if (this.contadores.size < MAX_CHAVES) return;
    const janela = this.config.login.janelaMin * 60_000;
    for (const [k, c] of this.contadores) if ((c.bloqueadoAte ?? 0) <= agora && c.janelaInicio <= agora - janela) this.contadores.delete(k);
    if (this.contadores.size >= MAX_CHAVES) this.contadores.clear();
  }

  /** Mesma regra do UPSERT de LimiteLoginService.reservar. */
  private reservar(chave: string, agora: number): Contador {
    const janela = this.config.login.janelaMin * 60_000;
    let c = this.contadores.get(chave);
    if (!c) {
      this.abrirEspaco(agora);
      c = { falhas: 1, janelaInicio: agora, bloqueadoAte: null };
      this.contadores.set(chave, c);
    } else if (c.bloqueadoAte !== null && c.bloqueadoAte > agora) {
      // bloqueio vigente: não mexe
    } else if (c.bloqueadoAte !== null || c.janelaInicio <= agora - janela) {
      c.falhas = 1; c.janelaInicio = agora; c.bloqueadoAte = null;
    } else {
      c.falhas = Math.min(c.falhas + 1, TETO_FALHAS);
    }
    return c;
  }

  private bloqueada(t: Tipo, c: Contador, agora: number) {
    if (t === 'login') return false;
    return (c.bloqueadoAte !== null && c.bloqueadoAte > agora) || c.falhas > this.maximo(t);
  }

  async tentar(login: string, senha: string, ip: string | null): Promise<ResultadoSemCondominio> {
    const agora = this.relogio.agora().getTime();
    const l = normalizarLogin(login);
    const reservas: [Tipo, Contador][] = [
      ['login', this.reservar(`login:${l}`, agora)],
      ['login_ip', this.reservar(`login_ip:${JSON.stringify([l, ip ?? ''])}`, agora)],
    ];
    if (ip) reservas.push(['ip', this.reservar(`ip:${ip}`, agora)]);
    if (reservas.some(([t, c]) => this.bloqueada(t, c, agora))) {
      const fins = reservas.map(([, c]) => c.bloqueadoAte).filter((x): x is number => x !== null && x > agora);
      return { motivo: 'bloqueado', ate: new Date(fins.length ? Math.max(...fins) : agora + this.bloqueioMs()) };
    }
    await this.senhas.verificarFicticio(senha);
    for (const [t, c] of reservas) {
      if (t !== 'login' && c.falhas >= this.maximo(t) && (c.bloqueadoAte === null || c.bloqueadoAte <= agora)) c.bloqueadoAte = agora + this.bloqueioMs();
    }
    await this.espera.esperar(atrasoDaFalha(this.config.login, reservas[0]![1].falhas));
    return { motivo: 'credenciais' };
  }
}
