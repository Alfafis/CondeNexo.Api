// Trava de desatualização do OpenAPI: docs/api/openapi.json (versionado) precisa bater com o que o gerador produz hoje
// a partir dos controllers e dos schemas Zod. Se falhar: `npm run openapi` e `npm run colecoes`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARQUIVO_OPENAPI, documentoAtual } from './openapi/documento-atual';
import { serializarOpenApi } from './openapi/serializar';

type Operacao = { operationId: string; security?: unknown[] };
const operacoes = (doc: { paths: Record<string, Record<string, Operacao>> }) =>
  Object.entries(doc.paths).flatMap(([caminho, ops]) => Object.entries(ops).map(([verbo, op]) => ({ caminho, verbo, op })));

describe('OpenAPI gerado dos metadados do Nest', () => {
  it('o arquivo versionado está atualizado', async () => {
    const { documento } = await documentoAtual(() => undefined);
    let versionado = '';
    try { versionado = readFileSync(ARQUIVO_OPENAPI, 'utf8'); } catch { /* ausente: falha abaixo com a instrução */ }
    expect(serializarOpenApi(documento) === versionado, 'docs/api/openapi.json desatualizado: rode npm run openapi').toBe(true);
  }, 60_000);

  it('toda rota tem operationId único e nenhum schema caiu em fallback', async () => {
    const { documento, relatorio } = await documentoAtual(() => undefined);
    const ops = operacoes(documento as never);
    expect(ops.length).toBe(relatorio.rotas);
    const ids = ops.map((o) => o.op.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(relatorio.schemasFallback).toEqual([]);
    expect(relatorio.avisos.filter((a) => a.includes('sem política'))).toEqual([]);
    // Toda resposta com corpo JSON tem o `data` descrito (tipo de retorno do handler), sem `any` nem handler perdido.
    expect(relatorio.avisos.filter((a) => a.startsWith('resposta:'))).toEqual([]);
  }, 60_000);

  it('as respostas descrevem o conteúdo de `data` (nenhuma fica no envelope genérico)', async () => {
    const { documento } = await documentoAtual(() => undefined);
    const ops = operacoes(documento as never) as unknown as { caminho: string; verbo: string; op: { responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> } }[];
    const genericas = ops.filter(({ op }) => Object.entries(op.responses).some(([c, r]) => c.startsWith('2')
      && /\/Envelope(Paginado)?$/.test(r.content?.['application/json']?.schema?.$ref ?? '')))
      .map(({ verbo, caminho }) => `${verbo} ${caminho}`);
    expect(genericas).toEqual([]);
    const me = (documento as never as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> }).paths['/auth/me']!.get!;
    expect(JSON.stringify(me.responses['200'])).toContain('#/components/schemas/PermissoesSessao');
  }, 60_000);

  it('o login é público (sem security) e as demais rotas protegidas exigem o cookie', async () => {
    const { documento } = await documentoAtual(() => undefined);
    const doc = documento as never as { paths: Record<string, Record<string, Operacao>> };
    const login = doc.paths['/auth/login']?.post;
    expect(login).toBeDefined();
    expect(login).not.toHaveProperty('security');
    expect(doc.paths['/auth/me']?.get?.security).toEqual([{ sessao: [] }]);
  }, 60_000);
});
