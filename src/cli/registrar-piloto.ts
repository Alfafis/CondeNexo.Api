// Registra o condomínio-piloto no banco `plataforma` e importa as chaves atuais como versão de hoje (fase F1,
// docs/05_arquitetura_saas.md; regras em src/saas/registrar-piloto.ts). Não mexe no banco `portaria` nem na API.
//
//   docker compose --profile plataforma run --rm plataforma-cli \
//     node dist/cli/registrar-piloto.js --codigo <slug> --nome "<nome exibido>" [--plano piloto]
//
// Ambiente (o serviço plataforma-cli do compose repassa do .env; nada vem por argumento):
//   DATABASE_URL_PLATAFORMA        app_plataforma no banco `plataforma`
//   PORTARIA_CHAVE_MESTRA(_VERSAO) chave mestra (base64 de 32 bytes) e a versão dela
//   PORTARIA_HMAC_CPF_KEY, PORTARIA_KEK, PORTARIA_KEK_VERSAO   as chaves que a API usa hoje
// Saída: JSON com ids, versões e impressões digitais (nunca a chave). Códigos: 0 ok (registrado ou já registrado com as
// mesmas chaves); 1 recusado (nada gravado); 2 uso.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { carregarChaveMestra, chaveDoAmbiente, ErroChave, versaoDoAmbiente } from '../saas/chave-mestra';
import { type DbPlataforma, type EntradaPiloto, registrarPiloto } from '../saas/registrar-piloto';
import * as sp from '../saas/schema-plataforma';

const USO = 'uso: registrar-piloto.js --codigo <slug> --nome "<nome exibido>" [--plano <plano>]';

export class ErroUso extends Error {}

/** Argumentos e ambiente -> entrada validada. Mensagens citam nomes de variável, nunca valores. */
export function lerEntrada(argv: string[], env: NodeJS.ProcessEnv): { entrada: EntradaPiloto; url: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!['--codigo', '--nome', '--plano'].includes(k) || v === undefined) throw new ErroUso(USO);
    args.set(k, v);
  }
  const codigo = args.get('--codigo');
  const nome = args.get('--nome');
  if (!codigo || !nome) throw new ErroUso(USO);
  const url = env.DATABASE_URL_PLATAFORMA?.trim();
  if (!url) throw new ErroChave('DATABASE_URL_PLATAFORMA não definida');
  let u: URL;
  try { u = new URL(url); } catch { throw new ErroChave('DATABASE_URL_PLATAFORMA inválida'); }
  // Salvaguarda: o registro é no banco da plataforma, nunca no de um condomínio.
  if (u.pathname !== '/plataforma') throw new ErroChave('DATABASE_URL_PLATAFORMA precisa apontar para o banco plataforma');
  if (!u.password) throw new ErroChave('DATABASE_URL_PLATAFORMA sem senha (APP_PLATAFORMA_PASSWORD vazia no .env?)');
  return {
    url,
    entrada: {
      codigo, nome, plano: args.get('--plano') ?? 'piloto',
      hmacCpf: chaveDoAmbiente(env, 'PORTARIA_HMAC_CPF_KEY', { min: 32, max: 128 }),
      kek: chaveDoAmbiente(env, 'PORTARIA_KEK', { min: 32, max: 32 }),
      kekVersao: versaoDoAmbiente(env, 'PORTARIA_KEK_VERSAO'),
      mestra: carregarChaveMestra(env),
    },
  };
}

async function principal(): Promise<number> {
  let lido: ReturnType<typeof lerEntrada>;
  try {
    lido = lerEntrada(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return e instanceof ErroUso ? 2 : 1;
  }
  const pool = new Pool({ connectionString: lido.url, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const r = await registrarPiloto(drizzle(pool, { schema: sp }) as unknown as DbPlataforma, lido.entrada);
    console.log(JSON.stringify(r, null, 2));
    console.error(r.situacao === 'registrado'
      ? 'OK: piloto registrado no banco plataforma. Confira as impressões com a cópia do cofre (docs/deploy.md, seção 12).'
      : 'OK: piloto já estava registrado com estas mesmas chaves; nada mudou.');
    return 0;
  } catch (e) {
    // Só a mensagem: as nossas citam nomes, e a do pg não traz a senha.
    console.error(`RECUSADO: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    lido.entrada.hmacCpf.fill(0);
    lido.entrada.kek.fill(0);
    lido.entrada.mestra.chave.fill(0);
    await pool.end();
  }
}

// Só roda como programa (o teste importa lerEntrada).
if (typeof require !== 'undefined' && require.main === module) {
  principal().then((c) => { process.exitCode = c; }, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
