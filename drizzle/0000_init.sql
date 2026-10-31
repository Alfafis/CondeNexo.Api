CREATE TYPE "public"."categoria_pessoa" AS ENUM('visitante', 'prestador', 'morador', 'funcionario');--> statement-breakpoint
CREATE TYPE "public"."escopo_restricao" AS ENUM('unidade', 'condominio');--> statement-breakpoint
CREATE TYPE "public"."meio_autorizacao" AS ENUM('interfone', 'morador_presente', 'autorizacao_previa', 'excecao_porteiro', 'escala');--> statement-breakpoint
CREATE TYPE "public"."papel" AS ENUM('sindico', 'administracao', 'porteiro', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."status_importacao" AS ENUM('analisada', 'confirmada', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."status_ocorrencia" AS ENUM('aberta', 'em_andamento', 'encerrada');--> statement-breakpoint
CREATE TYPE "public"."status_vinculo" AS ENUM('pendente', 'aprovado', 'rejeitado', 'legado', 'encerrado');--> statement-breakpoint
CREATE TYPE "public"."tipo_documento" AS ENUM('comprovante_vinculo', 'foto', 'anexo_ocorrencia', 'outro');--> statement-breakpoint
CREATE TYPE "public"."tipo_evento" AS ENUM('entrada', 'saida', 'negado', 'recusado', 'correcao');--> statement-breakpoint
CREATE TYPE "public"."tipo_inconsistencia" AS ENUM('aviso', 'erro');--> statement-breakpoint
CREATE TYPE "public"."tipo_ocorrencia" AS ENUM('conflito', 'tentativa_acesso_indevido', 'dano', 'encomenda', 'outro');--> statement-breakpoint
CREATE TYPE "public"."tipo_vinculo" AS ENUM('proprietario', 'inquilino', 'dependente');--> statement-breakpoint
CREATE TABLE "area_comum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_comum_nome_uq" UNIQUE("nome"),
	CONSTRAINT "area_comum_nome_ck" CHECK (length(btrim(nome)) > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"em" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"usuario_id" uuid,
	"usuario_nome" text NOT NULL,
	"usuario_papel" "papel",
	"acao" text NOT NULL,
	"entidade" text NOT NULL,
	"registro_id" uuid,
	"antes" jsonb,
	"depois" jsonb,
	"ip" "inet",
	"redigido_em" timestamp (3) with time zone,
	CONSTRAINT "audit_log_seq_uq" UNIQUE("seq"),
	CONSTRAINT "audit_log_acao_ck" CHECK (acao ~ '^[a-z][a-zA-Z_]*\.[a-z][a-zA-Z_]*$'),
	CONSTRAINT "audit_log_usuario_ck" CHECK (num_nonnulls(usuario_id, usuario_papel) IN (0, 2))
);
--> statement-breakpoint
CREATE TABLE "autorizacao_previa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"unidade_id" uuid,
	"area_comum_id" uuid,
	"valida_de" timestamp (3) with time zone NOT NULL,
	"valida_ate" timestamp (3) with time zone NOT NULL,
	"dias_semana" smallint[],
	"hora_inicio" time(0),
	"hora_fim" time(0),
	"solicitada_por_pessoa_id" uuid,
	"sem_solicitante" boolean DEFAULT false NOT NULL,
	"justificativa" text,
	"cadastrada_por_id" uuid NOT NULL,
	"cadastrada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"revogada_por_id" uuid,
	"revogada_em" timestamp (3) with time zone,
	CONSTRAINT "autorizacao_destino_ck" CHECK (num_nonnulls(unidade_id, area_comum_id) = 1),
	CONSTRAINT "autorizacao_validade_ck" CHECK (valida_ate > valida_de),
	CONSTRAINT "autorizacao_dias_ck" CHECK (dias_semana IS NULL OR (cardinality(dias_semana) BETWEEN 1 AND 7 AND dias_semana <@ ARRAY[0,1,2,3,4,5,6]::smallint[])),
	CONSTRAINT "autorizacao_janela_ck" CHECK (num_nonnulls(hora_inicio, hora_fim) IN (0, 2) AND (hora_inicio IS NULL OR hora_fim > hora_inicio)),
	CONSTRAINT "autorizacao_solicitante_ck" CHECK ((unidade_id IS NOT NULL AND sem_solicitante = (solicitada_por_pessoa_id IS NULL))
    OR (area_comum_id IS NOT NULL AND solicitada_por_pessoa_id IS NULL AND NOT sem_solicitante)),
	CONSTRAINT "autorizacao_sem_solicitante_justificada_ck" CHECK (NOT sem_solicitante OR (length(btrim(coalesce(justificativa, ''))) >= 15)),
	CONSTRAINT "autorizacao_revogacao_ck" CHECK (num_nonnulls(revogada_por_id, revogada_em) IN (0, 2))
);
--> statement-breakpoint
CREATE TABLE "autorizacao_retirada" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"encomenda_id" uuid NOT NULL,
	"pessoa_autorizada_id" uuid NOT NULL,
	"solicitante_pessoa_id" uuid NOT NULL,
	"registrada_por_id" uuid NOT NULL,
	"registrada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autorizacao_retirada_alvo_uq" UNIQUE("id","encomenda_id","pessoa_autorizada_id"),
	CONSTRAINT "autorizacao_retirada_pessoa_uq" UNIQUE("encomenda_id","pessoa_autorizada_id"),
	CONSTRAINT "autorizacao_retirada_pessoas_ck" CHECK (pessoa_autorizada_id <> solicitante_pessoa_id)
);
--> statement-breakpoint
CREATE TABLE "documento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" "tipo_documento" NOT NULL,
	"caminho_storage" text NOT NULL,
	"dek_cifrada" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"chave_versao" smallint NOT NULL,
	"sha256_conteudo" text NOT NULL,
	"mime" text NOT NULL,
	"tamanho_bytes" bigint NOT NULL,
	"enviado_por_id" uuid NOT NULL,
	"enviado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"eliminado_em" timestamp (3) with time zone,
	CONSTRAINT "documento_sha256_ck" CHECK (sha256_conteudo ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documento_tamanho_ck" CHECK (tamanho_bytes >= 0)
);
--> statement-breakpoint
CREATE TABLE "encomenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" integer GENERATED ALWAYS AS IDENTITY (sequence name "encomenda_numero_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"unidade_id" uuid NOT NULL,
	"destinatario" text NOT NULL,
	"transportadora" text,
	"codigo_rastreio" text,
	"unidade_confirmada" boolean NOT NULL,
	"recebida_por_id" uuid NOT NULL,
	"recebida_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"retirada_em" timestamp (3) with time zone,
	"retirada_por_pessoa_id" uuid,
	"retirada_registrada_por_id" uuid,
	"retirada_autorizacao_id" uuid,
	CONSTRAINT "encomenda_numero_uq" UNIQUE("numero"),
	CONSTRAINT "encomenda_destinatario_ck" CHECK (length(btrim(destinatario)) > 0),
	CONSTRAINT "encomenda_unidade_confirmada_ck" CHECK (unidade_confirmada),
	CONSTRAINT "encomenda_retirada_ck" CHECK (num_nonnulls(retirada_em, retirada_por_pessoa_id, retirada_registrada_por_id) IN (0, 3)),
	CONSTRAINT "encomenda_retirada_autorizada_ck" CHECK (retirada_autorizacao_id IS NULL OR retirada_em IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "evento_acesso" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"formato_hash" smallint DEFAULT 1 NOT NULL,
	"tipo" "tipo_evento" NOT NULL,
	"categoria_pessoa" "categoria_pessoa" NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"unidade_destino_id" uuid,
	"area_comum_id" uuid,
	"ponto_acesso_id" uuid NOT NULL,
	"autorizado_por_tipo" "meio_autorizacao",
	"autorizado_por_pessoa_id" uuid,
	"autorizacao_previa_id" uuid,
	"justificativa" text,
	"restricao_id" uuid,
	"operador_id" uuid NOT NULL,
	"operador_papel" "papel" NOT NULL,
	"ocorrido_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"registrado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"retroativo" boolean DEFAULT false NOT NULL,
	"formulario_contingencia" text,
	"refere_evento_id" uuid,
	"corrige_evento_id" uuid,
	"correcao_valores" jsonb,
	"empresa" text,
	"servico" text,
	"observacao" text,
	"hash_anterior" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL,
	CONSTRAINT "evento_seq_uq" UNIQUE("seq"),
	CONSTRAINT "evento_hash_uq" UNIQUE("hash"),
	CONSTRAINT "evento_destino_exclusivo_ck" CHECK (unidade_destino_id IS NULL OR area_comum_id IS NULL),
	CONSTRAINT "evento_area_comum_prestador_ck" CHECK (area_comum_id IS NULL OR categoria_pessoa = 'prestador'),
	CONSTRAINT "evento_destino_obrigatorio_ck" CHECK (tipo NOT IN ('entrada', 'recusado') OR categoria_pessoa = 'funcionario'
    OR unidade_destino_id IS NOT NULL OR area_comum_id IS NOT NULL),
	CONSTRAINT "evento_rn01_autorizado_por_ck" CHECK (tipo <> 'entrada' OR categoria_pessoa = 'morador' OR autorizado_por_tipo IS NOT NULL),
	CONSTRAINT "evento_autorizacao_so_entrada_recusa_ck" CHECK (tipo IN ('entrada', 'recusado')
    OR (autorizado_por_tipo IS NULL AND autorizado_por_pessoa_id IS NULL AND autorizacao_previa_id IS NULL)),
	CONSTRAINT "evento_recusa_meio_ck" CHECK (tipo <> 'recusado' OR autorizado_por_tipo IN ('interfone', 'morador_presente')),
	CONSTRAINT "evento_morador_identificado_ck" CHECK (autorizado_por_tipo NOT IN ('interfone', 'morador_presente')
    OR autorizado_por_pessoa_id IS NOT NULL),
	CONSTRAINT "evento_autorizacao_previa_ref_ck" CHECK ((autorizado_por_tipo IS NOT DISTINCT FROM 'autorizacao_previa')
    = (autorizacao_previa_id IS NOT NULL)),
	CONSTRAINT "evento_rf17_excecao_ck" CHECK (autorizado_por_tipo IS DISTINCT FROM 'excecao_porteiro'
    OR (length(btrim(coalesce(justificativa, ''))) >= 15 AND autorizado_por_pessoa_id IS NULL)),
	CONSTRAINT "evento_escala_ck" CHECK (autorizado_por_tipo IS DISTINCT FROM 'escala'
    OR (categoria_pessoa = 'funcionario' AND autorizado_por_pessoa_id IS NULL)),
	CONSTRAINT "evento_negado_restricao_ck" CHECK ((tipo = 'negado') = (restricao_id IS NOT NULL)),
	CONSTRAINT "evento_saida_refere_ck" CHECK ((tipo = 'saida') = (refere_evento_id IS NOT NULL)),
	CONSTRAINT "evento_correcao_ref_ck" CHECK ((tipo = 'correcao') = (corrige_evento_id IS NOT NULL)),
	CONSTRAINT "evento_correcao_valores_ck" CHECK (correcao_valores IS NULL
    OR (tipo = 'correcao' AND jsonb_typeof(correcao_valores) = 'object' AND correcao_valores <> '{}'::jsonb)),
	CONSTRAINT "evento_correcao_justificada_ck" CHECK (tipo <> 'correcao' OR (length(btrim(coalesce(justificativa, ''))) >= 15 AND NOT retroativo)),
	CONSTRAINT "evento_retroativo_formulario_ck" CHECK (retroativo = (formulario_contingencia IS NOT NULL)
    AND (formulario_contingencia IS NULL OR length(btrim(formulario_contingencia)) > 0)),
	CONSTRAINT "evento_retroativo_tempo_ck" CHECK ((retroativo AND ocorrido_em < registrado_em) OR (NOT retroativo AND ocorrido_em = registrado_em)),
	CONSTRAINT "evento_operador_papel_ck" CHECK (operador_papel <> 'auditor'),
	CONSTRAINT "evento_prestador_ck" CHECK ((categoria_pessoa = 'prestador' OR (empresa IS NULL AND servico IS NULL))
    AND (tipo <> 'entrada' OR categoria_pessoa <> 'prestador' OR length(btrim(coalesce(empresa, ''))) > 0)),
	CONSTRAINT "evento_cadeia_ck" CHECK (seq > 0 AND formato_hash = 1 AND hash ~ '^[0-9a-f]{64}$' AND hash_anterior ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "evento_acesso_cadeia" (
	"id" smallint PRIMARY KEY NOT NULL,
	"ultimo_seq" bigint NOT NULL,
	"ultimo_hash" text NOT NULL,
	"ultimo_registrado_em" timestamp (3) with time zone,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evento_cadeia_linha_unica_ck" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "funcionario" (
	"pessoa_id" uuid PRIMARY KEY NOT NULL,
	"funcao" text NOT NULL,
	"dias_semana" smallint[] NOT NULL,
	"hora_inicio" time(0) NOT NULL,
	"hora_fim" time(0) NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funcionario_funcao_ck" CHECK (length(btrim(funcao)) > 0),
	CONSTRAINT "funcionario_dias_ck" CHECK (cardinality(dias_semana) BETWEEN 1 AND 7 AND dias_semana <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
	CONSTRAINT "funcionario_escala_ck" CHECK (hora_inicio <> hora_fim)
);
--> statement-breakpoint
CREATE TABLE "importacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arquivo_nome" text NOT NULL,
	"arquivo_sha256" text NOT NULL,
	"status" "status_importacao" DEFAULT 'analisada' NOT NULL,
	"lidas" integer NOT NULL,
	"importaveis" integer NOT NULL,
	"rejeitadas" integer NOT NULL,
	"avisos" integer NOT NULL,
	"importados" integer,
	"reaproveitados" integer,
	"prazo_regularizacao" date NOT NULL,
	"executada_por_id" uuid NOT NULL,
	"analisada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"confirmada_em" timestamp (3) with time zone,
	CONSTRAINT "importacao_sha256_ck" CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "importacao_contagens_ck" CHECK (lidas >= 0 AND importaveis >= 0 AND rejeitadas >= 0 AND avisos >= 0
    AND coalesce(importados, 0) >= 0 AND coalesce(reaproveitados, 0) >= 0),
	CONSTRAINT "importacao_confirmacao_ck" CHECK ((status = 'confirmada') =
    (confirmada_em IS NOT NULL AND importados IS NOT NULL AND reaproveitados IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "importacao_inconsistencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"importacao_id" uuid NOT NULL,
	"linha" integer NOT NULL,
	"codigo" text NOT NULL,
	"mensagem" text NOT NULL,
	"tipo" "tipo_inconsistencia" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocorrencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" integer GENERATED ALWAYS AS IDENTITY (sequence name "ocorrencia_numero_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tipo" "tipo_ocorrencia" NOT NULL,
	"descricao" text NOT NULL,
	"unidade_id" uuid,
	"envolvidos" text,
	"aberta_por_id" uuid NOT NULL,
	"aberta_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"status" "status_ocorrencia" DEFAULT 'aberta' NOT NULL,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocorrencia_numero_uq" UNIQUE("numero"),
	CONSTRAINT "ocorrencia_descricao_ck" CHECK (length(btrim(descricao)) > 0)
);
--> statement-breakpoint
CREATE TABLE "ocorrencia_anexo" (
	"ocorrencia_id" uuid NOT NULL,
	"documento_id" uuid NOT NULL,
	CONSTRAINT "ocorrencia_anexo_pk" PRIMARY KEY("ocorrencia_id","documento_id")
);
--> statement-breakpoint
CREATE TABLE "ocorrencia_evento" (
	"ocorrencia_id" uuid NOT NULL,
	"evento_id" uuid NOT NULL,
	"vinculado_por_id" uuid NOT NULL,
	"vinculado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocorrencia_evento_pk" PRIMARY KEY("ocorrencia_id","evento_id")
);
--> statement-breakpoint
CREATE TABLE "ocorrencia_status_historico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ocorrencia_id" uuid NOT NULL,
	"de" "status_ocorrencia" NOT NULL,
	"para" "status_ocorrencia" NOT NULL,
	"por_id" uuid NOT NULL,
	"em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocorrencia_historico_mudanca_ck" CHECK (de <> para)
);
--> statement-breakpoint
CREATE TABLE "pessoa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"categoria" "categoria_pessoa" NOT NULL,
	"sem_cpf" boolean DEFAULT false NOT NULL,
	"documento_mascarado" text,
	"documento_busca" text,
	"telefone" text,
	"empresa" text,
	"servico" text,
	"foto_documento_id" uuid,
	"importacao_id" uuid,
	"anonimizada_em" timestamp (3) with time zone,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pessoa_documento_busca_uq" UNIQUE("documento_busca"),
	CONSTRAINT "pessoa_nome_ck" CHECK (length(btrim(nome)) > 0),
	CONSTRAINT "pessoa_documento_coerente_ck" CHECK (anonimizada_em IS NOT NULL
    OR (sem_cpf AND documento_busca IS NULL AND documento_mascarado IS NULL)
    OR (NOT sem_cpf AND documento_busca IS NOT NULL AND documento_mascarado IS NOT NULL)),
	CONSTRAINT "pessoa_documento_busca_ck" CHECK (documento_busca ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pessoa_documento_mascarado_ck" CHECK (documento_mascarado ~ '^\*\*\*\.[0-9]{3}\.[0-9]{3}-\*\*$'),
	CONSTRAINT "pessoa_telefone_ck" CHECK (telefone ~ '^[0-9]{10,11}$'),
	CONSTRAINT "pessoa_telefone_obrigatorio_ck" CHECK (telefone IS NOT NULL OR anonimizada_em IS NOT NULL OR importacao_id IS NOT NULL),
	CONSTRAINT "pessoa_prestador_empresa_ck" CHECK (categoria <> 'prestador' OR anonimizada_em IS NOT NULL
    OR length(btrim(coalesce(empresa, ''))) > 0),
	CONSTRAINT "pessoa_anonimizada_sem_pii_ck" CHECK (anonimizada_em IS NULL
    OR (documento_busca IS NULL AND documento_mascarado IS NULL AND telefone IS NULL AND foto_documento_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ponto_acesso" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ponto_acesso_nome_uq" UNIQUE("nome")
);
--> statement-breakpoint
CREATE TABLE "restricao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"escopo" "escopo_restricao" NOT NULL,
	"unidade_id" uuid,
	"pessoa_id" uuid NOT NULL,
	"motivo" text NOT NULL,
	"valida_ate" timestamp (3) with time zone NOT NULL,
	"solicitada_por_pessoa_id" uuid,
	"cadastrada_por_id" uuid NOT NULL,
	"cadastrada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"aprovada_por_id" uuid,
	"aprovada_em" timestamp (3) with time zone,
	"revogada_por_id" uuid,
	"revogada_em" timestamp (3) with time zone,
	CONSTRAINT "restricao_motivo_ck" CHECK (length(btrim(motivo)) > 0),
	CONSTRAINT "restricao_escopo_unidade_ck" CHECK (escopo <> 'unidade'
    OR (unidade_id IS NOT NULL AND solicitada_por_pessoa_id IS NOT NULL AND aprovada_por_id IS NULL)),
	CONSTRAINT "restricao_aprovacao_ck" CHECK (num_nonnulls(aprovada_por_id, aprovada_em) IN (0, 2)),
	CONSTRAINT "restricao_revogacao_ck" CHECK (num_nonnulls(revogada_por_id, revogada_em) IN (0, 2))
);
--> statement-breakpoint
CREATE TABLE "retencao_execucao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"executada_em" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"tipo" text NOT NULL,
	"ate_seq" bigint,
	"quantidade" integer NOT NULL,
	"detalhes" jsonb,
	CONSTRAINT "retencao_tipo_ck" CHECK (tipo IN ('eventos', 'audit_redacao', 'pessoas', 'documentos'))
);
--> statement-breakpoint
CREATE TABLE "selo_cadeia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data" date NOT NULL,
	"ultimo_seq" bigint NOT NULL,
	"ultimo_hash" text NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"enviado_para" text,
	"enviado_em" timestamp (3) with time zone,
	CONSTRAINT "selo_cadeia_data_uq" UNIQUE("data"),
	CONSTRAINT "selo_cadeia_seq_ck" CHECK (ultimo_seq >= 0),
	CONSTRAINT "selo_cadeia_hash_ck" CHECK (ultimo_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "selo_cadeia_envio_ck" CHECK (num_nonnulls(enviado_para, enviado_em) IN (0, 2))
);
--> statement-breakpoint
CREATE TABLE "unidade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"torre" smallint NOT NULL,
	"numero" text NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unidade_torre_numero_uq" UNIQUE("torre","numero"),
	CONSTRAINT "unidade_torre_ck" CHECK (torre > 0),
	CONSTRAINT "unidade_numero_ck" CHECK (numero ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "usuario_sistema" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"login" text NOT NULL,
	"senha_hash" text NOT NULL,
	"papel" "papel" NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultimo_acesso" timestamp (3) with time zone,
	"falhas_login" smallint DEFAULT 0 NOT NULL,
	"bloqueado_ate" timestamp (3) with time zone,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuario_senha_argon2id_ck" CHECK (senha_hash LIKE '$argon2id$%'),
	CONSTRAINT "usuario_falhas_ck" CHECK (falhas_login >= 0)
);
--> statement-breakpoint
CREATE TABLE "veiculo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unidade_id" uuid NOT NULL,
	"placa" text NOT NULL,
	"modelo" text NOT NULL,
	"cor" text NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "veiculo_placa_ck" CHECK (placa ~ '^[A-Z0-9]{7}$')
);
--> statement-breakpoint
CREATE TABLE "vinculo_unidade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"unidade_id" uuid NOT NULL,
	"tipo" "tipo_vinculo" NOT NULL,
	"status" "status_vinculo" DEFAULT 'pendente' NOT NULL,
	"vigencia_inicio" date,
	"vigencia_fim" date,
	"prazo_regularizacao" date,
	"documento_id" uuid,
	"conferencias" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registrado_por_id" uuid NOT NULL,
	"registrado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"importacao_id" uuid,
	"nota" text,
	"decidido_por_id" uuid,
	"decidido_em" timestamp (3) with time zone,
	"justificativa" text,
	"encerrado_em" timestamp (3) with time zone,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vinculo_vigencia_ck" CHECK (vigencia_fim IS NULL OR vigencia_inicio IS NULL OR vigencia_fim >= vigencia_inicio),
	CONSTRAINT "vinculo_legado_prazo_ck" CHECK (status <> 'legado' OR prazo_regularizacao IS NOT NULL),
	CONSTRAINT "vinculo_decisao_par_ck" CHECK (num_nonnulls(decidido_por_id, decidido_em) IN (0, 2)),
	CONSTRAINT "vinculo_decidido_ck" CHECK (status NOT IN ('aprovado', 'rejeitado') OR decidido_por_id IS NOT NULL),
	CONSTRAINT "vinculo_rejeicao_justificada_ck" CHECK (status <> 'rejeitado' OR length(btrim(coalesce(justificativa, ''))) > 0),
	CONSTRAINT "vinculo_encerrado_ck" CHECK ((status = 'encerrado') = (encerrado_em IS NOT NULL)),
	CONSTRAINT "vinculo_inquilino_fim_ck" CHECK (tipo <> 'inquilino' OR vigencia_fim IS NOT NULL OR status IN ('legado', 'encerrado')),
	CONSTRAINT "vinculo_conferencias_ck" CHECK (jsonb_typeof(conferencias) = 'array')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_usuario_id_usuario_sistema_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_previa" ADD CONSTRAINT "autorizacao_previa_pessoa_id_pessoa_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_previa" ADD CONSTRAINT "autorizacao_previa_unidade_id_unidade_id_fk" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_previa" ADD CONSTRAINT "autorizacao_previa_area_comum_id_area_comum_id_fk" FOREIGN KEY ("area_comum_id") REFERENCES "public"."area_comum"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_previa" ADD CONSTRAINT "autorizacao_previa_solicitada_por_pessoa_id_pessoa_id_fk" FOREIGN KEY ("solicitada_por_pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_previa" ADD CONSTRAINT "autorizacao_previa_cadastrada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("cadastrada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_previa" ADD CONSTRAINT "autorizacao_previa_revogada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("revogada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_retirada" ADD CONSTRAINT "autorizacao_retirada_encomenda_id_encomenda_id_fk" FOREIGN KEY ("encomenda_id") REFERENCES "public"."encomenda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_retirada" ADD CONSTRAINT "autorizacao_retirada_pessoa_autorizada_id_pessoa_id_fk" FOREIGN KEY ("pessoa_autorizada_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_retirada" ADD CONSTRAINT "autorizacao_retirada_solicitante_pessoa_id_pessoa_id_fk" FOREIGN KEY ("solicitante_pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autorizacao_retirada" ADD CONSTRAINT "autorizacao_retirada_registrada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("registrada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_enviado_por_id_usuario_sistema_id_fk" FOREIGN KEY ("enviado_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encomenda" ADD CONSTRAINT "encomenda_unidade_id_unidade_id_fk" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encomenda" ADD CONSTRAINT "encomenda_recebida_por_id_usuario_sistema_id_fk" FOREIGN KEY ("recebida_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encomenda" ADD CONSTRAINT "encomenda_retirada_por_pessoa_id_pessoa_id_fk" FOREIGN KEY ("retirada_por_pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encomenda" ADD CONSTRAINT "encomenda_retirada_registrada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("retirada_registrada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encomenda" ADD CONSTRAINT "encomenda_retirada_autorizacao_fk" FOREIGN KEY ("retirada_autorizacao_id","id","retirada_por_pessoa_id") REFERENCES "public"."autorizacao_retirada"("id","encomenda_id","pessoa_autorizada_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_pessoa_id_pessoa_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_unidade_destino_id_unidade_id_fk" FOREIGN KEY ("unidade_destino_id") REFERENCES "public"."unidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_area_comum_id_area_comum_id_fk" FOREIGN KEY ("area_comum_id") REFERENCES "public"."area_comum"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_ponto_acesso_id_ponto_acesso_id_fk" FOREIGN KEY ("ponto_acesso_id") REFERENCES "public"."ponto_acesso"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_autorizado_por_pessoa_id_pessoa_id_fk" FOREIGN KEY ("autorizado_por_pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_autorizacao_previa_id_autorizacao_previa_id_fk" FOREIGN KEY ("autorizacao_previa_id") REFERENCES "public"."autorizacao_previa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_restricao_id_restricao_id_fk" FOREIGN KEY ("restricao_id") REFERENCES "public"."restricao"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_acesso_operador_id_usuario_sistema_id_fk" FOREIGN KEY ("operador_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funcionario" ADD CONSTRAINT "funcionario_pessoa_id_pessoa_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "importacao" ADD CONSTRAINT "importacao_executada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("executada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "importacao_inconsistencia" ADD CONSTRAINT "importacao_inconsistencia_importacao_id_importacao_id_fk" FOREIGN KEY ("importacao_id") REFERENCES "public"."importacao"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia" ADD CONSTRAINT "ocorrencia_unidade_id_unidade_id_fk" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia" ADD CONSTRAINT "ocorrencia_aberta_por_id_usuario_sistema_id_fk" FOREIGN KEY ("aberta_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia_anexo" ADD CONSTRAINT "ocorrencia_anexo_ocorrencia_id_ocorrencia_id_fk" FOREIGN KEY ("ocorrencia_id") REFERENCES "public"."ocorrencia"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia_anexo" ADD CONSTRAINT "ocorrencia_anexo_documento_id_documento_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia_evento" ADD CONSTRAINT "ocorrencia_evento_ocorrencia_id_ocorrencia_id_fk" FOREIGN KEY ("ocorrencia_id") REFERENCES "public"."ocorrencia"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia_evento" ADD CONSTRAINT "ocorrencia_evento_evento_id_evento_acesso_id_fk" FOREIGN KEY ("evento_id") REFERENCES "public"."evento_acesso"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia_evento" ADD CONSTRAINT "ocorrencia_evento_vinculado_por_id_usuario_sistema_id_fk" FOREIGN KEY ("vinculado_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia_status_historico" ADD CONSTRAINT "ocorrencia_status_historico_ocorrencia_id_ocorrencia_id_fk" FOREIGN KEY ("ocorrencia_id") REFERENCES "public"."ocorrencia"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocorrencia_status_historico" ADD CONSTRAINT "ocorrencia_status_historico_por_id_usuario_sistema_id_fk" FOREIGN KEY ("por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_foto_documento_id_documento_id_fk" FOREIGN KEY ("foto_documento_id") REFERENCES "public"."documento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_importacao_id_importacao_id_fk" FOREIGN KEY ("importacao_id") REFERENCES "public"."importacao"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricao" ADD CONSTRAINT "restricao_unidade_id_unidade_id_fk" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricao" ADD CONSTRAINT "restricao_pessoa_id_pessoa_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricao" ADD CONSTRAINT "restricao_solicitada_por_pessoa_id_pessoa_id_fk" FOREIGN KEY ("solicitada_por_pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricao" ADD CONSTRAINT "restricao_cadastrada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("cadastrada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricao" ADD CONSTRAINT "restricao_aprovada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("aprovada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricao" ADD CONSTRAINT "restricao_revogada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("revogada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "veiculo" ADD CONSTRAINT "veiculo_unidade_id_unidade_id_fk" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_unidade_pessoa_id_pessoa_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_unidade_unidade_id_unidade_id_fk" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_unidade_documento_id_documento_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_unidade_registrado_por_id_usuario_sistema_id_fk" FOREIGN KEY ("registrado_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_unidade_importacao_id_importacao_id_fk" FOREIGN KEY ("importacao_id") REFERENCES "public"."importacao"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_unidade_decidido_por_id_usuario_sistema_id_fk" FOREIGN KEY ("decidido_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_registro_ix" ON "audit_log" USING btree ("entidade","registro_id");--> statement-breakpoint
CREATE INDEX "audit_log_em_ix" ON "audit_log" USING btree ("em");--> statement-breakpoint
CREATE INDEX "autorizacao_pessoa_vigente_ix" ON "autorizacao_previa" USING btree ("pessoa_id","unidade_id") WHERE revogada_em IS NULL;--> statement-breakpoint
CREATE INDEX "encomenda_pendente_ix" ON "encomenda" USING btree ("unidade_id") WHERE retirada_em IS NULL;--> statement-breakpoint
CREATE INDEX "evento_pessoa_ix" ON "evento_acesso" USING btree ("pessoa_id","ocorrido_em" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evento_unidade_ix" ON "evento_acesso" USING btree ("unidade_destino_id","ocorrido_em" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evento_operador_ix" ON "evento_acesso" USING btree ("operador_id","ocorrido_em" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evento_ocorrido_ix" ON "evento_acesso" USING btree ("ocorrido_em");--> statement-breakpoint
CREATE INDEX "evento_excecao_ix" ON "evento_acesso" USING btree ("operador_id","ocorrido_em") WHERE autorizado_por_tipo = 'excecao_porteiro';--> statement-breakpoint
CREATE UNIQUE INDEX "evento_saida_unica_uq" ON "evento_acesso" USING btree ("refere_evento_id") WHERE tipo = 'saida';--> statement-breakpoint
CREATE INDEX "evento_correcao_ix" ON "evento_acesso" USING btree ("corrige_evento_id") WHERE corrige_evento_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "importacao_inconsistencia_importacao_ix" ON "importacao_inconsistencia" USING btree ("importacao_id","linha");--> statement-breakpoint
CREATE INDEX "ocorrencia_status_ix" ON "ocorrencia" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ocorrencia_evento_evento_ix" ON "ocorrencia_evento" USING btree ("evento_id");--> statement-breakpoint
CREATE INDEX "ocorrencia_historico_ix" ON "ocorrencia_status_historico" USING btree ("ocorrencia_id","em");--> statement-breakpoint
CREATE INDEX "restricao_pessoa_vigente_ix" ON "restricao" USING btree ("pessoa_id") WHERE revogada_em IS NULL;--> statement-breakpoint
CREATE INDEX "selo_cadeia_seq_ix" ON "selo_cadeia" USING btree ("ultimo_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "usuario_login_uq" ON "usuario_sistema" USING btree (lower("login"));--> statement-breakpoint
CREATE UNIQUE INDEX "veiculo_placa_ativa_uq" ON "veiculo" USING btree ("placa") WHERE ativo;--> statement-breakpoint
CREATE UNIQUE INDEX "vinculo_ativo_uq" ON "vinculo_unidade" USING btree ("pessoa_id","unidade_id") WHERE status IN ('pendente', 'aprovado', 'legado');--> statement-breakpoint
CREATE INDEX "vinculo_unidade_status_ix" ON "vinculo_unidade" USING btree ("unidade_id","status");--> statement-breakpoint
CREATE INDEX "vinculo_pessoa_status_ix" ON "vinculo_unidade" USING btree ("pessoa_id","status");