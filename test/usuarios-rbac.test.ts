// Autorização (spec §5.2) e gestão de usuários pela API real: matriz por papel, acesso.negado em todo 403,
// administração sem poder sobre síndico, troca de senha obrigatória e revogação de sessões.
import { MATRIZ, pode } from '../src/dominio/rbac';
import type { Papel } from '../src/dominio/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PADROES_LOGIN } from '../src/config/config';
import * as s from '../src/db/schema';
import { type ApiDeTeste, LOGINS, novaApi, type PapelTeste, SENHA, trilha } from './helpers/app';

const PAPEIS: PapelTeste[] = ['sindico', 'administracao', 'porteiro', 'auditor'];
const ID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

describe('RBAC: matriz do domain aplicada nas rotas de usuários', () => {
  let api: ApiDeTeste;
  const cookies = {} as Record<PapelTeste, string>;
  beforeAll(async () => {
    api = await novaApi();
    for (const p of PAPEIS) cookies[p] = (await api.como(p)).cookie;
  });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  // Rota, método, corpo. O guard roda antes do pipe: quem pode recebe 400/404, quem não pode recebe 403.
  const rotas: [string, 'get' | 'post' | 'patch', string, object?][] = [
    ['listar', 'get', '/api/v1/usuarios'],
    ['criar', 'post', '/api/v1/usuarios', { nome: 'x' }],
    ['alterar papel', 'patch', `/api/v1/usuarios/${ID_INEXISTENTE}`, { papel: 'porteiro' }],
    ['desativar', 'post', `/api/v1/usuarios/${ID_INEXISTENTE}/desativar`],
    ['reativar', 'post', `/api/v1/usuarios/${ID_INEXISTENTE}/reativar`],
    ['redefinir senha', 'post', `/api/v1/usuarios/${ID_INEXISTENTE}/redefinir-senha`],
  ];

  for (const papel of PAPEIS) {
    for (const [nome, metodo, rota, corpo] of rotas) {
      const permitido = pode(papel as Papel, 'usuario.gerenciar');
      it(`${papel} ${permitido ? 'pode' : 'NÃO pode'} ${nome}`, async () => {
        const req = api.http()[metodo](rota).set('Cookie', cookies[papel]);
        const r = corpo ? await req.send(corpo) : await req;
        if (permitido) expect(r.status, JSON.stringify(r.body)).not.toBe(403);
        else expect(r.status).toBe(403);
      });
    }
  }

  it('a matriz do teste é a do domain (fonte única): usuario.gerenciar = SI e AD', () => {
    expect(MATRIZ['usuario.gerenciar']).toEqual(['sindico', 'administracao']);
    expect(MATRIZ['usuario.gerenciar_sindico']).toEqual(['sindico']);
  });

  it('todo 403 grava acesso.negado com a ação tentada, o usuário e a rota', async () => {
    const r = await api.http().get('/api/v1/usuarios').set('Cookie', cookies.porteiro);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SEM_PERMISSAO');
    const negado = (await trilha(api, 'acesso.negado')).at(-1)!;
    expect(negado).toMatchObject({ usuarioId: api.usuarios[LOGINS.porteiro]!.id, usuarioPapel: 'porteiro', entidade: 'acao' });
    expect(negado.depois).toMatchObject({ acao: 'usuario.gerenciar', metodo: 'GET', rota: '/api/v1/usuarios' });
  });
});

describe('usuários: gestão, síndico protegido, sessões revogadas', () => {
  let api: ApiDeTeste;
  beforeAll(async () => { api = await novaApi(); });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('administração não cria, não desativa, não promove nem redefine síndico (403 + acesso.negado)', async () => {
    const { cookie } = await api.como('administracao');
    const sindico = api.usuarios[LOGINS.sindico]!;
    const porteiro = api.usuarios[LOGINS.porteiro]!;
    const tentativas = [
      api.http().post('/api/v1/usuarios').set('Cookie', cookie).send({ nome: 'Outro Síndico', login: 'outro.sindico', papel: 'sindico' }),
      api.http().post(`/api/v1/usuarios/${sindico.id}/desativar`).set('Cookie', cookie),
      api.http().post(`/api/v1/usuarios/${sindico.id}/redefinir-senha`).set('Cookie', cookie),
      api.http().patch(`/api/v1/usuarios/${sindico.id}`).set('Cookie', cookie).send({ papel: 'porteiro' }),
      api.http().patch(`/api/v1/usuarios/${porteiro.id}`).set('Cookie', cookie).send({ papel: 'sindico' }),
    ];
    const antes = (await trilha(api, 'acesso.negado')).length;
    for (const t of tentativas) {
      const r = await t;
      expect(r.status, JSON.stringify(r.body)).toBe(403);
    }
    const negados = (await trilha(api, 'acesso.negado')).slice(antes);
    expect(negados.length).toBe(5);
    for (const n of negados) expect((n.depois as { acao: string }).acao).toBe('usuario.gerenciar_sindico');
    // Nada mudou no síndico, e a negação dentro da transação não deixou meia escrita
    const [depois] = await api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.id, sindico.id));
    expect(depois).toMatchObject({ ativo: true, papel: 'sindico', senhaHash: sindico.senhaHash });
    expect((await trilha(api, 'usuario.desativar')).length).toBe(0);
  });

  it('síndico desativa a administração: sessões dela caem na hora; reativar não ressuscita sessão', async () => {
    const adm = await api.como('administracao');
    const { cookie } = await api.como('sindico');
    const id = api.usuarios[LOGINS.administracao]!.id;
    const r = await api.http().post(`/api/v1/usuarios/${id}/desativar`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ativo: false });
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', adm.cookie)).status).toBe(401);
    const abertas = (await api.db.select().from(s.sessao).where(eq(s.sessao.usuarioId, id))).filter((x) => !x.revogadaEm);
    expect(abertas.length).toBe(0);
    const reativa = await api.http().post(`/api/v1/usuarios/${id}/reativar`).set('Cookie', cookie);
    expect(reativa.body.data).toMatchObject({ ativo: true });
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', adm.cookie)).status).toBe(401);
    const [aud] = await trilha(api, 'usuario.desativar');
    expect(aud).toMatchObject({ entidade: 'usuario_sistema', registroId: id });
    expect(aud!.antes).toMatchObject({ ativo: true });
    expect(aud!.depois).toMatchObject({ ativo: false });
  });

  it('ninguém desativa nem rebaixa a si mesmo (422)', async () => {
    const { cookie } = await api.como('sindico');
    const eu = api.usuarios[LOGINS.sindico]!.id;
    expect((await api.http().post(`/api/v1/usuarios/${eu}/desativar`).set('Cookie', cookie)).status).toBe(422);
    expect((await api.http().patch(`/api/v1/usuarios/${eu}`).set('Cookie', cookie).send({ papel: 'porteiro' })).status).toBe(422);
  });

  it('criar: senha temporária mostrada uma vez, troca obrigatória; login duplicado é 409 sem erro do driver', async () => {
    const { cookie } = await api.como('administracao');
    const r = await api.http().post('/api/v1/usuarios').set('Cookie', cookie).send({ nome: 'Marina Couto', login: 'Marina.Couto', papel: 'porteiro' });
    expect(r.status).toBe(201);
    expect(r.body.data.usuario).toMatchObject({ login: 'marina.couto', deveTrocarSenha: true, ativo: true });
    expect(r.body.data.senhaTemporaria).toMatch(/^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){3}$/);
    const dup = await api.http().post('/api/v1/usuarios').set('Cookie', cookie).send({ nome: 'Marina 2', login: 'marina.couto', papel: 'porteiro' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ statusCode: 409, code: 'LOGIN_EXISTENTE', message: 'Já existe um usuário com este login.' });
    const [aud] = await trilha(api, 'usuario.criar').then((l) => l.filter((x) => x.usuarioId));
    expect(JSON.stringify(aud)).not.toContain(r.body.data.senhaTemporaria);
    expect(JSON.stringify(aud)).not.toMatch(/argon2/);
  });

  it('troca de senha: obrigatória antes de usar o sistema; política; revoga as OUTRAS sessões', async () => {
    const { cookie: adm } = await api.como('sindico');
    const criado = await api.http().post('/api/v1/usuarios').set('Cookie', adm).send({ nome: 'Nova Administração', login: 'nova.adm', papel: 'administracao' });
    const temp = criado.body.data.senhaTemporaria as string;
    const s1 = await api.entrar('nova.adm', temp);
    const s2 = await api.entrar('nova.adm', temp);
    expect(s1.corpo.usuario.deveTrocarSenha).toBe(true);

    // Com troca pendente: me funciona, o resto não
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', s1.cookie)).status).toBe(200);
    const bloqueada = await api.http().get('/api/v1/usuarios').set('Cookie', s1.cookie);
    expect(bloqueada.status).toBe(403);
    expect(bloqueada.body.code).toBe('TROCA_DE_SENHA_OBRIGATORIA');

    const trocar = (senhaAtual: string, novaSenha: string) =>
      api.http().post('/api/v1/auth/trocar-senha').set('Cookie', s1.cookie).send({ senhaAtual, novaSenha });
    expect((await trocar(temp, 'curta')).body.code).toBe('SENHA_FRACA');
    expect((await trocar(temp, 'password1234')).body.code).toBe('SENHA_FRACA');
    expect((await trocar(temp, 'xx-nova.adm-xx')).body.code).toBe('SENHA_FRACA'); // contém o login
    expect((await trocar('nao-e-a-atual', 'uma senha nova e longa')).body.code).toBe('SENHA_ATUAL_INCORRETA');
    const ok = await trocar(temp, 'uma senha nova e longa');
    expect(ok.status).toBe(200);
    expect(ok.body.data.usuario.deveTrocarSenha).toBe(false);

    expect((await api.http().get('/api/v1/usuarios').set('Cookie', s1.cookie)).status).toBe(200); // a sessão atual segue
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', s2.cookie)).status).toBe(401); // a outra caiu
    expect((await api.http().post('/api/v1/auth/login').send({ login: 'nova.adm', senha: temp })).status).toBe(401);
    await api.entrar('nova.adm', 'uma senha nova e longa');
  });

  it('redefinir senha: derruba as sessões do alvo, exige troca e desbloqueia o login', async () => {
    const alvo = await api.como('porteiro');
    // Bloqueio por par login+IP (spec §5.1): o mesmo IP da guarita errando a senha.
    for (let i = 0; i < PADROES_LOGIN.maxFalhasLogin; i++) await api.http().post('/api/v1/auth/login').set('X-Forwarded-For', '198.51.100.99').send({ login: LOGINS.porteiro, senha: 'x' });
    expect((await api.http().post('/api/v1/auth/login').set('X-Forwarded-For', '198.51.100.99').send({ login: LOGINS.porteiro, senha: SENHA })).status).toBe(429);

    const { cookie } = await api.como('administracao');
    const r = await api.http().post(`/api/v1/usuarios/${api.usuarios[LOGINS.porteiro]!.id}/redefinir-senha`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.data.usuario.deveTrocarSenha).toBe(true);
    expect((await api.http().get('/api/v1/auth/me').set('Cookie', alvo.cookie)).status).toBe(401);
    const nova = await api.entrar(LOGINS.porteiro, r.body.data.senhaTemporaria, '198.51.100.99'); // o par foi zerado
    expect(nova.corpo.usuario.deveTrocarSenha).toBe(true);
  });

  it('id que não é uuid: 400 antes do banco (sem 22P02 nem 500)', async () => {
    const { cookie } = await api.como('sindico');
    const r = await api.http().post('/api/v1/usuarios/abc/desativar').set('Cookie', cookie);
    expect(r.status).toBe(400);
  });
});

describe('audit_log: snake_case e sem dado sensível em TODA a trilha gerada', () => {
  it('varre a trilha depois de um fluxo completo', async () => {
    const api = await novaApi();
    try {
      const { cookie } = await api.como('sindico');
      const c = await api.http().post('/api/v1/usuarios').set('Cookie', cookie).send({ nome: 'Edson Ramos', login: 'edson.ramos', papel: 'porteiro' });
      await api.http().patch(`/api/v1/usuarios/${c.body.data.usuario.id}`).set('Cookie', cookie).send({ papel: 'auditor' });
      await api.http().post(`/api/v1/usuarios/${c.body.data.usuario.id}/redefinir-senha`).set('Cookie', cookie);
      await api.http().post('/api/v1/auth/login').send({ login: '529.982.247-25', senha: SENHA });
      await api.http().get('/api/v1/usuarios').set('Cookie', (await api.como('porteiro')).cookie);
      await api.http().post('/api/v1/auth/logout').set('Cookie', cookie);

      const linhas = await trilha(api);
      const acoes = new Set(linhas.map((l) => l.acao));
      for (const a of ['auth.login', 'auth.login_falha', 'auth.logout', 'acesso.negado', 'usuario.criar', 'usuario.alterar_papel', 'usuario.redefinir_senha']) {
        expect(acoes, a).toContain(a);
      }
      const chaves = (v: unknown): string[] => (v && typeof v === 'object'
        ? Object.entries(v).flatMap(([k, x]) => [k, ...chaves(x)]) : []);
      for (const l of linhas) {
        for (const k of [...chaves(l.antes), ...chaves(l.depois)]) expect(k, `${l.acao}: ${k}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
      const tudo = JSON.stringify(linhas);
      expect(tudo).not.toMatch(/argon2/);
      expect(tudo).not.toContain(SENHA);
      expect(tudo).not.toContain(c.body.data.senhaTemporaria);
      expect(tudo).not.toMatch(/token_hash|senha_hash|documento_busca/);
      // nenhum CPF em claro. Os uuids saem antes: o último grupo (12 hex) às vezes tem 11 dígitos seguidos e o
      // teste falhava ao acaso, sem CPF nenhum.
      const semUuid = tudo.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
      expect(semUuid).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    } finally {
      await api.app.close(); await api.client.close();
    }
  });
});

describe('formato REST (skill rest-api): envelope { data }, paginação por cursor e erro padronizado', () => {
  let api: ApiDeTeste;
  let cookie: string;
  beforeAll(async () => { api = await novaApi(); cookie = (await api.como('sindico')).cookie; });
  afterAll(async () => { await api.app.close(); await api.client.close(); });

  it('GET /usuarios pagina por cursor: { data, pagination: { cursor, hasNextPage } }, sem repetir nem pular', async () => {
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const q: Record<string, string | number> = { limite: 3 };
      if (cursor) q.cursor = cursor;
      const r = await api.http().get('/api/v1/usuarios').query(q).set('Cookie', cookie);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(['data', 'pagination']);
      expect(r.body.data.length).toBeLessThanOrEqual(3);
      vistos.push(...r.body.data.map((u: { login: string }) => u.login));
      cursor = r.body.pagination.cursor;
      expect(r.body.pagination.hasNextPage).toBe(cursor !== null);
      paginas++;
    } while (cursor && paginas < 10);
    expect(paginas).toBe(2); // 4 usuários do seed em páginas de 3
    expect(new Set(vistos).size).toBe(vistos.length);
    expect([...vistos].sort()).toEqual(Object.values(LOGINS).sort());

    const tudo = await api.http().get('/api/v1/usuarios').set('Cookie', cookie);
    expect(tudo.body.data).toHaveLength(4);
    expect(tudo.body.pagination).toEqual({ cursor: null, hasNextPage: false });
  });

  it('cursor adulterado, limite fora da faixa e parâmetro desconhecido são 400 com details { field, message }', async () => {
    const ruim = await api.http().get('/api/v1/usuarios').query({ cursor: 'nao-e-cursor' }).set('Cookie', cookie);
    expect(ruim.status).toBe(400);
    expect(ruim.body).toMatchObject({ statusCode: 400, error: 'Bad Request', code: 'CURSOR_INVALIDO', path: '/api/v1/usuarios' });
    expect(ruim.body.path).not.toContain('?'); // a query nunca volta no corpo
    const limite = await api.http().get('/api/v1/usuarios').query({ limite: 500 }).set('Cookie', cookie);
    expect(limite.status).toBe(400);
    expect(limite.body.details[0]).toMatchObject({ field: 'limite' });
    expect((await api.http().get('/api/v1/usuarios').query({ papel: 'x' }).set('Cookie', cookie)).status).toBe(400);
  });

  it('item único vem em { data }; 204 sai sem corpo; erro traz statusCode, error, code, message, timestamp e path', async () => {
    const me = await api.http().get('/api/v1/auth/me').set('Cookie', cookie);
    expect(Object.keys(me.body)).toEqual(['data']);
    const e = await api.http().get('/api/v1/usuarios').set('Cookie', (await api.como('porteiro')).cookie);
    expect(e.status).toBe(403);
    expect(Object.keys(e.body).sort()).toEqual(['code', 'error', 'message', 'path', 'statusCode', 'timestamp']);
    expect(e.body).toMatchObject({ statusCode: 403, error: 'Forbidden', code: 'SEM_PERMISSAO' });
    expect(Number.isNaN(Date.parse(e.body.timestamp))).toBe(false);
    const sai = await api.http().post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(sai.status).toBe(204);
    expect(sai.text).toBe('');
  });
});
