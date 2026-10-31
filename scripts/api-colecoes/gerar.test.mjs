// Testes do gerador de coleções (node --test): gera numa pasta temporária a partir do docs/api/openapi.json e confere
// o contrato (uma request por operação, JSON válido, nenhuma senha preenchida) e que os arquivos versionados batem.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gerarColecoes } from './gerar.mjs';

const DOCS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'docs', 'api');
const openapi = JSON.parse(readFileSync(join(DOCS, 'openapi.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'colecoes-'));
after(() => rmSync(temp, { recursive: true, force: true }));
gerarColecoes(openapi, temp);

const arquivos = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? arquivos(p) : [p];
}).sort();
const operacoes = Object.values(openapi.paths).flatMap((ops) => Object.values(ops));

describe('coleções Postman e Bruno', () => {
  it('uma request por operação do OpenAPI (Postman e Bruno)', () => {
    const colecao = JSON.parse(readFileSync(join(temp, 'postman', 'portaria.postman_collection.json'), 'utf8'));
    assert.equal(colecao.item.flatMap((p) => p.item).length, operacoes.length);
    const bru = arquivos(join(temp, 'bruno')).filter((f) => f.endsWith('.bru') && !/folder\.bru$|environments/.test(f));
    assert.equal(bru.length, operacoes.length);
    assert.equal(colecao.item[0].name, 'auth');
    assert.equal(colecao.item[0].item[0].name, 'auth / login');
  });

  it('todo .json gerado é JSON válido', () => {
    for (const f of arquivos(temp).filter((x) => x.endsWith('.json'))) assert.doesNotThrow(() => JSON.parse(readFileSync(f, 'utf8')), f);
  });

  it('nenhuma senha preenchida: campos de senha são {{variável}} e os ambientes entregam senha vazia', () => {
    const colecao = JSON.parse(readFileSync(join(temp, 'postman', 'portaria.postman_collection.json'), 'utf8'));
    const corpos = colecao.item.flatMap((p) => p.item).filter((i) => i.request.body?.mode === 'raw').map((i) => JSON.parse(i.request.body.raw));
    let achou = 0;
    const varre = (v) => {
      for (const [k, x] of Object.entries(v ?? {})) {
        if (/senha/i.test(k)) { achou++; assert.match(String(x), /^\{\{\w+\}\}$/, `campo ${k} preenchido`); }
        else if (x && typeof x === 'object') varre(x);
      }
    };
    corpos.forEach(varre);
    assert.ok(achou >= 3, 'esperava login + trocar-senha');
    for (const amb of ['producao', 'local']) {
      const env = JSON.parse(readFileSync(join(temp, 'postman', `${amb}.postman_environment.json`), 'utf8'));
      for (const v of env.values.filter((x) => x.type === 'secret' || x.key === 'login')) assert.equal(v.value, '', `${amb}.${v.key}`);
      assert.ok(env.values.some((x) => x.key === 'senha' && x.type === 'secret'));
      assert.match(env.values.find((x) => x.key === 'baseUrl').value, /\/api\/v1$/);
      const bru = readFileSync(join(temp, 'bruno', 'environments', `${amb}.bru`), 'utf8');
      assert.match(bru, /vars:secret \[\n {2}senha\n/);
      assert.doesNotMatch(bru, /^\s*(senha|novaSenha|senhaAtual):/m);
    }
  });

  it('os arquivos versionados batem com a geração (rode npm run colecoes)', () => {
    for (const pasta of ['postman', 'bruno']) {
      const gerados = arquivos(join(temp, pasta)).map((f) => relative(temp, f));
      const versionados = arquivos(join(DOCS, pasta)).map((f) => relative(DOCS, f));
      assert.deepEqual(versionados, gerados, `lista de arquivos de docs/api/${pasta} desatualizada: rode npm run colecoes`);
      for (const rel of gerados) {
        assert.equal(readFileSync(join(DOCS, rel), 'utf8'), readFileSync(join(temp, rel), 'utf8'), `${rel} desatualizado: rode npm run colecoes`);
      }
    }
  });
});
