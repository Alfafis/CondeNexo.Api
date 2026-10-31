// CHECKs e máquinas de estado do schema. Cada caso nomeia a constraint/regra que deve barrar a escrita.
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { documentoBusca, mascararCpf } from '../src/db/cpf';
import * as s from '../src/db/schema';
import {
  CHAVE_HMAC_TESTE, type Db, type Fixtures, JUSTIFICATIVA, SENHA_FALSA, conferencia, entradaBase, erroDe, inserirEvento, novoBanco,
} from './helpers/banco';

let db: Db;
let fx: Fixtures;
beforeAll(async () => { ({ db, fx } = await novoBanco()); });

const falha = async (p: Promise<unknown>, re: RegExp) => expect(await erroDe(p)).toMatch(re);
const ev = (extra: Partial<typeof s.eventoAcesso.$inferInsert>) => inserirEvento(db, entradaBase(fx, extra));
const amanha = () => new Date(Date.now() + 86_400_000);

describe('evento de acesso', () => {
  it('RN-01: entrada de não morador exige autorizado_por_tipo', async () => {
    await falha(ev({ autorizadoPorTipo: null, autorizadoPorPessoaId: null }), /evento_rn01_autorizado_por_ck/);
  });
  it('interfone/morador presente exige o morador identificado', async () => {
    await falha(ev({ autorizadoPorPessoaId: null }), /evento_morador_identificado_ck/);
  });
  it('RF-17: exceção exige justificativa de 15+ caracteres e não tem autorizador', async () => {
    await falha(ev({ autorizadoPorTipo: 'excecao_porteiro', autorizadoPorPessoaId: null, justificativa: 'urgente' }), /evento_rf17_excecao_ck/);
    await falha(ev({ autorizadoPorTipo: 'excecao_porteiro', justificativa: JUSTIFICATIVA }), /evento_rf17_excecao_ck/);
    await ev({ autorizadoPorTipo: 'excecao_porteiro', autorizadoPorPessoaId: null, justificativa: JUSTIFICATIVA });
  });
  it('autorização prévia: meio e referência andam juntos', async () => {
    await falha(ev({ autorizadoPorTipo: 'autorizacao_previa', autorizadoPorPessoaId: null }), /evento_autorizacao_previa_ref_ck/);
  });
  it('escala só para funcionário', async () => {
    await falha(ev({ autorizadoPorTipo: 'escala', autorizadoPorPessoaId: null }), /evento_escala_ck/);
  });
  it('pessoa sem CPF só entra por exceção do porteiro (trigger)', async () => {
    await falha(ev({ pessoaId: fx.semCpf.id }), /sem CPF só entra por exceção/);
    await ev({ pessoaId: fx.semCpf.id, autorizadoPorTipo: 'excecao_porteiro', autorizadoPorPessoaId: null, justificativa: JUSTIFICATIVA });
  });
  it('destino: unidade OU área comum; área comum só para prestador; visitante precisa de destino', async () => {
    await falha(ev({ categoriaPessoa: 'prestador', pessoaId: fx.prestador.id, empresa: 'E', areaComumId: fx.area.id }), /evento_destino_exclusivo_ck/);
    await falha(ev({ unidadeDestinoId: null, areaComumId: fx.area.id }), /evento_area_comum_prestador_ck/);
    await falha(ev({ unidadeDestinoId: null }), /evento_destino_obrigatorio_ck/);
  });
  it('prestador: empresa obrigatória na entrada; empresa/serviço só em prestador', async () => {
    await falha(ev({ categoriaPessoa: 'prestador', pessoaId: fx.prestador.id }), /evento_prestador_ck/);
    await falha(ev({ empresa: 'X' }), /evento_prestador_ck/);
  });
  it('recusado só por interfone ou morador presente', async () => {
    await falha(ev({ tipo: 'recusado', autorizadoPorTipo: 'excecao_porteiro', autorizadoPorPessoaId: null, justificativa: JUSTIFICATIVA }),
      /evento_recusa_meio_ck/);
  });
  it('negado exige restrição; restrição só em negado', async () => {
    await falha(ev({ tipo: 'negado', autorizadoPorTipo: null, autorizadoPorPessoaId: null }), /evento_negado_restricao_ck/);
  });
  it('saída exige refere_evento_id apontando para uma entrada, uma única vez', async () => {
    const saida = { tipo: 'saida' as const, autorizadoPorTipo: null, autorizadoPorPessoaId: null };
    await falha(ev(saida), /saída precisa referenciar uma entrada/); // o trigger roda antes dos CHECKs
    const entrada = await ev({});
    await falha(ev({ refereEventoId: entrada.id }), /evento_saida_refere_ck/);
    const s1 = await ev({ ...saida, refereEventoId: entrada.id });
    await falha(ev({ ...saida, refereEventoId: entrada.id }), /evento_saida_unica_uq/);
    await falha(ev({ ...saida, refereEventoId: s1.id }), /saída precisa referenciar uma entrada/);
    await falha(ev({ ...saida, refereEventoId: '00000000-0000-4000-8000-000000000000' }), /saída precisa referenciar uma entrada/);
  });
  it('saída não carrega autorização', async () => {
    const entrada = await ev({});
    await falha(ev({ tipo: 'saida', refereEventoId: entrada.id }), /evento_autorizacao_so_entrada_recusa_ck/);
  });
  it('correção: referência, justificativa, campos corrigíveis; não se corrige correção', async () => {
    const entrada = await ev({});
    const cor = (extra: Partial<typeof s.eventoAcesso.$inferInsert>) => ev({
      tipo: 'correcao', autorizadoPorTipo: null, autorizadoPorPessoaId: null, operadorId: fx.admin.id, operadorPapel: 'administracao',
      corrigeEventoId: entrada.id, justificativa: 'Unidade digitada errada', ...extra,
    });
    await falha(cor({ corrigeEventoId: null }), /evento corrigido .* não existe/);
    await falha(ev({ corrigeEventoId: entrada.id }), /evento_correcao_ref_ck/);
    await falha(cor({ justificativa: 'erro' }), /evento_correcao_justificada_ck/);
    await falha(cor({ correcaoValores: {} }), /evento_correcao_valores_ck/);
    await falha(cor({ correcaoValores: { autorizado_por_nome: 'Fulano' } }), /não é corrigível/);
    await falha(cor({ correcaoValores: { ocorrido_em: '2026-10-17 10:00' } }), /com fuso/);
    await falha(cor({ correcaoValores: { ocorrido_em: amanha().toISOString() } }), /anterior ao momento atual/);
    await falha(cor({ correcaoValores: { pessoa_id: null } }), /pessoa corrigida/);
    const c1 = await cor({ correcaoValores: { pessoa_id: fx.prestador.id } });
    await falha(cor({ corrigeEventoId: c1.id }), /não se corrige uma correção/);
    await falha(ev({ correcaoValores: { pessoa_id: fx.prestador.id } }), /evento_correcao_valores_ck/);
  });
  it('RF-35: retroativo exige formulário e instante passado; não retroativo não tem formulário', async () => {
    await falha(ev({ retroativo: true, ocorridoEm: new Date(Date.now() - 3600_000) }), /evento_retroativo_formulario_ck/);
    await falha(ev({ retroativo: true, formularioContingencia: 'FC-1', ocorridoEm: amanha() }), /evento_retroativo_tempo_ck/);
    await falha(ev({ formularioContingencia: 'FC-1' }), /evento_retroativo_formulario_ck/);
    await falha(ev({ retroativo: true, formularioContingencia: '  ', ocorridoEm: new Date(Date.now() - 3600_000) }), /evento_retroativo_formulario_ck/);
  });
  it('auditor não registra evento', async () => {
    await falha(ev({ operadorId: fx.auditor.id, operadorPapel: 'auditor' }), /evento_operador_papel_ck/);
  });
});

describe('pessoa', () => {
  const nova = (extra: Partial<typeof s.pessoa.$inferInsert>) => db.insert(s.pessoa).values({
    nome: 'Teste', categoria: 'visitante', telefone: '11999998888',
    documentoMascarado: mascararCpf('11144477735'), documentoBusca: documentoBusca('11144477735', CHAVE_HMAC_TESTE), ...extra,
  });
  it('CPF completo nunca cabe em documento_mascarado', async () => {
    await falha(nova({ documentoMascarado: '111.444.777-35' }), /pessoa_documento_mascarado_ck/);
  });
  it('documento_busca é hex de 64 (HMAC-SHA256) e único', async () => {
    await falha(nova({ documentoBusca: '11144477735' }), /pessoa_documento_busca_ck/);
    await nova({});
    await falha(nova({}), /pessoa_documento_busca_uq/);
  });
  it('sem_cpf não tem documento; com CPF, documento é obrigatório', async () => {
    await falha(nova({ semCpf: true, documentoBusca: documentoBusca('52998224725', CHAVE_HMAC_TESTE) }), /pessoa_documento_coerente_ck/);
    await falha(nova({ documentoBusca: null, documentoMascarado: null }), /pessoa_documento_coerente_ck/);
  });
  it('telefone obrigatório (exceto importado/anonimizado) e só dígitos', async () => {
    await falha(nova({ telefone: null, documentoBusca: documentoBusca('52998224725', CHAVE_HMAC_TESTE) }), /pessoa_telefone_obrigatorio_ck/);
    await falha(nova({ telefone: '(11) 99999-8888' }), /pessoa_telefone_ck/);
  });
  it('prestador exige empresa', async () => {
    await falha(nova({ categoria: 'prestador', documentoBusca: documentoBusca('52998224725', CHAVE_HMAC_TESTE) }), /pessoa_prestador_empresa_ck/);
  });
  it('anonimizada não guarda documento nem telefone', async () => {
    await falha(db.update(s.pessoa).set({ anonimizadaEm: new Date() }).where(eq(s.pessoa.id, fx.visitante.id)), /pessoa_anonimizada_sem_pii_ck/);
  });
});

describe('vínculo', () => {
  const novo = (extra: Partial<typeof s.vinculoUnidade.$inferInsert> = {}) => db.insert(s.vinculoUnidade).values({
    pessoaId: fx.visitante.id, unidadeId: fx.a11.id, tipo: 'dependente', registradoPorId: fx.admin.id, ...extra,
  }).returning().then((r) => r[0]);
  const mudar = (id: string, set: Partial<typeof s.vinculoUnidade.$inferInsert>) =>
    db.update(s.vinculoUnidade).set(set).where(eq(s.vinculoUnidade.id, id));

  it('nasce pendente ou legado; legado exige prazo; inquilino exige fim', async () => {
    await falha(novo({ status: 'aprovado', decididoPorId: fx.admin.id, decididoEm: new Date() }), /nasce pendente ou legado/);
    await falha(novo({ status: 'legado' }), /vinculo_legado_prazo_ck/);
    await falha(novo({ tipo: 'inquilino' }), /vinculo_inquilino_fim_ck/);
  });
  it('transições e unicidade do vínculo ativo', async () => {
    const v = await novo();
    await falha(novo(), /vinculo_ativo_uq/);
    await falha(mudar(v.id, { status: 'encerrado', encerradoEm: new Date() }), /transição de vínculo inválida/);
    await falha(mudar(v.id, { ...conferencia(fx.admin.id), status: 'aprovado' }), /vinculo_decidido_ck/);
    await falha(mudar(v.id, { status: 'rejeitado', decididoPorId: fx.admin.id, decididoEm: new Date() }), /vinculo_rejeicao_justificada_ck/);
    await mudar(v.id, { status: 'rejeitado', decididoPorId: fx.admin.id, decididoEm: new Date(), justificativa: 'Sem relação com a unidade' });
    await falha(mudar(v.id, { nota: 'reabrir' }), /estado final/);
    await novo(); // rejeitado não bloqueia novo pedido
  });
  it('legado: regulariza (vira aprovado) ou encerra', async () => {
    const v = await novo({ unidadeId: fx.d32.id, status: 'legado', prazoRegularizacao: '2027-03-31' });
    await mudar(v.id, { ...conferencia(fx.admin.id), status: 'aprovado', decididoPorId: fx.admin.id, decididoEm: new Date() });
    await mudar(v.id, { status: 'encerrado', encerradoEm: new Date() });
    await falha(mudar(v.id, { status: 'aprovado' }), /estado final/);
  });

  describe('conferência do comprovante (RF-05, RN-02)', () => {
    const decidido = () => ({ decididoPorId: fx.admin.id, decididoEm: new Date() });
    it('aprovar sem conferência registrada falha', async () => {
      const v = await novo({ pessoaId: fx.prestador.id });
      await falha(mudar(v.id, { status: 'aprovado', ...decidido() }), /vinculo_aprovado_conferido_ck/);
      await mudar(v.id, { ...conferencia(fx.admin.id), status: 'aprovado', ...decidido() });
    });
    it('regularizar legado sem conferência falha', async () => {
      const v = await novo({ pessoaId: fx.prestador.id, unidadeId: fx.d32.id, status: 'legado', prazoRegularizacao: '2027-03-31' });
      await falha(mudar(v.id, { status: 'aprovado', ...decidido() }), /vinculo_aprovado_conferido_ck/);
      await mudar(v.id, { ...conferencia(fx.sindico.id), status: 'aprovado', ...decidido() });
    });
    it('conferência é completa: tipo, data e conferente juntos; "outro" exige descrição', async () => {
      const v = await novo({ pessoaId: fx.funcionarioPessoa.id });
      await falha(mudar(v.id, { conferenciaTipoDocumento: 'escritura' }), /vinculo_conferencia_completa_ck/);
      await falha(mudar(v.id, conferencia(fx.admin.id, { conferenciaTipoDocumento: 'outro' })), /vinculo_conferencia_descricao_ck/);
      await falha(mudar(v.id, conferencia(fx.admin.id, { conferenciaDescricao: 'sobra' })), /vinculo_conferencia_descricao_ck/);
      await falha(mudar(v.id, { conferenciaObservacao: 'sem conferência' }), /vinculo_conferencia_observacao_ck/);
      await mudar(v.id, conferencia(fx.admin.id, { conferenciaTipoDocumento: 'outro', conferenciaDescricao: 'Formal de partilha' }));
    });
    it('observação é curta e não aceita CPF ou telefone', async () => {
      const v = await novo({ pessoaId: fx.semCpf.id });
      await falha(mudar(v.id, conferencia(fx.admin.id, { conferenciaObservacao: 'x'.repeat(201) })), /vinculo_conferencia_observacao_ck/);
      await falha(mudar(v.id, conferencia(fx.admin.id, { conferenciaObservacao: 'CPF 529.982.247-25' })), /vinculo_conferencia_sem_numero_ck/);
      await falha(mudar(v.id, conferencia(fx.admin.id, { conferenciaObservacao: 'tel (11) 98765-4321' })), /vinculo_conferencia_sem_numero_ck/);
      await mudar(v.id, conferencia(fx.admin.id, { conferenciaObservacao: 'Recebido por e-mail em 01/10/2026; firma reconhecida.' }));
    });
    it('data da conferência não pode ser depois da decisão', async () => {
      const v = await novo({ pessoaId: fx.morador.id, unidadeId: fx.a11.id });
      await falha(mudar(v.id, { ...conferencia(fx.admin.id, { conferenciaData: '2999-01-01' }), status: 'aprovado', ...decidido() }),
        /vinculo_conferencia_antes_decisao_ck/);
    });
    it('pendente pode refazer a conferência; depois de aprovado ela é imutável', async () => {
      const v = await novo({ pessoaId: fx.visitante.id, unidadeId: fx.d32.id });
      await mudar(v.id, conferencia(fx.admin.id));
      await mudar(v.id, conferencia(fx.sindico.id, { conferenciaTipoDocumento: 'contrato_compra_venda' }));
      await mudar(v.id, { status: 'aprovado', ...decidido() });
      await falha(mudar(v.id, { conferenciaTipoDocumento: 'contrato_locacao' }), /imutável depois da aprovação/);
      await falha(mudar(v.id, { conferenciaObservacao: 'ajuste' }), /imutável depois da aprovação/);
      await mudar(v.id, { nota: 'nota livre continua editável' });
    });
  });
});

describe('autorização prévia e restrição', () => {
  const base = () => ({
    pessoaId: fx.visitante.id, unidadeId: fx.d32.id, validaDe: new Date(), validaAte: amanha(), cadastradaPorId: fx.porteiro.id,
    solicitadaPorPessoaId: fx.morador.id,
  });
  it('autorização: solicitante ou (sem solicitante + justificativa); destino único; janela completa', async () => {
    await falha(db.insert(s.autorizacaoPrevia).values({ ...base(), solicitadaPorPessoaId: null }), /autorizacao_solicitante_ck/);
    await falha(db.insert(s.autorizacaoPrevia).values({ ...base(), solicitadaPorPessoaId: null, semSolicitante: true, justificativa: 'curta' }),
      /autorizacao_sem_solicitante_justificada_ck/);
    await falha(db.insert(s.autorizacaoPrevia).values({ ...base(), areaComumId: fx.area.id }), /autorizacao_destino_ck/);
    await falha(db.insert(s.autorizacaoPrevia).values({ ...base(), horaInicio: '08:00:00' }), /autorizacao_janela_ck/);
    await falha(db.insert(s.autorizacaoPrevia).values({ ...base(), diasSemana: [7] }), /autorizacao_dias_ck/);
    await falha(db.insert(s.autorizacaoPrevia).values({ ...base(), validaAte: new Date(Date.now() - 1000) }), /autorizacao_validade_ck/);
    await db.insert(s.autorizacaoPrevia).values({ ...base(), solicitadaPorPessoaId: null, semSolicitante: true, justificativa: JUSTIFICATIVA });
    await db.insert(s.autorizacaoPrevia).values({ ...base(), unidadeId: null, areaComumId: fx.area.id, solicitadaPorPessoaId: null });
  });
  it('autorização revogada fica congelada (revogar duas vezes é proibido)', async () => {
    const [a] = await db.insert(s.autorizacaoPrevia).values(base()).returning();
    const revogar = () => db.update(s.autorizacaoPrevia).set({ revogadaEm: new Date(), revogadaPorId: fx.admin.id }).where(eq(s.autorizacaoPrevia.id, a.id));
    await revogar();
    await falha(revogar(), /já foi revogada/);
  });
  it('restrição: escopo unidade exige unidade e solicitante e não tem aprovação; aprovação e revogação únicas', async () => {
    const r = { pessoaId: fx.visitante.id, motivo: 'Pedido do morador', validaAte: amanha(), cadastradaPorId: fx.porteiro.id };
    await falha(db.insert(s.restricao).values({ ...r, escopo: 'unidade', unidadeId: fx.d32.id }), /restricao_escopo_unidade_ck/);
    const [cond] = await db.insert(s.restricao).values({ ...r, escopo: 'condominio' }).returning();
    const set = (v: Partial<typeof s.restricao.$inferInsert>) => db.update(s.restricao).set(v).where(eq(s.restricao.id, cond.id));
    await falha(set({ aprovadaPorId: fx.sindico.id }), /restricao_aprovacao_ck/);
    await set({ aprovadaPorId: fx.sindico.id, aprovadaEm: new Date() });
    await falha(set({ aprovadaPorId: fx.admin.id }), /já aprovada/);
    await set({ revogadaPorId: fx.admin.id, revogadaEm: new Date() });
    await falha(set({ revogadaPorId: fx.sindico.id, revogadaEm: new Date() }), /já foi revogada/);
  });
});

describe('encomenda e autorização de retirada (RN-08)', () => {
  it('unidade conferida, retirada completa, autorização da mesma encomenda e pessoa, retirada única', async () => {
    const enc = { unidadeId: fx.d32.id, destinatario: 'Joana', recebidaPorId: fx.porteiro.id };
    await falha(db.insert(s.encomenda).values({ ...enc, unidadeConfirmada: false }), /encomenda_unidade_confirmada_ck/);
    const [e] = await db.insert(s.encomenda).values({ ...enc, unidadeConfirmada: true }).returning();
    const [aut] = await db.insert(s.autorizacaoRetirada).values({
      encomendaId: e.id, pessoaAutorizadaId: fx.visitante.id, solicitantePessoaId: fx.morador.id, registradaPorId: fx.porteiro.id,
    }).returning();
    const set = (v: Partial<typeof s.encomenda.$inferInsert>) => db.update(s.encomenda).set(v).where(eq(s.encomenda.id, e.id));
    await falha(set({ retiradaEm: new Date() }), /encomenda_retirada_ck/);
    await falha(set({ retiradaEm: new Date(), retiradaPorPessoaId: fx.prestador.id, retiradaRegistradaPorId: fx.porteiro.id, retiradaAutorizacaoId: aut.id }),
      /encomenda_retirada_autorizacao_fk/);
    await set({ retiradaEm: new Date(), retiradaPorPessoaId: fx.visitante.id, retiradaRegistradaPorId: fx.porteiro.id, retiradaAutorizacaoId: aut.id });
    await falha(set({ retiradaPorPessoaId: fx.morador.id }), /já foi retirada/);
  });
});

describe('ocorrência', () => {
  it('nasce aberta; aberta -> em_andamento -> encerrada; encerrada é final', async () => {
    const o = { tipo: 'conflito' as const, descricao: 'Discussão na portaria', abertaPorId: fx.porteiro.id };
    await falha(db.insert(s.ocorrencia).values({ ...o, status: 'encerrada' }), /nasce aberta/);
    const [oc] = await db.insert(s.ocorrencia).values(o).returning();
    const set = (status: 'aberta' | 'em_andamento' | 'encerrada') => db.update(s.ocorrencia).set({ status }).where(eq(s.ocorrencia.id, oc.id));
    await falha(set('encerrada'), /transição de ocorrência inválida/);
    await set('em_andamento');
    await set('encerrada');
    await falha(set('em_andamento'), /encerrada não pode ser alterada/);
    await falha(db.insert(s.ocorrenciaStatusHistorico).values({ ocorrenciaId: oc.id, de: 'aberta', para: 'aberta', porId: fx.porteiro.id }),
      /ocorrencia_historico_mudanca_ck/);
  });
});

describe('outros cadastros', () => {
  it('usuário: senha argon2id; login único sem diferenciar maiúsculas', async () => {
    await falha(db.insert(s.usuarioSistema).values({ nome: 'X', login: 'x', papel: 'porteiro', senhaHash: 'md5$abc' }), /usuario_senha_argon2id_ck/);
    await falha(db.insert(s.usuarioSistema).values({ nome: 'X', login: 'PAULO', papel: 'porteiro', senhaHash: SENHA_FALSA }), /usuario_login_uq/);
  });
  it('funcionário: dias 0..6 e início diferente do fim (atravessar a meia-noite é permitido)', async () => {
    await falha(db.update(s.funcionario).set({ diasSemana: [] }).where(eq(s.funcionario.pessoaId, fx.funcionarioPessoa.id)), /funcionario_dias_ck/);
    await falha(db.update(s.funcionario).set({ horaFim: '22:00:00' }).where(eq(s.funcionario.pessoaId, fx.funcionarioPessoa.id)), /funcionario_escala_ck/);
  });
  it('unidade: bloco + número únicos; bloco de 1 a 3 maiúsculas/dígitos; número canônico com 2 dígitos no mínimo', async () => {
    await falha(db.insert(s.unidade).values({ bloco: 'D', numero: '32' }), /unidade_bloco_numero_uq/);
    await falha(db.insert(s.unidade).values({ bloco: 'd', numero: '32' }), /unidade_bloco_ck/);
    await falha(db.insert(s.unidade).values({ bloco: 'ABCD', numero: '32' }), /unidade_bloco_ck/);
    await falha(db.insert(s.unidade).values({ bloco: '', numero: '32' }), /unidade_bloco_ck/);
    await falha(db.insert(s.unidade).values({ bloco: 'Z', numero: '3' }), /unidade_numero_ck/);
    await falha(db.insert(s.unidade).values({ bloco: 'Z', numero: '032' }), /unidade_numero_ck/);
    await falha(db.insert(s.unidade).values({ bloco: 'Z', numero: '3a' }), /unidade_numero_ck/);
  });
  it('audit_log: ação no formato entidade.acao; usuário e papel juntos', async () => {
    await falha(db.insert(s.auditLog).values({ usuarioNome: 'x', acao: 'apagou tudo', entidade: 'pessoa' }), /audit_log_acao_ck/);
    await falha(db.insert(s.auditLog).values({ usuarioId: fx.admin.id, usuarioNome: 'x', acao: 'pessoa.criar', entidade: 'pessoa' }), /audit_log_usuario_ck/);
  });
});
