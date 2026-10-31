// Seed mínimo de estrutura (idempotente): as unidades da estrutura configurada (ESTRUTURA_PADRAO), o ponto de acesso único e as áreas comuns (RF-36), todos a partir de ../dominio/units. Só ACRESCENTA o que falta: banco com outra estrutura usa a CLI recriar-estrutura.
// Usuários e pessoas NÃO são semeados aqui: senha e dados pessoais não vão para o código (RN-05).
import { AREAS_COMUNS_INICIAIS, ESTRUTURA_PADRAO, PORTARIA_SOCIAL, gerarUnidades, type ConfigEstrutura } from '../dominio/units';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { areaComum, pontoAcesso, unidade } from './schema';

export { PORTARIA_SOCIAL };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aceita qualquer driver (PGlite, node-postgres) e schema
export async function seedEstrutura(db: PgDatabase<PgQueryResultHKT, any>, estrutura: ConfigEstrutura = ESTRUTURA_PADRAO) {
  await db.insert(unidade)
    .values(gerarUnidades(estrutura).map((u) => ({ bloco: u.bloco, numero: u.numero })))
    .onConflictDoNothing({ target: [unidade.bloco, unidade.numero] });
  await db.insert(pontoAcesso).values({ nome: PORTARIA_SOCIAL }).onConflictDoNothing({ target: pontoAcesso.nome });
  await db.insert(areaComum).values(AREAS_COMUNS_INICIAIS.map((nome) => ({ nome }))).onConflictDoNothing({ target: areaComum.nome });
}
