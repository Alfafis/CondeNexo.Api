-- 2º fator (TOTP) de volta, OPCIONAL (sub-projeto C2, fase A1; docs/05_arquitetura_saas.md SAAS-08). Só *expand*:
-- nenhum DROP de coluna ou tabela, nenhum dado existente muda de valor. Gerada pelo drizzle-kit a partir de
-- src/plataforma/schema-plataforma.ts; os GRANTs no fim são manuais (como na 0000).
--  - master_usuario: trio ativo e trio pendente do segredo (anuláveis), anti-replay, falhas seguidas e geração dos códigos
--    (NOT NULL DEFAULT 0, constante: o PG não reescreve a tabela). O Master existente fica SEM 2º fator e entra como hoje.
--  - master_codigo_recuperacao: recriada (a 0004 apagou a da 0000) com outro desenho: hash + geração, sem DELETE.
--  - master_login_pendente: o desafio "senha ok, falta o código", fora de master_sessao (nunca autentica rota).
--  - CHECKs de motivo de revogação (+ segundo_fator) e de tipo do limite (+ master_codigo): DROP + ADD com SUPERCONJUNTO,
--    então a API anterior (que não lê nada disto) continua passando neles se o deploy parar no meio.
-- Tabela nova sem GRANT explícito falha FECHADA para app_plataforma (o GRANT SELECT ON ALL TABLES da 0000 valeu só para as
-- tabelas daquela hora, e não há ALTER DEFAULT PRIVILEGES). As colunas novas de master_usuario já são cobertas pelo
-- GRANT de tabela da 0000 (INSERT, UPDATE).
CREATE TABLE "master_codigo_recuperacao" (
	"master_usuario_id" uuid NOT NULL,
	"geracao" smallint NOT NULL,
	"codigo_hash" text NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"usado_em" timestamp (3) with time zone,
	CONSTRAINT "master_codigo_recuperacao_pk" PRIMARY KEY("master_usuario_id","codigo_hash"),
	CONSTRAINT "master_codigo_recuperacao_hash_ck" CHECK (codigo_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "master_codigo_recuperacao_geracao_ck" CHECK (geracao > 0)
);
--> statement-breakpoint
CREATE TABLE "master_login_pendente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"master_usuario_id" uuid NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp (3) with time zone NOT NULL,
	"tentativas" smallint DEFAULT 0 NOT NULL,
	"concluido_em" timestamp (3) with time zone,
	"ip" "inet",
	CONSTRAINT "master_login_pendente_token_hash_ck" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "master_login_pendente_expira_ck" CHECK (expira_em > criado_em),
	CONSTRAINT "master_login_pendente_tentativas_ck" CHECK (tentativas >= 0)
);
--> statement-breakpoint
ALTER TABLE "master_sessao" DROP CONSTRAINT "master_sessao_revogacao_ck";--> statement-breakpoint
ALTER TABLE "plataforma_login_limite" DROP CONSTRAINT "plataforma_login_limite_tipo_ck";--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_cifrado" "bytea";--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_mestra_versao" smallint;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_ativado_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_ultimo_passo" bigint;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_pendente_cifrado" "bytea";--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_pendente_mestra_versao" smallint;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_pendente_expira_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "segundo_fator_falhas" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "recuperacao_geracao" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "master_codigo_recuperacao" ADD CONSTRAINT "master_codigo_recuperacao_master_usuario_id_master_usuario_id_fk" FOREIGN KEY ("master_usuario_id") REFERENCES "public"."master_usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_login_pendente" ADD CONSTRAINT "master_login_pendente_master_usuario_id_master_usuario_id_fk" FOREIGN KEY ("master_usuario_id") REFERENCES "public"."master_usuario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_login_pendente_token_uq" ON "master_login_pendente" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "master_login_pendente_usuario_idx" ON "master_login_pendente" USING btree ("master_usuario_id");--> statement-breakpoint
ALTER TABLE "master_sessao" ADD CONSTRAINT "master_sessao_revogacao_ck" CHECK ((revogada_em IS NULL) = (motivo_revogacao IS NULL) AND (motivo_revogacao IS NULL OR motivo_revogacao IN ('logout', 'troca_senha', 'credencial_reemitida', 'desativacao', 'segundo_fator')));--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_totp_ck" CHECK (((totp_cifrado IS NULL) = (totp_mestra_versao IS NULL) AND (totp_cifrado IS NULL) = (totp_ativado_em IS NULL)) AND (totp_cifrado IS NULL OR length(totp_cifrado) = 48) AND (totp_mestra_versao IS NULL OR totp_mestra_versao > 0));--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_totp_pendente_ck" CHECK (((totp_pendente_cifrado IS NULL) = (totp_pendente_mestra_versao IS NULL) AND (totp_pendente_cifrado IS NULL) = (totp_pendente_expira_em IS NULL)) AND (totp_pendente_cifrado IS NULL OR length(totp_pendente_cifrado) = 48) AND (totp_pendente_mestra_versao IS NULL OR totp_pendente_mestra_versao > 0));--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_totp_passo_ck" CHECK (totp_ultimo_passo IS NULL OR totp_ultimo_passo > 0);--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_segundo_fator_ck" CHECK (segundo_fator_falhas >= 0 AND recuperacao_geracao >= 0);--> statement-breakpoint
ALTER TABLE "plataforma_login_limite" ADD CONSTRAINT "plataforma_login_limite_tipo_ck" CHECK (tipo IN ('ip', 'master', 'master_ip', 'master_codigo'));--> statement-breakpoint
GRANT SELECT, INSERT ON master_codigo_recuperacao TO app_plataforma;
--> statement-breakpoint
GRANT UPDATE (usado_em) ON master_codigo_recuperacao TO app_plataforma;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON master_login_pendente TO app_plataforma;
--> statement-breakpoint
-- Explícito: sem DELETE nem TRUNCATE nas tabelas novas (as linhas de desafio e de códigos acumulam; limpeza fica fora).
REVOKE DELETE, TRUNCATE ON master_codigo_recuperacao, master_login_pendente FROM app_plataforma;
