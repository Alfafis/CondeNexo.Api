// LGPD (spec §9.1, §9.3) e selo com âncora externa (spec §4.6) pela API real sobre PGlite com as migrações reais.
// O "passar do tempo" (eventos, trilha e cadastro com mais de 3 anos) é simulado como SUPERUSUÁRIO: desliga o trigger,
// envelhece as linhas e, no caso dos eventos, recalcula a cadeia inteira (o registrado_em entra no hash).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { carregarConfig } from '../src/config/config';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { CofreDocumentos } from '../src/documentos/cofre';
import { Agendador } from '../src/jobs/agendador';
import { EnvioAncoraReal, textoDoEmail } from '../src/selo/ancora';
import { SeloService } from '../src/selo/selo.module';
import { AncoraDeTeste, type ApiDeTeste, configDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE, comoAppRw, erroDe } from './helpers/banco';

const V1 = '/api/v1';
const JUST = 'Morador não atende o interfone, entrega urgente';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('ANEXO-EM-CLARO '.repeat(20))]);
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function montar(extra: Parameters<typeof novaApi>[0] = {}) {
  const ancora = new AncoraDeTeste();
  const api = await novaApi(extra, { ancora });
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  const cookies = {} as Record<PapelTeste, string>;
  for (const p of ['sindico', 'administracao', 'porteiro', 'auditor'] as PapelTeste[]) cookies[p] = (await api.como(p)).cookie;
  const id = async (nome: string) => (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  const un = async (bloco: string, numero: string) => (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, bloco), eq(s.unidade.numero, numero))))[0]!;
  const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
  const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
  const d32 = await un('D', '32');
  async function entrada(pessoaId: string) {
    const e = await post('porteiro', '/eventos-acesso', { pessoaId, unidadeDestinoId: d32.id, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
    if (e.status !== 201) throw new Error(`entrada falhou: ${JSON.stringify(e.body)}`);
    await post('porteiro', `/eventos-acesso/${e.body.data.id}/saida`);
    return e.body.data.id as string;
  }
  const visitante = async (nome: string) => (await api.db.insert(s.pessoa).values({ nome, categoria: 'visitante', telefone: '11955550000', semCpf: true }).returning())[0]!;
  const cofre = await api.servico<CofreDocumentos>(CofreDocumentos);
  return { api, ancora, cookies, id, get, post, d32, entrada, visitante, cofre };
}
type M = Awaited<ReturnType<typeof montar>>;

/** Superusuário: envelhece os eventos até `ateSeq` e recalcula a cadeia inteira e a cabeça (só antes de qualquer descarte). */
async function envelhecerEventos(api: ApiDeTeste, ateSeq: number, anos = 4) {
  await api.client.exec(`
    ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel;
    UPDATE evento_acesso SET registrado_em = registrado_em - interval '${anos} years', ocorrido_em = ocorrido_em - interval '${anos} years' WHERE seq <= ${ateSeq};
    DO $$ DECLARE r evento_acesso%ROWTYPE; ant text := encode(sha256(convert_to('genesis', 'UTF8')), 'hex'); h text; BEGIN
      FOR r IN SELECT * FROM evento_acesso ORDER BY seq LOOP
        h := encode(sha256(convert_to(ant || evento_acesso_canonico(r), 'UTF8')), 'hex');
        UPDATE evento_acesso SET hash_anterior = ant, hash = h WHERE id = r.id;
        ant := h;
      END LOOP;
      UPDATE evento_acesso_cadeia SET ultimo_hash = ant WHERE id = 1;
    END $$;
    ALTER TABLE evento_acesso ENABLE TRIGGER evento_acesso_imutavel;`);
}
const seloEm = async (api: ApiDeTeste, seq: number) => {
  const [e] = await api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, seq));
  await api.db.insert(s.seloCadeia).values({ data: '2022-01-01', tipo: 'manual', ultimoSeq: seq, ultimoHash: e!.hash });
};

beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterAll(() => { vi.restoreAllMocks(); });

describe('exportação do titular (GET /lgpd/pessoas/:id/exportacao, spec §9.3)', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('403 para porteiro e auditor; 404 para pessoa inexistente', async () => {
    const ana = await m.id('Ana Ribeiro');
    expect((await m.get('porteiro', `/lgpd/pessoas/${ana}/exportacao`)).status).toBe(403);
    expect((await m.get('auditor', `/lgpd/pessoas/${ana}/exportacao`)).status).toBe(403);
    expect((await m.get('sindico', `/lgpd/pessoas/${randomUUID()}/exportacao`)).body.code).toBe('PESSOA_NAO_ENCONTRADA');
  });

  it('moradora: cadastro mascarado, vínculo com a conferência, veículos da unidade, encomenda retirada; nada de HMAC nem telefone', async () => {
    const ana = await m.id('Ana Ribeiro');
    const enc = await m.post('porteiro', '/encomendas', { unidadeId: m.d32.id, destinatario: 'Ana Ribeiro', unidadeConfirmada: true });
    expect((await m.post('porteiro', `/encomendas/${enc.body.data.id}/retirada`, { pessoaId: ana })).status).toBe(200);
    const r = await m.get('administracao', `/lgpd/pessoas/${ana}/exportacao`);
    expect(r.status).toBe(200);
    expect(r.body.data.nomeArquivo).toMatch(/^lgpd-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.json$/);
    const c = JSON.parse(r.body.data.conteudo);
    expect(c).toMatchObject({ tipo: 'portaria-parque/lgpd-exportacao', versao: 2, geradoPor: 'Paula Nogueira' });
    expect(c.titular).toMatchObject({ nome: 'Ana Ribeiro', categoria: 'Morador', cpf: '***.982.247-**', semCpf: false, telefone: '(**) *****-0001' });
    expect(c.vinculos).toHaveLength(1);
    expect(c.vinculos[0]).toMatchObject({ unidade: 'D-32', tipo: 'proprietario', status: 'aprovado', comprovanteConferido: { tipo: 'escritura' } });
    expect(c.vinculos[0].comprovanteConferido.conferidoPor).toBeTruthy();
    expect(c.veiculos.map((v: { placa: string }) => v.placa).sort()).toEqual(['FKR-2C41', 'GHT-8J20']);
    expect(c.encomendasRetiradas).toEqual([expect.objectContaining({ codigo: enc.body.data.codigo, unidade: 'D-32' })]);
    // Minimização: sem HMAC do CPF, sem número de CPF, sem telefone completo, sem hash de nada
    const texto = r.body.data.conteudo as string;
    expect(texto).not.toMatch(/documento_?[bB]usca/);
    expect(texto).not.toMatch(/[0-9a-f]{64}/);
    expect(texto.replace(UUID_G, '')).not.toMatch(/\d{9,}/);
    expect(texto).not.toContain('11987650001');
    // A exportação vai para o audit_log com o solicitante
    const t = await trilha(m.api, 'lgpd.exportar');
    expect(t.at(-1)).toMatchObject({ usuarioNome: 'Paula Nogueira', usuarioPapel: 'administracao', registroId: ana, entidade: 'pessoa' });
    expect(t.at(-1)!.depois).toMatchObject({ vinculos: 1, veiculos: 2, encomendas: 1, eventos: 0 });
  });

  it('visitante: os próprios eventos (efetivos) e os metadados do anexo da ocorrência ligada a eles, sem conteúdo', async () => {
    const marcos = await m.id('Marcos Pereira');
    const ev = await m.entrada(marcos);
    const oc = await m.post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Discussão na portaria', eventoIds: [ev] });
    const an = await m.api.http().post(`${V1}/ocorrencias/${oc.body.data.id}/anexos`).set('Cookie', m.cookies.porteiro).attach('arquivo', PNG, { filename: 'foto.png', contentType: 'image/png' });
    expect(an.status).toBe(201);
    const r = await m.get('sindico', `/lgpd/pessoas/${marcos}/exportacao`);
    const c = JSON.parse(r.body.data.conteudo);
    expect(r.body.data.quantidade).toBe(2);
    expect(c.eventos.map((e: { tipo: string }) => e.tipo)).toEqual(['entrada', 'saida']);
    expect(c.eventos[0]).toMatchObject({ unidade: 'D-32', meio: expect.any(String), pontoAcesso: expect.any(String), retroativo: false });
    expect(c.documentos).toEqual([expect.objectContaining({ tipo: 'anexo_ocorrencia', origem: `ocorrência ${oc.body.data.codigo}`, mime: 'image/png', tamanhoBytes: PNG.length, eliminadoEm: null })]);
    expect(r.body.data.conteudo).not.toContain('ANEXO-EM-CLARO');
    expect(r.body.data.conteudo).not.toContain('Discussão na portaria'); // descrição da ocorrência (terceiros) fica fora
  });
});

describe('anonimização a pedido (POST /lgpd/pessoas/:id/anonimizar)', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('só o síndico; com vínculo válido é 422; inexistente 404', async () => {
    const ana = await m.id('Ana Ribeiro');
    expect((await m.post('administracao', `/lgpd/pessoas/${ana}/anonimizar`)).status).toBe(403);
    expect((await m.post('auditor', `/lgpd/pessoas/${ana}/anonimizar`)).status).toBe(403);
    const r = await m.post('sindico', `/lgpd/pessoas/${ana}/anonimizar`);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PESSOA_COM_VINCULO_VALIDO');
    expect((await m.post('sindico', `/lgpd/pessoas/${randomUUID()}/anonimizar`)).status).toBe(404);
    expect((await m.api.db.select().from(s.pessoa).where(eq(s.pessoa.id, ana)))[0]!.anonimizadaEm).toBeNull();
  });

  it('apaga os dados, redige a trilha da pessoa, elimina a foto do volume e informa o que fica retido', async () => {
    const bruno = await m.id('Bruno Teixeira');
    await m.entrada(bruno);
    // Correção de cadastro deixa nome e telefone nos snapshots: é o que a redação precisa remover
    expect((await m.api.http().patch(`${V1}/pessoas/${bruno}`).set('Cookie', m.cookies.administracao).send({ telefone: '11912345678' })).status).toBe(200);
    // Foto (a API ainda não recebe foto; o registro é criado aqui como faria o upload)
    const g = await m.cofre.guardar(PNG);
    await m.api.db.insert(s.documento).values({ id: g.id, tipo: 'foto', caminhoStorage: g.caminhoStorage, dekCifrada: g.dekCifrada, nonce: g.nonce,
      chaveVersao: g.chaveVersao, sha256Conteudo: g.sha256Conteudo, mime: 'image/png', tamanhoBytes: g.tamanhoBytes, enviadoPorId: m.api.usuarios['paula.nogueira']!.id });
    await m.api.db.update(s.pessoa).set({ fotoDocumentoId: g.id }).where(eq(s.pessoa.id, bruno));
    const arquivo = join(m.api.config.documentos.dir, g.caminhoStorage);
    expect(existsSync(arquivo)).toBe(true);
    const antes = await trilha(m.api);
    expect(antes.some((l) => l.entidade === 'pessoa' && l.registroId === bruno && JSON.stringify(l.antes ?? l.depois).includes('Bruno'))).toBe(true);

    const r = await m.post('sindico', `/lgpd/pessoas/${bruno}/anonimizar`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ pessoaId: bruno, eventosRetidos: 2, documentosEliminados: 1, retido: expect.arrayContaining([expect.stringMatching(/3 anos/)]) });
    expect(r.body.data.registrosRedigidos).toBeGreaterThanOrEqual(1);
    expect(r.body.data.retidoAte).toMatch(/^20(29|3\d)-\d{2}-\d{2}$/);
    const [p] = await m.api.db.select().from(s.pessoa).where(eq(s.pessoa.id, bruno));
    expect(p).toMatchObject({ nome: 'Pessoa anonimizada', documentoMascarado: null, documentoBusca: null, telefone: null, empresa: null, servico: null, fotoDocumentoId: null });
    expect(p!.anonimizadaEm).toBeInstanceOf(Date);
    expect(existsSync(arquivo)).toBe(false);
    expect((await m.api.db.select().from(s.documento).where(eq(s.documento.id, g.id)))[0]!.eliminadoEm).toBeInstanceOf(Date);
    // Trilha: nenhum snapshot da pessoa guarda nome ou telefone; o registro da anonimização não tem dado pessoal
    const depois = (await trilha(m.api)).filter((l) => l.entidade === 'pessoa' && l.registroId === bruno);
    for (const l of depois) {
      const j = JSON.stringify([l.antes, l.depois]);
      expect(j).not.toContain('Bruno');
      expect(j).not.toMatch(/\*{5}-\d{4}|\d{10,}/); // nenhum telefone, nem mascarado
      // o registro da própria anonimização só lista os NOMES dos campos removidos
      if (l.acao !== 'lgpd.anonimizar') expect(Object.keys({ ...(l.antes as object), ...(l.depois as object) })).not.toEqual(expect.arrayContaining(['telefone']));
    }
    expect(depois.filter((l) => l.acao !== 'lgpd.anonimizar').every((l) => l.redigidoEm)).toBe(true);
    expect(depois.at(-1)).toMatchObject({ acao: 'lgpd.anonimizar', usuarioPapel: 'sindico' });
    const exec = await m.api.db.select().from(s.retencaoExecucao).orderBy(asc(s.retencaoExecucao.executadaEm));
    expect(exec.map((e) => e.tipo)).toEqual(expect.arrayContaining(['audit_redacao', 'pessoas']));
    // Os eventos continuam, só com o id
    expect((await m.api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.pessoaId, bruno))).length).toBe(2);
    // Segunda vez: 409
    expect((await m.post('sindico', `/lgpd/pessoas/${bruno}/anonimizar`)).body.code).toBe('PESSOA_JA_ANONIMIZADA');
  });

  it('anonimizada some da busca, não entra e não recebe vínculo', async () => {
    const bruno = await m.id('Pessoa anonimizada');
    const busca = await m.post('porteiro', '/pessoas/busca', { q: 'Bruno' });
    expect(busca.body.data.itens ?? busca.body.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: bruno })]));
    const anon = await m.post('porteiro', '/pessoas/busca', { q: 'anonimizada' });
    expect(JSON.stringify(anon.body.data)).not.toContain(bruno);
    const e = await m.post('porteiro', '/eventos-acesso', { pessoaId: bruno, unidadeDestinoId: m.d32.id, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('PESSOA_ANONIMIZADA');
    const v = await m.post('administracao', '/vinculos', { pessoaId: bruno, unidadeId: m.d32.id, tipo: 'dependente' });
    expect(v.status).toBe(422);
    expect(v.body.code).toBe('PESSOA_ANONIMIZADA');
  });

  it('app_rw só anonimiza pela função (com motivo válido); a função recusa pessoa já anonimizada', async () => {
    const juliana = await m.id('Juliana Costa');
    await comoAppRw(m.api.client, async () => {
      expect(await erroDe(m.api.client.query(`SELECT lgpd_anonimizar_pessoa('${juliana}', 'qualquer')`))).toMatch(/motivo de anonimização inválido/);
      expect(await erroDe(m.api.client.query('DELETE FROM audit_log'))).toMatch(/permission denied/);
      expect(await erroDe(m.api.client.query(`INSERT INTO retencao_execucao (tipo, quantidade) VALUES ('pessoas', 1)`))).toMatch(/permission denied/);
    });
    const bruno = await m.id('Pessoa anonimizada');
    expect(await erroDe(m.api.client.query(`SELECT lgpd_anonimizar_pessoa('${bruno}', 'pedido')`))).toMatch(/já está anonimizada/);
  });
});

describe('retenção (POST /lgpd/retencao, RNF-09)', () => {
  let m: M;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    m = await montar({ retencao: { anexoOcorrenciaAnos: 1 } });
    const adm = m.api.usuarios['paula.nogueira']!.id;
    // Visitante cadastrado há 4 anos, sem nenhum acesso: elegível
    ids.velho = (await m.visitante('Visitante Antigo')).id;
    // Visitante antigo, mas com acesso recente: não elegível
    ids.recente = (await m.visitante('Visitante Recente')).id; // o acesso dele é registrado no teste, depois dos vencidos
    await m.api.client.exec(`UPDATE pessoa SET criado_em = now() - interval '4 years' WHERE id IN ('${ids.velho}', '${ids.recente}')`);
    // Ex-moradora: último vínculo encerrado há 4 anos (o trigger de transição é desligado só para montar o passado)
    const [ex] = await m.api.db.insert(s.pessoa).values({ nome: 'Ex Moradora', categoria: 'morador', telefone: '11955551111', semCpf: true }).returning();
    ids.ex = ex!.id;
    await m.api.client.exec(`ALTER TABLE vinculo_unidade DISABLE TRIGGER vinculo_unidade_transicao;
      INSERT INTO vinculo_unidade (pessoa_id, unidade_id, tipo, status, registrado_por_id, vigencia_inicio, encerrado_em)
      VALUES ('${ex!.id}', '${m.d32.id}', 'proprietario', 'encerrado', '${adm}', '2018-01-01', now() - interval '4 years');
      ALTER TABLE vinculo_unidade ENABLE TRIGGER vinculo_unidade_transicao;`);
  });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('só o síndico roda; administração 403', async () => {
    expect((await m.post('administracao', '/lgpd/retencao')).status).toBe(403);
    expect((await m.get('administracao', '/lgpd/retencao')).status).toBe(403);
    expect((await m.get('sindico', '/lgpd/retencao')).body.data).toEqual({ ultima: null });
  });

  it('eventos vencidos SEM selo no corte não saem; anonimiza só quem passou do prazo', async () => {
    const marcos = await m.id('Marcos Pereira');
    for (let i = 0; i < 3; i++) await m.entrada(marcos); // seq 1..6: vão vencer
    await m.entrada(ids.recente); // seq 7..8: acesso recente
    await envelhecerEventos(m.api, 6);
    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.status).toBe(200);
    // velho: nunca entrou, cadastro de 4 anos; Marcos: último acesso há 4 anos; ex-moradora: vínculo encerrado há 4 anos
    expect(r.body.data).toMatchObject({ visitantesPrestadores: 2, moradores: 1, eventosDescartados: 0, eventosVencidosSemSelo: 6, prazoAnexosDefinido: true });
    expect(r.body.data.pessoaIds.sort()).toEqual([ids.velho, marcos, ids.ex].sort());
    expect((await m.api.db.select().from(s.eventoAcesso)).length).toBe(8);
    expect((await m.api.db.select().from(s.pessoa).where(eq(s.pessoa.id, ids.recente)))[0]!.anonimizadaEm).toBeNull();
    // vínculo da ex-moradora continua (encerrado), ligado só pelo id
    expect((await m.api.db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.pessoaId, ids.ex))).length).toBe(1);
    // A trilha e a tela: última execução com o mesmo formato do POST
    const u = await m.get('sindico', '/lgpd/retencao');
    expect(u.body.data.ultima).toMatchObject({ porNome: 'Carlos Andrade', resultado: { visitantesPrestadores: 2, moradores: 1, eventosVencidosSemSelo: 6 } });
  });

  it('com selo no meio do vencido: descarta o prefixo até o selo; a verificação recomeça do selo; segunda execução não faz nada', async () => {
    await seloEm(m.api, 4);
    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.body.data).toMatchObject({ eventosDescartados: 4, eventosVencidosSemSelo: 2, visitantesPrestadores: 0, moradores: 0 });
    const restantes = await m.api.db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq));
    expect(restantes[0]!.seq).toBe(5);
    expect((await m.get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: true, verificados: 4 });
    const deNovo = await m.post('sindico', '/lgpd/retencao');
    expect(deNovo.body.data).toMatchObject({ eventosDescartados: 0, visitantesPrestadores: 0, moradores: 0, registrosRedigidos: 0, trilhaDescartada: 0, anexosEliminados: 0, arquivosOrfaosRemovidos: 0 });
  });

  it('trilha de alterações com mais de 3 anos sai (e só ela); app_rw não apaga direto', async () => {
    const total = (await trilha(m.api)).length;
    await m.api.client.exec(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_imutavel; UPDATE audit_log SET em = em - interval '4 years' WHERE seq <= 5; ALTER TABLE audit_log ENABLE TRIGGER audit_log_imutavel;`);
    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.body.data.trilhaDescartada).toBe(5);
    expect((await trilha(m.api)).length).toBe(total - 5 + 1); // + o registro desta execução
    const [x] = await m.api.db.select().from(s.retencaoExecucao).where(eq(s.retencaoExecucao.tipo, 'audit_descarte'));
    expect(x).toMatchObject({ quantidade: 5 });
  });

  it('anexo de ocorrência encerrada há mais do prazo é eliminado (arquivo e registro); órfão velho sai, órfão novo fica; registro sem arquivo é contado', async () => {
    const oc = await m.post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Portão danificado' });
    const an = await m.api.http().post(`${V1}/ocorrencias/${oc.body.data.id}/anexos`).set('Cookie', m.cookies.porteiro).attach('arquivo', PNG, { filename: 'x.png', contentType: 'image/png' });
    const doc = an.body.data.documentos[0].id as string;
    await m.post('sindico', `/ocorrencias/${oc.body.data.id}/status`, { status: 'em_andamento' });
    await m.post('sindico', `/ocorrencias/${oc.body.data.id}/status`, { status: 'encerrada' });
    await m.api.client.exec(`ALTER TABLE ocorrencia_status_historico DISABLE TRIGGER ocorrencia_historico_imutavel;
      UPDATE ocorrencia_status_historico SET em = em - interval '2 years' WHERE ocorrencia_id = '${oc.body.data.id}';
      ALTER TABLE ocorrencia_status_historico ENABLE TRIGGER ocorrencia_historico_imutavel;`);
    const dir = m.api.config.documentos.dir;
    await mkdir(dir, { recursive: true });
    const velho = join(dir, `${randomUUID()}.bin`);
    const novo = join(dir, `${randomUUID()}.bin`);
    await writeFile(velho, 'lixo'); await writeFile(novo, 'lixo');
    const agora = m.api.relogio.agora().getTime() / 1000;
    await utimes(velho, agora - 7200, agora - 7200);
    await utimes(novo, agora, agora);
    // registro ativo cujo arquivo sumiu
    const g = await m.cofre.guardar(PNG);
    await m.api.db.insert(s.documento).values({ id: g.id, tipo: 'outro', caminhoStorage: g.caminhoStorage, dekCifrada: g.dekCifrada, nonce: g.nonce,
      chaveVersao: g.chaveVersao, sha256Conteudo: g.sha256Conteudo, mime: 'image/png', tamanhoBytes: g.tamanhoBytes, enviadoPorId: m.api.usuarios['paula.nogueira']!.id });
    await rm(join(dir, g.caminhoStorage));

    const r = await m.post('sindico', '/lgpd/retencao');
    expect(r.body.data).toMatchObject({ anexosEliminados: 1, arquivosOrfaosRemovidos: 2, registrosSemArquivo: 1 });
    expect(existsSync(join(dir, `${doc}.bin`))).toBe(false);
    expect(existsSync(velho)).toBe(false);
    expect(existsSync(novo)).toBe(true);
    expect((await m.api.db.select().from(s.documento).where(eq(s.documento.id, doc)))[0]!.eliminadoEm).toBeInstanceOf(Date);
    const baixar = await m.get('sindico', `/ocorrencias/${oc.body.data.id}/anexos/${doc}`);
    expect(baixar.status).toBe(410);
    // idempotente: nada novo
    expect((await m.post('sindico', '/lgpd/retencao')).body.data).toMatchObject({ anexosEliminados: 0, arquivosOrfaosRemovidos: 0, registrosSemArquivo: 1 });
  });
});

describe('selo e âncora externa (spec §4.6)', () => {
  let m: M;
  beforeAll(async () => { m = await montar(); await m.entrada(await m.id('Marcos Pereira')); });
  afterAll(async () => { await m.api.app.close(); await m.api.client.close(); });

  it('papéis: porteiro não vê; administração vê mas não sela; síndico e auditor selam', async () => {
    expect((await m.get('porteiro', '/auditoria/selos')).status).toBe(403);
    expect((await m.get('administracao', '/auditoria/selos')).body.data).toMatchObject({ ultimo: null, pendentesEnvio: 0, agendador: false });
    expect((await m.post('administracao', '/auditoria/selos')).status).toBe(403);
    expect((await m.post('porteiro', '/auditoria/selos')).status).toBe(403);
  });

  it('"Selar agora" sela a cabeça e envia a âncora uma vez; sem evento novo, devolve o mesmo selo sem novo e-mail', async () => {
    const r = await m.post('auditor', '/auditoria/selos');
    expect(r.status).toBe(200);
    const [cab] = await m.api.db.select().from(s.eventoAcessoCadeia);
    expect(r.body.data).toMatchObject({ novo: true, ancora: 'enviada', selo: { tipo: 'manual', ultimoSeq: 2, ultimoHash: cab!.ultimoHash, data: '2026-10-17' } });
    expect(m.ancora.enviados).toHaveLength(1);
    expect(m.ancora.enviados[0]).toMatchObject({ ultimoSeq: 2, ultimoHash: cab!.ultimoHash, data: '2026-10-17' });
    const de2 = await m.post('sindico', '/auditoria/selos');
    expect(de2.body.data).toMatchObject({ novo: false, ancora: 'enviada', selo: { id: r.body.data.selo.id } });
    expect(m.ancora.enviados).toHaveLength(1);
    expect((await m.get('auditor', '/auditoria/selos')).body.data).toMatchObject({ ultimo: { id: r.body.data.selo.id, enviadoPara: 'e-mail: conselho@exemplo.org' }, pendentesEnvio: 0 });
    expect((await trilha(m.api, 'auditoria.selar')).at(-1)).toMatchObject({ usuarioPapel: 'auditor' });
    // a verificação de integridade confere o selo
    expect((await m.get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: true, selosConferidos: 1 });
  });

  it('SMTP fora: o selo fica, a âncora fica pendente e sai no próximo envio', async () => {
    await m.entrada(await m.id('Marcos Pereira'));
    m.ancora.falhar = true;
    const r = await m.post('sindico', '/auditoria/selos');
    expect(r.body.data).toMatchObject({ novo: true, ancora: 'pendente' });
    expect((await m.get('auditor', '/auditoria/selos')).body.data.pendentesEnvio).toBe(1);
    m.ancora.falhar = false;
    expect(await (await m.api.servico<SeloService>(SeloService)).enviarPendentes()).toBe(1);
    expect((await m.get('auditor', '/auditoria/selos')).body.data).toMatchObject({ pendentesEnvio: 0, ultimo: { enviadoEm: expect.any(Number) } });
  });

  it('selo diário do dia: último evento registrado até a meia-noite BRT; um por dia; a âncora leva os eventos do dia', async () => {
    const [ult] = await m.api.db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq));
    const todos = await m.api.db.select().from(s.eventoAcesso).orderBy(asc(s.eventoAcesso.seq));
    const ultimo = todos.at(-1)!;
    const dia = new Date(ultimo.registradoEm.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const selo = await m.api.servico<SeloService>(SeloService);
    const a = await selo.selarDia(dia);
    expect(a).toMatchObject({ novo: true, selo: { tipo: 'diario', data: dia, ultimoSeq: ultimo.seq, ultimoHash: ultimo.hash } });
    expect((await selo.selarDia(dia))).toMatchObject({ novo: false, selo: { id: a!.selo.id } });
    expect(await erroDe(m.api.db.insert(s.seloCadeia).values({ data: dia, tipo: 'diario', ultimoSeq: ult!.seq, ultimoHash: ult!.hash }))).toMatch(/selo_cadeia_diario_uq|duplicate/);
    expect(await selo.enviarPendentes()).toBe(1);
    expect(m.ancora.enviados.at(-1)).toMatchObject({ tipo: 'diario', eventosNoDia: todos.filter((e) => e.registradoEm.getTime() >= Date.parse(`${dia}T03:00:00Z`)).length });
    // Dia sem evento antes dele (cadeia já tem eventos): nada a selar
    expect(await selo.selarDia('2020-01-01')).toBeNull();
  });

  it('conferir âncora: confere, diverge, seq inexistente; fica na trilha', async () => {
    const [e] = await m.api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, 2));
    expect((await m.post('auditor', '/auditoria/selos/conferir', { seq: 2, hash: ` ${e!.hash.toUpperCase()} ` })).body.data)
      .toMatchObject({ confere: true, motivo: 'confere', seloRegistrado: true, hashNoBanco: e!.hash });
    expect((await m.post('auditor', '/auditoria/selos/conferir', { seq: 2, hash: 'a'.repeat(64) })).body.data).toMatchObject({ confere: false, motivo: 'hash_divergente' });
    expect((await m.post('auditor', '/auditoria/selos/conferir', { seq: 999, hash: 'a'.repeat(64) })).body.data).toMatchObject({ confere: false, motivo: 'seq_inexistente' });
    expect((await m.post('auditor', '/auditoria/selos/conferir', { seq: 2, hash: 'xyz' })).status).toBe(400);
    expect((await m.post('porteiro', '/auditoria/selos/conferir', { seq: 2, hash: e!.hash })).status).toBe(403);
    expect((await trilha(m.api, 'auditoria.conferirAncora')).length).toBe(3);
  });

  it('o e-mail da âncora tem o hash e nenhum dado pessoal', () => {
    const t = textoDoEmail({ id: randomUUID(), data: '2026-10-17', tipo: 'diario', ultimoSeq: 42, ultimoHash: 'f'.repeat(64), eventosNoDia: 7, seladoEm: new Date('2026-10-18T03:10:00Z') });
    expect(t.assunto).toContain('2026-10-17');
    expect(t.texto).toContain('f'.repeat(64));
    expect(t.texto).toContain('seq): 42');
    expect(t.texto).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
  });
});

describe('agendador e destinos da âncora', () => {
  it('ciclo: sela o dia anterior (gênese se a cadeia está vazia) e roda a retenção uma vez por dia', async () => {
    const m = await montar();
    try {
      const ag = m.api.app.get(Agendador);
      await ag.ciclo();
      const selos = await m.api.db.select().from(s.seloCadeia);
      expect(selos).toEqual([expect.objectContaining({ tipo: 'diario', data: '2026-10-16', ultimoSeq: 0 })]);
      expect(m.ancora.enviados).toHaveLength(1);
      const t = await trilha(m.api, 'lgpd.retencao');
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({ usuarioId: null, usuarioNome: 'Agendador (sistema)' });
      await ag.ciclo(); // segunda vez no mesmo dia: nada
      expect(await m.api.db.select().from(s.seloCadeia)).toHaveLength(1);
      expect(await trilha(m.api, 'lgpd.retencao')).toHaveLength(1);
    } finally { await m.api.app.close(); await m.api.client.close(); }
  });

  it('arquivo append-only: uma linha JSON por selo, sem apagar as anteriores', async () => {
    const arquivo = join(tmpdir(), `ancoras-${process.pid}-${Date.now()}`, 'ancoras.jsonl');
    const envio = new EnvioAncoraReal(configDeTeste({ ancora: { github: false, emails: [], remetente: 'portaria@localhost', smtp: null, arquivo } }));
    expect(envio.destinos()).toEqual(['arquivo append-only']);
    const base = { id: randomUUID(), data: '2026-10-17', tipo: 'diario' as const, ultimoHash: 'a'.repeat(64), eventosNoDia: 1, seladoEm: new Date() };
    await envio.enviar({ ...base, ultimoSeq: 1 });
    await envio.enviar({ ...base, ultimoSeq: 2 });
    const linhas = (await readFile(arquivo, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(linhas.map((l) => l.ultimoSeq)).toEqual([1, 2]);
  });

  it('config: produção exige destino externo da âncora (github ou e-mail com TLS); SMTP e destinatários vão juntos', () => {
    const base = {
      PORTARIA_AMBIENTE: 'dev', COOKIE_SECURE: 'false', TRUST_PROXY: 'false',
      PORTARIA_HMAC_CPF_KEY: Buffer.alloc(32, 1).toString('base64'), PORTARIA_KEK: Buffer.alloc(32, 2).toString('base64'), PORTARIA_KEK_VERSAO: '1',
    };
    const c = carregarConfig(base);
    expect(c.ancora).toEqual({ github: false, emails: [], remetente: 'portaria@localhost', smtp: null, arquivo: null });
    expect(c.jobs).toEqual({ agendador: true, intervaloMin: 10, horaRetencaoBrt: 3 });
    expect(c.retencao).toEqual({ anexoOcorrenciaAnos: null });
    const dev = carregarConfig({ ...base, ANCORA_EMAILS: 'sindico@exemplo.org, conselho@exemplo.org', ANCORA_SMTP_HOST: 'mailpit', ANCORA_SMTP_PORTA: '1025', ANCORA_SMTP_TLS: 'nenhum', JOBS_AGENDADOR: 'false' });
    expect(dev.ancora.smtp).toMatchObject({ host: 'mailpit', porta: 1025, tls: 'nenhum', usuario: null });
    expect(dev.ancora.emails).toHaveLength(2);
    expect(dev.jobs.agendador).toBe(false);
    const prod = { ...base, PORTARIA_AMBIENTE: 'producao', COOKIE_SECURE: 'true' };
    expect(() => carregarConfig(prod)).toThrow(/ANCORA_DESTINOS \(github e\/ou email\) é obrigatória/);
    // Destino github: produção sobe sem e-mail nem SMTP
    expect(carregarConfig({ ...prod, ANCORA_DESTINOS: 'github' }).ancora).toMatchObject({ github: true, emails: [], smtp: null });
    expect(carregarConfig({ ...prod, ANCORA_DESTINOS: 'github, email', ANCORA_EMAILS: 'a@b.org', ANCORA_SMTP_HOST: 'smtp.exemplo.org' }).ancora)
      .toMatchObject({ github: true, emails: ['a@b.org'] });
    expect(() => carregarConfig({ ...prod, ANCORA_DESTINOS: 'git' })).toThrow(/destino desconhecido/);
    expect(() => carregarConfig({ ...prod, ANCORA_DESTINOS: 'email' })).toThrow(/ANCORA_EMAILS está vazia/);
    // Ambíguo: e-mail configurado mas fora da lista explícita (o e-mail não sairia, sem ninguém perceber)
    expect(() => carregarConfig({ ...prod, ANCORA_DESTINOS: 'github', ANCORA_EMAILS: 'a@b.org', ANCORA_SMTP_HOST: 'smtp.exemplo.org' })).toThrow(/não está em ANCORA_DESTINOS/);
    // Sem ANCORA_DESTINOS, ANCORA_EMAILS continua bastando (comportamento anterior)
    expect(carregarConfig({ ...prod, ANCORA_EMAILS: 'a@b.org', ANCORA_SMTP_HOST: 'smtp.exemplo.org' }).ancora.github).toBe(false);
    expect(() => carregarConfig({ ...prod, ANCORA_EMAILS: 'a@b.org', ANCORA_SMTP_HOST: 'smtp', ANCORA_SMTP_TLS: 'nenhum' })).toThrow(/não é permitido/);
    expect(carregarConfig({ ...prod, ANCORA_EMAILS: 'a@b.org', ANCORA_SMTP_HOST: 'smtp.exemplo.org', ANCORA_SMTP_USUARIO: 'u', ANCORA_SMTP_SENHA: 'p' }).ancora.smtp)
      .toMatchObject({ porta: 587, tls: 'starttls' });
    expect(() => carregarConfig({ ...base, ANCORA_EMAILS: 'a@b.org' })).toThrow(/exige ANCORA_SMTP_HOST/);
    expect(() => carregarConfig({ ...base, ANCORA_EMAILS: 'não-é-email', ANCORA_SMTP_HOST: 'x' })).toThrow(/endereço inválido/);
    expect(() => carregarConfig({ ...base, ANCORA_SMTP_HOST: 'x' })).toThrow(/para quem/);
    expect(() => carregarConfig({ ...base, ANCORA_ARQUIVO: 'relativo' })).toThrow(/caminho absoluto/);
    expect(() => carregarConfig({ ...base, RETENCAO_ANEXO_OCORRENCIA_ANOS: '0' })).toThrow(/RETENCAO_ANEXO_OCORRENCIA_ANOS/);
    expect(carregarConfig({ ...base, RETENCAO_ANEXO_OCORRENCIA_ANOS: '5' }).retencao.anexoOcorrenciaAnos).toBe(5);
  });
});
