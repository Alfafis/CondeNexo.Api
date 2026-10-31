-- Entrega 1 da F5 (docs/05_arquitetura_saas.md SAAS-07/08; app do Master): autenticação do Master na plataforma.
-- Só *expand* sobre tabelas que a 0000 criou e que nenhum código usou até aqui (master_usuario e master_sessao vazias):
--  - master_usuario: versão da mestra que cifrou o segredo TOTP, último passo TOTP aceito (anti-replay), troca de senha
--    obrigatória com validade da temporária, último acesso. `totp_mestra_versao` é NOT NULL sem default: se alguém tiver
--    inserido Master à mão antes desta migração, ela FALHA (de propósito; não há como inventar a versão da mestra).
--  - master_sessao: motivo da revogação (+ índice por usuário, para revogar todas as sessões dele).
--  - plataforma_login_limite: tipo `master_ip` (par login+IP, como `login_ip` da 0008 do condomínio).
-- app_plataforma já tem SELECT/INSERT/UPDATE nessas tabelas (0000, GRANT por tabela): nada de GRANT novo. Sem DELETE.
ALTER TABLE "plataforma_login_limite" DROP CONSTRAINT "plataforma_login_limite_tipo_ck";--> statement-breakpoint
ALTER TABLE "master_sessao" ADD COLUMN "motivo_revogacao" text;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_mestra_versao" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "totp_ultimo_passo" bigint;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "deve_trocar_senha" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "senha_temporaria_expira_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "master_usuario" ADD COLUMN "ultimo_acesso" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "master_sessao_usuario_idx" ON "master_sessao" USING btree ("master_usuario_id");--> statement-breakpoint
ALTER TABLE "master_sessao" ADD CONSTRAINT "master_sessao_revogacao_ck" CHECK ((revogada_em IS NULL) = (motivo_revogacao IS NULL) AND (motivo_revogacao IS NULL OR motivo_revogacao IN ('logout', 'troca_senha', 'credencial_reemitida', 'desativacao')));--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_email_ck" CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' AND length(email) <= 254);--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_totp_ck" CHECK (length(totp_cifrado) BETWEEN 44 AND 108 AND totp_mestra_versao > 0);--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_totp_passo_ck" CHECK (totp_ultimo_passo IS NULL OR totp_ultimo_passo > 0);--> statement-breakpoint
ALTER TABLE "master_usuario" ADD CONSTRAINT "master_usuario_temporaria_ck" CHECK (deve_trocar_senha OR senha_temporaria_expira_em IS NULL);--> statement-breakpoint
ALTER TABLE "plataforma_login_limite" ADD CONSTRAINT "plataforma_login_limite_tipo_ck" CHECK (tipo IN ('ip', 'master', 'master_ip'));