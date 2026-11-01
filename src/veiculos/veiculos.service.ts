// Veículos da unidade (RF-08). Regras: placa no formato antigo (ABC1234) ou Mercosul
// (ABC1D23), guardada em maiúsculas e sem hífen; placa ATIVA única (índice veiculo_placa_ativa_uq -> 409 PLACA_DUPLICADA);
// unidade inativa não recebe veículo novo (paraNovoUso -> 422 UNIDADE_INATIVA). Nunca é apagado: `ativo` (o detalhe da
// unidade mostra só os ativos). Escrita: veiculo.cadastrar (SI, AD), com audit_log na mesma transação.
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Contexto } from '../auth/tipos';
import { codigoPg, erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { DB, type Db } from '../database/database.module';
import { veiculo } from '../db/schema';
import { UnidadesService } from '../unidades/unidades.service';
import { NovoVeiculoDto, EdicaoVeiculoDto } from './veiculos.schemas';

const colunas = { id: veiculo.id, unidadeId: veiculo.unidadeId, placa: veiculo.placa, modelo: veiculo.modelo, cor: veiculo.cor, ativo: veiculo.ativo };

/** Maiúsculas, sem separador; 422 fora do padrão antigo ou Mercosul. */
export function normalizarPlaca(bruta: string): string {
  const placa = bruta.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) throw erroApi(422, 'PLACA_INVALIDA', 'Placa fora do padrão antigo ou Mercosul.');
  return placa;
}

function obrigatorio(v: string, codigo: string, mensagem: string) {
  const t = v.trim();
  if (!t) throw erroApi(422, codigo, mensagem);
  return t;
}

const duplicada = () => erroApi(409, 'PLACA_DUPLICADA', 'Placa já cadastrada em outro veículo ativo.');

@Injectable()
export class VeiculosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELOGIO) private readonly relogio: Relogio,
    @Inject(AuditoriaService) private readonly auditoria: AuditoriaService,
    @Inject(UnidadesService) private readonly unidades: UnidadesService,
  ) {}

  async criar(ctx: Contexto, i: z.infer<typeof NovoVeiculoDto>) {
    const placa = normalizarPlaca(i.placa);
    const modelo = obrigatorio(i.modelo, 'MODELO_OBRIGATORIO', 'Informe o modelo.');
    const cor = obrigatorio(i.cor, 'COR_OBRIGATORIA', 'Informe a cor.');
    try {
      return await this.db.transaction(async (tx) => {
        await this.unidades.paraNovoUso(tx, i.unidadeId);
        const [novo] = await tx.insert(veiculo).values({ unidadeId: i.unidadeId, placa, modelo, cor, criadoEm: this.relogio.agora() }).returning(colunas);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'veiculo.criar', entidade: 'veiculo', registroId: novo!.id, depois: novo });
        return novo!;
      });
    } catch (e) {
      if (codigoPg(e) === '23505') throw duplicada();
      throw e;
    }
  }

  /** Um veículo (ativo ou não), sem trilha: só leitura (o "Revelar" do app do Master, que registra na plataforma). */
  async obter(id: string) {
    const [v] = await this.db.select(colunas).from(veiculo).where(eq(veiculo.id, id));
    if (!v) throw erroApi(404, 'VEICULO_NAO_ENCONTRADO', 'Veículo não encontrado.');
    return v;
  }

  /** Placa, modelo, cor e ativo. A unidade não muda (cadastre o veículo na unidade certa). Reativar conta como novo uso. */
  async editar(ctx: Contexto, id: string, i: z.infer<typeof EdicaoVeiculoDto>) {
    try {
      return await this.db.transaction(async (tx) => {
        const [antes] = await tx.select(colunas).from(veiculo).where(eq(veiculo.id, id)).for('update');
        if (!antes) throw erroApi(404, 'VEICULO_NAO_ENCONTRADO', 'Veículo não encontrado.');
        const mudancas: Partial<typeof veiculo.$inferInsert> = {};
        if (i.placa !== undefined) { const p = normalizarPlaca(i.placa); if (p !== antes.placa) mudancas.placa = p; }
        if (i.modelo !== undefined) { const m = obrigatorio(i.modelo, 'MODELO_OBRIGATORIO', 'Informe o modelo.'); if (m !== antes.modelo) mudancas.modelo = m; }
        if (i.cor !== undefined) { const c = obrigatorio(i.cor, 'COR_OBRIGATORIA', 'Informe a cor.'); if (c !== antes.cor) mudancas.cor = c; }
        if (i.ativo !== undefined && i.ativo !== antes.ativo) {
          mudancas.ativo = i.ativo;
          // Fato gerador da retenção do veículo (0007): 3 anos depois da desativação o job apaga a linha.
          mudancas.desativadoEm = i.ativo ? null : this.relogio.agora();
        }
        if (!Object.keys(mudancas).length) return antes;
        if (mudancas.ativo === true) await this.unidades.paraNovoUso(tx, antes.unidadeId);
        const [depois] = await tx.update(veiculo).set(mudancas).where(eq(veiculo.id, id)).returning(colunas);
        await this.auditoria.registrar(tx, { ator: ctx.ator, ip: ctx.ip, acao: 'veiculo.editar', entidade: 'veiculo', registroId: id, antes, depois });
        return depois!;
      });
    } catch (e) {
      if (codigoPg(e) === '23505') throw duplicada();
      throw e;
    }
  }
}
