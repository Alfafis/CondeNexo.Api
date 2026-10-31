// Seed de desenvolvimento: estrutura (unidades, portaria, áreas) + 4 usuários, um por papel e, SÓ com
// PORTARIA_AMBIENTE=dev, pessoas, vínculos e veículos fictícios (seed-pessoas-dev.ts), com o HMAC do CPF pela
// PORTARIA_HMAC_CPF_KEY do ambiente. Idempotente: rodar de novo não duplica nem altera nada.
//   docker compose exec api node dist/cli/seed-dev.js
// Senha de todos: SEED_SENHA_DEV (do .env, nunca no código). deve_trocar_senha=false SÓ com PORTARIA_AMBIENTE=dev;
// em qualquer outro ambiente os usuários nascem obrigados a trocar a senha no primeiro login.
// Roda como app_rw (DATABASE_URL da API): INSERT em usuario_sistema e audit_log já é permitido a ela.
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { problemasDaSenha } from '../auth/senha.service';
import { PADROES_ARGON2 } from '../config/config';
import * as schema from '../db/schema';
import { seedEstrutura } from '../db/seed';
import { seedPessoasDev } from '../db/seed-pessoas-dev';
import { seedUsuariosDev } from '../db/seed-usuarios';
import { chaveHmacDoAmbiente } from '../db/cpf';

async function principal() {
  const url = process.env.DATABASE_URL;
  const senha = process.env.SEED_SENHA_DEV ?? '';
  const ambiente = process.env.PORTARIA_AMBIENTE;
  if (!url) throw new Error('DATABASE_URL não definida');
  if (ambiente !== 'dev' && ambiente !== 'producao') throw new Error("PORTARIA_AMBIENTE deve ser 'dev' ou 'producao'");
  if (!senha) throw new Error('SEED_SENHA_DEV não definida');
  const problemas = problemasDaSenha(senha);
  if (problemas.length) throw new Error(`SEED_SENHA_DEV recusada: ${problemas.join(' ')}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const db = drizzle(pool, { schema });
    await seedEstrutura(db);
    const senhaHash = await hash(senha, { memoryCost: PADROES_ARGON2.memoriaKib, timeCost: PADROES_ARGON2.iteracoes, parallelism: PADROES_ARGON2.paralelismo });
    const criados = await seedUsuariosDev(db, { senhaHash, deveTrocarSenha: ambiente !== 'dev' });
    console.log(criados.length ? `usuários criados: ${criados.join(', ')}` : 'usuários de dev já existiam (nada alterado)');
    if (ambiente === 'dev') {
      const pessoas = await seedPessoasDev(db, { chaveHmac: chaveHmacDoAmbiente() });
      console.log(pessoas.length ? `pessoas fictícias criadas: ${pessoas.length}` : 'pessoas fictícias já existiam (nada alterado)');
    } else {
      console.log('pessoas fictícias: puladas (só com PORTARIA_AMBIENTE=dev)');
    }
  } finally {
    await pool.end();
  }
}

principal().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
