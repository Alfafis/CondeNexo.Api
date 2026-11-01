// 2º fator (TOTP) do app do Master na API (sub-projeto C2, fase A1: OPCIONAL). HTTP de verdade sobre PGlite com as
// migrações reais. Cobre: enrolamento (iniciar/confirmar/regerar), login em duas etapas com desafio no servidor, as três
// camadas do limite do código, anti-replay (inclusive dois pedidos paralelos com o mesmo código), códigos de recuperação,
// 503 com segredo que não abre, e uma varredura final: nenhum segredo, URI, código ou hash de código em trilha ou log.
// O usuário SEM fator (o de hoje) é coberto por master-api.test.ts, que não mudou de expectativa.
import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nomeCookieDesafio, nomeCookieMaster } from '../src/plataforma/cookie-master';
import { masterCodigoRecuperacao, masterLoginPendente, masterSessao, masterUsuario, plataformaAudit, plataformaLoginLimite } from '../src/plataforma/schema-plataforma';
import { codigoTotp, deBase32, passoDe } from '../src/plataforma/totp';
import { criarUsuario, reemitirSenha } from '../src/plataforma/usuario-plataforma';
import { type ApiDeTeste, novaApi, novoIp } from './helpers/app';

const P = '/api/v1/plataforma';
const SENHA_M = 'senha-do-master-bem-longa-1';

let api: ApiDeTeste;
const logs: string[] = [];
/** Tudo que é segredo e passou pelo teste: a varredura final procura cada um na trilha e no log. */
const SEGREDOS = new Set<string>();

const ferramentas = () => ({
  hashSenha: (x: string) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => SENHA_M, agora: () => api.relogio.agora(),
});

async function novoMaster(email: string) {
  const c = await criarUsuario(api.plataforma.db, ferramentas(), { email, nome: `Operador ${email.split('@')[0]}`, papel: 'master' });
  await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, c.id));
  return c.id;
}

const login = (email: string, senha = SENHA_M, ip = novoIp()) => api.http().post(`${P}/auth/login`).set('X-Forwarded-For', ip).send({ email, senha });

function cookie(r: { headers: Record<string, unknown> }, nome: string): string | null {
  const l = ((r.headers['set-cookie'] as string[] | undefined) ?? []).find((x) => x.startsWith(`${nome}=`) && !x.startsWith(`${nome}=;`));
  return l ? l.split(';')[0]! : null;
}
const sessao = (r: { headers: Record<string, unknown> }) => cookie(r, nomeCookieMaster(true));
const desafio = (r: { headers: Record<string, unknown> }) => cookie(r, nomeCookieDesafio(true));

async function entrarSemFator(email: string) {
  const r = await login(email);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.etapa).toBe('concluido');
  return sessao(r)!;
}

const segundaEtapa = (c: string | null, corpo: Record<string, unknown>, ip = novoIp()) => {
  const req = api.http().post(`${P}/auth/login/segundo-fator`).set('X-Forwarded-For', ip);
  return (c ? req.set('Cookie', c) : req).send(corpo);
};

/** Próximo passo TOTP (o anti-replay não aceita o mesmo passo duas vezes). */
const proximoPasso = () => { api.relogio.atual = new Date(api.relogio.atual.getTime() + 30_000); };
const codigoAgora = (segredo: Buffer) => { const c = codigoTotp(segredo, passoDe(api.relogio.agora())); SEGREDOS.add(c); return c; };

/** Enrola o usuário pela API (iniciar + confirmar). Devolve o segredo, os códigos e o cookie da sessão que enrolou. */
async function enrolar(email: string) {
  const m = await entrarSemFator(email);
  const i = await api.http().post(`${P}/auth/segundo-fator/iniciar`).set('Cookie', m).send({ senhaAtual: SENHA_M });
  expect(i.status, JSON.stringify(i.body)).toBe(200);
  const segredo = deBase32(i.body.data.segredo);
  SEGREDOS.add(i.body.data.segredo).add(i.body.data.otpauthUri).add(segredo.toString('hex')).add(segredo.toString('base64'));
  const c = await api.http().post(`${P}/auth/segundo-fator/confirmar`).set('Cookie', m).send({ codigo: codigoAgora(segredo) });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const codigos = c.body.data.codigosRecuperacao as string[];
  for (const x of codigos) { SEGREDOS.add(x); SEGREDOS.add(x.replace(/-/g, '')); }
  proximoPasso();
  return { segredo, codigos, m };
}

async function entrarComFator(email: string, segredo: Buffer) {
  const r1 = await login(email);
  expect(r1.body.data.etapa).toBe('segundo_fator');
  const r2 = await segundaEtapa(desafio(r1), { codigo: codigoAgora(segredo) });
  expect(r2.status, JSON.stringify(r2.body)).toBe(200);
  proximoPasso();
  return sessao(r2)!;
}

const trilhaDe = async (id: string, acao: string) =>
  (await api.plataforma.db.select().from(plataformaAudit).where(and(eq(plataformaAudit.masterUsuarioId, id), eq(plataformaAudit.acao, acao)))).sort((a, b) => a.seq - b.seq);
const sessoesAtivas = async (id: string) =>
  (await api.plataforma.db.select().from(masterSessao).where(and(eq(masterSessao.masterUsuarioId, id), isNull(masterSessao.revogadaEm)))).length;
/** Sai da janela e do bloqueio do limite do código (15 + 15 min nos padrões). */
const passarBloqueio = () => api.relogio.avancarMin(16);

beforeAll(async () => {
  for (const k of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  }
  api = await novaApi();
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await api.app.close();
  await api.client.close();
});

describe('sem 2º fator (fase A1: opcional)', () => {
  it('login concluído na etapa 1, como antes, com `segundoFator` inativo em login e me; nenhum cookie de desafio', async () => {
    await novoMaster('sem.fator@exemplo.test');
    const r = await login('sem.fator@exemplo.test');
    expect(r.status).toBe(200);
    expect(r.body.data.etapa).toBe('concluido');
    expect(r.body.data.segundoFator).toEqual({ ativo: false, ativadoEm: null, codigosRestantes: 0, obrigatorio: false });
    expect(desafio(r)).toBeNull();
    const me = await api.http().get(`${P}/auth/me`).set('Cookie', sessao(r)!);
    expect(me.body.data.segundoFator).toEqual({ ativo: false, ativadoEm: null, codigosRestantes: 0, obrigatorio: false });
    // Nada exige o fator: rota comum responde.
    expect((await api.http().get(`${P}/condominios`).set('Cookie', sessao(r)!)).status).toBe(200);
  });
});

describe('enrolamento', () => {
  it('iniciar exige a senha (422, conta no par e-mail+IP; 429 no limite) e o corpo é estrito', async () => {
    const id = await novoMaster('enrola.senha@exemplo.test');
    const ip = novoIp();
    const m = (await (async () => { const r = await login('enrola.senha@exemplo.test', SENHA_M, ip); return sessao(r)!; })());
    const iniciar = (corpo: unknown) => api.http().post(`${P}/auth/segundo-fator/iniciar`).set('X-Forwarded-For', ip).set('Cookie', m).send(corpo as object);
    expect((await iniciar({})).status).toBe(400);
    expect((await iniciar({ senhaAtual: SENHA_M, extra: 1 })).status).toBe(400);
    expect((await iniciar({ senhaAtual: SENHA_M, codigo: '123456', codigoRecuperacao: 'AAAA-BBBB-CCCC-DDDD' })).status).toBe(400);
    const errada = await iniciar({ senhaAtual: 'senha-errada-errada' });
    expect([errada.status, errada.body.code]).toEqual([422, 'SENHA_ATUAL_INCORRETA']);
    expect((await trilhaDe(id, 'auth.segundo_fator_falha')).map((l) => l.detalhes)).toEqual([{ motivo: 'senha_incorreta', etapa: 'iniciar', ip }]);
    for (let i = 0; i < 9; i++) expect((await iniciar({ senhaAtual: 'senha-errada-errada' })).status).toBe(422);
    const bloq = await iniciar({ senhaAtual: SENHA_M });
    expect([bloq.status, bloq.body.code]).toEqual([429, 'LOGIN_BLOQUEADO']);
    expect(Number(bloq.headers['retry-after'])).toBeGreaterThan(0);
    // A sessão continua válida (422/429, nunca 401).
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', m)).status).toBe(200);
    const [u] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(u!.totpPendenteCifrado).toBeNull();
  });

  it('feliz: pendente até confirmar; código errado 422; confirmar ativa, gera 10 códigos (só hash no banco), revoga as OUTRAS sessões e mantém a atual', async () => {
    const id = await novoMaster('enrola.feliz@exemplo.test');
    const outra = await entrarSemFator('enrola.feliz@exemplo.test');
    const m = await entrarSemFator('enrola.feliz@exemplo.test');
    const i = await api.http().post(`${P}/auth/segundo-fator/iniciar`).set('Cookie', m).send({ senhaAtual: SENHA_M });
    expect(i.status).toBe(200);
    expect(i.headers['cache-control']).toBe('no-store');
    expect(i.body.data.segredo).toMatch(/^[A-Z2-7]{32}$/);
    expect(i.body.data.otpauthUri).toBe(`otpauth://totp/CondeNexo%3Aenrola.feliz%40exemplo.test?secret=${i.body.data.segredo}&issuer=CondeNexo&algorithm=SHA1&digits=6&period=30`);
    const segredo = deBase32(i.body.data.segredo);
    SEGREDOS.add(i.body.data.segredo).add(i.body.data.otpauthUri).add(segredo.toString('hex'));
    const [pend] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(pend!.totpPendenteCifrado).toHaveLength(48);
    expect(pend!.totpCifrado).toBeNull();
    expect(Buffer.from(pend!.totpPendenteCifrado!).includes(segredo)).toBe(false);
    // Antes de confirmar, o login continua sem código.
    expect((await login('enrola.feliz@exemplo.test')).body.data.etapa).toBe('concluido');

    const errado = codigoTotp(segredo, passoDe(api.relogio.agora()) + 5);
    const e = await api.http().post(`${P}/auth/segundo-fator/confirmar`).set('Cookie', m).send({ codigo: errado });
    expect([e.status, e.body.code]).toEqual([422, 'CODIGO_INVALIDO']);
    expect((await api.http().post(`${P}/auth/segundo-fator/confirmar`).set('Cookie', m).send({ codigo: '12a456' })).status).toBe(400);

    const c = await api.http().post(`${P}/auth/segundo-fator/confirmar`).set('Cookie', m).send({ codigo: codigoAgora(segredo) });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.headers['cache-control']).toBe('no-store');
    const codigos = c.body.data.codigosRecuperacao as string[];
    for (const x of codigos) { SEGREDOS.add(x); SEGREDOS.add(x.replace(/-/g, '')); }
    expect(codigos).toHaveLength(10);
    expect(c.body.data.segundoFator).toMatchObject({ ativo: true, codigosRestantes: 10, obrigatorio: false });
    expect(c.body.data.usuario.email).toBe('enrola.feliz@exemplo.test');
    // A sessão que enrolou continua; a outra (aberta só com senha) caiu com motivo segundo_fator.
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', m)).body.data.segundoFator.ativo).toBe(true);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', outra)).status).toBe(401);
    const motivos = (await api.plataforma.db.select().from(masterSessao).where(eq(masterSessao.masterUsuarioId, id))).map((s) => s.motivoRevogacao);
    expect(motivos).toContain('segundo_fator');
    expect((await trilhaDe(id, 'auth.segundo_fator_ativar')).map((l) => l.detalhes)).toEqual([{ troca_de_dispositivo: false, sessoes_revogadas: 2, ip: expect.any(String) }]);
    // O banco não contém código em claro (só o hash rotulado).
    const linhas = await api.plataforma.db.select().from(masterCodigoRecuperacao).where(eq(masterCodigoRecuperacao.masterUsuarioId, id));
    expect(linhas).toHaveLength(10);
    const tudo = JSON.stringify(linhas);
    for (const x of codigos) { expect(tudo).not.toContain(x); expect(tudo).not.toContain(x.replace(/-/g, '')); }
    const [u] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect([u!.totpCifrado?.length, u!.totpPendenteCifrado, u!.segundoFatorFalhas, u!.recuperacaoGeracao]).toEqual([48, null, 0, 1]);

    // O código que confirmou não abre login no mesmo passo (anti-replay); o do passo seguinte abre.
    const r1 = await login('enrola.feliz@exemplo.test');
    const mesmo = await segundaEtapa(desafio(r1), { codigo: codigoAgora(segredo) });
    expect([mesmo.status, mesmo.body.code]).toEqual([401, 'CODIGO_INVALIDO']);
    expect((await trilhaDe(id, 'auth.segundo_fator_falha')).at(-1)!.detalhes).toMatchObject({ motivo: 'codigo_reutilizado', etapa: 'login' });
    proximoPasso();
    expect((await segundaEtapa(desafio(r1), { codigo: codigoAgora(segredo) })).status).toBe(200);
    proximoPasso();
  });

  it('confirmar sem pendente ou com pendente vencido (10 min): 409 ENROLAMENTO_EXPIRADO', async () => {
    await novoMaster('enrola.vence@exemplo.test');
    const m = await entrarSemFator('enrola.vence@exemplo.test');
    const confirmar = () => api.http().post(`${P}/auth/segundo-fator/confirmar`).set('Cookie', m).send({ codigo: '123456' });
    expect([(await confirmar()).status, (await confirmar()).body.code]).toEqual([409, 'ENROLAMENTO_EXPIRADO']);
    const i = await api.http().post(`${P}/auth/segundo-fator/iniciar`).set('Cookie', m).send({ senhaAtual: SENHA_M });
    SEGREDOS.add(i.body.data.segredo);
    api.relogio.avancarMin(11);
    const r = await api.http().post(`${P}/auth/segundo-fator/confirmar`).set('Cookie', m).send({ codigo: codigoAgora(deBase32(i.body.data.segredo)) });
    expect([r.status, r.body.code]).toEqual([409, 'ENROLAMENTO_EXPIRADO']);
  });

  it('troca de dispositivo: exige código (TOTP ou recuperação, que NÃO é consumido); a confirmação gera códigos novos e os antigos morrem', async () => {
    const id = await novoMaster('troca@exemplo.test');
    const { segredo, codigos, m } = await enrolar('troca@exemplo.test');
    const iniciar = (corpo: object) => api.http().post(`${P}/auth/segundo-fator/iniciar`).set('Cookie', m).send({ senhaAtual: SENHA_M, ...corpo });
    const sem = await iniciar({});
    expect([sem.status, sem.body.code]).toEqual([422, 'CODIGO_INVALIDO']);
    const errado = await iniciar({ codigo: codigoTotp(segredo, passoDe(api.relogio.agora()) + 7) });
    expect([errado.status, errado.body.code]).toEqual([422, 'CODIGO_INVALIDO']);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', m)).status).toBe(200);
    // Com um código de recuperação: prova posse, não consome.
    const r = await iniciar({ codigoRecuperacao: codigos[0]!.toLowerCase() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', m)).body.data.segundoFator.codigosRestantes).toBe(10);
    // O fator antigo continua valendo até a confirmação.
    await entrarComFator('troca@exemplo.test', segredo);
    const novo = deBase32(r.body.data.segredo);
    SEGREDOS.add(r.body.data.segredo).add(r.body.data.otpauthUri);
    const c = await api.http().post(`${P}/auth/segundo-fator/confirmar`).set('Cookie', m).send({ codigo: codigoAgora(novo) });
    expect(c.status).toBe(200);
    for (const x of c.body.data.codigosRecuperacao as string[]) SEGREDOS.add(x);
    expect((await trilhaDe(id, 'auth.segundo_fator_ativar')).at(-1)!.detalhes).toMatchObject({ troca_de_dispositivo: true });
    proximoPasso();
    // Código antigo (de recuperação e do autenticador antigo) já não vale.
    const r1 = await login('troca@exemplo.test');
    expect((await segundaEtapa(desafio(r1), { codigoRecuperacao: codigos[1]! })).body.code).toBe('CODIGO_INVALIDO');
    expect((await segundaEtapa(desafio(r1), { codigo: codigoAgora(segredo) })).body.code).toBe('CODIGO_INVALIDO');
    expect((await segundaEtapa(desafio(r1), { codigo: codigoAgora(novo) })).status).toBe(200);
    proximoPasso();
  });

  it('regerar códigos: senha e código do autenticador; a geração anterior deixa de valer inteira', async () => {
    const id = await novoMaster('regera@exemplo.test');
    const { segredo, codigos, m } = await enrolar('regera@exemplo.test');
    const regerar = (corpo: object) => api.http().post(`${P}/auth/segundo-fator/codigos-recuperacao`).set('Cookie', m).send(corpo);
    expect((await regerar({ senhaAtual: SENHA_M })).status).toBe(400);
    expect((await regerar({ senhaAtual: SENHA_M, codigo: codigoTotp(segredo, passoDe(api.relogio.agora()) + 9) })).body.code).toBe('CODIGO_INVALIDO');
    const r = await regerar({ senhaAtual: SENHA_M, codigo: codigoAgora(segredo) });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const novos = r.body.data.codigosRecuperacao as string[];
    for (const x of novos) SEGREDOS.add(x);
    expect(novos).toHaveLength(10);
    expect(novos.some((x) => codigos.includes(x))).toBe(false);
    expect((await trilhaDe(id, 'auth.recuperacao_regerar')).length).toBe(1);
    const r1 = await login('regera@exemplo.test');
    expect((await segundaEtapa(desafio(r1), { codigoRecuperacao: codigos[0]! })).body.code).toBe('CODIGO_INVALIDO');
    expect((await segundaEtapa(desafio(r1), { codigoRecuperacao: novos[0]! })).status).toBe(200);
  });
});

describe('login com 2º fator', () => {
  let segredo: Buffer;
  let codigos: string[];
  let id: string;
  beforeAll(async () => {
    id = await novoMaster('com.fator@exemplo.test');
    ({ segredo, codigos } = await enrolar('com.fator@exemplo.test'));
  });

  it('etapa 1: 200 `segundo_fator`, só o cookie de desafio (Path do login, 5 min, HttpOnly, Secure, Strict), nenhuma sessão; trilha login_senha_ok', async () => {
    const antes = await sessoesAtivas(id);
    const ip = novoIp();
    const r = await login('com.fator@exemplo.test', SENHA_M, ip);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ etapa: 'segundo_fator', expiraEm: new Date(api.relogio.agora().getTime() + 5 * 60_000).toISOString() });
    expect(sessao(r)).toBeNull();
    const sc = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('__Secure-portaria_plataforma_2fa='))!;
    expect(sc).toMatch(/Path=\/api\/v1\/plataforma\/auth\/login(;|$)/);
    expect(sc).toMatch(/Max-Age=300/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Strict/);
    expect(await sessoesAtivas(id)).toBe(antes);
    expect((await trilhaDe(id, 'auth.login_senha_ok')).at(-1)!.detalhes).toMatchObject({ ip });
    // Senha errada continua a resposta de sempre (nada revela que há 2º fator).
    const errada = await login('com.fator@exemplo.test', 'senha-errada-errada');
    expect([errada.status, errada.body.code]).toEqual([401, 'CREDENCIAIS_INVALIDAS']);
    expect(desafio(errada)).toBeNull();
  });

  it('o cookie de desafio não autentica nenhuma rota, e o de sessão não serve como desafio', async () => {
    const r = await login('com.fator@exemplo.test');
    const d = desafio(r)!;
    const token = d.split('=')[1]!;
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', d)).status).toBe(401);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', `${nomeCookieMaster(true)}=${token}`)).status).toBe(401);
    expect((await api.http().get(`${P}/condominios`).set('Cookie', `${nomeCookieMaster(true)}=${token}`)).status).toBe(401);
    const m = await entrarComFator('com.fator@exemplo.test', segredo);
    const sessaoComoDesafio = await segundaEtapa(`${nomeCookieDesafio(true)}=${m.split('=')[1]}`, { codigo: codigoAgora(segredo) });
    expect([sessaoComoDesafio.status, sessaoComoDesafio.body.code]).toEqual([401, 'DESAFIO_EXPIRADO']);
    expect((await segundaEtapa(null, { codigo: '123456' })).body.code).toBe('DESAFIO_EXPIRADO');
    expect((await segundaEtapa(`${nomeCookieDesafio(true)}=lixo`, { codigo: '123456' })).body.code).toBe('DESAFIO_EXPIRADO');
  });

  it('etapa 2: código errado 401 CODIGO_INVALIDO (motivo só na trilha); certo = sessão nova, cookie de desafio limpo, trilha com fator e desvio', async () => {
    const ip = novoIp();
    const r1 = await login('com.fator@exemplo.test', SENHA_M, ip);
    const d = desafio(r1)!;
    const errado = await segundaEtapa(d, { codigo: codigoTotp(segredo, passoDe(api.relogio.agora()) + 4) }, ip);
    expect([errado.status, errado.body.code, errado.body.message]).toEqual([401, 'CODIGO_INVALIDO', 'Código inválido ou já usado.']);
    expect((await trilhaDe(id, 'auth.segundo_fator_falha')).at(-1)!.detalhes).toEqual({ motivo: 'codigo_incorreto', etapa: 'login', ip });
    expect((await segundaEtapa(d, { codigo: '12345' })).status).toBe(400);
    expect((await segundaEtapa(d, { codigo: '123456', codigoRecuperacao: codigos[0] })).status).toBe(400);
    expect((await segundaEtapa(d, {})).status).toBe(400);
    // Um passo antes (relógio do celular atrasado): aceito com desvio -1.
    proximoPasso();
    const ok = await segundaEtapa(d, { codigo: codigoTotp(segredo, passoDe(api.relogio.agora()) - 1) }, ip);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.etapa).toBe('concluido');
    expect(ok.body.data.segundoFator).toMatchObject({ ativo: true, codigosRestantes: 10 });
    expect(ok.body.data.codigosRecuperacaoRestantes).toBeUndefined();
    const linhaLimpa = (ok.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith(`${nomeCookieDesafio(true)}=;`));
    expect(linhaLimpa).toMatch(/Path=\/api\/v1\/plataforma\/auth\/login/);
    const m = sessao(ok)!;
    expect(m.split('=')[1]).not.toBe(d.split('=')[1]);
    expect((await api.http().get(`${P}/auth/me`).set('Cookie', m)).status).toBe(200);
    expect((await trilhaDe(id, 'auth.login')).at(-1)!.detalhes).toMatchObject({ fator: 'totp', desvio: -1, ip });
    const [u] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(u!.segundoFatorFalhas).toBe(0);
    // O desafio concluído não serve de novo.
    expect((await segundaEtapa(d, { codigo: codigoAgora(segredo) })).body.code).toBe('DESAFIO_EXPIRADO');
    proximoPasso();
  });

  it('dois pedidos paralelos com o mesmo código: exatamente UMA sessão (mesmo desafio e desafios diferentes)', async () => {
    const antes = await sessoesAtivas(id);
    const a = desafio(await login('com.fator@exemplo.test'))!;
    const b = desafio(await login('com.fator@exemplo.test'))!;
    const codigo = codigoAgora(segredo);
    const rs = await Promise.all([segundaEtapa(a, { codigo }), segundaEtapa(b, { codigo }), segundaEtapa(a, { codigo }), segundaEtapa(b, { codigo })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401, 401, 401]);
    expect(await sessoesAtivas(id)).toBe(antes + 1);
    // As falhas de corrida contaram: zera (por um sucesso) antes dos próximos testes.
    proximoPasso();
    passarBloqueio();
    await entrarComFator('com.fator@exemplo.test', segredo);
  });

  it('código de recuperação: entra uma vez só (informa quantos restam); reutilizado = 401; trilha fator recuperacao', async () => {
    const r1 = await login('com.fator@exemplo.test');
    const ok = await segundaEtapa(desafio(r1), { codigoRecuperacao: codigos[3]! });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.codigosRecuperacaoRestantes).toBe(9);
    expect(ok.body.data.segundoFator.codigosRestantes).toBe(9);
    expect((await trilhaDe(id, 'auth.login')).at(-1)!.detalhes).toMatchObject({ fator: 'recuperacao' });
    expect((await trilhaDe(id, 'auth.login')).at(-1)!.detalhes).not.toHaveProperty('desvio');
    const r2 = await login('com.fator@exemplo.test');
    const de_novo = await segundaEtapa(desafio(r2), { codigoRecuperacao: codigos[3]! });
    expect([de_novo.status, de_novo.body.code]).toEqual([401, 'CODIGO_INVALIDO']);
    expect((await trilhaDe(id, 'auth.segundo_fator_falha')).at(-1)!.detalhes).toMatchObject({ motivo: 'recuperacao_invalida' });
    expect((await segundaEtapa(desafio(r2), { codigoRecuperacao: codigos[4]! })).status).toBe(200);
  });

  it('desafio vencido (5 min): 401 DESAFIO_EXPIRADO e o cookie é limpo', async () => {
    const r1 = await login('com.fator@exemplo.test');
    api.relogio.avancarMin(6);
    const r = await segundaEtapa(desafio(r1), { codigo: codigoAgora(segredo) });
    expect([r.status, r.body.code, r.body.message]).toEqual([401, 'DESAFIO_EXPIRADO', 'Entre de novo com e-mail e senha.']);
    expect((r.headers['set-cookie'] as unknown as string[]).some((x) => x.startsWith(`${nomeCookieDesafio(true)}=;`))).toBe(true);
  });

  it('senha temporária vencida ou usuário desativado ENTRE as etapas: 401 DESAFIO_EXPIRADO', async () => {
    const outro = await novoMaster('entre.etapas@exemplo.test');
    const { segredo: s2 } = await enrolar('entre.etapas@exemplo.test');
    const d1 = desafio(await login('entre.etapas@exemplo.test'))!;
    await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: true, senhaTemporariaExpiraEm: new Date(api.relogio.agora().getTime() - 1000) }).where(eq(masterUsuario.id, outro));
    expect((await segundaEtapa(d1, { codigo: codigoAgora(s2) })).body.code).toBe('DESAFIO_EXPIRADO');
    await api.plataforma.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, outro));
    const d2 = desafio(await login('entre.etapas@exemplo.test'))!;
    await api.plataforma.db.update(masterUsuario).set({ ativo: false }).where(eq(masterUsuario.id, outro));
    expect((await segundaEtapa(d2, { codigo: codigoAgora(s2) })).body.code).toBe('DESAFIO_EXPIRADO');
  });
});

describe('limites do código', () => {
  it('5 tentativas queimam o desafio; o limite por usuário (qualquer IP) dá 429 com Retry-After sem conferir; depois da janela volta', async () => {
    const id = await novoMaster('limite.codigo@exemplo.test');
    const { segredo } = await enrolar('limite.codigo@exemplo.test');
    const d = desafio(await login('limite.codigo@exemplo.test'))!;
    const errado = () => codigoTotp(segredo, passoDe(api.relogio.agora()) + 3);
    for (let i = 0; i < 5; i++) expect((await segundaEtapa(d, { codigo: errado() })).body.code).toBe('CODIGO_INVALIDO');
    // 6ª no mesmo desafio, mesmo com o código certo: queimado.
    expect((await segundaEtapa(d, { codigo: codigoAgora(segredo) })).body.code).toBe('DESAFIO_EXPIRADO');
    // Desafio novo, outro IP: o limite é por usuário.
    const d2 = desafio(await login('limite.codigo@exemplo.test'))!;
    const b = await segundaEtapa(d2, { codigo: codigoAgora(segredo) }, novoIp());
    expect([b.status, b.body.code]).toEqual([429, 'LOGIN_BLOQUEADO']);
    expect(Number(b.headers['retry-after'])).toBeGreaterThan(0);
    const bloqueio = (await trilhaDe(id, 'auth.bloqueio')).find((l) => (l.detalhes as { tipo: string }).tipo === 'master_codigo');
    expect(bloqueio).toBeDefined();
    expect((await api.plataforma.db.select().from(plataformaLoginLimite).where(eq(plataformaLoginLimite.tipo, 'master_codigo'))).length).toBeGreaterThan(0);
    passarBloqueio();
    expect((await segundaEtapa(d2, { codigo: codigoAgora(segredo) })).body.code).toBe('DESAFIO_EXPIRADO'); // 16 min: o desafio de 5 min venceu
    await entrarComFator('limite.codigo@exemplo.test', segredo);
    const [u] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(u!.segundoFatorFalhas).toBe(0);
  });

  it('20 falhas seguidas travam o fator (403 na etapa 1); só a CLI destrava (--nova-senha zera as falhas e mantém o fator)', async () => {
    const id = await novoMaster('trava@exemplo.test');
    const { segredo } = await enrolar('trava@exemplo.test');
    for (let rodada = 0; rodada < 4; rodada++) {
      const d = desafio(await login('trava@exemplo.test'))!;
      for (let i = 0; i < 5; i++) {
        expect((await segundaEtapa(d, { codigo: codigoTotp(segredo, passoDe(api.relogio.agora()) + 3) })).body.code, `rodada ${rodada}, tentativa ${i}`).toBe('CODIGO_INVALIDO');
      }
      passarBloqueio();
    }
    const [u] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(u!.segundoFatorFalhas).toBe(20);
    expect((await trilhaDe(id, 'auth.segundo_fator_travado')).length).toBe(1);
    const t = await login('trava@exemplo.test');
    expect([t.status, t.body.code]).toEqual([403, 'SEGUNDO_FATOR_TRAVADO']);
    expect(desafio(t)).toBeNull();
    // A senha errada continua a resposta genérica (o travado só aparece a quem acerta a senha).
    expect((await login('trava@exemplo.test', 'senha-errada-errada')).body.code).toBe('CREDENCIAIS_INVALIDAS');
    // A CLI reemite a senha: falhas zeradas, o fator continua exigido.
    const c = await reemitirSenha(api.plataforma.db, { ...ferramentas(), gerarSenha: () => 'temporaria-da-cli-0001' }, 'trava@exemplo.test');
    const r1 = await login('trava@exemplo.test', c.senhaTemporaria!);
    expect(r1.body.data.etapa).toBe('segundo_fator');
    const ok = await segundaEtapa(desafio(r1), { codigo: codigoAgora(segredo) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.usuario.deveTrocarSenha).toBe(true);
    proximoPasso();
  });
});

describe('segredo que não abre (mestra trocada sem rotação, linha adulterada)', () => {
  it('503 SEGUNDO_FATOR_INDISPONIVEL com log sem detalhe; o código de recuperação continua entrando', async () => {
    const id = await novoMaster('nao.abre@exemplo.test');
    const { segredo, codigos } = await enrolar('nao.abre@exemplo.test');
    const [u] = await api.plataforma.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    const adulterado = Buffer.from(u!.totpCifrado!);
    adulterado[20] = adulterado[20]! ^ 0xff;
    await api.plataforma.db.update(masterUsuario).set({ totpCifrado: adulterado }).where(eq(masterUsuario.id, id));
    const d = desafio(await login('nao.abre@exemplo.test'))!;
    const r = await segundaEtapa(d, { codigo: codigoAgora(segredo) });
    expect([r.status, r.body.code]).toEqual([503, 'SEGUNDO_FATOR_INDISPONIVEL']);
    expect(logs.some((l) => l.includes('plataforma.totp_nao_abre') && l.includes(id))).toBe(true);
    expect((await segundaEtapa(d, { codigoRecuperacao: codigos[0]! })).status).toBe(200);
  });
});

describe('o que não pode vazar', () => {
  it('trilha, desafios e log: nenhum segredo (base32, hex, base64), otpauthUri, código TOTP, código de recuperação ou hash de código', async () => {
    const hashes = (await api.plataforma.db.select({ h: masterCodigoRecuperacao.codigoHash }).from(masterCodigoRecuperacao)).map((x) => x.h);
    expect(hashes.length).toBeGreaterThan(0);
    const trilha = JSON.stringify(await api.plataforma.db.select().from(plataformaAudit));
    const desafios = JSON.stringify(await api.plataforma.db.select().from(masterLoginPendente));
    const log = logs.join('\n');
    expect(SEGREDOS.size).toBeGreaterThan(30);
    // Código TOTP (6 dígitos) com fronteira: sem ela, 6 dígitos aleatórios casariam por acaso dentro de um UUID do log.
    // Nenhum grupo de UUID tem 6 caracteres, então um código cercado por não alfanuméricos nunca vem de um UUID.
    const achou = (texto: string, x: string) => (/^\d{6}$/.test(x) ? new RegExp(`(^|[^0-9A-Za-z])${x}([^0-9A-Za-z]|$)`).test(texto) : texto.includes(x));
    for (const x of [...SEGREDOS, ...hashes]) {
      expect(achou(trilha, x), x).toBe(false);
      expect(achou(log, x), x).toBe(false);
      expect(achou(desafios, x), x).toBe(false);
    }
    expect(achou('{"codigo":"123456"}', '123456')).toBe(true);
    // O hash do token de desafio é SHA-256 (64 hex), nunca o token.
    for (const d of await api.plataforma.db.select().from(masterLoginPendente)) expect(d.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(trilha).not.toMatch(/otpauth/i);
  });
});
