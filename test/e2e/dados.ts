// Dados FICTÍCIOS do e2e, por cima do seed de desenvolvimento (seed-pessoas-dev.ts): o que as specs do Playwright
// precisam encontrar pronto. Tudo entra pelos SERVIÇOS da API, com as mesmas
// regras, trilha e hash de uma requisição de verdade, mas sem login (nenhum auth.login sobra na trilha do e2e).
// Datas relativas à hora real do boot: o servidor de e2e não tem relógio simulado.
import type { INestApplication } from '@nestjs/common';
import { inicioDoDia } from '../../src/dominio/time';
import { and, eq } from 'drizzle-orm';
import type { Contexto } from '../../src/auth/tipos';
import { diaBrt, somarDias } from '../../src/comum/datas';
import { DB, type Db } from '../../src/database/database.module';
import type { CondominioResolvido } from '../../src/tenancy/condominio';
import { servicoDe } from '../helpers/saas';
import { cpfComDv } from '../../src/db/seed-pessoas-dev';
import { pessoa, unidade, usuarioSistema } from '../../src/db/schema';
import { EncomendasService } from '../../src/encomendas/encomendas.service';
import { AutorizacoesService } from '../../src/eventos/autorizacoes.service';
import { EventosService } from '../../src/eventos/eventos.service';
import { FuncionariosService } from '../../src/funcionarios/funcionarios.service';
import { OcorrenciasService } from '../../src/ocorrencias/ocorrencias.service';
import { PessoasService } from '../../src/pessoas/pessoas.service';

/** Usuários a mais (além dos 4 do seed de dev), com a mesma senha do e2e. */
export const USUARIOS_E2E = [
  { nome: 'Sérgio Matos', login: 'sergio.matos', papel: 'porteiro' },
  { nome: 'Marina Couto', login: 'marina.couto', papel: 'porteiro' },
] as const;

/** Pessoas do e2e. CPF fictício com dígitos verificadores válidos; nenhum colide com o seed de dev. */
export const PESSOAS_E2E = {
  marcia: { nome: 'Márcia Pereira', categoria: 'visitante', documento: cpfComDv('901234561'), telefone: '11987650021' },
  larissa: { nome: 'Larissa Gomes', categoria: 'visitante', documento: cpfComDv('902345672'), telefone: '11987650022' },
  pedro: { nome: 'Pedro Almeida', categoria: 'visitante', documento: cpfComDv('903456783'), telefone: '11987650023' },
  thiago: { nome: 'Thiago Moura', categoria: 'visitante', documento: cpfComDv('904567894'), telefone: '11987650024' },
  osvaldo: { nome: 'Osvaldo Brandão', categoria: 'visitante', documento: cpfComDv('905678905'), telefone: '11987650025' },
  adriano: {
    nome: 'Adriano Melo', categoria: 'prestador', documento: cpfComDv('906789016'), telefone: '11987650026',
    empresa: 'Melo Piscinas', servico: 'Manutenção da piscina',
  },
} as const;
export const FUNCIONARIO_E2E = { nome: 'Válter Souza', documento: cpfComDv('907890127'), telefone: '11987650027', funcao: 'Zelador' };

/** Formulário de papel do retroativo do seed (Pedro Almeida). */
export const FORMULARIO_SEED = '0099';

export async function semearDadosE2e(app: INestApplication, condominio?: CondominioResolvido) {
  // SaaS (F2): os serviços são duráveis por condomínio; padrão: os do piloto (o único condomínio do e2e). Os testes de
  // isolamento semeiam também o `demo`.
  const db = await servicoDe<Db>(app, DB, condominio);
  const svc = <T>(c: new (...a: never[]) => T) => servicoDe<T>(app, c, condominio);
  const [pessoas, funcionarios, eventos] = await Promise.all([svc(PessoasService), svc(FuncionariosService), svc(EventosService)]);
  const [autorizacoes, ocorrencias, encomendas] = await Promise.all([svc(AutorizacoesService), svc(OcorrenciasService), svc(EncomendasService)]);

  const ctx = async (login: string): Promise<Contexto> => {
    const [u] = await db.select().from(usuarioSistema).where(eq(usuarioSistema.login, login));
    if (!u) throw new Error(`dados do e2e: usuário ${login} não existe`);
    return { ator: { id: u.id, nome: u.nome, papel: u.papel, login: u.login, deveTrocarSenha: false }, sessaoId: 'seed-e2e', ip: null };
  };
  const idPessoa = async (nome: string) => {
    const [p] = await db.select({ id: pessoa.id }).from(pessoa).where(eq(pessoa.nome, nome));
    if (!p) throw new Error(`dados do e2e: pessoa ${nome} não existe`);
    return p.id;
  };
  const idUnidade = async (bloco: string, numero: string) =>
    (await db.select({ id: unidade.id }).from(unidade).where(and(eq(unidade.bloco, bloco), eq(unidade.numero, numero))))[0]!.id;

  const paula = await ctx('paula.nogueira'), joao = await ctx('joao.lima'), sergio = await ctx('sergio.matos');
  const ids: Record<keyof typeof PESSOAS_E2E, string> = {} as never;
  for (const [k, p] of Object.entries(PESSOAS_E2E)) ids[k as keyof typeof PESSOAS_E2E] = (await pessoas.criar(paula, { ...p })).id;
  await funcionarios.criar(paula, {
    ...FUNCIONARIO_E2E, escala: { diasSemana: [1, 2, 3, 4, 5], horaInicio: '07:00', horaFim: '16:00' },
  });

  const d32 = await idUnidade('D', '32');
  const ana = await idPessoa('Ana Ribeiro');
  const interfoneAna = { unidadeDestinoId: d32, autorizadoPorTipo: 'interfone' as const, autorizadoPorPessoaId: ana };
  const agora = Date.now();

  // Histórico: visitante e prestador (o relatório filtrado por tipo de pessoa muda o total).
  await eventos.criarEntrada(joao, { pessoaId: ids.thiago, ...interfoneAna });
  const juliana = await eventos.criarEntrada(joao, { pessoaId: await idPessoa('Juliana Costa'), ...interfoneAna });
  await eventos.registrarSaida(joao, juliana.id, {});

  // Pedro Almeida segue dentro: entrada retroativa (contingência em papel) ONTEM às 12:10, sempre no passado.
  const entradaPedro = inicioDoDia(agora) - 86_400_000 + (12 * 60 + 10) * 60_000;
  await eventos.criarEntrada(joao, {
    pessoaId: ids.pedro, ...interfoneAna, retroativo: true, ocorridoEm: entradaPedro, formularioContingencia: FORMULARIO_SEED,
  });

  // Bruno Teixeira: restrição na D-32 a pedido da Ana e uma tentativa já barrada (um "negado" na trilha).
  const bruno = await idPessoa('Bruno Teixeira');
  await autorizacoes.criarRestricao(paula, {
    pessoaId: bruno, unidadeId: d32, motivo: 'Morador não autoriza a entrada', validaAte: somarDias(diaBrt(new Date(agora)), 60),
    solicitadaPorPessoaId: ana,
  });
  await eventos.criarEntrada(joao, { pessoaId: bruno, ...interfoneAna }).then(
    () => { throw new Error('dados do e2e: a entrada do Bruno deveria ser negada'); },
    (e: unknown) => { if ((e as { getResponse?: () => { codigo?: string } }).getResponse?.().codigo !== 'PESSOA_EM_RESTRICAO') throw e; },
  );

  // Ocorrências: OC-…-001 encerrada (João), OC-…-002 aberta pelo Sérgio, OC-…-003 aberta pelo João.
  const oc = (descricao: string) => ({ tipo: 'outro' as const, descricao, unidadeId: null, envolvidos: '', eventoIds: [] });
  const encerrada = await ocorrencias.criar(joao, oc('Portão da garagem ficou aberto durante a madrugada.'));
  await ocorrencias.alterarStatus(joao, encerrada.id, 'em_andamento');
  await ocorrencias.alterarStatus(joao, encerrada.id, 'encerrada');
  await ocorrencias.criar(sergio, oc('Interfone do bloco C sem som na chamada para a portaria.'));
  await ocorrencias.criar(joao, oc('Lâmpada queimada no hall do bloco D.'));

  // Encomenda K1 aguardando retirada na D-32.
  await encomendas.receber(joao, { unidadeId: d32, destinatario: 'Ana Ribeiro', transportadora: 'Correios', codigoRastreio: '', unidadeConfirmada: true });
}
