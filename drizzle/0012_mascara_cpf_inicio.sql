-- Máscara do CPF com os 5 PRIMEIROS dígitos para cadastro novo (decisão do usuário de 2026-10-24, LGPD; docs/01 e 02).
-- O CHECK passa a aceitar os dois formatos: "***.456.789-**" (antigo, dígitos 4 a 9) e "123.45*.***-**" (novo, 1 a 5).
-- Os asteriscos continuam fixos nas posições escondidas: o CPF completo segue recusado. O número não é guardado.
-- Linhas existentes: nenhuma muda (não há como converter: o CPF não existe no banco). Elas passam no CHECK novo, que o
-- ADD CONSTRAINT valida na hora. Qual formato cada pessoa recebe é regra da API (anti-reconstrução: o mesmo CPF nunca
-- nos dois formatos; ver @portaria/domain/cpf e pessoas/formato-cpf.ts).
-- Rollback: a imagem anterior da API continua funcionando com esta migração (só gera o formato antigo, que segue
-- aceito). Desfazer o CHECK só é possível enquanto não houver linha no formato novo: na prática, sem volta depois de usada.
ALTER TABLE "pessoa" DROP CONSTRAINT "pessoa_documento_mascarado_ck";--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_documento_mascarado_ck" CHECK (documento_mascarado ~ '^(\*\*\*\.[0-9]{3}\.[0-9]{3}-\*\*|[0-9]{3}\.[0-9]{2}\*\.\*\*\*-\*\*)$');