// LGPD, migração 0007: anonimização que alcança o texto livre (art. 18, VI), exportação completa (art. 18, II),
// registro das anonimizações na plataforma e reaplicação depois de restore, retenção de veículo, operador e sessão, e
// dependente menor sem CPF e sem telefone (art. 14). API real sobre PGlite com as migrações reais.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { lerArgumentos } from '../src/cli/jobs';
import { LgpdService } from '../src/lgpd/lgpd.service';
import { RegistroAnonimizacoes } from '../src/saas/registro-anonimizacao';
import * as sp from '../src/saas/schema-plataforma';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE, comoAppRw, erroDe } from './helpers/banco';
import { comoAppPlataforma } from './helpers/plataforma';

const V1 = '/api/v1';
const JUST = 'Morador não atende o interfone, entrega urgente';
const REMOVIDO = 'Removido na anonimização (LGPD)';

async function montar() {
  const api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  const cookies = {} as Record<PapelTeste, string>;
  for (const p of ['sindico', 'administracao', 'porteiro', 'auditor'] as PapelTeste[]) cookies[p] = (await api.como(p)).cookie;
  const id = async (nome: string) => (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  const un = async (bloco: string, numero: string) => (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, bloco), eq(s.unidade.numero, numero))))[0]!;
  const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
  const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
  const patch = (papel: PapelTeste, url: string, corpo?: object) => api.http().patch(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
  const d32 = await un('D', '32');
  const ok = async (r: Promise<{ status: number; body: { data?: { id?: string }; code?: string } }>, esperado = [200, 201, 204]) => {
    const x = await r;
    if (!esperado.includes(x.status)) throw new Error(`esperado ${esperado}, veio ${x.status}: ${JSON.stringify(x.body)}`);
    return x.body.data as { id: string } & Record<string, unknown>;
  };
  return { api, cookies, id, un, get, post, patch, d32, ok };
}
type M = Awaited<ReturnType<typeof montar>>;

const textoDaTrilha = async (api: ApiDeTeste) => JSON.stringify((await trilha(api)).map((l) => [l.antes, l.depois]));
const noRegistro = async (api: ApiDeTeste) => api.plataforma.db.select().from(sp.lgpdAnonimizacao);

beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterAll(() => { vi.restoreAllMocks(); });

describe('anonimização completa (lgpd_anonimizar_titular, 0007)', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('texto livre ligado por id é substituído, o nome some de encomenda, ocorrência e trilha (inclusive registros congelados); o evento não muda e a cadeia continua íntegra', async () => {
    const marcos = await m.id('Marcos Pereira');
    const ana = await m.id('Ana Ribeiro');
    // Evento com o nome no texto livre (entra no hash: não pode mudar)
    const ev = await m.ok(m.post('porteiro', '/eventos-acesso', {
      pessoaId: marcos, unidadeDestinoId: m.d32.id, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST, observacao: 'Marcos Pereira veio com um amigo',
    }));
    await m.ok(m.post('porteiro', `/eventos-acesso/${ev.id}/saida`));
    // Restrição contra ele (revogada: registro congelado) e pedida pela Ana
    const r1 = await m.ok(m.post('sindico', '/restricoes', { pessoaId: marcos, unidadeId: m.d32.id, motivo: 'Marcos Pereira ameaçou a moradora', validaAte: '2027-12-31', solicitadaPorPessoaId: ana }));
    await m.ok(m.post('sindico', `/restricoes/${r1.id}/revogar`));
    // Autorização prévia sem solicitante (justificativa) para ele, revogada
    const a1 = await m.ok(m.post('sindico', '/autorizacoes-previas', { unidadeId: m.d32.id, pessoaId: marcos, validaAte: '2027-01-31', justificativa: 'Primo do morador, vem cuidar do apartamento' }));
    await m.ok(m.post('sindico', `/autorizacoes-previas/${a1.id}/revogar`));
    // Encomenda em nome dele (acentos e caixa diferentes, espaço duplo), já retirada pela Ana: congelada
    const enc = await m.ok(m.post('porteiro', '/encomendas', { unidadeId: m.d32.id, destinatario: 'MÁRCOS  pereira', unidadeConfirmada: true }));
    await m.ok(m.post('porteiro', `/encomendas/${enc.id}/retirada`, { pessoaId: ana }));
    const outra = await m.ok(m.post('porteiro', '/encomendas', { unidadeId: m.d32.id, destinatario: 'Ana Ribeiro', unidadeConfirmada: true }));
    // Ocorrência que o cita, encerrada (congelada)
    const oc = await m.ok(m.post('porteiro', '/ocorrencias', { tipo: 'conflito', descricao: 'Discussão entre o visitante Marcos Pereira e o porteiro', envolvidos: 'Marcos Pereira; porteiro do turno' }));
    await m.ok(m.post('sindico', `/ocorrencias/${oc.id}/status`, { status: 'em_andamento' }));
    await m.ok(m.post('sindico', `/ocorrencias/${oc.id}/status`, { status: 'encerrada' }));
    // Vínculo rejeitado (estado final) com o nome na justificativa
    const v = await m.ok(m.post('administracao', '/vinculos', { pessoaId: marcos, unidadeId: m.d32.id, tipo: 'dependente' }));
    await m.ok(m.post('administracao', `/vinculos/${v.id}/rejeitar`, { justificativa: 'Marcos Pereira não mora na unidade' }));
    expect(await textoDaTrilha(m.api)).toMatch(/M[áa]rcos\s+Pereira/i);

    const r = await m.post('sindico', `/lgpd/pessoas/${marcos}/anonimizar`);
    expect(r.status).toBe(200);
    expect(r.body.data.limpeza).toMatchObject({ textoLivre: 'substituido', encomendas: 1, ocorrencias: 1, eventosComTexto: 1 });
    expect(r.body.data.limpeza.restricoes).toBeGreaterThanOrEqual(1);
    expect(r.body.data.limpeza.vinculos).toBeGreaterThanOrEqual(1);
    expect(r.body.data.limpeza.trilhaTexto).toBeGreaterThanOrEqual(1);
    // A mensagem ao titular diz o que foi feito e o que fica, sem prometer "só pelo id"
    const retido = (r.body.data.retido as string[]).join(' ');
    expect(retido).toMatch(/1 desses eventos têm o nome/);
    expect(retido).toMatch(/trocado por “\[anonimizado\]”/);
    expect(retido).toMatch(/apelido/);
    expect(retido).toMatch(/fora do banco do condomínio/);

    const db = m.api.db;
    expect((await db.select().from(s.restricao).where(eq(s.restricao.id, r1.id)))[0]!.motivo).toBe(REMOVIDO);
    expect((await db.select().from(s.autorizacaoPrevia).where(eq(s.autorizacaoPrevia.id, a1.id)))[0]!.justificativa).toBe(REMOVIDO);
    expect((await db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.id, v.id)))[0]).toMatchObject({ status: 'rejeitado', justificativa: REMOVIDO });
    expect((await db.select().from(s.encomenda).where(eq(s.encomenda.id, enc.id)))[0]!.destinatario).toBe('[anonimizado]');
    expect((await db.select().from(s.encomenda).where(eq(s.encomenda.id, outra.id)))[0]!.destinatario).toBe('Ana Ribeiro');
    const [o] = await db.select().from(s.ocorrencia).where(eq(s.ocorrencia.id, oc.id));
    expect(o).toMatchObject({ status: 'encerrada', descricao: 'Discussão entre o visitante [anonimizado] e o porteiro', envolvidos: '[anonimizado]; porteiro do turno' });
    expect(await textoDaTrilha(m.api)).not.toMatch(/M[áa]rcos\s+Pereira/i);
    // O evento continua com o texto (hash) e a cadeia verifica
    const [e] = await db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.id, ev.id));
    expect(e!.observacao).toBe('Marcos Pereira veio com um amigo');
    expect((await m.get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: true });
    // Registro fora do banco do condomínio: só ids
    expect(await noRegistro(m.api)).toEqual([expect.objectContaining({ condominioId: m.api.pilotoId, pessoaId: marcos, motivo: 'pedido' })]);
    // Fora da função, os registros congelados continuam congelados (para o dono e para o app_rw)
    expect(await erroDe(m.api.client.query(`UPDATE encomenda SET destinatario = 'x' WHERE id = '${enc.id}'`))).toMatch(/já foi retirada/);
    expect(await erroDe(m.api.client.query(`UPDATE ocorrencia SET descricao = 'x' WHERE id = '${oc.id}'`))).toMatch(/encerrada não pode ser alterada/);
    await comoAppRw(m.api.client, async () => {
      await m.api.client.exec(`SELECT set_config('portaria.operacao', 'lgpd_anonimizar', false)`);
      expect(await erroDe(m.api.client.query(`UPDATE restricao SET motivo = 'x' WHERE id = '${r1.id}'`))).toMatch(/congelado/);
      await m.api.client.exec(`SELECT set_config('portaria.operacao', '', false)`);
    });
  });

  it('homônimo: o nome não é trocado no texto sem FK (seria apagar a menção a um terceiro) e a resposta pede revisão manual', async () => {
    const [h1] = await m.api.db.insert(s.pessoa).values({ nome: 'Joana Lima', categoria: 'visitante', telefone: '11955550001', semCpf: true }).returning();
    await m.api.db.insert(s.pessoa).values({ nome: 'Joana Lima Prado', categoria: 'visitante', telefone: '11955550002', semCpf: true });
    const enc = await m.ok(m.post('porteiro', '/encomendas', { unidadeId: m.d32.id, destinatario: 'Joana Lima Prado', unidadeConfirmada: true }));
    const r = await m.post('sindico', `/lgpd/pessoas/${h1!.id}/anonimizar`);
    expect(r.body.data.limpeza.textoLivre).toBe('homonimo');
    expect((r.body.data.retido as string[]).join(' ')).toMatch(/NÃO foi trocado/);
    expect((await m.api.db.select().from(s.encomenda).where(eq(s.encomenda.id, enc.id)))[0]!.destinatario).toBe('Joana Lima Prado');
  });

  it('nome de uma palavra: não é procurado no texto livre; a resposta diz isso', async () => {
    const [p] = await m.api.db.insert(s.pessoa).values({ nome: 'Zeca', categoria: 'visitante', telefone: '11955550003', semCpf: true }).returning();
    const r = await m.post('sindico', `/lgpd/pessoas/${p!.id}/anonimizar`);
    expect(r.body.data.limpeza.textoLivre).toBe('nome_curto');
    expect((r.body.data.retido as string[]).join(' ')).toMatch(/NÃO foi procurado/);
  });

  it('padrão do nome: sem acento e sem caixa, nome inteiro, sem casar dentro de outra palavra', async () => {
    const q = async (nome: string, texto: string) => (await m.api.client.query<{ x: string }>(`SELECT lgpd_trocar_nome($1, lgpd_padrao_nome($2)) AS x`, [texto, nome])).rows[0]!.x;
    expect(await q('José Antônio', 'jose  ANTONIO e Jôse Antonio')).toBe('[anonimizado] e [anonimizado]');
    expect(await q('Ana Souza', 'Mariana Souza e Ana Souzas')).toBe('Mariana Souza e Ana Souzas');
    expect(await q('D\'Ávila Neto (Jr.)', 'falar com d\'avila neto (jr.) hoje')).toBe('falar com [anonimizado] hoje');
    expect((await m.api.client.query<{ p: string | null }>(`SELECT lgpd_padrao_nome('Ana') AS p`)).rows[0]!.p).toBeNull();
  });
});

describe('exportação do titular completa (versão 2)', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('restrições, autorizações, encomendas e ocorrências que citam a pessoa, sem o texto livre e sem terceiros', async () => {
    const marcos = await m.id('Marcos Pereira');
    const ana = await m.id('Ana Ribeiro');
    await m.ok(m.post('sindico', '/restricoes', { pessoaId: marcos, unidadeId: m.d32.id, motivo: 'Motivo sigiloso que cita terceiros', validaAte: '2027-12-31', solicitadaPorPessoaId: ana }));
    await m.ok(m.post('sindico', '/autorizacoes-previas', { unidadeId: m.d32.id, pessoaId: marcos, validaAte: '2027-01-31', solicitadaPorPessoaId: ana }));
    const enc = await m.ok(m.post('porteiro', '/encomendas', { unidadeId: m.d32.id, destinatario: 'marcos pereira', unidadeConfirmada: true }));
    const oc = await m.ok(m.post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Marcos Pereira esqueceu um guarda-chuva com dados de terceiros' }));
    const c = JSON.parse((await m.get('administracao', `/lgpd/pessoas/${marcos}/exportacao`)).body.data.conteudo);
    expect(c.versao).toBe(2);
    expect(c.restricoes).toEqual([expect.objectContaining({ papel: 'restrição sobre a pessoa', escopo: 'unidade', unidade: 'D-32', situacao: 'vigente' })]);
    expect(c.autorizacoesPrevias).toEqual([expect.objectContaining({ papel: 'pessoa autorizada', destino: 'D-32', semSolicitante: false })]);
    expect(c.encomendasComONome).toEqual([expect.objectContaining({ codigo: enc.codigo, destinatario: 'marcos pereira', unidade: 'D-32' })]);
    expect(c.ocorrencias).toEqual([expect.objectContaining({ codigo: oc.codigo, relacao: ['texto'] })]);
    const texto = JSON.stringify(c);
    expect(texto).not.toContain('Motivo sigiloso');
    expect(texto).not.toContain('guarda-chuva');
    expect(texto).not.toContain('Ana Ribeiro'); // a solicitante (terceira) não aparece
    // Do lado da Ana: a restrição e a autorização que ela pediu, sem a identidade do Marcos
    const ca = JSON.parse((await m.get('administracao', `/lgpd/pessoas/${ana}/exportacao`)).body.data.conteudo);
    expect(ca.restricoes).toEqual([expect.objectContaining({ papel: 'restrição pedida pela pessoa' })]);
    expect(ca.autorizacoesPrevias).toEqual([expect.objectContaining({ papel: 'autorização pedida pela pessoa' })]);
    expect(JSON.stringify(ca)).not.toContain('Marcos');
    expect((await trilha(m.api, 'lgpd.exportar')).at(-1)!.depois).toMatchObject({ restricoes: 1, autorizacoes_previas: 1 });
  });
});

describe('restore: registro na plataforma e reaplicação', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('CLI: reaplicar-anonimizacoes aceita --condominio e não aceita argumento extra', () => {
    expect(lerArgumentos(['reaplicar-anonimizacoes', '--condominio', 'parque'])).toEqual({ comando: 'reaplicar-anonimizacoes', dia: undefined, codigo: 'parque' });
    expect(lerArgumentos(['reaplicar-anonimizacoes', '2026-01-01'])).toBeNull();
  });

  it('app_plataforma só insere e lê o registro (append-only)', async () => {
    const c = m.api.plataforma.client;
    await comoAppPlataforma(c, async () => {
      await c.query(`INSERT INTO lgpd_anonimizacao (condominio_id, pessoa_id, motivo, anonimizada_em) VALUES ('${m.api.pilotoId}', '${randomUUID()}', 'pedido', now())`);
      expect(await erroDe(c.query('UPDATE lgpd_anonimizacao SET motivo = \'retencao\''))).toMatch(/permission denied|append-only/);
      expect(await erroDe(c.query('DELETE FROM lgpd_anonimizacao'))).toMatch(/permission denied|append-only/);
    });
    expect(await erroDe(c.query('DELETE FROM lgpd_anonimizacao'))).toMatch(/append-only/); // nem o dono
  });

  it('banco restaurado de antes do pedido: a reaplicação anonimiza de novo, conta o inexistente e aponta quem tem vínculo válido', async () => {
    const ana = await m.id('Ana Ribeiro'); // moradora com vínculo válido no banco "restaurado"
    const marcos = await m.id('Marcos Pereira');
    const registro = await m.api.servico<RegistroAnonimizacoes>(RegistroAnonimizacoes);
    // O que a plataforma sabe (pedidos atendidos depois do backup) e o banco restaurado não
    await registro.registrar(m.api.pilotoId, [
      { pessoaId: ana, motivo: 'pedido', anonimizadaEm: new Date() },
      { pessoaId: marcos, motivo: 'retencao', anonimizadaEm: new Date() },
      { pessoaId: randomUUID(), motivo: 'pedido', anonimizadaEm: new Date() },
    ]);
    const lgpd = await m.api.servico<LgpdService>(LgpdService);
    const r = await lgpd.reaplicar({ ator: null, nomeInformado: 'teste de restore' });
    expect(r.reaplicadas.sort()).toEqual([ana, marcos].sort());
    // 2 inexistentes: o uuid aleatório acima e o do teste de permissão do app_plataforma
    expect(r).toMatchObject({ inexistentes: 2, comVinculoValido: [ana] });
    for (const id of [ana, marcos]) expect((await m.api.db.select().from(s.pessoa).where(eq(s.pessoa.id, id)))[0]).toMatchObject({ nome: 'Pessoa anonimizada', telefone: null });
    expect((await trilha(m.api, 'lgpd.reaplicar')).length).toBe(1);
    // Idempotente
    expect((await lgpd.reaplicar({ ator: null })).reaplicadas).toEqual([]);
  });

  it('a retenção copia para a plataforma a anonimização que ficou só no banco do condomínio (plataforma fora na hora)', async () => {
    const [p] = await m.api.db.insert(s.pessoa).values({ nome: 'Visitante Sem Registro', categoria: 'visitante', telefone: '11955550009', semCpf: true }).returning();
    await m.api.client.query(`SELECT lgpd_anonimizar_titular('${p!.id}', 'pedido')`); // como se o registro externo tivesse falhado
    expect((await noRegistro(m.api)).some((x) => x.pessoaId === p!.id)).toBe(false);
    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.body.data).toMatchObject({ registroExterno: 'ok', anonimizacoesReaplicadas: 0 });
    expect((await noRegistro(m.api)).find((x) => x.pessoaId === p!.id)).toMatchObject({ motivo: 'pedido' });
  });
});

describe('retenção de veículo, operador e sessão (0007)', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('veículo desativado há mais de 3 anos sai; o desativado há pouco e o ativo ficam; reativar limpa a data', async () => {
    const [v1, v2, v3] = await m.api.db.select().from(s.veiculo).where(eq(s.veiculo.ativo, true)).limit(3);
    expect(v3).toBeDefined();
    await m.ok(m.patch('administracao', `/veiculos/${v1!.id}`, { ativo: false }));
    expect((await m.api.db.select().from(s.veiculo).where(eq(s.veiculo.id, v1!.id)))[0]!.desativadoEm).toBeInstanceOf(Date);
    if (v2) await m.ok(m.patch('administracao', `/veiculos/${v2.id}`, { ativo: false }));
    await m.api.client.exec(`UPDATE veiculo SET desativado_em = now() - interval '3 years 1 day' WHERE id = '${v1!.id}'`);
    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.body.data.veiculosEliminados).toBe(1);
    expect(await m.api.db.select().from(s.veiculo).where(eq(s.veiculo.id, v1!.id))).toEqual([]);
    if (v2) {
      await m.ok(m.patch('administracao', `/veiculos/${v2.id}`, { ativo: true }));
      expect((await m.api.db.select().from(s.veiculo).where(eq(s.veiculo.id, v2.id)))[0]).toMatchObject({ ativo: true, desativadoEm: null });
    }
    // O banco mantém a data mesmo por um caminho que não a manda (imagem anterior da API, num rollback)
    if (v3) {
      await m.api.client.exec(`UPDATE veiculo SET ativo = false WHERE id = '${v3.id}'`);
      expect((await m.api.db.select().from(s.veiculo).where(eq(s.veiculo.id, v3.id)))[0]!.desativadoEm).toBeInstanceOf(Date);
      await m.api.client.exec(`UPDATE veiculo SET ativo = true WHERE id = '${v3.id}'`);
      expect((await m.api.db.select().from(s.veiculo).where(eq(s.veiculo.id, v3.id)))[0]!.desativadoEm).toBeNull();
    }
  });

  it('operador desativado há mais de 3 anos: nome e login genéricos, nome some da trilha, não reativa', async () => {
    const luiza = m.api.usuarios['luiza.campos']!;
    await m.ok(m.post('sindico', `/usuarios/${luiza.id}/desativar`));
    await m.api.client.exec(`UPDATE usuario_sistema SET desativado_em = now() - interval '3 years 1 day' WHERE id = '${luiza.id}'`);
    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.body.data.operadoresAnonimizados).toBe(1);
    const [u] = await m.api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.id, luiza.id));
    expect(u).toMatchObject({ nome: 'Operador anonimizado', login: `anonimizado-${luiza.id}`, ativo: false });
    expect(u!.anonimizadoEm).toBeInstanceOf(Date);
    const linhas = await trilha(m.api);
    expect(linhas.filter((l) => l.usuarioId === luiza.id).every((l) => l.usuarioNome === 'Operador anonimizado')).toBe(true);
    expect(JSON.stringify(linhas.filter((l) => l.registroId === luiza.id).map((l) => [l.antes, l.depois]))).not.toMatch(/Luiza|luiza\.campos/);
    expect((await m.post('sindico', `/usuarios/${luiza.id}/reativar`)).body.code).toBe('USUARIO_ANONIMIZADO');
    // Segunda execução: nada novo
    expect((await m.post('sindico', '/lgpd/retencao')).body.data.operadoresAnonimizados).toBe(0);
  });

  it('sessão sem uso há mais de 90 dias perde IP e navegador; a recente fica; app_rw não apaga direto', async () => {
    // A velha é de quem não faz as chamadas do teste (a do síndico expiraria a própria sessão do teste)
    const sindico = m.api.usuarios['carlos.andrade']!.id;
    const [velha] = await m.api.db.select().from(s.sessao).where(sql`${s.sessao.usuarioId} <> ${sindico}`).limit(1);
    const [nova] = await m.api.db.select().from(s.sessao).where(eq(s.sessao.usuarioId, sindico)).limit(1);
    await m.api.client.exec(`UPDATE sessao SET ip = '10.9.9.9', user_agent = 'Navegador de teste' WHERE id IN ('${velha!.id}', '${nova!.id}');
      UPDATE sessao SET ultimo_uso_em = now() - interval '91 days', criada_em = now() - interval '92 days', expira_em = now() - interval '91 days' WHERE id = '${velha!.id}'`);
    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.body.data.sessoesLimpas).toBeGreaterThanOrEqual(1);
    expect((await m.api.db.select().from(s.sessao).where(eq(s.sessao.id, velha!.id)))[0]).toMatchObject({ ip: null, userAgent: null });
    expect((await m.api.db.select().from(s.sessao).where(eq(s.sessao.id, nova!.id)))[0]).toMatchObject({ userAgent: 'Navegador de teste' });
    await comoAppRw(m.api.client, async () => {
      expect(await erroDe(m.api.client.query('DELETE FROM veiculo'))).toMatch(/permission denied/);
      expect(await erroDe(m.api.client.query('UPDATE sessao SET ip = NULL'))).toMatch(/permission denied/);
      await m.api.client.query('SELECT retencao_limpar_sessoes(), retencao_eliminar_veiculos(), retencao_anonimizar_operadores()');
    });
  });
});

describe('dependente menor de idade (LGPD art. 14)', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('sem CPF e sem telefone: cadastra, aprova como dependente, entra como morador; não aprova como proprietário', async () => {
    const p = await m.ok(m.post('administracao', '/pessoas', { nome: 'Pedro Ribeiro', categoria: 'morador', menorIdade: true }));
    expect(p).toMatchObject({ menorIdade: true, semCpf: false, documentoMascarado: '(menor, sem CPF)', telefoneMascarado: null });
    const v = await m.ok(m.post('administracao', '/vinculos', { pessoaId: p.id, unidadeId: m.d32.id, tipo: 'dependente' }));
    expect(v.pessoaCadastroCompleto).toBe(true);
    await m.ok(m.post('administracao', `/vinculos/${v.id}/conferencias`, { tipo: 'escritura' }));
    expect((await m.post('administracao', `/vinculos/${v.id}/aprovar`)).status).toBe(200);
    const e = await m.post('porteiro', '/eventos-acesso', { pessoaId: p.id, unidadeDestinoId: m.d32.id });
    expect(e.status).toBe(201);
    const outra = (await m.api.db.select().from(s.unidade).where(sql`${s.unidade.id} <> ${m.d32.id}`).limit(1))[0]!.id;
    const vp = await m.ok(m.post('administracao', '/vinculos', { pessoaId: p.id, unidadeId: outra, tipo: 'proprietario' }));
    expect(vp.pessoaCadastroCompleto).toBe(false);
    await m.ok(m.post('administracao', `/vinculos/${vp.id}/conferencias`, { tipo: 'escritura' }));
    expect((await m.post('administracao', `/vinculos/${vp.id}/aprovar`)).body.code).toBe('CADASTRO_INCOMPLETO');
  });

  it('com CPF: o CPF é validado e único (HMAC) como sempre; regras do menor', async () => {
    const p = await m.ok(m.post('administracao', '/pessoas', { nome: 'Lia Ribeiro', categoria: 'morador', menorIdade: true, documento: '123.456.789-09' }));
    expect(p.documentoMascarado).toBe('123.45*.***-**');
    expect((await m.post('administracao', '/pessoas', { nome: 'Outro', categoria: 'morador', documento: '12345678909', telefone: '11999990000' })).body.code).toBe('PESSOA_DUPLICADA');
    expect((await m.post('administracao', '/pessoas', { nome: 'Lia Bis', categoria: 'morador', menorIdade: true, documento: '12345678900' })).body.code).toBe('CPF_INVALIDO');
    expect((await m.post('administracao', '/pessoas', { nome: 'Visitante Menor', categoria: 'visitante', menorIdade: true })).body.code).toBe('MENOR_SO_MORADOR');
    expect((await m.post('administracao', '/pessoas', { nome: 'Adulto Sem Tel', categoria: 'morador', documento: '52998224725' })).body.code).toBe('TELEFONE_INVALIDO');
    expect((await m.post('administracao', '/pessoas', { nome: 'Pedro Ribeiro', categoria: 'morador', menorIdade: true })).body.code).toBe('PESSOA_DUPLICADA');
  });

  it('deixar de ser menor exige CPF e telefone; o banco recusa menor fora de morador', async () => {
    const pedro = await m.id('Pedro Ribeiro');
    expect((await m.patch('administracao', `/pessoas/${pedro}`, { menorIdade: false })).body.code).toBe('DOCUMENTO_OBRIGATORIO');
    expect((await m.patch('administracao', `/pessoas/${pedro}`, { menorIdade: false, documento: '111.444.777-35' })).body.code).toBe('TELEFONE_INVALIDO');
    const r = await m.patch('administracao', `/pessoas/${pedro}`, { menorIdade: false, documento: '111.444.777-35', telefone: '11988887777' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ menorIdade: false, documentoMascarado: '111.44*.***-**' }); // menor sem CPF (sem máscara) que informa: formato novo
    expect(await erroDe(m.api.client.query(`INSERT INTO pessoa (nome, categoria, menor_idade) VALUES ('X Y', 'visitante', true)`))).toMatch(/pessoa_menor_ck/);
    expect(await erroDe(m.api.client.query(`INSERT INTO pessoa (nome, categoria) VALUES ('X Y', 'morador')`))).toMatch(/pessoa_documento_coerente_ck|pessoa_telefone_obrigatorio_ck/);
  });
});
