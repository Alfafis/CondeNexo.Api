// Rotação das chaves (src/plataforma/rotacao-chaves.ts, CLI src/cli/rotacionar-chaves.ts, runbook
// docs/deploy-rotacao-chaves.md). Dois condomínios com bancos distintos, como em produção: `parque` (piloto, banco
// `portaria`) e `aguas-rasas` (banco `portaria_ts864rv9`), cada um com HMAC e KEK próprias, todas embrulhadas pela mestra
// v1. Todas as chaves são geradas aqui (randomBytes) e o último bloco confere que nenhuma aparece em resultado, mensagem
// de erro ou log, em base64, hex ou bytes.
//
// "API" nos testes = o ResolvedorCondominio de verdade (o boot: onModuleInit -> desembrulha e confere, log saas.boot) e o
// CofreDocumentos de verdade sobre o condomínio que ele resolve. Um resolvedor novo = um reinício da API.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lerAmbiente, lerArgs, executar, ErroUso, type Comando } from '../src/cli/rotacionar-chaves';
import type { Config } from '../src/config/config';
import type { Db } from '../src/database/database.module';
import * as s from '../src/db/schema';
import { CofreDocumentos } from '../src/documentos/cofre';
import { type ChaveMestra, desembrulhar, embrulhar } from '../src/plataforma/chave-mestra';
import type { DbPlataforma } from '../src/plataforma/registrar-piloto';
import { ErroRotacao, inspecionar, migrarDocumentos, prepararKek, rotacionarMestra } from '../src/plataforma/rotacao-chaves';
import * as sp from '../src/plataforma/schema-plataforma';
import { cifrarSegredoTotp, decifrarSegredoTotp } from '../src/plataforma/segredo-totp';
import { codigoTotp, gerarSegredoTotp, passoDe, verificarTotp } from '../src/plataforma/totp';
import type { CondominioResolvido } from '../src/tenancy/condominio';
import { ResolvedorCondominio } from '../src/tenancy/resolvedor';
import { configDeTeste } from './helpers/app';
import { novoBanco } from './helpers/banco';
import { comoAppPlataforma, novoBancoPlataforma } from './helpers/plataforma';
import { registrarCondominio, RegistroDeTeste } from './helpers/saas';

// ----- chaves fictícias, geradas no teste -------------------------------------------------------------------------
const MESTRA_V1: ChaveMestra = { chave: randomBytes(32), versao: 1 };
const MESTRA_V2: ChaveMestra = { chave: randomBytes(32), versao: 2 };
const PARQUE = { codigo: 'parque', banco: 'portaria', hmac: randomBytes(32), kek: randomBytes(32) };
const AGUAS = { codigo: 'aguas-rasas', banco: 'portaria_ts864rv9', hmac: randomBytes(32), kek: randomBytes(32) };
/** Toda chave que existiu no teste (as KEKs novas entram quando o teste as lê da plataforma). */
const SEGREDOS: Buffer[] = [MESTRA_V1.chave, MESTRA_V2.chave, PARQUE.hmac, PARQUE.kek, AGUAS.hmac, AGUAS.kek];
/** Tudo que saiu para fora: resultados, mensagens de erro, logs. O último teste procura as chaves aqui. */
const SAIDAS: string[] = [];
const copia = (m: ChaveMestra): ChaveMestra => ({ chave: Buffer.from(m.chave), versao: m.versao });

const capturar = (...a: unknown[]) => { SAIDAS.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
vi.spyOn(console, 'log').mockImplementation(capturar);
vi.spyOn(console, 'error').mockImplementation(capturar);
vi.spyOn(console, 'warn').mockImplementation(capturar);

interface Cenario {
  plat: Awaited<ReturnType<typeof novoBancoPlataforma>>;
  dbPlat: DbPlataforma;
  parque: Awaited<ReturnType<typeof novoBanco>> & { id: string };
  aguas: Awaited<ReturnType<typeof novoBanco>> & { id: string };
  registro: RegistroDeTeste;
  bancoDe: (banco: string) => Db;
  dir: string;
  fechar: () => Promise<void>;
}

let seq = 0;
const abertos: Cenario[] = [];
afterAll(async () => { for (const c of abertos) await c.fechar(); });

async function cenario(): Promise<Cenario> {
  const plat = await novoBancoPlataforma();
  const dbPlat = plat.db as unknown as DbPlataforma;
  const bp = await novoBanco();
  const ba = await novoBanco();
  const parque = { ...bp, id: await registrarCondominio(dbPlat, PARQUE, copia(MESTRA_V1)) };
  const aguas = { ...ba, id: await registrarCondominio(dbPlat, AGUAS, copia(MESTRA_V1)) };
  const bancos = new Map<string, Db>([[PARQUE.banco, bp.db as unknown as Db], [AGUAS.banco, ba.db as unknown as Db]]);
  const registro = new RegistroDeTeste(bancos);
  const c: Cenario = {
    plat, dbPlat, parque, aguas, registro, bancoDe: (b) => registro.db(b), dir: join(tmpdir(), `rotacao-${process.pid}-${++seq}`),
    fechar: async () => { await plat.client.close(); await bp.client.close(); await ba.client.close(); },
  };
  abertos.push(c);
  return c;
}

const configCom = (c: Cenario, amb: Config['saas']['chavesAmbiente'] = { hmacCpf: null, kek: null, kekVersao: null }): Config =>
  configDeTeste({ documentos: { dir: c.dir }, saas: { pilotoPadrao: true, chavesAmbiente: amb } });

/** "Sobe a API": resolvedor de verdade + boot. Lança se o boot recusar. */
async function subirApi(c: Cenario, mestra: ChaveMestra, amb?: Config['saas']['chavesAmbiente']) {
  const config = configCom(c, amb);
  const r = new ResolvedorCondominio(c.dbPlat, copia(mestra), config, c.registro);
  await r.onModuleInit();
  const resolvido = async (id: string): Promise<CondominioResolvido> => (await r.porIdDoCookie(id))!.condominio;
  const cofre = async (id: string) => new CofreDocumentos(config, await resolvido(id));
  return { r, resolvido, cofre, config };
}
type Api = Awaited<ReturnType<typeof subirApi>>;

/** Anexo gravado pela API (cofre de verdade, KEK ativa da API) + a linha de `documento`. */
async function novoAnexo(api: Api, c: Cenario, qual: 'parque' | 'aguas', conteudo: Buffer) {
  const b = c[qual];
  const g = await (await api.cofre(b.id)).guardar(conteudo);
  await b.db.insert(s.documento).values({
    id: g.id, tipo: 'anexo_ocorrencia', caminhoStorage: g.caminhoStorage, dekCifrada: g.dekCifrada, nonce: g.nonce, chaveVersao: g.chaveVersao,
    sha256Conteudo: g.sha256Conteudo, mime: 'application/octet-stream', tamanhoBytes: g.tamanhoBytes, enviadoPorId: b.fx.porteiro.id,
  });
  return g.id;
}

/** Lê TODOS os anexos do condomínio pela "API" e confere o conteúdo esperado. */
async function lerTodos(api: Api, c: Cenario, qual: 'parque' | 'aguas', esperado: Map<string, Buffer>) {
  const cofre = await api.cofre(c[qual].id);
  const docs = await c[qual].db.select().from(s.documento);
  expect(docs.length).toBe(esperado.size);
  for (const d of docs) expect((await cofre.ler(d)).equals(esperado.get(d.id)!)).toBe(true);
  return docs;
}

const versoesDocs = async (db: Db | Cenario['parque']['db']) =>
  (await (db as Db).select({ v: s.documento.chaveVersao }).from(s.documento)).map((x) => x.v).sort();

/** Foto da plataforma (linhas de chave e trilha) para provar "nada mudou". O cifrado não é a chave. */
async function fotoPlataforma(c: Cenario) {
  const linhas = await c.dbPlat.select().from(sp.condominioChave)
    .orderBy(asc(sp.condominioChave.condominioId), asc(sp.condominioChave.tipo), asc(sp.condominioChave.versao));
  const audit = await c.dbPlat.select().from(sp.plataformaAudit);
  return JSON.stringify({ linhas: linhas.map((l) => ({ ...l, chaveCifrada: Buffer.from(l.chaveCifrada).toString('hex'), nonce: Buffer.from(l.nonce).toString('hex') })), audit: audit.length });
}
async function fotoDocs(c: Cenario) {
  const f = async (db: Cenario['parque']['db']) => (await db.select().from(s.documento).orderBy(asc(s.documento.id)))
    .map((d) => `${d.id}:${d.chaveVersao}:${Buffer.from(d.dekCifrada).toString('hex')}`);
  return JSON.stringify([await f(c.parque.db), await f(c.aguas.db)]);
}

const anotar = <T>(x: T): T => { SAIDAS.push(JSON.stringify(x)); return x; };
async function falha(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { SAIDAS.push(String((e as Error).message)); return e as Error; }
  throw new Error('esperava falha');
}

/** Chave em claro do condomínio, lida da plataforma (para conferir ida e volta e registrar em SEGREDOS). */
async function claro(c: Cenario, condominioId: string, tipo: sp.TipoChave, versao: number, mestra: ChaveMestra) {
  const linha = (await c.dbPlat.select().from(sp.condominioChave).where(eq(sp.condominioChave.condominioId, condominioId)))
    .find((x) => x.tipo === tipo && x.versao === versao);
  const k = desembrulhar(mestra, { condominioId, tipo, versao }, linha!);
  SEGREDOS.push(Buffer.from(k));
  return k;
}

// =================================================================================================================
describe('dry-run (padrão): só lê', () => {
  let c: Cenario;
  beforeEach(async () => { c = await cenario(); });

  it('lerArgs: sem argumento é dry-run; flags desconhecidas, chave por argumento e modos juntos são erro de uso', () => {
    expect(lerArgs([])).toEqual({ modo: 'dry-run' });
    expect(lerArgs(['--dry-run'])).toEqual({ modo: 'dry-run' });
    expect(lerArgs(['--kek-preparar', '--condominio', 'parque', '--kek-versao-atual', '1'])).toEqual({ modo: 'kek-preparar', codigo: 'parque', versaoAtual: 1 });
    expect(lerArgs(['--kek-migrar', '--condominio', 'parque', '--lote', '50'])).toEqual({ modo: 'kek-migrar', codigo: 'parque', lote: 50 });
    for (const argv of [['--mestra', '--dry-run'], ['--chave', 'x'], ['--mestra', '--condominio', 'parque'], ['--kek-preparar', '--condominio', 'parque'],
      ['--kek-migrar'], ['--kek-preparar', '--condominio', 'parque', '--kek-versao-atual', 'um'], ['--dry-run', '--lote', '5']]) {
      expect(() => lerArgs(argv), argv.join(' ')).toThrow(ErroUso);
    }
  });

  it('relata as 4 linhas e os anexos dos dois bancos, código 0, e não escreve em nenhum banco', async () => {
    const api = await subirApi(c, MESTRA_V1);
    for (let i = 0; i < 3; i++) await novoAnexo(api, c, 'parque', randomBytes(64));
    await novoAnexo(api, c, 'aguas', randomBytes(64));
    const antes = [await fotoPlataforma(c), await fotoDocs(c)];
    const s0 = anotar(await executar({ modo: 'dry-run' }, { mestra: copia(MESTRA_V1), nova: copia(MESTRA_V2) }, { plataforma: c.dbPlat, bancoDe: c.bancoDe }));
    expect(s0.codigo).toBe(0);
    const r = s0.resultado as Awaited<ReturnType<typeof inspecionar>>;
    expect(r).toMatchObject({ linhas: 4, porMestraVersao: { 1: 4 }, linhasQueNaoAbrem: 0, falhas: 0, mestraNova: { versao: 2, situacao: 'a_rotacionar', linhasAReembrulhar: 4 } });
    expect(r.porTipoVersao).toEqual({ 'hmac_cpf:v1:ativa': 2, 'kek_documentos:v1:ativa': 2 });
    expect(r.condominios.map((x) => [x.codigo, x.documentos?.total, x.documentos?.porVersao])).toEqual([['aguas-rasas', 1, { 1: 1 }], ['parque', 3, { 1: 3 }]]);
    expect([await fotoPlataforma(c), await fotoDocs(c)]).toEqual(antes);
  });

  it('mestra errada: código 1, todas as linhas contadas como falha, nada escrito', async () => {
    const antes = await fotoPlataforma(c);
    const s1 = anotar(await executar({ modo: 'dry-run' }, { mestra: { chave: randomBytes(32), versao: 1 }, nova: null }, { plataforma: c.dbPlat, bancoDe: c.bancoDe }));
    expect(s1.codigo).toBe(1);
    expect(s1.resultado).toMatchObject({ linhasQueNaoAbrem: 4, falhas: 4 });
    expect(await fotoPlataforma(c)).toBe(antes);
  });

  it('anexo com DEK adulterada ou de versão sem KEK: código 1', async () => {
    const api = await subirApi(c, MESTRA_V1);
    const id = await novoAnexo(api, c, 'aguas', randomBytes(64));
    await c.aguas.db.update(s.documento).set({ chaveVersao: 9 }).where(eq(s.documento.id, id));
    const s1 = anotar(await executar({ modo: 'dry-run' }, { mestra: copia(MESTRA_V1), nova: null }, { plataforma: c.dbPlat, bancoDe: c.bancoDe }));
    expect(s1.codigo).toBe(1);
    expect((s1.resultado as Awaited<ReturnType<typeof inspecionar>>).condominios.find((x) => x.codigo === 'aguas-rasas')!.documentos).toMatchObject({ semChave: 1 });
  });
});

// =================================================================================================================
describe('rotação da mestra', () => {
  let c: Cenario;
  beforeEach(async () => { c = await cenario(); });

  it('feliz: as 4 linhas na v2, nonce novo, ida e volta, trilha; a API sobe com a v2 e recusa a v1', async () => {
    const antes = await c.dbPlat.select().from(sp.condominioChave);
    const r = anotar(await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2)));
    expect(r).toMatchObject({ situacao: 'rotacionada', mestraVersaoAnterior: 1, mestraVersao: 2, linhas: 4 });
    const depois = await c.dbPlat.select().from(sp.condominioChave);
    expect(depois.every((l) => l.mestraVersao === 2)).toBe(true);
    for (const l of depois) {
      const o = antes.find((x) => x.condominioId === l.condominioId && x.tipo === l.tipo && x.versao === l.versao)!;
      expect(Buffer.from(l.nonce).equals(Buffer.from(o.nonce))).toBe(false);
      expect([l.ativa, l.criadaEm.getTime()]).toEqual([o.ativa, o.criadaEm.getTime()]);
      const esperado = { [c.parque.id]: PARQUE, [c.aguas.id]: AGUAS }[l.condominioId]![l.tipo === 'hmac_cpf' ? 'hmac' : 'kek'];
      expect(desembrulhar(MESTRA_V2, { condominioId: l.condominioId, tipo: l.tipo as sp.TipoChave, versao: l.versao }, l).equals(esperado)).toBe(true);
    }
    expect((await c.dbPlat.select().from(sp.plataformaAudit)).map((a) => a.acao)).toContain('plataforma.mestraRotacionada');

    const api = await subirApi(c, MESTRA_V2);
    expect((await api.resolvido(c.parque.id)).chaves.hmacCpf.equals(PARQUE.hmac)).toBe(true);
    expect(SAIDAS.some((x) => x.includes('saas.boot') && x.includes('condominios=2'))).toBe(true);
    expect((await falha(subirApi(c, MESTRA_V1))).message).toMatch(/mestra v2, mas o ambiente tem a v1/);
    // A mestra antiga declarada como v2 (alguém trocou só o número): o GCM recusa.
    expect((await falha(subirApi(c, { chave: MESTRA_V1.chave, versao: 2 }))).message).toMatch(/não autenticou/);
  });

  it('mestra atual errada: falha sem escrever nada', async () => {
    const antes = await fotoPlataforma(c);
    await falha(rotacionarMestra(c.dbPlat, { chave: randomBytes(32), versao: 1 }, copia(MESTRA_V2)));
    expect(await fotoPlataforma(c)).toBe(antes);
  });

  it('falha injetada no meio (3ª linha): ROLLBACK total, nenhuma linha muda, nem a trilha', async () => {
    const antes = await fotoPlataforma(c);
    const e = await falha(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2), {
      aposReembrulhar: (i) => { if (i === 2) throw new Error('queda simulada'); },
    }));
    expect(e.message).toBe('queda simulada');
    expect(await fotoPlataforma(c)).toBe(antes);
    await subirApi(c, MESTRA_V1); // a API de antes continua subindo
  });

  it('reentrante: de novo responde ja_rotacionada sem escrever; "nova" errada com a mesma versão é recusada', async () => {
    await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2));
    const antes = await fotoPlataforma(c);
    expect(anotar(await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2)))).toMatchObject({ situacao: 'ja_rotacionada', linhas: 4 });
    expect(await fotoPlataforma(c)).toBe(antes);
    await falha(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), { chave: randomBytes(32), versao: 2 }));
    expect(await fotoPlataforma(c)).toBe(antes);
    // Rollback do runbook: voltar ao valor antigo como v3 (o trigger só aceita versão maior).
    const v3 = { chave: Buffer.from(MESTRA_V1.chave), versao: 3 };
    expect(await rotacionarMestra(c.dbPlat, copia(MESTRA_V2), v3)).toMatchObject({ situacao: 'rotacionada', mestraVersao: 3 });
    await subirApi(c, v3);
    // E o trigger recusa voltar a versão (mesmo como dono), sem passar pela checagem da CLI.
    const [l] = await c.dbPlat.select().from(sp.condominioChave).limit(1);
    await expect(c.dbPlat.update(sp.condominioChave).set({ mestraVersao: 1 })
      .where(and(eq(sp.condominioChave.condominioId, l!.condominioId), eq(sp.condominioChave.tipo, l!.tipo)))).rejects.toThrow();
  });

  it('estado misto (linha nova embrulhada pela mestra antiga depois da rotação): recusa clara, nada escrito', async () => {
    await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2));
    // O que um provisionador não reiniciado faria: condomínio novo com a mestra v1.
    const [n] = await c.dbPlat.insert(sp.condominio).values({ codigo: 'novo-cond', nome: 'Novo', banco: 'portaria_novo0001', status: 'provisionando', plano: 'teste' }).returning();
    await c.dbPlat.insert(sp.condominioChave).values({ condominioId: n!.id, tipo: 'hmac_cpf', versao: 1, ativa: true, ...embrulhar(MESTRA_V1, { condominioId: n!.id, tipo: 'hmac_cpf', versao: 1 }, randomBytes(32)) });
    const antes = await fotoPlataforma(c);
    expect((await falha(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2)))).message).toMatch(/estado misto em condominio_chave \(v1: 1, v2: 4\)/);
    expect(await fotoPlataforma(c)).toBe(antes);
  });

  it('versão nova não maior que a atual, ou chave nova igual à atual: recusa antes de abrir transação', async () => {
    await expect(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), { chave: MESTRA_V2.chave, versao: 1 })).rejects.toThrow(ErroRotacao);
    await expect(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), { chave: MESTRA_V1.chave, versao: 2 })).rejects.toThrow(/igual/);
  });

  it('privilégio: app_plataforma não consegue re-embrulhar (UPDATE só em `ativa`); nada muda', async () => {
    const antes = await fotoPlataforma(c);
    const e = await falha(comoAppPlataforma(c.plat.client, () => rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2))));
    expect(String((e as Error & { cause?: Error }).cause?.message ?? e.message)).toMatch(/permission denied/);
    expect(await fotoPlataforma(c)).toBe(antes);
  });
});

// =================================================================================================================
describe('rotação da KEK (os dois condomínios, cada um no seu banco)', () => {
  let c: Cenario;
  beforeEach(async () => { c = await cenario(); });

  it('sequência do runbook com queda entre lotes: todo anexo legível antes, durante e depois; v1 segue registrada (inativa)', async () => {
    // Mestra primeiro (a KEK nova não pode nascer embrulhada pela mestra que vazou).
    await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2));
    let api = await subirApi(c, MESTRA_V2);
    const conteudos = { parque: new Map<string, Buffer>(), aguas: new Map<string, Buffer>() };
    const novo = async (q: 'parque' | 'aguas') => { const b = randomBytes(100 + conteudos[q].size); conteudos[q].set(await novoAnexo(api, c, q, b), b); };
    for (let i = 0; i < 7; i++) await novo('parque');
    for (let i = 0; i < 5; i++) await novo('aguas');
    const todos = async (a: Api) => { await lerTodos(a, c, 'parque', conteudos.parque); await lerTodos(a, c, 'aguas', conteudos.aguas); };
    await todos(api);

    // Passo 1 nos dois. A API em execução (cache com a v1) segue lendo e GRAVANDO na v1: o passo 2 pega esses também.
    for (const q of [PARQUE, AGUAS]) {
      expect(anotar(await comoAppPlataforma(c.plat.client, () => prepararKek(c.dbPlat, copia(MESTRA_V2), q.codigo, 1))))
        .toMatchObject({ situacao: 'preparada', versaoAnterior: 1, versaoAtiva: 2, versoesRegistradas: [1, 2] });
    }
    await todos(api);
    await novo('parque'); // API antiga, KEK v1 em memória
    expect(await versoesDocs(c.parque.db)).toEqual(Array(8).fill(1));

    // Reinício da API: carrega v1 (inativa) e v2 (ativa); anexo novo já vai na v2.
    api = await subirApi(c, MESTRA_V2);
    expect([...(await api.resolvido(c.parque.id)).chaves.keks.keys()].sort()).toEqual([1, 2]);
    await novo('aguas');
    expect((await versoesDocs(c.aguas.db)).filter((v) => v === 2)).toHaveLength(1);
    await todos(api);

    // Passo 2 com queda simulada depois do 2º lote (lote de 3): parte na v2, parte na v1.
    const e = await falha(migrarDocumentos(c.dbPlat, c.bancoDe, copia(MESTRA_V2), 'parque', {
      lote: 3, aposLote: (l) => { if (l === 2) throw new Error('queda entre lotes'); },
    }));
    expect(e.message).toBe('queda entre lotes');
    expect(await versoesDocs(c.parque.db)).toEqual([1, 1, 2, 2, 2, 2, 2, 2]);
    await todos(api); // a API em execução lê as duas versões
    const reiniciada = await subirApi(c, MESTRA_V2); // e o boot no meio da migração passa (confere uma DEK de cada versão)
    expect(SAIDAS.at(-1)).toMatch(/deks_conferidas=4/); // uma DEK por versão com anexo: parque v1 e v2, águas v1 e v2
    await todos(reiniciada);

    // Retomada e o outro condomínio.
    // Com os papéis de produção: app_plataforma na plataforma (só leitura aqui) e app_rw no banco do condomínio.
    await c.parque.client.exec('SET ROLE app_rw');
    const retomada = await comoAppPlataforma(c.plat.client, () => migrarDocumentos(c.dbPlat, c.bancoDe, copia(MESTRA_V2), 'parque', { lote: 3 }))
      .finally(() => c.parque.client.exec('RESET ROLE'));
    expect(anotar(retomada))
      .toMatchObject({ situacao: 'migrada', migrados: 2, versaoAtiva: 2, porVersao: { 2: 8 } });
    expect(anotar(await migrarDocumentos(c.dbPlat, c.bancoDe, copia(MESTRA_V2), 'aguas-rasas', { lote: 2 })))
      .toMatchObject({ situacao: 'migrada', migrados: 5, lotes: 3, porVersao: { 2: 6 } });
    expect(anotar(await migrarDocumentos(c.dbPlat, c.bancoDe, copia(MESTRA_V2), 'aguas-rasas'))).toMatchObject({ situacao: 'nada_a_migrar', migrados: 0 });
    await todos(api);
    await todos(await subirApi(c, MESTRA_V2));

    // A KEK v1 (a que vazou) não abre mais nenhuma DEK; segue registrada, inativa; a v2 é a ativa.
    const chaves = await c.dbPlat.select().from(sp.condominioChave).where(eq(sp.condominioChave.tipo, 'kek_documentos'));
    expect(chaves.map((k) => `${k.condominioId === c.parque.id ? 'p' : 'a'}:v${k.versao}:${k.ativa}`).sort()).toEqual(['a:v1:false', 'a:v2:true', 'p:v1:false', 'p:v2:true']);
    const kekNova = await claro(c, c.parque.id, 'kek_documentos', 2, MESTRA_V2);
    expect(kekNova.equals(PARQUE.kek)).toBe(false);
    await claro(c, c.aguas.id, 'kek_documentos', 2, MESTRA_V2);
    const dry = anotar(await executar({ modo: 'dry-run' }, { mestra: copia(MESTRA_V2), nova: null }, { plataforma: c.dbPlat, bancoDe: c.bancoDe }));
    expect(dry.codigo).toBe(0);
    expect((dry.resultado as Awaited<ReturnType<typeof inspecionar>>).condominios.map((x) => x.documentos?.porVersao)).toEqual([{ 2: 6 }, { 2: 8 }]);
  });

  it('o arquivo cifrado não muda; só o envelope da DEK', async () => {
    const api = await subirApi(c, MESTRA_V1);
    const conteudo = new Map<string, Buffer>();
    for (let i = 0; i < 4; i++) { const b = randomBytes(80); conteudo.set(await novoAnexo(api, c, 'aguas', b), b); }
    const antes = await c.aguas.db.select().from(s.documento).orderBy(asc(s.documento.id));
    await prepararKek(c.dbPlat, copia(MESTRA_V1), 'aguas-rasas', 1);
    await migrarDocumentos(c.dbPlat, c.bancoDe, copia(MESTRA_V1), 'aguas-rasas', { lote: 3 });
    const depois = await c.aguas.db.select().from(s.documento).orderBy(asc(s.documento.id));
    for (const [i, d] of depois.entries()) {
      const o = antes[i]!;
      expect([d.id, d.caminhoStorage, Buffer.from(d.nonce).toString('hex'), d.sha256Conteudo, d.chaveVersao]).toEqual([o.id, o.caminhoStorage, Buffer.from(o.nonce).toString('hex'), o.sha256Conteudo, 2]);
      expect(Buffer.from(d.dekCifrada).equals(Buffer.from(o.dekCifrada))).toBe(false);
    }
    await lerTodos(await subirApi(c, MESTRA_V1), c, 'aguas', conteudo);
  });

  it('preparar é idempotente pela versão esperada; versão errada, condomínio inexistente e mestra pendente são recusados', async () => {
    await prepararKek(c.dbPlat, copia(MESTRA_V1), 'parque', 1);
    const antes = await fotoPlataforma(c);
    expect(anotar(await prepararKek(c.dbPlat, copia(MESTRA_V1), 'parque', 1))).toMatchObject({ situacao: 'ja_preparada', versaoAtiva: 2 });
    expect(await fotoPlataforma(c)).toBe(antes); // não gerou v3
    expect((await falha(prepararKek(c.dbPlat, copia(MESTRA_V1), 'aguas-rasas', 3))).message).toMatch(/ativa é a v1, não a v3/);
    expect((await falha(prepararKek(c.dbPlat, copia(MESTRA_V1), 'nao-existe', 1))).message).toMatch(/não existe/);
    // Mestra errada: nada gravado.
    await falha(prepararKek(c.dbPlat, { chave: randomBytes(32), versao: 1 }, 'aguas-rasas', 1));
    // Mestra do ambiente em outra versão (rotação da mestra feita, .env não atualizado): recusa.
    await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2));
    const depoisMestra = await fotoPlataforma(c);
    expect((await falha(prepararKek(c.dbPlat, copia(MESTRA_V1), 'aguas-rasas', 1))).message).toMatch(/outra versão da mestra/);
    expect(await fotoPlataforma(c)).toBe(depoisMestra);
    // CLI: com a mestra nova ainda no shell, nenhum modo de KEK roda.
    const env = {
      PORTARIA_CHAVE_MESTRA: MESTRA_V2.chave.toString('base64'), PORTARIA_CHAVE_MESTRA_VERSAO: '2',
      PORTARIA_CHAVE_MESTRA_NOVA: randomBytes(32).toString('base64'), PORTARIA_CHAVE_MESTRA_VERSAO_NOVA: '3',
      DATABASE_URL_PLATAFORMA: 'postgres://app_plataforma:x@db:5432/plataforma', DATABASE_URL: 'postgres://app_rw:x@db:5432/portaria',
    };
    for (const cmd of [{ modo: 'kek-preparar', codigo: 'parque', versaoAtual: 1 }, { modo: 'kek-migrar', codigo: 'parque' }] as Comando[]) {
      expect(() => lerAmbiente(cmd, env)).toThrow(/PORTARIA_CHAVE_MESTRA_NOVA ainda definida/);
    }
  });

  it('migrar: anexo numa versão sem KEK desfaz o lote inteiro (nenhuma DEK do lote muda)', async () => {
    const api = await subirApi(c, MESTRA_V1);
    for (let i = 0; i < 3; i++) await novoAnexo(api, c, 'parque', randomBytes(40));
    await prepararKek(c.dbPlat, copia(MESTRA_V1), 'parque', 1);
    const [d] = await c.parque.db.select().from(s.documento).orderBy(asc(s.documento.id)).limit(1).offset(2);
    await c.parque.db.update(s.documento).set({ chaveVersao: 7 }).where(eq(s.documento.id, d!.id));
    const antes = await fotoDocs(c);
    expect((await falha(migrarDocumentos(c.dbPlat, c.bancoDe, copia(MESTRA_V1), 'parque', { lote: 10 }))).message).toMatch(/v7, sem KEK registrada. Lote desfeito/);
    expect(await fotoDocs(c)).toBe(antes);
  });

  it('variáveis legadas do piloto: PORTARIA_KEK antiga no .env depois do passo 1 recusa o boot; ausente (ou só a HMAC) sobe', async () => {
    await prepararKek(c.dbPlat, copia(MESTRA_V1), 'parque', 1);
    expect((await falha(subirApi(c, MESTRA_V1, { hmacCpf: PARQUE.hmac, kek: PARQUE.kek, kekVersao: 1 }))).message).toMatch(/PORTARIA_KEK difere da KEK ativa do piloto/);
    expect((await falha(subirApi(c, MESTRA_V1, { hmacCpf: null, kek: null, kekVersao: 1 }))).message).toMatch(/PORTARIA_KEK_VERSAO=1, mas a KEK ativa do piloto na plataforma é a v2/);
    await subirApi(c, MESTRA_V1, { hmacCpf: null, kek: null, kekVersao: null });
    await subirApi(c, MESTRA_V1, { hmacCpf: PARQUE.hmac, kek: null, kekVersao: null });
    expect(SAIDAS.at(-1)).toMatch(/ambiente=hmac_cpf /);
  });

  it('API sem a versão de um anexo (não reiniciada): 500 CHAVE_INDISPONIVEL, nunca conteúdo; reiniciar resolve', async () => {
    const velha = await subirApi(c, MESTRA_V1);
    const conteudo = new Map<string, Buffer>();
    const b = randomBytes(50);
    conteudo.set(await novoAnexo(velha, c, 'aguas', b), b);
    await prepararKek(c.dbPlat, copia(MESTRA_V1), 'aguas-rasas', 1);
    await migrarDocumentos(c.dbPlat, c.bancoDe, copia(MESTRA_V1), 'aguas-rasas'); // fora de ordem (sem reiniciar antes)
    const [d] = await c.aguas.db.select().from(s.documento);
    await expect((await velha.cofre(c.aguas.id)).ler(d!)).rejects.toMatchObject({ status: 500 });
    await lerTodos(await subirApi(c, MESTRA_V1), c, 'aguas', conteudo);
  });
});

// =================================================================================================================
describe('segredo TOTP dos usuários da plataforma (sub-projeto C2)', () => {
  let c: Cenario;
  const ID = '0a0a0000-0000-4000-8000-00000000c2c2';
  const ID2 = '0a0a0000-0000-4000-8000-00000000c2c3';
  const ATIVO = gerarSegredoTotp();
  const PENDENTE = gerarSegredoTotp();
  SEGREDOS.push(ATIVO, PENDENTE);

  /** Master com fator ativo e enrolamento pendente, os dois cifrados pela mestra `m` (como a API grava). */
  async function comFator(id: string, email: string, m: ChaveMestra, pendente = true) {
    const a = cifrarSegredoTotp(m, id, 'ativo', ATIVO);
    const p = cifrarSegredoTotp(m, id, 'pendente', PENDENTE);
    await c.dbPlat.insert(sp.masterUsuario).values({
      id, nome: 'Master', email, senhaHash: '$argon2id$x', papel: 'master', deveTrocarSenha: false,
      totpCifrado: a.cifrado, totpMestraVersao: a.mestraVersao, totpAtivadoEm: new Date(), totpUltimoPasso: 1,
      ...(pendente ? { totpPendenteCifrado: p.cifrado, totpPendenteMestraVersao: p.mestraVersao, totpPendenteExpiraEm: new Date(Date.now() + 600_000) } : {}),
    });
  }
  const linhaDe = async (id: string) => (await c.dbPlat.select().from(sp.masterUsuario).where(eq(sp.masterUsuario.id, id)))[0]!;

  beforeEach(async () => { c = await cenario(); });

  it('dry-run conta os segredos (ativo + pendente) e diz quantos a rotação re-cifraria; segredo que não abre é falha (código 1)', async () => {
    await comFator(ID, 'c2@exemplo.test', copia(MESTRA_V1));
    const s0 = anotar(await executar({ modo: 'dry-run' }, { mestra: copia(MESTRA_V1), nova: copia(MESTRA_V2) }, { plataforma: c.dbPlat, bancoDe: c.bancoDe }));
    expect(s0.codigo).toBe(0);
    expect(s0.resultado).toMatchObject({ totp: { linhas: 2, porMestraVersao: { 1: 2 }, naoAbrem: 0 }, mestraNova: { totpARecifrar: 2 }, falhas: 0 });
    expect(s0.mensagem).toMatch(/2 segredo\(s\) TOTP/);
    const s1 = anotar(await executar({ modo: 'dry-run' }, { mestra: { chave: randomBytes(32), versao: 1 }, nova: null }, { plataforma: c.dbPlat }));
    expect(s1.codigo).toBe(1);
    expect(s1.resultado).toMatchObject({ totp: { naoAbrem: 2 } });
  });

  it('a rotação da mestra re-cifra o TOTP na mesma transação (ida e volta); o código do autenticador continua o mesmo; reentrante', async () => {
    await comFator(ID, 'c2@exemplo.test', copia(MESTRA_V1));
    const antes = await linhaDe(ID);
    const r = anotar(await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2)));
    expect(r).toMatchObject({ situacao: 'rotacionada', linhas: 4, totp: 2 });
    const u = await linhaDe(ID);
    expect([u.totpMestraVersao, u.totpPendenteMestraVersao]).toEqual([2, 2]);
    expect(Buffer.from(u.totpCifrado!).equals(Buffer.from(antes.totpCifrado!))).toBe(false);
    const ativo = decifrarSegredoTotp(MESTRA_V2, ID, 'ativo', { cifrado: u.totpCifrado!, mestraVersao: u.totpMestraVersao! });
    expect(ativo.equals(ATIVO)).toBe(true);
    expect(decifrarSegredoTotp(MESTRA_V2, ID, 'pendente', { cifrado: u.totpPendenteCifrado!, mestraVersao: u.totpPendenteMestraVersao! }).equals(PENDENTE)).toBe(true);
    // Login com código depois da rotação: o segredo que a API (já com a v2) abre gera o mesmo código do autenticador.
    const passo = passoDe(new Date());
    expect(verificarTotp(ativo, codigoTotp(ATIVO, passo), passo)).toEqual({ passo, desvio: 0 });
    expect(() => decifrarSegredoTotp(MESTRA_V1, ID, 'ativo', { cifrado: u.totpCifrado!, mestraVersao: 1 })).toThrow();
    expect((await c.dbPlat.select().from(sp.plataformaAudit)).find((a) => a.acao === 'plataforma.mestraRotacionada')!.detalhes).toMatchObject({ totp: 2 });
    // De novo: nada a fazer.
    const foto = JSON.stringify(await linhaDe(ID));
    expect(await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2))).toMatchObject({ situacao: 'ja_rotacionada', totp: 0 });
    expect(JSON.stringify(await linhaDe(ID))).toBe(foto);
  });

  it('segredo gravado com a mestra antiga DEPOIS da rotação (API não reiniciada): rodar de novo re-cifra só ele', async () => {
    await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2));
    await comFator(ID2, 'tarde@exemplo.test', copia(MESTRA_V1), false);
    const r = await rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2));
    expect(r).toMatchObject({ situacao: 'rotacionada', totp: 1 });
    expect((await linhaDe(ID2)).totpMestraVersao).toBe(2);
  });

  it('TOTP que não abre com a mestra atual, ou em versão inesperada: recusa sem escrever nada (nem as chaves de condomínio)', async () => {
    const outra = { chave: randomBytes(32), versao: 1 };
    await comFator(ID, 'c2@exemplo.test', outra);
    const antes = [await fotoPlataforma(c), JSON.stringify(await linhaDe(ID))];
    expect((await falha(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2)))).message).toMatch(/não abre com a mestra atual/);
    expect([await fotoPlataforma(c), JSON.stringify(await linhaDe(ID))]).toEqual(antes);
    await c.dbPlat.update(sp.masterUsuario).set({ totpMestraVersao: 9, totpPendenteMestraVersao: 9 }).where(eq(sp.masterUsuario.id, ID));
    expect((await falha(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2)))).message).toMatch(/versão da mestra inesperada \(v9, v9\)/);
    expect(await fotoPlataforma(c)).toBe(antes[0]);
  });

  it('falha injetada no meio da rotação: o TOTP também volta (mesma transação)', async () => {
    await comFator(ID, 'c2@exemplo.test', copia(MESTRA_V1));
    const antes = JSON.stringify(await linhaDe(ID));
    await falha(rotacionarMestra(c.dbPlat, copia(MESTRA_V1), copia(MESTRA_V2), { aposReembrulhar: (i) => { if (i === 3) throw new Error('queda simulada'); } }));
    expect(JSON.stringify(await linhaDe(ID))).toBe(antes);
  });
});

// =================================================================================================================
describe('segredos', () => {
  it('lerAmbiente: chave só pelo ambiente; a mensagem de erro cita o nome da variável, nunca o valor', () => {
    const base = { PORTARIA_CHAVE_MESTRA: MESTRA_V1.chave.toString('base64'), PORTARIA_CHAVE_MESTRA_VERSAO: '1', MIGRATOR_URL_BASE: 'postgres://app_migrator:x@db:5432' };
    const curta = randomBytes(16).toString('base64');
    for (const [env, msg] of [
      [{ ...base }, /PORTARIA_CHAVE_MESTRA_NOVA não definida/],
      [{ ...base, PORTARIA_CHAVE_MESTRA_NOVA: curta, PORTARIA_CHAVE_MESTRA_VERSAO_NOVA: '2' }, /PORTARIA_CHAVE_MESTRA_NOVA precisa ter exatamente 32 bytes/],
      [{ ...base, PORTARIA_CHAVE_MESTRA_NOVA: MESTRA_V2.chave.toString('base64') }, /PORTARIA_CHAVE_MESTRA_VERSAO_NOVA não definida/],
      [{ ...base, MIGRATOR_URL_BASE: 'postgres://app_rw:x@db:5432', PORTARIA_CHAVE_MESTRA_NOVA: MESTRA_V2.chave.toString('base64'), PORTARIA_CHAVE_MESTRA_VERSAO_NOVA: '2' }, /MIGRATOR_URL_BASE precisa usar o role app_migrator/],
    ] as const) {
      let m = '';
      try { lerAmbiente({ modo: 'mestra' }, env); } catch (e) { m = (e as Error).message; }
      expect(m).toMatch(msg);
      expect(m).not.toContain(curta);
      SAIDAS.push(m);
    }
    const ok = lerAmbiente({ modo: 'mestra' }, { ...base, PORTARIA_CHAVE_MESTRA_NOVA: MESTRA_V2.chave.toString('base64'), PORTARIA_CHAVE_MESTRA_VERSAO_NOVA: '2' });
    expect(ok.migratorPlataforma).toBe('postgres://app_migrator:x@db:5432/plataforma');
    expect(ok.nova!.chave.equals(MESTRA_V2.chave)).toBe(true);
  });

  it('nenhuma chave (base64, hex ou bytes) aparece em resultado, erro ou log de toda esta suíte', () => {
    expect(SAIDAS.length).toBeGreaterThan(20);
    const tudo = SAIDAS.join('\n');
    for (const k of SEGREDOS) {
      for (const forma of [k.toString('base64'), k.toString('hex'), k.toString('base64url'), k.toString('latin1')]) expect(tudo.includes(forma)).toBe(false);
      expect(tudo.includes(k.subarray(0, 12).toString('hex'))).toBe(false);
    }
  });
});
