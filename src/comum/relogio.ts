// Relógio injetável: sessão e limite de login comparam instantes do relógio da API (os testes avançam o tempo).
export const RELOGIO = Symbol('RELOGIO');

export interface Relogio {
  agora(): Date;
}

export const relogioDoSistema: Relogio = { agora: () => new Date() };
