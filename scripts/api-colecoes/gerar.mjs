// Gera as coleções do Postman (v2.1) e do Bruno a partir de docs/api/openapi.json. Node puro, sem dependência.
// Uso: `npm run colecoes` (grava em docs/api/postman e docs/api/bruno). Determinístico: sem datas nem ids aleatórios,
// para o arquivo versionado só mudar quando a API mudar. Nenhuma senha é preenchida: vão como {{variável}} e os
// ambientes entregam a senha vazia (cada um digita a sua).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ_DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'api');
const NOME = 'CondNexo';
const AMBIENTES = [
  { nome: 'producao', servidor: 0 },
  { nome: 'local', servidor: 1 },
];
const VERBOS = ['get', 'post', 'put', 'patch', 'delete'];

// ---------------------------------------------------------------------------------------------------------------------
// Exemplos a partir do JSON Schema

const singular = (p) => (p.endsWith('oes') ? `${p.slice(0, -3)}ao` : p.endsWith('ais') ? `${p.slice(0, -3)}al` : p.endsWith('s') ? p.slice(0, -1) : p);
const camel = (partes) => partes.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join('');
/** Campo de senha (qualquer variante): nunca recebe valor, vira {{variável}} secreta. */
const ehSenha = (nome) => /senha/i.test(nome ?? '');

/** "pessoaId" para `/pessoas/{id}` e "unidadeRef" para `/unidades/{ref}`; nomes próprios (`documentoId`) ficam como estão. */
function nomeVariavelPath(caminho, param) {
  if (param !== 'id' && param !== 'ref') return param;
  const segs = caminho.split('/').filter(Boolean);
  const i = segs.indexOf(`{${param}}`);
  const anterior = segs.slice(0, i).reverse().find((s) => !s.startsWith('{')) ?? 'recurso';
  return `${camel(anterior.split('-').map(singular))}${param === 'id' ? 'Id' : 'Ref'}`;
}

const tipoDe = (s) => (Array.isArray(s.type) ? (s.type.find((t) => t !== 'null') ?? 'null') : s.type);

function exemploString(s, nome) {
  const n = nome ?? '';
  if (ehSenha(n)) return `{{${n}}}`;
  if (s.format === 'uuid' || /Id$/.test(n)) return n ? `{{${n}}}` : '00000000-0000-4000-8000-000000000000';
  if (s.format === 'date-time') return '2026-01-15T12:00:00.000Z';
  if (s.format === 'date') return '2026-01-15';
  if (s.format === 'email' || /e-?mail/i.test(n)) return 'pessoa.exemplo@exemplo.org';
  if (/cpf|documento/i.test(n)) return '111.444.777-35'; // CPF fictício válido (o mesmo dos testes)
  if (/telefone|celular/i.test(n)) return '11955550000';
  if (/placa/i.test(n)) return 'ABC1D23';
  if (/^nome/i.test(n)) return 'Fulano de Tal';
  let v = 'exemplo';
  if (s.minLength && v.length < s.minLength) v = v.padEnd(s.minLength, 'x');
  if (s.maxLength && v.length > s.maxLength) v = v.slice(0, s.maxLength);
  return v;
}

/** Valor plausível para um JSON Schema. Retorna sempre algo serializável. */
export function exemplo(s, nome) {
  if (!s || typeof s !== 'object') return null;
  if ('const' in s) return s.const;
  if (s.enum?.length) return s.enum[0];
  const variantes = s.anyOf ?? s.oneOf;
  if (variantes) return exemplo(variantes.find((v) => tipoDe(v) !== 'null') ?? variantes[0], nome);
  if (s.allOf) return Object.assign({}, ...s.allOf.map((p) => exemplo(p, nome)));
  switch (tipoDe(s)) {
    case 'string': return exemploString(s, nome);
    case 'integer':
    case 'number': {
      if ('default' in s) return s.default;
      let v = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
      if (s.maximum !== undefined && v > s.maximum) v = s.maximum;
      return v;
    }
    case 'boolean': return 'default' in s ? s.default : false;
    case 'array': {
      const item = exemplo(s.items, nome && nome.replace(/Ids$/, 'Id').replace(/s$/, ''));
      return s.minItems === 0 ? [] : [item];
    }
    case 'object': return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, exemplo(v, k)]));
    default: return s.properties ? exemplo({ ...s, type: 'object' }, nome) : null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Modelo comum: uma lista de requests independente do formato de saída

/** @returns {{tag:string,nome:string,arquivo:string,metodo:string,caminho:string,descricao:string|undefined,
 *  pathParams:{nome:string,variavel:string}[],query:{nome:string,valor:string,ativo:boolean}[],
 *  corpo:null|{tipo:'json',valor:any}|{tipo:'multipart',campos:string[]}}[]} */
export function requestsDe(openapi) {
  const lista = [];
  for (const [caminho, ops] of Object.entries(openapi.paths)) {
    for (const verbo of VERBOS) {
      const op = ops[verbo];
      if (!op) continue;
      const [tag, metodo] = [op.tags[0], op.operationId.slice(op.tags[0].length + 1)];
      const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => ({ nome: p.name, variavel: nomeVariavelPath(caminho, p.name) }));
      const query = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => ({
        nome: p.name,
        valor: String(exemplo(p.schema, p.name)),
        ativo: !!p.required,
      }));
      let corpo = null;
      const conteudo = op.requestBody?.content;
      if (conteudo?.['application/json']) {
        let valor = exemplo(conteudo['application/json'].schema);
        if (caminho === '/auth/login' && verbo === 'post') valor = { login: '{{login}}', senha: '{{senha}}' };
        corpo = { tipo: 'json', valor };
      } else if (conteudo?.['multipart/form-data']) {
        corpo = { tipo: 'multipart', campos: Object.keys(conteudo['multipart/form-data'].schema.properties ?? {}) };
      }
      lista.push({
        tag, nome: `${tag} / ${metodo}`, arquivo: metodo, metodo: verbo.toUpperCase(), caminho, descricao: op.description,
        pathParams, query, corpo, operationId: op.operationId,
      });
    }
  }
  // auth primeiro, e o login no topo da pasta; o resto por tag e depois por caminho/verbo (a ordem do openapi.json).
  const peso = (r) => (r.operationId === 'auth_login' ? 0 : 1);
  const tags = [...new Set(lista.map((r) => r.tag))].sort((a, b) => (a === 'auth' ? -1 : b === 'auth' ? 1 : a.localeCompare(b)));
  return tags.flatMap((t) => lista.filter((r) => r.tag === t).sort((a, b) => peso(a) - peso(b)));
}

/** Variáveis {{x}} que as requests usam além de baseUrl/login/senha: ids (livres) e senhas extras (secretas). */
function variaveisDe(requests) {
  const usadas = new Set();
  const varre = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) usadas.add(m[1]);
    else if (Array.isArray(v)) v.forEach(varre);
    else if (v && typeof v === 'object') Object.values(v).forEach(varre);
  };
  for (const r of requests) { r.pathParams.forEach((p) => usadas.add(p.variavel)); r.query.forEach((q) => varre(q.valor)); varre(r.corpo?.valor); }
  const secretas = ['senha', ...[...usadas].filter((v) => ehSenha(v) && v !== 'senha').sort()];
  const ids = [...usadas].filter((v) => !ehSenha(v) && v !== 'login' && v !== 'baseUrl').sort();
  return { secretas, ids };
}

// ---------------------------------------------------------------------------------------------------------------------
// Postman v2.1

const urlPostman = (r) => {
  const segs = r.caminho.split('/').filter(Boolean).map((s) => (s.startsWith('{') ? `:${s.slice(1, -1)}` : s));
  const url = {
    raw: `{{baseUrl}}/${segs.join('/')}${r.query.length ? `?${r.query.map((q) => `${q.nome}=${q.valor}`).join('&')}` : ''}`,
    host: ['{{baseUrl}}'],
    path: segs,
  };
  if (r.query.length) url.query = r.query.map((q) => ({ key: q.nome, value: q.valor, ...(q.ativo ? {} : { disabled: true }) }));
  if (r.pathParams.length) url.variable = r.pathParams.map((p) => ({ key: p.nome, value: `{{${p.variavel}}}` }));
  return url;
};

function itemPostman(r) {
  const request = { method: r.metodo, header: [], url: urlPostman(r) };
  if (r.descricao) request.description = r.descricao;
  if (r.corpo?.tipo === 'json') {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: JSON.stringify(r.corpo.valor, null, 2), options: { raw: { language: 'json' } } };
  } else if (r.corpo?.tipo === 'multipart') {
    request.body = { mode: 'formdata', formdata: r.corpo.campos.map((c) => ({ key: c, type: 'file', src: [] })) };
  }
  return { name: r.nome, request };
}

function colecaoPostman(openapi, requests, ids) {
  const pastas = [...new Set(requests.map((r) => r.tag))].map((tag) => ({ name: tag, item: requests.filter((r) => r.tag === tag).map(itemPostman) }));
  return {
    info: {
      name: NOME,
      description: `${openapi.info.title} (v${openapi.info.version}). Gerada de docs/api/openapi.json (npm run colecoes): não editar à mão. Selecione o ambiente (producao ou local), preencha login e senha e rode "auth / login" primeiro: o cookie de sessão fica no cookie jar.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: pastas,
    variable: ids.map((key) => ({ key, value: '' })),
  };
}

function ambientePostman(nome, servidor, secretas) {
  return {
    name: `${NOME} - ${nome}`,
    values: [
      { key: 'baseUrl', value: servidor, type: 'default', enabled: true },
      { key: 'login', value: '', type: 'default', enabled: true },
      ...secretas.map((key) => ({ key, value: '', type: 'secret', enabled: true })),
    ],
    _postman_variable_scope: 'environment',
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bruno (.bru)

const bloco = (nome, linhas) => `${nome} {\n${linhas.map((l) => `  ${l}`).join('\n')}\n}\n`;

function arquivoBruno(r, seq) {
  const partes = [bloco('meta', [`name: ${r.nome}`, 'type: http', `seq: ${seq}`])];
  const caminho = r.caminho.replace(/\{([^}]+)\}/g, ':$1');
  const corpoBru = r.corpo?.tipo === 'json' ? 'json' : r.corpo?.tipo === 'multipart' ? 'multipartForm' : 'none';
  partes.push(bloco(r.metodo.toLowerCase(), [`url: {{baseUrl}}${caminho}`, `body: ${corpoBru}`, 'auth: none']));
  if (r.query.length) partes.push(bloco('params:query', r.query.map((q) => `${q.ativo ? '' : '~'}${q.nome}: ${q.valor}`)));
  if (r.pathParams.length) partes.push(bloco('params:path', r.pathParams.map((p) => `${p.nome}: {{${p.variavel}}}`)));
  if (r.corpo?.tipo === 'json') {
    partes.push(bloco('body:json', JSON.stringify(r.corpo.valor, null, 2).split('\n')));
  } else if (r.corpo?.tipo === 'multipart') {
    partes.push(bloco('body:multipart-form', r.corpo.campos.map((c) => `${c}: @file()`)));
  }
  if (r.descricao) partes.push(bloco('docs', r.descricao.split('\n')));
  return partes.join('\n');
}

function ambienteBruno(servidor, ids, secretas) {
  const vars = bloco('vars', [`baseUrl: ${servidor}`, 'login: ', ...ids.map((v) => `${v}: `)]);
  return `${vars}\nvars:secret [\n${secretas.map((s) => `  ${s}`).join('\n')}\n]\n`;
}

// ---------------------------------------------------------------------------------------------------------------------

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const grava = (arquivo, texto) => { mkdirSync(dirname(arquivo), { recursive: true }); writeFileSync(arquivo, texto); };

/** Grava `postman/` e `bruno/` dentro de `destino` (apagando o que havia nessas duas pastas). Devolve o número de requests. */
export function gerarColecoes(openapi, destino) {
  const requests = requestsDe(openapi);
  const { secretas, ids } = variaveisDe(requests);
  const postman = join(destino, 'postman');
  const bruno = join(destino, 'bruno');
  rmSync(postman, { recursive: true, force: true });
  rmSync(bruno, { recursive: true, force: true });

  grava(join(postman, 'portaria.postman_collection.json'), json(colecaoPostman(openapi, requests, ids)));
  for (const a of AMBIENTES) grava(join(postman, `${a.nome}.postman_environment.json`), json(ambientePostman(a.nome, openapi.servers[a.servidor].url, secretas)));

  grava(join(bruno, 'bruno.json'), json({ version: '1', name: NOME, type: 'collection', ignore: ['node_modules', '.git'] }));
  for (const a of AMBIENTES) grava(join(bruno, 'environments', `${a.nome}.bru`), ambienteBruno(openapi.servers[a.servidor].url, ids, secretas));
  const tags = [...new Set(requests.map((r) => r.tag))];
  tags.forEach((tag, i) => {
    grava(join(bruno, tag, 'folder.bru'), bloco('meta', [`name: ${tag}`, `seq: ${i + 1}`]));
    requests.filter((r) => r.tag === tag).forEach((r, j) => {
      grava(join(bruno, tag, `${r.arquivo}.bru`), arquivoBruno(r, j + 1));
    });
  });
  return requests.length;
}

export function gerarDeArquivo(arquivoOpenapi = join(RAIZ_DOCS, 'openapi.json'), destino = RAIZ_DOCS) {
  const openapi = JSON.parse(readFileSync(arquivoOpenapi, 'utf8'));
  return gerarColecoes(openapi, destino);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = gerarDeArquivo();
  console.log(`colecoes: ${n} requests em docs/api/postman e docs/api/bruno`);
}
