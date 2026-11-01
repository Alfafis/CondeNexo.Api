// Gerador de OpenAPI 3.1 a partir dos metadados do Nest (sem @nestjs/swagger): rotas por PATH_METADATA/METHOD_METADATA,
// entrada por ROUTE_ARGS_METADATA (pipes ZodPipe -> z.toJSONSchema) e autorização por POLITICA. O arquivo gerado é
// versionado (docs/api/openapi.json) e um teste falha se ele divergir da API.
//
// Só LÊ metadados: não abre porta, não toca em banco nem em .env. Nenhuma rota chama este código em produção.
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA, HTTP_CODE_METADATA, RESPONSE_PASSTHROUGH_METADATA } from '@nestjs/common/constants';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { z } from 'zod';
import { POLITICA, type Politica } from '../auth/decorators';
import { CAMINHO_COOKIE_MASTER, nomeCookieMaster } from '../plataforma/cookie-master';
import { MOTIVO_LEITURA, POLITICA_MASTER, type PoliticaMaster } from '../plataforma/decorators';
import { ZodPipe } from '../comum/zod.pipe';
import { PREFIXO_GLOBAL } from '../configurar-app';

type Json = Record<string, unknown>;

export const SERVIDOR_PRODUCAO = `https://api.condenexo.com.br/${PREFIXO_GLOBAL}`;
/** Porta padrão do modo local `dev:pglite` (test/e2e/iniciar.ts: PORTA_E2E, padrão 3101). */
export const SERVIDOR_LOCAL = `http://127.0.0.1:3101/${PREFIXO_GLOBAL}`;
export const COOKIE_PRODUCAO = '__Host-portaria_sessao';
export const COOKIE_LOCAL = 'portaria_sessao';
/** Campo do multipart do anexo de ocorrência (FileInterceptor('arquivo'); o nome fica escondido na closure do mixin). */
const CAMPO_UPLOAD = 'arquivo';

const METODOS: Partial<Record<number, string>> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch', [RequestMethod.DELETE]: 'delete',
};
const ORDEM_METODOS = ['get', 'post', 'put', 'patch', 'delete'];

export interface RelatorioOpenApi {
  rotas: number;
  /** Rotas com ao menos um schema Zod de entrada (body, query ou param). */
  comSchemaDeEntrada: number;
  /** Rotas que recebem @Body/@Query sem ZodPipe (entrada não documentada). */
  semSchema: { rota: string; faltando: string[] }[];
  /** Schemas que só converteram com `unrepresentable: 'any'` (parte virou `{}`). */
  schemasParciais: string[];
  /** Schemas que falharam por completo e viraram `{}`. */
  schemasFallback: string[];
  avisos: string[];
}

/** Schema do `data` de um handler (o gerador de verdade é test/openapi/respostas.ts, com o compilador TypeScript). */
export interface FonteRespostas {
  resposta(controller: string, metodo: string): { schema: Json | null; paginado: boolean } | undefined;
  componentes(): Record<string, Json>;
  avisos: string[];
}

export interface OpcoesOpenApi {
  versao?: string;
  /** Sem ela, as respostas saem como envelope genérico (`data` sem forma). */
  respostas?: FonteRespostas;
  /** Recebe os avisos (padrão: console.warn). */
  aviso?: (msg: string) => void;
}

const erroRef = (codigo: number) => ({ $ref: `#/components/responses/Erro${codigo}` });
const CODIGOS_ERRO: [number, string][] = [
  [400, 'Dados inválidos (`DADOS_INVALIDOS`).'], [401, 'Sem sessão válida.'], [403, 'Sem permissão para a ação.'],
  [404, 'Recurso não encontrado.'], [409, 'Conflito com o estado atual.'], [422, 'Regra de negócio violada.'],
  [429, 'Muitas requisições (limite de taxa).'],
];

function jsonSchema(schema: z.ZodType, rotulo: string, rel: RelatorioOpenApi): Json {
  const limpar = (s: Json) => { delete s.$schema; return s; };
  try {
    return limpar(z.toJSONSchema(schema, { io: 'input' }) as Json);
  } catch { /* transform/refine/custom: tenta de novo tolerando o que não tem representação */ }
  try {
    const s = limpar(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json);
    rel.schemasParciais.push(rotulo);
    rel.avisos.push(`schema parcial (parte sem representação virou {}): ${rotulo}`);
    return s;
  } catch (e) {
    rel.schemasFallback.push(rotulo);
    rel.avisos.push(`schema em fallback {} (${e instanceof Error ? e.message : String(e)}): ${rotulo}`);
    return {};
  }
}

const caminhoOpenApi = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const juntar = (...partes: string[]) => '/' + partes.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
const comoLista = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : ''));

function politicaDe(alvo: object, metodo: object): Politica | undefined {
  return (Reflect.getMetadata(POLITICA, metodo) ?? Reflect.getMetadata(POLITICA, alvo)) as Politica | undefined;
}

export function gerarOpenApiComRelatorio(app: INestApplication, opcoes: OpcoesOpenApi = {}): { documento: Json; relatorio: RelatorioOpenApi } {
  const rel: RelatorioOpenApi = { rotas: 0, comSchemaDeEntrada: 0, semSchema: [], schemasParciais: [], schemasFallback: [], avisos: [] };
  const paths: Record<string, Record<string, Json>> = {};
  const tagsUsadas = new Set<string>();

  const controllers = [...app.get(ModulesContainer, { strict: false }).values()]
    .flatMap((m) => [...m.controllers.values()])
    .map((w) => w.metatype as (new (...a: never[]) => object) | null)
    .filter((c): c is new (...a: never[]) => object => !!c);

  for (const ctrl of [...new Set(controllers)]) {
    const tag = ctrl.name.replace(/Controller$/, '').toLowerCase();
    const base = comoLista(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const nome of Object.getOwnPropertyNames(proto)) {
      const handler = proto[nome];
      if (nome === 'constructor' || typeof handler !== 'function') continue;
      const metodoHttp = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (metodoHttp === undefined) continue;
      const verbo = METODOS[metodoHttp];
      if (!verbo) { rel.avisos.push(`método HTTP não suportado em ${ctrl.name}.${nome}`); continue; }
      const subcaminhos = comoLista(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const politica = politicaDe(ctrl, handler);
      const argumentos = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, nome) ?? {}) as Record<string, { index: number; data?: unknown; pipes?: unknown[] }>;
      tagsUsadas.add(tag);

      for (const b of base) for (const sub of subcaminhos) {
        const caminho = caminhoOpenApi(juntar(b, sub));
        const rotulo = `${verbo.toUpperCase()} ${caminho}`;
        const parametros: Json[] = [];
        const jaTemParametro = new Set<string>();
        let requestBody: Json | undefined;
        let multipart = false;
        let binario = false;
        let temSchema = false;
        const faltando: string[] = [];

        const entradas = Object.entries(argumentos)
          .map(([chave, v]) => ({ tipo: Number(chave.split(':')[0]), ...v }))
          .sort((a, c) => a.index - c.index);
        for (const arg of entradas) {
          const pipe = (arg.pipes ?? []).find((p): p is ZodPipe<z.ZodType> => p instanceof ZodPipe);
          const schema = pipe ? (pipe as unknown as { schema: z.ZodType }).schema : undefined;
          const nomeArg = typeof arg.data === 'string' ? arg.data : undefined;
          switch (arg.tipo) {
            case RouteParamtypes.BODY: {
              if (!schema) { faltando.push('body'); break; }
              temSchema = true;
              requestBody = { required: true, content: { 'application/json': { schema: jsonSchema(schema, `${rotulo} body`, rel) } } };
              break;
            }
            case RouteParamtypes.QUERY:
            case RouteParamtypes.PARAM: {
              const onde = arg.tipo === RouteParamtypes.QUERY ? 'query' : 'path';
              if (!schema) { if (onde === 'query') faltando.push('query'); break; }
              temSchema = true;
              const js = jsonSchema(schema, `${rotulo} ${onde}`, rel);
              if (nomeArg) {
                // @Param('id', pipe): o pipe valida o valor de um parâmetro só.
                parametros.push({ name: nomeArg, in: onde, required: onde === 'path' || undefined, schema: js });
                jaTemParametro.add(`${onde}:${nomeArg}`);
              } else {
                // @Query(pipe) / @Param(pipe): o schema é um objeto, cada propriedade vira um parâmetro.
                const props = (js.properties ?? {}) as Record<string, Json>;
                const obrig = new Set((js.required ?? []) as string[]);
                for (const [k, v] of Object.entries(props)) {
                  parametros.push({ name: k, in: onde, required: onde === 'path' || obrig.has(k) || undefined, schema: v });
                  jaTemParametro.add(`${onde}:${k}`);
                }
                if (!Object.keys(props).length) rel.avisos.push(`${rotulo}: schema de ${onde} sem propriedades`);
              }
              break;
            }
            case RouteParamtypes.FILE:
            case RouteParamtypes.FILES: {
              multipart = true;
              temSchema = true;
              const campo = nomeArg ?? CAMPO_UPLOAD;
              requestBody = {
                required: true,
                content: { 'multipart/form-data': { schema: { type: 'object', properties: { [campo]: { type: 'string', format: 'binary' } }, required: [campo] } } },
              };
              break;
            }
            case RouteParamtypes.RESPONSE: {
              // @Res() sem passthrough: o handler escreve a resposta (download), fora do envelope. O Nest grava o
              // passthrough à parte (RESPONSE_PASSTHROUGH_METADATA na classe, por método), não no `data` do argumento.
              if (!Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, ctrl, nome)) binario = true;
              break;
            }
            default: break;
          }
        }
        // Parâmetros de caminho que o schema não cobriu (ex.: sem pipe): string obrigatória.
        for (const m of caminho.matchAll(/\{([^}]+)\}/g)) {
          if (!jaTemParametro.has(`path:${m[1]}`)) parametros.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
        }
        if (Reflect.getMetadata(MOTIVO_LEITURA, handler) ?? Reflect.getMetadata(MOTIVO_LEITURA, ctrl)) {
          parametros.push({
            name: 'X-Motivo-Token', in: 'header', required: true, schema: { type: 'string' },
            description: 'Token do motivo vigente, emitido por `POST /plataforma/condominios/{id}/motivo` (30 min, mesma sessão, mesmo condomínio). Ausente, vencido, de outra sessão, de outro condomínio ou adulterado: 403 `MOTIVO_NECESSARIO`.',
          });
        }
        parametros.sort((a, c) => (a.in === c.in ? 0 : a.in === 'path' ? -1 : 1) || String(a.name).localeCompare(String(c.name)));

        rel.rotas++;
        if (temSchema) rel.comSchemaDeEntrada++;
        if (faltando.length) rel.semSchema.push({ rota: rotulo, faltando });

        // Resposta de sucesso.
        const codigoOk = (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ?? (verbo === 'post' ? 201 : 200);
        const fonte = codigoOk === 204 || binario ? undefined : opcoes.respostas?.resposta(ctrl.name, nome);
        const paginada = fonte ? fonte.paginado
          : parametros.some((p) => p.in === 'query' && p.name === 'cursor') && parametros.some((p) => p.in === 'query' && p.name === 'limite');
        const respostas: Record<string, Json> = {};
        if (codigoOk === 204) respostas['204'] = { description: 'Sem conteúdo.' };
        else if (binario) respostas[String(codigoOk)] = { description: 'Arquivo (corpo binário, fora do envelope `{data}`).', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } };
        else if (fonte && fonte.schema === null) respostas[String(codigoOk)] = { description: 'Sucesso, sem corpo.' };
        else if (fonte) respostas[String(codigoOk)] = {
          description: paginada ? 'Sucesso: envelope `{data, pagination}` (listagem por cursor).' : 'Sucesso: envelope `{data}`.',
          content: { 'application/json': { schema: paginada
            ? { type: 'object', properties: { data: { type: 'array', items: fonte.schema }, pagination: { $ref: '#/components/schemas/Paginacao' } }, required: ['data', 'pagination'] }
            : { type: 'object', properties: { data: fonte.schema }, required: ['data'] } } },
        };
        else respostas[String(codigoOk)] = {
          description: paginada ? 'Sucesso: envelope `{data, pagination}` (listagem por cursor).' : 'Sucesso: envelope `{data}`.',
          content: { 'application/json': { schema: { $ref: paginada ? '#/components/schemas/EnvelopePaginado' : '#/components/schemas/Envelope' } } },
        };
        for (const [c] of CODIGOS_ERRO) respostas[String(c)] = erroRef(c);

        const op: Json = { tags: [tag], operationId: `${tag}_${nome}` };
        if (politica?.tipo === 'acao') {
          op.summary = rotulo;
          op.description = `Permissão: \`${politica.acao}\``;
          op['x-permissao'] = politica.acao;
        } else if (politica?.tipo === 'autenticado') {
          op.summary = rotulo;
          op.description = politica.permiteTrocaPendente ? 'Qualquer usuário logado (inclusive quem ainda deve trocar a senha).' : 'Qualquer usuário logado.';
        } else if (politica?.tipo === 'plataforma') {
          // App do Master (src/plataforma): política própria em POLITICA_MASTER, sessão e cookie da plataforma.
          const pm = (Reflect.getMetadata(POLITICA_MASTER, handler) ?? Reflect.getMetadata(POLITICA_MASTER, ctrl)) as PoliticaMaster | undefined;
          op.summary = rotulo;
          op.description = pm?.tipo === 'acao' ? `Plataforma (Master). Permissão: \`${pm.acao}\``
            : pm?.tipo === 'publico' ? 'Plataforma (Master). Pública: não exige sessão.'
              : 'Plataforma (Master): qualquer usuário da plataforma logado.';
          if (pm?.tipo === 'acao') op['x-permissao'] = pm.acao;
        } else {
          op.summary = rotulo;
          if (politica?.tipo === 'publico') op.description = 'Pública: não exige sessão.';
          else rel.avisos.push(`${rotulo}: sem política (@Publico/@Autenticado/@Acao); a API nega por padrão`);
        }
        if (politica?.tipo === 'plataforma') {
          const pm = (Reflect.getMetadata(POLITICA_MASTER, handler) ?? Reflect.getMetadata(POLITICA_MASTER, ctrl)) as PoliticaMaster | undefined;
          if (pm?.tipo !== 'publico') op.security = [{ sessaoPlataforma: [] }];
        } else if (politica && politica.tipo !== 'publico') op.security = [{ sessao: [] }];
        if (parametros.length) op.parameters = parametros;
        if (requestBody) op.requestBody = requestBody;
        op.responses = respostas;
        if (multipart) op['x-multipart'] = true;
        (paths[caminho] ??= {})[verbo] = op;
      }
    }
  }

  // operationId único: duas rotas no mesmo handler (path em lista) ou controllers homônimos quebrariam o contrato.
  const vistos = new Map<string, string>();
  for (const [caminho, ops] of Object.entries(paths)) for (const [verbo, op] of Object.entries(ops)) {
    const id = op.operationId as string;
    const outro = vistos.get(id);
    if (outro) { const novo = `${id}_${verbo}`; rel.avisos.push(`operationId duplicado ${id} (${outro} e ${verbo} ${caminho}): renomeado para ${novo}`); op.operationId = novo; }
    else vistos.set(id, `${verbo} ${caminho}`);
  }
  // x-multipart era só marcador interno para o gerador; não vai ao documento.
  for (const ops of Object.values(paths)) for (const op of Object.values(ops)) delete op['x-multipart'];

  const ordenarPaths: Record<string, Json> = {};
  for (const caminho of Object.keys(paths).sort()) {
    const ops = paths[caminho]!;
    ordenarPaths[caminho] = Object.fromEntries(ORDEM_METODOS.filter((m) => ops[m]).map((m) => [m, ops[m]!]));
  }

  const documento: Json = {
    openapi: '3.1.0',
    info: {
      title: 'API do CondeNexo',
      version: opcoes.versao ?? '0.0.0',
      description: [
        'Controle de acesso e gestão de portaria de condomínios (TCC). Gerada dos metadados do Nest e dos schemas Zod: não editar à mão.',
        'Sucesso sempre em `{data}` (listas por cursor: `{data, pagination:{cursor, hasNextPage}}`); erro em `Erro`.',
        'Autenticação por cookie de sessão HttpOnly/SameSite=Strict: chame `POST /auth/login` e reaproveite o cookie.',
        opcoes.respostas
          ? 'O conteúdo de `data` de cada resposta é o tipo de retorno do handler, extraído pelo compilador TypeScript (test/openapi/respostas.ts): é o contrato de que o CondeNexo.Front gera os tipos dele.'
          : 'As respostas de sucesso estão documentadas só como envelope genérico (o conteúdo de `data` não é descrito).',
      ].join('\n\n'),
    },
    servers: [
      { url: SERVIDOR_PRODUCAO, description: 'Produção no subdomínio api. (mesmo site do front em www.condenexo.com.br: o cookie SameSite=Strict é enviado; CORS com credenciais só para a origem exata do front). Escreve na trilha append-only real.' },
      { url: SERVIDOR_LOCAL, description: 'Local: `npm run dev:pglite` (PGlite em memória, dados fictícios).' },
    ],
    tags: [...tagsUsadas].sort().map((name) => ({ name })),
    paths: ordenarPaths,
    components: {
      securitySchemes: {
        sessaoPlataforma: {
          type: 'apiKey', in: 'cookie', name: nomeCookieMaster(true),
          description: `Cookie da sessão do Master (app da plataforma), Path=${CAMINHO_COOKIE_MASTER}, criado por \`POST /plataforma/auth/login\` (e-mail e senha; sem segundo fator desde 2026-10-23, SAAS-08). Nunca aceito nas rotas de condomínio, e o de condomínio nunca é aceito aqui. No modo local (http) o nome é \`${nomeCookieMaster(false)}\`.`,
        },
        sessao: {
          type: 'apiKey', in: 'cookie', name: COOKIE_PRODUCAO,
          description: `Cookie de sessão HttpOnly; SameSite=Strict, criado por \`POST /auth/login\`. Em produção (https) o nome é \`${COOKIE_PRODUCAO}\` (com Secure); no modo local (http) é \`${COOKIE_LOCAL}\` (sem Secure).`,
        },
      },
      schemas: {
        ...(opcoes.respostas?.componentes() ?? {}),
        Paginacao: {
          type: 'object',
          properties: { cursor: { type: ['string', 'null'], description: 'Cursor opaco da próxima página.' }, hasNextPage: { type: 'boolean' } },
          required: ['cursor', 'hasNextPage'],
        },
        Envelope: { type: 'object', properties: { data: {} }, required: ['data'] },
        EnvelopePaginado: {
          type: 'object',
          properties: {
            data: { type: 'array', items: {} },
            pagination: {
              type: 'object',
              properties: { cursor: { type: ['string', 'null'], description: 'Cursor opaco da próxima página.' }, hasNextPage: { type: 'boolean' } },
              required: ['cursor', 'hasNextPage'],
            },
          },
          required: ['data', 'pagination'],
        },
        Erro: {
          type: 'object',
          properties: {
            statusCode: { type: 'integer' }, error: { type: 'string' }, code: { type: 'string', description: 'Código estável, ex.: DADOS_INVALIDOS.' },
            message: { type: 'string' }, details: { description: 'Em 400: lista de {field, message}.' },
            timestamp: { type: 'string', format: 'date-time' }, path: { type: ['string', 'null'] },
          },
          required: ['statusCode', 'error', 'code', 'message', 'timestamp', 'path'],
        },
      },
      responses: Object.fromEntries(CODIGOS_ERRO.map(([c, d]) => [`Erro${c}`, {
        description: d,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Erro' } } },
      }])),
    },
  };

  if (opcoes.respostas) rel.avisos.push(...opcoes.respostas.avisos.map((a) => `resposta: ${a}`));
  const aviso = opcoes.aviso ?? ((m: string) => console.warn(`[openapi] ${m}`));
  for (const a of rel.avisos) aviso(a);
  return { documento, relatorio: rel };
}

/** Só o documento OpenAPI 3.1 (o que o teste compara com `docs/api/openapi.json`). */
export function gerarOpenApi(app: INestApplication, opcoes: OpcoesOpenApi = {}): Json {
  return gerarOpenApiComRelatorio(app, opcoes).documento;
}
