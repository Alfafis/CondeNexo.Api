// Linha de base da cadeia (fase F0, docs/05_arquitetura_saas.md; o que entra em cada arquivo: src/saas/linha-de-base.ts).
// Quem chama na VPS é scripts/saas/linha-de-base.sh, que cifra a saída com a chave pública age. Só leitura: uma
// transação REPEATABLE READ READ ONLY como o role da DATABASE_URL (na VPS, app_rw); nada é gravado no banco.
//
//   gerar:    node dist/cli/linha-de-base.js < selos.jsonl | age -R chave.pub > linha-de-base.tar.age
//             stdout = tar com linha-de-base.json, trilha.jsonl e selos.jsonl. Recusa stdout em terminal (a trilha
//             tem texto livre dos eventos e só pode sair cifrada). O resumo legível (sem dado pessoal) vai para stderr.
//   conferir: node dist/cli/linha-de-base.js --conferir linha-de-base.json < selos.jsonl
//             compara o banco atual (ex.: um restore de teste, ou a produção depois de F2/F3/F4) com uma linha de base
//             anterior; stdout = JSON com o resumo atual, problemas e observações.
//
// Códigos de saída: 0 ok; 4 gerado/conferido MAS com problema (cadeia inválida, âncora divergente, cabeça antiga
// alterada): não seguir para a fase seguinte; 1 erro; 2 uso.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { relogioDoSistema } from '../comum/relogio';
import type { Db } from '../database/database.module';
import * as schema from '../db/schema';
import { compararComReferencia, gerarLinhaDeBase, problemasDaLinhaDeBase, type ResumoLinhaDeBase } from '../saas/linha-de-base';
import { montarTar } from '../saas/tar';

const USO = 'uso: linha-de-base.js [--conferir <linha-de-base.json>] < selos.jsonl';

async function lerEntrada(): Promise<string> {
  const partes: Buffer[] = [];
  for await (const p of process.stdin) partes.push(p as Buffer);
  return Buffer.concat(partes).toString('utf8');
}

function resumoLegivel(r: ResumoLinhaDeBase): string {
  return [
    `cabeça: seq ${r.cabeca.seq} hash ${r.cabeca.hash}`,
    `eventos: ${r.eventos.quantidade} (seq ${r.eventos.primeiroSeq ?? '-'} a ${r.eventos.ultimoSeq ?? '-'})`,
    `verificação interna: ${r.integridade.valido ? 'íntegra' : `INVÁLIDA (${r.integridade.motivo} no seq ${r.integridade.primeiroSeqInvalido})`}, ${r.integridade.selosConferidos} selo(s) conferido(s)`,
    `âncoras do GitHub: ${r.ancoras.conclusao.toUpperCase()} (${r.ancoras.conferidas.length} conferida(s), ${r.ancoras.divergentes.length} divergente(s), ${r.ancoras.foraDoIntervalo} fora do intervalo)`,
    `tabelas: ${Object.keys(r.contagens).length}; última migração: ${r.ultimaMigracao ? new Date(r.ultimaMigracao.criadaEm).toISOString() : 'não visível para este role'}`,
  ].join('\n');
}

async function principal(): Promise<number> {
  const args = process.argv.slice(2);
  const conferir = args[0] === '--conferir' ? args[1] : undefined;
  if (args.length && (args[0] !== '--conferir' || !conferir || args.length !== 2)) { console.error(USO); return 2; }
  if (process.stdin.isTTY) { console.error(`${USO}\nmande o selos.jsonl do branch ancoras pela entrada padrão`); return 2; }
  if (!conferir && process.stdout.isTTY) { console.error('a saída é um tar com a trilha: redirecione para o age (nunca para o terminal)'); return 2; }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL não definida'); return 2; }
  const ref = conferir ? (JSON.parse(readFileSync(conferir, 'utf8')) as ResumoLinhaDeBase) : null;
  const selos = await lerEntrada();

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    // Uma fotografia só: contagens, cabeça, trilha e selos do mesmo instante, e nenhuma escrita possível.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const db = drizzle(client, { schema }) as unknown as Db;
    const lb = await gerarLinhaDeBase(db, selos, relogioDoSistema);
    console.error(resumoLegivel(lb.resumo));
    if (ref) {
      const c = compararComReferencia(lb, ref);
      process.stdout.write(`${JSON.stringify({ resumo: lb.resumo, referencia: { geradoEm: ref.geradoEm, cabeca: ref.cabeca }, ...c }, null, 2)}\n`);
      for (const o of c.observacoes) console.error(`observação: ${o}`);
      for (const p of c.problemas) console.error(`PROBLEMA: ${p}`);
      console.error(c.problemas.length ? 'NÃO CONFERE com a linha de base.' : `CONFERE com a linha de base de ${ref.geradoEm}.`);
      return c.problemas.length ? 4 : 0;
    }
    const agora = new Date(lb.resumo.geradoEm);
    const tar = montarTar([
      { nome: 'linha-de-base.json', conteudo: Buffer.from(`${JSON.stringify(lb.resumo, null, 2)}\n`, 'utf8') },
      { nome: 'trilha.jsonl', conteudo: Buffer.from(lb.trilha, 'utf8') },
      { nome: 'selos.jsonl', conteudo: Buffer.from(selos, 'utf8') },
    ], agora);
    await new Promise<void>((ok, falha) => process.stdout.write(tar, (e) => (e ? falha(e) : ok())));
    const problemas = problemasDaLinhaDeBase(lb.resumo);
    for (const p of problemas) console.error(`PROBLEMA: ${p}`);
    return problemas.length ? 4 : 0;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

principal().then((c) => { process.exitCode = c; }, (e: unknown) => {
  // Só a mensagem: a do pg não traz a senha, e as nossas não trazem dado.
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});
