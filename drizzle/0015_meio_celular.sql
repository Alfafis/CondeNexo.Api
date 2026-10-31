-- Meio de autorização 'celular' (questionário com a equipe, 22/10/2026): WhatsApp ou ligação para o celular do morador,
-- o recurso dos porteiros quando ele não atende o interfone. Mesma regra do interfone: morador identificado, com vínculo
-- válido na unidade (API), e vale também para a recusa. Não é exceção (ehExcecaoSql só olha excecao_porteiro e a AP sem
-- solicitante), e o hash não muda de formato: o meio entra na serialização canônica como texto (canon_texto(::text)).
-- Tudo gerado pelo drizzle-kit (schema.ts). Transação: o migrador do Drizzle aplica as pendentes numa transação só, e o
-- PostgreSQL 12+ aceita ADD VALUE dentro dela, mas o valor novo não pode ser USADO antes do commit ("unsafe use of new
-- value"). Por isso os dois CHECKs comparam `autorizado_por_tipo::text`: o literal 'celular' fica texto, sem conversão
-- para o enum. ADD VALUE ... BEFORE é só catálogo (sem reescrever a tabela); o ADD CONSTRAINT valida as linhas existentes
-- (uma varredura por CHECK, sob o lock do ALTER), e todas passam: nenhuma tem 'celular' e a regra antiga está contida na nova.
-- Rollback de imagem (API anterior com esta migração aplicada): registra e lê normalmente, a verificação da cadeia e do
-- selo continua válida (o hash é do texto do meio). Mas a imagem anterior não conhece 'celular': o zod dela recusa
-- `meio=celular` no filtro (400), o rótulo do meio sai vazio (relatório CSV, exportação do titular) e a correção pode
-- tirar o autorizador de uma entrada por celular (o banco não impede: a correção não grava meio). Nada quebra a leitura.
-- Desfazer: não há DROP VALUE em enum; depois de usado, só reescrevendo os eventos, o que a trilha append-only proíbe.
ALTER TYPE "public"."meio_autorizacao" ADD VALUE 'celular' BEFORE 'morador_presente';--> statement-breakpoint
ALTER TABLE "evento_acesso" DROP CONSTRAINT "evento_recusa_meio_ck";--> statement-breakpoint
ALTER TABLE "evento_acesso" DROP CONSTRAINT "evento_morador_identificado_ck";--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_recusa_meio_ck" CHECK (tipo <> 'recusado' OR autorizado_por_tipo::text IN ('interfone', 'celular', 'morador_presente'));--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_morador_identificado_ck" CHECK (autorizado_por_tipo::text NOT IN ('interfone', 'celular', 'morador_presente')
    OR autorizado_por_pessoa_id IS NOT NULL);