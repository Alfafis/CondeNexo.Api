// SaaS nos testes (fase F2): banco `plataforma` em PGlite próprio, condomínios registrados com chaves embrulhadas pela
// mestra de teste, e um registro de bancos que entrega o PGlite de cada condomínio. A API de teste sobe com o
// ResolvedorCondominio, a estratégia de contexto e os providers duráveis DE VERDADE: só a origem das conexões muda.
import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/database/database.module';
import { REGISTRO_BANCOS, type RegistroBancos } from '../../src/database/registro-bancos';
import { type ChaveMestra, embrulhar } from '../../src/saas/chave-mestra';
import type { CondominioResolvido } from '../../src/saas/condominio';
import { contextoDoJob } from '../../src/saas/contexto';
import { CHAVE_MESTRA, type DbPlataforma, PLATAFORMA_DB, PLATAFORMA_POOL } from '../../src/saas/plataforma-db';
import { BANCO_PILOTO, registrarPiloto } from '../../src/saas/registrar-piloto';
import { ResolvedorCondominio } from '../../src/saas/resolvedor';
import * as sp from '../../src/saas/schema-plataforma';

export const MESTRA_TESTE: ChaveMestra = { chave: Buffer.alloc(32, 5), versao: 1 };
export const KEK_TESTE = Buffer.alloc(32, 9);
export const CODIGO_PILOTO = 'piloto';
/** Segundo condomínio dos testes de isolamento: chaves próprias, diferentes das do piloto. */
export const DEMO = { codigo: 'demo', banco: 'portaria_demo0001', hmac: Buffer.alloc(32, 11), kek: Buffer.alloc(32, 13) } as const;

export interface NovoCondominio {
  codigo: string;
  banco: string;
  hmac: Buffer;
  kek: Buffer;
  kekVersao?: number;
  status?: (typeof sp.STATUS_CONDOMINIO)[number];
}

/** Registra um condomínio (o piloto pela CLI de verdade; os demais como fará o onboarding da F5). Devolve o id. */
export async function registrarCondominio(db: DbPlataforma, c: NovoCondominio, mestra = MESTRA_TESTE): Promise<string> {
  const kekVersao = c.kekVersao ?? 1;
  let id: string;
  if (c.banco === BANCO_PILOTO) {
    id = (await registrarPiloto(db, { codigo: c.codigo, nome: 'Condomínio de teste', plano: 'piloto', hmacCpf: c.hmac, kek: c.kek, kekVersao, mestra })).condominioId;
  } else {
    const [l] = await db.insert(sp.condominio).values({ codigo: c.codigo, nome: `Condomínio ${c.codigo}`, banco: c.banco, status: 'ativo', plano: 'teste' })
      .returning({ id: sp.condominio.id });
    id = l!.id;
    for (const [tipo, chave, versao] of [['hmac_cpf', c.hmac, 1], ['kek_documentos', c.kek, kekVersao]] as const) {
      await db.insert(sp.condominioChave).values({ condominioId: id, tipo, versao, ...embrulhar(mestra, { condominioId: id, tipo, versao }, chave), ativa: true });
    }
  }
  if (c.status && c.status !== 'ativo') {
    await db.update(sp.condominio).set({ status: c.status, encerradoEm: ['encerrado', 'excluido'].includes(c.status) ? new Date() : null })
      .where(eq(sp.condominio.id, id));
  }
  return id;
}

/** Bancos de condomínio dos testes: nome do banco -> Db (PGlite). Sem pool: a trava de job roda direto. */
export class RegistroDeTeste implements RegistroBancos {
  constructor(readonly bancos: Map<string, Db>, private readonly aoFechar: () => Promise<void> = async () => undefined) {}
  db(banco: string): Db {
    const d = this.bancos.get(banco);
    if (!d) throw new Error(`banco de teste não registrado: ${banco}`);
    return d;
  }
  pool() { return null; }
  async fechar() { await this.aoFechar(); }
}

/** Troca só a ORIGEM das conexões (plataforma, bancos, mestra); o resto do SaaS é o de produção. */
export function comSaas(b: TestingModuleBuilder, o: { plataforma: DbPlataforma; registro: RegistroBancos; fecharPlataforma?: () => Promise<void> }) {
  return b
    .overrideProvider(REGISTRO_BANCOS).useValue(o.registro)
    .overrideProvider(PLATAFORMA_POOL).useValue({ end: o.fecharPlataforma ?? (async () => undefined) })
    .overrideProvider(PLATAFORMA_DB).useValue(o.plataforma)
    .overrideProvider(CHAVE_MESTRA).useValue(MESTRA_TESTE);
}

/** Serviço durável resolvido na subárvore do condomínio (a mesma das requisições dele). Padrão: o piloto. */
export async function servicoDe<T>(app: INestApplication, token: unknown, condominio?: CondominioResolvido): Promise<T> {
  const c = condominio ?? (await app.get(ResolvedorCondominio).piloto())?.condominio;
  if (!c) throw new Error('teste: condomínio não resolvido');
  return app.resolve<T>(token as never, contextoDoJob(app, c), { strict: false });
}


/** Plataforma (PGlite) só com o piloto, nas chaves de teste de sempre (CHAVE_HMAC_TESTE, KEK_TESTE). */
export async function plataformaComPiloto() {
  const { novoBancoPlataforma } = await import('./plataforma');
  const { CHAVE_HMAC_TESTE } = await import('./banco');
  const p = await novoBancoPlataforma();
  const pilotoId = await registrarCondominio(p.db, { codigo: CODIGO_PILOTO, banco: BANCO_PILOTO, hmac: CHAVE_HMAC_TESTE, kek: KEK_TESTE });
  return { ...p, pilotoId };
}

/** Registro com um banco Postgres REAL (test:pg) no lugar do `portaria`: pool de verdade (a trava de job usa). */
export function registroDePool(pool: import('pg').Pool, db: Db): RegistroBancos {
  return {
    db: (banco) => { if (banco !== BANCO_PILOTO) throw new Error(`banco de teste não registrado: ${banco}`); return db; },
    pool: () => pool,
    fechar: () => pool.end(),
  };
}
