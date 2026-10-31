// CLI criar-usuario-plataforma (bootstrap do Master) e serviço provisionador (sidecar da tela "Novo condomínio").
// Plataforma em PGlite com as migrações reais, gravando como app_plataforma (SET ROLE): os GRANTs da 0000 valem.
import type { AddressInfo } from 'node:net';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lerArgsUsuario, textoCredenciais } from '../src/cli/criar-usuario-plataforma';
import { autorizado, criarServidor, tokenDoAmbiente } from '../src/cli/servidor-provisionador';
import { criarUsuario, ErroUsuarioPlataforma, reemitirSenha, validarCadastro } from '../src/master/usuario-plataforma';
import { ErroProvisionamento, type ResultadoProvisionamento } from '../src/saas/provisionar';
import { masterSessao, masterUsuario, plataformaAudit } from '../src/saas/schema-plataforma';
import { ProvisionadorHttp, TEMPO_SAUDE_MS } from '../src/master/provisionador';
import { comoAppPlataforma, novoBancoPlataforma } from './helpers/plataforma';

let p: Awaited<ReturnType<typeof novoBancoPlataforma>>;
const f = { hashSenha: (x: string) => hash(x, { memoryCost: 1024, timeCost: 1, parallelism: 1 }), gerarSenha: () => 'abcd-efgh-jkmn-pqrs' };

beforeAll(async () => { p = await novoBancoPlataforma(); });
afterAll(async () => { await p.client.close(); });

describe('argumentos', () => {
  it('criação exige e-mail e nome; reemissão (--nova-senha) não aceita nome/papel; --reemitir-totp e desconhecido são uso', () => {
    expect(lerArgsUsuario(['--email', 'a@b.c', '--nome', 'Fulano de Tal'])).toEqual({ email: 'a@b.c', nome: 'Fulano de Tal', novaSenha: false });
    expect(lerArgsUsuario(['--email', 'a@b.c', '--nova-senha'])).toEqual({ email: 'a@b.c', novaSenha: true });
    expect(() => lerArgsUsuario(['--email', 'a@b.c'])).toThrow(/uso/);
    expect(() => lerArgsUsuario(['--nome', 'x'])).toThrow(/uso/);
    expect(() => lerArgsUsuario(['--email', 'a@b.c', '--nova-senha', '--nome', 'x'])).toThrow(/só na criação/);
    expect(() => lerArgsUsuario(['--email', 'a@b.c', '--reemitir-totp'])).toThrow(/uso/);
    expect(() => lerArgsUsuario(['--email', 'a@b.c', '--senha', 'x'])).toThrow(/uso/);
    expect(() => validarCadastro({ email: 'sem-arroba', nome: 'Fulano' })).toThrow(/--email/);
    expect(() => validarCadastro({ email: 'a@b.c', nome: 'Fulano', papel: 'sindico' })).toThrow(/--papel/);
  });
});

describe('criar e reemitir', () => {
  let id = '';

  it('cria com senha temporária (troca obrigatória) e trilha sem a senha; a saída só traz a senha', async () => {
    const c = await comoAppPlataforma(p.client, () => criarUsuario(p.db, f, validarCadastro({ email: 'Operador@Exemplo.test', nome: 'Operador Fictício' })));
    id = c.id;
    expect(c).toEqual({ id, email: 'operador@exemplo.test', senhaTemporaria: 'abcd-efgh-jkmn-pqrs', senhaExpiraEm: expect.any(String) });
    const [u] = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(u).toMatchObject({ papel: 'master', ativo: true, deveTrocarSenha: true });
    expect(u!.senhaHash).toMatch(/^\$argon2id\$/);
    const trilha = JSON.stringify(await p.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'master.criar')));
    expect(trilha).toContain(id);
    expect(trilha).not.toContain('abcd-efgh');
    const texto = textoCredenciais(c, true);
    expect(texto).toContain('abcd-efgh-jkmn-pqrs');
    expect(texto).not.toMatch(/otpauth|totp|segundo fator/i);
  });

  it('e-mail já cadastrado (sem diferenciar maiúsculas): recusa, nada muda', async () => {
    const antes = await p.db.select().from(masterUsuario);
    await expect(comoAppPlataforma(p.client, () => criarUsuario(p.db, f, validarCadastro({ email: 'OPERADOR@exemplo.test', nome: 'Outro Nome' }))))
      .rejects.toBeInstanceOf(ErroUsuarioPlataforma);
    expect(await p.db.select().from(masterUsuario)).toEqual(antes);
  });

  it('nova senha: temporária com troca obrigatória e sessões revogadas; e-mail inexistente é recusado', async () => {
    await p.db.update(masterUsuario).set({ deveTrocarSenha: false, senhaTemporariaExpiraEm: null }).where(eq(masterUsuario.id, id));
    await p.db.insert(masterSessao).values({ tokenHash: 'a'.repeat(64), masterUsuarioId: id, expiraEm: new Date(Date.now() + 3600_000) });
    const [antes] = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    const c = await comoAppPlataforma(p.client, () => reemitirSenha(p.db, f, 'operador@exemplo.test'));
    expect(c.senhaTemporaria).toBe('abcd-efgh-jkmn-pqrs');
    const [u] = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(u!.deveTrocarSenha).toBe(true);
    expect(u!.senhaTemporariaExpiraEm).not.toBeNull();
    expect(u!.senhaHash).not.toBe(antes!.senhaHash);
    const [s] = await p.db.select().from(masterSessao).where(eq(masterSessao.masterUsuarioId, id));
    expect(s!.motivoRevogacao).toBe('credencial_reemitida');
    expect(textoCredenciais(c, false)).toContain('senha reemitida');
    await expect(reemitirSenha(p.db, f, 'ninguem@exemplo.test')).rejects.toThrow(/não encontrado/);
  });

  it('o banco recusa e-mail fora do formato; as colunas de TOTP e a tabela de recuperação não existem mais (0004)', async () => {
    const base = { nome: 'X X X', senhaHash: '$argon2id$x', papel: 'master' };
    await expect(p.db.insert(masterUsuario).values({ ...base, email: 'sem-arroba' })).rejects.toThrow();
    const r = await p.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name IN ('master_usuario', 'master_sessao') AND column_name LIKE 'totp%'`);
    expect(r.rows[0]!.n).toBe(0);
    const t = await p.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'master_codigo_recuperacao'`);
    expect(t.rows[0]!.n).toBe(0);
  });
});

describe('serviço provisionador (HTTP interno)', () => {
  const TOKEN = 't'.repeat(40);
  const ID = '11111111-1111-4111-8111-111111111111';
  let atraso: Promise<void> | null = null;
  const chamadas: unknown[] = [];
  const srv = criarServidor({
    token: TOKEN,
    async provisionar(entrada, masterUsuarioId) {
      chamadas.push({ entrada, masterUsuarioId });
      if (atraso) await atraso;
      if ((entrada as { codigo?: string }).codigo === 'recusa') throw new ErroProvisionamento('o código recusa já está cadastrado');
      if ((entrada as { codigo?: string }).codigo === 'quebra') throw new Error('erro do pg com SQL e senha=xyz');
      return { situacao: 'provisionado', condominioId: ID, codigo: 'x', banco: 'portaria_abcdefgh', unidades: 1, migracoes: 1, modulos: [], chaves: [], sindico: { login: 's', senhaTemporaria: 'k', expiraEm: 'e' } } as ResultadoProvisionamento;
    },
  });
  let url = '';
  beforeAll(async () => { await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok)); url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; });
  afterAll(async () => { await new Promise((ok) => srv.close(ok)); });

  const pedir = (corpo: unknown, token = TOKEN, caminho = '/provisionar') =>
    fetch(`${url}${caminho}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });

  it('token: obrigatório e comparado em tempo constante; rota única', async () => {
    expect(autorizado(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(autorizado(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(autorizado(undefined, TOKEN)).toBe(false);
    expect((await pedir({ entrada: {}, masterUsuarioId: ID }, 'errado')).status).toBe(401);
    expect((await pedir({ entrada: {}, masterUsuarioId: ID }, TOKEN, '/outra')).status).toBe(404);
    expect(chamadas).toEqual([]);
    expect(() => tokenDoAmbiente({ PROVISIONADOR_TOKEN: 'curto' })).toThrow(/32/);
  });

  it('pedido malformado 400, corpo grande 413, recusa 422 com a mensagem, falha 500 sem detalhe, sucesso 200', async () => {
    expect((await pedir('{nao json')).status).toBe(400);
    expect((await pedir({ entrada: {}, masterUsuarioId: 'x' })).status).toBe(400);
    expect((await pedir({ entrada: {}, masterUsuarioId: ID, extra: 1 })).status).toBe(400);
    expect((await pedir({ entrada: { x: 'a'.repeat(600_000) }, masterUsuarioId: ID }).catch(() => ({ status: 413 }))).status).toBe(413);
    const r = await pedir({ entrada: { codigo: 'recusa' }, masterUsuarioId: ID });
    expect([r.status, ((await r.json()) as { erro: string }).erro]).toEqual([422, 'o código recusa já está cadastrado']);
    const q = await pedir({ entrada: { codigo: 'quebra' }, masterUsuarioId: ID });
    expect(q.status).toBe(500);
    expect(JSON.stringify(await q.json())).not.toContain('senha=xyz');
    const ok = await pedir({ entrada: { codigo: 'bom' }, masterUsuarioId: ID });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(((await ok.json()) as { resultado: ResultadoProvisionamento }).resultado.sindico?.senhaTemporaria).toBe('k');
  });

  it('GET /saude: 200 com o token, 401 sem ele; o cliente da API vira booleano e nunca lança', async () => {
    const saude = (token?: string, metodo = 'GET', caminho = '/saude') =>
      fetch(`${url}${caminho}`, { method: metodo, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const antes = chamadas.length;
    const ok = await saude(TOKEN);
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true }]);
    expect((await saude()).status).toBe(401);
    expect((await saude('errado')).status).toBe(401);
    expect((await saude(TOKEN, 'POST')).status).toBe(404);
    expect((await saude(TOKEN, 'GET', '/provisionar')).status).toBe(404);
    expect(chamadas).toHaveLength(antes);
    expect(await new ProvisionadorHttp(url, TOKEN).disponivel()).toBe(true);
    expect(await new ProvisionadorHttp(url, 'x'.repeat(40)).disponivel()).toBe(false);
    expect(await new ProvisionadorHttp('http://127.0.0.1:9', TOKEN).disponivel()).toBe(false);
    expect(await new ProvisionadorHttp(null, null).disponivel()).toBe(false);
    // Pendurado: o timeout curto (TEMPO_SAUDE_MS) devolve false em vez de prender a tela.
    const preso = (async (_u: string, i: RequestInit) => new Promise((_ok, falha) => i.signal!.addEventListener('abort', () => falha(new Error('abort'))))) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await new ProvisionadorHttp(url, TOKEN, preso).disponivel()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(TEMPO_SAUDE_MS + 2_000);
  });

  it('um pedido por vez: o segundo simultâneo recebe 409', async () => {
    let soltar!: () => void;
    atraso = new Promise((ok) => { soltar = ok; });
    const primeiro = pedir({ entrada: { codigo: 'a' }, masterUsuarioId: ID });
    await new Promise((ok) => setTimeout(ok, 50));
    expect((await pedir({ entrada: { codigo: 'b' }, masterUsuarioId: ID })).status).toBe(409);
    // Ocupado não é desligado: a saúde responde no meio do provisionamento.
    expect(await new ProvisionadorHttp(url, TOKEN).disponivel()).toBe(true);
    soltar();
    expect((await primeiro).status).toBe(200);
    atraso = null;
  });
});
