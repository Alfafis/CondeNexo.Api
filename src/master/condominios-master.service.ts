// Cadastro de condomínios pelo Master (entrega 1 da F5): listar, criar (provisionar) e ligar/desligar módulos. Só o banco
// `plataforma` (pool app_plataforma) e, para criar, o serviço provisionador (provisionador.ts). Nenhum dado pessoal sai
// daqui: a lista não traz síndico nem contrato. A senha temporária do síndico atravessa esta classe UMA vez, do
// provisionador para a resposta, sem log nem trilha.
import { Inject, Injectable } from '@nestjs/common';
import { MODULOS, type Modulo } from '../dominio/modulos';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { type DbPlataforma, PLATAFORMA_DB } from '../saas/plataforma-db';
import { ResolvedorCondominio } from '../saas/resolvedor';
import { EntradaJson, ErroProvisionamento, validarEntrada } from '../saas/provisionar';
import { condominio } from '../saas/schema-plataforma';
import { PROVISIONADOR, type Provisionador, ProvisionadorIndisponivel, ProvisionamentoOcupado } from './provisionador';
import type { AuthMaster } from './tipos';
import { registrarPlataforma } from './trilha-plataforma';

export interface CondominioPlataforma {
  id: string;
  codigo: string;
  nome: string;
  cidade: string | null;
  uf: string | null;
  plano: string;
  situacao: string;
  modulos: Modulo[];
  criadoEm: string;
}

const colunas = {
  id: condominio.id, codigo: condominio.codigo, nome: condominio.nome, cidade: condominio.cidade, uf: condominio.uf,
  plano: condominio.plano, status: condominio.status, modulos: condominio.modulos, criadoEm: condominio.criadoEm,
};
type Linha = { id: string; codigo: string; nome: string; cidade: string | null; uf: string | null; plano: string; status: string; modulos: string[]; criadoEm: Date };
const paraApi = (c: Linha): CondominioPlataforma => ({
  id: c.id, codigo: c.codigo, nome: c.nome, cidade: c.cidade, uf: c.uf, plano: c.plano, situacao: c.status,
  modulos: MODULOS.filter((m) => c.modulos.includes(m)), criadoEm: c.criadoEm.toISOString(),
});

/** Mesmo texto da tela (apps/plataforma): o que fazer na VPS (docs/deploy.md, seção 18.5). */
export const MENSAGEM_PROVISIONADOR_DESLIGADO = 'O provisionador está desligado. Na VPS: docker compose --profile provisionar up -d provisionador';

export interface ResultadoCriacao {
  situacao: 'provisionado' | 'retomado' | 'ja_provisionado' | 'nova_senha_sindico';
  condominio: CondominioPlataforma;
  sindico: { login: string; senhaTemporaria: string; expiraEm: string } | null;
}

@Injectable()
export class CondominiosMasterService {
  /** Um provisionamento por vez neste processo (o serviço provisionador também serializa). */
  private ocupado = false;

  constructor(
    @Inject(PLATAFORMA_DB) private readonly db: DbPlataforma,
    @Inject(PROVISIONADOR) private readonly provisionador: Provisionador,
    @Inject(ResolvedorCondominio) private readonly resolvedor: ResolvedorCondominio,
  ) {}

  /** GET /plataforma/provisionador/saude: só o booleano (sem URL, token nem motivo). */
  async provisionadorDisponivel(): Promise<{ disponivel: boolean }> {
    return { disponivel: this.provisionador.configurado() && await this.provisionador.disponivel() };
  }

  async listar(): Promise<CondominioPlataforma[]> {
    return (await this.db.select(colunas).from(condominio).orderBy(asc(condominio.nome), asc(condominio.codigo))).map(paraApi);
  }

  async criar(m: AuthMaster, corpo: z.infer<typeof EntradaJson>): Promise<ResultadoCriacao> {
    // O formato já passou pelo ZodPipe(EntradaJson) do controller; aqui a coerência da estrutura (gerarUnidades), como na
    // CLI. O provisionador valida tudo de novo do lado dele.
    try { validarEntrada(corpo); } catch (e) {
      if (e instanceof ErroProvisionamento) throw erroApi(422, 'PROVISIONAMENTO_RECUSADO', e.message.replace(/^entrada inválida: /, ''));
      throw e;
    }
    if (!this.provisionador.configurado()) {
      throw erroApi(503, 'PROVISIONADOR_INDISPONIVEL', MENSAGEM_PROVISIONADOR_DESLIGADO);
    }
    if (this.ocupado) throw erroApi(409, 'PROVISIONAMENTO_EM_ANDAMENTO', 'Outro provisionamento está em andamento. Aguarde e tente de novo.');
    this.ocupado = true;
    try {
      const res = await this.provisionador.provisionar(corpo, m.usuario.id);
      const [c] = await this.db.select(colunas).from(condominio).where(eq(condominio.id, res.condominioId));
      if (!c) throw new Error('condomínio provisionado não encontrado na plataforma');
      return { situacao: res.situacao, condominio: paraApi(c), sindico: res.sindico ?? null };
    } catch (e) {
      if (e instanceof ErroProvisionamento || e instanceof ProvisionadorIndisponivel || e instanceof ProvisionamentoOcupado) {
        // Trilha da recusa: só o código do condomínio (a mensagem pode citar o login do síndico).
        await registrarPlataforma(this.db, {
          masterUsuarioId: m.usuario.id, acao: 'condominio.provisionar_falha',
          detalhes: { codigo: corpo.codigo, motivo: e instanceof ErroProvisionamento ? 'recusado' : e instanceof ProvisionamentoOcupado ? 'ocupado' : 'indisponivel', ip: m.ip },
        }).catch(() => log('error', 'plataforma.falha_trilha'));
      }
      if (e instanceof ErroProvisionamento) throw erroApi(422, 'PROVISIONAMENTO_RECUSADO', e.message);
      if (e instanceof ProvisionamentoOcupado) throw erroApi(409, 'PROVISIONAMENTO_EM_ANDAMENTO', 'Outro provisionamento está em andamento. Aguarde e tente de novo.');
      if (e instanceof ProvisionadorIndisponivel) {
        log('error', 'plataforma.provisionador_indisponivel', { motivo: e.message });
        throw erroApi(503, 'PROVISIONADOR_INDISPONIVEL', 'O provisionador não respondeu (desligado ou fora do ar). Na VPS: docker compose --profile provisionar up -d provisionador. '
          + 'Se o condomínio ficou "provisionando", repita o envio com os MESMOS dados para retomar.');
      }
      throw e;
    } finally {
      this.ocupado = false;
    }
  }

  /**
   * Liga/desliga módulos (SAAS-19). O ModuloGuard do condomínio lê do cache do resolvedor: este processo o invalida na
   * hora; outras réplicas da API pegam a mudança na renovação seguinte (até 1 min).
   */
  async modulos(m: AuthMaster, id: string, pedidos: Modulo[]): Promise<CondominioPlataforma> {
    const r = await this.gravarModulos(m, id, pedidos);
    this.resolvedor.invalidar();
    return r;
  }

  private gravarModulos(m: AuthMaster, id: string, pedidos: Modulo[]): Promise<CondominioPlataforma> {
    const depois = MODULOS.filter((x) => pedidos.includes(x));
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select(colunas).from(condominio).where(eq(condominio.id, id)).for('update');
      if (!c) throw erroApi(404, 'NAO_ENCONTRADO', 'Condomínio não encontrado.');
      if (c.status === 'encerrado' || c.status === 'excluido') throw erroApi(409, 'CONDOMINIO_ENCERRADO', 'Condomínio encerrado: módulos não mudam mais.');
      const antes = MODULOS.filter((x) => c.modulos.includes(x));
      if (antes.length === depois.length && antes.every((x, i) => x === depois[i])) return paraApi(c);
      const [novo] = await tx.update(condominio).set({ modulos: [...depois] }).where(eq(condominio.id, id)).returning(colunas);
      await registrarPlataforma(tx, {
        masterUsuarioId: m.usuario.id, acao: 'condominio.modulos', condominioId: id,
        detalhes: { antes, depois, ligados: depois.filter((x) => !antes.includes(x)), desligados: antes.filter((x) => !depois.includes(x)), ip: m.ip },
      });
      return paraApi(novo!);
    });
  }
}
