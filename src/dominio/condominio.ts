// Código do condomínio (docs/05_arquitetura_saas.md SAAS-05): o slug curto que a portaria digita no login e que vai no
// cabeçalho `X-Condominio`. Fonte única do formato para a API (resolvedor e registro do piloto) e para o front.
// Não é segredo nem dado pessoal: só escolhe o banco onde o login é procurado.

/** 3 a 31 caracteres, a-z, 0-9 e hífen, começando por letra. */
export const CODIGO_CONDOMINIO = /^[a-z][a-z0-9-]{2,30}$/;

/** O que o login aceita como digitado: sem espaços nas pontas e em minúsculas. */
export function normalizarCodigoCondominio(valor: string): string {
  return valor.trim().toLowerCase();
}

/** Código já normalizado e no formato. */
export function codigoCondominioValido(codigo: string): boolean {
  return CODIGO_CONDOMINIO.test(codigo);
}

/** Siglas das unidades da federação (cadastro do condomínio na plataforma; mesmo CHECK de `condominio.uf`). */
export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;
export type Uf = (typeof UFS)[number];

/** Login do síndico (o mesmo do cadastro de usuário da API): 3 a 40 caracteres, a-z, 0-9, ".", "-" e "_", começando por letra. */
export const LOGIN_SINDICO = /^[a-z][a-z0-9._-]{2,39}$/;

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const palavras = (s: string) => semAcento(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const CONECTIVOS = new Set(['a', 'as', 'o', 'os', 'da', 'das', 'de', 'do', 'dos', 'e']);
/** Palavras que quase todo nome de condomínio tem e que não ajudam a portaria a digitar o código. */
const GENERICAS = new Set(['condominio', 'cond', 'residencial', 'res', 'edificio', 'ed', 'conjunto']);

/** Junta palavras com `sep` sem passar de `max` caracteres (corta em palavra inteira; a primeira, se sozinha passar, é cortada). */
function juntar(ps: readonly string[], sep: string, max: number): string {
  let out = '';
  for (const p of ps) {
    const prox = out ? `${out}${sep}${p}` : p;
    if (prox.length > max) break;
    out = prox;
  }
  return out || (ps[0] ?? '').slice(0, max);
}

/**
 * Código sugerido a partir do nome do condomínio: minúsculas sem acento, palavras ligadas por hífen, sem as genéricas
 * ("Condomínio", "Residencial", "Edifício") e conectivos, até 31 caracteres. "Residencial Vila Sul" -> "vila-sul".
 * Nome que começa por dígito ganha o prefixo "c-" (o código começa por letra). Pode sair curto demais (o formulário avisa).
 */
export function sugerirCodigoCondominio(nome: string): string {
  const ps = palavras(nome);
  const uteis = ps.filter((p) => !GENERICAS.has(p) && !CONECTIVOS.has(p));
  let c = juntar(uteis.length ? uteis : ps, '-', 31);
  if (c && !/^[a-z]/.test(c)) c = juntar(['c', ...(uteis.length ? uteis : ps)], '-', 31);
  return c;
}

/**
 * Login sugerido a partir do nome do síndico: primeiro e último nome, minúsculas sem acento, ligados por ponto.
 * "Maria José da Souza" -> "maria.souza"; nome único -> só ele. Sempre começa por letra e cabe em 40 caracteres.
 */
export function sugerirLoginSindico(nome: string): string {
  const ps = palavras(nome).filter((p) => !CONECTIVOS.has(p)).map((p) => p.replace(/^[0-9]+/, '')).filter(Boolean);
  if (!ps.length) return '';
  const escolhidas = ps.length === 1 ? [ps[0]!] : [ps[0]!, ps[ps.length - 1]!];
  return juntar(escolhidas, '.', 40);
}
