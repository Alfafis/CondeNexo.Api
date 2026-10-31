-- Cadastro do condomínio na plataforma (SaaS, provisionamento; docs/05_arquitetura_saas.md §4.1 e "Módulos por
-- condomínio"): cidade/UF (lista "Licenças" do Master) e módulos contratados. Só *expand*: colunas novas, o piloto fica com
-- cidade/UF nulas e com todos os módulos (o default constante não reescreve a tabela). app_plataforma já tem INSERT e
-- UPDATE na tabela inteira (0000), então as colunas novas não pedem GRANT.
-- A lista de módulos repete MODULOS de @portaria/domain/modulos (conferido em test/saas-provisionar.test.ts).
ALTER TABLE "condominio" ADD COLUMN "cidade" text;--> statement-breakpoint
ALTER TABLE "condominio" ADD COLUMN "uf" text;--> statement-breakpoint
ALTER TABLE "condominio" ADD COLUMN "modulos" text[] DEFAULT ARRAY['encomendas', 'ocorrencias', 'autorizacoes_previas', 'importacao', 'veiculos', 'funcionarios', 'relatorios']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "condominio" ADD CONSTRAINT "condominio_local_ck" CHECK ((cidade IS NULL) = (uf IS NULL) AND (cidade IS NULL OR length(btrim(cidade)) BETWEEN 1 AND 100) AND (uf IS NULL OR uf IN ('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO')));--> statement-breakpoint
ALTER TABLE "condominio" ADD CONSTRAINT "condominio_modulos_ck" CHECK (modulos <@ ARRAY['encomendas', 'ocorrencias', 'autorizacoes_previas', 'importacao', 'veiculos', 'funcionarios', 'relatorios']::text[] AND array_position(modulos, NULL) IS NULL);