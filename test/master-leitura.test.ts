// Leitura auditada dos dados de um condomínio pelo app do Master (docs/05_arquitetura_saas.md SAAS-09, F5 entrega 2):
// "tudo que o síndico vê", só leitura, com a view do síndico MINIMIZADA (nome de terceiro mascarado, texto livre oculto,
// placa mascarada: src/master/minimizacao.ts) e a rota do síndico intacta; uma linha `plataforma.*` no audit_log DAQUELE
// condomínio por requisição, antes de devolver o dado (falhou: 503 e nada sai); uma linha em plataforma_audit; ponto
// único (AcessoPlataformaService) provado por teste de arquitetura; e a tela "Acessos da plataforma" do condomínio.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mascararNome } from '../src/dominio/nome';
import { AuditoriaService } from '../src/auditoria/auditoria.service';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { nomeCookieMaster } from '../src/master/cookie-master';
import { minimizarLeituraPlataforma, TEXTO_LIVRE_OCULTO } from '../src/master/minimizacao';
import { criarUsuario } from '../src/master/usuario-plataforma';
import { ResolvedorCondominio } from '../src/saas/resolvedor';
import { condominio, masterUsuario, plataformaAudit } from '../src/saas/schema-plataforma';
import { semearDadosE2e, USUARIOS_E2E } from './e2e/dados';
import { type ApiDeTeste, novaApi, novoIp } from './helpers/app';
import { CHAVE_HMAC_TESTE, SENHA_FALSA } from './helpers/banco';
import { DEMO } from './helpers/saas';

const V1 = '/api/v1';
const P = `${V1}/plataforma`;
const SENHA_M = 'senha-do-master-bem-longa-1';
const EMAIL = 'master@exemplo.test';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('ANEXO DE TESTE '.repeat(8))]);

let api: ApiDeTeste;
let master: string;
let masterId: string;
let suporte: string;
const sindico: Record<string, string> = {};
const ids: Record<string, string> = {};

async function novoMaster(email: string, papel: 'master' | 'suporte') {
  const c = await criarUsuario(api.plataforma.db, {
    hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
  }, { email, nome: `Operador ${papel}`, papel });
  await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
  const r = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', novoIp()).send({ email, senha: SENHA_M });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const linha = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!;
  return { cookie: linha.split(';')[0]!, id: c.id };
}

const linhasPlataforma = (db = api.db) => db.select().from(s.auditLog).where(eq(s.auditLog.usuarioNome, `plataforma/${EMAIL}`)).orderBy(s.auditLog.seq);
const trilhaP = () => api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.masterUsuarioId, masterId)).orderBy(plataformaAudit.seq);
const getM = (caminho: string, cookie = master, cond = api.pilotoId) => api.http().get(`${P}/condominios/${cond}${caminho}`).set('Cookie', cookie);
const getS = (caminho: string, login = 'carlos.andrade') => api.http().get(`${V1}${caminho}`).set('Cookie', sindico[login]!);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  api = await novaApi({}, { demo: true });
  api.relogio.atual = new Date(); // os dados do e2e são relativos à hora real
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  await seedPessoasDev(api.demo!.db, { chaveHmac: DEMO.hmac, agora: api.relogio.agora() });
  await api.db.insert(s.usuarioSistema).values(USUARIOS_E2E.map((u) => ({ ...u, senhaHash: SENHA_FALSA, deveTrocarSenha: false })));
  await semearDadosE2e(api.app);
  for (const p of ['sindico', 'administracao', 'porteiro', 'auditor'] as const) sindico[{ sindico: 'carlos.andrade', administracao: 'paula.nogueira', porteiro: 'joao.lima', auditor: 'luiza.campos' }[p]] = (await api.como(p)).cookie;

  const um = async <T>(q: Promise<T[]>) => (await q)[0]!;
  ids.pessoa = (await um(api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro')))).id;
  ids.unidade = (await um(api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32'))))).id;
  ids.vinculo = (await um(api.db.select().from(s.vinculoUnidade).limit(1))).id;
  ids.funcionario = (await um(api.db.select().from(s.funcionario).limit(1))).pessoaId;
  ids.evento = (await um(api.db.select().from(s.eventoAcesso).limit(1))).id;
  ids.encomenda = (await um(api.db.select().from(s.encomenda).limit(1))).id;
  ids.ocorrencia = (await um(api.db.select().from(s.ocorrencia).where(ne(s.ocorrencia.status, 'encerrada')).limit(1))).id;
  const bruno = await um(api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Bruno Teixeira')));
  const a = await api.http().post(`${V1}/autorizacoes-previas`).set('Cookie', sindico['joao.lima']!)
    .send({ unidadeId: ids.unidade, pessoaId: bruno.id, validaAte: '2030-10-30', solicitadaPorPessoaId: ids.pessoa });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const anexo = await api.http().post(`${V1}/ocorrencias/${ids.ocorrencia}/anexos`).set('Cookie', sindico['carlos.andrade']!)
    .attach('arquivo', PNG, { filename: 'f.png', contentType: 'image/png' });
  expect(anexo.status).toBe(201);
  ids.documento = (await um(api.db.select().from(s.ocorrenciaAnexo).where(eq(s.ocorrenciaAnexo.ocorrenciaId, ids.ocorrencia)))).documentoId;

  ({ cookie: master, id: masterId } = await novoMaster(EMAIL, 'master'));
  suporte = (await novoMaster('suporte@exemplo.test', 'suporte')).cookie;
}, 120_000);

afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

/** [rota do condomínio (síndico), rota do Master (sufixo), entidade, registro]: a view do síndico, minimizada no Master. */
const PARES = (): [string, string, string, string | null][] => [
  ['/catalogo', '/catalogo', 'unidade', null],
  ['/unidades?limite=5', '/unidades?limite=5', 'unidade', null],
  [`/unidades/${ids.unidade}`, `/unidades/${ids.unidade}`, 'unidade', ids.unidade!],
  [`/unidades/${ids.unidade}/autorizadores`, `/unidades/${ids.unidade}/autorizadores`, 'unidade', ids.unidade!],
  ['/usuarios', '/usuarios', 'usuario_sistema', null],
  ['/pessoas?limite=10', '/pessoas?limite=10', 'pessoa', null],
  [`/pessoas/${ids.pessoa}`, `/pessoas/${ids.pessoa}`, 'pessoa', ids.pessoa!],
  ['/vinculos', '/vinculos', 'vinculo_unidade', null],
  [`/vinculos/${ids.vinculo}`, `/vinculos/${ids.vinculo}`, 'vinculo_unidade', ids.vinculo!],
  ['/funcionarios', '/funcionarios', 'funcionario', null],
  [`/funcionarios/${ids.funcionario}`, `/funcionarios/${ids.funcionario}`, 'funcionario', ids.funcionario!],
  ['/eventos-acesso?limite=20', '/eventos-acesso?limite=20', 'evento_acesso', null],
  [`/eventos-acesso/${ids.evento}`, `/eventos-acesso/${ids.evento}`, 'evento_acesso', ids.evento!],
  [`/eventos-acesso/${ids.evento}/correcoes`, `/eventos-acesso/${ids.evento}/correcoes`, 'evento_acesso', ids.evento!],
  ['/acessos/presentes', '/acessos/presentes', 'evento_acesso', null],
  ['/autorizacoes-previas/hoje', '/autorizacoes-previas/hoje', 'autorizacao_previa', null],
  [`/autorizacoes-previas?unidadeId=${ids.unidade}`, `/autorizacoes-previas?unidadeId=${ids.unidade}`, 'autorizacao_previa', ids.unidade!],
  ['/restricoes/pendentes', '/restricoes/pendentes', 'restricao', null],
  [`/restricoes?unidadeId=${ids.unidade}`, `/restricoes?unidadeId=${ids.unidade}`, 'restricao', ids.unidade!],
  ['/encomendas', '/encomendas', 'encomenda', null],
  ['/encomendas/resumo', '/encomendas/resumo', 'encomenda', null],
  [`/encomendas/${ids.encomenda}`, `/encomendas/${ids.encomenda}`, 'encomenda', ids.encomenda!],
  ['/ocorrencias', '/ocorrencias', 'ocorrencia', null],
  [`/ocorrencias/${ids.ocorrencia}`, `/ocorrencias/${ids.ocorrencia}`, 'ocorrencia', ids.ocorrencia!],
  [`/ocorrencias/${ids.ocorrencia}/historico`, `/ocorrencias/${ids.ocorrencia}/historico`, 'ocorrencia', ids.ocorrencia!],
  ['/relatorios/resumo', '/relatorios/resumo', 'relatorio', null],
];

describe('leitura do Master: a view do síndico minimizada, uma linha na trilha do condomínio por requisição', () => {
  it('cada rota GET de leitura do openapi.json tem par aqui (rota nova sem teste de trilha falha)', () => {
    const openapi = JSON.parse(readFileSync(fileURLToPath(new URL('../docs/api/openapi.json', import.meta.url)), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const prefixo = '/plataforma/condominios/{id}';
    const doMaster = Object.entries(openapi.paths).filter(([p]) => p.startsWith(`${prefixo}/`) && p !== `${prefixo}/modulos`)
      .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p.slice(prefixo.length).replace(/\{[^}]+\}/g, ':x')}`))
      // Escrita sobre síndicos (§5.5): test/master-sindicos.test.ts.
      .filter((r) => !/^POST \/sindicos/.test(r)).sort();
    const cobertas = [
      ...PARES().map(([, m]) => `GET ${m.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':x')}`),
      'GET /ocorrencias/:x/anexos/:x', 'GET /relatorios/resumo/csv',
      'GET /sindicos', // sem par no condomínio (o síndico vê a lista de usuários inteira): test/master-sindicos.test.ts
    ];
    expect(doMaster).toEqual([...new Set(cobertas)].sort());
  });

  it('corpo = o do síndico passado pela minimização (nada além dela muda) e uma linha plataforma.ler por requisição', async () => {
    for (const [rotaS, rotaM, entidade, registro] of PARES()) {
      const antes = (await linhasPlataforma()).length;
      const antesP = (await trilhaP()).length;
      const rs = await getS(rotaS);
      const rm = await getM(rotaM);
      expect(rs.status, `${rotaS} ${JSON.stringify(rs.body)}`).toBe(200);
      expect(rm.status, `${rotaM} ${JSON.stringify(rm.body)}`).toBe(200);
      expect(rm.body, rotaM).toEqual(minimizarLeituraPlataforma(rs.body));
      const novas = (await linhasPlataforma()).slice(antes);
      expect(novas.length, rotaM).toBe(1);
      const l = novas[0]!;
      expect([l.usuarioId, l.usuarioPapel, l.acao, l.entidade, l.registroId]).toEqual([null, null, 'plataforma.ler', entidade, registro]);
      expect(l.antes).toBeNull();
      expect(l.depois).toEqual({ rota: expect.any(String), metodo: 'GET', status: 200, master_usuario_id: masterId });
      const rota = (l.depois as { rota: string }).rota;
      expect(rota.replace(/:[a-zA-Z]+/g, ':x'), rotaM).toBe(rotaM.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':x'));
      // A linha da plataforma não leva dado de morador nem id de registro do condomínio.
      const novasP = (await trilhaP()).slice(antesP);
      expect(novasP.map((x) => [x.acao, x.condominioId])).toEqual([['condominio.ler', api.pilotoId]]);
      expect(JSON.stringify(novasP[0]!.detalhes)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    // O demo não recebeu nenhuma linha (cada condomínio só tem a trilha das leituras dele).
    expect(await linhasPlataforma(api.demo!.db as never)).toEqual([]);
  });

  it('a rota gravada é o padrão, sem o prefixo e sem query string', async () => {
    await getM(`/pessoas/${ids.pessoa}?x=1`); // query desconhecida: o ZodPipe não olha a ficha; a rota é o padrão
    const [l] = (await linhasPlataforma()).slice(-1);
    expect((l!.depois as { rota: string }).rota).toBe('/pessoas/:pessoaId');
    await getM('/pessoas?limite=2&categoria=morador');
    const [l2] = (await linhasPlataforma()).slice(-1);
    expect((l2!.depois as { rota: string }).rota).toBe('/pessoas');
  });

  it('usuários: nada de senha nem hash na resposta do Master', async () => {
    const r = await getM('/usuarios');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/senhaHash|senha_hash|"senha"|\$argon2|tokenHash/i);
  });

  it('lista paginada é UMA linha por requisição, não uma por item', async () => {
    const antes = (await linhasPlataforma()).length;
    const r = await getM('/pessoas?limite=100');
    expect(r.body.data.length).toBeGreaterThan(5);
    expect((await linhasPlataforma()).length).toBe(antes + 1);
  });

  it('registro inexistente: 404 e a tentativa fica na trilha com o status', async () => {
    const outro = '00000000-0000-4000-8000-000000000123';
    const r = await getM(`/pessoas/${outro}`);
    expect([r.status, r.body.code]).toEqual([404, 'PESSOA_NAO_ENCONTRADA']);
    const [l] = (await linhasPlataforma()).slice(-1);
    expect([l!.registroId, (l!.depois as { status: number }).status]).toEqual([outro, 404]);
  });

  it('anexo, CSV e JSONL: plataforma.exportar; anexo idêntico ao do síndico, com os mesmos cabeçalhos', async () => {
    const binario = (r: import('supertest').Test) => r.buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    const rs = await binario(getS(`/ocorrencias/${ids.ocorrencia}/anexos/${ids.documento}`));
    const rm = await binario(getM(`/ocorrencias/${ids.ocorrencia}/anexos/${ids.documento}`));
    expect(rm.status).toBe(200);
    expect(Buffer.compare(rm.body as Buffer, rs.body as Buffer)).toBe(0);
    for (const h of ['content-type', 'content-disposition', 'content-security-policy']) expect(rm.headers[h], h).toBe(rs.headers[h]);
    let [l] = (await linhasPlataforma()).slice(-1);
    expect([l!.acao, l!.entidade, l!.registroId]).toEqual(['plataforma.exportar', 'documento', ids.documento]);

    const csv = await getM('/relatorios/resumo/csv');
    expect(csv.status).toBe(200);
    expect(csv.body.data.conteudo).toEqual((await getS('/relatorios/resumo/csv')).body.data.conteudo);
    [l] = (await linhasPlataforma()).slice(-1);
    expect([l!.acao, l!.entidade]).toEqual(['plataforma.exportar', 'relatorio']);

    // Sem JSONL verificável para o Master: o registro com hash não pode ser minimizado (texto livre e placa)
    const antesJ = (await linhasPlataforma()).length;
    const j = await api.http().post(`${P}/condominios/${api.pilotoId}/auditoria/exportacoes`).set('Cookie', master).send({});
    expect(j.status).toBe(404);
    expect((await linhasPlataforma()).length).toBe(antesJ);
  });

  it('o leitor do Master é o pool do condomínio lido: o demo responde com o dado do demo', async () => {
    const r = await getM('/pessoas?limite=100', master, api.demo!.id);
    expect(r.status).toBe(200);
    const doDemo = await api.demo!.db.select({ id: s.pessoa.id }).from(s.pessoa);
    expect(new Set(r.body.data.map((p: { id: string }) => p.id))).toEqual(new Set(doDemo.map((p) => p.id)));
    expect((await linhasPlataforma(api.demo!.db as never)).length).toBe(1);
  });
});

describe('minimização do dado de terceiros (LGPD: o Master é operador)', () => {
  /** Nomes completos de pessoas do banco lido que NÃO são também nome de usuário do sistema (esse fica, por decisão). */
  const nomesDePessoas = async () => {
    const usuarios = new Set((await api.db.select({ n: s.usuarioSistema.nome }).from(s.usuarioSistema)).map((x) => x.n));
    return (await api.db.select({ n: s.pessoa.nome }).from(s.pessoa)).map((x) => x.n).filter((n) => n.includes(' ') && !usuarios.has(n));
  };

  it('nenhuma resposta do Master tem o nome completo de uma pessoa; as mesmas rotas do síndico têm', async () => {
    const nomes = await nomesDePessoas();
    expect(nomes.length).toBeGreaterThan(10);
    const vistosPeloSindico = new Set<string>();
    for (const [rotaS, rotaM] of PARES()) {
      const corpoM = JSON.stringify((await getM(rotaM)).body);
      const corpoS = JSON.stringify((await getS(rotaS)).body);
      for (const n of nomes) {
        expect(corpoM, `${rotaM}: ${n}`).not.toContain(n);
        if (corpoS.includes(n)) vistosPeloSindico.add(n);
      }
    }
    // A comparação acima só prova algo se o síndico recebe esses nomes nas mesmas rotas.
    expect(vistosPeloSindico.size).toBeGreaterThan(10);
  });

  it('ficha: nome mascarado no formato do protótipo para o Master, completo para o síndico', async () => {
    const m = await getM(`/pessoas/${ids.pessoa}`);
    const sx = await getS(`/pessoas/${ids.pessoa}`);
    expect(m.body.data.pessoa.nome).toBe('Ana R******');
    expect(sx.body.data.pessoa.nome).toBe('Ana Ribeiro');
    for (const v of m.body.data.vinculos) expect(v.pessoaNome).toBe(mascararNome(v.pessoaNome));
  });

  it('texto livre oculto (ocorrência, restrição); vazio continua vazio; o síndico vê o texto', async () => {
    const ocS = (await getS(`/ocorrencias/${ids.ocorrencia}`)).body.data;
    const ocM = (await getM(`/ocorrencias/${ids.ocorrencia}`)).body.data;
    expect(ocS.descricao.length).toBeGreaterThan(0);
    expect(ocS.descricao).not.toBe(TEXTO_LIVRE_OCULTO);
    expect(ocM.descricao).toBe(TEXTO_LIVRE_OCULTO);
    expect(ocM.envolvidos).toBe(ocS.envolvidos.trim() ? TEXTO_LIVRE_OCULTO : ocS.envolvidos);
    const rs = (await getS(`/restricoes?unidadeId=${ids.unidade}`)).body.data;
    const rm = (await getM(`/restricoes?unidadeId=${ids.unidade}`)).body.data;
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0].motivo).not.toBe(TEXTO_LIVRE_OCULTO);
    expect(rm[0].motivo).toBe(TEXTO_LIVRE_OCULTO);
  });

  it('nome de usuário do sistema fica (síndicos e operadores): o Master gerencia os síndicos pelo nome', async () => {
    const u = (await getM('/usuarios')).body.data.map((x: { nome: string }) => x.nome);
    expect(u).toContain('Carlos Andrade');
    expect((await getM('/sindicos')).body.data.map((x: { nome: string }) => x.nome)).toContain('Carlos Andrade');
    const ev = (await getM('/eventos-acesso?limite=20')).body.data;
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.map((e: { operadorNome: string }) => e.operadorNome)).toEqual((await getS('/eventos-acesso?limite=20')).body.data.map((e: { operadorNome: string }) => e.operadorNome));
  });

});

describe('a trilha vem antes do dado: falhou a gravação, 503 e nada sai', () => {
  it('falha no audit_log do condomínio', async () => {
    const svc = api.app.get(AuditoriaService);
    const espiao = vi.spyOn(svc, 'registrarPlataforma').mockRejectedValueOnce(Object.assign(new Error('x'), { code: '53100' }));
    const r = await getM(`/pessoas/${ids.pessoa}`);
    espiao.mockRestore();
    expect([r.status, r.body.code]).toEqual([503, 'TRILHA_INDISPONIVEL']);
    expect(JSON.stringify(r.body)).not.toContain('Ana');
    expect(r.body.data).toBeUndefined();
  });

  it('falha no plataforma_audit (a linha do condomínio já entrou: o síndico vê a tentativa)', async () => {
    const antes = (await linhasPlataforma()).length;
    const espiao = vi.spyOn(api.plataforma.db, 'insert').mockImplementationOnce(() => { throw new Error('plataforma fora'); });
    const r = await getM('/pessoas?limite=3');
    espiao.mockRestore();
    expect([r.status, r.body.code]).toEqual([503, 'TRILHA_INDISPONIVEL']);
    expect(r.body.data).toBeUndefined();
    expect((await linhasPlataforma()).length).toBe(antes + 1);
  });
});

describe('quem lê e o que se lê', () => {
  it('suporte não lê (só master); sem sessão 401; sessão de condomínio não abre a rota da plataforma', async () => {
    const r = await getM('/pessoas', suporte);
    expect([r.status, r.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    expect((await api.http().get(`${P}/condominios/${api.pilotoId}/pessoas`)).status).toBe(401);
    expect((await api.http().get(`${P}/condominios/${api.pilotoId}/pessoas`).set('Cookie', sindico['carlos.andrade']!)).status).toBe(401);
    const [neg] = (await api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'acesso.negado'))).slice(-1);
    expect((neg!.detalhes as { acao: string }).acao).toBe('condominio.ler');
  });

  it('condomínio desconhecido 404; provisionando 409; encerrado lê (fim de contrato); excluído 404', async () => {
    expect((await getM('/pessoas', master, '00000000-0000-4000-8000-000000000999')).status).toBe(404);
    const resolvedor = api.app.get(ResolvedorCondominio);
    const status = async (st: 'provisionando' | 'ativo' | 'encerrado' | 'excluido') => {
      await api.plataforma.db.update(condominio).set({ status: st, encerradoEm: ['encerrado', 'excluido'].includes(st) ? new Date() : null }).where(eq(condominio.id, api.demo!.id));
      resolvedor.invalidar();
    };
    try {
      await status('provisionando');
      expect((await getM('/pessoas', master, api.demo!.id)).body.code).toBe('CONDOMINIO_PROVISIONANDO');
      await status('encerrado');
      expect((await getM('/pessoas', master, api.demo!.id)).status).toBe(200);
      await status('excluido');
      expect((await getM('/pessoas', master, api.demo!.id)).status).toBe(404);
    } finally {
      await status('ativo');
    }
  });

  it('módulo desligado não bloqueia a leitura do Master (o dado continua existindo)', async () => {
    const [c] = await api.plataforma.db.select().from(condominio).where(eq(condominio.id, api.pilotoId));
    await api.plataforma.db.update(condominio).set({ modulos: [] }).where(eq(condominio.id, api.pilotoId));
    api.app.get(ResolvedorCondominio).invalidar();
    try {
      expect((await getS('/encomendas')).body.code).toBe('MODULO_DESLIGADO');
      expect((await getM('/encomendas')).status).toBe(200);
      expect((await getM('/relatorios/resumo')).status).toBe(200);
    } finally {
      await api.plataforma.db.update(condominio).set({ modulos: c!.modulos }).where(eq(condominio.id, api.pilotoId));
      api.app.get(ResolvedorCondominio).invalidar();
    }
  });

  it('nenhuma rota de escrita no condomínio a partir da plataforma', async () => {
    for (const [m, url] of [['post', '/pessoas'], ['patch', `/pessoas/${ids.pessoa}`], ['post', `/encomendas/${ids.encomenda}/retirada`], ['post', '/eventos-acesso']] as const) {
      const r = await api.http()[m](`${P}/condominios/${api.pilotoId}${url}`).set('Cookie', master).send({});
      expect(r.status, `${m} ${url}`).toBe(404);
    }
  });
});

describe('tela "Acessos da plataforma" (GET /auditoria/acessos-plataforma)', () => {
  it('síndico e auditor veem; administração e porteiro não', async () => {
    for (const [login, esperado] of [['carlos.andrade', 200], ['luiza.campos', 200], ['paula.nogueira', 403], ['joao.lima', 403]] as const) {
      expect((await getS('/auditoria/acessos-plataforma', login)).status, login).toBe(esperado);
    }
  });

  it('só as linhas plataforma.*: quando, quem, o quê, rota; mais recentes primeiro; paginado; período', async () => {
    const r = await getS('/auditoria/acessos-plataforma?limite=3');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(3);
    expect(r.body.pagination.hasNextPage).toBe(true);
    const item = r.body.data[0];
    expect(Object.keys(item).sort()).toEqual(['acao', 'alvo', 'em', 'entidade', 'id', 'metodo', 'motivo', 'quem', 'registroId', 'rota', 'status', 'troca']);
    expect([item.motivo, item.alvo, item.troca]).toEqual([null, null, null]); // só nas ações sobre síndicos
    expect(item.quem).toBe(`plataforma/${EMAIL}`);
    for (const x of r.body.data) expect(x.acao).toMatch(/^plataforma\.(ler|exportar)$/);
    const todas = await linhasPlataforma();
    expect(r.body.data[0].id).toBe(todas[todas.length - 1]!.id);
    const r2 = await getS(`/auditoria/acessos-plataforma?limite=3&cursor=${r.body.pagination.cursor}`);
    expect(r2.body.data[0].id).toBe(todas[todas.length - 4]!.id);
    // Período no futuro: nada.
    const amanha = Date.now() + 86_400_000;
    expect((await getS(`/auditoria/acessos-plataforma?de=${amanha}`)).body.data).toEqual([]);
    // Os filtros e o corpo não estão na trilha (só rota, método, status, master).
    expect(JSON.stringify(todas.map((l) => l.depois))).not.toMatch(/limite|categoria|Ana Ribeiro/);
  });
});

describe('arquitetura: ponto único', () => {
  const raiz = fileURLToPath(new URL('../src', import.meta.url));
  const arquivos = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? arquivos(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const fontes = arquivos(raiz).map((f) => ({ f: f.slice(raiz.length + 1), texto: readFileSync(f, 'utf8') }));

  it('em src/master, só o AcessoPlataformaService obtém subárvore de condomínio (contextoDoJob, ModuleRef, DB)', () => {
    const citam = fontes.filter((x) => x.f.startsWith('master/') && /\b(contextoDoJob|ModuleRef|registerRequestByContextId|REGISTRO_BANCOS|estrategiaCondominio)\b|\bDB\b.*from '..\/database/.test(x.texto))
      .map((x) => x.f);
    expect(citam).toEqual(['master/acesso-plataforma.service.ts']);
  });

  it('fora de src/master, só os jobs e o próprio contexto montam subárvore por condomínio sem requisição', () => {
    const citam = fontes.filter((x) => /\bcontextoDoJob\(/.test(x.texto)).map((x) => x.f).sort();
    expect(citam).toEqual(['jobs/agendador.ts', 'master/acesso-plataforma.service.ts', 'saas/contexto.ts']);
  });

  it('toda rota do controller de síndicos (escrita, §5.5) passa pelo ponto único, com reautenticação', () => {
    const texto = fontes.find((x) => x.f === 'master/sindicos-master.controller.ts')!.texto;
    const handlers = [...texto.matchAll(/@(Get|Post|Patch|Put|Delete)\(/g)].length;
    const chamadas = [...texto.matchAll(/this\.acesso\.alterarSindico\(m, req, id, b,/g)].length;
    expect(handlers).toBe(5);
    expect(chamadas).toBe(handlers);
    const servico = fontes.find((x) => x.f === 'master/acesso-plataforma.service.ts')!.texto;
    const corpo = servico.slice(servico.indexOf('async alterarSindico('));
    // A reautenticação vem antes de resolver o condomínio e de obter a subárvore.
    expect(corpo.indexOf('this.auth.reautenticar(')).toBeGreaterThan(0);
    expect(corpo.indexOf('this.auth.reautenticar(')).toBeLessThan(corpo.indexOf('this.resolvedor.paraPlataforma('));
    // Fora do ponto único, ninguém chama a escrita do Master nos usuários do condomínio.
    expect(fontes.filter((x) => x.texto.includes('sindicoPelaPlataforma(')).map((x) => x.f).sort())
      .toEqual(['master/acesso-plataforma.service.ts', 'usuarios/usuarios.service.ts']);
  });

  it('toda rota do controller de leitura passa pelo ponto único', () => {
    const texto = fontes.find((x) => x.f === 'master/leitura-master.controller.ts')!.texto;
    const handlers = [...texto.matchAll(/@(Get|Post)\('[^']*'\)/g)].length;
    const chamadas = [...texto.matchAll(/this\.ler\(m, req, id,/g)].length;
    expect(handlers).toBeGreaterThan(20);
    expect(chamadas).toBe(handlers);
  });
});
