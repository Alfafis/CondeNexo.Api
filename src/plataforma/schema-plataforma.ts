// Schema do banco `plataforma` (SaaS multi-condomínio, docs/05_arquitetura_saas.md §4.1, SAAS-02/04). É OUTRO banco
// do mesmo cluster, com migrações próprias (drizzle-plataforma/, drizzle-plataforma.config.ts): nada daqui existe nos
// bancos de condomínio, e nada de lá existe aqui.
//
// O que guarda: o cadastro dos condomínios (código do login, nome do banco Postgres, status), as chaves de cada um
// embrulhadas pela chave mestra (nunca em claro), o contrato (a plataforma é controladora destes dados, não do morador),
// os usuários e sessões do Master, a trilha da plataforma e as métricas agregadas. NENHUM dado de morador.
//
// Fase F1: só o schema e o registro do piloto (cli/registrar-piloto). A API em execução não abre este banco.
// Mesmas convenções de src/db/schema.ts (snake_case, uuid, timestamptz(3)). Este arquivo não importa nada de lá: a
// imagem `migrate` copia só ele (Dockerfile).
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, customType, date, index, inet, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp,
  uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });
const instante = (nome: string) => timestamp(nome, { withTimezone: true, precision: 3, mode: 'date' });
const pk = () => uuid('id').primaryKey().defaultRandom();

/** Estados do contrato (SAAS-11). `suspenso` recusa login, mas os jobs de selo e retenção continuam. */
export const STATUS_CONDOMINIO = ['provisionando', 'ativo', 'suspenso', 'encerrado', 'excluido'] as const;
/** Tipos de chave por condomínio (SAAS-04): HMAC do CPF (não rotacionável) e KEK dos anexos. */
export const TIPOS_CHAVE = ['hmac_cpf', 'kek_documentos'] as const;
export type TipoChave = (typeof TIPOS_CHAVE)[number];
/**
 * Módulos contratáveis (cópia literal de MODULOS de ../dominio/modulos: este arquivo não importa o domain, porque a
 * imagem `migrate` copia só ele; test/saas-provisionar.test.ts confere as duas listas). Padrão: todos ligados.
 */
export const MODULOS_PLATAFORMA = ['encomendas', 'ocorrencias', 'autorizacoes_previas', 'importacao', 'veiculos', 'funcionarios', 'relatorios'] as const;
/** Siglas das UFs (cópia literal de UFS de ../dominio/condominio, pelo mesmo motivo). */
export const UFS_PLATAFORMA = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'] as const;
const listaSql = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

export const condominio = pgTable('condominio', {
  id: pk(),
  /** Slug do formulário de login (SAAS-05). Não vai para a âncora pública: lá vai `ancora_id`. */
  codigo: text('codigo').notNull(),
  nome: text('nome').notNull(),
  /** Nome do banco Postgres do condomínio. O piloto é `portaria` (o banco de hoje, sem renomear nada). */
  banco: text('banco').notNull(),
  status: text('status').notNull().default('provisionando'),
  plano: text('plano').notNull(),
  /** Identificador da folha do condomínio na âncora pública agregada (§4.3): não revela o código nem o nome. */
  ancoraId: uuid('ancora_id').notNull().defaultRandom(),
  criadoEm: instante('criado_em').notNull().defaultNow(),
  encerradoEm: instante('encerrado_em'),
  /** Cidade e UF do condomínio (cadastro e lista "Licenças" do Master). Nulos só no piloto, registrado antes (F1). */
  cidade: text('cidade'),
  uf: text('uf'),
  /** Módulos ligados (contratados). Nasce com todos; a tela de ligar/desligar é da F5. Núcleo da portaria não entra. */
  modulos: text('modulos').array().notNull().default(sql.raw(`ARRAY[${listaSql(MODULOS_PLATAFORMA)}]::text[]`)),
}, (t) => [
  uniqueIndex('condominio_codigo_uq').on(t.codigo),
  uniqueIndex('condominio_banco_uq').on(t.banco),
  uniqueIndex('condominio_ancora_uq').on(t.ancoraId),
  check('condominio_codigo_ck', sql`codigo ~ '^[a-z][a-z0-9-]{2,30}$'`),
  // `portaria` (piloto) ou `portaria_<8 caracteres>`: o nome entra em CREATE/DROP DATABASE na CLI, então o formato é fechado.
  check('condominio_banco_ck', sql`banco ~ '^portaria(_[a-z0-9]{8})?$'`),
  check('condominio_status_ck', sql.raw(`status IN (${STATUS_CONDOMINIO.map((s) => `'${s}'`).join(', ')})`)),
  check('condominio_nome_ck', sql`length(btrim(nome)) BETWEEN 1 AND 200`),
  check('condominio_encerrado_ck', sql`(status IN ('encerrado', 'excluido')) = (encerrado_em IS NOT NULL)`),
  check('condominio_local_ck', sql.raw(`(cidade IS NULL) = (uf IS NULL) AND (cidade IS NULL OR length(btrim(cidade)) BETWEEN 1 AND 100) AND (uf IS NULL OR uf IN (${listaSql(UFS_PLATAFORMA)}))`)),
  check('condominio_modulos_ck', sql.raw(`modulos <@ ARRAY[${listaSql(MODULOS_PLATAFORMA)}]::text[] AND array_position(modulos, NULL) IS NULL`)),
]);

/** Dados do cliente (contrato): a plataforma é controladora destes (execução de contrato, art. 7º, V). Nunca morador. */
export const condominioContrato = pgTable('condominio_contrato', {
  condominioId: uuid('condominio_id').primaryKey().references(() => condominio.id),
  razaoSocial: text('razao_social').notNull(),
  cnpj: text('cnpj').notNull(),
  contatoNome: text('contato_nome').notNull(),
  contatoEmail: text('contato_email').notNull(),
  /** Cotas do plano (SAAS-14). */
  limites: jsonb('limites').notNull().default({}),
}, () => [check('condominio_contrato_cnpj_ck', sql`cnpj ~ '^[0-9]{14}$'`)]);

/**
 * Chaves do condomínio (SAAS-04), cada uma cifrada (AES-256-GCM) pela chave mestra do ambiente, que nunca vem ao banco
 * nem ao backup. `chave_cifrada` = cifrado || tag (16 bytes); AAD `portaria:chave:<condominio_id>:<tipo>:v<versao>`
 * (src/plataforma/chave-mestra.ts). `versao` da KEK é a mesma gravada em `documento.chave_versao` do banco do condomínio.
 */
export const condominioChave = pgTable('condominio_chave', {
  condominioId: uuid('condominio_id').notNull().references(() => condominio.id),
  tipo: text('tipo').notNull(),
  versao: smallint('versao').notNull(),
  chaveCifrada: bytea('chave_cifrada').notNull(),
  nonce: bytea('nonce').notNull(),
  mestraVersao: smallint('mestra_versao').notNull(),
  ativa: boolean('ativa').notNull(),
  criadaEm: instante('criada_em').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'condominio_chave_pk', columns: [t.condominioId, t.tipo, t.versao] }),
  uniqueIndex('condominio_chave_ativa_uq').on(t.condominioId, t.tipo).where(sql`ativa`),
  check('condominio_chave_tipo_ck', sql.raw(`tipo IN (${TIPOS_CHAVE.map((s) => `'${s}'`).join(', ')})`)),
  check('condominio_chave_versao_ck', sql`versao > 0 AND mestra_versao > 0`),
  check('condominio_chave_nonce_ck', sql`length(nonce) = 12`),
  // 32 bytes de chave + 16 de tag, no mínimo (a HMAC do piloto pode ter mais de 32: veio do ambiente).
  check('condominio_chave_tamanho_ck', sql`length(chave_cifrada) BETWEEN 48 AND 144`),
]);

/** Papéis da plataforma (SAAS-07): fora do enum `papel` de condomínio. Matriz em ../dominio/rbac-plataforma. */
export const PAPEIS_PLATAFORMA = ['master', 'suporte'] as const;

/**
 * Usuário da plataforma (SAAS-07): fora do RBAC de condomínio. O e-mail é o login. O 2º fator (TOTP) saiu na 0004
 * (2026-10-23) e voltou na 0005 (sub-projeto C2, fase A1), OPCIONAL: quem não enrolou entra só com e-mail e senha.
 *  - trio ativo (`totp_cifrado`, `totp_mestra_versao`, `totp_ativado_em`): o fator em uso; tudo nulo = sem 2º fator;
 *  - trio pendente: o enrolamento em curso (o ativo continua valendo até a confirmação);
 *  - `totp_cifrado` = nonce(12) || cifrado(20) || tag(16), AES-256-GCM pela chave mestra, AAD
 *    `portaria:totp:<id>:ativo|pendente` (src/plataforma/segredo-totp.ts); a rotação da mestra re-cifra (rotacao-chaves.ts);
 *  - `totp_ultimo_passo`: anti-replay (só passo MAIOR vale); `segundo_fator_falhas`: trava após 20 seguidas (só a CLI
 *    desfaz); `recuperacao_geracao`: a geração válida dos códigos de recuperação (regerar invalida a anterior sem DELETE).
 */
export const masterUsuario = pgTable('master_usuario', {
  id: pk(),
  nome: text('nome').notNull(),
  email: text('email').notNull(),
  senhaHash: text('senha_hash').notNull(),
  papel: text('papel').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: instante('criado_em').notNull().defaultNow(),
  deveTrocarSenha: boolean('deve_trocar_senha').notNull().default(true),
  senhaTemporariaExpiraEm: instante('senha_temporaria_expira_em'),
  ultimoAcesso: instante('ultimo_acesso'),
  totpCifrado: bytea('totp_cifrado'),
  totpMestraVersao: smallint('totp_mestra_versao'),
  totpAtivadoEm: instante('totp_ativado_em'),
  totpUltimoPasso: bigint('totp_ultimo_passo', { mode: 'number' }),
  totpPendenteCifrado: bytea('totp_pendente_cifrado'),
  totpPendenteMestraVersao: smallint('totp_pendente_mestra_versao'),
  totpPendenteExpiraEm: instante('totp_pendente_expira_em'),
  segundoFatorFalhas: smallint('segundo_fator_falhas').notNull().default(0),
  recuperacaoGeracao: smallint('recuperacao_geracao').notNull().default(0),
}, (t) => [
  uniqueIndex('master_usuario_email_uq').on(sql`lower(${t.email})`),
  check('master_usuario_senha_ck', sql`senha_hash LIKE '$argon2id$%'`),
  check('master_usuario_papel_ck', sql`papel IN ('master', 'suporte')`),
  check('master_usuario_email_ck', sql`email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' AND length(email) <= 254`),
  check('master_usuario_temporaria_ck', sql`deve_trocar_senha OR senha_temporaria_expira_em IS NULL`),
  check('master_usuario_totp_ck', sql`((totp_cifrado IS NULL) = (totp_mestra_versao IS NULL) AND (totp_cifrado IS NULL) = (totp_ativado_em IS NULL)) AND (totp_cifrado IS NULL OR length(totp_cifrado) = 48) AND (totp_mestra_versao IS NULL OR totp_mestra_versao > 0)`),
  check('master_usuario_totp_pendente_ck', sql`((totp_pendente_cifrado IS NULL) = (totp_pendente_mestra_versao IS NULL) AND (totp_pendente_cifrado IS NULL) = (totp_pendente_expira_em IS NULL)) AND (totp_pendente_cifrado IS NULL OR length(totp_pendente_cifrado) = 48) AND (totp_pendente_mestra_versao IS NULL OR totp_pendente_mestra_versao > 0)`),
  check('master_usuario_totp_passo_ck', sql`totp_ultimo_passo IS NULL OR totp_ultimo_passo > 0`),
  check('master_usuario_segundo_fator_ck', sql`segundo_fator_falhas >= 0 AND recuperacao_geracao >= 0`),
]);

/**
 * Códigos de recuperação do 2º fator (0005; o nome é o da 0000, com outro desenho). Só o SHA-256 rotulado do código
 * normalizado (`portaria:recuperacao:v1:`), nunca o claro. Vale se `geracao` = `master_usuario.recuperacao_geracao` e
 * `usado_em` nulo. app_plataforma: SELECT, INSERT e UPDATE só em `usado_em` (sem DELETE: regerar troca a geração).
 */
export const masterCodigoRecuperacao = pgTable('master_codigo_recuperacao', {
  masterUsuarioId: uuid('master_usuario_id').notNull().references(() => masterUsuario.id),
  geracao: smallint('geracao').notNull(),
  codigoHash: text('codigo_hash').notNull(),
  criadoEm: instante('criado_em').notNull().defaultNow(),
  usadoEm: instante('usado_em'),
}, (t) => [
  primaryKey({ name: 'master_codigo_recuperacao_pk', columns: [t.masterUsuarioId, t.codigoHash] }),
  check('master_codigo_recuperacao_hash_ck', sql`codigo_hash ~ '^[0-9a-f]{64}$'`),
  check('master_codigo_recuperacao_geracao_ck', sql`geracao > 0`),
]);

/**
 * Login em duas etapas (0005): "senha ok, falta o código". Tabela PRÓPRIA, fora de `master_sessao`: um desafio nunca
 * autentica rota nenhuma (a PlataformaGuard só lê `master_sessao`). Só o SHA-256 do token do cookie de desafio.
 */
export const masterLoginPendente = pgTable('master_login_pendente', {
  id: pk(),
  tokenHash: text('token_hash').notNull(),
  masterUsuarioId: uuid('master_usuario_id').notNull().references(() => masterUsuario.id),
  criadoEm: instante('criado_em').notNull().defaultNow(),
  expiraEm: instante('expira_em').notNull(),
  tentativas: smallint('tentativas').notNull().default(0),
  concluidoEm: instante('concluido_em'),
  ip: inet('ip'),
}, (t) => [
  uniqueIndex('master_login_pendente_token_uq').on(t.tokenHash),
  index('master_login_pendente_usuario_idx').on(t.masterUsuarioId),
  check('master_login_pendente_token_hash_ck', sql`token_hash ~ '^[0-9a-f]{64}$'`),
  check('master_login_pendente_expira_ck', sql`expira_em > criado_em`),
  check('master_login_pendente_tentativas_ck', sql`tentativas >= 0`),
]);

/** Mesmo desenho de `sessao` (src/db/schema.ts), outra tabela em outro banco. */
export const masterSessao = pgTable('master_sessao', {
  id: pk(),
  tokenHash: text('token_hash').notNull(),
  masterUsuarioId: uuid('master_usuario_id').notNull().references(() => masterUsuario.id),
  criadaEm: instante('criada_em').notNull().defaultNow(),
  ultimoUsoEm: instante('ultimo_uso_em').notNull().defaultNow(),
  expiraEm: instante('expira_em').notNull(),
  revogadaEm: instante('revogada_em'),
  ip: inet('ip'),
  /** Migração 0003. Nulo enquanto a sessão não foi revogada. */
  motivoRevogacao: text('motivo_revogacao'),
}, (t) => [
  uniqueIndex('master_sessao_token_uq').on(t.tokenHash),
  index('master_sessao_usuario_idx').on(t.masterUsuarioId),
  check('master_sessao_token_hash_ck', sql`token_hash ~ '^[0-9a-f]{64}$'`),
  check('master_sessao_expira_ck', sql`expira_em > criada_em`),
  check('master_sessao_revogacao_ck', sql`(revogada_em IS NULL) = (motivo_revogacao IS NULL) AND (motivo_revogacao IS NULL OR motivo_revogacao IN ('logout', 'troca_senha', 'credencial_reemitida', 'desativacao', 'segundo_fator'))`),
]);

/**
 * Mesmo desenho de `login_limite` (0008 do condomínio): `master` (por login: só gradua o atraso, nunca bloqueia),
 * `master_ip` (par login+IP: bloqueia), `ip` (bloqueia) e `master_codigo` (0005: o passo do 2º fator, por usuário). Chaves: HMAC com subchave HKDF da chave mestra.
 */
export const plataformaLoginLimite = pgTable('plataforma_login_limite', {
  tipo: text('tipo').notNull(),
  chave: text('chave').notNull(),
  falhas: smallint('falhas').notNull(),
  janelaInicio: instante('janela_inicio').notNull(),
  bloqueadoAte: instante('bloqueado_ate'),
  atualizadoEm: instante('atualizado_em').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'plataforma_login_limite_pk', columns: [t.tipo, t.chave] }),
  check('plataforma_login_limite_tipo_ck', sql`tipo IN ('ip', 'master', 'master_ip', 'master_codigo')`),
  check('plataforma_login_limite_chave_ck', sql`chave ~ '^[0-9a-f]{64}$'`),
  check('plataforma_login_limite_falhas_ck', sql`falhas >= 0`),
]);

/** Trilha da plataforma: append-only por trigger (migração 0000). `detalhes` nunca leva dado de morador. */
export const plataformaAudit = pgTable('plataforma_audit', {
  id: pk(),
  seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity().unique('plataforma_audit_seq_uq'),
  em: instante('em').notNull().default(sql`clock_timestamp()`),
  /** Nulo quando a ação vem da CLI do operador na VPS (ex.: registro do piloto), não de um usuário do Master. */
  masterUsuarioId: uuid('master_usuario_id').references(() => masterUsuario.id),
  acao: text('acao').notNull(),
  condominioId: uuid('condominio_id').references(() => condominio.id),
  detalhes: jsonb('detalhes'),
}, () => [check('plataforma_audit_acao_ck', sql`acao ~ '^[a-z][a-zA-Z_]*\\.[a-z][a-zA-Z_]*$'`)]);

/** Métricas agregadas por condomínio e dia, copiadas pelo job (SAAS-15). Só números. */
export const condominioMetrica = pgTable('condominio_metrica', {
  condominioId: uuid('condominio_id').notNull().references(() => condominio.id),
  dia: date('dia').notNull(),
  eventos: integer('eventos'),
  tamanhoBytes: bigint('tamanho_bytes', { mode: 'number' }),
  ultimoSelo: date('ultimo_selo'),
  jobsAtrasados: integer('jobs_atrasados'),
}, (t) => [primaryKey({ name: 'condominio_metrica_pk', columns: [t.condominioId, t.dia] })]);

/** Âncora pública agregada (§4.3, fase F4): raiz de Merkle do dia sobre as folhas de todos os condomínios. */
export const ancoraDiaria = pgTable('ancora_diaria', {
  data: date('data').primaryKey(),
  raiz: text('raiz').notNull(),
  /** [{ancora_id, seq, hash}] em ordem de ancora_id; sem contagem por condomínio. */
  folhas: jsonb('folhas').notNull(),
  criadaEm: instante('criada_em').notNull().defaultNow(),
}, () => [check('ancora_diaria_raiz_ck', sql`raiz ~ '^[0-9a-f]{64}$'`)]);

/**
 * Registro das anonimizações (LGPD art. 18, VI, e retenção) FORA do banco do condomínio (0001): um restore do banco do
 * condomínio para antes do pedido desfaria a anonimização em silêncio; este registro permite reaplicá-la
 * (`jobs.js reaplicar-anonimizacoes`). Só ids: o `pessoa_id` aponta para uma linha que já está anonimizada no banco do
 * condomínio, e o app_plataforma não tem CONNECT lá (SAAS-03). Append-only (sem UPDATE/DELETE para app_plataforma).
 */
export const lgpdAnonimizacao = pgTable('lgpd_anonimizacao', {
  condominioId: uuid('condominio_id').notNull().references(() => condominio.id),
  pessoaId: uuid('pessoa_id').notNull(),
  motivo: text('motivo').notNull(),
  anonimizadaEm: instante('anonimizada_em').notNull(),
  registradaEm: instante('registrada_em').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'lgpd_anonimizacao_pk', columns: [t.condominioId, t.pessoaId] }),
  check('lgpd_anonimizacao_motivo_ck', sql`motivo IN ('pedido', 'retencao')`),
]);
