// Âncora pelo GitHub Actions (spec §4.6): endpoint público dos selos diários e a conferência pelo ARQUIVO de âncoras
// (o selos.jsonl do branch `ancoras`), montado aqui pelo mesmo script que o workflow roda (scripts/ancoras).
// O ataque é feito como superusuário do PGlite: reescreve um evento, recalcula a cadeia inteira E os selos do banco.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { principal } from '../scripts/ancoras/anexar-selos.mjs';
import { diaBrt } from '../src/comum/datas';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { DESTINO_GITHUB, EnvioAncoraReal } from '../src/selo/ancora';
import { conferirAncoras } from '../src/selo/conferir-ancoras';
import { SeloService } from '../src/selo/selo.module';
import { configDeTeste, novaApi, novoIp, type PapelTeste } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const V1 = '/api/v1';
const PUBLICO = `${V1}/auditoria/selos/publico`;
const JUST = 'Morador não atende o interfone, entrega urgente';
const ANCORA_GITHUB = { github: true, emails: [], remetente: 'portaria@localhost', smtp: null, arquivo: null };

async function montar(github = true) {
  const api = await novaApi(github ? { ancora: ANCORA_GITHUB } : {});
  await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
  const cookies = {} as Record<PapelTeste, string>;
  for (const p of ['porteiro', 'auditor'] as PapelTeste[]) cookies[p] = (await api.como(p)).cookie;
  const [pessoa] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Marcos Pereira'));
  const [d32] = await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32')));
  const get = (papel: PapelTeste, url: string) => api.http().get(`${V1}${url}`).set('Cookie', cookies[papel]);
  const post = (papel: PapelTeste, url: string, corpo?: object) => api.http().post(`${V1}${url}`).set('Cookie', cookies[papel]).send(corpo);
  /** n entradas (com saída): 2n eventos. */
  async function movimentar(n: number) {
    for (let i = 0; i < n; i++) {
      const e = await post('porteiro', '/eventos-acesso', { pessoaId: pessoa!.id, unidadeDestinoId: d32!.id, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
      if (e.status !== 201) throw new Error(`entrada falhou: ${JSON.stringify(e.body)}`);
      await post('porteiro', `/eventos-acesso/${e.body.data.id}/saida`);
    }
  }
  const hashDo = async (seq: number) => (await api.db.select().from(s.eventoAcesso).where(eq(s.eventoAcesso.seq, seq)))[0]!.hash;
  /** Selo diário gravado direto (superusuário), para ter dias anteriores ao de hoje. O trigger confere seq e hash. */
  const seloDiario = async (data: string, seq: number) => api.db.insert(s.seloCadeia).values({ data, tipo: 'diario', ultimoSeq: seq, ultimoHash: await hashDo(seq) });
  const publico = (ip = novoIp()) => api.http().get(PUBLICO).set('X-Forwarded-For', ip);
  return { api, get, post, movimentar, hashDo, seloDiario, publico, selo: await api.servico<SeloService>(SeloService) };
}

describe('GET /auditoria/selos/publico (destino github)', () => {
  let m: Awaited<ReturnType<typeof montar>>;
  // No PGlite o registrado_em vem do relógio REAL (trigger): o "hoje" dos eventos é o dia real, em BRT.
  const hoje = diaBrt(new Date());
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    m = await montar();
    await m.movimentar(2); // seq 1..4
    await m.seloDiario('2026-10-01', 2);
    await m.movimentar(1); // seq 5..6
    await m.selo.selarDia(hoje); // diário de hoje: seq 6
    await m.movimentar(1); // seq 7..8
    expect((await m.post('auditor', '/auditoria/selos')).body.data).toMatchObject({ novo: true, selo: { tipo: 'manual', ultimoSeq: 8 } }); // não pode aparecer
  });
  afterAll(async () => { vi.restoreAllMocks(); await m.api.app.close(); await m.api.client.close(); });

  it('sem sessão; só selos DIÁRIOS, só data/seq/hash/total; nenhum instante, id ou selo manual', async () => {
    const r = await m.publico();
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(Object.keys(r.body.data)).toEqual(['formato', 'versao', 'selos']);
    expect(r.body.data).toMatchObject({ formato: 'portaria-parque/selos-diarios', versao: 1 });
    expect(r.body.data.selos).toEqual([
      { data: '2026-10-01', seq: 2, hash: await m.hashDo(2), totalDoDia: 0 },
      { data: hoje, seq: 6, hash: await m.hashDo(6), totalDoDia: 6 },
    ]);
  });

  it('não é oráculo: parâmetros são ignorados (a resposta é a mesma para qualquer pergunta)', async () => {
    const base = (await m.publico()).body;
    for (const q of [`?seq=3`, `?hash=${'a'.repeat(64)}`, '?data=2026-10-01&limite=1000']) {
      expect((await m.api.http().get(`${PUBLICO}${q}`).set('X-Forwarded-For', novoIp())).body).toEqual(base);
    }
  });

  it('cache: selo gravado por fora só aparece depois do TTL; selo diário pela API invalida na hora', async () => {
    await m.publico(); // aquece
    await m.seloDiario('2026-10-02', 4); // direto no banco: sem invalidar o cache
    expect((await m.publico()).body.data.selos.map((x: { data: string }) => x.data)).not.toContain('2026-10-02');
    m.api.relogio.avancarMin(1.1);
    expect((await m.publico()).body.data.selos.map((x: { data: string }) => x.data)).toContain('2026-10-02');
    await m.publico(); // aquece de novo
    await m.selo.selarDia('2026-10-03'); // sem evento antes do dia (cadeia não vazia): não sela
    const amanha = new Date(Date.now() + 86_400_000);
    expect((await m.selo.selarDia(diaBrt(amanha)))?.novo).toBe(true);
    expect((await m.publico()).body.data.selos.at(-1)).toMatchObject({ data: diaBrt(amanha), seq: 8, totalDoDia: 0 });
  });

  it('limite próprio por IP: 30 por minuto, depois 429 com Retry-After e no-store; outro IP segue', async () => {
    const ip = novoIp();
    for (let i = 0; i < 30; i++) expect((await m.publico(ip)).status).toBe(200);
    const r = await m.publico(ip);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('LIMITE_EXCEDIDO');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await m.publico()).status).toBe(200);
  });

  it('/saude público não devolve o seq da cadeia (em polling, mostraria cada evento na hora)', async () => {
    const r = await m.api.http().get(`${V1}/saude`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/seq/i);
  });
});

describe('destino github desligado', () => {
  it('o endpoint público não existe (404)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const m = await montar(false);
    try {
      const r = await m.publico();
      expect(r.status).toBe(404);
    } finally { vi.restoreAllMocks(); await m.api.app.close(); await m.api.client.close(); }
  });

  it('EnvioAncoraReal com github: diário fica para a coleta; manual, coberto pelo próximo diário; sem SMTP', async () => {
    const envio = new EnvioAncoraReal(configDeTeste({ ancora: ANCORA_GITHUB }));
    expect(envio.destinos()).toEqual([DESTINO_GITHUB]);
    const base = { id: 'x', data: '2026-10-17', ultimoSeq: 1, ultimoHash: 'a'.repeat(64), eventosNoDia: 1, seladoEm: new Date() };
    expect(await envio.enviar({ ...base, tipo: 'diario' })).toBe(DESTINO_GITHUB);
    expect(await envio.enviar({ ...base, tipo: 'manual' })).toMatch(/coberto pelo próximo selo diário/);
  });
});

describe('cadeia recalculada por superusuário: o ARQUIVO de âncoras do GitHub denuncia', () => {
  it('a verificação interna volta a dizer íntegra; a trilha exportada não bate com selos.jsonl, e a coleta seguinte falha alto', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const m = await montar();
    try {
      await m.movimentar(2);
      await m.seloDiario('2026-10-01', 2);
      await m.movimentar(1);
      await m.seloDiario('2026-10-02', 6);

      // Coleta do workflow: resposta da API -> script do workflow -> selos.jsonl
      const dir = mkdtempSync(join(tmpdir(), 'ancoras-gh-'));
      const f = { resposta: join(dir, 'resposta.json'), arquivo: join(dir, 'selos.jsonl'), relatorio: join(dir, 'divergencia.md') };
      const coletar = async () => {
        m.api.relogio.avancarMin(1.1); // fora do cache
        const r = await m.publico();
        writeFileSync(f.resposta, r.text);
        return principal(['--resposta', f.resposta, '--arquivo', f.arquivo, '--relatorio', f.relatorio, '--execucao', 'teste']);
      };
      expect((await coletar()).novos.map((x) => x.data)).toEqual(['2026-10-01', '2026-10-02']);
      const ancorado = readFileSync(f.arquivo, 'utf8');
      const exportar = async () => (await m.post('auditor', '/auditoria/exportacoes', {})).body.data.conteudo as string;
      expect(await conferirAncoras(await exportar(), ancorado)).toMatchObject({ conclusao: 'confere', conferidas: [{ seq: 2 }, { seq: 6 }], divergentes: [] });

      // Ataque: altera o seq 2, recalcula TODOS os hashes e a cabeça, e reescreve os selos do banco para baterem
      const hashAntigo = await m.hashDo(2);
      await m.api.client.exec(`
        ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel;
        UPDATE evento_acesso SET observacao = 'inserido depois do fato' WHERE seq = 2;
        DO $$ DECLARE r evento_acesso%ROWTYPE; ant text := encode(sha256(convert_to('genesis', 'UTF8')), 'hex'); h text; BEGIN
          FOR r IN SELECT * FROM evento_acesso ORDER BY seq LOOP
            h := encode(sha256(convert_to(ant || evento_acesso_canonico(r), 'UTF8')), 'hex');
            UPDATE evento_acesso SET hash_anterior = ant, hash = h WHERE id = r.id;
            ant := h;
          END LOOP;
          UPDATE evento_acesso_cadeia SET ultimo_hash = ant WHERE id = 1;
        END $$;
        ALTER TABLE evento_acesso ENABLE TRIGGER evento_acesso_imutavel;
        ALTER TABLE selo_cadeia DISABLE TRIGGER selo_cadeia_validar;
        UPDATE selo_cadeia s SET ultimo_hash = e.hash FROM evento_acesso e WHERE e.seq = s.ultimo_seq;
        ALTER TABLE selo_cadeia ENABLE TRIGGER selo_cadeia_validar;`);
      expect(await m.hashDo(2)).not.toBe(hashAntigo);
      // Por dentro, tudo coerente: cadeia, cabeça e selos
      expect((await m.get('auditor', '/auditoria/integridade')).body.data).toMatchObject({ valido: true, selosConferidos: 2 });

      // Offline: a trilha exportada é coerente por dentro, mas não bate com o que o GitHub guardou antes do ataque
      const r = await conferirAncoras(await exportar(), ancorado);
      expect(r).toMatchObject({ conclusao: 'divergente', trilha: { valido: true } });
      expect(r.divergentes.map((d) => [d.data, d.seq, d.hashAncorado === hashAntigo])).toEqual([['2026-10-01', 2, true], ['2026-10-02', 6, false]]);

      // Coleta seguinte: o workflow falha alto, não grava nada e o relatório (corpo da issue) traz os dois hashes
      const depois = await coletar();
      expect(depois.codigo).toBe(2);
      expect(depois.divergencias.map((d) => d.tipo)).toEqual(['valor_alterado', 'valor_alterado']);
      expect(readFileSync(f.arquivo, 'utf8')).toBe(ancorado);
      const md = readFileSync(f.relatorio, 'utf8');
      expect(md).toContain(hashAntigo);
      expect(md).toContain(await m.hashDo(2));
    } finally { vi.restoreAllMocks(); await m.api.app.close(); await m.api.client.close(); }
  });
});
