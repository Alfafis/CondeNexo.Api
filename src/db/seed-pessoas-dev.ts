// Pessoas, vínculos e veículos FICTÍCIOS de desenvolvimento (só PORTARIA_AMBIENTE=dev), para a busca e o resumo das
// unidades terem o que mostrar. Os e2e do front (apps/web/e2e) contam com estes nomes e unidades.
// - CPF válido (dígitos verificadores corretos) e fictício; o banco recebe só a máscara e o HMAC com a chave do ambiente.
//   Máscara no formato novo; Ana Ribeiro fica no antigo para cobrir a convivência dos dois (como em produção).
// - Idempotente por família: se a primeira pessoa já existe (mesmo HMAC), a família inteira é pulada. Cada família numa
//   transação: ou entra inteira, ou não entra.
// - Vínculo aprovado segue o caminho real: nasce pendente com a conferência do comprovante e é aprovado depois (trigger
//   de transição e CHECKs valem também para o seed).
import { parseCodigoUnidade } from '../dominio/units';
import { eq, and } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { snapshot } from '../auditoria/snapshot';
import { diaBrt } from '../comum/datas';
import { documentoBusca, mascararCpf } from './cpf';
import { auditLog, pessoa, unidade, usuarioSistema, veiculo, vinculoUnidade } from './schema';

/** Completa 9 dígitos com os 2 verificadores do CPF. */
export function cpfComDv(base9: string): string {
  const d = base9.split('').map(Number);
  const dv = (n: number[]) => { const s = n.reduce((a, x, i) => a + x * (n.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(d);
  const d2 = dv([...d, d1]);
  return `${base9}${d1}${d2}`;
}

type Categoria = (typeof pessoa.categoria.enumValues)[number];
type TipoVinculo = (typeof vinculoUnidade.tipo.enumValues)[number];

interface PessoaSeed {
  nome: string;
  categoria: Categoria;
  /** 9 dígitos-base; sem `cpf` = cadastro "sem CPF" (exceção). */
  cpf?: string;
  /** Máscara no formato antigo ("***.456.789-**"): a convivência dos dois formatos (decisão de 2026-10-24). Padrão: o novo. */
  mascaraAntiga?: true;
  telefone: string;
  empresa?: string;
  servico?: string;
  vinculo?: { tipo: TipoVinculo; status: 'aprovado' | 'pendente' | 'legado'; vigenciaFim?: string };
}

interface FamiliaSeed { unidade?: string; pessoas: PessoaSeed[]; veiculos?: { placa: string; modelo: string; cor: string }[] }

/** Bloco e número de "D-32". */
const un = (c: string) => parseCodigoUnidade(c)!;

export const FAMILIAS_DEV: FamiliaSeed[] = [
  { unidade: 'D-32', pessoas: [
    { nome: 'Ana Ribeiro', categoria: 'morador', cpf: '529982247', mascaraAntiga: true, telefone: '11987650001', vinculo: { tipo: 'proprietario', status: 'aprovado' } },
    { nome: 'Paulo Ribeiro', categoria: 'morador', cpf: '318406253', telefone: '11987650002', vinculo: { tipo: 'dependente', status: 'aprovado' } },
    { nome: 'Lúcia Ribeiro', categoria: 'morador', cpf: '407152936', telefone: '11987650003', vinculo: { tipo: 'dependente', status: 'legado' } },
  ], veiculos: [{ placa: 'FKR2C41', modelo: 'Honda Fit', cor: 'prata' }, { placa: 'GHT8J20', modelo: 'VW T-Cross', cor: 'branco' }] },
  { unidade: 'G-11', pessoas: [
    { nome: 'Carla Mendes', categoria: 'morador', cpf: '226718409', telefone: '11987650004', vinculo: { tipo: 'inquilino', status: 'aprovado', vigenciaFim: '2027-07-31' } },
    { nome: 'Rafael Mendes', categoria: 'visitante', cpf: '613029487', telefone: '11987650005', vinculo: { tipo: 'dependente', status: 'pendente' } },
  ], veiculos: [{ placa: 'EQP4B77', modelo: 'Fiat Argo', cor: 'cinza' }] },
  { unidade: 'I-13', pessoas: [
    { nome: 'Marta Siqueira', categoria: 'morador', cpf: '740385162', telefone: '11987650006', vinculo: { tipo: 'proprietario', status: 'aprovado' } },
    { nome: 'Rodrigo Alves', categoria: 'visitante', cpf: '851204736', telefone: '11987650007', vinculo: { tipo: 'inquilino', status: 'pendente', vigenciaFim: '2027-12-31' } },
  ], veiculos: [{ placa: 'BRA2E19', modelo: 'Toyota Corolla', cor: 'preto' }] },
  { unidade: 'B-24', pessoas: [
    { nome: 'Helena Duarte', categoria: 'morador', cpf: '162839045', telefone: '11987650008', vinculo: { tipo: 'proprietario', status: 'aprovado' } },
    { nome: 'Otávio Duarte', categoria: 'morador', cpf: '293746518', telefone: '11987650009', vinculo: { tipo: 'dependente', status: 'legado' } },
  ], veiculos: [{ placa: 'DXA1F03', modelo: 'Jeep Renegade', cor: 'verde' }] },
  { unidade: 'C-42', pessoas: [
    { nome: 'Sandra Ferraz Teles', categoria: 'morador', cpf: '384615270', telefone: '11987650010', vinculo: { tipo: 'proprietario', status: 'legado' } },
    { nome: 'Lucas Ferraz', categoria: 'visitante', cpf: '475926381', telefone: '11987650011', vinculo: { tipo: 'inquilino', status: 'pendente', vigenciaFim: '2027-06-30' } },
  ] },
  { pessoas: [{ nome: 'Marcos Pereira', categoria: 'visitante', cpf: '586037492', telefone: '11987650012' }] },
  { pessoas: [{ nome: 'Bruno Teixeira', categoria: 'visitante', cpf: '697148503', telefone: '11987650013' }] },
  { pessoas: [{ nome: 'Juliana Costa', categoria: 'prestador', cpf: '708259614', telefone: '11987650014', empresa: 'Autônoma', servico: 'Diarista' }] },
  { pessoas: [{ nome: 'Técnico Enel — Diego Santos', categoria: 'prestador', cpf: '819360725', telefone: '11987650015', empresa: 'Enel', servico: 'Manutenção de energia' }] },
  { pessoas: [{ nome: 'Cláudia Rocha', categoria: 'prestador', telefone: '11987650016', empresa: 'Autônoma', servico: 'Diarista' }] },
];

const ORIGEM = '(seed de desenvolvimento)';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aceita qualquer driver (PGlite, node-postgres) e schema
export async function seedPessoasDev(db: PgDatabase<PgQueryResultHKT, any>, o: { chaveHmac: Buffer; agora?: Date }) {
  const agora = o.agora ?? new Date();
  const hoje = diaBrt(agora);
  const prazoLegado = diaBrt(new Date(agora.getTime() + 90 * 86_400_000)); // RN-09: 90 dias para regularizar
  const [admin] = await db.select({ id: usuarioSistema.id }).from(usuarioSistema).where(eq(usuarioSistema.login, 'paula.nogueira'));
  if (!admin) throw new Error('seed de pessoas: rode antes o seed de usuários (paula.nogueira não existe)');

  const criadas: string[] = [];
  for (const f of FAMILIAS_DEV) {
    await db.transaction(async (tx) => {
      const audit = (acao: string, entidade: string, registroId: string, depois: unknown) =>
        tx.insert(auditLog).values({ usuarioId: null, usuarioPapel: null, usuarioNome: ORIGEM, acao, entidade, registroId, depois: { ...snapshot(depois), origem: 'seed' } });
      const destino = f.unidade
        ? (await tx.select({ id: unidade.id }).from(unidade).where(and(eq(unidade.bloco, un(f.unidade).bloco), eq(unidade.numero, un(f.unidade).numero))))[0]
        : undefined;
      if (f.unidade && !destino) throw new Error(`seed de pessoas: unidade ${f.unidade} não existe (rode o seed de estrutura)`);
      for (const [i, p] of f.pessoas.entries()) {
        const cpf = p.cpf ? cpfComDv(p.cpf) : null;
        const valores = {
          nome: p.nome, categoria: p.categoria, telefone: p.telefone, empresa: p.empresa ?? null, servico: p.servico ?? null,
          semCpf: !cpf, documentoMascarado: cpf ? mascararCpf(cpf, p.mascaraAntiga ? 'meio' : 'inicio') : null, documentoBusca: cpf ? documentoBusca(cpf, o.chaveHmac) : null,
          criadoEm: agora, atualizadoEm: agora,
        };
        let novo: { id: string } | undefined;
        if (cpf) {
          [novo] = await tx.insert(pessoa).values(valores).onConflictDoNothing({ target: pessoa.documentoBusca }).returning({ id: pessoa.id });
        } else {
          const [existe] = await tx.select({ id: pessoa.id }).from(pessoa)
            .where(and(eq(pessoa.nome, p.nome), eq(pessoa.telefone, p.telefone), eq(pessoa.semCpf, true)));
          if (!existe) [novo] = await tx.insert(pessoa).values(valores).returning({ id: pessoa.id });
        }
        if (!novo) {
          if (i === 0) return; // família já semeada: nada a fazer
          continue;
        }
        criadas.push(p.nome);
        await audit('pessoa.criar', 'pessoa', novo.id, { ...valores, id: novo.id });
        if (p.vinculo && destino) {
          const conferencia = p.vinculo.status === 'aprovado' ? {
            conferenciaTipoDocumento: p.vinculo.tipo === 'inquilino' ? 'contrato_locacao' as const : p.vinculo.tipo === 'proprietario' ? 'escritura' as const : 'outro' as const,
            conferenciaDescricao: p.vinculo.tipo === 'dependente' ? 'Certidão de nascimento' : null,
            conferenciaData: hoje, conferidoPorId: admin.id,
          } : {};
          const [v] = await tx.insert(vinculoUnidade).values({
            pessoaId: novo.id, unidadeId: destino.id, tipo: p.vinculo.tipo, status: p.vinculo.status === 'legado' ? 'legado' : 'pendente',
            vigenciaInicio: '2025-01-01', vigenciaFim: p.vinculo.vigenciaFim ?? null,
            prazoRegularizacao: p.vinculo.status === 'legado' ? prazoLegado : null,
            registradoPorId: admin.id, registradoEm: agora, atualizadoEm: agora, ...conferencia,
          }).returning();
          await audit('vinculo.criar', 'vinculo_unidade', v!.id, v);
          if (p.vinculo.status === 'aprovado') {
            const [a] = await tx.update(vinculoUnidade).set({ status: 'aprovado', decididoPorId: admin.id, decididoEm: agora, atualizadoEm: agora })
              .where(eq(vinculoUnidade.id, v!.id)).returning();
            await audit('vinculo.aprovar', 'vinculo_unidade', v!.id, a);
          }
        }
      }
      for (const ve of f.veiculos ?? []) {
        // Placa ativa já existe (cadastrada à mão): pula, sem erro.
        const [novo] = await tx.insert(veiculo).values({ unidadeId: destino!.id, ...ve, criadoEm: agora }).onConflictDoNothing().returning();
        if (novo) await audit('veiculo.criar', 'veiculo', novo.id, novo);
      }
    });
  }
  return criadas;
}
