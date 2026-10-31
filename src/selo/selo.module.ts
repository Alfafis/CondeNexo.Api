// Selo da cadeia de eventos e âncora externa (spec §4.6). Ver o porquê em ./ancora.ts.
//
// - Selo diário (agendador): para o dia D (BRT), sela o ÚLTIMO evento registrado antes da meia-noite de D+1. Um por dia
//   (índice único parcial em `selo_cadeia`), então rodar de novo ou em duas réplicas não duplica. É também o ponto de
//   corte da retenção (o descarte do prefixo exige um selo exatamente no seq de corte).
// - Selo manual ("Selar agora", SI/AU): sela a cabeça da cadeia naquele momento. Se a cabeça não andou desde o último
//   selo, devolve o existente (não cria selo nem e-mail repetido).
// - Envio da âncora: depois do COMMIT do selo; quem falha fica pendente (`enviado_em` nulo) e o agendador tenta de novo.
//   O envio é "pelo menos uma vez": se o UPDATE de `enviado_em` falhar depois do e-mail, o próximo envio repete o e-mail.
// - Conferir âncora: compara um seq+hash recebido por fora com o banco. Conveniência: um servidor adulterado pode mentir
//   aqui; a conferência com valor de prova é a offline (exportação + verificar-ancoras + o branch `ancoras` ou o e-mail).
// - Selos públicos (destino `github`): `GET /auditoria/selos/publico`, sem sessão, com cache e limite próprios. O porquê
//   de cada restrição está em ./publico.ts.
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post, Req, Res } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, isNull, lt, lte } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { Acao, Ctx, ipDe, Publico } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { diaBrt, inicioDoDiaBrt, somarDias } from '../comum/datas';
import { erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { ZodPipe } from '../comum/zod.pipe';
import { CONFIG, type Config } from '../config/config';
import { DB, type Db } from '../database/database.module';
import { eventoAcesso, eventoAcessoCadeia, seloCadeia } from '../db/schema';
import { TravaJobs } from '../jobs/trava';
import { CONDOMINIO, type CondominioResolvido } from '../saas/condominio';
import { AncoraSemDestino, ENVIO_ANCORA, type EnvioAncora, EnvioAncoraReal, SemDestinoAncora } from './ancora';
import { CACHE_PUBLICO_MS, FORMATO_SELOS_PUBLICOS, LimiteTaxaPublico, SELOS_PUBLICOS_MAX, type SelosPublicos } from './publico';

type LinhaSelo = typeof seloCadeia.$inferSelect;
type TipoSelo = 'diario' | 'manual';

export interface SeloView {
  id: string; data: string; tipo: TipoSelo; ultimoSeq: number; ultimoHash: string; criadoEm: number;
  enviadoPara: string | null; enviadoEm: number | null;
}
export type StatusAncora = 'enviada' | 'pendente' | 'sem_destino';

const seloView = (s: LinhaSelo): SeloView => ({
  id: s.id, data: s.data, tipo: s.tipo as TipoSelo, ultimoSeq: s.ultimoSeq, ultimoHash: s.ultimoHash, criadoEm: s.criadoEm.getTime(),
  enviadoPara: s.enviadoPara, enviadoEm: s.enviadoEm ? s.enviadoEm.getTime() : null,
});

const ConferirDto = z.strictObject({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // Colado do e-mail: aceita maiúsculas e espaços nas pontas, compara em minúsculas.
  hash: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, 'hash SHA-256 em hexadecimal (64 caracteres)'),
});

/** Ator do agendador no audit_log (sem usuário: usuario_id e papel nulos, como permite o CHECK). */
export const NOME_AGENDADOR = 'Agendador (sistema)';

/** Executor de consulta: o banco ou a transação em curso (no PGlite, consulta fora da transação trava). */
type Executor = Pick<Db, 'select'>;

@Injectable()
export class SeloService {
  /** Resposta do endpoint público em cache (promessa: requisições simultâneas dividem uma consulta só). */
  private cachePublico: { ate: number; valor: Promise<SelosPublicos> } | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(ENVIO_ANCORA) private readonly envio: EnvioAncora,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(TravaJobs) private readonly trava: TravaJobs,
  ) {}

  /**
   * Selo diário do dia `dia` (BRT): o último evento registrado até o fim do dia. Já selado: devolve o existente.
   * Sem nenhum evento até lá: sela a gênese só se a cadeia ainda está vazia; senão não há o que selar (null).
   */
  async selarDia(dia: string): Promise<{ selo: SeloView; novo: boolean } | null> {
    const existente = await this.diario(dia);
    if (existente) return { selo: seloView(existente), novo: false };
    const limite = inicioDoDiaBrt(somarDias(dia, 1));
    const [ultimo] = await this.db.select({ seq: eventoAcesso.seq, hash: eventoAcesso.hash }).from(eventoAcesso)
      .where(lt(eventoAcesso.registradoEm, limite)).orderBy(desc(eventoAcesso.seq)).limit(1);
    let alvo = ultimo;
    if (!alvo) {
      const [cab] = await this.db.select().from(eventoAcessoCadeia).where(eq(eventoAcessoCadeia.id, 1));
      if (!cab || cab.ultimoSeq !== 0) return null; // eventos só depois do dia (ou já descartados): nada a selar
      alvo = { seq: cab.ultimoSeq, hash: cab.ultimoHash };
    }
    const [novo] = await this.db.insert(seloCadeia).values({ data: dia, tipo: 'diario', ultimoSeq: alvo.seq, ultimoHash: alvo.hash })
      .onConflictDoNothing().returning();
    if (!novo) return { selo: seloView((await this.diario(dia))!), novo: false }; // outra réplica selou ao mesmo tempo
    this.cachePublico = null; // selo diário novo: a coleta do GitHub vê na hora, sem esperar o cache vencer
    await this.auditoria.registrar(this.db, {
      ator: null, nomeInformado: NOME_AGENDADOR, acao: 'auditoria.selar', entidade: 'selo_cadeia', registroId: novo.id,
      depois: { tipo: 'diario', data: dia, ultimoSeq: alvo.seq, ultimoHash: alvo.hash },
    });
    return { selo: seloView(novo), novo: true };
  }

  private async diario(dia: string) {
    const [s] = await this.db.select().from(seloCadeia).where(and(eq(seloCadeia.data, dia), eq(seloCadeia.tipo, 'diario')));
    return s;
  }

  /** "Selar agora" (SI/AU): a cabeça da cadeia, com a âncora enviada na hora (falha = pendente, sem erro). */
  async selarAgora(ctx: Contexto): Promise<{ selo: SeloView; novo: boolean; ancora: StatusAncora }> {
    const r = await this.trava.tentar('selo', async () => {
      const [cab] = await this.db.select().from(eventoAcessoCadeia).where(eq(eventoAcessoCadeia.id, 1));
      if (!cab) throw erroApi(500, 'CADEIA_AUSENTE', 'A cabeça da cadeia não existe no banco.');
      const [mesmo] = await this.db.select().from(seloCadeia)
        .where(and(eq(seloCadeia.ultimoSeq, cab.ultimoSeq), eq(seloCadeia.ultimoHash, cab.ultimoHash)))
        .orderBy(desc(seloCadeia.criadoEm), desc(seloCadeia.id)).limit(1);
      if (mesmo) return { linha: mesmo, novo: false };
      const [novo] = await this.db.insert(seloCadeia).values({
        data: diaBrt(this.relogio.agora()), tipo: 'manual', ultimoSeq: cab.ultimoSeq, ultimoHash: cab.ultimoHash,
      }).returning();
      await this.auditoria.registrar(this.db, {
        ator: ctx.ator, ip: ctx.ip, acao: 'auditoria.selar', entidade: 'selo_cadeia', registroId: novo!.id,
        depois: { tipo: 'manual', data: novo!.data, ultimoSeq: novo!.ultimoSeq, ultimoHash: novo!.ultimoHash },
      });
      return { linha: novo!, novo: true };
    });
    if (!r.obtida) throw erroApi(409, 'SELO_EM_ANDAMENTO', 'Um selo está sendo gravado agora. Tente de novo em instantes.');
    let linha = r.valor.linha;
    if (!linha.enviadoEm) {
      await this.enviarSelo(linha.id);
      linha = (await this.db.select().from(seloCadeia).where(eq(seloCadeia.id, linha.id)))[0]!;
    }
    const ancora: StatusAncora = linha.enviadoEm ? 'enviada' : this.envio.destinos().length ? 'pendente' : 'sem_destino';
    return { selo: seloView(linha), novo: r.valor.novo, ancora };
  }

  /**
   * Envia a âncora de UM selo ainda não enviado. A linha fica travada (FOR UPDATE SKIP LOCKED) durante o envio: duas
   * réplicas não mandam o mesmo e-mail ao mesmo tempo. Devolve se enviou.
   */
  async enviarSelo(id: string): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const [s] = await tx.select().from(seloCadeia).where(and(eq(seloCadeia.id, id), isNull(seloCadeia.enviadoEm)))
          .for('update', { skipLocked: true });
        if (!s) return false;
        const para = await this.envio.enviar({
          id: s.id, data: s.data, tipo: s.tipo as TipoSelo, ultimoSeq: s.ultimoSeq, ultimoHash: s.ultimoHash,
          eventosNoDia: await this.eventosNoDia(tx, s), seladoEm: s.criadoEm,
        });
        await tx.update(seloCadeia).set({ enviadoPara: para.slice(0, 500), enviadoEm: this.relogio.agora() }).where(eq(seloCadeia.id, s.id));
        return true;
      });
    } catch (e) {
      if (e instanceof SemDestinoAncora) { log('warn', 'ancora.sem_destino', { detalhe: id }); return false; }
      // Só o código (ECONNREFUSED, EAUTH...): a mensagem do SMTP pode trazer o endereço e a resposta do servidor.
      log('warn', 'ancora.envio_falhou', { detalhe: id, codigo: (e as { code?: string }).code ?? 'erro' });
      return false;
    }
  }

  /** Eventos registrados no dia BRT do selo até o seq selado (o mesmo número no e-mail e no endpoint público). */
  private async eventosNoDia(ex: Executor, s: Pick<LinhaSelo, 'data' | 'ultimoSeq'>): Promise<number> {
    const [{ n }] = await ex.select({ n: count() }).from(eventoAcesso).where(and(
      lte(eventoAcesso.seq, s.ultimoSeq), gte(eventoAcesso.registradoEm, inicioDoDiaBrt(s.data)),
      lt(eventoAcesso.registradoEm, inicioDoDiaBrt(somarDias(s.data, 1))),
    )) as [{ n: number }];
    return Number(n);
  }

  /**
   * Selos DIÁRIOS mais recentes para o endpoint público (destino `github`): data, seq, hash e total do dia, do mais
   * antigo para o mais novo. Nada de selo manual, instante ou id (ver ./publico.ts). Em cache por CACHE_PUBLICO_MS.
   */
  selosPublicos(): Promise<SelosPublicos> {
    const agora = this.relogio.agora().getTime();
    if (this.cachePublico && agora < this.cachePublico.ate && agora >= this.cachePublico.ate - CACHE_PUBLICO_MS) return this.cachePublico.valor;
    const valor = this.consultarSelosPublicos();
    const entrada = { ate: agora + CACHE_PUBLICO_MS, valor };
    this.cachePublico = entrada;
    // Falha (banco fora) não fica em cache: a próxima chamada tenta de novo.
    valor.catch(() => { if (this.cachePublico === entrada) this.cachePublico = null; });
    return valor;
  }

  private async consultarSelosPublicos(): Promise<SelosPublicos> {
    const linhas = await this.db.select().from(seloCadeia).where(eq(seloCadeia.tipo, 'diario'))
      .orderBy(desc(seloCadeia.data)).limit(SELOS_PUBLICOS_MAX);
    const selos = [];
    for (const s of linhas.reverse()) {
      selos.push({ data: s.data, seq: s.ultimoSeq, hash: s.ultimoHash, totalDoDia: await this.eventosNoDia(this.db, s) });
    }
    return { formato: FORMATO_SELOS_PUBLICOS, versao: 1, selos };
  }

  /** Âncoras pendentes, da mais antiga para a mais nova; para no primeiro erro (SMTP fora: tenta no próximo ciclo). */
  async enviarPendentes(maximo = 10): Promise<number> {
    if (!this.envio.destinos().length) return 0;
    const pendentes = await this.db.select({ id: seloCadeia.id }).from(seloCadeia).where(isNull(seloCadeia.enviadoEm))
      .orderBy(asc(seloCadeia.ultimoSeq), asc(seloCadeia.criadoEm)).limit(maximo);
    let enviados = 0;
    for (const p of pendentes) {
      if (!(await this.enviarSelo(p.id))) break;
      enviados++;
    }
    return enviados;
  }

  /** Tarefa do agendador: selo de ontem (BRT) e âncoras pendentes, com a trava de job. */
  async rotinaDiaria(): Promise<{ selado: boolean; enviados: number } | null> {
    const r = await this.trava.tentar('selo', async () => {
      const ontem = somarDias(diaBrt(this.relogio.agora()), -1);
      const s = await this.selarDia(ontem);
      return { selado: !!s?.novo, enviados: await this.enviarPendentes() };
    });
    return r.obtida ? r.valor : null;
  }

  async estado() {
    const [ultimo] = await this.db.select().from(seloCadeia).orderBy(desc(seloCadeia.criadoEm), desc(seloCadeia.id)).limit(1);
    const [{ n }] = await this.db.select({ n: count() }).from(seloCadeia).where(isNull(seloCadeia.enviadoEm)) as [{ n: number }];
    return { ultimo: ultimo ? seloView(ultimo) : null, pendentesEnvio: Number(n), destinos: this.envio.destinos(), agendador: this.config.jobs.agendador };
  }

  /** Confere um seq+hash recebido por fora (e-mail do selo) contra o evento no banco. Registra a conferência. */
  async conferir(ctx: Contexto, i: z.infer<typeof ConferirDto>) {
    const [e] = await this.db.select({ hash: eventoAcesso.hash }).from(eventoAcesso).where(eq(eventoAcesso.seq, i.seq));
    const [selo] = await this.db.select({ id: seloCadeia.id }).from(seloCadeia)
      .where(and(eq(seloCadeia.ultimoSeq, i.seq), eq(seloCadeia.ultimoHash, i.hash))).limit(1);
    let hashNoBanco: string | null = e?.hash ?? null;
    let motivo: 'confere' | 'hash_divergente' | 'seq_descartado' | 'seq_inexistente';
    if (e) motivo = e.hash === i.hash ? 'confere' : 'hash_divergente';
    else {
      // Gênese (seq 0) só existe como cabeça; eventos abaixo do primeiro restante foram descartados pela retenção.
      const [primeiro] = await this.db.select({ seq: eventoAcesso.seq }).from(eventoAcesso).orderBy(asc(eventoAcesso.seq)).limit(1);
      const [cab] = await this.db.select().from(eventoAcessoCadeia).where(eq(eventoAcessoCadeia.id, 1));
      if (i.seq === 0 && cab?.ultimoSeq === 0) { hashNoBanco = cab.ultimoHash; motivo = cab.ultimoHash === i.hash ? 'confere' : 'hash_divergente'; }
      else if (cab && i.seq <= cab.ultimoSeq && (!primeiro || i.seq < primeiro.seq)) motivo = 'seq_descartado';
      else motivo = 'seq_inexistente';
    }
    const confere = motivo === 'confere' || (motivo === 'seq_descartado' && !!selo);
    await this.auditoria.registrar(this.db, {
      ator: ctx.ator, ip: ctx.ip, acao: 'auditoria.conferirAncora', entidade: 'selo_cadeia', registroId: selo?.id ?? null,
      depois: { seq: i.seq, hash: i.hash, confere, motivo },
    });
    return { confere, motivo, seq: i.seq, hashNoBanco, seloRegistrado: !!selo };
  }
}

@Controller('auditoria/selos')
export class SeloController {
  constructor(
    @Inject(SeloService) private readonly s: SeloService,
    @Inject(LimiteTaxaPublico) private readonly limite: LimiteTaxaPublico,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
  ) {}

  /** Público, sem parâmetro (ver ./publico.ts). Só existe com o destino `github` ligado; desligado, 404. */
  @Get('publico')
  @Publico()
  async publico(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = this.limite.consumir(ipDe(req) ?? 'sem-ip', Date.now());
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSeg));
      throw erroApi(429, 'LIMITE_EXCEDIDO', 'Muitas consultas aos selos públicos. Tente de novo em instantes.');
    }
    // SaaS (F2): só o piloto publica (formato v1, por condomínio). Para vários condomínios, o v1 revelaria o volume de
    // cada cliente: a âncora agregada (§4.3) é a fase F4, que vem antes do segundo condomínio real.
    if (!this.config.ancora.github || !this.condominio?.piloto) throw erroApi(404, 'NAO_ENCONTRADO', 'Recurso não encontrado.');
    const corpo = await this.s.selosPublicos();
    // Só o sucesso sai com cache público. Não usar @Header: o Nest aplica antes do handler, e um 429/404 sairia
    // com max-age (resposta de erro com validade explícita pode ser guardada por cache intermediário).
    res.setHeader('Cache-Control', `public, max-age=${CACHE_PUBLICO_MS / 1000}`);
    return corpo;
  }

  @Get()
  @Acao('auditoria.verificar')
  estado() { return this.s.estado(); }

  @Post()
  @Acao('auditoria.selar')
  @HttpCode(200)
  selar(@Ctx() ctx: Contexto) { return this.s.selarAgora(ctx); }

  @Post('conferir')
  @Acao('auditoria.verificar')
  @HttpCode(200)
  conferir(@Ctx() ctx: Contexto, @Body(new ZodPipe(ConferirDto)) b: z.infer<typeof ConferirDto>) { return this.s.conferir(ctx, b); }
}

@Module({
  controllers: [SeloController],
  providers: [
    SeloService, TravaJobs, EnvioAncoraReal,
    // Âncora por condomínio (F2): o piloto usa os destinos configurados; os demais ficam sem destino (selo pendente)
    // até a âncora agregada da F4. Sem isso, o selo de outro condomínio iria para o e-mail e o arquivo do piloto.
    {
      provide: ENVIO_ANCORA, inject: [CONDOMINIO, EnvioAncoraReal],
      useFactory: (c: CondominioResolvido | null, real: EnvioAncoraReal): EnvioAncora => (c?.piloto ? real : new AncoraSemDestino()),
    },
    // Factory: um limite por instância da aplicação (useValue seria um objeto só, dividido entre apps de teste).
    { provide: LimiteTaxaPublico, useFactory: () => new LimiteTaxaPublico() },
  ],
  exports: [SeloService, TravaJobs],
})
export class SeloModule {}
