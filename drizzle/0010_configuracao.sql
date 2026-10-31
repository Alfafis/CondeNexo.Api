-- Configuração do condomínio (SaaS: provisionamento de condomínio novo, docs/05_arquitetura_saas.md SAAS-06/18).
-- Só *expand*: tabela nova, vazia. Linha única com o agrupamento ("Bloco"/"Torre", que era fixo no código) e o fuso
-- (CHECK fixo em Brasília, SAAS-18). A CLI provisionar-condominio grava a linha do condomínio novo; o piloto fica sem
-- linha e a API usa o agrupamento padrão de antes (nenhuma mudança visível para ele).
CREATE TABLE "configuracao" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"agrupamento" text NOT NULL,
	"fuso" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"criado_em" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configuracao_linha_unica_ck" CHECK (id = 1),
	CONSTRAINT "configuracao_agrupamento_ck" CHECK (agrupamento IN ('Bloco', 'Torre')),
	CONSTRAINT "configuracao_fuso_ck" CHECK (fuso = 'America/Sao_Paulo')
);
--> statement-breakpoint
-- ===== Parte manual =========================================================================================
-- app_rw lê e grava a linha uma vez (CLI de provisionamento, que roda como app_rw, como o seed). Sem UPDATE nem DELETE:
-- mudar o agrupamento depois é tela da fase seguinte, com GRANT de coluna próprio.
GRANT SELECT, INSERT ON configuracao TO app_rw;
