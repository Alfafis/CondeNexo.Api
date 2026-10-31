// Provisionamento de condomínio novo (src/saas/provisionar.ts, CLI provisionar-condominio). Sobre PGlite: a plataforma
// roda como app_plataforma (SET ROLE) e os dados do condomínio como app_rw, então os GRANTs das migrações valem; o que
// depende de role com LOGIN de verdade (app_provisionador, CONNECT por banco) está em
// test/postgres-real/saas-provisionar.test.ts. Aqui: o fluxo inteiro, o login no condomínio novo pela API, o
// isolamento contra o piloto, a idempotência, a retomada depois de falha e as recusas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UFS } from '../src/dominio/condominio';
import { MODULOS } from '../src/dominio/modulos';
import { lerAmbiente, lerArgs, lerEntrada } from '../src/cli/provisionar-condominio';
import type { Db } from '../src/database/database.module';
import { REGISTRO_BANCOS } from '../src/database/registro-bancos';
import * as s from '../src/db/schema';
import { ErroChave } from '../src/saas/chave-mestra';
import {
  type Cluster, ErroProvisionamento, NOME_PROVISIONAMENTO, type Portas, provisionar, validarEntrada,
} from '../src/saas/provisionar';
import { ResolvedorCondominio } from '../src/saas/resolvedor';
import * as sp from '../src/saas/schema-plataforma';
import { type ApiDeTeste, cookieDe, novaApi, novoIp, SENHA } from './helpers/app';
import { PASTA_MIGRACOES } from './helpers/banco';
import type { RegistroDeTeste } from './helpers/saas';
import { MESTRA_TESTE } from './helpers/saas';

const V1 = '/api/v1';

const ENTRADA = {
  codigo: 'jardim-norte',
  nome: 'Residencial Jardim Norte',
  cidade: 'Campinas',
  uf: 'sp',
  estrutura: { agrupamento: 'Torre', blocos: ['1', '2'], andares: [0, 1, 2], finais: [1, 2], ausentes: ['1-01'] },
  areasComuns: ['Salão de festas', 'Churrasqueira'],
  sindico: { nome: 'Síndica de Exemplo', login: 'sindica.exemplo' },
};
const UNIDADES = 2 * 3 * 2 - 1; // 11

/** Cluster de teste: cada banco é um PGlite próprio, registrado no RegistroDeTeste da API (como o pool app_rw). */
class ClusterDeTeste implements Cluster {
  readonly clientes = new Map<string, PGlite>();
  readonly restringidos = new Set<string>();
  falharConexoes = 0;
  constructor(private readonly registro: RegistroDeTeste) {}
  async donoDoBanco(banco: string) { return this.clientes.has(banco) ? 'app_migrator' : null; }
  async criarBanco(banco: string) {
    const c = new PGlite();
    await c.exec('CREATE ROLE app_migrator NOLOGIN; CREATE ROLE app_rw NOLOGIN;');
    this.clientes.set(banco, c);
    this.registro.bancos.set(banco, drizzle(c, { schema: s }) as unknown as Db);
  }
  async restringirConexao(banco: string) { this.restringidos.add(banco); }
  async conexoes(banco: string) {
    if (this.falharConexoes > 0) { this.falharConexoes--; throw new Error('falha simulada na verificação'); }
    const ok = this.restringidos.has(banco);
    return { appRw: true, appPlataforma: !ok, publico: !ok };
  }
}

let api: ApiDeTeste;
let cluster: ClusterDeTeste;
const journal = JSON.parse(readFileSync(fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url)), 'utf8')) as { entries: unknown[] };

function portas(extra: Partial<Portas> = {}): Portas {
  return {
    plataforma: api.plataforma.db,
    cluster,
    // Migra como superusuário (o PGlite não tem LOGIN) e deixa a sessão como app_rw: os dados gravam com os GRANTs dele.
    migrar: async (banco) => {
      const c = cluster.clientes.get(banco)!;
      await c.exec('RESET ROLE');
      await migrate(drizzle(c), { migrationsFolder: PASTA_MIGRACOES });
      const n = Number((await c.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0]!.n);
      await c.exec('SET ROLE app_rw');
      return { aplicadas: n, esperadas: journal.entries.length };
    },
    dados: (banco) => drizzle(cluster.clientes.get(banco)!, { schema: s }) as unknown as Db,
    mestra: MESTRA_TESTE,
    hashSenha: (senha) => hash(senha, { memoryCost: 1024, timeCost: 1, parallelism: 1 }),
    gerarSenha: (() => { let n = 0; return () => `temp-senha-${String(++n).padStart(4, '0')}-xyzw`; })(),
    ...extra,
  };
}

/** Provisiona como app_plataforma (SET ROLE no PGlite da plataforma). */
async function comoPlataforma<T>(fn: () => Promise<T>): Promise<T> {
  await api.plataforma.client.exec('SET ROLE app_plataforma');
  try { return await fn(); } finally { await api.plataforma.client.exec('RESET ROLE'); }
}

async function login(codigo: string | null, loginNome: string, senha: string) {
  const r = api.http().post(`${V1}/auth/login`).set('X-Forwarded-For', novoIp());
  if (codigo) r.set('X-Condominio', codigo);
  return r.send({ login: loginNome, senha });
}

/**
 * O resolvedor guarda a tabela `condominio` em cache (status novo vale em até RENOVAR_MS, 1 min; código desconhecido
 * recarrega no máximo a cada 5 s). Aqui o teste "espera" esse tempo zerando a idade do cache.
 */
function cacheVencido() {
  (api.app.get(ResolvedorCondominio) as unknown as { carregadoEm: number }).carregadoEm = 0;
}

async function statusDe(codigo: string) {
  const [c] = await api.plataforma.db.select().from(sp.condominio).where(eq(sp.condominio.codigo, codigo));
  return c;
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  api = await novaApi();
  cluster = new ClusterDeTeste(api.app.get(REGISTRO_BANCOS) as RegistroDeTeste);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await api.app.close();
  await api.client.close();
  for (const c of cluster.clientes.values()) await c.close();
});

describe('entrada', () => {
  it('normaliza e aceita a entrada de exemplo; áreas comuns padrão quando omitidas', () => {
    const e = validarEntrada(ENTRADA);
    expect(e.uf).toBe('SP');
    expect(e.plano).toBe('padrao');
    const { areasComuns: _, ...semAreas } = ENTRADA;
    expect(validarEntrada(semAreas).areasComuns).toContain('Salão de festas');
  });

  it('recusa código, UF, login, estrutura incoerente e campo desconhecido, citando o campo', () => {
    const erro = (x: unknown) => { try { validarEntrada(x); return ''; } catch (e) { expect(e).toBeInstanceOf(ErroProvisionamento); return (e as Error).message; } };
    expect(erro({ ...ENTRADA, codigo: '1abc' })).toMatch(/codigo/);
    expect(erro({ ...ENTRADA, uf: 'XX' })).toMatch(/uf/);
    expect(erro({ ...ENTRADA, sindico: { nome: 'Fulano', login: 'a b' } })).toMatch(/sindico\.login/);
    expect(erro({ ...ENTRADA, estrutura: { ...ENTRADA.estrutura, ausentes: ['9-99'] } })).toMatch(/ausente "9-99" não existe/);
    expect(erro({ ...ENTRADA, estrutura: { ...ENTRADA.estrutura, agrupamento: 'Quadra' } })).toMatch(/agrupamento/);
    expect(erro({ ...ENTRADA, senha: 'x' })).toMatch(/senha|Unrecognized/i);
    expect(erro({ ...ENTRADA, areasComuns: ['Piscina', 'piscina'] })).toMatch(/repetida/);
    expect(() => lerEntrada('{nao json')).toThrow(/JSON/);
  });

  it('lista explícita: alternativa à estrutura (exatamente uma), agrupamento próprio, normalizada e ordenada; CLI lê igual', () => {
    const { estrutura: _e, ...base } = ENTRADA;
    const lista = { ...base, agrupamento: 'Bloco', unidades: [{ bloco: 'b', numero: '1201' }, { bloco: ' A ', numero: '32' }, { bloco: 'A', numero: '03' }] };
    const e = validarEntrada(lista);
    expect(e.agrupamento).toBe('Bloco');
    expect(e.unidades).toEqual([{ bloco: 'A', numero: '03' }, { bloco: 'A', numero: '32' }, { bloco: 'B', numero: '1201' }]);
    expect(lerEntrada(JSON.stringify(lista))).toEqual(e);
    // A grade vira a mesma forma (unidades resolvidas), com o agrupamento dela.
    const g = validarEntrada(ENTRADA);
    expect([g.agrupamento, g.unidades.length]).toEqual(['Torre', UNIDADES]);
    expect(validarEntrada({ ...ENTRADA, agrupamento: 'Torre' }).unidades).toEqual(g.unidades);
    const erro = (x: unknown) => { try { validarEntrada(x); return ''; } catch (err) { expect(err).toBeInstanceOf(ErroProvisionamento); return (err as Error).message; } };
    expect(erro({ ...lista, estrutura: ENTRADA.estrutura })).toMatch(/exatamente um/);
    expect(erro(base)).toMatch(/exatamente um/);
    expect(erro({ ...lista, agrupamento: undefined })).toMatch(/agrupamento: obrigatório/);
    expect(erro({ ...ENTRADA, agrupamento: 'Bloco' })).toMatch(/agrupamento: diferente/);
    expect(erro({ ...lista, unidades: [{ bloco: 'A', numero: '03' }, { bloco: 'a', numero: '03' }] })).toMatch(/unidades\.1: unidade repetida: A-03/);
    expect(erro({ ...lista, unidades: [{ bloco: 'A', numero: '3' }] })).toMatch(/unidades\.0\.numero/);
    expect(erro({ ...lista, unidades: [{ bloco: 'A-1', numero: '03' }] })).toMatch(/unidades\.0\.bloco/);
    expect(erro({ ...lista, unidades: [{ bloco: 'A', numero: '03', andar: 0 }] })).toMatch(/unidades\.0/);
  });

  it('argumentos e ambiente: role e banco de cada URL conferidos; mensagem sem valor', () => {
    expect(lerArgs([])).toEqual({ arquivo: null, opcoes: {} });
    expect(lerArgs(['--entrada', 'x.json', '--nova-senha-sindico'])).toEqual({ arquivo: 'x.json', opcoes: { novaSenhaSindico: true } });
    expect(() => lerArgs(['--codigo', 'x'])).toThrow(/uso/);
    const env = {
      DATABASE_URL_PROVISIONADOR: 'postgres://app_provisionador:s1@db:5432/postgres',
      MIGRATOR_URL_BASE: 'postgres://app_migrator:s2@db:5432',
      DATABASE_URL: 'postgres://app_rw:s3@db:5432/portaria',
      DATABASE_URL_PLATAFORMA: 'postgres://app_plataforma:s4@db:5432/plataforma',
      PORTARIA_CHAVE_MESTRA: Buffer.alloc(32, 1).toString('base64'),
      PORTARIA_CHAVE_MESTRA_VERSAO: '1',
    };
    expect(lerAmbiente(env).rwBase).toBe(env.DATABASE_URL);
    const recusa = (k: keyof typeof env, v: string) => { try { lerAmbiente({ ...env, [k]: v }); return ''; } catch (e) { expect(e).toBeInstanceOf(ErroChave); return (e as Error).message; } };
    expect(recusa('DATABASE_URL_PROVISIONADOR', 'postgres://app_migrator:s@db:5432/postgres')).toMatch(/app_provisionador/);
    expect(recusa('DATABASE_URL_PROVISIONADOR', 'postgres://app_provisionador:s@db:5432/portaria')).toMatch(/banco postgres/);
    expect(recusa('DATABASE_URL_PLATAFORMA', 'postgres://app_plataforma:s@db:5432/portaria')).toMatch(/banco plataforma/);
    expect(recusa('DATABASE_URL', 'postgres://app_rw:@db:5432/portaria')).toMatch(/sem senha/);
    expect(recusa('MIGRATOR_URL_BASE', '')).toMatch(/não definida/);
    expect(recusa('DATABASE_URL', 'postgres://app_rw:s3@db:5432/portaria')).toBe('');
    for (const m of [recusa('DATABASE_URL_PROVISIONADOR', 'postgres://app_migrator:segredo@db:5432/postgres')]) expect(m).not.toContain('segredo');
  });

  it('listas da plataforma = listas do domain, e a migração 0002 usa as mesmas', () => {
    expect([...sp.MODULOS_PLATAFORMA]).toEqual([...MODULOS]);
    expect([...sp.UFS_PLATAFORMA]).toEqual([...UFS]);
    const sql = readFileSync(fileURLToPath(new URL('../drizzle-plataforma/0002_cadastro_modulos.sql', import.meta.url)), 'utf8');
    const lista = `ARRAY[${MODULOS.map((m) => `'${m}'`).join(', ')}]::text[]`;
    expect(sql.split(lista).length - 1).toBe(2); // default e CHECK
  });
});

describe('provisionamento de ponta a ponta (PGlite)', () => {
  let senha = '';
  let id = '';
  let banco = '';

  it('cria plataforma, banco, migrações, chaves, estrutura e síndico; só então fica ativo', async () => {
    const r = await comoPlataforma(() => provisionar(portas(), validarEntrada(ENTRADA)));
    expect(r.situacao).toBe('provisionado');
    expect(r.banco).toMatch(/^portaria_[a-z0-9]{8}$/);
    expect(r.unidades).toBe(UNIDADES);
    expect(r.migracoes).toBe(journal.entries.length);
    expect(r.modulos).toEqual([...MODULOS]);
    expect(r.chaves.map((c) => [c.tipo, c.versao])).toEqual([['hmac_cpf', 1], ['kek_documentos', 1]]);
    expect(JSON.stringify(r)).not.toMatch(/chaveCifrada|nonce/);
    expect(r.sindico?.login).toBe('sindica.exemplo');
    senha = r.sindico!.senhaTemporaria;
    ({ condominioId: id, banco } = r);

    const c = await statusDe(ENTRADA.codigo);
    expect(c).toMatchObject({ status: 'ativo', banco, cidade: 'Campinas', uf: 'SP', plano: 'padrao' });
    const aud = await api.plataforma.db.select().from(sp.plataformaAudit).where(eq(sp.plataformaAudit.condominioId, id));
    expect(aud.map((a) => a.acao)).toEqual(['condominio.provisionar']);
    expect(JSON.stringify(aud[0]!.detalhes)).not.toMatch(/sindica|Síndica/); // nada de pessoa na trilha da plataforma

    const db = cluster.clientes.get(banco)!;
    const trilha = (await db.query<{ acao: string; usuario_nome: string; usuario_id: string | null }>('select acao, usuario_nome, usuario_id from audit_log order by seq')).rows;
    expect(trilha.map((t) => t.acao)).toEqual(['condominio.provisionar', 'usuario.criar']);
    expect(trilha.every((t) => t.usuario_nome === NOME_PROVISIONAMENTO && t.usuario_id === null)).toBe(true);
    const u = (await db.query<{ deve_trocar_senha: boolean; papel: string; senha_hash: string }>('select deve_trocar_senha, papel, senha_hash from usuario_sistema')).rows;
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ deve_trocar_senha: true, papel: 'sindico' });
    expect(u[0]!.senha_hash).not.toContain(senha);
    const cab = (await db.query<{ ultimo_seq: string }>('select ultimo_seq from evento_acesso_cadeia')).rows;
    expect(cab).toEqual([{ ultimo_seq: 0 }]);
  });

  it('o síndico entra pelo código, troca a senha obrigatória e vê a estrutura do PRÓPRIO banco (Torre, 11 unidades)', async () => {
    cacheVencido();
    const r = await login(ENTRADA.codigo, 'sindica.exemplo', senha);
    expect(r.status).toBe(200);
    expect(r.body.data.usuario.deveTrocarSenha).toBe(true);
    expect(r.body.data.condominio).toEqual({ codigo: ENTRADA.codigo, nome: ENTRADA.nome });
    const cookie = cookieDe(r.headers['set-cookie']);
    expect(cookie).toContain(`v2.${id}.`);
    expect((await api.http().get(`${V1}/catalogo`).set('Cookie', cookie)).status).toBe(403); // troca pendente
    const t = await api.http().post(`${V1}/auth/trocar-senha`).set('Cookie', cookie).send({ senhaAtual: senha, novaSenha: SENHA });
    expect(t.status).toBe(200);
    const c2 = cookieDe((await login(ENTRADA.codigo, 'sindica.exemplo', SENHA)).headers['set-cookie']);
    const cat = await api.http().get(`${V1}/catalogo`).set('Cookie', c2);
    expect(cat.status).toBe(200);
    expect(cat.body.data.agrupamento).toBe('Torre');
    expect(cat.body.data.unidades).toHaveLength(UNIDADES);
    expect(cat.body.data.unidades[0].rotulo).toBe('Torre 1 · AP 02');
    expect(cat.body.data.areasComuns.map((a: { nome: string }) => a.nome).sort()).toEqual(['Churrasqueira', 'Salão de festas']);

    // O piloto continua com a estrutura e o agrupamento de antes (sem linha em `configuracao`).
    const piloto = cookieDe((await login(null, 'carlos.andrade', SENHA)).headers['set-cookie']);
    const catPiloto = await api.http().get(`${V1}/catalogo`).set('Cookie', piloto);
    expect(catPiloto.body.data.agrupamento).toBe('Bloco');
    expect(catPiloto.body.data.unidades.length).not.toBe(UNIDADES);
  });

  it('isolamento contra o piloto: login cruzado não entra, cookie com prefixo trocado não autentica', async () => {
    expect((await login(null, 'sindica.exemplo', SENHA)).status).toBe(401); // sem código = piloto
    expect((await login('piloto', 'sindica.exemplo', SENHA)).status).toBe(401);
    expect((await login(ENTRADA.codigo, 'carlos.andrade', SENHA)).status).toBe(401);
    const c = cookieDe((await login(ENTRADA.codigo, 'sindica.exemplo', SENHA)).headers['set-cookie']);
    const trocado = c.replace(`v2.${id}.`, `v2.${api.pilotoId}.`);
    expect((await api.http().get(`${V1}/auth/me`).set('Cookie', trocado)).status).toBe(401);
    // Nenhuma linha do condomínio novo foi parar no piloto.
    expect((await api.db.select().from(s.usuarioSistema).where(eq(s.usuarioSistema.login, 'sindica.exemplo')))).toHaveLength(0);
    expect((await api.db.select().from(s.configuracao))).toHaveLength(0);
  });

  it('idempotente: rodar de novo com a mesma entrada não muda nada e não gera senha', async () => {
    const antes = (await cluster.clientes.get(banco)!.query('select count(*)::int as n from audit_log')).rows;
    const r = await comoPlataforma(() => provisionar(portas(), validarEntrada(ENTRADA)));
    expect(r.situacao).toBe('ja_provisionado');
    expect(r.sindico).toBeUndefined();
    expect(r.condominioId).toBe(id);
    expect((await cluster.clientes.get(banco)!.query('select count(*)::int as n from audit_log')).rows).toEqual(antes);
    expect(await api.plataforma.db.select().from(sp.condominioChave).where(eq(sp.condominioChave.condominioId, id))).toHaveLength(2);
  });

  it('recusa: entrada divergente para o mesmo código; nova senha para síndico que já entrou', async () => {
    await expect(comoPlataforma(() => provisionar(portas(), validarEntrada({ ...ENTRADA, nome: 'Outro nome' })))).rejects.toThrow(/outro nome/);
    await expect(comoPlataforma(() => provisionar(portas(), validarEntrada(ENTRADA), { novaSenhaSindico: true }))).rejects.toThrow(/já entrou/);
  });
});

describe('retomada depois de falha no meio', () => {
  const ENTRADA2 = { ...ENTRADA, codigo: 'vila-sul', nome: 'Condomínio Vila Sul', estrutura: { agrupamento: 'Bloco', blocos: ['A'], andares: [1], finais: [1, 2], ausentes: [] }, sindico: { nome: 'Síndico Dois', login: 'sindico.dois' } };

  it('falha na verificação: fica provisionando (API não atende); a 2a execução conclui e a senha da 1a não vale', async () => {
    cluster.falharConexoes = 1;
    const p = portas();
    await expect(comoPlataforma(() => provisionar(p, validarEntrada(ENTRADA2)))).rejects.toThrow(/falha simulada/);
    const c = await statusDe('vila-sul');
    expect(c?.status).toBe('provisionando');
    // Dados já gravados (transação do passo 4 concluiu) com a senha 1, que nunca foi entregue.
    const senha1 = 'temp-senha-0001-xyzw';
    expect((await login('vila-sul', 'sindico.dois', senha1)).status).toBe(401); // provisionando: código não resolve

    const r = await comoPlataforma(() => provisionar(p, validarEntrada(ENTRADA2)));
    expect(r.situacao).toBe('retomado');
    expect(r.banco).toBe(c!.banco);
    expect(r.sindico!.senhaTemporaria).not.toBe(senha1);
    const trilha = (await cluster.clientes.get(r.banco)!.query<{ acao: string }>('select acao from audit_log order by seq')).rows.map((x) => x.acao);
    expect(trilha).toEqual(['condominio.provisionar', 'usuario.criar', 'usuario.redefinir_senha']);
    expect(await api.plataforma.db.select().from(sp.condominioChave).where(eq(sp.condominioChave.condominioId, r.condominioId))).toHaveLength(2);

    cacheVencido(); // o status `ativo` vale para a API depois da renovação do cache (até 1 min)
    expect((await login('vila-sul', 'sindico.dois', senha1)).status).toBe(401);
    expect((await login('vila-sul', 'sindico.dois', r.sindico!.senhaTemporaria)).status).toBe(200);
  });

  it('nova senha do síndico em condomínio ativo, só enquanto ele nunca entrou (a de 72 h venceu antes do uso)', async () => {
    const E3 = { ...ENTRADA2, codigo: 'tres', nome: 'Condomínio Três', sindico: { nome: 'Síndico Três', login: 'sindico.tres' } };
    const p = portas();
    const r1 = await comoPlataforma(() => provisionar(p, validarEntrada(E3)));
    const r2 = await comoPlataforma(() => provisionar(p, validarEntrada(E3), { novaSenhaSindico: true }));
    expect(r2.situacao).toBe('nova_senha_sindico');
    expect(r2.sindico!.senhaTemporaria).not.toBe(r1.sindico!.senhaTemporaria);
    cacheVencido();
    expect((await login('tres', 'sindico.tres', r1.sindico!.senhaTemporaria)).status).toBe(401);
    expect((await login('tres', 'sindico.tres', r2.sindico!.senhaTemporaria)).status).toBe(200);
    // Entrou: a senha passa a ser dele.
    await expect(comoPlataforma(() => provisionar(p, validarEntrada(E3), { novaSenhaSindico: true }))).rejects.toThrow(/já entrou/);
    // Em condomínio provisionando a opção não vale (lá a retomada já regenera).
    await expect(comoPlataforma(() => provisionar(p, validarEntrada({ ...E3, codigo: 'quatro', nome: 'Quatro' }), { novaSenhaSindico: true }))).rejects.toThrow(/só vale para condomínio já ativo/);
  });

  it('retomada com lista explícita: mesma lista (em outra ordem) conclui; lista diferente é recusada sem mexer', async () => {
    const { estrutura: _e, ...base } = ENTRADA;
    const L = { ...base, codigo: 'lista-sul', nome: 'Lista Sul', agrupamento: 'Bloco', sindico: { nome: 'Síndico Lista', login: 'sindico.lista' },
      unidades: [{ bloco: 'A', numero: '101' }, { bloco: 'A', numero: '102' }, { bloco: 'B', numero: '01' }] };
    cluster.falharConexoes = 1;
    const p = portas();
    await expect(comoPlataforma(() => provisionar(p, validarEntrada(L)))).rejects.toThrow(/falha simulada/);
    expect((await statusDe('lista-sul'))?.status).toBe('provisionando');
    await expect(comoPlataforma(() => provisionar(p, validarEntrada({ ...L, unidades: [...L.unidades, { bloco: 'C', numero: '01' }] }))))
      .rejects.toThrow(/outra estrutura de unidades \(faltam C-01; sobram nenhuma\)/);
    const r = await comoPlataforma(() => provisionar(p, validarEntrada({ ...L, unidades: [...L.unidades].reverse() })));
    expect([r.situacao, r.unidades]).toEqual(['retomado', 3]);
    const db = cluster.clientes.get(r.banco)!;
    const aud = (await db.query<{ depois: { blocos: string[]; unidades: number } }>("select depois from audit_log where acao = 'condominio.provisionar'")).rows;
    expect(aud.map((a) => a.depois)).toMatchObject([{ blocos: ['A', 'B'], unidades: 3 }]);
  });

  it('banco que já existe com outro dono: recusa sem tocar nele', async () => {
    const outro: Cluster = { ...cluster, donoDoBanco: async () => 'postgres', criarBanco: cluster.criarBanco.bind(cluster), restringirConexao: cluster.restringirConexao.bind(cluster), conexoes: cluster.conexoes.bind(cluster) };
    await expect(comoPlataforma(() => provisionar(portas({ cluster: outro }), validarEntrada({ ...ENTRADA2, codigo: 'alheio', nome: 'Alheio' }))))
      .rejects.toThrow(/outro dono/);
    expect((await statusDe('alheio'))?.status).toBe('provisionando');
  });
});
