// Máscara do nome de uma pessoa na leitura do Master (operador do SaaS, LGPD art. 6º, III: o mínimo necessário).
// Formato do protótipo: primeiro nome + inicial do último sobrenome + asteriscos ("Ana Ribeiro" -> "Ana R******").
// Os asteriscos são sempre 6: não revelam o tamanho do sobrenome. Os nomes do meio somem.
// Quem aplica é a API (src/plataforma/minimizacao.ts), nunca o front: o front do Master não recebe o nome completo.

/** Nome que a anonimização LGPD grava no lugar do nome (drizzle/0007, `lgpd_anonimizar_pessoa`). */
export const NOME_ANONIMIZADO = 'Pessoa anonimizada';

/** Asteriscos depois da inicial do sobrenome (quantidade fixa). */
export const ASTERISCOS_NOME = '******';

/** Partículas que não contam como sobrenome ("Maria da Silva" -> inicial de "Silva", não de "da"). */
const PARTICULAS = new Set(['da', 'das', 'de', 'do', 'dos', 'e', 'di', 'du', 'del', 'della', 'van', 'von', 'y']);

const temLetra = (s: string) => /\p{L}/u.test(s);

/**
 * "Ana Ribeiro" -> "Ana R******"; "Maria da Conceição dos Santos" -> "Maria S******".
 * - Uma palavra só ("Thiago"): fica como está, porque já é só o primeiro nome (o que o formato mostra de qualquer nome).
 * - Vazio: "". Marcadores do sistema ficam como estão: "Pessoa anonimizada", "(pessoa removida)", "?" (sem letra).
 * - Idempotente: um nome já mascarado sai igual.
 */
export function mascararNome(nome: string): string {
  const t = nome.trim().replace(/\s+/g, ' ');
  if (!t || t === NOME_ANONIMIZADO || /^\(.*\)$/.test(t) || !temLetra(t)) return t;
  const [primeiro, ...resto] = t.split(' ');
  const sobrenomes = resto.filter((p) => temLetra(p) && !PARTICULAS.has(p.toLocaleLowerCase('pt-BR')));
  const ultimo = sobrenomes[sobrenomes.length - 1];
  if (!ultimo) return primeiro!;
  const inicial = Array.from(ultimo).find(temLetra)!;
  return `${primeiro} ${inicial.toLocaleUpperCase('pt-BR')}${ASTERISCOS_NOME}`;
}

/** Nome mascarado no formato acima (para teste e para o front decidir o rótulo acessível). */
export const NOME_MASCARADO = /^\S+ \p{L}\*{6}$/u;

/** Para leitor de tela: "Ana R******" -> "Ana R." (os asteriscos seriam lidos um a um). Outro texto sai igual. */
export const nomeFalado = (nome: string) => (NOME_MASCARADO.test(nome) ? nome.replace(/\*+$/, '.') : nome);
