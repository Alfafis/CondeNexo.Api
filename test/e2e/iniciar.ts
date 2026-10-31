// Ponto de entrada do modo e2e: `npm run dev:pglite` (porta em PORTA_E2E, padrão 3101; senha em E2E_SENHA).
import 'reflect-metadata';
import { iniciarServidorE2e } from './servidor';

const porta = Number(process.env.PORTA_E2E ?? 3101);
iniciarServidorE2e({ porta, senha: process.env.E2E_SENHA }).then(
  (s) => {
    console.log(`API de e2e (PGlite em memória, dados fictícios) em ${s.url}`);
    const sair = () => { void s.fechar().finally(() => process.exit(0)); };
    process.once('SIGINT', sair);
    process.once('SIGTERM', sair);
  },
  (erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : erro);
    process.exit(1);
  },
);
