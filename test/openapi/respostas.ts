// Schemas de RESPOSTA do OpenAPI, tirados do tipo de retorno de cada handler pelo próprio compilador TypeScript (o que o
// controller devolve é o que o EnvelopeInterceptor põe em `data`). Sem anotação à mão: mudou o retorno, mudou o contrato,
// e o teste de desatualização (test/openapi.test.ts) acusa. O CondeNexo.Front gera os tipos dele deste documento.
//
// Conversão (o que JSON.stringify faz com o valor): Date -> string date-time; propriedade opcional ou `| undefined` -> fora
// do `required`; função -> ignorada; `Pagina<T>` (comum/pagina.ts) -> envelope paginado com itens T. Tipo nomeado
// declarado em src/ (interface ou alias sem parâmetro) vira `components.schemas.<Nome>` com $ref; o resto vai inline.
// `unknown` vira `{}` (qualquer JSON); `any` também, mas entra em `avisos` (o teste exige zero).
//
// Fica em test/ (fora do build): usa o compilador, que é dependência de desenvolvimento.
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Json = Record<string, unknown>;

export interface RespostaHandler {
  /** Schema do conteúdo de `data` (no paginado, de cada item). null: o handler não devolve corpo (void). */
  schema: Json | null;
  paginado: boolean;
}

export interface ConversorRespostas {
  resposta(controller: string, metodo: string): RespostaHandler | undefined;
  componentes(): Record<string, Json>;
  avisos: string[];
}

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(RAIZ, 'src') + sep;

export function criarConversorRespostas(): ConversorRespostas {
  const cfg = ts.readConfigFile(join(RAIZ, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, RAIZ);
  const arquivos = parsed.fileNames.filter((f) => f.startsWith(SRC));
  const programa = ts.createProgram(arquivos, { ...parsed.options, noEmit: true });
  const checker = programa.getTypeChecker();

  // Classe de controller por nome (os nomes são únicos na API; repetido = aviso e fica o primeiro).
  const classes = new Map<string, ts.ClassDeclaration>();
  const avisos: string[] = [];
  for (const sf of programa.getSourceFiles()) {
    if (!sf.fileName.startsWith(SRC)) continue;
    ts.forEachChild(sf, function visitar(n) {
      if (ts.isClassDeclaration(n) && n.name) {
        if (classes.has(n.name.text) && n.name.text.endsWith('Controller')) avisos.push(`controller repetido: ${n.name.text}`);
        else classes.set(n.name.text, n);
      }
    });
  }

  const componentes: Record<string, Json> = {};
  /** Nome do componente -> declaração (para detectar homônimos de arquivos diferentes). */
  const donos = new Map<string, ts.Declaration>();
  const emConversao = new Set<string>();

  const declDe = (s: ts.Symbol | undefined) => s?.declarations?.[0];
  const doSrc = (d: ts.Declaration | undefined) => !!d && d.getSourceFile().fileName.startsWith(SRC);

  /** Nome estável do tipo nomeado (interface/classe ou alias sem parâmetro declarado em src/), ou null se for anônimo. */
  function nomeDe(t: ts.Type): string | null {
    let s: ts.Symbol | undefined;
    if (t.aliasSymbol && !t.aliasTypeArguments?.length) s = t.aliasSymbol;
    else if (!t.aliasSymbol && t.symbol && (t.flags & ts.TypeFlags.Object)) {
      const of = (t as ts.ObjectType).objectFlags;
      const generico = (of & ts.ObjectFlags.Reference) && ((t as ts.TypeReference).typeArguments?.length ?? 0) > 0;
      if ((of & (ts.ObjectFlags.Interface | ts.ObjectFlags.Class)) && !generico) s = t.symbol;
    }
    const d = declDe(s);
    if (!s || !doSrc(d)) return null;
    let nome = s.name;
    const dono = donos.get(nome);
    if (dono && dono !== d) {
      const arquivo = relative(SRC, d!.getSourceFile().fileName).replace(/\.ts$/, '').replace(/[^A-Za-z0-9]+/g, '_');
      nome = `${nome}_${arquivo}`;
    }
    donos.set(nome, d!);
    return nome;
  }

  const ehDate = (t: ts.Type) => t.symbol?.name === 'Date' && !doSrc(declDe(t.symbol));
  const ehPagina = (t: ts.Type) => t.symbol?.name === 'Pagina' && doSrc(declDe(t.symbol));
  const semUndefined = (t: ts.Type): ts.Type[] => (t.isUnion() ? t.types : [t]).filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));

  function converter(t: ts.Type, onde: string): Json {
    const nome = nomeDe(t);
    if (nome) {
      if (!componentes[nome] && !emConversao.has(nome)) {
        emConversao.add(nome);
        componentes[nome] = converterEstrutura(t, nome);
        emConversao.delete(nome);
      }
      return { $ref: `#/components/schemas/${nome}` };
    }
    return converterEstrutura(t, onde);
  }

  function uniao(membros: ts.Type[], onde: string): Json {
    const nulo = membros.some((m) => m.flags & ts.TypeFlags.Null);
    const resto = membros.filter((m) => !(m.flags & ts.TypeFlags.Null));
    const bools = resto.filter((m) => m.flags & ts.TypeFlags.BooleanLiteral);
    const strs = resto.filter((m) => m.flags & ts.TypeFlags.StringLiteral);
    const nums = resto.filter((m) => m.flags & ts.TypeFlags.NumberLiteral);
    const outros = resto.filter((m) => !(m.flags & (ts.TypeFlags.BooleanLiteral | ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)));
    const partes: Json[] = [];
    if (bools.length === 2) partes.push({ type: 'boolean' });
    else for (const b of bools) partes.push({ type: 'boolean', const: checker.typeToString(b) === 'true' });
    if (strs.length) partes.push({ type: 'string', enum: strs.map((x) => (x as ts.StringLiteralType).value).sort() });
    if (nums.length) partes.push({ type: 'number', enum: nums.map((x) => (x as ts.NumberLiteralType).value).sort((a, b) => a - b) });
    for (const o of outros) partes.push(converter(o, onde));
    if (nulo) {
      // `X | null` com X simples: type: [X, 'null'] (enum ganha o null); senão anyOf com {type:'null'}.
      const so = partes.length === 1 ? partes[0]! : null;
      if (so && typeof so.type === 'string' && !so.$ref) {
        const r: Json = { ...so, type: [so.type, 'null'] };
        if (Array.isArray(so.enum)) r.enum = [...so.enum, null];
        return r;
      }
      partes.push({ type: 'null' });
    }
    return partes.length === 1 ? partes[0]! : { anyOf: partes };
  }

  function converterEstrutura(t: ts.Type, onde: string): Json {
    const f = t.flags;
    // `unknown` declarado é escolha (snapshot JSON da trilha: qualquer valor); `any` é buraco no tipo e vira aviso.
    if (f & ts.TypeFlags.Unknown) return {};
    if (f & ts.TypeFlags.Any) { avisos.push(`${onde}: tipo any sem forma (virou {})`); return {}; }
    if (f & ts.TypeFlags.Never) return { not: {} };
    if (t.isUnion()) {
      const membros = semUndefined(t);
      // Alias de união só de literais (CategoriaPessoa, Papel...): um enum.
      return uniao(membros, onde);
    }
    if (f & ts.TypeFlags.StringLiteral) return { type: 'string', const: (t as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { type: 'number', const: (t as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: checker.typeToString(t) === 'true' };
    if (f & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) return { type: 'string' };
    if (f & ts.TypeFlags.Number) return { type: 'number' };
    if (f & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (f & ts.TypeFlags.Null) return { type: 'null' };
    if (f & ts.TypeFlags.BigInt) { avisos.push(`${onde}: bigint não é JSON`); return { type: 'string' }; }
    if (ehDate(t)) return { type: 'string', format: 'date-time' };
    if (checker.isArrayType(t) || checker.isTupleType(t)) {
      const args = checker.getTypeArguments(t as ts.TypeReference);
      if (checker.isTupleType(t)) return { type: 'array', prefixItems: args.map((a, i) => converter(a, `${onde}[${i}]`)), minItems: args.length, maxItems: args.length };
      return { type: 'array', items: converter(args[0]!, `${onde}[]`) };
    }
    if (ehPagina(t)) { avisos.push(`${onde}: Pagina aninhada (só vale como retorno do handler)`); return {}; }
    if (f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
      const props: Record<string, Json> = {};
      const obrig: string[] = [];
      for (const p of checker.getPropertiesOfType(t)) {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const tp = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
        if (tp.getCallSignatures().length && !(tp.flags & ts.TypeFlags.Union)) continue; // método: JSON ignora
        const comUndefined = tp.isUnion() && tp.types.some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
        const opcional = !!(p.flags & ts.SymbolFlags.Optional) || comUndefined;
        const so = semUndefined(tp);
        if (!so.length) continue; // só undefined: some no JSON
        // Sem undefined, o tipo vai inteiro (mantém o nome do alias); com ele, o resto da união.
        props[p.name] = !comUndefined ? converter(tp, `${onde}.${p.name}`)
          : so.length === 1 ? converter(so[0]!, `${onde}.${p.name}`) : uniao(so, `${onde}.${p.name}`);
        if (!opcional) obrig.push(p.name);
      }
      const r: Json = { type: 'object', properties: props };
      if (obrig.length) r.required = obrig;
      const idx = checker.getIndexInfoOfType(t, ts.IndexKind.String);
      r.additionalProperties = idx ? converter(idx.type, `${onde}[*]`) : false;
      if (!Object.keys(props).length && !idx && t.getCallSignatures().length === 0 && !(f & ts.TypeFlags.Intersection)
        && checker.typeToString(t) !== '{}') avisos.push(`${onde}: objeto sem propriedades (${checker.typeToString(t)})`);
      return r;
    }
    avisos.push(`${onde}: tipo não suportado ${checker.typeToString(t)}`);
    return {};
  }

  function resposta(controller: string, metodo: string): RespostaHandler | undefined {
    const cls = classes.get(controller);
    const m = cls?.members.find((x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && !!x.name && x.name.getText() === metodo);
    if (!m) { avisos.push(`${controller}.${metodo}: handler não encontrado no código-fonte`); return undefined; }
    const sig = checker.getSignatureFromDeclaration(m);
    if (!sig) return undefined;
    let t = checker.getReturnTypeOfSignature(sig);
    t = checker.getAwaitedType(t) ?? t;
    const onde = `${controller}.${metodo}`;
    if (t.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return { schema: null, paginado: false };
    if (ehPagina(t)) {
      const item = checker.getTypeArguments(t as ts.TypeReference)[0];
      return { schema: item ? converter(item, `${onde}[]`) : {}, paginado: true };
    }
    return { schema: converter(t, onde), paginado: false };
  }

  return {
    resposta,
    componentes: () => Object.fromEntries(Object.keys(componentes).sort().map((k) => [k, componentes[k]!])),
    avisos,
  };
}
