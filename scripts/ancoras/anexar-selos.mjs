#!/usr/bin/env node
// Âncora do selo diário pelo GitHub Actions (spec §4.6; workflow .github/workflows/ancora-selo.yml).
//
// Lê a resposta de GET /api/v1/auditoria/selos/publico, confere com o arquivo de âncoras (selos.jsonl do branch
// `ancoras`) e ANEXA só os dias ainda não ancorados. Nunca reescreve nem reordena linha existente. Se a API devolve,
// para um dia já ancorado, um valor diferente (ou some com um dia ancorado, ou apresenta uma história incoerente),
// isso é sinal de que a trilha foi reescrita depois da âncora: NADA é gravado, o relatório vai para --relatorio e o
// processo sai com código 2 (o workflow abre uma issue).
//
// Sem dependência: só o Node do runner. Códigos de saída:
//   0  conferido (com ou sem dias novos anexados)
//   1  resposta inválida, API fora do ar ou uso errado: nada gravado, nada a investigar além da disponibilidade
//   2  divergência (ou arquivo de âncoras corrompido): nada gravado, investigar
//
// Uso: node anexar-selos.mjs --resposta resposta.json --arquivo selos.jsonl [--relatorio divergencia.md]
//                            [--execucao <id da execução>] [--agora <ISO, só para teste>]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FORMATO = 'portaria-parque/selos-diarios';
const MAX_SELOS_RESPOSTA = 100;
const BRT_MS = 3 * 3600 * 1000;
const HASH = /^[0-9a-f]{64}$/;

/** Resposta da API fora do formato: falha de disponibilidade ou de versão, não de integridade. */
export class ErroResposta extends Error {}
/** O próprio arquivo de âncoras não é um JSONL válido do formato: alguém mexeu nele por fora do workflow. */
export class ErroArquivo extends Error {}

/** 'AAAA-MM-DD' do dia em BRT (UTC-3 fixo, como a API). */
export const diaBrt = (agora) => new Date(agora.getTime() - BRT_MS).toISOString().slice(0, 10);

function diaValido(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const inteiroNaoNegativo = (n) => Number.isSafeInteger(n) && n >= 0;

/** Os quatro campos de um selo, validados; `onde` vai na mensagem de erro. */
function selo(o, onde, Erro) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Erro(`${onde}: não é um objeto`);
  if (!diaValido(o.data)) throw new Erro(`${onde}: data inválida`);
  if (!inteiroNaoNegativo(o.seq)) throw new Erro(`${onde}: seq inválido`);
  if (typeof o.hash !== 'string' || !HASH.test(o.hash)) throw new Erro(`${onde}: hash inválido (64 hex minúsculos)`);
  if (!inteiroNaoNegativo(o.totalDoDia)) throw new Erro(`${onde}: totalDoDia inválido`);
  return { data: o.data, seq: o.seq, hash: o.hash, totalDoDia: o.totalDoDia };
}

/**
 * Valida o corpo da resposta (envelope `{ data: { formato, versao, selos } }`) e devolve os selos em ordem de data.
 * Selo com data posterior a hoje (BRT) é recusado: servidor com relógio errado não ancora o futuro.
 */
export function validarResposta(texto, agora = new Date()) {
  let corpo;
  try { corpo = JSON.parse(texto); } catch { throw new ErroResposta('resposta não é JSON'); }
  const d = corpo?.data;
  if (!d || typeof d !== 'object') throw new ErroResposta('resposta sem o envelope { data }');
  if (d.formato !== FORMATO) throw new ErroResposta(`formato inesperado (esperado ${FORMATO})`);
  if (d.versao !== 1) throw new ErroResposta('versão do formato não suportada');
  if (!Array.isArray(d.selos)) throw new ErroResposta('selos não é uma lista');
  if (d.selos.length > MAX_SELOS_RESPOSTA) throw new ErroResposta('selos demais na resposta');
  const hoje = diaBrt(agora);
  const selos = d.selos.map((s, i) => selo(s, `selos[${i}]`, ErroResposta));
  const vistos = new Set();
  for (const s of selos) {
    if (s.data > hoje) throw new ErroResposta(`selo com data no futuro (${s.data})`);
    if (vistos.has(s.data)) throw new ErroResposta(`data repetida na resposta (${s.data})`);
    vistos.add(s.data);
  }
  return selos.sort((a, b) => (a.data < b.data ? -1 : 1));
}

/** Lê o selos.jsonl: uma linha JSON por dia ancorado, terminada em \n, sem data repetida. */
export function lerArquivo(texto) {
  if (texto === '') return [];
  if (!texto.endsWith('\n')) throw new ErroArquivo('o arquivo não termina em quebra de linha (linha truncada?)');
  const linhas = texto.slice(0, -1).split('\n');
  const vistos = new Set();
  return linhas.map((l, i) => {
    let o;
    try { o = JSON.parse(l); } catch { throw new ErroArquivo(`linha ${i + 1}: não é JSON`); }
    const s = selo(o, `linha ${i + 1}`, ErroArquivo);
    if (vistos.has(s.data)) throw new ErroArquivo(`linha ${i + 1}: data ${s.data} repetida`);
    vistos.add(s.data);
    return s;
  });
}

/**
 * Confere os recebidos contra os ancorados. Devolve os dias novos (em ordem de data) e as divergências. Só há o que
 * gravar se não houver divergência nenhuma (tudo ou nada).
 *
 * Divergências:
 *  - valor_alterado: dia já ancorado volta com seq, hash ou total diferente (a reescrita que a âncora existe para pegar)
 *  - selo_sumiu: dia ancorado dentro do intervalo da resposta não veio (selo_cadeia não aceita DELETE)
 *  - seq_regrediu: em ordem de data, o seq de um dia é menor que o de um dia anterior
 *  - mesmo_seq_hash_diferente: dois dias com o mesmo seq (dia sem evento) e hashes diferentes
 */
export function mesclar(ancorados, recebidos) {
  const porData = new Map(ancorados.map((s) => [s.data, s]));
  const divergencias = [];
  const novos = [];
  for (const r of recebidos) {
    const a = porData.get(r.data);
    if (!a) { novos.push(r); continue; }
    if (a.seq !== r.seq || a.hash !== r.hash || a.totalDoDia !== r.totalDoDia) {
      divergencias.push({ tipo: 'valor_alterado', data: r.data, ancorado: a, recebido: r });
    }
  }
  if (recebidos.length) {
    const min = recebidos[0].data;
    const max = recebidos[recebidos.length - 1].data;
    const recebidas = new Set(recebidos.map((r) => r.data));
    for (const a of ancorados) {
      if (a.data >= min && a.data <= max && !recebidas.has(a.data)) divergencias.push({ tipo: 'selo_sumiu', data: a.data, ancorado: a });
    }
  }
  // História completa (ancorados + novos), em ordem de data: o seq só cresce e um seq tem um hash só.
  const todos = [...ancorados, ...novos].sort((x, y) => (x.data < y.data ? -1 : 1));
  const hashDoSeq = new Map();
  for (let i = 0; i < todos.length; i++) {
    const s = todos[i];
    if (i > 0 && s.seq < todos[i - 1].seq) divergencias.push({ tipo: 'seq_regrediu', data: s.data, anterior: todos[i - 1], atual: s });
    const h = hashDoSeq.get(s.seq);
    if (h && h.hash !== s.hash) divergencias.push({ tipo: 'mesmo_seq_hash_diferente', data: s.data, anterior: h, atual: s });
    else if (!h) hashDoSeq.set(s.seq, s);
  }
  return { novos: divergencias.length ? [] : novos, divergencias };
}

/** Linha gravada no arquivo: os quatro campos conferidos, quando e em que execução do Actions foi ancorado. */
export const linhaJsonl = (s, ancoradoEm, execucao) =>
  `${JSON.stringify({ data: s.data, seq: s.seq, hash: s.hash, totalDoDia: s.totalDoDia, ancoradoEm, execucao: execucao ?? null })}\n`;

const fmt = (s) => (s ? `seq ${s.seq}, hash \`${s.hash}\`, total ${s.totalDoDia}` : '(ausente)');

/** Relatório em Markdown para a issue. Só valores já validados (datas, inteiros, hex): nada vindo cru da resposta. */
export function relatorio(divergencias, contexto) {
  const linhas = [
    '## Divergência na âncora do selo diário',
    '',
    'A API devolveu, para dia(s) já ancorado(s) neste repositório, valores que não coincidem com os commitados no branch',
    '`ancoras`. A âncora existe exatamente para isto: um hash ancorado em D que muda depois de D indica que a trilha de',
    'acessos foi reescrita (ou que selos foram apagados ou alterados no banco). **Nada foi gravado nesta execução.**',
    '',
    `Execução: ${contexto.execucao ?? '(local)'} · conferido em ${contexto.agora}`,
    '',
    '| Tipo | Data | Ancorado | Recebido agora |',
    '|---|---|---|---|',
  ];
  for (const d of divergencias) {
    if (d.tipo === 'valor_alterado') linhas.push(`| valor alterado | ${d.data} | ${fmt(d.ancorado)} | ${fmt(d.recebido)} |`);
    else if (d.tipo === 'selo_sumiu') linhas.push(`| selo sumiu da API | ${d.data} | ${fmt(d.ancorado)} | (ausente) |`);
    else if (d.tipo === 'seq_regrediu') linhas.push(`| seq regrediu | ${d.data} | anterior (${d.anterior.data}): ${fmt(d.anterior)} | ${fmt(d.atual)} |`);
    else if (d.tipo === 'arquivo_invalido') linhas.push(`| arquivo de âncoras inválido | - | ${d.mensagem} | - |`);
    else linhas.push(`| mesmo seq, hash diferente | ${d.data} | ${d.anterior.data}: ${fmt(d.anterior)} | ${fmt(d.atual)} |`);
  }
  linhas.push(
    '',
    '### O que fazer',
    '',
    '1. **Não** altere nem apague o branch `ancoras` nem esta issue: eles são a prova.',
    '2. Exporte a trilha completa no sistema (Histórico, "Exportar trilha") e rode o verificador contra o arquivo de',
    '   âncoras: `node dist/cli/verificar-ancoras.js trilha.jsonl selos.jsonl` (ver `docs/deploy.md`).',
    '3. Preserve o servidor (backup do volume do banco e dos logs) antes de qualquer correção, e avise o síndico.',
    '',
    'Enquanto a divergência não for explicada, o workflow continua falhando e comentando aqui todos os dias.',
  );
  return `${linhas.join('\n')}\n`;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith('--') || argv[i + 1] === undefined) throw new ErroResposta(`argumento inválido: ${k ?? ''}`);
    o[k.slice(2)] = argv[i + 1];
  }
  if (!o.resposta || !o.arquivo) throw new ErroResposta('uso: --resposta <arquivo> --arquivo <selos.jsonl> [--relatorio <md>] [--execucao <id>]');
  return o;
}

function saida(nome, valor) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${nome}=${valor}\n`);
}

export function principal(argv, agora = new Date()) {
  const o = args(argv);
  const instante = o.agora ? new Date(o.agora) : agora;
  const contexto = { execucao: o.execucao ?? null, agora: instante.toISOString() };
  const recebidos = validarResposta(readFileSync(o.resposta, 'utf8'), instante);
  const original = existsSync(o.arquivo) ? readFileSync(o.arquivo, 'utf8') : '';
  let ancorados;
  try {
    ancorados = lerArquivo(original);
  } catch (e) {
    if (!(e instanceof ErroArquivo)) throw e;
    const divergencias = [{ tipo: 'arquivo_invalido', mensagem: e.message }];
    if (o.relatorio) writeFileSync(o.relatorio, relatorio(divergencias, contexto));
    return { codigo: 2, novos: [], divergencias };
  }
  const { novos, divergencias } = mesclar(ancorados, recebidos);
  if (divergencias.length) {
    if (o.relatorio) writeFileSync(o.relatorio, relatorio(divergencias, contexto));
    return { codigo: 2, novos: [], divergencias };
  }
  if (novos.length) {
    appendFileSync(o.arquivo, novos.map((s) => linhaJsonl(s, contexto.agora, contexto.execucao)).join(''));
    // O que estava lá continua byte a byte no começo do arquivo (defesa contra erro de programação aqui).
    if (!readFileSync(o.arquivo, 'utf8').startsWith(original)) throw new Error('o arquivo de âncoras não terminou como append do original');
  }
  return { codigo: 0, novos, divergencias: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = principal(process.argv.slice(2));
    saida('novos', String(r.novos.length));
    saida('divergencia', r.codigo === 2 ? 'true' : 'false');
    if (r.novos.length) saida('intervalo', `${r.novos[0].data} a ${r.novos[r.novos.length - 1].data}`);
    if (r.codigo === 2) {
      console.error(`::error::divergência na âncora (${r.divergencias.map((d) => `${d.tipo} ${d.data ?? ''}`.trim()).join('; ')}): nada gravado`);
    } else {
      console.log(r.novos.length ? `anexados ${r.novos.length} dia(s): ${r.novos.map((s) => s.data).join(', ')}` : 'nenhum dia novo; os já ancorados conferem');
    }
    process.exitCode = r.codigo;
  } catch (e) {
    saida('novos', '0');
    saida('divergencia', 'false');
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
