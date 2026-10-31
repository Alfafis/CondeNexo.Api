-- Autenticação (spec §5.1): sessão por token opaco, limite de tentativas de login persistente e troca obrigatória de senha.
-- Parte gerada pelo drizzle-kit (schema.ts):
--   sessao        token_hash (SHA-256 hex, único), expiração absoluta em expira_em, revogação lógica (app_rw não tem DELETE).
--   login_limite  contador por (tipo, chave) com UPSERT atômico: funciona com várias réplicas da API e não cresce por
--                 tentativa (uma linha por login/IP distinto). A trilha de cada tentativa já fica no audit_log.
--   usuario_sistema  + deve_trocar_senha (default true: senha criada por terceiro), + senha_alterada_em;
--                    - falhas_login e bloqueado_ate (o bloqueio passa a viver em login_limite, igual para login existente
--                    e inexistente, sem enumeração). Sem dado real em produção quando esta migração foi escrita.
-- Parte manual (no fim): GRANT mínimo para app_rw. Sem ALTER DEFAULT PRIVILEGES (0001): tabela nova sem GRANT falha fechada.
CREATE TABLE "login_limite" (
	"tipo" text NOT NULL,
	"chave" text NOT NULL,
	"falhas" smallint NOT NULL,
	"janela_inicio" timestamp (3) with time zone NOT NULL,
	"bloqueado_ate" timestamp (3) with time zone,
	"atualizado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_limite_pk" PRIMARY KEY("tipo","chave"),
	CONSTRAINT "login_limite_tipo_ck" CHECK (tipo IN ('login', 'ip')),
	CONSTRAINT "login_limite_chave_ck" CHECK (chave ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "login_limite_falhas_ck" CHECK (falhas >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"usuario_id" uuid NOT NULL,
	"criada_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ultimo_uso_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp (3) with time zone NOT NULL,
	"revogada_em" timestamp (3) with time zone,
	"motivo_revogacao" text,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "sessao_token_hash_ck" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sessao_expira_ck" CHECK (expira_em > criada_em),
	CONSTRAINT "sessao_revogacao_ck" CHECK (num_nonnulls(revogada_em, motivo_revogacao) IN (0, 2)),
	CONSTRAINT "sessao_motivo_ck" CHECK (motivo_revogacao IS NULL OR motivo_revogacao IN ('logout', 'desativacao', 'troca_senha', 'redefinicao_senha')),
	CONSTRAINT "sessao_user_agent_ck" CHECK (user_agent IS NULL OR length(user_agent) <= 300)
);
--> statement-breakpoint
ALTER TABLE "usuario_sistema" DROP CONSTRAINT "usuario_falhas_ck";--> statement-breakpoint
ALTER TABLE "usuario_sistema" ADD COLUMN "deve_trocar_senha" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "usuario_sistema" ADD COLUMN "senha_alterada_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sessao" ADD CONSTRAINT "sessao_usuario_id_usuario_sistema_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessao_token_uq" ON "sessao" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessao_usuario_ix" ON "sessao" USING btree ("usuario_id");--> statement-breakpoint
ALTER TABLE "usuario_sistema" DROP COLUMN "falhas_login";--> statement-breakpoint
ALTER TABLE "usuario_sistema" DROP COLUMN "bloqueado_ate";--> statement-breakpoint
-- ===== Parte manual: permissões do app_rw (camada 1, padrão da 0001) =====================================
-- Sessão: cria, lê e só altera uso e revogação. Token, usuário e expiração ficam imutáveis para a API.
GRANT SELECT, INSERT ON sessao TO app_rw;
--> statement-breakpoint
GRANT UPDATE (ultimo_uso_em, revogada_em, motivo_revogacao) ON sessao TO app_rw;
--> statement-breakpoint
-- Limite de login: o UPSERT (INSERT ... ON CONFLICT DO UPDATE) exige INSERT e UPDATE nas colunas alteradas.
GRANT SELECT, INSERT ON login_limite TO app_rw;
--> statement-breakpoint
GRANT UPDATE (falhas, janela_inicio, bloqueado_ate, atualizado_em) ON login_limite TO app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON sessao, login_limite FROM app_rw;
