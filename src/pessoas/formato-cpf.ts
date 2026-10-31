// Qual formato de máscara um CPF recebe (decisão de 2026-10-24; formatos em ../dominio/cpf). Regra anti-reconstrução:
// o mesmo CPF nunca pode aparecer nos dois formatos em lugar nenhum (pessoa, audit_log, exportação), porque o antigo
// (dígitos 4 a 9) mais o novo (1 a 5) dão os 9 primeiros e, com os verificadores, o CPF inteiro.
//   1. Pessoa que já tem máscara e corrige o CPF: continua no formato que tem (o "antes" da trilha está nele). Antigo
//      gera antigo, novo gera novo, mesmo que o CPF corrigido seja outro (erro de digitação: perto do anterior).
//   2. Cadastro novo, importação ou pessoa sem máscara (sem CPF, menor sem CPF) que passa a informar: formato novo,
//      SALVO se a máscara antiga DESTE CPF já existe em algum lugar (outra pessoa, ou o "antes"/"depois" de uma correção
//      na trilha: quem corrigiu o CPF libera o número antigo, e a máscara antiga dele fica no audit_log). Aí, antigo.
//      Falso positivo (outro CPF com os mesmos dígitos 4 a 9) só faz a pessoa nascer no formato antigo, que é permitido.
// A regra 1 vence a 2: a mesma pessoa nunca mistura formatos na própria trilha, que é o vazamento mais provável.
import { sql } from 'drizzle-orm';
import { formatoDaMascara, mascararCpf, type FormatoMascaraCpf } from '../db/cpf';
import { auditLog, pessoa } from '../db/schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- transação ou banco, de qualquer driver
type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<any> };

/**
 * Máscaras no formato antigo existentes no banco: na tabela pessoa e em qualquer snapshot do audit_log. Uma consulta só
 * (a importação chama uma vez para o lote). O conjunto só cresce com correção de quem já está no formato antigo.
 */
export async function mascarasAntigasEmUso(exec: Exec): Promise<Set<string>> {
  const r = await exec.execute(sql`
    SELECT ${pessoa.documentoMascarado} AS m FROM ${pessoa} WHERE ${pessoa.documentoMascarado} LIKE '***.%'
    UNION
    SELECT (regexp_matches(coalesce(${auditLog.antes}::text, '') || ' ' || coalesce(${auditLog.depois}::text, ''),
      '\\*\\*\\*\\.[0-9]{3}\\.[0-9]{3}-\\*\\*', 'g'))[1] AS m
      FROM ${auditLog} WHERE coalesce(${auditLog.antes}::text, '') || coalesce(${auditLog.depois}::text, '') LIKE '%***.%'`);
  const linhas: { m: string }[] = Array.isArray(r) ? r : r.rows;
  return new Set(linhas.map((l) => l.m));
}

/** Formato para gravar `cpf` (11 dígitos válidos) numa pessoa cuja máscara atual é `mascaraAtual` (null se não tem). */
export function formatoParaCpf(cpf: string, mascaraAtual: string | null | undefined, antigasEmUso: Set<string>): FormatoMascaraCpf {
  const atual = formatoDaMascara(mascaraAtual);
  if (atual) return atual;
  return antigasEmUso.has(mascararCpf(cpf, 'meio')) ? 'meio' : 'inicio';
}

/** Atalho: consulta o banco e devolve a máscara já no formato certo. */
export async function mascaraParaCpf(exec: Exec, cpf: string, mascaraAtual: string | null | undefined): Promise<string> {
  return mascararCpf(cpf, formatoParaCpf(cpf, mascaraAtual, await mascarasAntigasEmUso(exec)));
}
