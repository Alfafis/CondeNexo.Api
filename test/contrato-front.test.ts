// O que a API passou a expor como DADO para o CondeNexo.Front não ter regra própria (separação dos repositórios,
// 2026-10-31): permissões da sessão (condomínio e plataforma), /parametros, avaliação da entrada sem gravar, prazo da
// próxima prorrogação nos presentes, encomenda atrasada, senha temporária vencida e a análise da lista de unidades do
// Master. A decisão continua nas guardas e nas escritas: estes testes conferem também que nada aqui grava.
import { and, count, eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { MATRIZ, ROTAS } from '../src/dominio/rbac';
import { MAX_PRORROGACOES, MIN_JUSTIFICATIVA, PRAZO_PADRAO_MIN } from '../src/dominio/rules';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { nomeCookieMaster } from '../src/plataforma/cookie-master';
import { criarUsuario } from '../src/plataforma/usuario-plataforma';
import { condominio, masterUsuario } from '../src/plataforma/schema-plataforma';
import { MODULOS } from '../src/dominio/modulos';
import { ResolvedorCondominio } from '../src/tenancy/resolvedor';
import { type ApiDeTeste, LOGINS, novaApi, novoIp, type PapelTeste, SENHA } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const MIN = 60_000;
const HORA = 60 * MIN;
const SENHA_M = 'senha-do-master-bem-longa-1';
const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
  for (const nome of ['Ana Ribeiro', 'Marcos Pereira', 'Juliana Costa', 'Bruno Teixeira']) {
    ids[nome] = (await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome)))[0]!.id;
  }
  ids['D-32'] = (await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32'))))[0]!.id;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const eventos = async () => Number((await api.db.select({ n: count() }).from(s.eventoAcesso))[0]!.n);

describe('permissões da sessão do condomínio (login, /auth/me, trocar-senha)', () => {
  it('cada papel recebe exatamente as ações da MATRIZ e as telas de ROTAS (todos os módulos ligados)', async () => {
    for (const papel of PAPEIS) {
      const me = (await get(papel, '/auth/me')).body.data;
      const p = me.usuario.papel;
      expect(me.permissoes.acoes.sort()).toEqual(Object.keys(MATRIZ).filter((a) => MATRIZ[a as keyof typeof MATRIZ].includes(p)).sort());
      expect(me.permissoes.rotas.sort()).toEqual(Object.keys(ROTAS).filter((r) => ROTAS[r as keyof typeof ROTAS].includes(p)).sort());
    }
    expect((await get('auditor', '/auth/me')).body.data.permissoes.rotaInicial).toBe('historico');
    expect((await get('administracao', '/auth/me')).body.data.permissoes.rotaInicial).toBe('vinculos');
    expect((await get('porteiro', '/auth/me')).body.data.permissoes.rotaInicial).toBe('painel');
  });

  it('o login já devolve as permissões; a lista do porteiro não tem vínculos, usuários nem correção', async () => {
    const r = await api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp()).send({ login: LOGINS.porteiro, senha: SENHA });
    expect(r.status).toBe(200);
    expect(r.body.data.permissoes.acoes).toContain('evento.registrar');
    expect(r.body.data.permissoes.acoes).not.toContain('evento.corrigir');
    expect(r.body.data.permissoes.rotas).not.toEqual(expect.arrayContaining(['vinculos']));
    expect(r.body.data.permissoes.rotas).not.toContain('usuarios');
  });

  it('módulo desligado some das telas (a ação continua, a ModuloGuard recusa a rota)', async () => {
    await api.plataforma.db.update(condominio).set({ modulos: ['ocorrencias'] }).where(eq(condominio.id, api.pilotoId));
    api.app.get(ResolvedorCondominio).invalidar();
    try {
      const me = (await get('sindico', '/auth/me')).body.data;
      expect(me.modulos).toEqual(['ocorrencias']);
      expect(me.permissoes.rotas).toContain('ocorrencias');
      expect(me.permissoes.rotas).not.toContain('encomendas');
      expect(me.permissoes.rotas).not.toContain('relatorios');
      expect(me.permissoes.rotas).toContain('painel');
    } finally {
      await api.plataforma.db.update(condominio).set({ modulos: [...MODULOS] }).where(eq(condominio.id, api.pilotoId));
      api.app.get(ResolvedorCondominio).invalidar();
    }
  });

  it('as guardas continuam decidindo: a lista é só leitura (auditor recebe 403 em escrita mesmo pedindo direto)', async () => {
    const r = await post('auditor', '/eventos-acesso/avaliacao', { pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['D-32'] });
    expect(r.status).toBe(403);
  });
});

describe('/parametros', () => {
  it('qualquer papel logado lê as constantes que a API aplica; sem sessão, 401', async () => {
    const r = await get('auditor', '/parametros');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      justificativaMin: MIN_JUSTIFICATIVA, prazoPadraoMin: PRAZO_PADRAO_MIN, meiosComMorador: ['interfone', 'celular', 'morador_presente'],
      anexo: { maxBytes: 4 * 1024 * 1024, maxPorOcorrencia: 5, tipos: ['image/jpeg', 'image/png', 'application/pdf'] },
      comprovante: { descricaoMax: 80, observacaoMax: 200 },
    });
    expect((await api.http().get(`${V1}/parametros`)).status).toBe(401);
  });
});

describe('POST /eventos-acesso/avaliacao (rascunho da entrada, sem gravar)', () => {
  it('visitante na unidade: meios da regra, prazo da visita, erro enquanto falta o autorizador; nada é gravado', async () => {
    const antes = await eventos();
    const r = await post('porteiro', '/eventos-acesso/avaliacao', { pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['D-32'] });
    expect(r.status).toBe(200);
    const a = r.body.data;
    expect(a).toMatchObject({ categoria: 'visitante', emEscala: null, tipoVisitaPadrao: 'visita', erro: { code: 'AUTORIZADO_POR_OBRIGATORIO' } });
    expect(a.meiosAceitos).toEqual(['interfone', 'celular', 'morador_presente', 'autorizacao_previa', 'excecao_porteiro']);
    expect(a.prazoAte).toBe(api.relogio.agora().getTime() + 4 * HORA);
    expect(await eventos()).toBe(antes);
  });

  it('com o morador que autorizou: sem erro; tipo "entrega" muda o prazo; exceção curta devolve o erro da regra', async () => {
    const base = { pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['D-32'] };
    const ok = (await post('porteiro', '/eventos-acesso/avaliacao', { ...base, autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Ana Ribeiro'], tipoVisita: 'entrega' })).body.data;
    expect(ok.erro).toBeNull();
    expect(ok.prazoAte).toBe(api.relogio.agora().getTime() + 30 * MIN);
    const curta = (await post('porteiro', '/eventos-acesso/avaliacao', { ...base, autorizadoPorTipo: 'excecao_porteiro', justificativa: 'curta' })).body.data;
    expect(curta.erro.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    const longa = (await post('porteiro', '/eventos-acesso/avaliacao', { ...base, autorizadoPorTipo: 'excecao_porteiro', justificativa: 'x'.repeat(MIN_JUSTIFICATIVA) })).body.data;
    expect(longa.erro).toBeNull();
  });

  it('autorizador sem vínculo e meio que não se aplica: o mesmo código que o registro daria', async () => {
    const base = { pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['D-32'] };
    const semVinculo = (await post('porteiro', '/eventos-acesso/avaliacao', { ...base, autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Bruno Teixeira'] })).body.data;
    expect(semVinculo.erro.code).toBe('AUTORIZADOR_SEM_VINCULO');
    const reg = await post('porteiro', '/eventos-acesso', { ...base, autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Bruno Teixeira'] });
    expect(reg.status).toBe(422);
    expect(reg.body.code).toBe('AUTORIZADOR_SEM_VINCULO');
    const escala = (await post('porteiro', '/eventos-acesso/avaliacao', { ...base, autorizadoPorTipo: 'escala' })).body.data;
    expect(escala.erro.code).toBe('MEIO_INVALIDO_PARA_TIPO');
  });

  it('prestador: tipo padrão serviço (8 h); corpo fora do formato é 400', async () => {
    const a = (await post('porteiro', '/eventos-acesso/avaliacao', { pessoaId: ids['Juliana Costa'], unidadeDestinoId: ids['D-32'] })).body.data;
    expect(a).toMatchObject({ categoria: 'prestador', tipoVisitaPadrao: 'servico', prazoAte: api.relogio.agora().getTime() + 8 * HORA });
    expect((await post('porteiro', '/eventos-acesso/avaliacao', { pessoaId: 'x' })).status).toBe(400);
  });
});

describe('dados calculados no instante da resposta', () => {
  it('presentes: proximoPrazo = prazo + 1 h; depois de 4 prorrogações, null', async () => {
    const ent = (await post('porteiro', '/eventos-acesso', {
      pessoaId: ids['Marcos Pereira'], unidadeDestinoId: ids['D-32'], autorizadoPorTipo: 'interfone', autorizadoPorPessoaId: ids['Ana Ribeiro'], tipoVisita: 'entrega',
    })).body.data;
    const presente = async () => (await get('porteiro', '/acessos/presentes')).body.data.find((e: { id: string }) => e.id === ent.id).permanencia;
    expect(await presente()).toMatchObject({ prorrogacoes: 0, proximoPrazo: ent.permanencia.prazoAte + HORA });
    for (let i = 0; i < MAX_PRORROGACOES; i++) expect((await post('porteiro', `/eventos-acesso/${ent.id}/permanencia/prorrogacoes`)).status).toBe(201);
    expect(await presente()).toMatchObject({ prorrogacoes: MAX_PRORROGACOES, proximoPrazo: null });
    expect((await post('porteiro', `/eventos-acesso/${ent.id}/saida`)).status).toBe(201);
  });

  it('encomenda: atrasada só depois de 7 dias inteiros aguardando', async () => {
    const r = await post('porteiro', '/encomendas', { unidadeId: ids['D-32'], destinatario: 'Ana Ribeiro', unidadeConfirmada: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.atrasada).toBe(false);
    const id = r.body.data.id;
    await api.db.update(s.encomenda).set({ recebidaEm: new Date(api.relogio.agora().getTime() - 8 * 24 * HORA) }).where(eq(s.encomenda.id, id));
    expect((await get('porteiro', `/encomendas/${id}`)).body.data.atrasada).toBe(true);
  });

  it('usuários: senhaTemporariaVencida pelo relógio da API', async () => {
    const criado = await post('sindico', '/usuarios', { nome: 'Pessoa Temporária', login: 'pessoa.temp', papel: 'porteiro' });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.data.usuario.senhaTemporariaVencida).toBe(false);
    const id = criado.body.data.usuario.id;
    await api.db.update(s.usuarioSistema).set({ senhaTemporariaExpiraEm: new Date(api.relogio.agora().getTime() - MIN) }).where(eq(s.usuarioSistema.id, id));
    const lista = (await get('sindico', '/usuarios')).body.data as { id: string; senhaTemporariaVencida: boolean }[];
    expect(lista.find((u) => u.id === id)?.senhaTemporariaVencida).toBe(true);
  });
});

describe('plataforma: permissões, parâmetros e análise da lista de unidades', () => {
  const P = `${V1}/plataforma`;
  async function entrarMaster(email: string, papel: 'master' | 'suporte') {
    const c = await criarUsuario(api.plataforma.db, {
      hashSenha: (x) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
    }, { email, nome: `Operador ${papel}`, papel });
    await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
    const r = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', novoIp()).send({ email, senha: SENHA_M });
    expect(r.status).toBe(200);
    const linha = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(nomeCookieMaster(true)))!;
    return { cookie: linha.split(';')[0]!, corpo: r.body.data };
  }

  it('master tem todas as ações; suporte só lista; ambos recebem o mínimo da senha', async () => {
    const m = await entrarMaster('contrato.master@exemplo.test', 'master');
    expect(m.corpo.permissoes).toEqual({
      acoes: ['condominio.listar', 'condominio.criar', 'condominio.modulos', 'condominio.ler', 'condominio.sindicos'], senhaMin: 16,
    });
    const sup = await entrarMaster('contrato.suporte@exemplo.test', 'suporte');
    expect(sup.corpo.permissoes.acoes).toEqual(['condominio.listar']);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', sup.cookie)).body.data.permissoes.acoes).toEqual(['condominio.listar']);

    const par = (await api.http().get(`${P}/parametros`).set('Cookie', sup.cookie)).body.data;
    expect(par).toMatchObject({ agrupamentos: ['Bloco', 'Torre'], limiteUnidades: 5000 });
    expect(par.ufs).toContain('SP');
    expect(new RegExp(par.formatos.codigoCondominio).test('vila-sul')).toBe(true);
    expect(new RegExp(par.formatos.loginSindico).test('1abc')).toBe(false);

    const corpo = { texto: 'A-101\nA 101\nxyz\nTorre 2 - 34', agrupamento: 'Torre' };
    expect((await api.http().post(`${P}/unidades/analise`).set('Cookie', sup.cookie).send(corpo)).status).toBe(403);
    const r = await api.http().post(`${P}/unidades/analise`).set('Cookie', m.cookie).send(corpo);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ invalidas: 1, duplicadas: 1, acimaDoLimite: false, unidades: [{ bloco: '2', numero: '34' }, { bloco: 'A', numero: '101' }] });
    // O cookie do condomínio não vale aqui (e vice-versa): análise sem sessão da plataforma é 401.
    expect((await api.http().post(`${P}/unidades/analise`).set('Cookie', cookies.sindico).send(corpo)).status).toBe(401);
  });
});
