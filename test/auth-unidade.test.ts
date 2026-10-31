// Unidades sem HTTP: snapshot da trilha, log, política de senha, config, filtro e GRANT das tabelas novas.
import type { ArgumentsHost } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditoriaService } from '../src/auditoria/auditoria.service';
import { snapshot } from '../src/auditoria/snapshot';
import * as s from '../src/db/schema';
import { problemasDaSenha } from '../src/auth/senha.service';
import { FiltroExcecao } from '../src/comum/filtro-excecao';
import { linhaDeLog, mascararDigitos } from '../src/comum/log';
import { carregarConfig } from '../src/config/config';
import { eq } from 'drizzle-orm';
import { type Db, type Fixtures, comoAppRw, erroDe, novoBanco } from './helpers/banco';
import type { PGlite } from '@electric-sql/pglite';

describe('snapshot do audit_log', () => {
  it('snake_case em todos os níveis; Date em ISO; segredos removidos; telefone e CPF mascarados; ids intactos', () => {
    const r = snapshot({
      id: '0b8a3c1e-1234-4567-8901-234567890123', usuarioId: '12345678-1234-4123-8123-123456789012',
      nomeCompleto: 'Ana', senhaHash: '$argon2id$...', tokenHash: 'abc', documentoBusca: 'f'.repeat(64),
      telefone: '11987654321', observacao: 'CPF 529.982.247-25 e fone 11 98765-4321', documentoMascarado: '***.982.247-**',
      criadoEm: new Date('2026-10-17T12:00:00.000Z'), extra: { ultimoAcesso: null, subNivel: { cpfDigitado: '52998224725' } },
    })!;
    expect(r).toEqual({
      id: '0b8a3c1e-1234-4567-8901-234567890123', usuario_id: '12345678-1234-4123-8123-123456789012',
      nome_completo: 'Ana', telefone: '(**) *****-4321', observacao: 'CPF ***.***.***-** e fone ** *****-****',
      documento_mascarado: '***.982.247-**', criado_em: '2026-10-17T12:00:00.000Z',
      extra: { ultimo_acesso: null, sub_nivel: { cpf_digitado: '***********' } },
    });
  });

  it('datas e números curtos não são mascarados', () => {
    expect(mascararDigitos('2026-10-17 torre 4 apto 32')).toBe('2026-10-17 torre 4 apto 32');
    expect(mascararDigitos('joao.lima')).toBe('joao.lima');
  });
});

describe('log de aplicação', () => {
  it('allowlist: campo fora da lista some (corpo, senha, cookie, login); dígitos e quebras de linha tratados', () => {
    const l = JSON.parse(linhaDeLog('info', 'http', {
      request_id: 'ab5c1234-1111-4111-8111-123456789012', rota: '/api/v1/auth/login\nFORJADO', status: 401,
      senha: 'segredo', corpo: { senha: 'x' }, cookie: 'tok', login: '52998224725', detalhe: 'cpf 52998224725',
    }));
    expect(Object.keys(l).sort()).toEqual(['detalhe', 'em', 'evento', 'nivel', 'request_id', 'rota', 'status']);
    expect(l.request_id).toBe('ab5c1234-1111-4111-8111-123456789012');
    expect(l.rota).toBe('/api/v1/auth/login FORJADO');
    expect(l.detalhe).toBe('cpf ***********');
  });
});

describe('política de senha', () => {
  it('12+ caracteres, fora da lista comum, sem conter o login, sem repetição de um caractere', () => {
    expect(problemasDaSenha('curta')).not.toEqual([]);
    expect(problemasDaSenha('Password1234')).not.toEqual([]);
    expect(problemasDaSenha('aaaaaaaaaaaaaaa')).not.toEqual([]);
    expect(problemasDaSenha('meu-joao.lima-2026', { login: 'joao.lima' })).not.toEqual([]);
    expect(problemasDaSenha('cavalo correto bateria grampo')).toEqual([]);
  });
});

describe('config do ambiente (falha no boot em vez de default silencioso)', () => {
  const base = {
    PORTARIA_AMBIENTE: 'dev', COOKIE_SECURE: 'false', TRUST_PROXY: 'false',
    PORTARIA_HMAC_CPF_KEY: Buffer.alloc(32, 1).toString('base64'),
    PORTARIA_KEK: Buffer.alloc(32, 2).toString('base64'), PORTARIA_KEK_VERSAO: '1',
  };
  it('válida', () => {
    const c = carregarConfig(base);
    expect(c.cookie).toEqual({ secure: false, nome: 'portaria_sessao' });
    expect(c.sessao).toEqual({ padrao: { inatividadeMin: 240, absolutaMin: 840 }, longa: { inatividadeMin: 1440, absolutaMin: 21600 }, toqueSeg: 60 });
    expect(carregarConfig({ ...base, SESSAO_PADRAO_INATIVIDADE_MIN: '', SESSAO_LONGA_ABSOLUTA_MIN: ' ' }).sessao).toEqual(c.sessao);
    expect(carregarConfig({
      ...base, SESSAO_PADRAO_INATIVIDADE_MIN: '60', SESSAO_PADRAO_ABSOLUTA_MIN: '480', SESSAO_LONGA_INATIVIDADE_MIN: '120', SESSAO_LONGA_ABSOLUTA_MIN: '43200',
    }).sessao).toMatchObject({ padrao: { inatividadeMin: 60, absolutaMin: 480 }, longa: { inatividadeMin: 120, absolutaMin: 43200 } });
    expect(c.login).toMatchObject({ maxFalhasLogin: 10, maxFalhasIp: 30, janelaMin: 15, bloqueioMin: 15 });
    expect(carregarConfig({ ...base, LOGIN_MAX_FALHAS_LOGIN: '', LOGIN_MAX_FALHAS_IP: ' ' }).login).toMatchObject({ maxFalhasLogin: 10, maxFalhasIp: 30 });
    expect(carregarConfig({ ...base, LOGIN_MAX_FALHAS_LOGIN: '8', LOGIN_MAX_FALHAS_IP: '40', LOGIN_JANELA_MIN: '20', LOGIN_BLOQUEIO_MIN: '30' }).login)
      .toMatchObject({ maxFalhasLogin: 8, maxFalhasIp: 40, janelaMin: 20, bloqueioMin: 30, atrasoBaseMs: 250 });
    expect(c.argon2).toMatchObject({ memoriaKib: 65536, iteracoes: 3, paralelismo: 1 });
    expect(carregarConfig({ ...base, COOKIE_SECURE: 'true' }).cookie.nome).toBe('__Host-portaria_sessao');
    // RN-09: prazo do legado definido em assembleia; vazio = 90 dias
    expect(c.importacao).toEqual({ prazoLegadoDias: 90 });
    expect(carregarConfig({ ...base, IMPORTACAO_PRAZO_LEGADO_DIAS: '' }).importacao.prazoLegadoDias).toBe(90);
    expect(carregarConfig({ ...base, IMPORTACAO_PRAZO_LEGADO_DIAS: '120' }).importacao.prazoLegadoDias).toBe(120);
    // Anexos cifrados (spec §9.2): só a pasta (padrão: o volume do compose). A KEK vem da plataforma (SaaS, F2).
    expect(c.documentos).toEqual({ dir: '/var/lib/portaria/documentos' });
    expect(carregarConfig({ ...base, PORTARIA_DOCUMENTOS_DIR: '/tmp/x' }).documentos.dir).toBe('/tmp/x');
    // SaaS (F2): transição ligada por padrão; as chaves antigas do ambiente ficam só para a conferência do boot.
    expect(c.saas.pilotoPadrao).toBe(true);
    expect(carregarConfig({ ...base, SAAS_PILOTO_PADRAO: 'false' }).saas.pilotoPadrao).toBe(false);
    expect(c.saas.chavesAmbiente.kekVersao).toBe(1);
    expect(c.saas.chavesAmbiente.kek!.equals(Buffer.alloc(32, 2))).toBe(true);
    expect(c.saas.chavesAmbiente.hmacCpf!.equals(Buffer.alloc(32, 1))).toBe(true);
    // Sem as chaves antigas (fim da transição): sobe, sem nada a conferir. Fallback para o ambiente não existe.
    const { PORTARIA_HMAC_CPF_KEY: _h, PORTARIA_KEK: _k, PORTARIA_KEK_VERSAO: _v, ...semChaves } = base;
    expect(carregarConfig(semChaves).saas.chavesAmbiente).toEqual({ hmacCpf: null, kek: null, kekVersao: null });
  });
  it('SESSAO_ABSOLUTA_MIN / SESSAO_INATIVIDADE_MIN antigas (mesmo inválidas): ignoradas com aviso, sem derrubar o boot', () => {
    const espiao = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const c = carregarConfig({ ...base, SESSAO_ABSOLUTA_MIN: '720', SESSAO_INATIVIDADE_MIN: '99999' });
      expect(c.sessao).toEqual(carregarConfig(base).sessao); // os prazos novos, não os antigos
      const avisos = espiao.mock.calls.map(([l]) => JSON.parse(String(l))).filter((l) => l.evento === 'config.variavel_ignorada');
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toMatchObject({ nivel: 'warn', detalhe: expect.stringContaining('SESSAO_ABSOLUTA_MIN, SESSAO_INATIVIDADE_MIN') });
      espiao.mockClear();
      carregarConfig({ ...base, SESSAO_ABSOLUTA_MIN: ' ' }); // vazia (compose com padrão vazio): sem aviso
      expect(espiao).not.toHaveBeenCalled();
    } finally {
      espiao.mockRestore();
    }
  });
  it.each([
    [{ COOKIE_SECURE: '1' }, /COOKIE_SECURE/],
    [{ COOKIE_SECURE: 'FALSE' }, /COOKIE_SECURE/],
    [{ PORTARIA_AMBIENTE: 'producao' }, /não é permitido/],
    [{ TRUST_PROXY: 'true' }, /TRUST_PROXY/],
    [{ LOGIN_MAX_FALHAS_LOGIN: '2' }, /LOGIN_MAX_FALHAS_LOGIN/],
    [{ LOGIN_MAX_FALHAS_LOGIN: '10.5' }, /LOGIN_MAX_FALHAS_LOGIN/],
    [{ LOGIN_MAX_FALHAS_IP: '1000' }, /LOGIN_MAX_FALHAS_IP/],
    [{ LOGIN_JANELA_MIN: '0' }, /LOGIN_JANELA_MIN/],
    [{ LOGIN_BLOQUEIO_MIN: 'quinze' }, /LOGIN_BLOQUEIO_MIN/],
    [{ CORS_ORIGENS: 'https://www.condenexo.com.br/' }, /origem exata/],
    [{ CORS_ORIGENS: '*' }, /CORS_ORIGENS/],
    // Produção sem CORS_ORIGENS (o resto da produção válido): recusa no boot. Em dev, vazia continua valendo (base).
    [{ PORTARIA_AMBIENTE: 'producao', COOKIE_SECURE: 'true', ANCORA_DESTINOS: 'github' }, /CORS_ORIGENS é obrigatória com PORTARIA_AMBIENTE=producao/],
    [{ PORTARIA_AMBIENTE: 'producao', COOKIE_SECURE: 'true', ANCORA_DESTINOS: 'github', CORS_ORIGENS: ' , ' }, /CORS_ORIGENS é obrigatória/],
    [{ SESSAO_PADRAO_INATIVIDADE_MIN: '900' }, /SESSAO_PADRAO_INATIVIDADE_MIN não pode passar de SESSAO_PADRAO_ABSOLUTA_MIN/],
    [{ SESSAO_PADRAO_ABSOLUTA_MIN: '1500' }, /SESSAO_PADRAO_ABSOLUTA_MIN deve estar entre 5 e 1440/],
    [{ SESSAO_PADRAO_ABSOLUTA_MIN: '4' }, /SESSAO_PADRAO_ABSOLUTA_MIN/],
    [{ SESSAO_PADRAO_INATIVIDADE_MIN: '4h' }, /SESSAO_PADRAO_INATIVIDADE_MIN deve ser inteiro/],
    [{ SESSAO_LONGA_ABSOLUTA_MIN: '43201' }, /SESSAO_LONGA_ABSOLUTA_MIN deve estar entre/],
    [{ SESSAO_LONGA_INATIVIDADE_MIN: '30000' }, /SESSAO_LONGA_INATIVIDADE_MIN não pode passar de SESSAO_LONGA_ABSOLUTA_MIN/],
    [{ SESSAO_LONGA_INATIVIDADE_MIN: '60' }, /não pode ser menor que SESSAO_PADRAO/],
    [{ SESSAO_LONGA_INATIVIDADE_MIN: '300', SESSAO_LONGA_ABSOLUTA_MIN: '600' }, /não pode ser menor que SESSAO_PADRAO/],
    [{ PORTARIA_HMAC_CPF_KEY: 'curta' }, /32 bytes/],
    [{ TRUST_PROXY: '' }, /TRUST_PROXY não definida/],
    [{ IMPORTACAO_PRAZO_LEGADO_DIAS: '0' }, /IMPORTACAO_PRAZO_LEGADO_DIAS/],
    [{ IMPORTACAO_PRAZO_LEGADO_DIAS: '1000' }, /IMPORTACAO_PRAZO_LEGADO_DIAS/],
    [{ IMPORTACAO_PRAZO_LEGADO_DIAS: 'noventa' }, /IMPORTACAO_PRAZO_LEGADO_DIAS/],
    [{ SAAS_PILOTO_PADRAO: 'sim' }, /SAAS_PILOTO_PADRAO/],
    [{ PORTARIA_KEK: Buffer.alloc(16, 1).toString('base64') }, /exatamente 32 bytes/],
    [{ PORTARIA_KEK: Buffer.alloc(48, 1).toString('base64') }, /exatamente 32 bytes/],
    [{ PORTARIA_KEK_VERSAO: '' }, /PORTARIA_KEK_VERSAO/],
    [{ PORTARIA_KEK_VERSAO: 'um' }, /PORTARIA_KEK_VERSAO/],
    [{ PORTARIA_DOCUMENTOS_DIR: 'relativo/pasta' }, /caminho absoluto/],
  ])('recusa %o', (extra, erro) => {
    expect(() => carregarConfig({ ...base, ...extra })).toThrow(erro);
  });
});

describe('filtro de exceção: erro do driver não vaza', () => {
  it('DrizzleQueryError (mensagem com SQL e parâmetros) vira 500 genérico; o log não leva a mensagem', async () => {
    const filtro = new FiltroExcecao({} as never, {} as never);
    const erro = Object.assign(new Error('Failed query: insert into pessoa ... params: Maria,52998224725'), {
      name: 'DrizzleQueryError', cause: { code: '22P02', constraint: undefined },
    });
    let status = 0; let corpo: unknown;
    const res = { headersSent: false, status(s: number) { status = s; return this; }, json(c: unknown) { corpo = c; } };
    const host = { switchToHttp: () => ({ getRequest: () => ({ requestId: 'r1' }), getResponse: () => res }) } as unknown as ArgumentsHost;
    const saida: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((l: string) => { saida.push(l); });
    await filtro.catch(erro, host);
    spy.mockRestore();
    expect(status).toBe(500);
    expect(corpo).toMatchObject({ statusCode: 500, error: 'Internal Server Error', code: 'ERRO_INTERNO', message: 'Erro interno. Tente novamente.', path: null });
    expect(saida.join('\n')).toContain('22P02');
    expect(saida.join('\n')).not.toMatch(/Maria|52998224725|Failed query/);
  });
});

describe('GRANT das tabelas da 0003 para app_rw (PGlite + SET ROLE)', () => {
  let client: PGlite; let db: Db; let usuarioId: string;
  beforeAll(async () => { ({ client, db } = await novoBanco()); usuarioId = (await db.execute(sql`select id from usuario_sistema limit 1`)).rows[0]!.id as string; });
  afterAll(async () => { await client.close(); });

  it('sessao: insere, atualiza uso/revogação; não muda token, dono ou expiração; não apaga', async () => {
    await comoAppRw(client, async () => {
      await db.execute(sql`insert into sessao (token_hash, usuario_id, expira_em) values (${'d'.repeat(64)}, ${usuarioId}, now() + interval '1 hour')`);
      await db.execute(sql`update sessao set ultimo_uso_em = now(), revogada_em = now(), motivo_revogacao = 'logout'`);
      for (const q of [sql`update sessao set token_hash = ${'e'.repeat(64)}`, sql`update sessao set expira_em = now()`, sql`delete from sessao`]) {
        expect(await erroDe(db.execute(q))).toMatch(/permission denied/);
      }
    });
  });

  it('login_limite: UPSERT funciona como app_rw; DELETE não', async () => {
    await comoAppRw(client, async () => {
      const up = sql`insert into login_limite as l (tipo, chave, falhas, janela_inicio) values ('ip', ${'f'.repeat(64)}, 1, now())
        on conflict (tipo, chave) do update set falhas = l.falhas + 1, atualizado_em = now() returning falhas`;
      await db.execute(up);
      expect((await db.execute(up)).rows[0]).toEqual({ falhas: 2 });
      expect(await erroDe(db.execute(sql`delete from login_limite`))).toMatch(/permission denied/);
    });
  });

  it('CHECKs: token fora do formato e motivo de revogação desconhecido são recusados', async () => {
    expect(await erroDe(db.execute(sql`insert into sessao (token_hash, usuario_id, expira_em) values ('curto', ${usuarioId}, now() + interval '1 hour')`))).toMatch(/sessao_token_hash_ck/);
    expect(await erroDe(db.execute(sql`update sessao set revogada_em = now(), motivo_revogacao = 'capricho'`))).toMatch(/sessao_motivo_ck/);
  });
});

describe('AuditoriaService + lgpd_redigir_audit_pessoa (exigência do schema: snapshot em snake_case)', () => {
  let client: PGlite; let db: Db; let fx: Fixtures;
  beforeAll(async () => { ({ client, db, fx } = await novoBanco()); });
  afterAll(async () => { await client.close(); });

  it('linha camelCase do Drizzle gravada pelo serviço é redigida pela função do banco (nome, telefone, documento, empresa)', async () => {
    const aud = new AuditoriaService();
    const [antes] = await db.select().from(s.pessoa).where(eq(s.pessoa.id, fx.prestador.id));
    await db.transaction(async (tx) => {
      const [depois] = await tx.update(s.pessoa).set({ servico: 'Troca de disjuntor' }).where(eq(s.pessoa.id, fx.prestador.id)).returning();
      await aud.registrar(tx, {
        ator: { id: fx.admin.id, nome: 'Ana Administração', papel: 'administracao' }, acao: 'pessoa.editar', entidade: 'pessoa',
        registroId: fx.prestador.id, antes, depois, ip: '::ffff:127.0.0.1',
      });
    });
    const [reg] = await db.select().from(s.auditLog).where(eq(s.auditLog.registroId, fx.prestador.id));
    expect(reg!.depois).toMatchObject({ nome: 'Pedro Prestador', empresa: 'Elétrica Silva', servico: 'Troca de disjuntor', telefone: '(**) *****-4321' });
    expect(Object.keys(reg!.depois as object)).not.toContain('documento_busca');

    await db.update(s.pessoa).set({ nome: 'Pessoa anonimizada', telefone: null, documentoMascarado: null, documentoBusca: null, anonimizadaEm: new Date() })
      .where(eq(s.pessoa.id, fx.prestador.id));
    await comoAppRw(client, () => client.query(`SELECT lgpd_redigir_audit_pessoa('${fx.prestador.id}')`));
    const [redigido] = await db.select().from(s.auditLog).where(eq(s.auditLog.registroId, fx.prestador.id));
    for (const campo of ['nome', 'telefone', 'documento_mascarado', 'empresa', 'servico']) {
      expect(redigido!.antes, campo).not.toHaveProperty(campo);
      expect(redigido!.depois, campo).not.toHaveProperty(campo);
    }
    expect(redigido!.depois).toHaveProperty('categoria', 'prestador');
  });

  it('IP inválido vira nulo e ação fora do formato falha ANTES do SQL (não aborta a transação do chamador)', async () => {
    const aud = new AuditoriaService();
    await expect(aud.registrar(db, { ator: null, nomeInformado: 'x', acao: 'Invalida', entidade: 'x' })).rejects.toThrow(/formato/);
    await aud.registrar(db, { ator: null, nomeInformado: 'x', acao: 'teste.ip', entidade: 'x', ip: 'não-é-ip' });
    const [l] = await db.select().from(s.auditLog).where(eq(s.auditLog.acao, 'teste.ip'));
    expect(l!.ip).toBeNull();
  });
});
