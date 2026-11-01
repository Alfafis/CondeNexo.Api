// Configuração da API, lida UMA vez do ambiente e validada no boot: valor ausente ou ambíguo derruba o processo
// em vez de virar um default silencioso (ex.: COOKIE_SECURE=1 não significa nada e é recusado).
import { Buffer } from 'node:buffer';
import { log } from '../comum/log';

export const CONFIG = Symbol('CONFIG');
/**
 * Estrutura do condomínio (`EstruturaCondominio`, database.module.ts): o nome do agrupamento que o front exibe (vai no
 * /catalogo). Por condomínio desde o provisionamento (SaaS): vem da tabela `configuracao` do banco dele, lida pelo
 * ResolvedorCondominio; sem a linha (o piloto), `ESTRUTURA_PADRAO.agrupamento`. As unidades sempre vieram do banco.
 */
export const ESTRUTURA = Symbol('ESTRUTURA');

export type Ambiente = 'dev' | 'producao';

export interface Config {
  ambiente: Ambiente;
  /** false: sem proxy (req.ip = socket). Número: quantos saltos de proxy confiáveis há na frente da API. */
  trustProxy: false | number;
  /** Origens exatas para CORS com credenciais. Vazio: CORS desligado. Produção: a origem do front (https://www.condenexo.com.br). */
  corsOrigens: string[];
  cookie: { secure: boolean; nome: string };
  /**
   * Prazos da sessão do condomínio, em minutos, por tipo de uso (spec §5.1):
   *  - `padrao`: toda sessão sem "Manter conectado", e SEMPRE a do porteiro (terminal da portaria, compartilhado
   *    por turno: sessão longa faria o porteiro seguinte registrar com a autoria do anterior);
   *  - `longa`: síndico, administração e auditor que marcaram "Manter conectado neste computador" no login.
   */
  sessao: { padrao: PrazoSessao; longa: PrazoSessao; /** intervalo mínimo entre gravações de ultimo_uso_em */ toqueSeg: number };
  login: {
    maxFalhasLogin: number;
    maxFalhasIp: number;
    janelaMin: number;
    bloqueioMin: number;
    /** atraso crescente nas falhas: base * 2^(n-1), limitado a atrasoMaxMs */
    atrasoBaseMs: number;
    atrasoMaxMs: number;
  };
  /** spec §5.1: 64 MiB, 3 iterações, paralelismo 1. `concorrencia` limita hashes simultâneos POR PROCESSO (memória). */
  argon2: { memoriaKib: number; iteracoes: number; paralelismo: number; concorrencia: number; filaMax: number };
  /**
   * Importação da planilha (RF-11, RN-09): prazo, em dias, para regularizar o vínculo legado. O valor é definido em
   * assembleia (`IMPORTACAO_PRAZO_LEGADO_DIAS`, padrão 90, de 1 a 730).
   */
  importacao: { prazoLegadoDias: number };
  /**
   * Anexos cifrados (RNF-03, spec §9.2): `dir` é a raiz dos arquivos cifrados (`PORTARIA_DOCUMENTOS_DIR`), fora do banco.
   * A KEK e a versão dela vêm do condomínio (banco plataforma, SAAS-04), não mais do ambiente (tenancy/condominio.ts).
   */
  documentos: { dir: string };
  /**
   * SaaS (docs/05_arquitetura_saas.md, fase F2):
   *  - `pilotoPadrao` (`SAAS_PILOTO_PADRAO`, padrão true): requisição sem código do condomínio e cookie sem prefixo
   *    (o formato de antes da F2) vão para o piloto. Desligar ao fim da transição (SAAS-05): aí ficam sem condomínio.
   *  - `chavesAmbiente`: as chaves antigas do ambiente (`PORTARIA_HMAC_CPF_KEY`, `PORTARIA_KEK`, `PORTARIA_KEK_VERSAO`),
   *    OPCIONAIS e só para conferir no boot contra as do piloto na plataforma. As chaves em uso vêm sempre da plataforma.
   */
  saas: {
    pilotoPadrao: boolean;
    chavesAmbiente: { hmacCpf: Buffer | null; kek: Buffer | null; kekVersao: number | null };
  };
  /**
   * Âncora externa do selo diário (spec §4.6): para onde vai o resumo (data, seq, hash, eventos do dia). Destinos
   * externos (`ANCORA_DESTINOS`), fora do alcance de quem administra o banco:
   *  - `github`: os selos DIÁRIOS ficam num endpoint público (`GET /auditoria/selos/publico`), que um workflow agendado
   *    do GitHub Actions lê e commita, só por append, no branch `ancoras` do repositório. Nenhum segredo na VPS.
   *  - `email`: SMTP para o síndico e o conselho (`ANCORA_EMAILS`), com TLS em produção.
   * O arquivo append-only (`ANCORA_ARQUIVO`) é cópia local, no mesmo servidor: não conta como destino externo.
   * Em produção, pelo menos um destino externo é obrigatório.
   */
  ancora: {
    /** Publica os selos diários no endpoint público para o GitHub Actions. */
    github: boolean;
    emails: string[];
    remetente: string;
    smtp: { host: string; porta: number; tls: TlsSmtp; usuario: string | null; senha: string | null } | null;
    arquivo: string | null;
  };
  /**
   * Agendador interno (selo diário, envio de âncoras pendentes, retenção). `agendador=false` desliga os timers (testes,
   * CLI); as rotinas continuam disponíveis sob demanda. A retenção diária roda a partir de `horaRetencaoBrt`.
   */
  jobs: { agendador: boolean; intervaloMin: number; horaRetencaoBrt: number };
  /**
   * Prazo de retenção dos anexos de ocorrência, em anos a partir do encerramento da ocorrência. A seção 7 dos requisitos
   * NÃO o define (spec §14, decisão em aberto): sem `RETENCAO_ANEXO_OCORRENCIA_ANOS`, nenhum anexo é eliminado por prazo.
   */
  retencao: { anexoOcorrenciaAnos: number | null };
  /**
   * App do Master (Fase B, 2026-11-01): `revelarPorMinuto` (`PLATAFORMA_REVELAR_POR_MINUTO`, padrão 60, de 1 a 1000) é o
   * limite de "Revelar" (valor completo de um registro) por usuário da plataforma numa janela de 60 s. Em memória, por
   * processo: freio contra raspagem por sessão roubada, não controle forte (src/plataforma/acesso-plataforma.service.ts).
   *
   * Escrita do Master (Fase C1, 2026-11-01), lidas direto do ambiente com o padrão de produção no código (nenhuma precisa
   * estar no .env): `escritasPorMinuto` (`PLATAFORMA_ESCRITAS_POR_MINUTO`, padrão 30, de 1 a 1000; em memória, por
   * processo, conta também as tentativas que dão erro de regra); `destrutivasPorDia` (`PLATAFORMA_DESTRUTIVAS_POR_DIA`,
   * padrão 0 = DESLIGADAS até haver 2º fator obrigatório, de 0 a 200) e `credenciaisPorDia`
   * (`PLATAFORMA_CREDENCIAIS_POR_DIA`, padrão 10, de 0 a 200; 0 desliga): por usuário, em 24 h, DURÁVEIS (contados nas
   * linhas `condominio.destrutiva`/`condominio.credencial` de plataforma_audit; sobrevivem a reinício).
   */
  plataforma: { revelarPorMinuto: number; escritasPorMinuto: number; destrutivasPorDia: number; credenciaisPorDia: number };
}

export type TlsSmtp = 'implicito' | 'starttls' | 'nenhum';

export interface PrazoSessao { inatividadeMin: number; absolutaMin: number }

/**
 * Prazos da sessão (decisão do usuário de 2026-10-29): padrão 4 h sem uso / 14 h no total (um turno da portaria com
 * folga); "Manter conectado" 1 dia sem uso / 15 dias no total. Ajustáveis por SESSAO_{PADRAO,LONGA}_{INATIVIDADE,ABSOLUTA}_MIN.
 */
export const PADROES_SESSAO: Pick<Config['sessao'], 'padrao' | 'longa'> = {
  padrao: { inatividadeMin: 4 * 60, absolutaMin: 14 * 60 },
  longa: { inatividadeMin: 24 * 60, absolutaMin: 15 * 24 * 60 },
};
/** Variáveis de antes dos prazos por tipo de uso: ignoradas, com aviso no boot (ver carregarSessao). */
export const VARIAVEIS_SESSAO_ANTIGAS = ['SESSAO_ABSOLUTA_MIN', 'SESSAO_INATIVIDADE_MIN'] as const;

/**
 * Padrões da spec §5.1 (§14 nº 27): 10 falhas por login e 30 por IP numa janela de 15 min bloqueiam por 15 min.
 * O IP é mais folgado porque a guarita sai por um único IP (NAT) e vários operadores dividem o contador; o limite que
 * protege cada conta é o por login. Os quatro números são ajustáveis por ambiente (LOGIN_MAX_FALHAS_LOGIN,
 * LOGIN_MAX_FALHAS_IP, LOGIN_JANELA_MIN, LOGIN_BLOQUEIO_MIN); vazio ou ausente usa o padrão. O atraso crescente não.
 */
export const PADROES_LOGIN: Config['login'] = {
  maxFalhasLogin: 10, maxFalhasIp: 30, janelaMin: 15, bloqueioMin: 15, atrasoBaseMs: 250, atrasoMaxMs: 3000,
};
/** Prazo de regularização do legado (RN-09) quando a assembleia não definiu outro. */
export const PRAZO_LEGADO_PADRAO_DIAS = 90;
/** Revelações por minuto por usuário da plataforma (Config.plataforma). */
export const REVELAR_POR_MINUTO_PADRAO = 60;
/** Escrita do Master (Config.plataforma): o padrão é o valor de produção. Destrutivas desligadas (0) até o 2º fator. */
export const PADROES_ESCRITA_PLATAFORMA = { escritasPorMinuto: 30, destrutivasPorDia: 0, credenciaisPorDia: 10 } as const;
export const PADROES_ARGON2: Config['argon2'] = { memoriaKib: 64 * 1024, iteracoes: 3, paralelismo: 1, concorrencia: 2, filaMax: 50 };

export const nomeCookie = (secure: boolean) => (secure ? '__Host-portaria_sessao' : 'portaria_sessao');

class ErroConfig extends Error {}

function exigir(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome];
  if (v === undefined || v.trim() === '') throw new ErroConfig(`${nome} não definida`);
  return v.trim();
}

function booleano(env: NodeJS.ProcessEnv, nome: string): boolean {
  const v = exigir(env, nome);
  // Só 'true'/'false': coerção por truthiness ligaria a flag com a string 'false'.
  if (v !== 'true' && v !== 'false') throw new ErroConfig(`${nome} deve ser 'true' ou 'false'`);
  return v === 'true';
}

function inteiro(env: NodeJS.ProcessEnv, nome: string, padrao: number, min: number, max: number): number {
  const bruto = env[nome]?.trim();
  if (bruto === undefined || bruto === '') return padrao;
  if (!/^\d+$/.test(bruto)) throw new ErroConfig(`${nome} deve ser inteiro`);
  const n = Number(bruto);
  if (n < min || n > max) throw new ErroConfig(`${nome} deve estar entre ${min} e ${max}`);
  return n;
}

/** Pasta padrão dos anexos cifrados no container (volume `documentos` do compose). */
export const DOCUMENTOS_DIR_PADRAO = '/var/lib/portaria/documentos';

function carregarDocumentos(env: NodeJS.ProcessEnv): Config['documentos'] {
  const dir = env.PORTARIA_DOCUMENTOS_DIR?.trim() || DOCUMENTOS_DIR_PADRAO;
  if (!dir.startsWith('/')) throw new ErroConfig('PORTARIA_DOCUMENTOS_DIR deve ser um caminho absoluto');
  return { dir };
}

/** Chaves antigas do ambiente, se ainda estiverem lá (só para a conferência do boot). Mesmo formato de antes da F2. */
function carregarChavesAmbiente(env: NodeJS.ProcessEnv): Config['saas']['chavesAmbiente'] {
  const hmacBruto = env.PORTARIA_HMAC_CPF_KEY?.trim();
  const hmacCpf = hmacBruto ? Buffer.from(hmacBruto, 'base64') : null;
  if (hmacCpf && hmacCpf.length < 32) throw new ErroConfig('PORTARIA_HMAC_CPF_KEY precisa de pelo menos 32 bytes (base64)');
  const kekBruto = env.PORTARIA_KEK?.trim();
  const kek = kekBruto ? Buffer.from(kekBruto, 'base64') : null;
  // AES-256: exatamente 32 bytes. Mais ou menos que isso é chave colada errada, não "mais segura".
  if (kek && kek.length !== 32) throw new ErroConfig('PORTARIA_KEK precisa ter exatamente 32 bytes (base64)');
  const v = inteiro(env, 'PORTARIA_KEK_VERSAO', 0, 1, 32767);
  if (kek && v === 0) throw new ErroConfig('PORTARIA_KEK sem PORTARIA_KEK_VERSAO');
  return { hmacCpf, kek, kekVersao: v || null };
}

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const DESTINOS_ANCORA = ['github', 'email'] as const;

/**
 * `ANCORA_DESTINOS`: lista separada por vírgula (`github`, `email`). Vazia ou ausente = inferida: `email` se
 * `ANCORA_EMAILS` estiver preenchida (o comportamento anterior), senão nenhum. Explícita, ela manda: `ANCORA_EMAILS`
 * preenchida sem `email` na lista é recusada (configuração ambígua: o e-mail não sairia e ninguém perceberia).
 */
function destinosAncora(env: NodeJS.ProcessEnv, temEmails: boolean): Set<(typeof DESTINOS_ANCORA)[number]> {
  const bruto = env.ANCORA_DESTINOS?.trim() ?? '';
  if (bruto === '') return new Set(temEmails ? ['email'] : []);
  const lista = bruto.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const d of lista) {
    if (!(DESTINOS_ANCORA as readonly string[]).includes(d)) throw new ErroConfig(`ANCORA_DESTINOS: destino desconhecido (${d}); use github e/ou email`);
  }
  const destinos = new Set(lista as (typeof DESTINOS_ANCORA)[number][]);
  if (temEmails && !destinos.has('email')) throw new ErroConfig("ANCORA_EMAILS preenchida, mas 'email' não está em ANCORA_DESTINOS");
  if (destinos.has('email') && !temEmails) throw new ErroConfig("ANCORA_DESTINOS inclui 'email', mas ANCORA_EMAILS está vazia");
  return destinos;
}

function carregarAncora(env: NodeJS.ProcessEnv, ambiente: Ambiente): Config['ancora'] {
  const emails = (env.ANCORA_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const destinos = destinosAncora(env, emails.length > 0);
  for (const e of emails) if (!EMAIL.test(e)) throw new ErroConfig('ANCORA_EMAILS: endereço inválido');
  const host = env.ANCORA_SMTP_HOST?.trim() || null;
  const arquivo = env.ANCORA_ARQUIVO?.trim() || null;
  if (arquivo && !arquivo.startsWith('/')) throw new ErroConfig('ANCORA_ARQUIVO deve ser um caminho absoluto');
  const remetente = env.ANCORA_REMETENTE?.trim() || 'portaria@localhost';
  if (!EMAIL.test(remetente) && remetente !== 'portaria@localhost') throw new ErroConfig('ANCORA_REMETENTE: endereço inválido');
  if (emails.length && !host) throw new ErroConfig('ANCORA_EMAILS exige ANCORA_SMTP_HOST');
  let smtp: Config['ancora']['smtp'] = null;
  if (host) {
    if (!emails.length) throw new ErroConfig('ANCORA_SMTP_HOST sem ANCORA_EMAILS: para quem mandar a âncora?');
    const tls = (env.ANCORA_SMTP_TLS?.trim() || 'starttls') as TlsSmtp;
    if (!['implicito', 'starttls', 'nenhum'].includes(tls)) throw new ErroConfig("ANCORA_SMTP_TLS deve ser 'implicito', 'starttls' ou 'nenhum'");
    // SMTP sem TLS só existe no Mailpit do compose de dev: em produção, a âncora não pode trafegar (nem a senha) em claro.
    if (tls === 'nenhum' && ambiente === 'producao') throw new ErroConfig('ANCORA_SMTP_TLS=nenhum não é permitido com PORTARIA_AMBIENTE=producao');
    const usuario = env.ANCORA_SMTP_USUARIO?.trim() || null;
    const senha = env.ANCORA_SMTP_SENHA ?? null;
    if (!!usuario !== !!senha) throw new ErroConfig('ANCORA_SMTP_USUARIO e ANCORA_SMTP_SENHA vão juntos');
    smtp = { host, porta: inteiro(env, 'ANCORA_SMTP_PORTA', tls === 'implicito' ? 465 : 587, 1, 65535), tls, usuario, senha: senha || null };
  }
  // Sem destino externo, a âncora fica só no próprio servidor: em produção isso anula a proteção do selo (spec §4.6).
  if (ambiente === 'producao' && destinos.size === 0) {
    throw new ErroConfig('ANCORA_DESTINOS (github e/ou email) é obrigatória com PORTARIA_AMBIENTE=producao (âncora externa do selo)');
  }
  return { github: destinos.has('github'), emails, remetente, smtp, arquivo };
}

function opcionalBooleano(env: NodeJS.ProcessEnv, nome: string, padrao: boolean): boolean {
  const v = env[nome]?.trim();
  if (v === undefined || v === '') return padrao;
  return booleano(env, nome);
}

/**
 * Prazos da sessão. As variáveis antigas (SESSAO_ABSOLUTA_MIN e SESSAO_INATIVIDADE_MIN, 12 h / 30 min) são IGNORADAS
 * com aviso no log, sem derrubar o boot: o compose de produção as repassava com padrão (720/30), então honrá-las
 * anularia em silêncio os prazos novos, e recusá-las derrubaria a API num .env que ainda as tenha.
 * Faixas: o padrão (que é o do porteiro) vai até 24 h; o longo até 30 dias. Em cada um, inatividade <= absoluta; e o
 * longo nunca é mais curto que o padrão (marcar "Manter conectado" não pode encurtar a sessão).
 */
function carregarSessao(env: NodeJS.ProcessEnv): Pick<Config['sessao'], 'padrao' | 'longa'> {
  const antigas = VARIAVEIS_SESSAO_ANTIGAS.filter((n) => env[n]?.trim());
  if (antigas.length) {
    log('warn', 'config.variavel_ignorada', {
      detalhe: `${antigas.join(', ')} não vale mais e foi ignorada; use SESSAO_PADRAO_* e SESSAO_LONGA_* (vazio = padrão)`,
    });
  }
  const P = PADROES_SESSAO;
  const padrao = {
    inatividadeMin: inteiro(env, 'SESSAO_PADRAO_INATIVIDADE_MIN', P.padrao.inatividadeMin, 1, 24 * 60),
    absolutaMin: inteiro(env, 'SESSAO_PADRAO_ABSOLUTA_MIN', P.padrao.absolutaMin, 5, 24 * 60),
  };
  const longa = {
    inatividadeMin: inteiro(env, 'SESSAO_LONGA_INATIVIDADE_MIN', P.longa.inatividadeMin, 1, 30 * 24 * 60),
    absolutaMin: inteiro(env, 'SESSAO_LONGA_ABSOLUTA_MIN', P.longa.absolutaMin, 5, 30 * 24 * 60),
  };
  for (const [nome, p] of [['PADRAO', padrao], ['LONGA', longa]] as const) {
    if (p.inatividadeMin > p.absolutaMin) throw new ErroConfig(`SESSAO_${nome}_INATIVIDADE_MIN não pode passar de SESSAO_${nome}_ABSOLUTA_MIN`);
  }
  if (longa.inatividadeMin < padrao.inatividadeMin || longa.absolutaMin < padrao.absolutaMin) {
    throw new ErroConfig('SESSAO_LONGA_* não pode ser menor que SESSAO_PADRAO_* ("Manter conectado" não encurta a sessão)');
  }
  return { padrao, longa };
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ambiente = exigir(env, 'PORTARIA_AMBIENTE');
  if (ambiente !== 'dev' && ambiente !== 'producao') throw new ErroConfig("PORTARIA_AMBIENTE deve ser 'dev' ou 'producao'");

  const secure = booleano(env, 'COOKIE_SECURE');
  // Cookie sem Secure só faz sentido em http://localhost. Em produção, recusar no boot é mais barato que descobrir depois.
  if (ambiente === 'producao' && !secure) throw new ErroConfig('COOKIE_SECURE=false não é permitido com PORTARIA_AMBIENTE=producao');

  const tp = exigir(env, 'TRUST_PROXY');
  let trustProxy: false | number;
  if (tp === 'false') trustProxy = false;
  else if (/^[1-3]$/.test(tp)) trustProxy = Number(tp);
  else throw new ErroConfig("TRUST_PROXY deve ser 'false' ou o número de proxies confiáveis (1 a 3)");

  const corsOrigens = (env.CORS_ORIGENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of corsOrigens) {
    let origem: string;
    try { origem = new URL(o).origin; } catch { throw new ErroConfig(`CORS_ORIGENS: origem inválida (${o})`); }
    // Origem exata (sem barra, sem caminho, sem curinga): CORS que reflete Origin anula o SameSite.
    if (origem !== o) throw new ErroConfig(`CORS_ORIGENS: use a origem exata, sem caminho nem barra final (${o})`);
  }
  // Produção: o front chama a API em outra origem (docs/deploy-subdominio-api.md). Lista vazia deixaria o front quebrado
  // e a verificação de Origin (comum/origem.ts) caindo na regra de dev (Origin = Host). Recusar no boot.
  if (ambiente === 'producao' && !corsOrigens.length) {
    throw new ErroConfig('CORS_ORIGENS é obrigatória com PORTARIA_AMBIENTE=producao (a origem exata do front, ex.: https://www.condenexo.com.br)');
  }

  return {
    ambiente,
    trustProxy,
    corsOrigens,
    cookie: { secure, nome: nomeCookie(secure) },
    sessao: { ...carregarSessao(env), toqueSeg: 60 },
    login: {
      ...PADROES_LOGIN,
      // Faixas: abaixo do mínimo o erro de digitação bloqueia a guarita; acima do máximo o limite deixa de proteger.
      maxFalhasLogin: inteiro(env, 'LOGIN_MAX_FALHAS_LOGIN', PADROES_LOGIN.maxFalhasLogin, 3, 50),
      maxFalhasIp: inteiro(env, 'LOGIN_MAX_FALHAS_IP', PADROES_LOGIN.maxFalhasIp, 3, 500),
      janelaMin: inteiro(env, 'LOGIN_JANELA_MIN', PADROES_LOGIN.janelaMin, 1, 24 * 60),
      bloqueioMin: inteiro(env, 'LOGIN_BLOQUEIO_MIN', PADROES_LOGIN.bloqueioMin, 1, 24 * 60),
    },
    argon2: { ...PADROES_ARGON2 },
    importacao: { prazoLegadoDias: inteiro(env, 'IMPORTACAO_PRAZO_LEGADO_DIAS', PRAZO_LEGADO_PADRAO_DIAS, 1, 730) },
    documentos: carregarDocumentos(env),
    saas: { pilotoPadrao: opcionalBooleano(env, 'SAAS_PILOTO_PADRAO', true), chavesAmbiente: carregarChavesAmbiente(env) },
    ancora: carregarAncora(env, ambiente),
    jobs: {
      agendador: opcionalBooleano(env, 'JOBS_AGENDADOR', true),
      intervaloMin: inteiro(env, 'JOBS_INTERVALO_MIN', 10, 1, 60),
      horaRetencaoBrt: inteiro(env, 'RETENCAO_HORA_BRT', 3, 0, 23),
    },
    retencao: { anexoOcorrenciaAnos: inteiro(env, 'RETENCAO_ANEXO_OCORRENCIA_ANOS', 0, 1, 20) || null },
    plataforma: {
      revelarPorMinuto: inteiro(env, 'PLATAFORMA_REVELAR_POR_MINUTO', REVELAR_POR_MINUTO_PADRAO, 1, 1000),
      escritasPorMinuto: inteiro(env, 'PLATAFORMA_ESCRITAS_POR_MINUTO', PADROES_ESCRITA_PLATAFORMA.escritasPorMinuto, 1, 1000),
      destrutivasPorDia: inteiro(env, 'PLATAFORMA_DESTRUTIVAS_POR_DIA', PADROES_ESCRITA_PLATAFORMA.destrutivasPorDia, 0, 200),
      credenciaisPorDia: inteiro(env, 'PLATAFORMA_CREDENCIAIS_POR_DIA', PADROES_ESCRITA_PLATAFORMA.credenciaisPorDia, 0, 200),
    },
  };
}
