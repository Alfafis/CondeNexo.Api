// Registro das anonimizações no banco `plataforma` (LGPD art. 18, VI; docs/deploy.md seção 9). Existe por causa do
// restore: a lista de quem foi anonimizado vivia só no banco do condomínio (pessoa.anonimizada_em, retencao_execucao),
// e voltar um backup de antes do pedido desfazia a anonimização sem ninguém perceber. Aqui fica só
// (condominio_id, pessoa_id, motivo, quando): nenhum dado pessoal, e o pessoa_id aponta para uma linha já anonimizada.
//
// Gravação em dois caminhos, ambos idempotentes (ON CONFLICT DO NOTHING; a tabela é append-only):
//  1. logo depois do COMMIT da anonimização (a pedido ou pela retenção). Sem transação distribuída: se a plataforma
//     estiver fora, a anonimização vale do mesmo jeito e só o registro atrasa;
//  2. na retenção diária, que copia de `retencao_execucao` (tipo 'pessoas') tudo o que faltar. Fecha a janela do item 1.
// A leitura (`doCondominio`) alimenta a reaplicação depois de um restore (RetencaoService.reaplicarAnonimizacoes).
//
// Este é o segundo serviço, depois do ResolvedorCondominio, autorizado a injetar PLATAFORMA_DB (teste de arquitetura
// em test/saas-isolamento.test.ts). Só toca a tabela `lgpd_anonimizacao`.
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type DbPlataforma, PLATAFORMA_DB } from './plataforma-db';
import { lgpdAnonimizacao } from './schema-plataforma';

export interface AnonimizacaoRegistrada { pessoaId: string; motivo: 'pedido' | 'retencao'; anonimizadaEm: Date }

@Injectable()
export class RegistroAnonimizacoes {
  constructor(@Inject(PLATAFORMA_DB) private readonly db: DbPlataforma) {}

  /** Grava o que ainda não está registrado. Devolve quantas linhas eram novas. */
  async registrar(condominioId: string, itens: AnonimizacaoRegistrada[]): Promise<number> {
    let novas = 0;
    for (let i = 0; i < itens.length; i += 500) {
      const lote = itens.slice(i, i + 500);
      const r = await this.db.insert(lgpdAnonimizacao)
        .values(lote.map((x) => ({ condominioId, pessoaId: x.pessoaId, motivo: x.motivo, anonimizadaEm: x.anonimizadaEm })))
        .onConflictDoNothing().returning({ p: lgpdAnonimizacao.pessoaId });
      novas += r.length;
    }
    return novas;
  }

  async doCondominio(condominioId: string): Promise<AnonimizacaoRegistrada[]> {
    const linhas = await this.db.select({ pessoaId: lgpdAnonimizacao.pessoaId, motivo: lgpdAnonimizacao.motivo, anonimizadaEm: lgpdAnonimizacao.anonimizadaEm })
      .from(lgpdAnonimizacao).where(eq(lgpdAnonimizacao.condominioId, condominioId)).orderBy(lgpdAnonimizacao.anonimizadaEm);
    return linhas.map((l) => ({ ...l, motivo: l.motivo as AnonimizacaoRegistrada['motivo'] }));
  }
}
