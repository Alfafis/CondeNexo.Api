// Veículos da unidade (RF-08). Regras: placa no formato antigo (ABC1234) ou Mercosul
// (ABC1D23), guardada em maiúsculas e sem hífen; placa ATIVA única (índice veiculo_placa_ativa_uq -> 409 PLACA_DUPLICADA);
// unidade inativa não recebe veículo novo (paraNovoUso -> 422 UNIDADE_INATIVA). Nunca é apagado: `ativo` (o detalhe da
// unidade mostra só os ativos). Escrita: veiculo.cadastrar (SI, AD), com audit_log na mesma transação.
import { Body, Controller, Inject, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { Acao, Ctx } from '../auth/decorators';
import type { Contexto } from '../auth/tipos';
import { codigoPg, erroApi } from '../comum/erros';
import { RELOGIO, type Relogio } from '../comum/relogio';
import { uuidParam, ZodPipe } from '../comum/zod.pipe';
import { DB, type Db } from '../database/database.module';
import { veiculo } from '../db/schema';
import { UnidadesModule } from '../unidades/unidades.module';
import { UnidadesService } from '../unidades/unidades.service';
import { Modulo } from '../saas/modulo.guard';

const NovoVeiculoDto = z.strictObject({ unidadeId: z.uuid({ message: 'unidade inválida' }), placa: z.string().max(10), modelo: z.string().max(60), cor: z.string().max(30) });
const EdicaoVeiculoDto = z.strictObject({ placa: z.string().max(10).optional(), modelo: z.string().max(60).optional(), cor: z.string().max(30).optional(), ativo: z.boolean().optional() });

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

@Modulo('veiculos')
@Controller('veiculos')
export class VeiculosController {
  constructor(@Inject(VeiculosService) private readonly veiculos: VeiculosService) {}

  @Post()
  @Acao('veiculo.cadastrar')
  criar(@Ctx() ctx: Contexto, @Body(new ZodPipe(NovoVeiculoDto)) b: z.infer<typeof NovoVeiculoDto>) { return this.veiculos.criar(ctx, b); }

  @Patch(':id')
  @Acao('veiculo.cadastrar')
  editar(@Ctx() ctx: Contexto, @Param('id', uuidParam) id: string, @Body(new ZodPipe(EdicaoVeiculoDto)) b: z.infer<typeof EdicaoVeiculoDto>) {
    return this.veiculos.editar(ctx, id, b);
  }
}

@Module({ imports: [UnidadesModule], controllers: [VeiculosController], providers: [VeiculosService] })
export class VeiculosModule {}
