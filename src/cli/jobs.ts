// Rotinas de LGPD e de selo pela linha de comando (as mesmas do agendador e dos endpoints), para rodar à mão, por cron
// externo ou depois de um restore:
//   docker compose exec api node dist/cli/jobs.js retencao [--condominio <código>]          retenção completa (seção 7)
//   docker compose exec api node dist/cli/jobs.js selo [AAAA-MM-DD] [--condominio <código>]  selo diário (padrão: ontem, BRT) + âncoras
//   docker compose exec api node dist/cli/jobs.js ancoras [--condominio <código>]           só reenvia as âncoras pendentes
//   docker compose exec api node dist/cli/jobs.js reaplicar-anonimizacoes [--condominio <código>]
//        depois de um RESTORE (docs/deploy.md, seção 9): refaz as anonimizações que a plataforma registra e o banco
//        restaurado desfez. Lista quem ainda tem vínculo válido no banco restaurado (conferir à mão).
// SaaS (F2): roda num condomínio só, o do --condominio (padrão: o piloto), na mesma subárvore de injeção que a API usa
// para ele (banco, chaves, trava). Roda como app_rw (DATABASE_URL da API), com a mesma trava de job: se o agendador
// estiver no meio, sai com código 3. A saída tem só contagens e ids (sem dado pessoal).
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { diaBrt, ehDiaValido, somarDias } from '../comum/datas';
import { NOME_AGENDADOR } from '../selo/selo.module';
import { servicosDoCondominio } from '../jobs/agendador';
import { ResolvedorCondominio } from '../saas/resolvedor';

const USO = 'uso: jobs.js retencao | selo [AAAA-MM-DD] | ancoras | reaplicar-anonimizacoes   [--condominio <código>]';

export function lerArgumentos(argv: string[]): { comando: string; dia?: string; codigo?: string } | null {
  const resto = [...argv];
  let codigo: string | undefined;
  const i = resto.indexOf('--condominio');
  if (i >= 0) {
    codigo = resto[i + 1];
    if (!codigo) return null;
    resto.splice(i, 2);
  }
  const [comando, dia, ...sobra] = resto;
  if (!['retencao', 'selo', 'ancoras', 'reaplicar-anonimizacoes'].includes(comando ?? '') || sobra.length || (dia !== undefined && comando !== 'selo')) return null;
  return { comando: comando!, dia, codigo };
}

async function principal(): Promise<number> {
  process.env.JOBS_AGENDADOR = 'false'; // o contexto do CLI não liga os timers
  const args = lerArgumentos(process.argv.slice(2));
  if (!args) {
    console.error(USO);
    return 2;
  }
  const { AppModule } = await import('../app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const resolvedor = app.get(ResolvedorCondominio);
    const r = args.codigo ? await resolvedor.porCodigoDoLogin(args.codigo) : await resolvedor.piloto();
    if (!r) { console.error('condomínio não encontrado (ou fora de ativo/suspenso)'); return 1; }
    const { selo, retencao, trava, lgpd } = await servicosDoCondominio(app, r.condominio);
    if (args.comando === 'reaplicar-anonimizacoes') {
      // Mesma trava da retenção: as duas anonimizam, e a retenção também reaplica.
      const x = await trava.tentar('retencao', () => lgpd.reaplicar({ ator: null, nomeInformado: `${NOME_AGENDADOR} via CLI (restore)` }));
      if (!x.obtida) { console.error('retenção em andamento em outro processo; tente de novo'); return 3; }
      console.log(JSON.stringify({ condominioId: r.condominio.id, ...x.valor }));
      return 0;
    }
    if (args.comando === 'retencao') {
      const x = await trava.tentar('retencao', () => retencao.aplicar({ ator: null, nomeInformado: `${NOME_AGENDADOR} via CLI` }));
      if (!x.obtida) { console.error('retenção já em andamento em outro processo'); return 3; }
      console.log(JSON.stringify({ condominioId: r.condominio.id, ...x.valor }));
      return 0;
    }
    const x = await trava.tentar('selo', async () => {
      if (args.comando === 'ancoras') return { enviados: await selo.enviarPendentes(100) };
      const dia = args.dia ?? somarDias(diaBrt(new Date()), -1);
      if (!ehDiaValido(dia)) throw new Error('dia inválido (AAAA-MM-DD)');
      const s = await selo.selarDia(dia);
      return { dia, selo: s ? { id: s.selo.id, ultimoSeq: s.selo.ultimoSeq, novo: s.novo } : null, enviados: await selo.enviarPendentes(100) };
    });
    if (!x.obtida) { console.error('selo já em andamento em outro processo'); return 3; }
    console.log(JSON.stringify({ condominioId: r.condominio.id, ...x.valor }));
    return 0;
  } finally {
    await app.close();
  }
}

// Só roda como programa (o teste importa lerArgumentos).
if (typeof require !== 'undefined' && require.main === module) {
  principal().then((codigo) => process.exit(codigo)).catch((e) => {
    // Só a mensagem: erro de config é nosso texto; o do pg não traz a senha na mensagem.
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
    process.exit(1);
  });
}
