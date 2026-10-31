// Ordem das unidades no SQL, igual à do domain (`compararUnidades`). Módulo à parte para quem lista
// unidades (vínculos, busca) não importar o serviço e criar ciclo.
import { asc, sql, type SQL } from 'drizzle-orm';
import { unidade } from '../db/schema';

/**
 * Chave de ordenação natural do bloco, igual a `chaveBloco` do domain: cada sequência de dígitos com 3 casas
 * ("2" -> "002", "B10" -> "B010"), comparada byte a byte (COLLATE "C", sem depender da collation do banco).
 */
export const chaveBlocoSql = (bloco: SQL | typeof unidade.bloco) =>
  sql`regexp_replace(regexp_replace(${bloco}, '(?<![0-9])([0-9])(?![0-9])', '00\\1', 'g'), '(?<![0-9])([0-9]{2})(?![0-9])', '0\\1', 'g') COLLATE "C"`;

/** Ordem de exibição: bloco (natural), número numérico ("03" antes de "32"), número como texto (desempate). */
export const ORDEM_UNIDADES = [asc(chaveBlocoSql(unidade.bloco)), asc(sql`${unidade.numero}::numeric`), asc(unidade.numero)];
