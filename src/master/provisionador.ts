// Como a API pede um provisionamento (POST /plataforma/condominios). A API NÃO cria banco nem roda migração: isso exige
// as credenciais de app_provisionador (CREATEDB + SET app_migrator) e de app_migrator (dono de TODOS os bancos de
// condomínio, inclusive das trilhas append-only), e um processo exposto à internet com essas senhas transformaria uma
// invasão da API em adulteração de trilha e DROP DATABASE (docs/05_arquitetura_saas.md SAAS-10, "A API não cria banco").
//
// Por isso a API chama o SERVIÇO provisionador (src/cli/servidor-provisionador.ts): o mesmo `provisionar()` da CLI, num
// container separado, só na rede interna do compose, ligado sob demanda (perfil `provisionar`), com um token
// compartilhado. A interface dele é só "provisione esta entrada": quem invadir a API consegue, no máximo, criar um
// condomínio novo (e isso fica na trilha da plataforma), não tocar nos existentes.
//
// Desligado (PROVISIONADOR_URL vazia ou serviço parado): 503 PROVISIONADOR_INDISPONIVEL e a CLI continua valendo.
import type { ResultadoProvisionamento } from '../saas/provisionar';
import { ErroProvisionamento } from '../saas/provisionar';

export const PROVISIONADOR = Symbol('PROVISIONADOR');

export class ProvisionadorIndisponivel extends Error {}

export interface Provisionador {
  /** Há para onde mandar (configurado). Não garante que o serviço esteja de pé. */
  configurado(): boolean;
  /**
   * O serviço está de pé e aceita o token (GET /saude, timeout curto). Nunca lança: qualquer falha é `false`. Serve à
   * tela do Master para não deixar preencher tudo e só descobrir no envio que o provisionador está desligado.
   */
  disponivel(): Promise<boolean>;
  /** `entrada` = o JSON da CLI (validado de novo do outro lado). Lança ErroProvisionamento (recusa) ou ProvisionadorIndisponivel. */
  provisionar(entrada: unknown, masterUsuarioId: string): Promise<ResultadoProvisionamento>;
}

/** Tempo máximo de um provisionamento (CREATE DATABASE + migrações + argon2): folgado, mas não infinito. */
export const TEMPO_MAXIMO_MS = 120_000;
export const TOKEN_MINIMO = 32;
/** Tempo máximo da consulta de saúde: a tela espera por ela. */
export const TEMPO_SAUDE_MS = 3_000;

export class ProvisionadorHttp implements Provisionador {
  constructor(private readonly url: string | null, private readonly token: string | null, private readonly buscar: typeof fetch = fetch) {}

  configurado() { return !!this.url && !!this.token; }

  async disponivel(): Promise<boolean> {
    if (!this.url || !this.token) return false;
    try {
      const r = await this.buscar(`${this.url}/saude`, {
        method: 'GET', headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(TEMPO_SAUDE_MS),
      });
      await r.body?.cancel().catch(() => undefined);
      return r.status === 200;
    } catch {
      return false;
    }
  }

  async provisionar(entrada: unknown, masterUsuarioId: string): Promise<ResultadoProvisionamento> {
    if (!this.url || !this.token) throw new ProvisionadorIndisponivel('provisionador não configurado');
    let r: Response;
    try {
      r = await this.buscar(`${this.url}/provisionar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ entrada, masterUsuarioId }),
        signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
      });
    } catch {
      throw new ProvisionadorIndisponivel('provisionador fora do ar');
    }
    const corpo = (await r.json().catch(() => null)) as { erro?: unknown; resultado?: ResultadoProvisionamento } | null;
    if (r.status === 200 && corpo?.resultado) return corpo.resultado;
    if (r.status === 422) throw new ErroProvisionamento(typeof corpo?.erro === 'string' ? corpo.erro : 'provisionamento recusado');
    if (r.status === 409) throw new ProvisionamentoOcupado();
    throw new ProvisionadorIndisponivel(`provisionador respondeu ${r.status}`);
  }
}

export class ProvisionamentoOcupado extends Error {}

/** PROVISIONADOR_URL (http://<serviço>:<porta>, rede interna) e PROVISIONADOR_TOKEN (32+ caracteres). Vazias: desligado. */
export function provisionadorDoAmbiente(env: NodeJS.ProcessEnv): Provisionador {
  const url = env.PROVISIONADOR_URL?.trim() || null;
  const token = env.PROVISIONADOR_TOKEN?.trim() || null;
  if (!url && !token) return new ProvisionadorHttp(null, null);
  if (!url || !token) throw new Error('PROVISIONADOR_URL e PROVISIONADOR_TOKEN vão juntas');
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('PROVISIONADOR_URL inválida'); }
  // http em claro só faz sentido dentro da rede do compose; nada de caminho, usuário ou query na URL.
  if (u.protocol !== 'http:' || u.pathname !== '/' || u.search || u.username || u.password) throw new Error('PROVISIONADOR_URL deve ser http://<serviço>:<porta>');
  if (token.length < TOKEN_MINIMO) throw new Error(`PROVISIONADOR_TOKEN precisa de pelo menos ${TOKEN_MINIMO} caracteres`);
  return new ProvisionadorHttp(u.origin, token);
}
