-- Spec §5.1: a senha temporária (criada pela administração no cadastro ou na redefinição) vale 72 h. Antes não
-- expirava: uma mensagem esquecida no WhatsApp valia para sempre. O prazo (constante de @portaria/domain/rules) é
-- gravado pela API em senha_temporaria_expira_em; a troca de senha volta a coluna para NULL.
-- Parte gerada pelo drizzle-kit (schema.ts): a coluna e o CHECK "sem troca pendente, sem prazo". O inverso (troca
-- pendente exige prazo) NÃO vira CHECK de propósito: o default de deve_trocar_senha é true e há INSERTs sem o prazo
-- (fixtures, código antigo durante o deploy). A API trata troca pendente sem prazo como vencida (falha fechada).
-- Parte manual: backfill ENTRE a coluna e o CHECK. NÃO destrutiva: nenhuma linha some, nenhuma senha muda.
-- Linhas que já devem trocar a senha recebem o prazo a partir da última senha definida por terceiro:
-- senha_alterada_em (redefinição) ou, se NULL, criado_em (cadastro e seed não gravam senha_alterada_em).
-- Sem GRANT novo: app_rw tem SELECT/INSERT/UPDATE na tabela inteira (0001), sem GRANT por coluna; sem trigger.
ALTER TABLE "usuario_sistema" ADD COLUMN "senha_temporaria_expira_em" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "usuario_sistema"
   SET "senha_temporaria_expira_em" = COALESCE("senha_alterada_em", "criado_em") + interval '72 hours'
 WHERE "deve_trocar_senha";--> statement-breakpoint
ALTER TABLE "usuario_sistema" ADD CONSTRAINT "usuario_senha_temporaria_ck" CHECK (deve_trocar_senha OR senha_temporaria_expira_em IS NULL);
