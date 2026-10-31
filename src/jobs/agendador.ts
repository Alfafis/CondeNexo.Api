// Agendador interno (selo diário, âncoras pendentes, retenção). Escolha: timer DENTRO da API, não um serviço cron no
// compose. Motivos: a VPS tem pouca memória (a API roda com 384 MiB) e um segundo processo Node só para o cron custaria
// outra imagem e outro tanto de RAM; e o agendador não depende de horário exato. A cada `intervaloMin` ele pergunta ao
// BANCO o que falta (o selo de ontem existe? a retenção já rodou hoje?) e faz só isso. Assim:
//  - API reiniciada na hora "marcada" não perde o dia (recupera no próximo ciclo);
//  - várias réplicas não duplicam: a trava de job (advisory lock) pula quem chega depois, e cada passo é idempotente
//    no banco (selo diário único por dia, pessoa reconferida com a linha travada);
//  - nada depende de @nestjs/schedule (seria só um setInterval com decorator).
// Desligado com JOBS_AGENDADOR=false (testes e CLI). As rotinas continuam disponíveis sob demanda e pelo CLI.
//
// SaaS (F2, SAAS-13): cada ciclo percorre os condomínios atendidos (ativo e suspenso: a trilha de um suspenso não pode
// ter buraco nem dado vencido retido) e roda selo, âncoras e retenção na subárvore de injeção DE CADA UM (os mesmos
// serviços duráveis das requisições dele, saas/contexto.ts). Um condomínio por vez (o "no máximo N em paralelo" do
// SAAS-13 com N = 1: não disputa conexões com a portaria). Falha num condomínio vai ao log e o laço segue.
import { Inject, Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, gte } from 'drizzle-orm';
import { diaBrt, inicioDoDiaBrt } from '../comum/datas';
import { codigoPg } from '../comum/erros';
import { log } from '../comum/log';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { CONFIG, type Config } from '../config/config';
import { DB, type Db } from '../database/database.module';
import { auditLog } from '../db/schema';
import { LgpdModule } from '../lgpd/lgpd.module';
import { LgpdService } from '../lgpd/lgpd.service';
import { RetencaoService } from '../lgpd/retencao.service';
import type { CondominioResolvido } from '../saas/condominio';
import { contextoDoJob, type ResolvedorDeInstancias } from '../saas/contexto';
import { ResolvedorCondominio } from '../saas/resolvedor';
import { NOME_AGENDADOR, SeloModule, SeloService } from '../selo/selo.module';
import { TravaJobs } from './trava';

const BRT_MS = 3 * 3600 * 1000;

/** Serviços de um condomínio, resolvidos na subárvore dele (a mesma das requisições do condomínio). */
export async function servicosDoCondominio(moduleRef: ResolvedorDeInstancias, c: CondominioResolvido) {
  const id = contextoDoJob(moduleRef, c);
  const r = <T>(t: Type<T> | symbol) => moduleRef.resolve<T>(t, id, { strict: false });
  const [selo, retencao, trava, db, lgpd] = await Promise.all([
    r<SeloService>(SeloService), r<RetencaoService>(RetencaoService), r<TravaJobs>(TravaJobs), r<Db>(DB), r<LgpdService>(LgpdService),
  ]);
  return { selo, retencao, trava, db, lgpd };
}

@Injectable()
export class Agendador implements OnApplicationBootstrap, OnApplicationShutdown {
  private timers: NodeJS.Timeout[] = [];
  private rodando = false;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.jobs.agendador) return;
    // Primeiro ciclo logo depois do boot (com folga para o pool e o healthcheck), depois a cada intervalo.
    const inicial = setTimeout(() => void this.ciclo(), 30_000);
    const periodico = setInterval(() => void this.ciclo(), this.config.jobs.intervaloMin * 60_000);
    inicial.unref(); periodico.unref();
    this.timers.push(inicial, periodico);
    log('info', 'agendador.ligado', { detalhe: `a cada ${this.config.jobs.intervaloMin} min; retenção a partir das ${this.config.jobs.horaRetencaoBrt}h BRT` });
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Um ciclo: para cada condomínio atendido, o ciclo dele. Devolve os ids que falharam (testes e log). */
  async ciclo(): Promise<{ falharam: string[] }> {
    if (this.rodando) return { falharam: [] }; // ciclo anterior ainda em curso neste processo
    this.rodando = true;
    const falharam: string[] = [];
    try {
      let condominios: CondominioResolvido[];
      try {
        // Condomínio que não resolve (chave, plataforma) entra em `falharam` e não para o laço dos outros.
        const r = await this.resolvedor.atendidosComFalhas();
        condominios = r.resolvidos.map((x) => x.condominio);
        falharam.push(...r.falhas);
      } catch {
        log('error', 'agendador.sem_condominios');
        return { falharam };
      }
      for (const c of condominios) {
        try {
          await this.cicloDoCondominio(c);
        } catch (e) {
          falharam.push(c.id);
          // Só códigos e o uuid do condomínio: o erro do driver pode trazer parâmetros de conexão.
          log('error', 'agendador.falhou', { condominio_id: c.id, codigo_pg: codigoPg(e), erro: e instanceof Error ? e.name : 'erro' });
        }
      }
      return { falharam };
    } finally {
      this.rodando = false;
    }
  }

  /** Selo de ontem e âncoras pendentes; retenção, se já passou da hora e ainda não rodou hoje. */
  async cicloDoCondominio(c: CondominioResolvido): Promise<void> {
    const { selo, retencao, trava, db } = await servicosDoCondominio(this.moduleRef, c);
    const s = await selo.rotinaDiaria();
    if (s && (s.selado || s.enviados)) log('info', 'agendador.selo', { condominio_id: c.id, detalhe: `selado=${s.selado} ancoras_enviadas=${s.enviados}` });
    const agora = this.relogio.agora();
    const horaBrt = new Date(agora.getTime() - BRT_MS).getUTCHours();
    if (horaBrt >= this.config.jobs.horaRetencaoBrt && !(await this.retencaoRodouHoje(db, agora))) {
      const r = await trava.tentar('retencao', () => retencao.aplicar({ ator: null, nomeInformado: NOME_AGENDADOR }));
      if (r.obtida) {
        const v = r.valor;
        log('info', 'agendador.retencao', { condominio_id: c.id, detalhe: `pessoas=${v.pessoaIds.length} eventos=${v.eventosDescartados} trilha=${v.trilhaDescartada} orfaos=${v.arquivosOrfaosRemovidos}` });
      }
    }
  }

  private async retencaoRodouHoje(db: Db, agora: Date): Promise<boolean> {
    const [l] = await db.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.acao, 'lgpd.retencao'), gte(auditLog.em, inicioDoDiaBrt(diaBrt(agora))))).limit(1);
    return !!l;
  }
}

@Module({ imports: [SeloModule, LgpdModule], providers: [Agendador] })
export class JobsModule {}
