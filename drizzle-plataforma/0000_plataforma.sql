-- Banco `plataforma` (SaaS multi-condomínio, docs/05_arquitetura_saas.md §4.1, SAAS-02/04; fase F1). OUTRO banco do
-- mesmo cluster, dono app_migrator, criado pelo bootstrap (db/bootstrap/00_roles.sh) ou à mão em produção.
-- Parte gerada pelo drizzle-kit (src/saas/schema-plataforma.ts): cadastro de condomínios, chaves embrulhadas pela
-- chave mestra, contrato, Master (usuário, códigos de recuperação, sessão), limite de login, trilha, métricas e âncora.
-- Parte manual (no fim): trilha append-only e GRANTs de app_plataforma. Sem ALTER DEFAULT PRIVILEGES (como na 0001 do
-- banco de condomínio): tabela nova sem GRANT falha fechada. app_rw não tem CONNECT neste banco (bootstrap).
CREATE TABLE "ancora_diaria" (
	"data" date PRIMARY KEY NOT NULL,
	"raiz" text NOT NULL,
	"folhas" jsonb NOT NULL,
	"criada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ancora_diaria_raiz_ck" CHECK (raiz ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "condominio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"nome" text NOT NULL,
	"banco" text NOT NULL,
	"status" text DEFAULT 'provisionando' NOT NULL,
	"plano" text NOT NULL,
	"ancora_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"encerrado_em" timestamp (3) with time zone,
	CONSTRAINT "condominio_codigo_ck" CHECK (codigo ~ '^[a-z][a-z0-9-]{2,30}$'),
	CONSTRAINT "condominio_banco_ck" CHECK (banco ~ '^portaria(_[a-z0-9]{8})?$'),
	CONSTRAINT "condominio_status_ck" CHECK (status IN ('provisionando', 'ativo', 'suspenso', 'encerrado', 'excluido')),
	CONSTRAINT "condominio_nome_ck" CHECK (length(btrim(nome)) BETWEEN 1 AND 200),
	CONSTRAINT "condominio_encerrado_ck" CHECK ((status IN ('encerrado', 'excluido')) = (encerrado_em IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "condominio_chave" (
	"condominio_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"versao" smallint NOT NULL,
	"chave_cifrada" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"mestra_versao" smallint NOT NULL,
	"ativa" boolean NOT NULL,
	"criada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "condominio_chave_pk" PRIMARY KEY("condominio_id","tipo","versao"),
	CONSTRAINT "condominio_chave_tipo_ck" CHECK (tipo IN ('hmac_cpf', 'kek_documentos')),
	CONSTRAINT "condominio_chave_versao_ck" CHECK (versao > 0 AND mestra_versao > 0),
	CONSTRAINT "condominio_chave_nonce_ck" CHECK (length(nonce) = 12),
	CONSTRAINT "condominio_chave_tamanho_ck" CHECK (length(chave_cifrada) BETWEEN 48 AND 144)
);
--> statement-breakpoint
CREATE TABLE "condominio_contrato" (
	"condominio_id" uuid PRIMARY KEY NOT NULL,
	"razao_social" text NOT NULL,
	"cnpj" text NOT NULL,
	"contato_nome" text NOT NULL,
	"contato_email" text NOT NULL,
	"limites" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "condominio_contrato_cnpj_ck" CHECK (cnpj ~ '^[0-9]{14}$')
);
--> statement-breakpoint
CREATE TABLE "condominio_metrica" (
	"condominio_id" uuid NOT NULL,
	"dia" date NOT NULL,
	"eventos" integer,
	"tamanho_bytes" bigint,
	"ultimo_selo" date,
	"jobs_atrasados" integer,
	CONSTRAINT "condominio_metrica_pk" PRIMARY KEY("condominio_id","dia")
);
--> statement-breakpoint
CREATE TABLE "master_codigo_recuperacao" (
	"master_usuario_id" uuid NOT NULL,
	"codigo_hash" text NOT NULL,
	"usado_em" timestamp (3) with time zone,
	CONSTRAINT "master_codigo_recuperacao_pk" PRIMARY KEY("master_usuario_id","codigo_hash"),
	CONSTRAINT "master_codigo_recuperacao_hash_ck" CHECK (codigo_hash LIKE '$argon2id$%')
);
--> statement-breakpoint
CREATE TABLE "master_sessao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"master_usuario_id" uuid NOT NULL,
	"criada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ultimo_uso_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp (3) with time zone NOT NULL,
	"revogada_em" timestamp (3) with time zone,
	"totp_confirmado_em" timestamp (3) with time zone,
	"ip" "inet",
	CONSTRAINT "master_sessao_token_hash_ck" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "master_sessao_expira_ck" CHECK (expira_em > criada_em)
);
--> statement-breakpoint
CREATE TABLE "master_usuario" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"email" text NOT NULL,
	"senha_hash" text NOT NULL,
	"totp_cifrado" "bytea" NOT NULL,
	"papel" text NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_usuario_senha_ck" CHECK (senha_hash LIKE '$argon2id$%'),
	CONSTRAINT "master_usuario_papel_ck" CHECK (papel IN ('master', 'suporte'))
);
--> statement-breakpoint
CREATE TABLE "plataforma_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "plataforma_audit_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"em" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"master_usuario_id" uuid,
	"acao" text NOT NULL,
	"condominio_id" uuid,
	"detalhes" jsonb,
	CONSTRAINT "plataforma_audit_seq_uq" UNIQUE("seq"),
	CONSTRAINT "plataforma_audit_acao_ck" CHECK (acao ~ '^[a-z][a-zA-Z_]*\.[a-z][a-zA-Z_]*$')
);
--> statement-breakpoint
CREATE TABLE "plataforma_login_limite" (
	"tipo" text NOT NULL,
	"chave" text NOT NULL,
	"falhas" smallint NOT NULL,
	"janela_inicio" timestamp (3) with time zone NOT NULL,
	"bloqueado_ate" timestamp (3) with time zone,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plataforma_login_limite_pk" PRIMARY KEY("tipo","chave"),
	CONSTRAINT "plataforma_login_limite_tipo_ck" CHECK (tipo IN ('ip', 'master')),
	CONSTRAINT "plataforma_login_limite_chave_ck" CHECK (chave ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "plataforma_login_limite_falhas_ck" CHECK (falhas >= 0)
);
--> statement-breakpoint
ALTER TABLE "condominio_chave" ADD CONSTRAINT "condominio_chave_condominio_id_condominio_id_fk" FOREIGN KEY ("condominio_id") REFERENCES "public"."condominio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condominio_contrato" ADD CONSTRAINT "condominio_contrato_condominio_id_condominio_id_fk" FOREIGN KEY ("condominio_id") REFERENCES "public"."condominio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condominio_metrica" ADD CONSTRAINT "condominio_metrica_condominio_id_condominio_id_fk" FOREIGN KEY ("condominio_id") REFERENCES "public"."condominio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_codigo_recuperacao" ADD CONSTRAINT "master_codigo_recuperacao_master_usuario_id_master_usuario_id_fk" FOREIGN KEY ("master_usuario_id") REFERENCES "public"."master_usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_sessao" ADD CONSTRAINT "master_sessao_master_usuario_id_master_usuario_id_fk" FOREIGN KEY ("master_usuario_id") REFERENCES "public"."master_usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plataforma_audit" ADD CONSTRAINT "plataforma_audit_master_usuario_id_master_usuario_id_fk" FOREIGN KEY ("master_usuario_id") REFERENCES "public"."master_usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plataforma_audit" ADD CONSTRAINT "plataforma_audit_condominio_id_condominio_id_fk" FOREIGN KEY ("condominio_id") REFERENCES "public"."condominio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "condominio_codigo_uq" ON "condominio" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "condominio_banco_uq" ON "condominio" USING btree ("banco");--> statement-breakpoint
CREATE UNIQUE INDEX "condominio_ancora_uq" ON "condominio" USING btree ("ancora_id");--> statement-breakpoint
CREATE UNIQUE INDEX "condominio_chave_ativa_uq" ON "condominio_chave" USING btree ("condominio_id","tipo") WHERE ativa;--> statement-breakpoint
CREATE UNIQUE INDEX "master_sessao_token_uq" ON "master_sessao" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "master_usuario_email_uq" ON "master_usuario" USING btree (lower("email"));--> statement-breakpoint

-- ===== Parte manual =========================================================================================
-- Trilha da plataforma: append-only sem exceção (nem o dono altera; a exclusão de condomínio não apaga linha daqui).
CREATE FUNCTION plataforma_audit_bloqueia_alteracao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tabela % é append-only: % bloqueado', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER plataforma_audit_imutavel BEFORE UPDATE OR DELETE ON plataforma_audit
FOR EACH ROW EXECUTE FUNCTION plataforma_audit_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER plataforma_audit_sem_truncate BEFORE TRUNCATE ON plataforma_audit
FOR EACH STATEMENT EXECUTE FUNCTION plataforma_audit_bloqueia_alteracao();
--> statement-breakpoint

-- Chave embrulhada: identidade imutável (condomínio, tipo, versão). Muda `ativa` (rotação da chave do condomínio grava
-- versão nova e desativa a antiga) e, só com mestra_versao MAIOR, o embrulho (rotação da chave mestra re-embrulha a
-- mesma chave; feito pela CLI como app_migrator, já que app_plataforma só tem UPDATE em `ativa`).
CREATE FUNCTION condominio_chave_bloqueia_alteracao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.condominio_id, NEW.tipo, NEW.versao, NEW.criada_em) IS DISTINCT FROM (OLD.condominio_id, OLD.tipo, OLD.versao, OLD.criada_em)
     OR ((NEW.chave_cifrada, NEW.nonce, NEW.mestra_versao) IS DISTINCT FROM (OLD.chave_cifrada, OLD.nonce, OLD.mestra_versao)
         AND NEW.mestra_versao <= OLD.mestra_versao) THEN
    RAISE EXCEPTION 'condominio_chave: só ativa muda, ou o embrulho com chave mestra de versão maior'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER condominio_chave_imutavel BEFORE UPDATE ON condominio_chave
FOR EACH ROW EXECUTE FUNCTION condominio_chave_bloqueia_alteracao();
--> statement-breakpoint

-- Permissões de app_plataforma (role da API para este banco, a partir da F2): ler e gravar, nunca apagar.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_plataforma;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_plataforma;
--> statement-breakpoint
GRANT INSERT, UPDATE ON condominio, condominio_contrato, master_usuario, master_sessao, plataforma_login_limite,
  condominio_metrica, ancora_diaria TO app_plataforma;
--> statement-breakpoint
GRANT INSERT ON plataforma_audit, condominio_chave, master_codigo_recuperacao TO app_plataforma;
--> statement-breakpoint
GRANT UPDATE (ativa) ON condominio_chave TO app_plataforma;
--> statement-breakpoint
GRANT UPDATE (usado_em) ON master_codigo_recuperacao TO app_plataforma;
--> statement-breakpoint
-- Explícito, para documentar e anular qualquer GRANT amplo anterior: sem DELETE em nada (exclusão de condomínio é da
-- CLI, SAAS-11), e a trilha só cresce.
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_plataforma;
--> statement-breakpoint
REVOKE UPDATE ON plataforma_audit FROM app_plataforma;
--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_plataforma;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION plataforma_audit_bloqueia_alteracao(), condominio_chave_bloqueia_alteracao() FROM PUBLIC;
