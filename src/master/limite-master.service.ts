// Limite de tentativas do login do Master (docs/05_arquitetura_saas.md SAAS-08: "limite próprio, no banco plataforma").
// MESMO algoritmo do condomínio (auth/limite-login.service.ts, migração 0008), na tabela `plataforma_login_limite`:
//   - master_ip (par login+IP): config.login.maxFalhasLogin falhas na janela bloqueiam ESSE par;
//   - ip: config.login.maxFalhasIp falhas bloqueiam o IP;
//   - master (login sozinho): nunca bloqueia, só gradua o atraso (senão quem souber o e-mail do Master o tranca fora).
// Reserva ANTES de verificar senha e código, num UPSERT atômico (requisições paralelas não ganham palpites extras).
// Chaves: HMAC com subchave HKDF da chave mestra (o e-mail e o IP não vão em claro para a tabela).
// Não reaproveita o LimiteLoginService do condomínio de propósito: aquele é durável por condomínio, usa a chave HMAC do
// condomínio e a tabela do banco dele; a auth do condomínio não muda nesta entrega.
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { createHmac, hkdfSync } from 'node:crypto';
import { CONFIG, type Config } from '../config/config';
import { atrasoDaFalha } from '../auth/login-sem-condominio';
import { normalizarLogin, TETO_FALHAS } from '../auth/limite-login.service';
import type { ChaveMestra } from '../saas/chave-mestra';
import { CHAVE_MESTRA, type DbPlataforma, PLATAFORMA_DB } from '../saas/plataforma-db';
import { plataformaLoginLimite } from '../saas/schema-plataforma';

export type TipoLimiteMaster = 'master' | 'master_ip' | 'ip';

export interface ChaveLimiteMaster { tipo: TipoLimiteMaster; chave: string }
export interface ReservaMaster { chave: ChaveLimiteMaster; falhas: number; bloqueadoAte: Date | null }

@Injectable()
export class LimiteMasterService {
  private readonly subchave: Buffer;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(CHAVE_MESTRA) mestra: ChaveMestra,
  ) {
    this.subchave = Buffer.from(hkdfSync('sha256', mestra.chave, Buffer.alloc(0), 'portaria/plataforma/login_limite/v1', 32));
  }

  private hmac(texto: string) {
    return createHmac('sha256', this.subchave).update(texto, 'utf8').digest('hex');
  }

  chave(tipo: 'master' | 'ip', valor: string): ChaveLimiteMaster {
    return { tipo, chave: this.hmac(`${tipo}:${tipo === 'master' ? normalizarLogin(valor) : valor}`) };
  }

  /** Metade do HMAC do login + metade do HMAC do par: zerar todos os pares de um login sem saber os IPs. */
  chavePar(login: string, ip: string | null): ChaveLimiteMaster {
    const prefixo = this.chave('master', login).chave.slice(0, 32);
    return { tipo: 'master_ip', chave: prefixo + this.hmac(`master_ip:${JSON.stringify([normalizarLogin(login), ip ?? ''])}`).slice(0, 32) };
  }

  maximo(tipo: TipoLimiteMaster) {
    return tipo === 'master_ip' ? this.config.login.maxFalhasLogin : tipo === 'ip' ? this.config.login.maxFalhasIp : Infinity;
  }

  async reservar(c: ChaveLimiteMaster, agora: Date): Promise<ReservaMaster> {
    const t = agora.toISOString();
    const janela = this.config.login.janelaMin;
    const res = (await this.db.execute(sql`
      INSERT INTO plataforma_login_limite AS l (tipo, chave, falhas, janela_inicio, bloqueado_ate, atualizado_em)
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
    const l = res.rows[0]!;
    return { chave: c, falhas: Number(l.falhas), bloqueadoAte: l.bloqueado_ate ? new Date(l.bloqueado_ate) : null };
  }

  estaBloqueada(r: ReservaMaster, agora: Date): boolean {
    if (r.chave.tipo === 'master') return false;
    return (r.bloqueadoAte !== null && r.bloqueadoAte > agora) || r.falhas > this.maximo(r.chave.tipo);
  }

  /** Grava o bloqueio ao atingir o máximo; devolve o fim só se ESTA chamada o criou. */
  async bloquearSeAtingiu(r: ReservaMaster, agora: Date): Promise<Date | null> {
    if (r.falhas < this.maximo(r.chave.tipo)) return null;
    const ate = new Date(agora.getTime() + this.bloqueioMs());
    const l = await this.db.update(plataformaLoginLimite).set({ bloqueadoAte: ate, atualizadoEm: agora })
      .where(and(eq(plataformaLoginLimite.tipo, r.chave.tipo), eq(plataformaLoginLimite.chave, r.chave.chave),
        or(isNull(plataformaLoginLimite.bloqueadoAte), lte(plataformaLoginLimite.bloqueadoAte, agora))))
      .returning({ tipo: plataformaLoginLimite.tipo });
    return l.length ? ate : null;
  }

  /** Sucesso: zera login e par; desfaz só a reserva do IP (outras contas no mesmo IP). */
  async sucesso(login: ChaveLimiteMaster, par: ChaveLimiteMaster, ip: ChaveLimiteMaster | null, agora: Date) {
    for (const c of [login, par]) {
      await this.db.update(plataformaLoginLimite).set({ falhas: 0, janelaInicio: agora, bloqueadoAte: null, atualizadoEm: agora })
        .where(and(eq(plataformaLoginLimite.tipo, c.tipo), eq(plataformaLoginLimite.chave, c.chave)));
    }
    if (ip) {
      await this.db.update(plataformaLoginLimite).set({ falhas: sql`greatest(${plataformaLoginLimite.falhas} - 1, 0)`, atualizadoEm: agora })
        .where(and(eq(plataformaLoginLimite.tipo, ip.tipo), eq(plataformaLoginLimite.chave, ip.chave)));
    }
  }

  bloqueioMs() { return this.config.login.bloqueioMin * 60_000; }
  atraso(falhas: number) { return atrasoDaFalha(this.config.login, falhas); }
}
