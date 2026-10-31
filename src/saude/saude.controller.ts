import { Controller, Get, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Publico } from '../auth/decorators';
import { REGISTRO_BANCOS, type RegistroBancos } from '../database/registro-bancos';
import { eventoAcessoCadeia } from '../db/schema';
import { ResolvedorCondominio } from '../saas/resolvedor';

/** Validade do resultado do /saude: o healthcheck e quem chama de fora não viram uma consulta por banco a cada vez. */
export const SAUDE_CACHE_MS = 5_000;

type Resultado = { ok: true; condominiosComFalha: number } | { ok: false };

/**
 * Checagens do /saude (singleton: o cache vale para o processo, não por subárvore de condomínio).
 * Saudável = plataforma lida (app_plataforma) e o piloto, se existir, com a cabeça da cadeia legível (app_rw). Outro
 * condomínio com defeito (chave que não desembrulha, banco fora) NÃO derruba o healthcheck (derrubaria todos, e o
 * deploy faria rollback): entra na contagem `condominios_com_falha`, sem id, código nem nome. O log tem o id.
 */
@Injectable()
export class SaudeService {
  private readonly log = new Logger('Saude');
  private cache: { ate: number; valor: Promise<Resultado> } | null = null;

  constructor(
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
    @Inject(REGISTRO_BANCOS) private readonly bancos: RegistroBancos,
  ) {}

  verificar(): Promise<Resultado> {
    const agora = Date.now();
    if (!this.cache || this.cache.ate <= agora) this.cache = { ate: agora + SAUDE_CACHE_MS, valor: this.checar() };
    return this.cache.valor;
  }

  private async checar(): Promise<Resultado> {
    try {
      await this.resolvedor.pingPlataforma();
    } catch (erro) {
      this.registrar(erro);
      return { ok: false };
    }
    const { resolvidos, falhas } = await this.resolvedor.atendidosComFalhas();
    let comFalha = falhas.length;
    for (const { condominio } of resolvidos) {
      try {
        await this.bancos.db(condominio.banco).select({ id: eventoAcessoCadeia.id }).from(eventoAcessoCadeia).limit(1);
      } catch (erro) {
        this.registrar(erro);
        if (condominio.piloto) return { ok: false };
        comFalha++;
      }
    }
    return { ok: true, condominiosComFalha: comFalha };
  }

  private registrar(erro: unknown) {
    this.log.error(erro instanceof Error ? (erro.cause instanceof Error ? erro.cause.message : erro.message) : String(erro));
  }
}

// Público: o healthcheck do compose e do proxy chama sem sessão (guard global não pode derrubar o /saude).
// Não devolve o `ultimo_seq` da cadeia: com o rewrite da Vercel este endpoint fica aberto na internet, e o seq em
// polling mostraria o instante de cada evento da portaria (ver selo/publico.ts). A leitura da cabeça continua aqui
// como prova de que o app_rw enxerga a tabela da trilha, não só de que o banco responde.
// SaaS (F2): não injeta DB (não é rota de condomínio); as checagens e o cache estão no SaudeService.
@Publico()
@Controller('saude')
export class SaudeController {
  constructor(@Inject(SaudeService) private readonly saudeService: SaudeService) {}

  @Get()
  async saude() {
    const r = await this.saudeService.verificar();
    if (!r.ok) throw new ServiceUnavailableException({ status: 'erro', banco: 'indisponivel' });
    return { status: 'ok', banco: 'ok', condominios_com_falha: r.condominiosComFalha, em: new Date().toISOString() };
  }
}
