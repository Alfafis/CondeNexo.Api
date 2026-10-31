// Encomendas (RF-22 a RF-26, RN-08) e ocorrências (RF-27, RF-28, anexos cifrados da spec §9.2) pela API real
// (HTTP + PGlite + migrações). Relógio da API fixo em 17/10/2026 09:00 BRT; os nomes vêm do seed de pessoas de dev:
// Ana Ribeiro (proprietária aprovada da D-32), Paulo Ribeiro (dependente aprovado da D-32), Rafael Mendes (pendente
// na G-11), Marcos Pereira (visitante com CPF, sem vínculo) e Cláudia Rocha (sem CPF).
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';
import { KEK_TESTE } from './helpers/saas';

const V1 = '/api/v1';
const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
const DIA = 86_400_000;

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
  for (const nome of ['Ana Ribeiro', 'Paulo Ribeiro', 'Rafael Mendes', 'Marcos Pereira', 'Cláudia Rocha', 'Bruno Teixeira', 'Carla Mendes']) {
    ids[nome] = (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  }
  for (const c of ['D-32', 'G-11', 'A-11', 'B-24']) {
    const m = /^([A-Z0-9]+)-(\d+)$/.exec(c)!;
    ids[c] = (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, m[1]!), eq(s.unidade.numero, m[2]!))))[0]!.id;
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await api.app.close(); await api.client.close();
  await rm(api.config.documentos.dir, { recursive: true, force: true });
});

const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const receber = (papel: PapelTeste, unidade = 'D-32', extra: object = {}) =>
  post(papel, '/encomendas', { unidadeId: ids[unidade], destinatario: 'Ana Ribeiro', transportadora: 'Correios', codigoRastreio: 'BR123', unidadeConfirmada: true, ...extra });
const negadosDe = async (acao: string) => (await trilha(api, 'acesso.negado')).filter((l) => (l.depois as { acao?: string }).acao === acao).length;

describe('encomendas: receber (RF-22, RF-23)', () => {
  it('porteiro recebe: 201 com a view do mock (código K, unidade, quem recebeu) e audit_log', async () => {
    const r = await receber('porteiro');
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      codigo: expect.stringMatching(/^K\d+$/), unidadeCodigo: 'D-32', destinatario: 'Ana Ribeiro', transportadora: 'Correios', codigoRastreio: 'BR123',
      recebidaPorNome: 'João Lima', retiradaEm: null, retiradaPorNome: null, autorizacoes: [], unidadeConfirmada: true,
      recebidaEm: api.relogio.agora().getTime(),
    });
    const t = await trilha(api, 'encomenda.receber');
    expect(t.at(-1)).toMatchObject({ registroId: r.body.data.id, entidade: 'encomenda', usuarioPapel: 'porteiro' });
  });

  it('sem conferência da unidade, sem destinatário ou unidade inexistente: 422/404; transportadora e rastreio opcionais', async () => {
    expect((await receber('porteiro', 'D-32', { unidadeConfirmada: false })).body.code).toBe('UNIDADE_NAO_CONFIRMADA');
    expect((await receber('porteiro', 'D-32', { destinatario: '   ' })).body.code).toBe('DESTINATARIO_OBRIGATORIO');
    expect((await post('porteiro', '/encomendas', { unidadeId: '00000000-0000-4000-8000-000000000000', destinatario: 'X', unidadeConfirmada: true })).status).toBe(404);
    const sem = await post('porteiro', '/encomendas', { unidadeId: ids['D-32'], destinatario: 'Paulo', unidadeConfirmada: true });
    expect(sem.status).toBe(201);
    expect(sem.body.data).toMatchObject({ transportadora: '', codigoRastreio: '' });
    expect((await receber('porteiro', 'D-32', { papel: 'sindico' })).status).toBe(400); // campo desconhecido
  });

  it('unidade desativada não recebe encomenda nova (UNIDADE_INATIVA)', async () => {
    expect((await post('administracao', `/unidades/${ids['A-11']}/desativar`)).status).toBe(200);
    try {
      const r = await receber('porteiro', 'A-11');
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('UNIDADE_INATIVA');
    } finally { await post('administracao', `/unidades/${ids['A-11']}/reativar`); }
  });

  it('403 por papel: o auditor só lê (e a negação vai para a trilha)', async () => {
    const antes = await negadosDe('encomenda.operar');
    expect((await receber('auditor')).status).toBe(403);
    expect(await negadosDe('encomenda.operar')).toBe(antes + 1);
    expect((await get('auditor', '/encomendas?status=aguardando')).status).toBe(200);
    expect((await api.http().get(`${V1}/encomendas`)).status).toBe(401);
  });
});

describe('encomendas: entrega (RF-25, RN-08)', () => {
  it('sem vínculo, com vínculo pendente: 422; dependente aprovado retira; a segunda retirada é 409', async () => {
    const e = (await receber('porteiro')).body.data;
    expect((await post('porteiro', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Marcos Pereira'] })).body)
      .toMatchObject({ code: 'PESSOA_SEM_VINCULO', message: expect.stringContaining('D-32') });
    expect((await post('porteiro', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Rafael Mendes'] })).body.code).toBe('PESSOA_SEM_VINCULO');
    expect((await post('porteiro', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Carla Mendes'] })).body.code).toBe('PESSOA_SEM_VINCULO'); // outra unidade
    const ok = await post('porteiro', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Paulo Ribeiro'] });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      retiradaPorPessoaId: ids['Paulo Ribeiro'], retiradaPorNome: 'Paulo Ribeiro (dependente)', retiradaRegistradaPorNome: 'João Lima',
      retiradaAutorizacaoId: null, retiradaEm: api.relogio.agora().getTime(),
    });
    const de_novo = await post('administracao', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Ana Ribeiro'] });
    expect(de_novo.status).toBe(409);
    expect(de_novo.body.code).toBe('ENCOMENDA_JA_ENTREGUE');
    const t = (await trilha(api, 'encomenda.entregar')).filter((l) => l.registroId === e.id);
    expect(t).toHaveLength(1);
    expect(t[0]!.antes).toMatchObject({ retirada_em: null });
  });

  it('duas entregas simultâneas: uma passa, a outra é 409 (linha travada; trigger como última barreira)', async () => {
    const e = (await receber('porteiro')).body.data;
    const rs = await Promise.all([
      post('porteiro', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Ana Ribeiro'] }),
      post('administracao', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Paulo Ribeiro'] }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('auditor não entrega; encomenda inexistente 404; pessoa inexistente 404', async () => {
    const e = (await receber('porteiro')).body.data;
    expect((await post('auditor', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Ana Ribeiro'] })).status).toBe(403);
    expect((await post('porteiro', '/encomendas/00000000-0000-4000-8000-000000000000/retirada', { pessoaId: ids['Ana Ribeiro'] })).body.code).toBe('ENCOMENDA_NAO_ENCONTRADA');
    expect((await post('porteiro', `/encomendas/${e.id}/retirada`, { pessoaId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('PESSOA_NAO_ENCONTRADA');
  });
});

describe('encomendas: autorização de retirada (RN-08)', () => {
  it('regras do mock: solicitante com vínculo, retirante com CPF, não a si mesmo, sem duplicar; depois o terceiro retira', async () => {
    const e = (await receber('porteiro')).body.data;
    const outra = (await receber('porteiro')).body.data;
    const autorizar = (pessoa: string, solicitante: string) =>
      post('porteiro', `/encomendas/${e.id}/autorizacoes-retirada`, { pessoaId: ids[pessoa], solicitadaPorPessoaId: ids[solicitante] });
    expect((await autorizar('Bruno Teixeira', 'Marcos Pereira')).body.code).toBe('SOLICITANTE_SEM_VINCULO');
    expect((await autorizar('Bruno Teixeira', 'Rafael Mendes')).body.code).toBe('SOLICITANTE_SEM_VINCULO'); // pendente
    expect((await autorizar('Cláudia Rocha', 'Ana Ribeiro')).body.code).toBe('CPF_OBRIGATORIO');
    expect((await autorizar('Ana Ribeiro', 'Ana Ribeiro')).body.code).toBe('AUTORIZACAO_PROPRIA');
    const ok = await autorizar('Marcos Pereira', 'Ana Ribeiro');
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ encomendaId: e.id, pessoaAutorizadaId: ids['Marcos Pereira'], solicitantePessoaId: ids['Ana Ribeiro'] });
    expect((await autorizar('Marcos Pereira', 'Paulo Ribeiro')).body.code).toBe('AUTORIZACAO_DUPLICADA');
    expect((await post('auditor', `/encomendas/${e.id}/autorizacoes-retirada`, { pessoaId: ids['Bruno Teixeira'], solicitadaPorPessoaId: ids['Ana Ribeiro'] })).status).toBe(403);

    // A autorização é desta encomenda: na outra, o mesmo terceiro continua sem vínculo
    expect((await post('porteiro', `/encomendas/${outra.id}/retirada`, { pessoaId: ids['Marcos Pereira'] })).body.code).toBe('PESSOA_SEM_VINCULO');
    const det = await get('auditor', `/encomendas/${e.id}`);
    expect(det.body.data.autorizacoes).toEqual([expect.objectContaining({ pessoaNome: 'Marcos Pereira', solicitanteNome: 'Ana Ribeiro' })]);
    const ret = await post('porteiro', `/encomendas/${e.id}/retirada`, { pessoaId: ids['Marcos Pereira'] });
    expect(ret.status).toBe(200);
    expect(ret.body.data).toMatchObject({ retiradaAutorizacaoId: ok.body.data.id, retiradaPorNome: 'Marcos Pereira (autorizado por Ana Ribeiro)' });
    expect((await autorizar('Bruno Teixeira', 'Ana Ribeiro')).body.code).toBe('ENCOMENDA_JA_ENTREGUE');
    expect((await trilha(api, 'encomenda.autorizarRetirada')).at(-1)).toMatchObject({ entidade: 'autorizacao_retirada', registroId: ok.body.data.id });
  });
});

describe('encomendas: filas, atrasadas e contagens (RF-26)', () => {
  it('status separa as filas; página por cursor sem repetir; atrasadas = há mais de 7 dias; resumo e turno batem', async () => {
    const recebida = async (diasAtras: number) => {
      const [e] = await api.db.insert(s.encomenda).values({
        unidadeId: ids['B-24'], destinatario: `Helena ${diasAtras}d`, unidadeConfirmada: true, recebidaPorId: api.usuarios['joao.lima']!.id,
        recebidaEm: new Date(api.relogio.agora().getTime() - diasAtras * DIA - 60_000),
      }).returning();
      return e!.id;
    };
    const antiga = await recebida(9);
    const limite = await recebida(7); // 7 dias e 1 minuto: diasDesde = 7, ainda não é "mais de 7"
    const lista = async (q: string) => {
      const vistos: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const r = await get('porteiro', `/encomendas?${q}&limite=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(r.status).toBe(200);
        vistos.push(...r.body.data.map((e: { id: string }) => e.id));
        if (!r.body.pagination.hasNextPage) break;
        cursor = r.body.pagination.cursor;
      }
      return vistos;
    };
    const aguardando = await lista('status=aguardando');
    const entregues = await lista('status=entregue');
    expect(new Set(aguardando).size).toBe(aguardando.length);
    expect(aguardando).toContain(antiga);
    expect(aguardando.some((id) => entregues.includes(id))).toBe(false);
    expect(aguardando.at(-1)).toBe(antiga); // mais recentes primeiro

    const atr = await get('porteiro', '/encomendas/atrasadas');
    expect(atr.body.data.map((e: { id: string }) => e.id)).toEqual([antiga]);
    expect((await get('porteiro', '/encomendas?atrasadasDias=6')).body.data.map((e: { id: string }) => e.id)).toEqual([limite, antiga]);
    const res = (await get('porteiro', '/encomendas/resumo')).body.data;
    expect(res).toEqual({ aguardando: aguardando.length, atrasadas: 1, entregues: entregues.length, diasAtraso: 7 });
    expect((await get('porteiro', '/turnos/resumo')).body.data.encomendasPendentes).toBe(aguardando.length);
    expect((await get('porteiro', '/encomendas?status=pendente')).status).toBe(400);
    expect((await get('porteiro', '/encomendas?cursor=lixo')).body.code).toBe('CURSOR_INVALIDO');
    expect((await get('porteiro', `/encomendas?unidadeId=${ids['B-24']}`)).body.data).toHaveLength(2);
  });
});

describe('restrição em unidade desativada (correção pendente do lote de acesso)', () => {
  it('criar restrição de unidade ou com origem em unidade inativa é 422 UNIDADE_INATIVA', async () => {
    const validaAte = '2026-12-31';
    expect((await post('administracao', `/unidades/${ids['D-32']}/desativar`)).status).toBe(200);
    try {
      const r = await post('porteiro', '/restricoes', { pessoaId: ids['Marcos Pereira'], unidadeId: ids['D-32'], motivo: 'Morador não autoriza', validaAte, solicitadaPorPessoaId: ids['Ana Ribeiro'] });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('UNIDADE_INATIVA');
      const cond = await post('administracao', '/restricoes', { pessoaId: ids['Marcos Pereira'], unidadeId: ids['D-32'], motivo: 'Ameaçou o porteiro', validaAte, paraTodoCondominio: true, solicitadaPorPessoaId: null });
      expect(cond.body.code).toBe('UNIDADE_INATIVA');
    } finally { await post('administracao', `/unidades/${ids['D-32']}/reativar`); }
    const ok = await post('porteiro', '/restricoes', { pessoaId: ids['Marcos Pereira'], unidadeId: ids['D-32'], motivo: 'Morador não autoriza', validaAte, solicitadaPorPessoaId: ids['Ana Ribeiro'] });
    expect(ok.status).toBe(201);
    await post('administracao', `/restricoes/${ok.body.data.id}/revogar`);
  });
});

describe('ocorrências: abrir, status e eventos (RF-27, RF-28)', () => {
  let eventoId: string;
  let doPorteiro: string;
  beforeAll(async () => {
    const r = await post('porteiro', '/eventos-acesso', {
      pessoaId: ids['Bruno Teixeira'], unidadeDestinoId: ids['G-11'], autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Carla Mendes'],
    });
    expect(r.status).toBe(201);
    eventoId = r.body.data.id;
  });

  it('porteiro abre com evento vinculado (o link do negado): 201, nasce aberta, código OC-ano-nnn, audit', async () => {
    const r = await post('porteiro', '/ocorrencias', {
      tipo: 'tentativa_acesso_indevido', descricao: '  Tentou entrar sem autorização  ', unidadeId: ids['G-11'], envolvidos: 'Bruno Teixeira', eventoIds: [eventoId, eventoId],
    });
    expect(r.status).toBe(201);
    doPorteiro = r.body.data.id;
    expect(r.body.data).toMatchObject({
      codigo: expect.stringMatching(/^OC-2026-\d{3}$/), status: 'aberta', descricao: 'Tentou entrar sem autorização', unidadeCodigo: 'G-11',
      envolvidos: 'Bruno Teixeira', abertaPorNome: 'João Lima', eventoIds: [eventoId], historicoStatus: [], anexos: [], documentos: [],
    });
    expect((await trilha(api, 'ocorrencia.criar')).at(-1)).toMatchObject({ registroId: doPorteiro });
  });

  it('validações: descrição vazia 422, evento ou unidade inexistentes 404, tipo inválido 400; auditor 403', async () => {
    const base = { tipo: 'outro', descricao: 'Portão com defeito', unidadeId: null };
    expect((await post('porteiro', '/ocorrencias', { ...base, descricao: '  ' })).body.code).toBe('DESCRICAO_OBRIGATORIA');
    expect((await post('porteiro', '/ocorrencias', { ...base, eventoIds: ['00000000-0000-4000-8000-000000000000'] })).body.code).toBe('EVENTO_NAO_ENCONTRADO');
    expect((await post('porteiro', '/ocorrencias', { ...base, unidadeId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('UNIDADE_NAO_ENCONTRADA');
    expect((await post('porteiro', '/ocorrencias', { ...base, tipo: 'furto' })).status).toBe(400);
    expect((await post('auditor', '/ocorrencias', base)).status).toBe(403);
    const sem = await post('porteiro', '/ocorrencias', base);
    expect(sem.body.data).toMatchObject({ unidadeId: null, unidadeCodigo: null, envolvidos: '' });
  });

  it('status só para a frente: pular etapa e voltar são 422; encerrada é final (409); histórico com quem e quando', async () => {
    const st = (papel: PapelTeste, status: string) => post(papel, `/ocorrencias/${doPorteiro}/status`, { status });
    expect((await st('porteiro', 'encerrada')).body.code).toBe('TRANSICAO_INVALIDA');
    expect((await st('porteiro', 'aberta')).status).toBe(400); // fora do DTO: nunca se volta para aberta
    const a = await st('porteiro', 'em_andamento');
    expect(a.status).toBe(200);
    expect(a.body.data.status).toBe('em_andamento');
    expect((await st('porteiro', 'em_andamento')).body.code).toBe('TRANSICAO_INVALIDA');
    const enc = await st('porteiro', 'encerrada');
    expect(enc.body.data.historicoStatus).toEqual([
      expect.objectContaining({ de: 'aberta', para: 'em_andamento', porNome: 'João Lima' }),
      expect.objectContaining({ de: 'em_andamento', para: 'encerrada', porNome: 'João Lima' }),
    ]);
    expect((await st('sindico', 'encerrada')).body.code).toBe('OCORRENCIA_ENCERRADA');
    expect((await post('porteiro', `/ocorrencias/${doPorteiro}/eventos`, { eventoIds: [eventoId] })).body.code).toBe('OCORRENCIA_ENCERRADA');
    expect((await get('auditor', `/ocorrencias/${doPorteiro}/historico`)).body.data).toHaveLength(2);
    expect((await trilha(api, 'ocorrencia.alterarStatus')).filter((l) => l.registroId === doPorteiro)).toHaveLength(2);
  });

  it('porteiro em ocorrência alheia: 403 SO_PROPRIA_OCORRENCIA, gravado em acesso.negado; a administração altera a do porteiro', async () => {
    const daAdm = (await post('administracao', '/ocorrencias', { tipo: 'dano', descricao: 'Lâmpada quebrada', unidadeId: null })).body.data;
    const antes = await negadosDe('ocorrencia.operar');
    const r = await post('porteiro', `/ocorrencias/${daAdm.id}/status`, { status: 'em_andamento' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SO_PROPRIA_OCORRENCIA');
    expect(await negadosDe('ocorrencia.operar')).toBe(antes + 1);
    expect((await get('administracao', `/ocorrencias/${daAdm.id}`)).body.data.status).toBe('aberta'); // nada mudou
    const minha = (await post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Barulho', unidadeId: null })).body.data;
    expect((await post('administracao', `/ocorrencias/${minha.id}/status`, { status: 'em_andamento' })).status).toBe(200);
    expect((await post('auditor', `/ocorrencias/${minha.id}/status`, { status: 'encerrada' })).status).toBe(403);
  });

  it('vincular eventos depois: aditivo, repetido é ignorado; evento inexistente 404', async () => {
    const o = (await post('porteiro', '/ocorrencias', { tipo: 'conflito', descricao: 'Discussão na portaria', unidadeId: ids['G-11'] })).body.data;
    const v = await post('porteiro', `/ocorrencias/${o.id}/eventos`, { eventoIds: [eventoId] });
    expect(v.status).toBe(200);
    expect(v.body.data.eventoIds).toEqual([eventoId]);
    expect((await post('porteiro', `/ocorrencias/${o.id}/eventos`, { eventoIds: [eventoId] })).body.data.eventoIds).toEqual([eventoId]);
    expect((await post('porteiro', `/ocorrencias/${o.id}/eventos`, { eventoIds: ['00000000-0000-4000-8000-000000000000'] })).body.code).toBe('EVENTO_NAO_ENCONTRADO');
    expect((await post('porteiro', `/ocorrencias/${o.id}/eventos`, { eventoIds: [] })).status).toBe(400);
    expect((await trilha(api, 'ocorrencia.vincularEventos')).filter((l) => l.registroId === o.id)).toHaveLength(1);
  });

  it('lista paginada por abertura (mais recentes primeiro) com filtro de status e tipo; turno conta as não encerradas', async () => {
    const todas: { id: string; status: string }[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await get('auditor', `/ocorrencias?limite=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      todas.push(...r.body.data);
      if (!r.body.pagination.hasNextPage) break;
      cursor = r.body.pagination.cursor;
    }
    expect(new Set(todas.map((o) => o.id)).size).toBe(todas.length);
    const abertas = (await get('porteiro', '/ocorrencias?status=aberta,em_andamento&limite=100')).body.data;
    expect(abertas.every((o: { status: string }) => o.status !== 'encerrada')).toBe(true);
    expect(abertas).toHaveLength(todas.filter((o) => o.status !== 'encerrada').length);
    expect((await get('porteiro', '/turnos/resumo')).body.data.ocorrenciasAbertas).toBe(abertas.length);
    expect((await get('porteiro', '/ocorrencias?tipo=dano')).body.data.every((o: { tipo: string }) => o.tipo === 'dano')).toBe(true);
    expect((await get('porteiro', '/ocorrencias?status=fechada')).status).toBe(400);
  });
});

describe('ocorrências: anexos cifrados (RNF-03, spec §9.2)', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('CONTEUDO-EM-CLARO-DO-ANEXO '.repeat(20))]);
  const PDF = Buffer.from('%PDF-1.4\nBOLETIM-DE-OCORRENCIA-TEXTO-CLARO\n%%EOF');
  let oc: string;
  const anexar = (papel: PapelTeste, id: string, conteudo: Buffer, nome = 'foto.png', tipo = 'image/png') =>
    api.http().post(`${V1}/ocorrencias/${id}/anexos`).set('Cookie', cookies[papel]).attach('arquivo', conteudo, { filename: nome, contentType: tipo });
  const baixar = (papel: PapelTeste | null, id: string, doc: string) => {
    const r = api.http().get(`${V1}/ocorrencias/${id}/anexos/${doc}`).buffer(true).parse((res, cb) => {
      const partes: Buffer[] = [];
      res.on('data', (c: Buffer) => partes.push(c));
      res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    return papel ? r.set('Cookie', cookies[papel]) : r;
  };

  beforeAll(async () => {
    oc = (await post('porteiro', '/ocorrencias', { tipo: 'dano', descricao: 'Portão riscado', unidadeId: null })).body.data.id;
  });

  it('upload: 201; nome do cliente ignorado (inclusive com path traversal); no disco só o cifrado, sem o texto claro', async () => {
    const r = await anexar('porteiro', oc, PNG, '../../../etc/passwd.png', 'text/plain');
    expect(r.status).toBe(201);
    const [d] = r.body.data.documentos;
    expect(d).toMatchObject({ nome: `anexo-${d.id.slice(0, 8)}.png`, mime: 'image/png', tamanhoBytes: PNG.length, enviadoPorNome: 'João Lima' });
    expect(r.body.data.anexos).toEqual([d.nome]);
    const arquivos = await readdir(api.config.documentos.dir);
    expect(arquivos).toContain(`${d.id}.bin`);
    expect(arquivos.every((a) => /^[0-9a-f-]{36}\.bin$/.test(a))).toBe(true);
    const cifrado = await readFile(join(api.config.documentos.dir, `${d.id}.bin`));
    expect(cifrado.includes(Buffer.from('CONTEUDO-EM-CLARO'))).toBe(false);
    expect(cifrado.length).toBe(PNG.length + 16); // GCM: mesmo tamanho + tag
    const [linha] = await api.db.select().from(s.documento).where(eq(s.documento.id, d.id));
    expect(linha).toMatchObject({ tipo: 'anexo_ocorrencia', caminhoStorage: `${d.id}.bin`, chaveVersao: 1, mime: 'image/png' });
    expect(linha!.sha256Conteudo).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(Buffer.from(linha!.dekCifrada).length).toBe(12 + 32 + 16); // nonce + DEK cifrada + tag
    expect(Buffer.from(linha!.dekCifrada).includes(KEK_TESTE)).toBe(false);
    const t = (await trilha(api, 'ocorrencia.anexar')).at(-1)!;
    expect(JSON.stringify(t.depois)).not.toMatch(/passwd|dek_cifrada|CONTEUDO-EM-CLARO|foto\.png/);
  });

  it('download: síndico e administração recebem o conteúdo exato como anexo; porteiro e auditor 403; sem sessão 401; leitura auditada', async () => {
    const doc = (await get('sindico', `/ocorrencias/${oc}`)).body.data.documentos[0].id;
    const r = await baixar('sindico', oc, doc);
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body as Buffer, PNG)).toBe(0);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="anexo-${doc.slice(0, 8)}.png"`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await baixar('administracao', oc, doc)).status).toBe(200);
    expect((await baixar('porteiro', oc, doc)).status).toBe(403);
    expect((await baixar('auditor', oc, doc)).status).toBe(403);
    expect((await baixar(null, oc, doc)).status).toBe(401);
    expect((await trilha(api, 'documento.ler')).filter((l) => l.registroId === doc)).toHaveLength(2);
    // O documento só sai pela ocorrência a que pertence
    const outra = (await post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Outra', unidadeId: null })).body.data.id;
    expect((await baixar('sindico', outra, doc)).status).toBe(404);
  });

  it('tipo pelo conteúdo: texto com Content-Type de imagem é 415; PDF real passa; vazio 422; acima de 4 MiB 413', async () => {
    const txt = await anexar('porteiro', oc, Buffer.from('<script>alert(1)</script>'), 'foto.png', 'image/png');
    expect(txt.status).toBe(415);
    expect(txt.body.code).toBe('TIPO_NAO_PERMITIDO');
    const pdf = await anexar('porteiro', oc, PDF, 'bo.pdf', 'application/pdf');
    expect(pdf.status).toBe(201);
    expect(pdf.body.data.documentos.map((d: { mime: string }) => d.mime).sort()).toEqual(['application/pdf', 'image/png']);
    expect(pdf.body.data.documentos.every((d: { id: string; nome: string; mime: string }) =>
      d.nome === `anexo-${d.id.slice(0, 8)}.${d.mime === 'application/pdf' ? 'pdf' : 'png'}`)).toBe(true);
    expect((await anexar('porteiro', oc, Buffer.alloc(0))).body.code).toBe('ARQUIVO_VAZIO');
    const grande = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(4 * 1024 * 1024)]);
    const g = await anexar('porteiro', oc, grande);
    expect(g.status).toBe(413);
    expect(g.body.code).toBe('ARQUIVO_GRANDE_DEMAIS');
    const semArquivo = await api.http().post(`${V1}/ocorrencias/${oc}/anexos`).set('Cookie', cookies.porteiro).field('x', 'y');
    expect(semArquivo.status).toBe(400);
  });

  it('porteiro não anexa em ocorrência alheia (403) nem o auditor; até 5 anexos; encerrada não recebe anexo; falha não deixa arquivo', async () => {
    const daAdm = (await post('administracao', '/ocorrencias', { tipo: 'outro', descricao: 'Da administração', unidadeId: null })).body.data.id;
    const antes = (await readdir(api.config.documentos.dir)).length;
    expect((await anexar('porteiro', daAdm, PNG)).body.code).toBe('SO_PROPRIA_OCORRENCIA');
    expect((await anexar('auditor', daAdm, PNG)).status).toBe(403);
    expect((await readdir(api.config.documentos.dir)).length).toBe(antes); // nada gravado em disco
    for (let i = 0; i < 5; i++) expect((await anexar('administracao', daAdm, PNG)).status).toBe(201);
    expect((await anexar('administracao', daAdm, PNG)).body.code).toBe('LIMITE_ANEXOS');
    await post('administracao', `/ocorrencias/${daAdm}/status`, { status: 'em_andamento' });
    await post('administracao', `/ocorrencias/${daAdm}/status`, { status: 'encerrada' });
    const fechada = (await post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Encerrar', unidadeId: null })).body.data.id;
    await post('porteiro', `/ocorrencias/${fechada}/status`, { status: 'em_andamento' });
    await post('porteiro', `/ocorrencias/${fechada}/status`, { status: 'encerrada' });
    const n = (await readdir(api.config.documentos.dir)).length;
    expect((await anexar('porteiro', fechada, PNG)).body.code).toBe('OCORRENCIA_ENCERRADA');
    expect((await readdir(api.config.documentos.dir)).length).toBe(n);
  });

  it('arquivo adulterado no disco não é entregue (500 DOCUMENTO_CORROMPIDO, sem conteúdo parcial)', async () => {
    const o = (await post('porteiro', '/ocorrencias', { tipo: 'outro', descricao: 'Adulteração', unidadeId: null })).body.data.id;
    const doc = (await anexar('porteiro', o, PNG)).body.data.documentos[0].id;
    const caminho = join(api.config.documentos.dir, `${doc}.bin`);
    const c = await readFile(caminho);
    c[5] = c[5]! ^ 0xff;
    await writeFile(caminho, c);
    const r = await baixar('sindico', o, doc);
    expect(r.status).toBe(500);
    expect(JSON.parse((r.body as Buffer).toString('utf8')).code).toBe('DOCUMENTO_CORROMPIDO');
  });
});
