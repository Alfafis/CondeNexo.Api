-- RF-05 / RN-02: conferência do comprovante de vínculo, sem guardar o arquivo (LGPD art. 6º, III).
-- Parte gerada pelo drizzle-kit (schema.ts): enum tipo_comprovante, colunas conferencia_* e conferido_por_id no vínculo,
-- CHECKs (aprovado exige conferência; 'outro' exige descrição; observação curta sem sequência de 9+ dígitos), e remoção
-- do que guardava o comprovante: vinculo_unidade.documento_id, o checklist jsonb vinculo_unidade.conferencias e o
-- valor 'comprovante_vinculo' de tipo_documento (recriação do enum; falha se houver documento desse tipo).
-- Parte manual (no fim): o trigger de transição passa a congelar a conferência depois da aprovação.
-- Pré-requisito: nenhum vínculo aprovado sem conferência (o ADD CONSTRAINT falha e a migração aborta inteira).
CREATE TYPE "public"."tipo_comprovante" AS ENUM('escritura', 'contrato_compra_venda', 'contrato_locacao', 'outro');--> statement-breakpoint
ALTER TABLE "vinculo_unidade" DROP CONSTRAINT "vinculo_conferencias_ck";--> statement-breakpoint
ALTER TABLE "vinculo_unidade" DROP CONSTRAINT "vinculo_unidade_documento_id_documento_id_fk";
--> statement-breakpoint
ALTER TABLE "documento" ALTER COLUMN "tipo" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."tipo_documento";--> statement-breakpoint
CREATE TYPE "public"."tipo_documento" AS ENUM('foto', 'anexo_ocorrencia', 'outro');--> statement-breakpoint
ALTER TABLE "documento" ALTER COLUMN "tipo" SET DATA TYPE "public"."tipo_documento" USING "tipo"::"public"."tipo_documento";--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD COLUMN "conferencia_tipo_documento" "tipo_comprovante";--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD COLUMN "conferencia_descricao" text;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD COLUMN "conferencia_data" date;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD COLUMN "conferido_por_id" uuid;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD COLUMN "conferencia_observacao" text;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_unidade_conferido_por_id_usuario_sistema_id_fk" FOREIGN KEY ("conferido_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vinculo_unidade" DROP COLUMN "documento_id";--> statement-breakpoint
ALTER TABLE "vinculo_unidade" DROP COLUMN "conferencias";--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_conferencia_completa_ck" CHECK (num_nonnulls(conferencia_tipo_documento, conferencia_data, conferido_por_id) IN (0, 3));--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_conferencia_descricao_ck" CHECK (CASE WHEN conferencia_tipo_documento = 'outro'
    THEN length(btrim(coalesce(conferencia_descricao, ''))) BETWEEN 1 AND 80 ELSE conferencia_descricao IS NULL END);--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_conferencia_observacao_ck" CHECK (conferencia_observacao IS NULL
    OR (conferencia_tipo_documento IS NOT NULL AND length(conferencia_observacao) <= 200));--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_conferencia_sem_numero_ck" CHECK (regexp_replace(coalesce(conferencia_descricao, '') || ' ' || coalesce(conferencia_observacao, ''), '[. -]', '', 'g') !~ '[0-9]{9}');--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_conferencia_antes_decisao_ck" CHECK (conferencia_data IS NULL OR decidido_em IS NULL
    OR conferencia_data <= (decidido_em AT TIME ZONE 'UTC')::date);--> statement-breakpoint
ALTER TABLE "vinculo_unidade" ADD CONSTRAINT "vinculo_aprovado_conferido_ck" CHECK (status <> 'aprovado' OR conferido_por_id IS NOT NULL);--> statement-breakpoint
-- ===== Parte manual: máquina de estado do vínculo (substitui a função da 0001; o trigger continua o mesmo) =====
-- Igual à 0001, mais: com OLD.status = 'aprovado', as colunas da conferência não mudam (a base da aprovação fica fixa).
-- Enquanto pendente ou legado, a conferência pode ser refeita; cada registro gera linha no audit_log (antes/depois).
CREATE OR REPLACE FUNCTION vinculo_unidade_transicao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pendente', 'legado') THEN
      RAISE EXCEPTION 'vínculo nasce pendente ou legado, não %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('rejeitado', 'encerrado') THEN
    RAISE EXCEPTION 'vínculo % está em estado final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pendente' AND NEW.status IN ('aprovado', 'rejeitado'))
    OR (OLD.status = 'aprovado' AND NEW.status = 'encerrado')
    OR (OLD.status = 'legado' AND NEW.status IN ('aprovado', 'encerrado'))) THEN
    RAISE EXCEPTION 'transição de vínculo inválida: % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'aprovado'
     AND (NEW.conferencia_tipo_documento, NEW.conferencia_descricao, NEW.conferencia_data, NEW.conferido_por_id, NEW.conferencia_observacao)
         IS DISTINCT FROM
         (OLD.conferencia_tipo_documento, OLD.conferencia_descricao, OLD.conferencia_data, OLD.conferido_por_id, OLD.conferencia_observacao) THEN
    RAISE EXCEPTION 'conferência do comprovante do vínculo % é imutável depois da aprovação', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
