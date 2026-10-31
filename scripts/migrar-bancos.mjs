// Laço de migração do SaaS (docs/05_arquitetura_saas.md SAAS-16, fase F2): serviço `migrate` do compose, como
// app_migrator. Primeiro o banco `plataforma` (drizzle-plataforma/), depois cada banco de condomínio (drizzle/), em
// série. Falhou um: para ali e sai com 1. O compose só sobe a API nova se este processo terminar com 0, então um
// deploy interrompido no meio deixa a API velha no ar (as migrações são expand/contract: a versão N roda no schema N-1).
//
// Bancos de condomínio migrados: `portaria` (o piloto, que existe desde antes do SaaS, registrado ou não) e todo
// `condominio.banco` com status ativo, suspenso ou encerrado. `provisionando` é migrado pela CLI de onboarding (F5),
// e `excluido` já não tem banco. Nome fora do formato do CHECK da plataforma: recusa (nunca vira argumento de URL).
//
//   MIGRATOR_URL_BASE=postgres://app_migrator:<senha>@db:5432 node scripts/migrar-bancos.mjs
// Saída: uma linha por banco (só nomes de banco; a URL com a senha nunca é impressa).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const NOME_BANCO = /^portaria(_[a-z0-9]{8})?$/;
export const STATUS_MIGRADOS = ['ativo', 'suspenso', 'encerrado'];

/** Ordem: o piloto primeiro (é o banco de produção hoje), depois os demais em ordem alfabética. Sem repetição. */
export function bancosParaMigrar(linhas, existentes) {
  const lista = new Set();
  if (existentes.includes('portaria')) lista.add('portaria');
  for (const l of [...linhas].sort((a, b) => a.banco.localeCompare(b.banco))) {
    if (!STATUS_MIGRADOS.includes(l.status)) continue;
    if (!NOME_BANCO.test(l.banco)) throw new Error(`banco fora do formato na plataforma: ${JSON.stringify(l.banco).slice(0, 40)}`);
    if (!existentes.includes(l.banco)) throw new Error(`o banco ${l.banco} (status ${l.status}) não existe no cluster`);
    lista.add(l.banco);
  }
  return [...lista];
}

export function urlDoBanco(base, banco) {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  return u.toString();
}

function migrar(base, banco, config) {
  const args = ['drizzle-kit', 'migrate', ...(config ? ['--config', config] : [])];
  // stdio herdado: o drizzle-kit não imprime a URL. A variável vai só no ambiente do filho.
  const r = spawnSync('npx', args, { stdio: 'inherit', env: { ...process.env, DATABASE_URL_MIGRATOR: urlDoBanco(base, banco) } });
  return r.status === 0;
}

async function principal() {
  const base = process.env.MIGRATOR_URL_BASE?.trim();
  if (!base) { console.error('MIGRATOR_URL_BASE não definida'); return 2; }
  console.log('migrar-bancos: plataforma');
  if (!migrar(base, 'plataforma', 'drizzle-plataforma.config.ts')) { console.error('FALHOU: plataforma (nenhum banco de condomínio foi tocado)'); return 1; }

  const c = new pg.Client({ connectionString: urlDoBanco(base, 'plataforma') });
  let bancos;
  try {
    await c.connect();
    const linhas = (await c.query('SELECT banco, status FROM condominio')).rows;
    const existentes = (await c.query('SELECT datname FROM pg_database')).rows.map((r) => r.datname);
    bancos = bancosParaMigrar(linhas, existentes);
  } finally {
    await c.end().catch(() => undefined);
  }
  for (const [i, banco] of bancos.entries()) {
    console.log(`migrar-bancos: ${banco} (${i + 1}/${bancos.length})`);
    if (!migrar(base, banco)) {
      console.error(`FALHOU: ${banco}. Migrados antes dele: ${bancos.slice(0, i).join(', ') || 'nenhum'}. Os seguintes não foram tocados.`);
      return 1;
    }
  }
  console.log(`migrar-bancos: ok (plataforma + ${bancos.length} condomínio(s))`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  principal().then((codigo) => { process.exitCode = codigo; }, (e) => {
    // Só a mensagem: a do pg não traz a senha.
    console.error(`FALHOU: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
