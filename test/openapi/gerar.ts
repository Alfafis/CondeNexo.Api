// CLI: `npm run openapi` grava docs/api/openapi.json e imprime o relatório.
// Fica em test/ (fora do tsconfig.build.json): usa o módulo de teste do Nest, que não existe na imagem de produção.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ARQUIVO_OPENAPI, documentoAtual } from './documento-atual';
import { serializarOpenApi } from './serializar';

const { documento, relatorio } = await documentoAtual();
mkdirSync(dirname(ARQUIVO_OPENAPI), { recursive: true });
writeFileSync(ARQUIVO_OPENAPI, serializarOpenApi(documento));
console.log(`openapi: ${relatorio.rotas} rotas, ${relatorio.comSchemaDeEntrada} com schema Zod de entrada`);
console.log(`openapi: ${relatorio.schemasParciais.length} schemas parciais, ${relatorio.schemasFallback.length} em fallback`);
if (relatorio.semSchema.length) {
  console.log('openapi: rotas com @Body/@Query sem ZodPipe:');
  for (const s of relatorio.semSchema) console.log(`  ${s.rota} (${s.faltando.join(', ')})`);
}
process.exit(0);
