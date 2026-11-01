// Painel da plataforma (Fase A, spec 2026-10-31): só leitura do banco `plataforma` e a saúde do provisionador. Cada bloco é
// calculado isoladamente: se um falhar, o campo vai `null` (log sem dado sensível) e o resto responde. Só números e
// categorias; nada de texto livre, e-mail ou id de condomínio nas leituras agregadas.
import { Inject, Injectable } from '@nestjs/common';
import { desc, max, sql } from 'drizzle-orm';
import { diaBrt, somarDias } from '../comum/datas';
import { log } from '../comum/log';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { ENTIDADES_REVELAR, type EntidadeRevelar } from './acesso-plataforma.service';
import { CondominiosMasterService } from './condominios-master.service';
import { type DbPlataforma, PLATAFORMA_DB } from './plataforma-db';
import { TEMPO_SAUDE_MS } from './provisionador';
import { ancoraDiaria, condominio, plataformaAudit } from './schema-plataforma';

export interface CondominioRecente { id: string; nome: string; codigo: string; status: string; criadoEm: string }
export interface PainelCondominios {
  porStatus: Record<string, number>;
  porPlano: Record<string, number>;
  /** Os 5 criados por último. */
  recentes: CondominioRecente[];
}
export interface PainelAncora {
  /** 'AAAA-MM-DD' da última âncora agregada; nulo se ainda não há nenhuma. */
  ultimaData: string | null;
  /**
   * A última âncora é anterior a ontem (dia BRT, o calendário do restante da API). Sem nenhuma âncora é `false`, não alarme:
   * nada em `src` escreve em `ancora_diaria` ainda (a âncora dos selos no git é outro mecanismo), então "nunca rodou" não é atraso.
   */
  atrasada: boolean;
}
export interface PainelPlataforma {
  condominios: PainelCondominios | null;
  provisionador: { disponivel: boolean } | null;
  ancora: PainelAncora | null;
}

export const JANELA_REVELACOES_DIAS = 7;

/**
 * "Revelações nos últimos 7 dias" (Fase B, 2026-11-01): as linhas `condominio.revelar` da plataforma_audit, por entidade.
 * Substitui o bloco "Leituras do Master", que perdeu a fonte (a leitura não grava mais trilha). Serve ao próprio Master
 * para notar revelação que não fez (sessão roubada). Só contagens; nunca id, rota, IP ou condomínio.
 */
export interface RevelacoesMaster {
  janelaDias: number;
  total: number;
  /** Toda entidade aparece (zero inclusive). */
  porEntidade: Record<EntidadeRevelar, number>;
}

@Injectable()
export class PainelMasterService {
  constructor(
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(CondominiosMasterService) private readonly condominios: CondominiosMasterService,
    @Inject(RELOGIO) private readonly relogio: Relogio,
  ) {}

  async painel(): Promise<PainelPlataforma> {
    const [c, p, a] = await Promise.all([
      this.bloco('condominios', () => this.blocoCondominios()),
      this.bloco('provisionador', () => this.blocoProvisionador()),
      this.bloco('ancora', () => this.blocoAncora()),
    ]);
    return { condominios: c, provisionador: p, ancora: a };
  }

  private async bloco<T>(nome: string, fn: () => Promise<T>): Promise<T | null> {
    try { return await fn(); } catch (e) {
      log('error', 'plataforma.painel_bloco_falhou', { bloco: nome, erro: e instanceof Error ? e.name : 'erro' });
      return null;
    }
  }

  private async blocoCondominios(): Promise<PainelCondominios> {
    // Sem filtro de status, como a lista de licenças (listar()): encerrado e excluído também contam.
    const conta = async (col: typeof condominio.status | typeof condominio.plano) => {
      const linhas = await this.db.select({ k: col, n: sql<number>`count(*)::int` }).from(condominio).groupBy(col);
      return Object.fromEntries(linhas.map((l) => [l.k, l.n]));
    };
    const [porStatus, porPlano, recentes] = await Promise.all([
      conta(condominio.status), conta(condominio.plano),
      this.db.select({ id: condominio.id, nome: condominio.nome, codigo: condominio.codigo, status: condominio.status, criadoEm: condominio.criadoEm })
        .from(condominio).orderBy(desc(condominio.criadoEm), desc(condominio.codigo)).limit(5),
    ]);
    return { porStatus, porPlano, recentes: recentes.map((r) => ({ ...r, criadoEm: r.criadoEm.toISOString() })) };
  }

  private async blocoProvisionador(): Promise<{ disponivel: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    const estouro = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TEMPO_SAUDE_MS + 500); });
    try { return await Promise.race([this.condominios.provisionadorDisponivel(), estouro]); } finally { clearTimeout(timer); }
  }

  private async blocoAncora(): Promise<PainelAncora> {
    const [l] = await this.db.select({ d: max(ancoraDiaria.data) }).from(ancoraDiaria);
    const ultimaData = l?.d ?? null;
    const ontem = somarDias(diaBrt(this.relogio.agora()), -1);
    return { ultimaData, atrasada: ultimaData !== null && ultimaData < ontem };
  }

  async revelacoes(): Promise<RevelacoesMaster> {
    const desde = new Date(this.relogio.agora().getTime() - JANELA_REVELACOES_DIAS * 86_400_000);
    const entidade = sql<string | null>`${plataformaAudit.detalhes}->>'entidade'`;
    const linhas = await this.db.select({ entidade, n: sql<number>`count(*)::int` }).from(plataformaAudit)
      .where(sql`${plataformaAudit.acao} = 'condominio.revelar' and ${plataformaAudit.em} >= ${desde}`)
      .groupBy(entidade);
    const porEntidade = Object.fromEntries(ENTIDADES_REVELAR.map((e) => [e, 0])) as Record<EntidadeRevelar, number>;
    let total = 0;
    for (const l of linhas) {
      total += l.n;
      // Só entidades conhecidas viram chave: a resposta nunca ecoa texto da trilha.
      if ((ENTIDADES_REVELAR as readonly string[]).includes(l.entidade ?? '')) porEntidade[l.entidade as EntidadeRevelar] += l.n;
    }
    return { janelaDias: JANELA_REVELACOES_DIAS, total, porEntidade };
  }
}
