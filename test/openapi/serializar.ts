/** JSON formatado com newline final: o formato do arquivo versionado (e o que o teste compara). */
export const serializarOpenApi = (documento: unknown) => `${JSON.stringify(documento, null, 2)}\n`;
