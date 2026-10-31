// Documento OpenAPI da API atual (usado pelo CLI `npm run openapi` e pelo teste de desatualização).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gerarOpenApiComRelatorio } from '../../src/openapi/gerar-openapi';
import { appSemBanco } from './app-sem-banco';
import { criarConversorRespostas } from './respostas';

const RAIZ_API = fileURLToPath(new URL('../..', import.meta.url));
export const ARQUIVO_OPENAPI = join(RAIZ_API, 'docs', 'api', 'openapi.json');

export async function documentoAtual(aviso?: (m: string) => void) {
  const versao = (JSON.parse(readFileSync(join(RAIZ_API, 'package.json'), 'utf8')) as { version: string }).version;
  const app = await appSemBanco();
  try {
    return gerarOpenApiComRelatorio(app, { versao, aviso, respostas: criarConversorRespostas() });
  } finally {
    await app.close();
  }
}
