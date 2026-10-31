// Cria um usuário da plataforma, o "Master", ou reemite a senha dele (docs/05_arquitetura_saas.md SAAS-07/08;
// docs/deploy.md seção 18). Regras em src/master/usuario-plataforma.ts. Na VPS, num TERMINAL COMUM (nunca pelo `!` do
// Claude Code nem por ferramenta que guarde a saída: ela traz a senha temporária):
//
//   docker compose --profile plataforma run --rm usuario-plataforma-cli --email <e-mail> --nome "<nome>" [--papel master|suporte]
//   docker compose --profile plataforma run --rm usuario-plataforma-cli --email <e-mail> --nova-senha
//
// Ambiente: DATABASE_URL_PLATAFORMA (app_plataforma no banco plataforma). Saída: a senha temporária (72 h, troca
// obrigatória no primeiro login, a nova com 16+ caracteres), UMA vez; nada fica gravado em claro. Sem segundo fator desde
// 2026-10-23 (SAAS-08): não há segredo TOTP nem --reemitir-totp. Códigos: 0 ok; 1 recusa; 2 uso.
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { gerarSenhaTemporaria } from '../auth/senha.service';
import { PADROES_ARGON2 } from '../config/config';
import { type DbPlataforma, urlPlataforma } from '../saas/plataforma-db';
import * as sp from '../saas/schema-plataforma';
import { type Credenciais, criarUsuario, ErroUsuarioPlataforma, reemitirSenha, validarCadastro } from '../master/usuario-plataforma';

const USO = [
  'uso: criar-usuario-plataforma.js --email <e-mail> --nome "<nome>" [--papel master|suporte]',
  '     criar-usuario-plataforma.js --email <e-mail> --nova-senha',
].join('\n');

export class ErroUsoCli extends Error {}

export interface ArgsCli { email?: string; nome?: string; papel?: string; novaSenha: boolean }

export function lerArgsUsuario(argv: string[]): ArgsCli {
  const a: ArgsCli = { novaSenha: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if ((k === '--email' || k === '--nome' || k === '--papel') && v !== undefined && !v.startsWith('--')) {
      a[k.slice(2) as 'email' | 'nome' | 'papel'] = v;
      i++;
    } else if (k === '--nova-senha') a.novaSenha = true;
    else throw new ErroUsoCli(USO);
  }
  if (!a.email) throw new ErroUsoCli(USO);
  if (a.novaSenha && (a.nome || a.papel)) throw new ErroUsoCli(`${USO}\n(--nome e --papel só na criação)`);
  if (!a.novaSenha && !a.nome) throw new ErroUsoCli(USO);
  return a;
}

/** Bloco do terminal: a senha temporária, uma vez. */
export function textoCredenciais(c: Credenciais, criado: boolean): string {
  const linhas = ['', '============ CREDENCIAIS DA PLATAFORMA (mostradas UMA vez; não ficam guardadas) ============',
    `  ${criado ? 'usuário criado' : 'senha reemitida'}: ${c.email}`];
  if (c.senhaTemporaria) linhas.push(`  senha temporária:      ${c.senhaTemporaria}`, `  válida até:            ${c.senhaExpiraEm} (troca obrigatória no primeiro login)`);
  linhas.push(criado ? '  Entregue por canal fora do sistema.' : '  Entregue por canal fora do sistema. Sessões abertas deste usuário foram encerradas.',
    '=============================================================================================', '');
  return linhas.join('\n');
}

async function principal(): Promise<number> {
  let args: ArgsCli;
  let url: string;
  try {
    args = lerArgsUsuario(process.argv.slice(2));
    url = urlPlataforma(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return e instanceof ErroUsoCli ? 2 : 1;
  }
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => undefined);
  try {
    const db = drizzle(pool, { schema: sp }) as unknown as DbPlataforma;
    const f = {
      hashSenha: (s: string) => hash(s, { memoryCost: PADROES_ARGON2.memoriaKib, timeCost: PADROES_ARGON2.iteracoes, parallelism: PADROES_ARGON2.paralelismo }),
      gerarSenha: () => gerarSenhaTemporaria(),
    };
    const c = args.novaSenha ? await reemitirSenha(db, f, args.email!) : await criarUsuario(db, f, validarCadastro(args));
    console.log(textoCredenciais(c, !args.novaSenha));
    return 0;
  } catch (e) {
    if (e instanceof ErroUsuarioPlataforma) { console.error(`RECUSADO: ${e.message}`); return 1; }
    console.error(`RECUSADO: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  principal().then((c) => { process.exitCode = c; }, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
