// Minimização do dado pessoal de TERCEIROS na leitura do Master (SAAS-09; LGPD art. 6º, III: o operador vê o mínimo).
// Aplicada no ponto único (AcessoPlataformaService.ler), na borda: os serviços e as views são os do síndico, que não
// mudam; só a resposta que sai para /plataforma/condominios/:id/... passa por aqui. Rota nova do Master já nasce
// minimizada. Regras por NOME DE CAMPO, iguais em qualquer view:
//
//  - nome de pessoa (morador, visitante, prestador, funcionário, destinatário): `mascararNome` ("Ana R******");
//  - texto livre (descrição e envolvidos da ocorrência, motivo, justificativa, observação, descrição da conferência):
//    OCULTO, trocado por um marcador. Pode citar qualquer pessoa e não há como mascarar texto livre com segurança; o
//    suporte trabalha com tipo, situação, datas, unidade e quem registrou, e o conteúdo é do síndico. Vazio e nulo ficam
//    como estão (o Master sabe se havia texto);
//  - placa de veículo: 3 primeiros caracteres + "****";
//  - nome de USUÁRIO do sistema (operadorNome, abertaPorNome, recebidaPorNome, cadastradaPorNome, lista de usuários e
//    síndicos...) fica: é quem age em nome do controlador, na função, e o Master gerencia os síndicos pelo nome.
//
// O que NÃO passa por aqui (decisão em docs/05_arquitetura_saas.md §5.4): o anexo de ocorrência (arquivo, baixado com
// `plataforma.exportar`). O JSONL verificável não existe para o Master: o registro com hash não pode ser minimizado.
import { mascararNome } from '../dominio/nome';
import { Pagina } from '../comum/pagina';

/** O que aparece no lugar de um texto livre preenchido. */
export const TEXTO_LIVRE_OCULTO = '(texto livre oculto na leitura da plataforma)';

/** Campos que guardam o nome de uma PESSOA (tabela `pessoa` ou texto digitado com o nome dela). */
const NOME_DE_PESSOA = new Set([
  'pessoaNome', 'pessoaNomeOriginal', 'pessoaNomeCorrigida', 'destinatario', 'retiradaPorNome', 'solicitadaPorNome', 'solicitanteNome',
]);
/** Quem autorizou: pessoa, exceto quando a view escreve o usuário que cadastrou (evento-view.ts, `nomeAutorizador`). */
const AUTORIZADOR = new Set(['autorizadoPorNome', 'autorizadoPorNomeOriginal', 'autorizadoPorNomeCorrigido']);
const AUTORIZADOR_E_USUARIO = /^(Área comum|Sem solicitante) — cadastrada por /;
const TEXTO_LIVRE = new Set(['descricao', 'envolvidos', 'motivo', 'justificativa', 'observacao', 'desativacaoMotivo']);
const PLACA = new Set(['placa', 'veiculoPlaca']);

export const mascararPlaca = (p: string) => (p ? `${p.slice(0, 3)}****` : p);

/** `nome` só é de pessoa no objeto pessoa (PessoaApi tem `documentoMascarado`) ou ao lado de `pessoaId`. */
const ehPessoa = (o: Record<string, unknown>) => 'documentoMascarado' in o || 'pessoaId' in o;

const ehObjetoSimples = (v: object): v is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function campo(o: Record<string, unknown>, k: string, v: string): string {
  if (NOME_DE_PESSOA.has(k) || (k === 'nome' && ehPessoa(o))) return mascararNome(v);
  if (AUTORIZADOR.has(k)) return AUTORIZADOR_E_USUARIO.test(v) ? v : mascararNome(v);
  if (TEXTO_LIVRE.has(k)) return v.trim() ? TEXTO_LIVRE_OCULTO : v;
  if (PLACA.has(k)) return mascararPlaca(v);
  return v;
}

/**
 * Cópia da resposta com as regras acima (não altera o valor recebido). Percorre array, objeto simples e `Pagina`; o
 * Buffer do anexo e Date passam como estão. Qualquer outro objeto (classe que a regra não conhece) é ERRO: falha
 * fechada, para uma view nova não sair sem minimização por ser instância de classe.
 */
export function minimizarLeituraPlataforma<T>(valor: T): T {
  const ir = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(ir);
    if (v instanceof Pagina) return new Pagina(v.itens.map(ir), v.proximoCursor);
    if (Buffer.isBuffer(v) || v instanceof Date) return v;
    if (!ehObjetoSimples(v)) throw new Error(`minimizacao: tipo de resposta não previsto (${v.constructor?.name ?? 'objeto'})`);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' ? campo(v, k, x) : ir(x);
    return out;
  };
  return ir(valor) as T;
}
