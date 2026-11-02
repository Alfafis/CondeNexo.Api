// Schema do banco do CondNexo (PostgreSQL 16+), em Drizzle.
//
// Convenções (spec §2 e §3):
// - Tabelas e colunas em snake_case no banco; chaves camelCase no TypeScript.
// - PK uuid (gen_random_uuid, v4). O evento de acesso tem também `seq`, que ordena a cadeia de hash.
// - Instantes em timestamptz(3): precisão de milissegundo, a mesma do JavaScript. Assim a serialização
//   canônica do hash é idêntica no banco (to_char ... MS) e fora dele (Date.toISOString()).
// - Nada é apagado pela API: remoção lógica por `ativo`, `revogada_em` e `encerrado_em`. O role app_rw não tem DELETE.
// - O que o Drizzle não expressa (triggers, funções de hash, GRANT/REVOKE e checagens entre tabelas)
//   fica na migração SQL manual `drizzle/0001_regras_imutabilidade.sql`.
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn, type PgTableExtraConfigValue, bigint, boolean, check, customType, date, foreignKey, index, inet, integer,
  jsonb, pgEnum, pgTable, primaryKey, smallint, text, time, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });
/** Instante com precisão de milissegundo (ver cabeçalho). */
const instante = (nome: string) => timestamp(nome, { withTimezone: true, precision: 3, mode: 'date' });
const criadoEm = () => instante('criado_em').notNull().defaultNow();
const atualizadoEm = () => instante('atualizado_em').notNull().defaultNow();
const pk = () => uuid('id').primaryKey().defaultRandom();

/** Justificativa mínima (RF-17, RN-04 e autorização sem solicitante): 15 caracteres sem contar espaços nas pontas. */
const JUST = (col: string) => sql.raw(`length(btrim(coalesce(${col}, ''))) >= 15`);
const DIAS_VALIDOS = (col: string) =>
  sql.raw(`cardinality(${col}) BETWEEN 1 AND 7 AND ${col} <@ ARRAY[0,1,2,3,4,5,6]::smallint[]`);

// ----- Enumerações ---------------------------------------------------------------------------------

export const papel = pgEnum('papel', ['sindico', 'administracao', 'porteiro', 'auditor']);
export const categoriaPessoa = pgEnum('categoria_pessoa', ['visitante', 'prestador', 'morador', 'funcionario']);
export const tipoVinculo = pgEnum('tipo_vinculo', ['proprietario', 'inquilino', 'dependente']);
export const statusVinculo = pgEnum('status_vinculo', ['pendente', 'aprovado', 'rejeitado', 'legado', 'encerrado']);
export const escopoRestricao = pgEnum('escopo_restricao', ['unidade', 'condominio']);
export const tipoEvento = pgEnum('tipo_evento', ['entrada', 'saida', 'negado', 'recusado', 'correcao']);
// 'celular' (0015): WhatsApp ou ligação para o celular do morador, quando ele não atende o interfone (questionário 22/10/2026)
export const meioAutorizacao = pgEnum('meio_autorizacao', [
  'interfone', 'celular', 'morador_presente', 'autorizacao_previa', 'excecao_porteiro', 'escala',
]);
export const tipoOcorrencia = pgEnum('tipo_ocorrencia', ['conflito', 'tentativa_acesso_indevido', 'dano', 'encomenda', 'outro']);
export const statusOcorrencia = pgEnum('status_ocorrencia', ['aberta', 'em_andamento', 'encerrada']);
// Sem 'comprovante_vinculo' desde a 0002: o comprovante do vínculo é conferido, não guardado (RF-05, LGPD art. 6º, III).
export const tipoDocumento = pgEnum('tipo_documento', ['foto', 'anexo_ocorrencia', 'outro']);
/** Tipo do comprovante conferido pela administração (RF-05). 'outro' exige descrição. */
export const tipoComprovante = pgEnum('tipo_comprovante', ['escritura', 'contrato_compra_venda', 'contrato_locacao', 'outro']);
export const statusImportacao = pgEnum('status_importacao', ['analisada', 'confirmada', 'cancelada']);
export const tipoInconsistencia = pgEnum('tipo_inconsistencia', ['aviso', 'erro']);

// ----- Estrutura do condomínio (RF-01) -------------------------------------------------------------

/**
 * Bloco: 1 a 3 maiúsculas ou dígitos ("A", "4", "B2"); número canônico com 2 dígitos no mínimo ("03", não "3" nem "003"),
 * para "3" e "03" não virarem duas unidades. A API normaliza antes de gravar (../dominio/units); o CHECK é a rede.
 * O CHECK aceita "00" (dado antigo "0" migrado); o cadastro novo recusa no domain.
 */
export const unidade = pgTable('unidade', {
  id: pk(),
  bloco: text('bloco').notNull(),
  numero: text('numero').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
  atualizadoEm: atualizadoEm(),
}, (t) => [
  unique('unidade_bloco_numero_uq').on(t.bloco, t.numero),
  check('unidade_bloco_ck', sql`bloco ~ '^[A-Z0-9]{1,3}$'`),
  check('unidade_numero_ck', sql`numero ~ '^(0[0-9]|[1-9][0-9]+)$'`),
]);

/** Áreas comuns atendidas por prestador (RF-36): salão, piscina, casa de máquinas... */
export const areaComum = pgTable('area_comum', {
  id: pk(),
  nome: text('nome').notNull().unique('area_comum_nome_uq'),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
}, () => [check('area_comum_nome_ck', sql`length(btrim(nome)) > 0`)]);

/** Hoje só existe a portaria social; a tabela fica pronta para garagem/dispositivos (fase 3). */
export const pontoAcesso = pgTable('ponto_acesso', {
  id: pk(),
  nome: text('nome').notNull().unique('ponto_acesso_nome_uq'),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
});

// ----- Usuários do sistema (RN-05, RF-33) -------------------------------------------------------------

export const usuarioSistema = pgTable('usuario_sistema', {
  id: pk(),
  nome: text('nome').notNull(),
  login: text('login').notNull(),
  /** argon2id (formato PHC). 2FA fica para a fase de segurança: sem colunas de TOTP no MVP. */
  senhaHash: text('senha_hash').notNull(),
  papel: papel('papel').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  ultimoAcesso: instante('ultimo_acesso'),
  /** Senha criada por terceiro (cadastro ou redefinição): só /auth/me, /auth/logout e /auth/trocar-senha até trocar. */
  deveTrocarSenha: boolean('deve_trocar_senha').notNull().default(true),
  senhaAlteradaEm: instante('senha_alterada_em'),
  /** Fim da validade da senha temporária (72 h, ../dominio/rules). NULL sem troca pendente (CHECK abaixo). */
  senhaTemporariaExpiraEm: instante('senha_temporaria_expira_em'),
  /** Fato gerador da retenção do operador (seção 7: "enquanto ativo + 3 anos"). Preenchido ao desativar, nulo ao reativar. */
  desativadoEm: instante('desativado_em'),
  /** Retenção aplicada (`retencao_anonimizar_operadores`, 0007): nome e login genéricos; não volta a ser ativado. */
  anonimizadoEm: instante('anonimizado_em'),
  // O bloqueio por falhas de login NÃO fica aqui (0003): vive em `login_limite`, por login e por IP, para tratar igual
  // login existente e inexistente (sem enumeração) e funcionar com várias réplicas.
  criadoEm: criadoEm(),
  atualizadoEm: atualizadoEm(),
}, (t) => [
  uniqueIndex('usuario_login_uq').on(sql`lower(${t.login})`),
  check('usuario_senha_argon2id_ck', sql`senha_hash LIKE '$argon2id$%'`),
  check('usuario_senha_temporaria_ck', sql`deve_trocar_senha OR senha_temporaria_expira_em IS NULL`),
  check('usuario_desativado_ck', sql`NOT ativo OR (desativado_em IS NULL AND anonimizado_em IS NULL)`),
]);

// ----- Sessões (spec §5.1): token opaco no cookie; aqui só o SHA-256 dele --------------------------------------
// Revogação lógica (`revogada_em`): app_rw não tem DELETE. Expiração absoluta em `expira_em`; a de inatividade é
// `ultimo_uso_em` + o prazo do tipo de uso (`manter_conectado`), calculada na API (configurável sem migração).
export const sessao = pgTable('sessao', {
  id: pk(),
  /** SHA-256 (hex) do token. O token tem 256 bits aleatórios, então hash sem sal basta e permite a busca. */
  tokenHash: text('token_hash').notNull(),
  usuarioId: uuid('usuario_id').notNull().references(() => usuarioSistema.id),
  criadaEm: instante('criada_em').notNull().defaultNow(),
  ultimoUsoEm: instante('ultimo_uso_em').notNull().defaultNow(),
  expiraEm: instante('expira_em').notNull(),
  /**
   * Sessão longa ("Manter conectado neste computador", 0014): já é o valor EFETIVO, gravado false para o porteiro
   * mesmo que ele marque. Linhas anteriores à coluna ficam false = prazo padrão. A API ainda confere o papel atual
   * a cada requisição (rebaixado a porteiro volta ao prazo padrão).
   */
  manterConectado: boolean('manter_conectado').notNull().default(false),
  revogadaEm: instante('revogada_em'),
  /** logout, desativacao, troca_senha, redefinicao_senha. */
  motivoRevogacao: text('motivo_revogacao'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
}, (t) => [
  uniqueIndex('sessao_token_uq').on(t.tokenHash),
  index('sessao_usuario_ix').on(t.usuarioId),
  check('sessao_token_hash_ck', sql`token_hash ~ '^[0-9a-f]{64}$'`),
  check('sessao_expira_ck', sql`expira_em > criada_em`),
  check('sessao_revogacao_ck', sql`num_nonnulls(revogada_em, motivo_revogacao) IN (0, 2)`),
  check('sessao_motivo_ck', sql`motivo_revogacao IS NULL OR motivo_revogacao IN ('logout', 'desativacao', 'troca_senha', 'redefinicao_senha')`),
  check('sessao_user_agent_ck', sql`user_agent IS NULL OR length(user_agent) <= 300`),
]);

// ----- Limite de tentativas de login (spec §5.1): contador por chave, persistente ------------------------------
// Uma linha por (tipo, chave), atualizada por UPSERT atômico: vale entre réplicas e não cresce por tentativa.
// `chave` é HMAC (subchave derivada de PORTARIA_HMAC_CPF_KEY) do login normalizado, do IP ou do par login+IP (0008): o
// login digitado pode ser um CPF. Só `ip` e `login_ip` bloqueiam; `login` sozinho só gradua o atraso (limite-login.service.ts).
export const loginLimite = pgTable('login_limite', {
  tipo: text('tipo').notNull(),
  chave: text('chave').notNull(),
  falhas: smallint('falhas').notNull(),
  janelaInicio: instante('janela_inicio').notNull(),
  bloqueadoAte: instante('bloqueado_ate'),
  atualizadoEm: instante('atualizado_em').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'login_limite_pk', columns: [t.tipo, t.chave] }),
  check('login_limite_tipo_ck', sql`tipo IN ('login', 'ip', 'login_ip')`),
  check('login_limite_chave_ck', sql`chave ~ '^[0-9a-f]{64}$'`),
  check('login_limite_falhas_ck', sql`falhas >= 0`),
]);

// ----- Documentos cifrados (RNF-03, spec §9.2): foto e anexos de ocorrência. O comprovante de vínculo NÃO vem para cá ----

export const documento = pgTable('documento', {
  id: pk(),
  tipo: tipoDocumento('tipo').notNull(),
  caminhoStorage: text('caminho_storage').notNull(),
  /** DEK do arquivo cifrada pela KEK (envelope); `chave_versao` identifica a KEK. */
  dekCifrada: bytea('dek_cifrada').notNull(),
  nonce: bytea('nonce').notNull(),
  chaveVersao: smallint('chave_versao').notNull(),
  sha256Conteudo: text('sha256_conteudo').notNull(),
  mime: text('mime').notNull(),
  tamanhoBytes: bigint('tamanho_bytes', { mode: 'number' }).notNull(),
  enviadoPorId: uuid('enviado_por_id').notNull().references(() => usuarioSistema.id),
  enviadoEm: instante('enviado_em').notNull().defaultNow(),
  eliminadoEm: instante('eliminado_em'),
}, () => [
  check('documento_sha256_ck', sql`sha256_conteudo ~ '^[0-9a-f]{64}$'`),
  check('documento_tamanho_ck', sql`tamanho_bytes >= 0`),
]);

// ----- Importação da planilha (RF-11, RN-09) ----------------------------------------------------------

export const importacao = pgTable('importacao', {
  id: pk(),
  arquivoNome: text('arquivo_nome').notNull(),
  arquivoSha256: text('arquivo_sha256').notNull(),
  status: statusImportacao('status').notNull().default('analisada'),
  lidas: integer('lidas').notNull(),
  importaveis: integer('importaveis').notNull(),
  rejeitadas: integer('rejeitadas').notNull(),
  avisos: integer('avisos').notNull(),
  importados: integer('importados'),
  reaproveitados: integer('reaproveitados'),
  prazoRegularizacao: date('prazo_regularizacao', { mode: 'string' }).notNull(),
  executadaPorId: uuid('executada_por_id').notNull().references(() => usuarioSistema.id),
  analisadaEm: instante('analisada_em').notNull().defaultNow(),
  confirmadaEm: instante('confirmada_em'),
}, () => [
  check('importacao_sha256_ck', sql`arquivo_sha256 ~ '^[0-9a-f]{64}$'`),
  check('importacao_contagens_ck', sql`lidas >= 0 AND importaveis >= 0 AND rejeitadas >= 0 AND avisos >= 0
    AND coalesce(importados, 0) >= 0 AND coalesce(reaproveitados, 0) >= 0`),
  check('importacao_confirmacao_ck', sql`(status = 'confirmada') =
    (confirmada_em IS NOT NULL AND importados IS NOT NULL AND reaproveitados IS NOT NULL)`),
]);

/** Relatório de inconsistências da importação. A mensagem pode citar o nome da pessoa (ver LGPD em db/README). */
export const importacaoInconsistencia = pgTable('importacao_inconsistencia', {
  id: pk(),
  importacaoId: uuid('importacao_id').notNull().references(() => importacao.id),
  linha: integer('linha').notNull(),
  codigo: text('codigo').notNull(),
  mensagem: text('mensagem').notNull(),
  tipo: tipoInconsistencia('tipo').notNull(),
}, (t) => [index('importacao_inconsistencia_importacao_ix').on(t.importacaoId, t.linha)]);

// ----- Pessoa (RF-02, RN-10) ---------------------------------------------------------------------------

export const pessoa = pgTable('pessoa', {
  id: pk(),
  nome: text('nome').notNull(),
  categoria: categoriaPessoa('categoria').notNull(),
  /** Exceção: cadastro sem CPF. Só entra por `excecao_porteiro` (trigger do evento) e não tem vínculo aprovado (regra da API). */
  semCpf: boolean('sem_cpf').notNull().default(false),
  /** Dependente menor de idade (LGPD art. 14, 0007): CPF e telefone opcionais. Não é "sem CPF": entra como morador. */
  menorIdade: boolean('menor_idade').notNull().default(false),
  /** Exibição: 123.45*.***-** (novo) ou ***.456.789-** (antigo). O CHECK impede que um CPF completo seja gravado aqui por engano. */
  documentoMascarado: text('documento_mascarado'),
  /** HMAC-SHA256(chave HMAC, 11 dígitos), hex. Busca exata e unicidade sem guardar o CPF. O CPF não é armazenado. */
  documentoBusca: text('documento_busca').unique('pessoa_documento_busca_uq'),
  /** Só dígitos, com DDD. Nulo apenas para importado da planilha (legado) ou anonimizado. */
  telefone: text('telefone'),
  empresa: text('empresa'),
  servico: text('servico'),
  fotoDocumentoId: uuid('foto_documento_id').references(() => documento.id),
  importacaoId: uuid('importacao_id').references(() => importacao.id),
  anonimizadaEm: instante('anonimizada_em'),
  /**
   * Cadastro desativado (RF-02, 0009): não é exclusão. Some das buscas, não entra, não recebe vínculo nem autorização;
   * o histórico continua. Os três campos andam juntos (pessoa_desativacao_ck). O motivo é texto livre do operador:
   * a anonimização o substitui (trigger pessoa_anonimizada_limpa_motivo) e a redação da trilha o remove.
   */
  desativadaEm: instante('desativada_em'),
  desativadaPorId: uuid('desativada_por_id').references((): AnyPgColumn => usuarioSistema.id),
  desativacaoMotivo: text('desativacao_motivo'),
  criadoEm: criadoEm(),
  atualizadoEm: atualizadoEm(),
}, () => [
  check('pessoa_nome_ck', sql`length(btrim(nome)) > 0`),
  check('pessoa_documento_coerente_ck', sql`anonimizada_em IS NOT NULL
    OR (sem_cpf AND documento_busca IS NULL AND documento_mascarado IS NULL)
    OR (NOT sem_cpf AND documento_busca IS NOT NULL AND documento_mascarado IS NOT NULL)
    OR (menor_idade AND NOT sem_cpf AND documento_busca IS NULL AND documento_mascarado IS NULL)`),
  check('pessoa_menor_ck', sql`NOT menor_idade OR (NOT sem_cpf AND categoria = 'morador')`),
  check('pessoa_documento_busca_ck', sql`documento_busca ~ '^[0-9a-f]{64}$'`),
  // Dois formatos (migração 0012): "***.456.789-**" (antigo, meio) e "123.45*.***-**" (cadastro novo, início). Os
  // asteriscos fixos nas posições escondidas impedem gravar o CPF completo; qual formato cada pessoa recebe é regra da API.
  check('pessoa_documento_mascarado_ck', sql`documento_mascarado ~ '^(\\*\\*\\*\\.[0-9]{3}\\.[0-9]{3}-\\*\\*|[0-9]{3}\\.[0-9]{2}\\*\\.\\*\\*\\*-\\*\\*)$'`),
  check('pessoa_telefone_ck', sql`telefone ~ '^[0-9]{10,11}$'`),
  check('pessoa_telefone_obrigatorio_ck', sql`telefone IS NOT NULL OR anonimizada_em IS NOT NULL OR importacao_id IS NOT NULL OR menor_idade`),
  check('pessoa_prestador_empresa_ck', sql`categoria <> 'prestador' OR anonimizada_em IS NOT NULL
    OR length(btrim(coalesce(empresa, ''))) > 0`),
  check('pessoa_anonimizada_sem_pii_ck', sql`anonimizada_em IS NULL
    OR (documento_busca IS NULL AND documento_mascarado IS NULL AND telefone IS NULL AND foto_documento_id IS NULL)`),
  check('pessoa_desativacao_ck', sql`num_nonnulls(desativada_em, desativada_por_id, desativacao_motivo) IN (0, 3)
    AND (desativacao_motivo IS NULL OR ${JUST('desativacao_motivo')})`),
]);

/** Funcionário do condomínio (RF-09). Escala que atravessa a meia-noite (22:00–06:00) vale no dia do início do turno. */
export const funcionario = pgTable('funcionario', {
  pessoaId: uuid('pessoa_id').primaryKey().references(() => pessoa.id),
  funcao: text('funcao').notNull(),
  /** 0 = domingo ... 6 = sábado. */
  diasSemana: smallint('dias_semana').array().notNull(),
  horaInicio: time('hora_inicio', { precision: 0 }).notNull(),
  horaFim: time('hora_fim', { precision: 0 }).notNull(),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
  atualizadoEm: atualizadoEm(),
}, () => [
  check('funcionario_funcao_ck', sql`length(btrim(funcao)) > 0`),
  check('funcionario_dias_ck', DIAS_VALIDOS('dias_semana')),
  check('funcionario_escala_ck', sql`hora_inicio <> hora_fim`),
]);

// ----- Vínculo com a unidade (RF-03 a RF-07, RN-02, RN-03, RN-09) -------------------------------------
// Transições (trigger): pendente -> aprovado | rejeitado; aprovado -> encerrado; legado -> aprovado | encerrado.
// Regra da API (não do banco): aprovar exige pessoa com CPF (não sem_cpf) e telefone; a categoria vira 'morador' na aprovação;
// só síndico/administração registra a conferência (vinculo.decidir); a data da conferência não pode ser futura.
// Conferência do comprovante (RF-05, RN-02): colunas conferencia_* — uma conferência vigente por vínculo. Pode ser
// refeita enquanto pendente/legado (o histórico fica no audit_log); aprovado exige conferência (CHECK) e o trigger
// congela as colunas depois da aprovação. O arquivo do comprovante não é guardado.

export const vinculoUnidade = pgTable('vinculo_unidade', {
  id: pk(),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoa.id),
  unidadeId: uuid('unidade_id').notNull().references(() => unidade.id),
  tipo: tipoVinculo('tipo').notNull(),
  status: statusVinculo('status').notNull().default('pendente'),
  vigenciaInicio: date('vigencia_inicio', { mode: 'string' }),
  vigenciaFim: date('vigencia_fim', { mode: 'string' }),
  prazoRegularizacao: date('prazo_regularizacao', { mode: 'string' }),
  conferenciaTipoDocumento: tipoComprovante('conferencia_tipo_documento'),
  /** Obrigatória se, e somente se, o tipo for 'outro' (até 80 caracteres). */
  conferenciaDescricao: text('conferencia_descricao'),
  /** Data em que a administração conferiu o comprovante (o instante do registro fica no audit_log). */
  conferenciaData: date('conferencia_data', { mode: 'string' }),
  conferidoPorId: uuid('conferido_por_id').references(() => usuarioSistema.id),
  /** Opcional, até 200 caracteres, SEM dado pessoal (nem CPF, nem telefone, nem nome de terceiro). O CHECK barra
   *  sequência de 9+ dígitos (CPF/telefone); o resto é orientação de preenchimento na tela. */
  conferenciaObservacao: text('conferencia_observacao'),
  registradoPorId: uuid('registrado_por_id').notNull().references(() => usuarioSistema.id),
  registradoEm: instante('registrado_em').notNull().defaultNow(),
  importacaoId: uuid('importacao_id').references(() => importacao.id),
  nota: text('nota'),
  decididoPorId: uuid('decidido_por_id').references(() => usuarioSistema.id),
  decididoEm: instante('decidido_em'),
  justificativa: text('justificativa'),
  encerradoEm: instante('encerrado_em'),
  atualizadoEm: atualizadoEm(),
}, (t) => [
  uniqueIndex('vinculo_ativo_uq').on(t.pessoaId, t.unidadeId).where(sql`status IN ('pendente', 'aprovado', 'legado')`),
  index('vinculo_unidade_status_ix').on(t.unidadeId, t.status),
  index('vinculo_pessoa_status_ix').on(t.pessoaId, t.status),
  check('vinculo_vigencia_ck', sql`vigencia_fim IS NULL OR vigencia_inicio IS NULL OR vigencia_fim >= vigencia_inicio`),
  check('vinculo_legado_prazo_ck', sql`status <> 'legado' OR prazo_regularizacao IS NOT NULL`),
  check('vinculo_decisao_par_ck', sql`num_nonnulls(decidido_por_id, decidido_em) IN (0, 2)`),
  check('vinculo_decidido_ck', sql`status NOT IN ('aprovado', 'rejeitado') OR decidido_por_id IS NOT NULL`),
  check('vinculo_rejeicao_justificada_ck', sql`status <> 'rejeitado' OR length(btrim(coalesce(justificativa, ''))) > 0`),
  check('vinculo_encerrado_ck', sql`(status = 'encerrado') = (encerrado_em IS NOT NULL)`),
  check('vinculo_inquilino_fim_ck', sql`tipo <> 'inquilino' OR vigencia_fim IS NOT NULL OR status IN ('legado', 'encerrado')`),
  check('vinculo_conferencia_completa_ck', sql`num_nonnulls(conferencia_tipo_documento, conferencia_data, conferido_por_id) IN (0, 3)`),
  check('vinculo_conferencia_descricao_ck', sql`CASE WHEN conferencia_tipo_documento = 'outro'
    THEN length(btrim(coalesce(conferencia_descricao, ''))) BETWEEN 1 AND 80 ELSE conferencia_descricao IS NULL END`),
  check('vinculo_conferencia_observacao_ck', sql`conferencia_observacao IS NULL
    OR (conferencia_tipo_documento IS NOT NULL AND length(conferencia_observacao) <= 200)`),
  check('vinculo_conferencia_sem_numero_ck', sql`regexp_replace(coalesce(conferencia_descricao, '') || ' ' || coalesce(conferencia_observacao, ''), '[. -]', '', 'g') !~ '[0-9]{9}'`),
  check('vinculo_conferencia_antes_decisao_ck', sql`conferencia_data IS NULL OR decidido_em IS NULL
    OR conferencia_data <= (decidido_em AT TIME ZONE 'UTC')::date`),
  check('vinculo_aprovado_conferido_ck', sql`status <> 'aprovado' OR conferido_por_id IS NOT NULL`),
]);

export const veiculo = pgTable('veiculo', {
  id: pk(),
  unidadeId: uuid('unidade_id').notNull().references(() => unidade.id),
  /** Maiúsculas, sem hífen (ABC1D23). */
  placa: text('placa').notNull(),
  modelo: text('modelo').notNull(),
  cor: text('cor').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  /** Fato gerador da retenção do veículo (0007): preenchido ao desativar, nulo ao reativar. 3 anos depois o job apaga. */
  desativadoEm: instante('desativado_em'),
  criadoEm: criadoEm(),
}, (t) => [
  uniqueIndex('veiculo_placa_ativa_uq').on(t.placa).where(sql`ativo`),
  index('veiculo_unidade_ix').on(t.unidadeId),
  check('veiculo_placa_ck', sql`placa ~ '^[A-Z0-9]{7}$'`),
  check('veiculo_desativado_ck', sql`NOT ativo OR desativado_em IS NULL`),
]);

// ----- Autorização prévia (RF-14, RN-07) --------------------------------------------------------------

export const autorizacaoPrevia = pgTable('autorizacao_previa', {
  id: pk(),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoa.id),
  /** Destino: unidade OU área comum (área comum só síndico/administração criam — RBAC na API). */
  unidadeId: uuid('unidade_id').references(() => unidade.id),
  areaComumId: uuid('area_comum_id').references(() => areaComum.id),
  validaDe: instante('valida_de').notNull(),
  validaAte: instante('valida_ate').notNull(),
  /** null = todos os dias. */
  diasSemana: smallint('dias_semana').array(),
  horaInicio: time('hora_inicio', { precision: 0 }),
  horaFim: time('hora_fim', { precision: 0 }),
  /** Morador que pediu (com vínculo válido na unidade: regra da API). Nulo => sem_solicitante + justificativa. */
  solicitadaPorPessoaId: uuid('solicitada_por_pessoa_id').references(() => pessoa.id),
  semSolicitante: boolean('sem_solicitante').notNull().default(false),
  justificativa: text('justificativa'),
  cadastradaPorId: uuid('cadastrada_por_id').notNull().references(() => usuarioSistema.id),
  cadastradaEm: instante('cadastrada_em').notNull().defaultNow(),
  revogadaPorId: uuid('revogada_por_id').references(() => usuarioSistema.id),
  revogadaEm: instante('revogada_em'),
}, (t) => [
  index('autorizacao_pessoa_vigente_ix').on(t.pessoaId, t.unidadeId).where(sql`revogada_em IS NULL`),
  check('autorizacao_destino_ck', sql`num_nonnulls(unidade_id, area_comum_id) = 1`),
  check('autorizacao_validade_ck', sql`valida_ate > valida_de`),
  check('autorizacao_dias_ck', sql`dias_semana IS NULL OR (${DIAS_VALIDOS('dias_semana')})`),
  check('autorizacao_janela_ck', sql`num_nonnulls(hora_inicio, hora_fim) IN (0, 2) AND (hora_inicio IS NULL OR hora_fim > hora_inicio)`),
  // Unidade: sem_solicitante <=> sem pessoa solicitante. Área comum: a própria administração é a solicitante.
  check('autorizacao_solicitante_ck', sql`(unidade_id IS NOT NULL AND sem_solicitante = (solicitada_por_pessoa_id IS NULL))
    OR (area_comum_id IS NOT NULL AND solicitada_por_pessoa_id IS NULL AND NOT sem_solicitante)`),
  check('autorizacao_sem_solicitante_justificada_ck', sql`NOT sem_solicitante OR (${JUST('justificativa')})`),
  check('autorizacao_revogacao_ck', sql`num_nonnulls(revogada_por_id, revogada_em) IN (0, 2)`),
]);

// ----- Restrição (RF-15, RF-16, RN-06) ----------------------------------------------------------------

export const restricao = pgTable('restricao', {
  id: pk(),
  escopo: escopoRestricao('escopo').notNull(),
  /** Unidade de origem do pedido. Obrigatória no escopo unidade; opcional no condomínio. */
  unidadeId: uuid('unidade_id').references(() => unidade.id),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoa.id),
  motivo: text('motivo').notNull(),
  validaAte: instante('valida_ate').notNull(),
  solicitadaPorPessoaId: uuid('solicitada_por_pessoa_id').references(() => pessoa.id),
  cadastradaPorId: uuid('cadastrada_por_id').notNull().references(() => usuarioSistema.id),
  cadastradaEm: instante('cadastrada_em').notNull().defaultNow(),
  /** Escopo condomínio só vale depois de aprovado pelo síndico (RN-06; papel conferido na API). */
  aprovadaPorId: uuid('aprovada_por_id').references(() => usuarioSistema.id),
  aprovadaEm: instante('aprovada_em'),
  revogadaPorId: uuid('revogada_por_id').references(() => usuarioSistema.id),
  revogadaEm: instante('revogada_em'),
}, (t) => [
  index('restricao_pessoa_vigente_ix').on(t.pessoaId).where(sql`revogada_em IS NULL`),
  // Contagem de restrições vigentes por unidade na lista de unidades (subconsulta correlacionada por linha da página).
  index('restricao_unidade_vigente_ix').on(t.unidadeId).where(sql`revogada_em IS NULL`),
  check('restricao_motivo_ck', sql`length(btrim(motivo)) > 0`),
  check('restricao_escopo_unidade_ck', sql`escopo <> 'unidade'
    OR (unidade_id IS NOT NULL AND solicitada_por_pessoa_id IS NOT NULL AND aprovada_por_id IS NULL)`),
  check('restricao_aprovacao_ck', sql`num_nonnulls(aprovada_por_id, aprovada_em) IN (0, 2)`),
  check('restricao_revogacao_ck', sql`num_nonnulls(revogada_por_id, revogada_em) IN (0, 2)`),
]);

// ----- Evento de acesso: APPEND-ONLY com hash encadeado (RF-12, RF-13, RF-17, RF-35, RN-01, RN-04) -----
// seq, formato_hash, registrado_em, hash_anterior e hash são definidos pelo trigger `evento_acesso_antes_inserir`
// (os defaults abaixo só existem para o tipo de insert do Drizzle; o trigger sempre os sobrescreve).
// Sem FK em refere_evento_id/corrige_evento_id: o trigger valida na inserção, e o descarte por retenção
// (prefixo da cadeia) não pode ser bloqueado por uma saída ou correção posterior.

export const eventoAcesso = pgTable('evento_acesso', {
  id: pk(),
  seq: bigint('seq', { mode: 'number' }).notNull().default(0).unique('evento_seq_uq'),
  /** 1 = sem veículo; 2 = entrada com veículo (0013). Definido pelo trigger a partir da placa. */
  formatoHash: smallint('formato_hash').notNull().default(1),
  tipo: tipoEvento('tipo').notNull(),
  categoriaPessoa: categoriaPessoa('categoria_pessoa').notNull(),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoa.id),
  unidadeDestinoId: uuid('unidade_destino_id').references(() => unidade.id),
  areaComumId: uuid('area_comum_id').references(() => areaComum.id),
  pontoAcessoId: uuid('ponto_acesso_id').notNull().references(() => pontoAcesso.id),
  autorizadoPorTipo: meioAutorizacao('autorizado_por_tipo'),
  /** Só o id: o nome vem por join (anonimizar a pessoa não quebra a cadeia). Sem coluna de nome copiado. */
  autorizadoPorPessoaId: uuid('autorizado_por_pessoa_id').references(() => pessoa.id),
  autorizacaoPreviaId: uuid('autorizacao_previa_id').references(() => autorizacaoPrevia.id),
  justificativa: text('justificativa'),
  restricaoId: uuid('restricao_id').references(() => restricao.id),
  operadorId: uuid('operador_id').notNull().references(() => usuarioSistema.id),
  operadorPapel: papel('operador_papel').notNull(),
  /** Não retroativo: o trigger iguala a registrado_em (o relógio é do servidor). */
  ocorridoEm: instante('ocorrido_em').notNull().defaultNow(),
  registradoEm: instante('registrado_em').notNull().defaultNow(),
  retroativo: boolean('retroativo').notNull().default(false),
  formularioContingencia: text('formulario_contingencia'),
  refereEventoId: uuid('refere_evento_id'),
  corrigeEventoId: uuid('corrige_evento_id'),
  /** Só em correção: { unidade_destino_id?, ocorrido_em?, pessoa_id?, autorizado_por_pessoa_id? }. Normalizado pelo trigger. */
  correcaoValores: jsonb('correcao_valores').$type<Record<string, string | null>>(),
  empresa: text('empresa'),
  servico: text('servico'),
  observacao: text('observacao'),
  /**
   * Veículo da entrada (0013; entra no hash, formato 2). Placa em maiúsculas sem hífen; modelo e cor opcionais, só com
   * placa. Dado pessoal do visitante: sai com o evento no descarte por retenção; não é corrigível.
   */
  veiculoPlaca: text('veiculo_placa'),
  veiculoModelo: text('veiculo_modelo'),
  veiculoCor: text('veiculo_cor'),
  hashAnterior: text('hash_anterior').notNull().default(''),
  hash: text('hash').notNull().default('').unique('evento_hash_uq'),
}, (t) => [
  index('evento_pessoa_ix').on(t.pessoaId, t.ocorridoEm.desc()),
  index('evento_unidade_ix').on(t.unidadeDestinoId, t.ocorridoEm.desc()),
  index('evento_operador_ix').on(t.operadorId, t.ocorridoEm.desc()),
  index('evento_ocorrido_ix').on(t.ocorridoEm),
  index('evento_excecao_ix').on(t.operadorId, t.ocorridoEm).where(sql`autorizado_por_tipo = 'excecao_porteiro'`),
  uniqueIndex('evento_saida_unica_uq').on(t.refereEventoId).where(sql`tipo = 'saida'`),
  index('evento_correcao_ix').on(t.corrigeEventoId).where(sql`corrige_evento_id IS NOT NULL`),
  // Destino
  check('evento_destino_exclusivo_ck', sql`unidade_destino_id IS NULL OR area_comum_id IS NULL`),
  check('evento_area_comum_prestador_ck', sql`area_comum_id IS NULL OR categoria_pessoa = 'prestador'`),
  check('evento_destino_obrigatorio_ck', sql`tipo NOT IN ('entrada', 'recusado') OR categoria_pessoa = 'funcionario'
    OR unidade_destino_id IS NOT NULL OR area_comum_id IS NOT NULL`),
  // RN-01 e coerência do meio de autorização
  check('evento_rn01_autorizado_por_ck', sql`tipo <> 'entrada' OR categoria_pessoa = 'morador' OR autorizado_por_tipo IS NOT NULL`),
  check('evento_autorizacao_so_entrada_recusa_ck', sql`tipo IN ('entrada', 'recusado')
    OR (autorizado_por_tipo IS NULL AND autorizado_por_pessoa_id IS NULL AND autorizacao_previa_id IS NULL)`),
  // Meios em que um morador identificado autoriza ou recusa. Comparação como texto desde a 0015: o literal 'celular'
  // convertido para o enum na mesma transação do ADD VALUE é "unsafe use of new value" (e o migrador roda tudo numa só)
  check('evento_recusa_meio_ck', sql`tipo <> 'recusado' OR autorizado_por_tipo::text IN ('interfone', 'celular', 'morador_presente')`),
  check('evento_morador_identificado_ck', sql`autorizado_por_tipo::text NOT IN ('interfone', 'celular', 'morador_presente')
    OR autorizado_por_pessoa_id IS NOT NULL`),
  check('evento_autorizacao_previa_ref_ck', sql`(autorizado_por_tipo IS NOT DISTINCT FROM 'autorizacao_previa')
    = (autorizacao_previa_id IS NOT NULL)`),
  check('evento_rf17_excecao_ck', sql`autorizado_por_tipo IS DISTINCT FROM 'excecao_porteiro'
    OR (${JUST('justificativa')} AND autorizado_por_pessoa_id IS NULL)`),
  check('evento_escala_ck', sql`autorizado_por_tipo IS DISTINCT FROM 'escala'
    OR (categoria_pessoa = 'funcionario' AND autorizado_por_pessoa_id IS NULL)`),
  // Coerência do tipo
  check('evento_negado_restricao_ck', sql`(tipo = 'negado') = (restricao_id IS NOT NULL)`),
  check('evento_saida_refere_ck', sql`(tipo = 'saida') = (refere_evento_id IS NOT NULL)`),
  check('evento_correcao_ref_ck', sql`(tipo = 'correcao') = (corrige_evento_id IS NOT NULL)`),
  check('evento_correcao_valores_ck', sql`correcao_valores IS NULL
    OR (tipo = 'correcao' AND jsonb_typeof(correcao_valores) = 'object' AND correcao_valores <> '{}'::jsonb)`),
  check('evento_correcao_justificada_ck', sql`tipo <> 'correcao' OR (${JUST('justificativa')} AND NOT retroativo)`),
  // Retroativo (RF-35)
  check('evento_retroativo_formulario_ck', sql`retroativo = (formulario_contingencia IS NOT NULL)
    AND (formulario_contingencia IS NULL OR length(btrim(formulario_contingencia)) > 0)`),
  check('evento_retroativo_tempo_ck', sql`(retroativo AND ocorrido_em < registrado_em) OR (NOT retroativo AND ocorrido_em = registrado_em)`),
  // Operador e prestador
  check('evento_operador_papel_ck', sql`operador_papel <> 'auditor'`),
  check('evento_prestador_ck', sql`(categoria_pessoa = 'prestador' OR (empresa IS NULL AND servico IS NULL))
    AND (tipo <> 'entrada' OR categoria_pessoa <> 'prestador' OR length(btrim(coalesce(empresa, ''))) > 0)`),
  // Veículo (0013): só na entrada; placa no padrão (a API confere antiga/Mercosul); modelo e cor só com placa
  check('evento_veiculo_so_entrada_ck', sql`tipo = 'entrada' OR num_nonnulls(veiculo_placa, veiculo_modelo, veiculo_cor) = 0`),
  check('evento_veiculo_placa_ck', sql`veiculo_placa IS NULL OR veiculo_placa ~ '^[A-Z0-9]{7}$'`),
  check('evento_veiculo_detalhe_ck', sql`(veiculo_placa IS NOT NULL OR (veiculo_modelo IS NULL AND veiculo_cor IS NULL))
    AND (veiculo_modelo IS NULL OR length(btrim(veiculo_modelo)) BETWEEN 1 AND 60)
    AND (veiculo_cor IS NULL OR length(btrim(veiculo_cor)) BETWEEN 1 AND 30)`),
  // Cadeia (o trigger preenche; o CHECK garante que ele rodou). Formato 2 <=> entrada com veículo.
  check('evento_cadeia_ck', sql`seq > 0 AND formato_hash IN (1, 2) AND hash ~ '^[0-9a-f]{64}$' AND hash_anterior ~ '^[0-9a-f]{64}$'`),
  check('evento_veiculo_formato_ck', sql`(formato_hash = 2) = (veiculo_placa IS NOT NULL)`),
]);

/** Cabeça da cadeia (linha única). Lida com FOR UPDATE pelo trigger: serializa as inserções e sobrevive ao descarte por retenção. */
export const eventoAcessoCadeia = pgTable('evento_acesso_cadeia', {
  id: smallint('id').primaryKey(),
  ultimoSeq: bigint('ultimo_seq', { mode: 'number' }).notNull(),
  ultimoHash: text('ultimo_hash').notNull(),
  ultimoRegistradoEm: instante('ultimo_registrado_em'),
  atualizadoEm: atualizadoEm(),
}, () => [check('evento_cadeia_linha_unica_ck', sql`id = 1`)]);

// ----- Encomendas (RF-22 a RF-26, RN-08) --------------------------------------------------------------

export const encomenda = pgTable('encomenda', {
  id: pk(),
  numero: integer('numero').notNull().generatedAlwaysAsIdentity().unique('encomenda_numero_uq'),
  unidadeId: uuid('unidade_id').notNull().references(() => unidade.id),
  destinatario: text('destinatario').notNull(),
  transportadora: text('transportadora'),
  codigoRastreio: text('codigo_rastreio'),
  /** RF-23: o registro só existe com a unidade conferida na tela. */
  unidadeConfirmada: boolean('unidade_confirmada').notNull(),
  recebidaPorId: uuid('recebida_por_id').notNull().references(() => usuarioSistema.id),
  recebidaEm: instante('recebida_em').notNull().defaultNow(),
  retiradaEm: instante('retirada_em'),
  retiradaPorPessoaId: uuid('retirada_por_pessoa_id').references(() => pessoa.id),
  retiradaRegistradaPorId: uuid('retirada_registrada_por_id').references(() => usuarioSistema.id),
  /** Preenchido quando quem retirou não tem vínculo e foi autorizado pelo morador (RN-08). */
  retiradaAutorizacaoId: uuid('retirada_autorizacao_id'),
}, (t): PgTableExtraConfigValue[] => [
  index('encomenda_pendente_ix').on(t.unidadeId).where(sql`retirada_em IS NULL`),
  // Listagem por cursor: ORDER BY recebida_em DESC, id DESC (encomendas.service). Índice ASC de propósito: a varredura reversa
  // entrega DESC NULLS FIRST, que é o que o ORDER BY ... DESC pede; um índice DESC NULLS LAST (o do drizzle-kit) não era usado.
  index('encomenda_recebida_ix').on(t.recebidaEm, t.id),
  check('encomenda_destinatario_ck', sql`length(btrim(destinatario)) > 0`),
  check('encomenda_unidade_confirmada_ck', sql`unidade_confirmada`),
  check('encomenda_retirada_ck', sql`num_nonnulls(retirada_em, retirada_por_pessoa_id, retirada_registrada_por_id) IN (0, 3)`),
  check('encomenda_retirada_autorizada_ck', sql`retirada_autorizacao_id IS NULL OR retirada_em IS NOT NULL`),
  // A autorização usada tem de ser desta encomenda e para esta pessoa.
  foreignKey({
    name: 'encomenda_retirada_autorizacao_fk',
    columns: [t.retiradaAutorizacaoId, t.id, t.retiradaPorPessoaId],
    foreignColumns: [autorizacaoRetirada.id, autorizacaoRetirada.encomendaId, autorizacaoRetirada.pessoaAutorizadaId],
  }),
]);

/** Autorização de retirada dada pelo morador com vínculo válido (RN-08: "ou a pessoa autorizada por ela"). */
export const autorizacaoRetirada = pgTable('autorizacao_retirada', {
  id: pk(),
  encomendaId: uuid('encomenda_id').notNull().references((): AnyPgColumn => encomenda.id),
  pessoaAutorizadaId: uuid('pessoa_autorizada_id').notNull().references(() => pessoa.id),
  /** Morador que autorizou (vínculo válido na unidade da encomenda: regra da API). */
  solicitantePessoaId: uuid('solicitante_pessoa_id').notNull().references(() => pessoa.id),
  registradaPorId: uuid('registrada_por_id').notNull().references(() => usuarioSistema.id),
  registradaEm: instante('registrada_em').notNull().defaultNow(),
}, (t) => [
  unique('autorizacao_retirada_alvo_uq').on(t.id, t.encomendaId, t.pessoaAutorizadaId),
  unique('autorizacao_retirada_pessoa_uq').on(t.encomendaId, t.pessoaAutorizadaId),
  check('autorizacao_retirada_pessoas_ck', sql`pessoa_autorizada_id <> solicitante_pessoa_id`),
]);

// ----- Ocorrências (RF-27, RF-28) ---------------------------------------------------------------------

export const ocorrencia = pgTable('ocorrencia', {
  id: pk(),
  numero: integer('numero').notNull().generatedAlwaysAsIdentity().unique('ocorrencia_numero_uq'),
  tipo: tipoOcorrencia('tipo').notNull(),
  descricao: text('descricao').notNull(),
  /** null = área comum. */
  unidadeId: uuid('unidade_id').references(() => unidade.id),
  envolvidos: text('envolvidos'),
  abertaPorId: uuid('aberta_por_id').notNull().references(() => usuarioSistema.id),
  abertaEm: instante('aberta_em').notNull().defaultNow(),
  status: statusOcorrencia('status').notNull().default('aberta'),
  atualizadoEm: atualizadoEm(),
}, (t) => [
  index('ocorrencia_status_ix').on(t.status),
  // Listagem por cursor: keyset (aberta_em, id) (ocorrencias.service).
  index('ocorrencia_aberta_ix').on(t.abertaEm, t.id),
  check('ocorrencia_descricao_ck', sql`length(btrim(descricao)) > 0`),
]);

/** Histórico de status (de, para, por, em). Append-only. */
export const ocorrenciaStatusHistorico = pgTable('ocorrencia_status_historico', {
  id: pk(),
  ocorrenciaId: uuid('ocorrencia_id').notNull().references(() => ocorrencia.id),
  de: statusOcorrencia('de').notNull(),
  para: statusOcorrencia('para').notNull(),
  porId: uuid('por_id').notNull().references(() => usuarioSistema.id),
  em: instante('em').notNull().defaultNow(),
}, (t) => [
  index('ocorrencia_historico_ix').on(t.ocorrenciaId, t.em),
  check('ocorrencia_historico_mudanca_ck', sql`de <> para`),
]);

/** N:N ocorrência x evento (RF-28). O descarte de evento por retenção remove o vínculo (cascade). */
export const ocorrenciaEvento = pgTable('ocorrencia_evento', {
  ocorrenciaId: uuid('ocorrencia_id').notNull().references(() => ocorrencia.id),
  eventoId: uuid('evento_id').notNull().references(() => eventoAcesso.id, { onDelete: 'cascade' }),
  vinculadoPorId: uuid('vinculado_por_id').notNull().references(() => usuarioSistema.id),
  vinculadoEm: instante('vinculado_em').notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'ocorrencia_evento_pk', columns: [t.ocorrenciaId, t.eventoId] }), index('ocorrencia_evento_evento_ix').on(t.eventoId)]);

export const ocorrenciaAnexo = pgTable('ocorrencia_anexo', {
  ocorrenciaId: uuid('ocorrencia_id').notNull().references(() => ocorrencia.id),
  documentoId: uuid('documento_id').notNull().references(() => documento.id),
}, (t) => [primaryKey({ name: 'ocorrencia_anexo_pk', columns: [t.ocorrenciaId, t.documentoId] })]);

// ----- Trilha de alterações (spec §3.3): append-only, SEM hash (redigível por LGPD) ---------------------

export const auditLog = pgTable('audit_log', {
  id: pk(),
  seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity().unique('audit_log_seq_uq'),
  em: instante('em').notNull().default(sql`clock_timestamp()`),
  /** Nulo apenas em falha de login com usuário inexistente. */
  usuarioId: uuid('usuario_id').references(() => usuarioSistema.id),
  usuarioNome: text('usuario_nome').notNull(),
  usuarioPapel: papel('usuario_papel'),
  /** Ex.: pessoa.criar, vinculo.decidir, auth.login_falha, acesso.negado. */
  acao: text('acao').notNull(),
  entidade: text('entidade').notNull(),
  registroId: uuid('registro_id'),
  /** Snapshots com nomes de coluna do banco; CPF e telefone mascarados pela API. */
  antes: jsonb('antes'),
  depois: jsonb('depois'),
  ip: inet('ip'),
  /** Preenchido por `lgpd_redigir_audit_pessoa` (única alteração permitida). */
  redigidoEm: instante('redigido_em'),
}, (t) => [
  index('audit_log_registro_ix').on(t.entidade, t.registroId),
  index('audit_log_em_ix').on(t.em),
  check('audit_log_acao_ck', sql`acao ~ '^[a-z][a-zA-Z_]*\\.[a-z][a-zA-Z_]*$'`),
  check('audit_log_usuario_ck', sql`num_nonnulls(usuario_id, usuario_papel) IN (0, 2)`),
]);

// ----- Selo diário e âncora externa (spec §4.6) -------------------------------------------------------

export const seloCadeia = pgTable('selo_cadeia', {
  id: pk(),
  /** Dia BRT a que o selo se refere. O diário é um por dia (fim do dia); o manual ("Selar agora") pode repetir o dia. */
  data: date('data', { mode: 'string' }).notNull(),
  /** 'diario' (agendador: último evento registrado até o fim do dia) ou 'manual' (cabeça da cadeia no momento). */
  tipo: text('tipo').notNull().default('diario'),
  ultimoSeq: bigint('ultimo_seq', { mode: 'number' }).notNull(),
  ultimoHash: text('ultimo_hash').notNull(),
  criadoEm: criadoEm(),
  /** Destino da âncora (e-mail, bucket). Preenchido uma única vez, após o envio. */
  enviadoPara: text('enviado_para'),
  enviadoEm: instante('enviado_em'),
}, (t) => [
  index('selo_cadeia_seq_ix').on(t.ultimoSeq),
  uniqueIndex('selo_cadeia_diario_uq').on(t.data).where(sql`tipo = 'diario'`),
  check('selo_cadeia_tipo_ck', sql`tipo IN ('diario', 'manual')`),
  check('selo_cadeia_seq_ck', sql`ultimo_seq >= 0`),
  check('selo_cadeia_hash_ck', sql`ultimo_hash ~ '^[0-9a-f]{64}$'`),
  check('selo_cadeia_envio_ck', sql`num_nonnulls(enviado_para, enviado_em) IN (0, 2)`),
]);

/** Registro das execuções de retenção/anonimização: só contagens e ids, sem dado pessoal (spec §9.1). */
export const retencaoExecucao = pgTable('retencao_execucao', {
  id: pk(),
  executadaEm: instante('executada_em').notNull().default(sql`clock_timestamp()`),
  tipo: text('tipo').notNull(),
  ateSeq: bigint('ate_seq', { mode: 'number' }),
  quantidade: integer('quantidade').notNull(),
  detalhes: jsonb('detalhes'),
}, () => [check('retencao_tipo_ck', sql`tipo IN ('eventos', 'audit_redacao', 'pessoas', 'documentos', 'audit_descarte', 'veiculos', 'operadores', 'sessoes')`)]);

// ----- Configuração do condomínio (SaaS, SAAS-06/18; docs/05_arquitetura_saas.md, provisionamento) ----------------

/**
 * Linha única (`id = 1`) com o que era fixo no código e passa a ser de cada condomínio: o nome do agrupamento
 * ("Bloco"/"Torre", só rótulo) e o fuso (SAAS-18: CHECK fixo em Brasília na primeira versão). Gravada pela CLI de
 * provisionamento. Ausente (o piloto, que nasceu antes): a API usa `ESTRUTURA_PADRAO.agrupamento`, o comportamento de
 * antes. app_rw: SELECT e INSERT; sem UPDATE até existir a tela de configuração (fase posterior).
 */
export const configuracao = pgTable('configuracao', {
  id: smallint('id').primaryKey().default(1),
  agrupamento: text('agrupamento').notNull(),
  fuso: text('fuso').notNull().default('America/Sao_Paulo'),
  criadoEm: criadoEm(),
}, () => [
  check('configuracao_linha_unica_ck', sql`id = 1`),
  check('configuracao_agrupamento_ck', sql`agrupamento IN ('Bloco', 'Torre')`),
  check('configuracao_fuso_ck', sql`fuso = 'America/Sao_Paulo'`),
]);

// ----- Tempo de permanência (prazo por tipo de visita, spec §14 2026-10-23) -------------------------------------------
// FORA da cadeia de hash, de propósito: o prazo é operacional (alerta da portaria), muda com a prorrogação e não pode
// mexer no evento_acesso, na canonização nem no hash. Append-only (trigger + REVOKE na migração 0011).

/** Rótulos no domain (`ROTULO_TIPO_VISITA`). Só para visitante e prestador. */
export const tipoVisita = pgEnum('tipo_visita', ['visita', 'entrega', 'transporte_app', 'servico']);

/**
 * Uma linha por definição de prazo de uma ENTRADA: `ordem` 0 é o prazo da entrada (gravado na mesma transação do
 * evento), 1..4 são as prorrogações. O prazo vigente é a linha de maior `ordem`. O índice único (evento, ordem)
 * serializa duas prorrogações simultâneas (a segunda recebe 23505) e o CHECK de `ordem` é o limite de prorrogações.
 * O trigger `permanencia_antes_inserir` confere: entrada de visitante/prestador, sequência sem buraco, mesmo tipo,
 * prazo crescente e dentro de 12 h da entrada, e nenhuma saída registrada. Sem dado pessoal: só ids, enum e instantes.
 * O descarte da entrada por retenção (prefixo da cadeia) leva as linhas junto (cascade), como em ocorrencia_evento.
 */
export const permanencia = pgTable('permanencia', {
  id: pk(),
  eventoEntradaId: uuid('evento_entrada_id').notNull().references(() => eventoAcesso.id, { onDelete: 'cascade' }),
  ordem: smallint('ordem').notNull(),
  tipoVisita: tipoVisita('tipo_visita').notNull(),
  prazoAte: instante('prazo_ate').notNull(),
  /** 'entrada' (ordem 0) ou 'prorrogacao'. */
  motivo: text('motivo').notNull(),
  definidoPorId: uuid('definido_por_id').notNull().references(() => usuarioSistema.id),
  /** Relógio do banco (o trigger sobrescreve). */
  definidoEm: instante('definido_em').notNull().default(sql`clock_timestamp()`),
}, (t) => [
  uniqueIndex('permanencia_evento_ordem_uq').on(t.eventoEntradaId, t.ordem),
  check('permanencia_ordem_ck', sql`ordem BETWEEN 0 AND 4`),
  check('permanencia_motivo_ck', sql`motivo IN ('entrada', 'prorrogacao') AND (motivo = 'entrada') = (ordem = 0)`),
]);
