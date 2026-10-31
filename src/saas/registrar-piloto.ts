// Registro do condomínio-piloto no banco `plataforma` (docs/05_arquitetura_saas.md, fase F1; SAAS-04 "Piloto"):
// a linha de `condominio` com `banco = 'portaria'` (o banco de hoje, sem renomear nada) e as chaves ATUAIS do ambiente
// (`PORTARIA_HMAC_CPF_KEY`, `PORTARIA_KEK`) embrulhadas pela chave mestra. Nenhum `documento_busca` nem DEK é
// recalculado: a KEK entra com a MESMA versão de hoje (`PORTARIA_KEK_VERSAO`, que está em `documento.chave_versao` e na
// AAD das DEKs), e a HMAC entra como v1.
//
// Idempotente e conservador: rodar de novo com as mesmas chaves não muda nada; com chave, código ou banco diferentes,
// recusa e não grava (nunca sobrescreve chave registrada). Tudo numa transação, que só confirma depois de desembrulhar
// o que gravou e comparar com o ambiente (ida e volta). O resultado leva só ids, versões e impressões digitais.
import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { CODIGO_CONDOMINIO as CODIGO } from '../dominio/condominio';
import {
  type ChaveMestra, desembrulhar, embrulhar, ErroChave, type IdChave, impressaoDigital, mesmaChave,
} from './chave-mestra';
import * as sp from './schema-plataforma';

export type DbPlataforma = PgDatabase<PgQueryResultHKT, typeof sp>;

/** O banco do piloto. Fixo: é o banco que existe hoje em produção. */
export const BANCO_PILOTO = 'portaria';

export interface EntradaPiloto {
  codigo: string;
  nome: string;
  plano: string;
  hmacCpf: Buffer;
  kek: Buffer;
  kekVersao: number;
  mestra: ChaveMestra;
}

export interface ResultadoPiloto {
  situacao: 'registrado' | 'ja_registrado';
  condominioId: string;
  codigo: string;
  banco: string;
  chaves: { tipo: sp.TipoChave; versao: number; mestraVersao: number; impressao: string }[];
}

function validar(e: EntradaPiloto) {
  if (!CODIGO.test(e.codigo)) throw new ErroChave('código do condomínio: 3 a 31 caracteres, a-z, 0-9 e hífen, começando por letra');
  if (!e.nome.trim() || e.nome.trim().length > 200) throw new ErroChave('nome do condomínio: 1 a 200 caracteres');
  if (!e.plano.trim()) throw new ErroChave('plano não informado');
  // Reuso de chave entre finalidades (ex.: mestra colada igual à KEK) anularia o envelope.
  if (mesmaChave(e.mestra.chave, e.kek) || mesmaChave(e.mestra.chave, e.hmacCpf.subarray(0, 32)) || mesmaChave(e.kek, e.hmacCpf.subarray(0, 32))) {
    throw new ErroChave('chave mestra, KEK e HMAC do CPF precisam ser diferentes entre si');
  }
}

export async function registrarPiloto(db: DbPlataforma, e: EntradaPiloto): Promise<ResultadoPiloto> {
  validar(e);
  const esperadas: { tipo: sp.TipoChave; versao: number; chave: Buffer }[] = [
    { tipo: 'hmac_cpf', versao: 1, chave: e.hmacCpf },
    { tipo: 'kek_documentos', versao: e.kekVersao, chave: e.kek },
  ];
  return db.transaction(async (tx) => {
    const [porBanco] = await tx.select().from(sp.condominio).where(eq(sp.condominio.banco, BANCO_PILOTO));
    const [porCodigo] = await tx.select().from(sp.condominio).where(eq(sp.condominio.codigo, e.codigo));
    if (porCodigo && porCodigo.banco !== BANCO_PILOTO) throw new ErroChave(`o código ${e.codigo} já pertence a outro condomínio`);
    if (porBanco && porBanco.codigo !== e.codigo) throw new ErroChave(`o piloto já está registrado com outro código (${porBanco.codigo}): nada foi alterado`);

    let situacao: ResultadoPiloto['situacao'] = 'ja_registrado';
    let condominioId: string;
    if (porBanco) {
      condominioId = porBanco.id;
    } else {
      const [c] = await tx.insert(sp.condominio).values({
        codigo: e.codigo, nome: e.nome.trim(), banco: BANCO_PILOTO, status: 'ativo', plano: e.plano.trim(),
      }).returning({ id: sp.condominio.id });
      condominioId = c!.id;
      for (const k of esperadas) {
        const emb = embrulhar(e.mestra, { condominioId, tipo: k.tipo, versao: k.versao }, k.chave);
        await tx.insert(sp.condominioChave).values({ condominioId, tipo: k.tipo, versao: k.versao, ...emb, ativa: true });
      }
      situacao = 'registrado';
    }

    // Ida e volta (no registro novo) ou conferência (no repetido): a chave ativa de cada tipo, desembrulhada, tem de
    // ser byte a byte a do ambiente, na mesma versão. Qualquer diferença aborta a transação.
    const chaves: ResultadoPiloto['chaves'] = [];
    for (const k of esperadas) {
      const [l] = await tx.select().from(sp.condominioChave)
        .where(and(eq(sp.condominioChave.condominioId, condominioId), eq(sp.condominioChave.tipo, k.tipo), eq(sp.condominioChave.ativa, true)));
      if (!l) throw new ErroChave(`piloto registrado sem chave ativa de ${k.tipo}: conferir à mão (nada foi alterado)`);
      if (l.versao !== k.versao) throw new ErroChave(`a chave ativa de ${k.tipo} é a v${l.versao}, o ambiente informa a v${k.versao}: nada foi alterado`);
      const id: IdChave = { condominioId, tipo: k.tipo, versao: l.versao };
      const claro = desembrulhar(e.mestra, id, l);
      try {
        if (!mesmaChave(claro, k.chave)) throw new ErroChave(`a chave ${k.tipo} registrada é diferente da do ambiente: nada foi alterado`);
      } finally {
        claro.fill(0);
      }
      chaves.push({ tipo: k.tipo, versao: l.versao, mestraVersao: l.mestraVersao, impressao: impressaoDigital(k.chave) });
    }

    if (situacao === 'registrado') {
      await tx.insert(sp.plataformaAudit).values({
        acao: 'condominio.registrarPiloto', condominioId,
        detalhes: { banco: BANCO_PILOTO, origem: 'cli', chaves: chaves.map(({ tipo, versao, mestraVersao }) => ({ tipo, versao, mestraVersao })) },
      });
    }
    return { situacao, condominioId, codigo: e.codigo, banco: BANCO_PILOTO, chaves };
  });
}
