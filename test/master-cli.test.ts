// CLI criar-usuario-plataforma (bootstrap do Master) e serviço provisionador (sidecar da tela "Novo condomínio").
// Plataforma em PGlite com as migrações reais, gravando como app_plataforma (SET ROLE): os GRANTs da 0000 valem.
import type { AddressInfo } from 'node:net';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lerArgsUsuario, textoCredenciais, textoReset } from '../src/cli/criar-usuario-plataforma';
import { autorizado, criarServidor, tokenDoAmbiente } from '../src/cli/servidor-provisionador';
import { criarUsuario, ErroUsuarioPlataforma, normalizarEmail, normalizarNome, reemitirSenha, resetarSegundoFator, validarCadastro } from '../src/plataforma/usuario-plataforma';
import { masterCodigoRecuperacao } from '../src/plataforma/schema-plataforma';
import { ErroProvisionamento, type ResultadoProvisionamento } from '../src/plataforma/provisionar';
import { masterSessao, masterUsuario, plataformaAudit } from '../src/plataforma/schema-plataforma';
import { ProvisionadorHttp, TEMPO_SAUDE_MS } from '../src/plataforma/provisionador';
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

  it('regras de e-mail e nome (as mesmas do PATCH /plataforma/auth/me): mensagens da CLI inalteradas', () => {
    expect(validarCadastro({ email: '  Fulano@Exemplo.TEST ', nome: '  Fulano  ' })).toEqual({ email: 'fulano@exemplo.test', nome: 'Fulano', papel: 'master' });
    expect(() => validarCadastro({ nome: 'Fulano' })).toThrow('--email inválido');
    expect(() => validarCadastro({ email: `${'a'.repeat(245)}@exemplo.test`, nome: 'Fulano' })).toThrow('--email inválido');
    expect(() => validarCadastro({ email: 'a@b.c', nome: '  ab  ' })).toThrow('--nome precisa de 3 a 120 caracteres');
    expect(() => validarCadastro({ email: 'a@b.c', nome: 'x'.repeat(121) })).toThrow('--nome precisa de 3 a 120 caracteres');
    expect(normalizarEmail(`${'a'.repeat(241)}@exemplo.test`)).toHaveLength(254);
    expect(normalizarEmail(`${'a'.repeat(242)}@exemplo.test`)).toBeNull();
    for (const e of ['sem-arroba', 'a@b', 'a b@c.d', 'a@@b.c', '']) expect(normalizarEmail(e), e).toBeNull();
    expect(normalizarNome('x'.repeat(120))).toHaveLength(120);
    expect(normalizarNome('  abc ')).toBe('abc');
    expect(normalizarNome('ab')).toBeNull();
    // Texto enorme: recusado pelo tamanho antes da regex (com '.' repetido e '@' no fim, ela retrocede em tempo quadrático).
    const inicio = Date.now();
    expect(normalizarEmail(`a@${'.'.repeat(100_000)}@`)).toBeNull();
    expect(Date.now() - inicio).toBeLessThan(200);
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

  it('o banco recusa e-mail fora do formato; as colunas de TOTP e a tabela de recuperação voltaram na 0005 (segundo fator opcional)', async () => {
    const base = { nome: 'X X X', senhaHash: '$argon2id$x', papel: 'master' };
    await expect(p.db.insert(masterUsuario).values({ ...base, email: 'sem-arroba' })).rejects.toThrow();
    // Só em master_usuario (a 0004 tirou totp_confirmado_em de master_sessao e ele não volta).
    const r = await p.client.query<{ c: string }>(`SELECT table_name || '.' || column_name AS c FROM information_schema.columns
      WHERE table_name IN ('master_usuario', 'master_sessao') AND column_name LIKE 'totp%' ORDER BY 1`);
    expect(r.rows.map((x) => x.c)).toEqual(['master_usuario.totp_ativado_em', 'master_usuario.totp_cifrado', 'master_usuario.totp_mestra_versao',
      'master_usuario.totp_pendente_cifrado', 'master_usuario.totp_pendente_expira_em', 'master_usuario.totp_pendente_mestra_versao', 'master_usuario.totp_ultimo_passo']);
    const t = await p.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'master_codigo_recuperacao'`);
    expect(t.rows[0]!.n).toBe(1);
  });
});

describe('--resetar-2fa (sub-projeto C2)', () => {
  const CIFRADO = new Uint8Array(48).fill(7);
  let id = '';

  /** Usuário com fator ativo, enrolamento pendente, falhas, códigos da geração 1 e duas sessões abertas. */
  async function comFator(email: string) {
    const c = await comoAppPlataforma(p.client, () => criarUsuario(p.db, f, validarCadastro({ email, nome: 'Com Fator' })));
    await p.db.update(masterUsuario).set({
      deveTrocarSenha: false, senhaTemporariaExpiraEm: null, totpCifrado: CIFRADO, totpMestraVersao: 1, totpAtivadoEm: new Date(), totpUltimoPasso: 99,
      totpPendenteCifrado: CIFRADO, totpPendenteMestraVersao: 1, totpPendenteExpiraEm: new Date(Date.now() + 60_000), segundoFatorFalhas: 20, recuperacaoGeracao: 1,
    }).where(eq(masterUsuario.id, c.id));
    await p.db.insert(masterCodigoRecuperacao).values({ masterUsuarioId: c.id, geracao: 1, codigoHash: '9'.repeat(64) });
    for (const t of ['5', '6']) await p.db.insert(masterSessao).values({ tokenHash: t.repeat(32) + c.id.replaceAll('-', ''), masterUsuarioId: c.id, expiraEm: new Date(Date.now() + 3600_000) });
    return c.id;
  }

  it('argumentos: --resetar-2fa com ou sem --nova-senha; não aceita --nome/--papel nem repetição', () => {
    expect(lerArgsUsuario(['--email', 'a@b.c', '--resetar-2fa'])).toEqual({ email: 'a@b.c', novaSenha: false, resetar2fa: true });
    expect(lerArgsUsuario(['--resetar-2fa', '--email', 'a@b.c', '--nova-senha'])).toEqual({ email: 'a@b.c', novaSenha: true, resetar2fa: true });
    expect(() => lerArgsUsuario(['--resetar-2fa'])).toThrow(/uso/);
    expect(() => lerArgsUsuario(['--email', 'a@b.c', '--resetar-2fa', '--nome', 'Fulano'])).toThrow(/só na criação/);
    expect(() => lerArgsUsuario(['--email', 'a@b.c', '--resetar-2fa', '--resetar-2fa'])).toThrow(/uso/);
    expect(() => lerArgsUsuario(['--email', 'a@b.c', '--resetar2fa'])).toThrow(/uso/);
  });

  it('como app_plataforma, sem chave mestra: zera os dois trios, o passo e as falhas, invalida os códigos (geração + 1), revoga todas as sessões; a senha fica', async () => {
    id = await comFator('reset@exemplo.test');
    const [antes] = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    const c = await comoAppPlataforma(p.client, () => resetarSegundoFator(p.db, f, 'RESET@exemplo.test', { novaSenha: false }));
    expect(c).toEqual({ id, email: 'reset@exemplo.test', segundoFatorEstavaAtivo: true });
    const [u] = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    expect(u).toMatchObject({
      totpCifrado: null, totpMestraVersao: null, totpAtivadoEm: null, totpUltimoPasso: null, totpPendenteCifrado: null, totpPendenteMestraVersao: null,
      totpPendenteExpiraEm: null, segundoFatorFalhas: 0, recuperacaoGeracao: 2, senhaHash: antes!.senhaHash, deveTrocarSenha: false,
    });
    const sessoes = await p.db.select().from(masterSessao).where(eq(masterSessao.masterUsuarioId, id));
    expect(sessoes.map((x) => x.motivoRevogacao)).toEqual(['credencial_reemitida', 'credencial_reemitida']);
    const [l] = await p.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'master.resetar_segundo_fator'));
    expect(l!.detalhes).toEqual({ origem: 'cli', usuario_id: id, estava_ativo: true, senha: false, sessoes_revogadas: 2 });
    expect(l!.masterUsuarioId).toBeNull();
    const texto = textoReset(c);
    expect(texto).toContain('desligado');
    expect(texto).not.toMatch(/otpauth|secret=|senha temporária/i);
    expect(JSON.stringify(l)).not.toContain('9'.repeat(64));
  });

  it('com --nova-senha: senha temporária na MESMA transação (troca obrigatória) e mostrada só no terminal', async () => {
    const outro = await comFator('reset.senha@exemplo.test');
    const c = await comoAppPlataforma(p.client, () => resetarSegundoFator(p.db, f, 'reset.senha@exemplo.test', { novaSenha: true }));
    expect(c).toMatchObject({ id: outro, senhaTemporaria: 'abcd-efgh-jkmn-pqrs', segundoFatorEstavaAtivo: true });
    const [u] = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, outro));
    expect([u!.deveTrocarSenha, u!.totpAtivadoEm, u!.senhaTemporariaExpiraEm !== null]).toEqual([true, null, true]);
    expect(textoReset(c)).toContain('abcd-efgh-jkmn-pqrs');
    const linhas = await p.db.select().from(plataformaAudit).where(eq(plataformaAudit.acao, 'master.resetar_segundo_fator'));
    expect(JSON.stringify(linhas)).not.toContain('abcd-efgh');
    expect(linhas.at(-1)!.detalhes).toMatchObject({ usuario_id: outro, senha: true });
  });

  it('--nova-senha sozinho não desliga o 2º fator, mas zera as falhas (destrava a trava de 20)', async () => {
    const outro = await comFator('so.senha@exemplo.test');
    await comoAppPlataforma(p.client, () => reemitirSenha(p.db, f, 'so.senha@exemplo.test'));
    const [u] = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, outro));
    expect([u!.segundoFatorFalhas, u!.totpAtivadoEm !== null, u!.recuperacaoGeracao]).toEqual([0, true, 1]);
  });

  it('erros: e-mail inexistente e usuário desativado são recusados sem escrever', async () => {
    await expect(resetarSegundoFator(p.db, f, 'ninguem@exemplo.test', { novaSenha: false })).rejects.toThrow(/não encontrado/);
    await p.db.update(masterUsuario).set({ ativo: false }).where(eq(masterUsuario.id, id));
    const antes = await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, id));
    await expect(resetarSegundoFator(p.db, f, 'reset@exemplo.test', { novaSenha: false })).rejects.toBeInstanceOf(ErroUsuarioPlataforma);
    expect(await p.db.select().from(masterUsuario).where(eq(masterUsuario.id, id))).toEqual(antes);
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
