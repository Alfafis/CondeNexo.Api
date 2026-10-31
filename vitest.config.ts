import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Cada arquivo sobe um PGlite (Postgres em WASM) e aplica as migrações reais.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // A API loga uma linha JSON por requisição (comum/log.ts): fora do relatório, exceto erro.
    onConsoleLog: (linha, tipo) => !(tipo === 'stdout' && linha.startsWith('{"em":')),
  },
});
