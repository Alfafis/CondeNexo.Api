// Gestão de síndicos pelo app do Master (docs/05_arquitetura_saas.md §5.5): adicionar, trocar, nova senha,
// desativar/reativar, só sobre usuários `sindico`, com motivo, a senha do Master de novo (sob o limite do login) e a trilha
// do condomínio (`plataforma.usuario_*`) gravada na mesma transação da mudança; `plataforma_audit` antes do COMMIT.
import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditoriaService } from '../src/auditoria/auditoria.service';
import * as s from '../src/db/schema';
import { nomeCookieMaster } from '../src/master/cookie-master';
import { criarUsuario } from '../src/master/usuario-plataforma';
import { ResolvedorCondominio } from '../src/saas/resolvedor';
import { condominio, masterUsuario, plataformaAudit } from '../src/saas/schema-plataforma';
import { type ApiDeTeste, LOGINS, novaApi, novoIp } from './helpers/app';

const V1 = '/api/v1';
const P = `${V1}/plataforma`;
const SENHA_M = 'senha-do-master-bem-longa-1';
const EMAIL = 'master.sindicos@exemplo.test';
const MOTIVO = 'Chamado 42: o síndico pediu a troca em assembleia';

let api: ApiDeTeste;
let master: string;
let masterId: string;
let suporte: string;
/** IP fixo das ações do Master (o limite é por par e-mail+IP). */
const IP_M = '203.0.113.50';

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

const post = (caminho: string, corpo: object, cookie = master, cond = api.pilotoId, ip = IP_M) =>
  api.http().post(`${P}/condominios/${cond}/sindicos${caminho}`).set('Cookie', cookie).set('X-Forwarded-For', ip).send(corpo);
const prot = (extra: object = {}) => ({ motivo: MOTIVO, senhaMaster: SENHA_M, ...extra });
const linhasM = (db = api.db) => db.select().from(s.auditLog).where(eq(s.auditLog.usuarioNome, `plataforma/${EMAIL}`)).orderBy(s.auditLog.seq);
const trilhaP = () => api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.masterUsuarioId, masterId)).orderBy(plataformaAudit.seq);
const usuario = async (login: string) => (await api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.login, login)))[0]!;
const sessoesAbertas = async (id: string) => (await api.db.select().from(s.sessao).where(eq(s.sessao.usuarioId, id))).filter((x) => !x.revogadaEm).length;
/** Nada de senha nem hash no que vai para a trilha ou volta na resposta (além da temporária, que sai uma vez). */
const semSegredo = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(/senha_hash|senhaHash|\$argon2|senha_master|senhaMaster|"senha"/i);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  api = await novaApi({}, { demo: true });
  ({ cookie: master, id: masterId } = await novoMaster(EMAIL, 'master'));
  suporte = (await novoMaster('suporte.sindicos@exemplo.test', 'suporte')).cookie;
}, 120_000);

afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

describe('lista dos síndicos (leitura auditada)', () => {
  it('só papel sindico, sem nada de senha, e uma linha plataforma.ler', async () => {
    const antes = (await linhasM()).length;
    const r = await api.http().get(`${P}/condominios/${api.pilotoId}/sindicos`).set('Cookie', master);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.map((u: { login: string }) => u.login)).toEqual([LOGINS.sindico]);
    expect(r.body.data[0]).toMatchObject({ papel: 'sindico', ativo: true });
    semSegredo(r.body);
    const [l] = (await linhasM()).slice(antes);
    expect([l!.acao, l!.entidade, (l!.depois as { rota: string }).rota]).toEqual(['plataforma.ler', 'usuario_sistema', '/sindicos']);
  });
});

describe('adicionar, nova senha, trocar, desativar e reativar', () => {
  let novoId = '';

  it('adicionar: senha temporária uma vez, troca obrigatória, trilha do condomínio e da plataforma', async () => {
    const antesP = (await trilhaP()).length;
    const r = await post('', prot({ nome: 'Marina Duarte', login: '  Marina.Duarte ' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data;
    expect(d.usuario).toMatchObject({ nome: 'Marina Duarte', login: 'marina.duarte', papel: 'sindico', ativo: true, deveTrocarSenha: true });
    expect(d.senhaTemporaria).toEqual(expect.any(String));
    expect(Date.parse(d.expiraEm) - api.relogio.agora().getTime()).toBe(72 * 3_600_000);
    novoId = d.usuario.id;
    // Entra com a temporária e cai na troca obrigatória.
    const login = await api.entrar('marina.duarte', d.senhaTemporaria);
    expect(login.corpo.usuario.deveTrocarSenha).toBe(true);

    const [l] = (await linhasM()).slice(-1);
    expect([l!.usuarioId, l!.usuarioPapel, l!.acao, l!.entidade, l!.registroId, l!.ip]).toEqual([null, null, 'plataforma.usuario_criar', 'usuario_sistema', novoId, IP_M]);
    expect(l!.depois).toMatchObject({ motivo: MOTIVO, rota: '/sindicos', metodo: 'POST', master_usuario_id: masterId, usuario: { nome: 'Marina Duarte', login: 'marina.duarte', papel: 'sindico' } });
    semSegredo(l);
    expect(JSON.stringify(l)).not.toContain(d.senhaTemporaria);
    const p = (await trilhaP()).slice(antesP);
    expect(p.map((x) => [x.acao, x.condominioId])).toEqual([['condominio.sindico_criar', api.pilotoId]]);
    expect(p[0]!.detalhes).toEqual({ usuario_id: novoId, rota: '/sindicos', metodo: 'POST', ip: IP_M });
  });

  it('login duplicado (sem diferença de maiúsculas): 409 no campo login, nada gravado', async () => {
    const antes = (await linhasM()).length;
    const r = await post('', prot({ nome: 'Outro Nome', login: LOGINS.sindico.toUpperCase() }));
    expect([r.status, r.body.code]).toEqual([409, 'LOGIN_EXISTENTE']);
    expect(r.body.details).toEqual([{ field: 'login', message: expect.any(String) }]);
    expect((await linhasM()).length).toBe(antes);
  });

  it('nova senha: temporária nova, sessões revogadas, limite de login zerado', async () => {
    const carlos = await usuario(LOGINS.sindico);
    await api.como('sindico');
    expect(await sessoesAbertas(carlos.id)).toBeGreaterThan(0);
    const r = await post(`/${carlos.id}/redefinir-senha`, prot());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.usuario).toMatchObject({ id: carlos.id, deveTrocarSenha: true });
    expect(await sessoesAbertas(carlos.id)).toBe(0);
    const login = await api.entrar(LOGINS.sindico, r.body.data.senhaTemporaria);
    expect(login.corpo.usuario.deveTrocarSenha).toBe(true);
    const [l] = (await linhasM()).slice(-1);
    expect([l!.acao, l!.registroId]).toEqual(['plataforma.usuario_redefinir_senha', carlos.id]);
    expect(l!.depois).toMatchObject({ motivo: MOTIVO, deve_trocar_senha: true, sessoes_revogadas: expect.any(Number) });
    semSegredo(l);
  });

  it('trocar: cria o novo e desativa o antigo na mesma transação, sessões do antigo revogadas; duas linhas', async () => {
    const marina = await usuario('marina.duarte');
    const antes = (await linhasM()).length;
    const r = await post(`/${marina.id}/trocar`, prot({ nome: 'Caio Prado', login: 'caio.prado' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { usuario: novo, substituido, senhaTemporaria } = r.body.data;
    expect(novo).toMatchObject({ login: 'caio.prado', papel: 'sindico', ativo: true, deveTrocarSenha: true });
    expect(substituido).toMatchObject({ id: marina.id, ativo: false });
    expect(senhaTemporaria).toEqual(expect.any(String));
    expect(await sessoesAbertas(marina.id)).toBe(0);
    const novas = (await linhasM()).slice(antes);
    expect(novas.map((x) => [x.acao, x.registroId, (x.depois as { troca: string }).troca])).toEqual([
      ['plataforma.usuario_trocar', novo.id, 'entrou'], ['plataforma.usuario_trocar', marina.id, 'saiu'],
    ]);
    expect(novas[1]!.depois).toMatchObject({ substituido_por_usuario_id: novo.id, ativo: { antes: true, depois: false } });
  });

  it('trocar um síndico já desativado: recusado', async () => {
    const marina = await usuario('marina.duarte');
    const r = await post(`/${marina.id}/trocar`, prot({ nome: 'Fulano Tal', login: 'fulano.tal' }));
    expect([r.status, r.body.code]).toEqual([422, 'SINDICO_DESATIVADO']);
  });

  it('nova senha de síndico desativado: recusada (reativar antes)', async () => {
    const marina = await usuario('marina.duarte');
    const r = await post(`/${marina.id}/redefinir-senha`, prot());
    expect([r.status, r.body.code]).toEqual([422, 'USUARIO_DESATIVADO']);
  });

  it('reativar e desativar; o último síndico ativo não sai (orienta a trocar)', async () => {
    const marina = await usuario('marina.duarte');
    let r = await post(`/${marina.id}/reativar`, prot());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ usuario: { ativo: true } });
    expect(r.body.data.senhaTemporaria).toBeUndefined();
    expect((await linhasM()).slice(-1)[0]!.acao).toBe('plataforma.usuario_reativar');
    r = await post(`/${marina.id}/reativar`, prot());
    expect([r.status, r.body.code]).toEqual([422, 'USUARIO_JA_ATIVO']);

    // Ativos agora: carlos, caio e marina. Desativa dois; o terceiro é o último.
    const ativos = (await api.db.select().from(s.usuarioSistema).where(and(eq(s.usuarioSistema.papel, 'sindico'), eq(s.usuarioSistema.ativo, true))));
    expect(ativos.length).toBe(3);
    for (const u of ativos.slice(0, 2)) {
      r = await post(`/${u.id}/desativar`, prot());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await linhasM()).slice(-1)[0]!.acao).toBe('plataforma.usuario_desativar');
    }
    const ultimo = ativos[2]!;
    const antes = (await linhasM()).length;
    r = await post(`/${ultimo.id}/desativar`, prot());
    expect([r.status, r.body.code]).toEqual([422, 'ULTIMO_SINDICO_ATIVO']);
    expect(r.body.message).toMatch(/Trocar/);
    expect((await usuario(ultimo.login)).ativo).toBe(true);
    expect((await linhasM()).length).toBe(antes);
    // Devolve os outros dois (os testes seguintes contam com o carlos ativo).
    for (const u of ativos.slice(0, 2)) expect((await post(`/${u.id}/reativar`, prot())).status).toBe(200);
  });
});

describe('proteções', () => {
  it('só usuários sindico: outro papel 422, id desconhecido 404', async () => {
    const porteiro = await usuario(LOGINS.porteiro);
    for (const c of ['redefinir-senha', 'desativar', 'reativar']) {
      const r = await post(`/${porteiro.id}/${c}`, prot());
      expect([r.status, r.body.code], c).toEqual([422, 'USUARIO_NAO_SINDICO']);
    }
    expect((await post(`/${porteiro.id}/trocar`, prot({ nome: 'Novo Alguém', login: 'novo.alguem' }))).body.code).toBe('USUARIO_NAO_SINDICO');
    expect((await usuario('novo.alguem').catch(() => undefined))).toBeUndefined();
    const r = await post('/00000000-0000-4000-8000-000000000777/desativar', prot());
    expect([r.status, r.body.code]).toEqual([404, 'USUARIO_NAO_ENCONTRADO']);
  });

  it('motivo curto e campos extras: 400 antes de qualquer verificação; não existe senha definida pelo Master', async () => {
    const carlos = await usuario(LOGINS.sindico);
    let r = await post(`/${carlos.id}/desativar`, prot({ motivo: '  curto demais ' }));
    expect([r.status, r.body.code]).toEqual([400, 'DADOS_INVALIDOS']);
    expect(r.body.details[0].field).toBe('motivo');
    r = await post('', prot({ nome: 'Ana Souza', login: 'ana.souza', senha: 'uma-senha-escolhida-pelo-master' }));
    expect([r.status, r.body.code]).toEqual([400, 'DADOS_INVALIDOS']);
    r = await post(`/${carlos.id}/redefinir-senha`, prot({ novaSenha: 'x'.repeat(20) }));
    expect(r.status).toBe(400);
    semSegredo(r.body);
  });

  it('senha do Master errada: 403 no campo, nada muda, falha na trilha da plataforma (sem o texto digitado)', async () => {
    const carlos = await usuario(LOGINS.sindico);
    const antes = (await linhasM()).length;
    const r = await post(`/${carlos.id}/redefinir-senha`, prot({ senhaMaster: 'chute-errado-123' }), master, api.pilotoId, novoIp());
    expect([r.status, r.body.code]).toEqual([403, 'SENHA_MASTER_INCORRETA']);
    expect(r.body.details).toEqual([{ field: 'senhaMaster', message: expect.any(String) }]);
    expect((await linhasM()).length).toBe(antes);
    expect((await usuario(LOGINS.sindico)).senhaHash).toBe(carlos.senhaHash);
    const [f] = (await trilhaP()).filter((x) => x.acao === 'auth.reautenticar_falha').slice(-1);
    expect(f!.condominioId).toBe(api.pilotoId);
    expect(f!.detalhes).toMatchObject({ motivo: 'senha_incorreta', acao: 'plataforma.usuario_redefinir_senha' });
    expect(JSON.stringify(f!.detalhes)).not.toContain('chute-errado');
    // A sessão continua válida (403, não 401).
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', master)).status).toBe(200);
  });

  it('a senha errada conta para o limite do login: a 11ª no mesmo IP é 429, mesmo com a senha certa', async () => {
    const outro = await novoMaster('limite.sindicos@exemplo.test', 'master');
    const ip = novoIp();
    const carlos = await usuario(LOGINS.sindico);
    for (let i = 0; i < 10; i++) {
      const r = await post(`/${carlos.id}/redefinir-senha`, prot({ senhaMaster: `errada-${i}` }), outro.cookie, api.pilotoId, ip);
      expect(r.status, `${i}`).toBe(403);
    }
    const r = await post(`/${carlos.id}/redefinir-senha`, prot(), outro.cookie, api.pilotoId, ip);
    expect([r.status, r.body.code]).toEqual([429, 'LOGIN_BLOQUEADO']);
    // E o login do Master nesse IP também está bloqueado (mesmo limite).
    const l = await api.http().post(`${P}/auth/login`).set('X-Forwarded-For', ip).send({ email: 'limite.sindicos@exemplo.test', senha: SENHA_M });
    expect(l.status).toBe(429);
    expect((await api.plataforma.db.select().from(plataformaAudit).where(and(eq(plataformaAudit.masterUsuarioId, outro.id), eq(plataformaAudit.acao, 'auth.bloqueio')))).length).toBeGreaterThan(0);
  });

  it('suporte não tem a ação (403 SEM_PERMISSAO); sem sessão 401; sessão de condomínio não abre', async () => {
    const carlos = await usuario(LOGINS.sindico);
    const r = await post(`/${carlos.id}/desativar`, prot(), suporte);
    expect([r.status, r.body.code]).toEqual([403, 'SEM_PERMISSAO']);
    const [neg] = (await api.plataforma.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'acesso.negado'))).slice(-1);
    expect((neg!.detalhes as { acao: string }).acao).toBe('condominio.sindicos');
    expect((await api.http().post(`${P}/condominios/${api.pilotoId}/sindicos/${carlos.id}/desativar`).send(prot())).status).toBe(401);
    const sind = await api.como('administracao'); // a senha do carlos foi redefinida acima
    expect((await api.http().post(`${P}/condominios/${api.pilotoId}/sindicos/${carlos.id}/desativar`).set('Cookie', sind.cookie).send(prot())).status).toBe(401);
  });

  it('situação do condomínio: encerrado e provisionando 409, excluído 404; suspenso aceita', async () => {
    const resolvedor = api.app.get(ResolvedorCondominio);
    const status = async (st: 'provisionando' | 'ativo' | 'suspenso' | 'encerrado' | 'excluido') => {
      await api.plataforma.db.update(condominio).set({ status: st, encerradoEm: ['encerrado', 'excluido'].includes(st) ? new Date() : null }).where(eq(condominio.id, api.demo!.id));
      resolvedor.invalidar();
    };
    const corpo = prot({ nome: 'Síndico Do Demo', login: 'sindico.demo' });
    try {
      await status('encerrado');
      expect((await post('', corpo, master, api.demo!.id)).body.code).toBe('CONDOMINIO_ENCERRADO');
      await status('provisionando');
      expect((await post('', corpo, master, api.demo!.id)).body.code).toBe('CONDOMINIO_PROVISIONANDO');
      await status('excluido');
      expect((await post('', corpo, master, api.demo!.id)).status).toBe(404);
      await status('suspenso');
      const r = await post('', corpo, master, api.demo!.id);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      // Gravado no banco do demo, não no piloto.
      expect((await api.demo!.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.login, 'sindico.demo'))).length).toBe(1);
      expect((await api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.login, 'sindico.demo'))).length).toBe(0);
      expect((await linhasM(api.demo!.db as never)).slice(-1)[0]!.acao).toBe('plataforma.usuario_criar');
    } finally {
      await status('ativo');
    }
  });
});

describe('a trilha vem junto: falhou, nada muda', () => {
  it('falha no audit_log do condomínio: 503 e o usuário não é criado', async () => {
    const espiao = vi.spyOn(api.app.get(AuditoriaService), 'registrarPlataforma').mockRejectedValueOnce(Object.assign(new Error('x'), { code: '53100' }));
    const r = await post('', prot({ nome: 'Sem Trilha Um', login: 'sem.trilha1' }));
    espiao.mockRestore();
    expect([r.status, r.body.code]).toEqual([503, 'TRILHA_INDISPONIVEL']);
    expect(r.body.data).toBeUndefined();
    expect(await usuario('sem.trilha1').catch(() => undefined)).toBeUndefined();
  });

  it('falha no plataforma_audit (antes do COMMIT): 503, rollback da mudança e da linha do condomínio', async () => {
    const carlos = await usuario(LOGINS.sindico);
    const antes = (await linhasM()).length;
    const espiao = vi.spyOn(api.plataforma.db, 'insert').mockImplementationOnce(() => { throw new Error('plataforma fora'); });
    const r = await post(`/${carlos.id}/redefinir-senha`, prot());
    espiao.mockRestore();
    expect([r.status, r.body.code]).toEqual([503, 'TRILHA_INDISPONIVEL']);
    expect(r.body.data).toBeUndefined();
    expect((await usuario(LOGINS.sindico)).senhaHash).toBe(carlos.senhaHash);
    expect((await linhasM()).length).toBe(antes);
  });
});

describe('tela "Acessos da plataforma": a ação aparece com motivo e usuário afetado', () => {
  it('síndico vê plataforma.usuario_* com motivo e alvo; master_usuario_id não sai', async () => {
    const sind = await api.como('auditor');
    const r = await api.http().get(`${V1}/auditoria/acessos-plataforma?limite=100`).set('Cookie', sind.cookie);
    expect(r.status).toBe(200);
    const criar = r.body.data.find((x: { acao: string }) => x.acao === 'plataforma.usuario_criar');
    expect(criar).toMatchObject({ quem: `plataforma/${EMAIL}`, motivo: MOTIVO, alvo: 'Marina Duarte (marina.duarte)', entidade: 'usuario_sistema', rota: '/sindicos', metodo: 'POST' });
    const trocas = r.body.data.filter((x: { acao: string }) => x.acao === 'plataforma.usuario_trocar').map((x: { troca: string }) => x.troca).sort();
    expect(trocas).toEqual(['entrou', 'saiu']);
    expect(JSON.stringify(r.body)).not.toContain(masterId);
    semSegredo(r.body);
  });
});
