-- Spec §5.1: o bloqueio de login passa a valer por PAR login+IP (tipo 'login_ip'), e não mais só pelo login. Antes, 10
-- falhas em qualquer IP bloqueavam a conta por 15 min: com os logins do seed públicos, qualquer um mantinha o porteiro
-- bloqueado indefinidamente. O tipo 'login' continua existindo, mas só gradua o atraso crescente (sem bloqueio total);
-- o tipo 'ip' continua bloqueando.
-- Gerada pelo drizzle-kit (schema.ts): só alarga o CHECK de tipo. NÃO destrutiva: nenhuma linha muda.
-- Rollback de imagem (voltar à API anterior SEM desfazer a migração) é compatível: a imagem antiga nunca grava nem lê
-- 'login_ip' (as linhas ficam órfãs, sem efeito), e volta a bloquear pelo tipo 'login' como antes. Desfazer a migração
-- exige antes `DELETE FROM login_limite WHERE tipo = 'login_ip'` como app_migrator (app_rw não tem DELETE).
ALTER TABLE "login_limite" DROP CONSTRAINT "login_limite_tipo_ck";--> statement-breakpoint
ALTER TABLE "login_limite" ADD CONSTRAINT "login_limite_tipo_ck" CHECK (tipo IN ('login', 'ip', 'login_ip'));