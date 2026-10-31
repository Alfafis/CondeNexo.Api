// Testes do anexar-selos.mjs com dados falsos (node --test scripts/). Rodam também no `npm test` da raiz.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ErroArquivo, ErroResposta, FORMATO, lerArquivo, linhaJsonl, mesclar, principal, validarResposta } from './anexar-selos.mjs';

const h = (c) => c.repeat(64);
const AGORA = new Date('2026-10-20T05:17:00Z'); // 02:17 BRT de 20/10
const resposta = (selos, extra = {}) => JSON.stringify({ data: { formato: FORMATO, versao: 1, selos, ...extra } });
const S = (data, seq, hash, totalDoDia) => ({ data, seq, hash, totalDoDia });

function cenario(selos, arquivo = '') {
  const dir = mkdtempSync(join(tmpdir(), 'ancoras-'));
  const f = { resposta: join(dir, 'resposta.json'), arquivo: join(dir, 'selos.jsonl'), relatorio: join(dir, 'divergencia.md') };
  writeFileSync(f.resposta, typeof selos === 'string' ? selos : resposta(selos));
  if (arquivo !== null) writeFileSync(f.arquivo, arquivo);
  const rodar = () => principal(['--resposta', f.resposta, '--arquivo', f.arquivo, '--relatorio', f.relatorio, '--execucao', '42'], AGORA);
  const ler = () => readFileSync(f.arquivo, 'utf8');
  const trocarResposta = (s) => writeFileSync(f.resposta, resposta(s));
  return { f, rodar, ler, trocarResposta };
}

describe('validarResposta', () => {
  it('aceita o formato e ordena por data', () => {
    const r = validarResposta(resposta([S('2026-10-19', 9, h('b'), 4), S('2026-10-18', 5, h('a'), 5)]), AGORA);
    assert.deepEqual(r.map((s) => s.data), ['2026-10-18', '2026-10-19']);
  });
  it('descarta campos extras (só os quatro conferidos vão para o arquivo)', () => {
    const [s] = validarResposta(resposta([{ ...S('2026-10-18', 5, h('a'), 5), nome: 'x' }]), AGORA);
    assert.deepEqual(Object.keys(s), ['data', 'seq', 'hash', 'totalDoDia']);
  });
  for (const [caso, corpo] of [
    ['não é JSON', '<html>502</html>'],
    ['sem envelope', JSON.stringify({ formato: FORMATO, versao: 1, selos: [] })],
    ['formato errado', resposta([], { formato: 'outro' })],
    ['versão nova', resposta([], { versao: 2 })],
    ['hash maiúsculo', resposta([S('2026-10-18', 1, 'A'.repeat(64), 1)])],
    ['hash curto', resposta([S('2026-10-18', 1, 'a'.repeat(63), 1)])],
    ['seq negativo', resposta([S('2026-10-18', -1, h('a'), 1)])],
    ['seq fracionário', resposta([S('2026-10-18', 1.5, h('a'), 1)])],
    ['data inexistente', resposta([S('2026-02-30', 1, h('a'), 1)])],
    ['data no futuro (BRT)', resposta([S('2026-10-21', 1, h('a'), 1)])],
    ['data repetida', resposta([S('2026-10-18', 1, h('a'), 1), S('2026-10-18', 1, h('a'), 1)])],
    ['total ausente', resposta([{ data: '2026-10-18', seq: 1, hash: h('a') }])],
  ]) {
    it(`recusa: ${caso}`, () => assert.throws(() => validarResposta(corpo, AGORA), ErroResposta));
  }
  it('hoje em BRT, não em UTC: às 01:00 UTC de 21/10 ainda é 20/10 em Brasília', () => {
    assert.throws(() => validarResposta(resposta([S('2026-10-21', 1, h('a'), 1)]), new Date('2026-10-21T01:00:00Z')), ErroResposta);
    assert.equal(validarResposta(resposta([S('2026-10-20', 1, h('a'), 1)]), new Date('2026-10-21T01:00:00Z')).length, 1);
  });
});

describe('lerArquivo', () => {
  it('vazio = nada ancorado', () => assert.deepEqual(lerArquivo(''), []));
  it('recusa linha truncada, JSON inválido e data repetida', () => {
    const l = linhaJsonl(S('2026-10-18', 1, h('a'), 1), 'x', '1');
    assert.throws(() => lerArquivo(l.slice(0, -1)), ErroArquivo);
    assert.throws(() => lerArquivo('{nao json}\n'), ErroArquivo);
    assert.throws(() => lerArquivo(l + l), ErroArquivo);
  });
});

describe('mesclar', () => {
  const ancorados = [S('2026-10-16', 3, h('a'), 3), S('2026-10-17', 3, h('a'), 0), S('2026-10-18', 7, h('c'), 4)];
  it('anexa só o que é novo; o já ancorado que confere não gera nada', () => {
    const r = mesclar(ancorados, [S('2026-10-17', 3, h('a'), 0), S('2026-10-18', 7, h('c'), 4), S('2026-10-19', 9, h('d'), 2)]);
    assert.deepEqual(r, { novos: [S('2026-10-19', 9, h('d'), 2)], divergencias: [] });
  });
  it('hash de dia ancorado mudou: divergência, e nada é anexado (nem o dia novo)', () => {
    const r = mesclar(ancorados, [S('2026-10-18', 7, h('f'), 4), S('2026-10-19', 9, h('d'), 2)]);
    assert.deepEqual(r.novos, []);
    assert.equal(r.divergencias[0].tipo, 'valor_alterado');
  });
  it('seq ou total de dia ancorado mudou: divergência', () => {
    assert.equal(mesclar(ancorados, [S('2026-10-18', 6, h('c'), 4)]).divergencias[0].tipo, 'valor_alterado');
    assert.equal(mesclar(ancorados, [S('2026-10-18', 7, h('c'), 3)]).divergencias[0].tipo, 'valor_alterado');
  });
  it('dia ancorado sumiu do meio da resposta: divergência (selo não aceita DELETE)', () => {
    const r = mesclar(ancorados, [S('2026-10-16', 3, h('a'), 3), S('2026-10-18', 7, h('c'), 4)]);
    assert.deepEqual(r.divergencias.map((d) => [d.tipo, d.data]), [['selo_sumiu', '2026-10-17']]);
  });
  it('dia ancorado mais antigo que a janela da resposta não é cobrado', () => {
    assert.deepEqual(mesclar(ancorados, [S('2026-10-18', 7, h('c'), 4)]).divergencias, []);
  });
  it('dia novo preenchendo lacuna com seq fora de ordem: divergência', () => {
    const r = mesclar([S('2026-10-16', 3, h('a'), 3), S('2026-10-18', 7, h('c'), 4)], [S('2026-10-17', 9, h('e'), 6)]);
    assert.equal(r.divergencias[0].tipo, 'seq_regrediu');
    assert.deepEqual(r.novos, []);
  });
  it('mesmo seq em dois dias (dia sem evento) com hash diferente: divergência', () => {
    const r = mesclar([S('2026-10-16', 3, h('a'), 3)], [S('2026-10-17', 3, h('b'), 0)]);
    assert.equal(r.divergencias[0].tipo, 'mesmo_seq_hash_diferente');
  });
  it('lacuna legítima (API fora alguns dias): dia novo coerente é aceito', () => {
    const r = mesclar([S('2026-10-10', 3, h('a'), 3)], [S('2026-10-18', 9, h('d'), 2)]);
    assert.deepEqual(r, { novos: [S('2026-10-18', 9, h('d'), 2)], divergencias: [] });
  });
});

describe('principal (arquivo de verdade)', () => {
  it('primeira execução cria o arquivo; a segunda, igual, não muda nada; a terceira só anexa', () => {
    const c = cenario([S('2026-10-17', 0, h('0'), 0), S('2026-10-18', 4, h('a'), 4)], null);
    assert.equal(c.rodar().codigo, 0);
    const primeira = c.ler();
    assert.equal(primeira.trim().split('\n').length, 2);
    assert.equal(c.rodar().novos.length, 0);
    assert.equal(c.ler(), primeira);
    c.trocarResposta([S('2026-10-18', 4, h('a'), 4), S('2026-10-19', 6, h('b'), 2)]);
    assert.deepEqual(c.rodar().novos.map((s) => s.data), ['2026-10-19']);
    const terceira = c.ler();
    assert.ok(terceira.startsWith(primeira), 'o conteúdo anterior continua intacto no começo');
    assert.deepEqual(JSON.parse(terceira.trim().split('\n')[2]), { data: '2026-10-19', seq: 6, hash: h('b'), totalDoDia: 2, ancoradoEm: AGORA.toISOString(), execucao: '42' });
  });

  it('divergência: código 2, arquivo intacto byte a byte, relatório com os dois valores', () => {
    const original = linhaJsonl(S('2026-10-18', 4, h('a'), 4), '2026-10-19T05:17:00.000Z', '41');
    const c = cenario([S('2026-10-18', 4, h('f'), 4), S('2026-10-19', 6, h('b'), 2)], original);
    const r = c.rodar();
    assert.equal(r.codigo, 2);
    assert.equal(c.ler(), original);
    const md = readFileSync(c.f.relatorio, 'utf8');
    assert.match(md, new RegExp(h('a')));
    assert.match(md, new RegExp(h('f')));
  });

  it('arquivo de âncoras corrompido: código 2 (investigar), nada gravado', () => {
    const c = cenario([S('2026-10-19', 6, h('b'), 2)], '{"data":"2026-10-18"');
    assert.equal(c.rodar().codigo, 2);
    assert.equal(c.ler(), '{"data":"2026-10-18"');
    assert.match(readFileSync(c.f.relatorio, 'utf8'), /arquivo de âncoras inválido/);
  });

  it('API fora (página de erro no lugar do JSON): lança ErroResposta e não toca no arquivo', () => {
    const original = linhaJsonl(S('2026-10-18', 4, h('a'), 4), 'x', '41');
    const c = cenario('<html>502 Bad Gateway</html>', original);
    assert.throws(() => c.rodar(), ErroResposta);
    assert.equal(c.ler(), original);
  });
});
