-- Login do Master sem segundo fator (2026-10-23, decisão do usuário; docs/05_arquitetura_saas.md SAAS-08 e §5.3).
-- *Contract* direto, sem fase intermediária: só a API nova (que não lê nada disto) roda depois, porque o serviço `migrate`
-- do compose termina antes da `api` subir com a imagem nova (docs/deploy.md §18). Se o laço de migração falhar DEPOIS
-- desta (num banco de condomínio), a API velha continua no ar e só as rotas /plataforma dela quebram (selecionam colunas
-- que não existem mais); as rotas de condomínio não tocam estas tabelas.
--  - master_usuario: sai o segredo TOTP cifrado (o do Master em produção some junto, de propósito), a versão da mestra
--    que o cifrou, o anti-replay e os dois CHECKs. Senha, troca obrigatória, e-mail e papel ficam como estão: o Master
--    existente entra com a MESMA senha.
--  - master_sessao.totp_confirmado_em: só marcava a sessão aberta com o 2º fator. Sessões abertas continuam válidas.
--  - master_codigo_recuperacao: códigos de recuperação do 2º fator; nenhum código os gravou (§5.3). Sem CASCADE: se
--    algo depender da tabela, a migração falha em vez de levar junto.
-- app_migrator é o dono das tabelas (criadas por ele na 0000): DROP sem GRANT novo. Os GRANTs da tabela caem com ela.
ALTER TABLE "master_usuario" DROP CONSTRAINT "master_usuario_totp_ck";--> statement-breakpoint
ALTER TABLE "master_usuario" DROP CONSTRAINT "master_usuario_totp_passo_ck";--> statement-breakpoint
ALTER TABLE "master_usuario" DROP COLUMN "totp_cifrado";--> statement-breakpoint
ALTER TABLE "master_usuario" DROP COLUMN "totp_mestra_versao";--> statement-breakpoint
ALTER TABLE "master_usuario" DROP COLUMN "totp_ultimo_passo";--> statement-breakpoint
ALTER TABLE "master_sessao" DROP COLUMN "totp_confirmado_em";--> statement-breakpoint
DROP TABLE "master_codigo_recuperacao";
