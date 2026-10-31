-- RF-02 (pedido do cliente "remover visitante", decisão de 2026-10-22, spec §14): DESATIVAR o cadastro da pessoa, não
-- excluir. O histórico (eventos, vínculos, trilha) fica como está; a pessoa some das buscas, não entra, não recebe
-- vínculo nem autorização prévia, até ser reativada.
-- Parte gerada pelo drizzle-kit (schema.ts):
--   pessoa  + desativada_em, desativada_por_id (FK usuario_sistema), desativacao_motivo; pessoa_desativacao_ck (os três
--             juntos, motivo com 15+ caracteres, o MIN_JUSTIFICATIVA do domain).
-- Parte manual (no fim): o motivo é texto livre do operador e pode citar o titular, então
--   1. trigger pessoa_anonimizada_limpa_motivo: a anonimização (lgpd_anonimizar_titular, qualquer versão da API) troca o
--      motivo por um texto fixo (o CHECK continua valendo: a pessoa segue desativada, sem o texto);
--   2. lgpd_redigir_audit_pessoa passa a remover também `desativacao_motivo` dos snapshots da trilha da pessoa.
-- NÃO destrutiva: só colunas novas, nulas; nenhuma linha muda; GRANT de 0001 (UPDATE na tabela inteira) já cobre as
-- colunas; nada toca evento_acesso (a cadeia de hash não muda).
-- Rollback de imagem (voltar à API anterior SEM desfazer a migração) é compatível: a imagem anterior não lê nem grava as
-- colunas. Efeito: enquanto ela estiver no ar, quem foi desativado VOLTA a aparecer nas buscas e pode registrar entrada
-- (a desativação fica gravada e volta a valer com a imagem nova); não há como desativar/reativar por ela. Desfazer a
-- migração (DROP das colunas) apagaria quem está desativado: não fazer sem antes reativar todos pela API.
ALTER TABLE "pessoa" ADD COLUMN "desativada_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "pessoa" ADD COLUMN "desativada_por_id" uuid;--> statement-breakpoint
ALTER TABLE "pessoa" ADD COLUMN "desativacao_motivo" text;--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_desativada_por_id_usuario_sistema_id_fk" FOREIGN KEY ("desativada_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_desativacao_ck" CHECK (num_nonnulls(desativada_em, desativada_por_id, desativacao_motivo) IN (0, 3)
    AND (desativacao_motivo IS NULL OR length(btrim(coalesce(desativacao_motivo, ''))) >= 15));
--> statement-breakpoint
-- ===== Parte manual =========================================================================================

-- 1. Anonimizada não guarda o motivo da desativação (texto livre do operador). Fica a marca de que foi desativada.
CREATE FUNCTION pessoa_anonimizada_limpa_motivo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.anonimizada_em IS NOT NULL AND OLD.anonimizada_em IS NULL AND NEW.desativacao_motivo IS NOT NULL THEN
    NEW.desativacao_motivo := 'Removido na anonimização (LGPD)';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pessoa_anonimizada_limpa_motivo BEFORE UPDATE OF anonimizada_em ON pessoa
FOR EACH ROW EXECUTE FUNCTION pessoa_anonimizada_limpa_motivo();
--> statement-breakpoint

-- 2. Mesma função da 0001, com `desativacao_motivo` na lista. CREATE OR REPLACE mantém dono e GRANTs.
CREATE OR REPLACE FUNCTION lgpd_redigir_audit_pessoa(p_pessoa_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_campos text[] := ARRAY['nome', 'telefone', 'documento_mascarado', 'empresa', 'servico', 'desativacao_motivo'];
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pessoa WHERE id = p_pessoa_id AND anonimizada_em IS NOT NULL) THEN
    RAISE EXCEPTION 'pessoa % não está anonimizada', p_pessoa_id USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('portaria.operacao', 'redacao_audit', true);
  UPDATE audit_log
     SET antes = antes - v_campos, depois = depois - v_campos, redigido_em = clock_timestamp()
   WHERE entidade = 'pessoa' AND registro_id = p_pessoa_id AND redigido_em IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('portaria.operacao', '', true);
  INSERT INTO retencao_execucao (tipo, quantidade, detalhes)
  VALUES ('audit_redacao', v_n, jsonb_build_object('pessoa_id', p_pessoa_id));
  RETURN v_n;
END $$;
