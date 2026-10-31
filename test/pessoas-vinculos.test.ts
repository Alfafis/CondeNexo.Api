// Pessoas (RF-02), funcionários (RF-09), veículos (RF-08) e vínculos (RF-03 a RF-07, RN-02, RN-03, RN-09) pela API real
// (HTTP + PGlite + migrações). Dados: seed de estrutura + usuários + pessoas fictícias do seed de dev.
import { and, eq, sql } from 'drizzle-orm';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as s from '../src/db/schema';
import { cpfComDv, seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { PessoasService } from '../src/pessoas/pessoas.service';
import { traduzirErroVinculo } from '../src/vinculos/vinculos.service';
import { type ApiDeTeste, novaApi, type PapelTeste, trilha } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
const CPF_ANA = cpfComDv('529982247');
let base = 100_000_000;
/** CPF fictício novo, válido (dígitos verificadores), diferente a cada chamada. */
const novoCpf = () => cpfComDv(String(++base));
const usados: string[] = [CPF_ANA];
const cpf = () => { const c = novoCpf(); usados.push(c); return c; };

let api: ApiDeTeste;
const cookies = {} as Record<PapelTeste, string>;
const saida: string[] = [];

beforeAll(async () => {
  // Tudo o que a API escrever no console (log de requisição e de erro) fica aqui, para o teste de "CPF fora do log".
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { saida.push(a.map(String).join(' ')); });
  }
  api = await novaApi();
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
});
afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
const patch = (papel: PapelTeste, url: string, corpo: object) => api.http().patch(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);

async function unidadeId(codigo: string) {
  const m = /^([A-Z0-9]+)-(\d+)$/.exec(codigo)!;
  const [u] = await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, m[1]!), eq(s.unidade.numero, m[2]!)));
  return u!.id;
}
async function pessoaPorNome(nome: string) {
  const [p] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, nome));
  return p!;
}
async function vinculoDe(nome: string, codigo: string) {
  const p = await pessoaPorNome(nome);
  const [v] = await api.db.select().from(s.vinculoUnidade)
    .where(and(eq(s.vinculoUnidade.pessoaId, p.id), eq(s.vinculoUnidade.unidadeId, await unidadeId(codigo))));
  return v!;
}
const novaPessoa = (papel: PapelTeste, corpo: Partial<{ nome: string; documento: string; telefone: string; categoria: string; empresa: string; semCpf: boolean }>) =>
  post(papel, '/pessoas', { nome: 'Fulano de Teste', telefone: '11912345678', categoria: 'visitante', ...corpo });

describe('pessoas: cadastro (RF-02)', () => {
  it('porteiro cadastra visitante e prestador; a resposta não traz telefone completo nem HMAC', async () => {
    const r = await novaPessoa('porteiro', { nome: 'Visitante Um', documento: cpf() });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ nome: 'Visitante Um', categoria: 'visitante', semCpf: false, documentoMascarado: expect.stringMatching(/^\d{3}\.\d{2}\*\.\*\*\*-\*\*$/), telefoneMascarado: '(**) *****-5678' });
    expect(r.body.data).not.toHaveProperty('telefone');
    expect(r.body.data).not.toHaveProperty('documentoBusca');
    const p = await novaPessoa('porteiro', { nome: 'Prestador Um', documento: cpf(), categoria: 'prestador', empresa: 'Enel' });
    expect(p.status).toBe(201);
  });

  it('porteiro não cadastra morador nem funcionário (403, com acesso.negado na trilha)', async () => {
    for (const categoria of ['morador', 'funcionario']) {
      const r = await novaPessoa('porteiro', { documento: novoCpf(), categoria });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('SEM_PERMISSAO');
    }
    const negados = await trilha(api, 'acesso.negado');
    expect(negados.at(-1)!.depois).toMatchObject({ acao: 'pessoa.cadastrar_morador', metodo: 'POST' });
  });

  it('administração cadastra morador e recebe só o telefone mascarado', async () => {
    const r = await novaPessoa('administracao', { nome: 'Morador Novo', documento: cpf(), categoria: 'morador' });
    expect(r.status).toBe(201);
    expect(r.body.data.telefone).toBeUndefined();
    expect(r.body.data.telefoneMascarado).toBe('(**) *****-5678');
  });

  it('regras: nome, telefone, CPF obrigatório e com dígito verificador, empresa do prestador', async () => {
    const casos: [object, string][] = [
      [{ nome: '  ', documento: novoCpf() }, 'NOME_OBRIGATORIO'],
      [{ telefone: '1234', documento: novoCpf() }, 'TELEFONE_INVALIDO'],
      [{ documento: '' }, 'DOCUMENTO_OBRIGATORIO'],
      [{ documento: '529.982.247-24' }, 'CPF_INVALIDO'],
      [{ documento: '111.111.111-11' }, 'CPF_INVALIDO'],
      [{ documento: novoCpf(), categoria: 'prestador' }, 'EMPRESA_OBRIGATORIA'],
    ];
    for (const [corpo, codigo] of casos) {
      const r = await novaPessoa('administracao', corpo);
      expect([r.status, r.body.code]).toEqual([422, codigo]);
    }
  });

  it('CPF já cadastrado: 409 PESSOA_DUPLICADA (pela checagem e pela tradução do 23505)', async () => {
    const r = await novaPessoa('administracao', { documento: '529.982.247-25' });
    expect([r.status, r.body.code]).toEqual([409, 'PESSOA_DUPLICADA']);
    // Corrida: a checagem prévia não vê a outra inserção; o índice único barra e a API traduz o 23505.
    const svc = await api.servico<PessoasService>(PessoasService);
    const original = svc.valoresNovaPessoa.bind(svc);
    // Dentro da transação: usar o executor dela (o PGlite tem uma conexão só; consulta fora dela esperaria para sempre).
    const espiao = vi.spyOn(svc, 'valoresNovaPessoa').mockImplementation(async (exec, i, agora) => {
      const outro = await original(exec, { ...i, documento: novoCpf() }, agora);
      const [ana] = await exec.select({ h: s.pessoa.documentoBusca }).from(s.pessoa).where(eq(s.pessoa.nome, 'Ana Ribeiro'));
      return { ...outro, documentoBusca: ana!.h };
    });
    try {
      const c = await novaPessoa('administracao', { documento: novoCpf() });
      expect([c.status, c.body.code, c.body.message]).toEqual([409, 'PESSOA_DUPLICADA', 'Já existe cadastro com este CPF.']);
    } finally { espiao.mockRestore(); }
  });

  it('sem CPF: nome e telefone; duplicata por nome (sem acento/caixa) + telefone é 409', async () => {
    const r = await novaPessoa('porteiro', { nome: 'José Sem Documento', semCpf: true, telefone: '(11) 98888-0001' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ semCpf: true, documentoMascarado: '(sem CPF)' });
    const d = await novaPessoa('porteiro', { nome: 'jose sem documento', semCpf: true, telefone: '11988880001' });
    expect([d.status, d.body.code]).toEqual([409, 'PESSOA_DUPLICADA']);
  });

  it('o corpo não aceita campo desconhecido (ex.: documentoBusca)', async () => {
    const r = await novaPessoa('administracao', { documento: novoCpf(), documentoBusca: 'x' } as object);
    expect(r.status).toBe(400);
  });
});

describe('pessoas: correção do cadastro (art. 18)', () => {
  it('só SI/AD; antes e depois na trilha, com telefone mascarado e sem HMAC; sem mudança, sem trilha', async () => {
    const p = await pessoaPorNome('Marcos Pereira');
    expect((await patch('porteiro', `/pessoas/${p.id}`, { nome: 'X' })).status).toBe(403);
    expect((await patch('auditor', `/pessoas/${p.id}`, { nome: 'X' })).status).toBe(403);
    const r = await patch('administracao', `/pessoas/${p.id}`, { nome: 'Marcos Pereira Lima', telefone: '(11) 97777-0012' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ nome: 'Marcos Pereira Lima', telefoneMascarado: '(**) *****-0012' });
    expect(r.body.data.telefone).toBeUndefined();
    const t = (await trilha(api, 'pessoa.editar')).at(-1)!;
    expect(t.registroId).toBe(p.id);
    expect(t.antes).toMatchObject({ nome: 'Marcos Pereira', telefone: '(**) *****-0012' });
    expect(t.depois).toMatchObject({ nome: 'Marcos Pereira Lima', telefone: '(**) *****-0012' });
    expect(JSON.stringify([t.antes, t.depois])).not.toContain('documento_busca');
    const n = (await trilha(api, 'pessoa.editar')).length;
    expect((await patch('administracao', `/pessoas/${p.id}`, { nome: 'Marcos Pereira Lima' })).status).toBe(200);
    expect((await trilha(api, 'pessoa.editar')).length).toBe(n);
  });

  it('informar CPF tira a pessoa de "sem CPF"; CPF de outra pessoa é 409; inválido é 422', async () => {
    const p = await pessoaPorNome('Cláudia Rocha');
    expect(p.semCpf).toBe(true);
    expect((await patch('administracao', `/pessoas/${p.id}`, { documento: CPF_ANA })).body.code).toBe('PESSOA_DUPLICADA');
    expect((await patch('administracao', `/pessoas/${p.id}`, { documento: '12345678900' })).body.code).toBe('CPF_INVALIDO');
    const r = await patch('administracao', `/pessoas/${p.id}`, { documento: cpf() });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ semCpf: false, documentoMascarado: expect.stringMatching(/^\d{3}\.\d{2}\*\.\*\*\*-\*\*$/) }); // sem CPF que informa: formato novo
  });

  it('prestador não fica sem empresa; pessoa inexistente é 404', async () => {
    const p = await pessoaPorNome('Juliana Costa');
    expect((await patch('administracao', `/pessoas/${p.id}`, { empresa: '  ' })).body.code).toBe('EMPRESA_OBRIGATORIA');
    expect((await patch('administracao', '/pessoas/00000000-0000-4000-8000-000000000000', { nome: 'X' })).status).toBe(404);
  });
});

describe('pessoas: listagem e ficha (MATRIZ e minimização)', () => {
  it('percorre todas por cursor, em ordem de nome, sem repetir; sem telefone completo nem HMAC', async () => {
    const vistos: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await get('auditor', `/pessoas?limite=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      for (const p of r.body.data) {
        expect(p).not.toHaveProperty('telefone');
        expect(p).not.toHaveProperty('documentoBusca');
        vistos.push(p.nome);
      }
      cursor = r.body.pagination.cursor;
    } while (cursor);
    const [{ n }] = (await api.db.execute(sql`SELECT count(*)::int AS n FROM pessoa`)).rows as { n: number }[];
    expect(vistos).toHaveLength(n);
    expect(new Set(vistos).size).toBe(n);
    expect([...vistos]).toEqual([...vistos].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('vínculo principal e unidades válidas na lista; filtro por categoria; texto na URL é recusado (pode ser CPF)', async () => {
    const r = await get('administracao', '/pessoas?limite=100&categoria=morador');
    const ana = r.body.data.find((p: { nome: string }) => p.nome === 'Ana Ribeiro');
    expect(ana).toMatchObject({ vinculoPrincipal: { unidadeCodigo: 'D-32', status: 'aprovado', tipo: 'proprietario' }, unidadesVinculadasCodigos: ['D-32'] });
    expect(r.body.data.every((p: { categoria: string }) => p.categoria === 'morador')).toBe(true);
    expect((await get('administracao', `/pessoas?q=${CPF_ANA}`)).status).toBe(400);
  });

  it('ficha: telefone só mascarado para todos; vínculos com nomes; eventos ainda null', async () => {
    const ana = await pessoaPorNome('Ana Ribeiro');
    const adm = await get('administracao', `/pessoas/${ana.id}`);
    expect(adm.status).toBe(200);
    expect(adm.body.data.pessoa.telefone).toBeUndefined();
    expect(adm.body.data.pessoa.telefoneMascarado).toBe('(**) *****-0001');
    expect(adm.body.data.eventos).toBeNull();
    expect(adm.body.data.vinculos[0]).toMatchObject({ unidadeCodigo: 'D-32', status: 'aprovado', conferencia: { tipoDocumento: 'escritura' }, conferidoPorNome: 'Paula Nogueira' });
    for (const papel of ['porteiro', 'auditor'] as const) {
      const r = await get(papel, `/pessoas/${ana.id}`);
      expect(r.status).toBe(200);
      expect(r.body.data.pessoa).not.toHaveProperty('telefone');
      expect(r.body.data.pessoa.telefoneMascarado).toBe('(**) *****-0001');
    }
  });
});

describe('funcionários (RF-09)', () => {
  const escalaNoite = { diasSemana: [5], horaInicio: '22:00', horaFim: '06:00' };

  it('cria com escala que atravessa a meia-noite; a madrugada de sábado é do turno de sexta', async () => {
    expect((await post('porteiro', '/funcionarios', { nome: 'Vigia', documento: novoCpf(), telefone: '11955550000', funcao: 'Vigia', escala: escalaNoite })).status).toBe(403);
    const r = await post('administracao', '/funcionarios', { nome: 'Vigia Noturno', documento: cpf(), telefone: '11955550001', funcao: 'Vigia', escala: escalaNoite });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ funcao: 'Vigia', escala: escalaNoite, ativo: true, pessoa: { nome: 'Vigia Noturno', categoria: 'funcionario' } });
    const id = r.body.data.pessoaId;
    // Relógio: sábado 17/10/2026 09:00 BRT -> fora; sábado 02:00 BRT -> dentro (turno de sexta).
    // O porteiro lê só a escala da pessoa (tela de entrada), nunca a ficha nem a lista (spec §14, decisão nº 29).
    const esc = await get('porteiro', `/funcionarios/${id}/escala`);
    expect(esc.body.data).toEqual({ pessoaId: id, funcao: 'Vigia', escala: escalaNoite, ativo: true, emEscalaAgora: false });
    const antes = api.relogio.atual;
    api.relogio.atual = new Date('2026-10-17T05:00:00.000Z');
    try { expect((await get('porteiro', `/funcionarios/${id}/escala`)).body.data.emEscalaAgora).toBe(true); }
    finally { api.relogio.atual = antes; }
    expect((await get('porteiro', `/funcionarios/${id}`)).status).toBe(403);
    const trilhaF = (await trilha(api, 'funcionario.criar')).at(-1)!;
    expect(trilhaF.registroId).toBe(id);
  });

  it('regras: função e escala; edição com trilha; lista paginada; 404 para quem não é funcionário', async () => {
    const base = { nome: 'Zelador', documento: novoCpf(), telefone: '11955550002', escala: { diasSemana: [1, 2], horaInicio: '07:00', horaFim: '16:00' } };
    expect((await post('administracao', '/funcionarios', { ...base, funcao: ' ' })).body.code).toBe('FUNCAO_OBRIGATORIA');
    expect((await post('administracao', '/funcionarios', { ...base, funcao: 'Zelador', escala: { diasSemana: [], horaInicio: '07:00', horaFim: '16:00' } })).body.code).toBe('ESCALA_INVALIDA');
    expect((await post('administracao', '/funcionarios', { ...base, funcao: 'Zelador', escala: { diasSemana: [1], horaInicio: '07:00', horaFim: '07:00' } })).body.code).toBe('ESCALA_INVALIDA');
    const c = await post('administracao', '/funcionarios', { ...base, documento: cpf(), funcao: 'Zelador', escala: { diasSemana: [3, 1], horaInicio: '07:00', horaFim: '16:00' } });
    expect(c.body.data.escala.diasSemana).toEqual([1, 3]);
    const e = await patch('administracao', `/funcionarios/${c.body.data.pessoaId}`, { ativo: false, funcao: 'Zelador-chefe' });
    expect(e.body.data).toMatchObject({ ativo: false, funcao: 'Zelador-chefe', emEscalaAgora: false });
    expect((await trilha(api, 'funcionario.editar')).at(-1)!.antes).toMatchObject({ ativo: true, funcao: 'Zelador' });
    // Lista: síndico, administração e auditor; o porteiro não (403, com acesso.negado na trilha)
    const l = await get('auditor', '/funcionarios?limite=1');
    expect(l.body.data).toHaveLength(1);
    expect(l.body.pagination.hasNextPage).toBe(true);
    for (const papel of ['sindico', 'administracao'] as const) expect((await get(papel, '/funcionarios?limite=1')).status).toBe(200);
    const negado = await get('porteiro', '/funcionarios?limite=1');
    expect(negado.status).toBe(403);
    expect((await trilha(api, 'acesso.negado')).at(-1)!.depois).toMatchObject({ acao: 'funcionario.ver' });
    const ana = await pessoaPorNome('Ana Ribeiro');
    expect((await get('auditor', `/funcionarios/${ana.id}`)).body.code).toBe('FUNCIONARIO_NAO_ENCONTRADO');
    expect((await get('porteiro', `/funcionarios/${ana.id}/escala`)).body.code).toBe('FUNCIONARIO_NAO_ENCONTRADO');
    expect((await get('auditor', `/funcionarios/${ana.id}/escala`)).status).toBe(403);
  });
});

describe('veículos (RF-08)', () => {
  it('placa antiga ou Mercosul, normalizada; inválida 422; ativa repetida 409; porteiro 403', async () => {
    const a11 = await unidadeId('A-11');
    const r = await post('administracao', '/veiculos', { unidadeId: a11, placa: 'abc-1d23', modelo: 'Gol', cor: 'azul' });
    expect([r.status, r.body.data.placa]).toEqual([201, 'ABC1D23']);
    expect((await post('administracao', '/veiculos', { unidadeId: a11, placa: 'XYZ1234', modelo: 'Uno', cor: 'branco' })).status).toBe(201);
    expect((await post('administracao', '/veiculos', { unidadeId: a11, placa: 'AB12345', modelo: 'Uno', cor: 'branco' })).body.code).toBe('PLACA_INVALIDA');
    expect((await post('administracao', '/veiculos', { unidadeId: a11, placa: 'FKR-2C41', modelo: 'Fit', cor: 'prata' })).body.code).toBe('PLACA_DUPLICADA');
    expect((await post('administracao', '/veiculos', { unidadeId: a11, placa: 'QWE1R23', modelo: ' ', cor: 'prata' })).body.code).toBe('MODELO_OBRIGATORIO');
    expect((await post('porteiro', '/veiculos', { unidadeId: a11, placa: 'QWE1R23', modelo: 'Ka', cor: 'prata' })).status).toBe(403);
    const det = await get('porteiro', '/unidades/A-11');
    expect(det.body.data.veiculos.map((v: { placa: string }) => v.placa)).toEqual(['ABC1D23', 'XYZ1234']);
  });

  it('unidade desativada não recebe veículo; desativar libera a placa; reativar com a placa em uso é 409', async () => {
    const u = await post('administracao', '/unidades', { bloco: 'Y', numero: '01' });
    await post('administracao', `/unidades/${u.body.data.id}/desativar`);
    expect((await post('administracao', '/veiculos', { unidadeId: u.body.data.id, placa: 'JJJ1A11', modelo: 'Ka', cor: 'preto' })).body.code).toBe('UNIDADE_INATIVA');
    const a12 = await unidadeId('A-12');
    const a = await post('administracao', '/veiculos', { unidadeId: a12, placa: 'JJJ1A11', modelo: 'Ka', cor: 'preto' });
    expect((await patch('administracao', `/veiculos/${a.body.data.id}`, { ativo: false })).body.data.ativo).toBe(false);
    expect((await get('administracao', '/unidades/A-12')).body.data.veiculos).toEqual([]);
    expect((await post('administracao', '/veiculos', { unidadeId: a12, placa: 'JJJ-1A11', modelo: 'Onix', cor: 'cinza' })).status).toBe(201);
    expect((await patch('administracao', `/veiculos/${a.body.data.id}`, { ativo: true })).body.code).toBe('PLACA_DUPLICADA');
    const ed = await patch('administracao', `/veiculos/${a.body.data.id}`, { cor: 'vermelho' });
    expect(ed.body.data.cor).toBe('vermelho');
    expect((await trilha(api, 'veiculo.editar')).at(-1)!.antes).toMatchObject({ cor: 'preto' });
  });
});

describe('vínculos: fluxo completo (RF-03 a RF-06, RN-02, RN-03)', () => {
  let pessoaId: string;
  let vinculoId: string;
  let a11: string;

  beforeAll(async () => {
    a11 = await unidadeId('A-11');
    const p = await novaPessoa('administracao', { nome: 'Renata Vínculo', documento: cpf(), categoria: 'visitante' });
    pessoaId = p.body.data.id;
  });

  it('só SI/AD criam; porteiro não vê a lista; nasce pendente e não muda a categoria', async () => {
    const corpo = () => ({ pessoaId, unidadeId: a11, tipo: 'proprietario', vigenciaInicio: '2026-10-01', vigenciaFim: null });
    expect((await post('porteiro', '/vinculos', corpo())).status).toBe(403);
    expect((await post('auditor', '/vinculos', corpo())).status).toBe(403);
    expect((await get('porteiro', '/vinculos')).status).toBe(403);
    const pend = (await get('auditor', '/vinculos/contagem?status=pendente')).body.data.total;
    const r = await post('administracao', '/vinculos', corpo());
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'pendente', unidadeCodigo: 'A-11', pessoaNome: 'Renata Vínculo', conferencia: null, registradoPorNome: 'Paula Nogueira', solicitadoPor: 'Paula Nogueira', vigenciaInicio: '2026-10-01' });
    vinculoId = r.body.data.id;
    expect((await get('auditor', '/vinculos/contagem?status=pendente')).body.data.total).toBe(pend + 1);
    expect((await pessoaPorNome('Renata Vínculo')).categoria).toBe('visitante');
    expect((await post('administracao', '/vinculos', corpo())).body.code).toBe('VINCULO_DUPLICADO');
  });

  it('regras de vigência e de unidade', async () => {
    const p = { pessoaId, unidadeId: await unidadeId('A-12') };
    expect((await post('administracao', '/vinculos', { ...p, tipo: 'inquilino', vigenciaInicio: '2026-10-01' })).body.code).toBe('VIGENCIA_OBRIGATORIA');
    expect((await post('administracao', '/vinculos', { ...p, tipo: 'proprietario', vigenciaInicio: '2026-10-01', vigenciaFim: '2026-09-01' })).body.code).toBe('VIGENCIA_INVALIDA');
    expect((await post('administracao', '/vinculos', { ...p, tipo: 'proprietario', vigenciaInicio: '2026-02-30' })).status).toBe(400);
    expect((await post('administracao', '/vinculos', { ...p, pessoaId: '00000000-0000-4000-8000-000000000000', tipo: 'proprietario' })).body.code).toBe('PESSOA_NAO_ENCONTRADA');
  });

  it('aprovar sem conferência: 422; a conferência valida tipo, descrição, data e dado pessoal', async () => {
    expect((await post('administracao', `/vinculos/${vinculoId}/aprovar`)).body.code).toBe('CONFERENCIA_OBRIGATORIA');
    const conf = (c: object) => post('administracao', `/vinculos/${vinculoId}/conferencias`, c);
    expect((await conf({ tipo: 'outro' })).body.code).toBe('DESCRICAO_OBRIGATORIA');
    expect((await conf({ tipo: 'escritura', data: '2026-10-18' })).body.code).toBe('DATA_FUTURA');
    expect((await conf({ tipo: 'escritura', observacao: `CPF ${CPF_ANA}` })).body.code).toBe('DADO_PESSOAL_NA_CONFERENCIA');
    expect((await post('porteiro', `/vinculos/${vinculoId}/conferencias`, { tipo: 'escritura' })).status).toBe(403);
    const r = await conf({ tipo: 'escritura', observacao: 'recebido por e-mail' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ conferencia: { tipoDocumento: 'escritura', data: '2026-10-17', observacao: 'recebido por e-mail' }, conferidoPorNome: 'Paula Nogueira' });
    expect((await trilha(api, 'vinculo.conferir')).at(-1)!.registroId).toBe(vinculoId);
  });

  it('aprovar: auditor 403; aprovado vira morador, sai dos pendentes, aparece na unidade e na busca', async () => {
    expect((await post('auditor', `/vinculos/${vinculoId}/aprovar`)).status).toBe(403);
    const pend = (await get('auditor', '/vinculos/contagem?status=pendente')).body.data.total;
    const r = await post('administracao', `/vinculos/${vinculoId}/aprovar`, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'aprovado', decididoPorNome: 'Paula Nogueira', pessoaCadastroCompleto: true });
    expect((await pessoaPorNome('Renata Vínculo')).categoria).toBe('morador');
    expect((await get('auditor', '/vinculos/contagem?status=pendente')).body.data.total).toBe(pend - 1);
    const det = await get('porteiro', '/unidades/A-11');
    expect(det.body.data.vinculos.map((v: { pessoaNome: string; status: string }) => [v.pessoaNome, v.status])).toContainEqual(['Renata Vínculo', 'aprovado']);
    const b = await post('porteiro', '/busca', { q: 'Renata' });
    expect(b.body.data.pessoas[0]).toMatchObject({ nome: 'Renata Vínculo', unidadesVinculadasCodigos: ['A-11'] });
    const aut = await get('porteiro', `/unidades/${a11}/autorizadores`);
    expect(aut.body.data.map((a: { pessoa: { nome: string } }) => a.pessoa.nome)).toContain('Renata Vínculo');
    expect(aut.body.data[0].pessoa).not.toHaveProperty('telefone');
  });

  it('tentativas inválidas depois da aprovação: decidir de novo e refazer a conferência são 409', async () => {
    expect((await post('administracao', `/vinculos/${vinculoId}/aprovar`)).body.code).toBe('VINCULO_JA_DECIDIDO');
    expect((await post('administracao', `/vinculos/${vinculoId}/rejeitar`, { justificativa: 'qualquer coisa' })).body.code).toBe('VINCULO_JA_DECIDIDO');
    expect((await post('administracao', `/vinculos/${vinculoId}/conferencias`, { tipo: 'contrato_locacao' })).body.code).toBe('CONFERENCIA_IMUTAVEL');
    expect((await post('administracao', `/vinculos/${vinculoId}/regularizar`, {})).body.code).toBe('VINCULO_NAO_LEGADO');
  });

  it('encerrar (RF-07): motivo e data; encerrado é final', async () => {
    expect((await post('administracao', `/vinculos/${vinculoId}/encerrar`, { motivo: 'curto' })).body.code).toBe('MOTIVO_OBRIGATORIO');
    expect((await post('administracao', `/vinculos/${vinculoId}/encerrar`, { motivo: 'Mudou-se do condomínio', data: '2026-10-20' })).body.code).toBe('DATA_FUTURA');
    expect((await post('administracao', `/vinculos/${vinculoId}/encerrar`, { motivo: 'Mudou-se do condomínio', data: '2026-09-01' })).body.code).toBe('DATA_ANTES_DO_INICIO');
    const r = await post('administracao', `/vinculos/${vinculoId}/encerrar`, { motivo: 'Mudou-se do condomínio', data: '2026-10-10' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'encerrado', justificativa: 'Mudou-se do condomínio', encerradoEm: new Date('2026-10-10T03:00:00.000Z').getTime() });
    expect((await post('administracao', `/vinculos/${vinculoId}/encerrar`, { motivo: 'Mudou-se do condomínio' })).body.code).toBe('VINCULO_NAO_ENCERRAVEL');
    const aut = await get('porteiro', `/unidades/${a11}/autorizadores`);
    expect(aut.body.data.map((a: { pessoa: { nome: string } }) => a.pessoa.nome)).not.toContain('Renata Vínculo');
  });

  it('cadastro incompleto (sem CPF) não é aprovado; rejeitar exige justificativa', async () => {
    const semCpf = await pessoaPorNome('José Sem Documento');
    const v = await post('administracao', '/vinculos', { pessoaId: semCpf.id, unidadeId: a11, tipo: 'dependente' });
    await post('administracao', `/vinculos/${v.body.data.id}/conferencias`, { tipo: 'outro', descricao: 'Certidão de nascimento' });
    const a = await post('administracao', `/vinculos/${v.body.data.id}/aprovar`);
    expect([a.status, a.body.code]).toEqual([422, 'CADASTRO_INCOMPLETO']);
    expect((await post('administracao', `/vinculos/${v.body.data.id}/rejeitar`, { justificativa: '  ' })).body.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    expect((await post('administracao', `/vinculos/${v.body.data.id}/rejeitar`)).body.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    const r = await post('sindico', `/vinculos/${v.body.data.id}/rejeitar`, { justificativa: 'Sem CPF: cadastro incompleto' });
    expect(r.body.data).toMatchObject({ status: 'rejeitado', justificativa: 'Sem CPF: cadastro incompleto', decididoPorNome: 'Carlos Andrade' });
    expect((await post('administracao', `/vinculos/${v.body.data.id}/encerrar`, { motivo: 'Tentativa de encerrar rejeitado' })).body.code).toBe('VINCULO_NAO_ENCERRAVEL');
  });
});

describe('vínculos: legado (RN-09)', () => {
  it('regularizar exige conferência e cadastro completo; vira aprovado', async () => {
    const v = await vinculoDe('Lúcia Ribeiro', 'D-32');
    expect(v.status).toBe('legado');
    expect((await post('administracao', `/vinculos/${v.id}/regularizar`, {})).body.code).toBe('CONFERENCIA_OBRIGATORIA');
    await post('administracao', `/vinculos/${v.id}/conferencias`, { tipo: 'outro', descricao: 'Certidão de casamento' });
    const r = await post('administracao', `/vinculos/${v.id}/regularizar`, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'aprovado', decididoPorNome: 'Paula Nogueira' });
    expect((await trilha(api, 'vinculo.regularizar')).at(-1)!.registroId).toBe(v.id);
  });

  it('legado de pessoa importada sem telefone: CADASTRO_INCOMPLETO até completar o cadastro', async () => {
    const [imp] = await api.db.insert(s.importacao).values({
      arquivoNome: 'teste.csv', arquivoSha256: 'a'.repeat(64), lidas: 1, importaveis: 1, rejeitadas: 0, avisos: 0,
      prazoRegularizacao: '2026-10-01', executadaPorId: api.usuarios['paula.nogueira']!.id,
    }).returning();
    const [p] = await api.db.insert(s.pessoa).values({ nome: 'Legado Sem Telefone', categoria: 'morador', semCpf: true, importacaoId: imp!.id }).returning();
    const [v] = await api.db.insert(s.vinculoUnidade).values({
      pessoaId: p!.id, unidadeId: await unidadeId('B-21'), tipo: 'proprietario', status: 'legado', prazoRegularizacao: '2026-10-01',
      registradoPorId: api.usuarios['paula.nogueira']!.id, importacaoId: imp!.id,
    }).returning();
    await post('administracao', `/vinculos/${v!.id}/conferencias`, { tipo: 'escritura' });
    expect((await post('administracao', `/vinculos/${v!.id}/regularizar`)).body.code).toBe('CADASTRO_INCOMPLETO');
    // Lista "Legados" pela ordem de prazo: o vencido (01/10) vem primeiro, em destaque.
    const l = await get('administracao', '/vinculos?status=legado&ordem=prazo&limite=1');
    expect(l.body.data[0]).toMatchObject({ id: v!.id, legadoVencido: true, solicitadoPor: 'Importação da planilha teste.csv' });
    await patch('administracao', `/pessoas/${p!.id}`, { documento: cpf(), telefone: '11944440000' });
    expect((await post('administracao', `/vinculos/${v!.id}/regularizar`)).body.data.status).toBe('aprovado');
  });
});

describe('vínculos: unidade desativada barra a aprovação (UNIDADE_INATIVA)', () => {
  it('aprovar e regularizar em unidade desativada: 422; rejeitar continua possível; reativada, aprova', async () => {
    const u = await post('administracao', '/unidades', { bloco: 'X', numero: '01' });
    expect(u.status).toBe(201);
    const uid = u.body.data.id as string;
    const p1 = (await novaPessoa('administracao', { nome: 'Inativa Um', documento: cpf() })).body.data.id as string;
    const p2 = (await novaPessoa('administracao', { nome: 'Inativa Dois', documento: cpf() })).body.data.id as string;
    const v1 = (await post('administracao', '/vinculos', { pessoaId: p1, unidadeId: uid, tipo: 'proprietario' })).body.data.id as string;
    const v2 = (await post('administracao', '/vinculos', { pessoaId: p2, unidadeId: uid, tipo: 'dependente' })).body.data.id as string;
    for (const v of [v1, v2]) expect((await post('administracao', `/vinculos/${v}/conferencias`, { tipo: 'escritura' })).status).toBe(201);
    expect((await post('administracao', `/unidades/${uid}/desativar`)).status).toBe(200);
    const r = await post('administracao', `/vinculos/${v1}/aprovar`, {});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('UNIDADE_INATIVA');
    expect((await api.db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.id, v1)))[0]!.status).toBe('pendente');
    expect((await post('administracao', `/vinculos/${v2}/rejeitar`, { justificativa: 'Unidade desativada pela administração' })).status).toBe(200);
    // Legado na unidade desativada: regularizar também é aprovar
    const [leg] = await api.db.insert(s.vinculoUnidade).values({
      pessoaId: p2, unidadeId: uid, tipo: 'dependente', status: 'legado', prazoRegularizacao: '2027-12-31',
      registradoPorId: api.usuarios['paula.nogueira']!.id, conferenciaTipoDocumento: 'escritura', conferenciaData: '2026-10-01',
      conferidoPorId: api.usuarios['paula.nogueira']!.id,
    }).returning();
    expect((await post('administracao', `/vinculos/${leg!.id}/regularizar`, {})).body.code).toBe('UNIDADE_INATIVA');
    expect((await post('administracao', `/unidades/${uid}/reativar`)).status).toBe(200);
    expect((await post('administracao', `/vinculos/${v1}/aprovar`, {})).body.data.status).toBe('aprovado');
    expect((await post('administracao', `/vinculos/${leg!.id}/regularizar`, {})).body.data.status).toBe('aprovado');
  });
});

describe('vínculos: paginação e filtros', () => {
  it('percorre por cursor nas três ordens, sem repetir; cursor de outra ordem é 400', async () => {
    const total = Number(((await api.db.execute(sql`SELECT count(*)::int AS n FROM vinculo_unidade`)).rows[0] as { n: number }).n);
    for (const ordem of ['recentes', 'decisao', 'prazo']) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const r = await get('auditor', `/vinculos?ordem=${ordem}&limite=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(r.status).toBe(200);
        ids.push(...r.body.data.map((x: { id: string }) => x.id));
        cursor = r.body.pagination.cursor;
      } while (cursor);
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
    }
    const r = await get('auditor', '/vinculos?ordem=recentes&limite=1');
    expect((await get('auditor', `/vinculos?ordem=prazo&cursor=${encodeURIComponent(r.body.pagination.cursor)}`)).body.code).toBe('CURSOR_INVALIDO');
  });

  it('filtro por vários status, por unidade e por pessoa', async () => {
    const r = await get('administracao', '/vinculos?status=aprovado,rejeitado&ordem=decisao&limite=100');
    expect(r.body.data.every((v: { status: string }) => ['aprovado', 'rejeitado'].includes(v.status))).toBe(true);
    const d32 = await unidadeId('D-32');
    const u = await get('administracao', `/vinculos?unidadeId=${d32}&limite=100`);
    expect(u.body.data.map((v: { pessoaNome: string }) => v.pessoaNome).sort()).toEqual(['Ana Ribeiro', 'Lúcia Ribeiro', 'Paulo Ribeiro']);
    expect((await get('administracao', '/vinculos?status=xpto')).status).toBe(400);
  });
});

describe('vínculos: erros do banco viram 409/422 legíveis', () => {
  it('trigger de transição (rejeitado -> aprovado) e CHECK de conferência, sem a mensagem do driver', async () => {
    const [rej] = await api.db.select().from(s.vinculoUnidade).where(eq(s.vinculoUnidade.status, 'rejeitado')).limit(1);
    let erro: unknown;
    try { await api.db.update(s.vinculoUnidade).set({ status: 'aprovado' }).where(eq(s.vinculoUnidade.id, rej!.id)); } catch (e) { erro = e; }
    const t = traduzirErroVinculo(erro) as HttpException;
    expect(t).toBeInstanceOf(HttpException);
    expect([t.getStatus(), (t.getResponse() as { codigo: string }).codigo]).toEqual([409, 'TRANSICAO_INVALIDA']);
    expect(JSON.stringify(t.getResponse())).not.toMatch(/vínculo .* está|transição de vínculo|[0-9a-f]{8}-/);

    const pend = await vinculoDe('Rafael Mendes', 'G-11');
    erro = undefined;
    try {
      await api.db.update(s.vinculoUnidade).set({ status: 'aprovado', decididoPorId: api.usuarios['paula.nogueira']!.id, decididoEm: new Date() })
        .where(eq(s.vinculoUnidade.id, pend.id));
    } catch (e) { erro = e; }
    const c = traduzirErroVinculo(erro) as HttpException;
    expect([c.getStatus(), (c.getResponse() as { codigo: string }).codigo]).toEqual([422, 'CONFERENCIA_OBRIGATORIA']);
  });
});

describe('LGPD: o CPF não aparece no log, na trilha nem nas respostas', () => {
  it('nenhum CPF usado no teste (nem o HMAC) está no console ou no audit_log', async () => {
    const hmacs = (await api.db.select({ h: s.pessoa.documentoBusca }).from(s.pessoa)).flatMap((x) => (x.h ? [x.h] : []));
    const log = saida.join('\n');
    expect(log.length).toBeGreaterThan(0);
    const linhas = await trilha(api);
    const trilhaJson = JSON.stringify(linhas.map((l) => ({ ...l, em: null })))
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'); // uuid pode ter 11 dígitos seguidos
    for (const c of usados) {
      expect(log).not.toContain(c);
      expect(trilhaJson).not.toContain(c);
    }
    for (const h of hmacs) {
      expect(log).not.toContain(h);
      expect(trilhaJson).not.toContain(h);
    }
    expect(trilhaJson).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
  });
});
