-- Registro das anonimizações fora do banco do condomínio (LGPD art. 18, VI): sobrevive ao restore do banco do
-- condomínio e permite reaplicar (jobs.js reaplicar-anonimizacoes, docs/deploy.md seção 9). Só ids, nenhum dado pessoal.
-- Parte manual (no fim): append-only (mesmo trigger da trilha da plataforma) e GRANT mínimo (SELECT, INSERT).
CREATE TABLE "lgpd_anonimizacao" (
	"condominio_id" uuid NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"motivo" text NOT NULL,
	"anonimizada_em" timestamp (3) with time zone NOT NULL,
	"registrada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lgpd_anonimizacao_pk" PRIMARY KEY("condominio_id","pessoa_id"),
	CONSTRAINT "lgpd_anonimizacao_motivo_ck" CHECK (motivo IN ('pedido', 'retencao'))
);
--> statement-breakpoint
ALTER TABLE "lgpd_anonimizacao" ADD CONSTRAINT "lgpd_anonimizacao_condominio_id_condominio_id_fk" FOREIGN KEY ("condominio_id") REFERENCES "public"."condominio"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- ===== Parte manual =========================================================================================
CREATE TRIGGER lgpd_anonimizacao_imutavel BEFORE UPDATE OR DELETE ON lgpd_anonimizacao
FOR EACH ROW EXECUTE FUNCTION plataforma_audit_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER lgpd_anonimizacao_sem_truncate BEFORE TRUNCATE ON lgpd_anonimizacao
FOR EACH STATEMENT EXECUTE FUNCTION plataforma_audit_bloqueia_alteracao();
--> statement-breakpoint
GRANT SELECT, INSERT ON lgpd_anonimizacao TO app_plataforma;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON lgpd_anonimizacao FROM app_plataforma;
