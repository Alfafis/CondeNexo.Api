// Rotação das chaves do envelope: chave mestra e KEK dos anexos por condomínio (regras em src/plataforma/rotacao-chaves.ts;
// passo a passo de produção, com a ordem obrigatória e o rollback, em docs/deploy-rotacao-chaves.md).
//
//   docker compose --profile rotacao run --rm -T rotacao-cli                                    (dry-run, padrão: só lê)
//   docker compose --profile rotacao run --rm -T rotacao-cli node dist/cli/rotacionar-chaves.js --mestra
//   docker compose --profile rotacao run --rm -T rotacao-cli node dist/cli/rotacionar-chaves.js --kek-preparar --condominio <codigo> --kek-versao-atual <n>
//   docker compose --profile rotacao run --rm -T rotacao-cli node dist/cli/rotacionar-chaves.js --kek-migrar --condominio <codigo> [--lote <n>]
//
// Ambiente (o serviço rotacao-cli do compose monta as URLs do .env; chave NUNCA vem por argumento):
//   PORTARIA_CHAVE_MESTRA(_VERSAO)            mestra em uso (a do .env)                       todos os modos
//   PORTARIA_CHAVE_MESTRA_NOVA(_VERSAO_NOVA)  mestra nova, só exportada na sessão do shell     --mestra (e, se houver, o dry-run)
//   DATABASE_URL_PLATAFORMA                   app_plataforma no banco `plataforma`             dry-run, --kek-*
//   MIGRATOR_URL_BASE                         app_migrator (dono de condominio_chave)          --mestra
//   DATABASE_URL                              app_rw (o nome do banco vira o do condomínio)    dry-run, --kek-migrar
// Saída: JSON no stdout (contagens, tipos, versões, id/código do condomínio; nunca chave). Progresso e veredito no stderr.
// Códigos: 0 ok (inclusive "já feito"); 1 recusado, falha ou dry-run com problema (nada além do já confirmado foi gravado); 2 uso.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Db } from '../database/database.module';
import { urlDoBanco } from '../database/registro-bancos';
import * as schema from '../db/schema';
import { carregarChaveMestra, type ChaveMestra, chaveDoAmbiente, ErroChave, versaoDoAmbiente } from '../plataforma/chave-mestra';
import type { DbPlataforma } from '../plataforma/registrar-piloto';
import { inspecionar, migrarDocumentos, prepararKek, rotacionarMestra } from '../plataforma/rotacao-chaves';
import * as sp from '../plataforma/schema-plataforma';

const USO = [
  'uso: rotacionar-chaves.js [--dry-run]',
  '     rotacionar-chaves.js --mestra',
  '     rotacionar-chaves.js --kek-preparar --condominio <codigo> --kek-versao-atual <n>',
  '     rotacionar-chaves.js --kek-migrar --condominio <codigo> [--lote <n>]',
  '(chaves só pelo ambiente; docs/deploy-rotacao-chaves.md)',
].join('\n');

export class ErroUso extends Error {}

export type Comando =
  | { modo: 'dry-run' }
  | { modo: 'mestra' }
  | { modo: 'kek-preparar'; codigo: string; versaoAtual: number }
  | { modo: 'kek-migrar'; codigo: string; lote?: number };

const inteiro = (v: string | undefined) => (v !== undefined && /^\d{1,5}$/.test(v) ? Number(v) : null);

export function lerArgs(argv: string[]): Comando {
  const modos = argv.filter((a) => ['--dry-run', '--mestra', '--kek-preparar', '--kek-migrar'].includes(a));
  if (modos.length > 1) throw new ErroUso(USO);
  const modo = modos[0] ?? '--dry-run';
  const valores = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === modo) continue;
    if (!['--condominio', '--kek-versao-atual', '--lote'].includes(a) || argv[i + 1] === undefined || valores.has(a)) throw new ErroUso(USO);
    valores.set(a, argv[++i]!);
  }
  const permitidos: Record<string, string[]> = {
    '--dry-run': [], '--mestra': [], '--kek-preparar': ['--condominio', '--kek-versao-atual'], '--kek-migrar': ['--condominio', '--lote'],
  };
  for (const k of valores.keys()) if (!permitidos[modo]!.includes(k)) throw new ErroUso(USO);
  if (modo === '--dry-run') return { modo: 'dry-run' };
  if (modo === '--mestra') return { modo: 'mestra' };
  const codigo = valores.get('--condominio');
  if (!codigo) throw new ErroUso(USO);
  if (modo === '--kek-preparar') {
    const v = inteiro(valores.get('--kek-versao-atual'));
    if (v === null || v < 1) throw new ErroUso(USO);
    return { modo: 'kek-preparar', codigo, versaoAtual: v };
  }
  let lote: number | undefined;
  if (valores.has('--lote')) {
    const l = inteiro(valores.get('--lote'));
    if (l === null) throw new ErroUso(USO);
    lote = l;
  }
  return { modo: 'kek-migrar', codigo, lote };
}

/** URL do ambiente com o role (e, se pedido, o banco) conferidos. Mensagem cita a variável, nunca o valor. */
function url(env: NodeJS.ProcessEnv, nome: string, role: string, banco?: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new ErroChave(`${nome} não definida`);
  let u: URL;
  try { u = new URL(v); } catch { throw new ErroChave(`${nome} inválida`); }
  if (decodeURIComponent(u.username) !== role) throw new ErroChave(`${nome} precisa usar o role ${role}`);
  if (!u.password) throw new ErroChave(`${nome} sem senha (variável vazia no .env?)`);
  if (banco !== undefined && u.pathname !== `/${banco}`) throw new ErroChave(`${nome} precisa apontar para o banco ${banco}`);
  return v;
}

/** Mestra nova do ambiente, ou null se nenhuma das duas variáveis estiver definida (metade definida = erro). */
export function mestraNovaDoAmbiente(env: NodeJS.ProcessEnv): ChaveMestra | null {
  const temChave = !!env.PORTARIA_CHAVE_MESTRA_NOVA?.trim();
  const temVersao = !!env.PORTARIA_CHAVE_MESTRA_VERSAO_NOVA?.trim();
  if (!temChave && !temVersao) return null;
  return {
    chave: chaveDoAmbiente(env, 'PORTARIA_CHAVE_MESTRA_NOVA', { min: 32, max: 32 }),
    versao: versaoDoAmbiente(env, 'PORTARIA_CHAVE_MESTRA_VERSAO_NOVA'),
  };
}

export interface Ambiente {
  mestra: ChaveMestra;
  nova: ChaveMestra | null;
  plataforma: string | null;
  migratorPlataforma: string | null;
  rwBase: string | null;
}

/** Só as variáveis que o modo usa (o resto pode estar vazio). */
export function lerAmbiente(c: Comando, env: NodeJS.ProcessEnv): Ambiente {
  const mestra = carregarChaveMestra(env);
  let nova: ChaveMestra | null;
  try { nova = mestraNovaDoAmbiente(env); } catch (e) { mestra.chave.fill(0); throw e; }
  const limpar = () => { mestra.chave.fill(0); nova?.chave.fill(0); };
  try {
    if (c.modo === 'mestra' && !nova) throw new ErroChave('PORTARIA_CHAVE_MESTRA_NOVA não definida');
    // A KEK nova tem de nascer embrulhada pela mestra DEFINITIVA: com a nova ainda pendente no shell, a rotação da mestra
    // não terminou (ou o .env não foi atualizado). Recusa em vez de gravar KEK sob a mestra que vazou.
    if (c.modo.startsWith('kek-') && nova) {
      throw new ErroChave('PORTARIA_CHAVE_MESTRA_NOVA ainda definida: conclua a rotação da mestra, atualize o .env e faça unset antes de rotacionar a KEK');
    }
    let migratorPlataforma: string | null = null;
    if (c.modo === 'mestra') {
      const u = new URL(url(env, 'MIGRATOR_URL_BASE', 'app_migrator'));
      u.pathname = '/plataforma';
      migratorPlataforma = u.toString();
    }
    return {
      mestra, nova, migratorPlataforma,
      plataforma: c.modo === 'mestra' ? null : url(env, 'DATABASE_URL_PLATAFORMA', 'app_plataforma', 'plataforma'),
      rwBase: c.modo === 'dry-run' || c.modo === 'kek-migrar' ? url(env, 'DATABASE_URL', 'app_rw') : null,
    };
  } catch (e) {
    limpar();
    throw e;
  }
}

/** Conexões já abertas (CLI: pg; testes: PGlite). */
export interface Portas {
  plataforma?: DbPlataforma;
  migratorPlataforma?: DbPlataforma;
  bancoDe?: (banco: string) => Db;
}

export interface Saida { codigo: 0 | 1; resultado: unknown; mensagem: string }

/** Executa o comando já validado. Não abre conexão nem lê ambiente (o teste chama direto). */
export async function executar(c: Comando, amb: Pick<Ambiente, 'mestra' | 'nova'>, p: Portas, progresso: (m: string) => void = () => undefined): Promise<Saida> {
  const exigir = <T>(x: T | undefined, nome: string): T => { if (!x) throw new Error(`conexão ${nome} não aberta`); return x; };
  switch (c.modo) {
    case 'dry-run': {
      const r = await inspecionar(exigir(p.plataforma, 'plataforma'), amb.mestra, p.bancoDe ?? null, amb.nova);
      const docs = r.condominios.reduce((n, x) => n + (x.documentos?.total ?? 0), 0);
      if (r.falhas) return { codigo: 1, resultado: r, mensagem: `PROBLEMA: ${r.falhas} falha(s) (linhas que não abrem com a mestra v${r.mestraVersao}: ${r.linhasQueNaoAbrem}; segredos TOTP que não abrem: ${r.totp.naoAbrem}). Nada foi alterado.` };
      return { codigo: 0, resultado: r, mensagem: `OK (dry-run): ${r.linhas} linha(s) de condominio_chave e ${r.totp.linhas} segredo(s) TOTP abrem com a mestra v${r.mestraVersao}; ${docs} anexo(s) conferido(s). Nada foi alterado.` };
    }
    case 'mestra': {
      const r = await rotacionarMestra(exigir(p.migratorPlataforma, 'plataforma (app_migrator)'), amb.mestra, amb.nova!);
      return {
        codigo: 0, resultado: r,
        mensagem: r.situacao === 'rotacionada'
          ? `OK: ${r.linhas} linha(s) re-embrulhada(s) e ${r.totp} segredo(s) TOTP re-cifrado(s) com a mestra v${r.mestraVersao} (ida e volta conferida). Agora atualize o .env e reinicie (docs/deploy-rotacao-chaves.md).`
          : `OK: as ${r.linhas} linha(s) já estavam na mestra v${r.mestraVersao} e abrem com ela; nada mudou.`,
      };
    }
    case 'kek-preparar': {
      const r = await prepararKek(exigir(p.plataforma, 'plataforma'), amb.mestra, c.codigo, c.versaoAtual);
      return {
        codigo: 0, resultado: r,
        mensagem: r.situacao === 'preparada'
          ? `OK: condomínio ${r.codigo}: KEK v${r.versaoAtiva} ativa; v${r.versaoAnterior} inativa e ainda legível. Reinicie a API ANTES de --kek-migrar.`
          : `OK: condomínio ${r.codigo}: KEK v${r.versaoAtiva} já era a ativa (v${r.versaoAnterior} registrada); nada mudou.`,
      };
    }
    case 'kek-migrar': {
      const r = await migrarDocumentos(exigir(p.plataforma, 'plataforma'), exigir(p.bancoDe, 'condomínio'), amb.mestra, c.codigo, {
        lote: c.lote, aposLote: (l, n) => progresso(`lote ${l}: ${n} anexo(s) migrado(s) até aqui`),
      });
      const fora = Object.entries(r.porVersao).filter(([v]) => Number(v) !== r.versaoAtiva).reduce((n, [, q]) => n + q, 0);
      if (fora) return { codigo: 1, resultado: r, mensagem: `PROBLEMA: condomínio ${r.codigo}: ${fora} anexo(s) fora da v${r.versaoAtiva} ao final (gravados durante a migração por uma API ainda não reiniciada?). Reinicie a API e rode de novo.` };
      return { codigo: 0, resultado: r, mensagem: `OK: condomínio ${r.codigo}: ${r.migrados} anexo(s) migrado(s) em ${r.lotes} lote(s); todos na KEK v${r.versaoAtiva}.` };
    }
  }
}

async function principal(): Promise<number> {
  let cmd: Comando;
  let amb: Ambiente;
  try {
    cmd = lerArgs(process.argv.slice(2));
    amb = lerAmbiente(cmd, process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return e instanceof ErroUso ? 2 : 1;
  }
  const pools: Pool[] = [];
  const pool = (cs: string) => { const p = new Pool({ connectionString: cs, max: 1, connectionTimeoutMillis: 5000 }); p.on('error', () => undefined); pools.push(p); return p; };
  const bancos = new Map<string, Db>();
  const portas: Portas = {
    plataforma: amb.plataforma ? drizzle(pool(amb.plataforma), { schema: sp }) as unknown as DbPlataforma : undefined,
    migratorPlataforma: amb.migratorPlataforma ? drizzle(pool(amb.migratorPlataforma), { schema: sp }) as unknown as DbPlataforma : undefined,
    bancoDe: amb.rwBase
      ? (banco) => {
        let d = bancos.get(banco);
        if (!d) { d = drizzle(pool(urlDoBanco(amb.rwBase!, banco)), { schema }) as unknown as Db; bancos.set(banco, d); }
        return d;
      }
      : undefined,
  };
  try {
    const s = await executar(cmd, amb, portas, (m) => console.error(m));
    console.log(JSON.stringify(s.resultado, null, 2));
    console.error(s.mensagem);
    return s.codigo;
  } catch (e) {
    // Só a mensagem: as nossas citam nomes e versões, e a do pg não traz senha. Nunca o objeto inteiro.
    console.error(`RECUSADO: ${e instanceof Error ? e.message : String(e)}`);
    console.error('Nada além do que já tinha sido confirmado foi gravado (cada operação é transacional; ver docs/deploy-rotacao-chaves.md).');
    return 1;
  } finally {
    amb.mestra.chave.fill(0);
    amb.nova?.chave.fill(0);
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  }
}

// Só roda como programa (o teste importa as funções).
if (typeof require !== 'undefined' && require.main === module) {
  principal().then((c) => { process.exitCode = c; }, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
