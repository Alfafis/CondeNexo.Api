// Troca TODAS as unidades do banco pela estrutura configurada (ESTRUTURA_PADRAO de ../dominio/units), para o
// banco que nasceu com a estrutura antiga (165 unidades em torres 1..9) e ainda não tem uso nenhum de unidade.
//
//   docker compose run --rm --no-deps api node dist/cli/recriar-estrutura.js              simula (nada é gravado)
//   docker compose run --rm --no-deps api node dist/cli/recriar-estrutura.js --aplicar    aplica
//
// Regras:
// - só substitui se NENHUMA unidade tiver referência (vínculo, evento, encomenda, veículo, autorização, restrição,
//   ocorrência; a lista vem das FKs do banco, em unidade_descartar_estrutura(), migração 0005). Senão recusa e não
//   muda nada: com uso, o caminho é o CRUD de unidades (desativar e cadastrar);
// - idempotente: se o banco já tem exatamente a estrutura configurada (todas ativas), não faz nada;
// - tudo numa transação: apaga, insere a estrutura nova e grava o audit_log (unidade.recriarEstrutura), ou nada;
// - a simulação roda o mesmo caminho e desfaz (ROLLBACK): o que ela diz é o que o --aplicar faria.
// Roda como app_rw (DATABASE_URL da API): o DELETE é da função SECURITY DEFINER, o resto o app_rw já pode.
// Códigos de saída: 0 aplicado, simulado ou nada a fazer; 2 recusado (unidade referenciada); 1 erro.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ESTRUTURA_PADRAO } from '../dominio/units';
import { codigoPg } from '../comum/erros';
import { recriarEstrutura } from '../db/recriar-estrutura';
import * as schema from '../db/schema';

async function principal(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');
  const args = process.argv.slice(2);
  const desconhecidos = args.filter((a) => a !== '--aplicar');
  if (desconhecidos.length) throw new Error(`argumento desconhecido: ${desconhecidos.join(' ')} (uso: recriar-estrutura.js [--aplicar])`);

  const e = ESTRUTURA_PADRAO;
  const descricao = `${e.agrupamento.toLowerCase()}s ${e.blocos.join(', ')}`;
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const r = await recriarEstrutura(drizzle(pool, { schema }), e, args.includes('--aplicar'));
    if (r.resultado === 'nada_a_fazer') console.log(`NADA A FAZER: o banco já tem as ${r.antes} unidades da estrutura configurada.`);
    else if (r.resultado === 'simulado') console.log(`SIMULAÇÃO (nada gravado): ${r.antes} unidade(s) seriam trocadas por ${r.depois} (${descricao}). Para aplicar: --aplicar`);
    else console.log(`APLICADO: ${r.antes} unidade(s) trocadas por ${r.depois} (${descricao}). Registrado no audit_log (unidade.recriarEstrutura).`);
    return 0;
  } catch (erro) {
    if (codigoPg(erro) === '23503') {
      console.error(`RECUSADO: ${mensagemPg(erro)}. Nada foi alterado. Com unidades em uso, ajuste pelo CRUD de unidades `
        + '(desativar e cadastrar) ou pela importação.');
      return 2;
    }
    throw erro;
  } finally {
    await pool.end();
  }
}

/** Mensagem do RAISE da função (o erro do driver pode vir embrulhado pelo Drizzle em `cause`). */
function mensagemPg(e: unknown): string {
  const c = (e as { cause?: unknown })?.cause ?? e;
  return c instanceof Error ? c.message : String(c);
}

principal().then((c) => { process.exitCode = c; }, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
