-- LGPD (spec §9.1 e §9.3) e selo diário com âncora externa (spec §4.6).
-- Parte gerada pelo drizzle-kit (schema.ts):
--   selo_cadeia        + tipo ('diario' | 'manual'). O diário continua um por dia (índice único parcial); o manual
--                      ("Selar agora", SI/AU) pode repetir o dia. Antes, UNIQUE(data) impedia selar sob demanda.
--   retencao_execucao  + tipo 'audit_descarte' (trilha de alterações com mais de 3 anos, seção 7 dos requisitos).
-- Parte manual (no fim): funções SECURITY DEFINER no padrão da 0001 (o app_rw não tem DELETE nem INSERT em
-- retencao_execucao; cada procedimento controlado faz a sua parte e registra a execução) e os GRANTs.
ALTER TABLE "selo_cadeia" DROP CONSTRAINT "selo_cadeia_data_uq";--> statement-breakpoint
ALTER TABLE "retencao_execucao" DROP CONSTRAINT "retencao_tipo_ck";--> statement-breakpoint
ALTER TABLE "selo_cadeia" ADD COLUMN "tipo" text DEFAULT 'diario' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "selo_cadeia_diario_uq" ON "selo_cadeia" USING btree ("data") WHERE tipo = 'diario';--> statement-breakpoint
ALTER TABLE "retencao_execucao" ADD CONSTRAINT "retencao_tipo_ck" CHECK (tipo IN ('eventos', 'audit_redacao', 'pessoas', 'documentos', 'audit_descarte'));--> statement-breakpoint
ALTER TABLE "selo_cadeia" ADD CONSTRAINT "selo_cadeia_tipo_ck" CHECK (tipo IN ('diario', 'manual'));
--> statement-breakpoint
-- ===== Parte manual =========================================================================================

-- Selo: o tipo também é imutável depois de gravado (só o envio da âncora pode ser registrado, uma vez).
CREATE OR REPLACE FUNCTION selo_cadeia_validar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM evento_acesso WHERE seq = NEW.ultimo_seq AND hash = NEW.ultimo_hash)
       AND NOT EXISTS (SELECT 1 FROM evento_acesso_cadeia WHERE ultimo_seq = NEW.ultimo_seq AND ultimo_hash = NEW.ultimo_hash) THEN
      RAISE EXCEPTION 'selo não confere com a cadeia (seq %)', NEW.ultimo_seq USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.enviado_em IS NOT NULL
     OR (NEW.id, NEW.data, NEW.tipo, NEW.ultimo_seq, NEW.ultimo_hash, NEW.criado_em)
        IS DISTINCT FROM (OLD.id, OLD.data, OLD.tipo, OLD.ultimo_seq, OLD.ultimo_hash, OLD.criado_em) THEN
    RAISE EXCEPTION 'selo é imutável: só o envio da âncora pode ser registrado, uma vez'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Append-only: mais uma exceção controlada, o DELETE da trilha de alterações vencida (retencao_descartar_audit).
CREATE OR REPLACE FUNCTION trilha_bloqueia_alteracao() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_dono boolean := current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = TG_RELID);
  v_operacao text := coalesce(current_setting('portaria.operacao', true), '');
BEGIN
  IF TG_LEVEL = 'ROW' AND v_dono THEN
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'evento_acesso' AND v_operacao = 'retencao_eventos' THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'audit_log' AND v_operacao = 'redacao_audit' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_log' AND v_operacao = 'retencao_audit' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'tabela % é append-only (RN-04): % bloqueado', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

-- Trilha de alterações: 3 anos a partir da data do registro (seção 7). O prazo é do relógio do BANCO, não um
-- parâmetro: quem só tem app_rw não consegue apagar registro recente passando outra data.
CREATE FUNCTION retencao_descartar_audit() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_limite timestamptz := now() - interval '3 years';
  v_ate bigint;
  v_n integer;
BEGIN
  SELECT max(seq) INTO v_ate FROM audit_log WHERE em < v_limite;
  IF v_ate IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM set_config('portaria.operacao', 'retencao_audit', true);
  DELETE FROM audit_log WHERE em < v_limite;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('portaria.operacao', '', true);
  INSERT INTO retencao_execucao (tipo, quantidade, detalhes)
  VALUES ('audit_descarte', v_n, jsonb_build_object('limite', v_limite, 'ate_seq_audit', v_ate));
  RETURN v_n;
END $$;
--> statement-breakpoint

-- Anonimização (art. 18, VI, e retenção): numa transação só, apaga os dados pessoais da pessoa, marca a foto como
-- eliminada (o arquivo é apagado pela API depois do COMMIT), redige a trilha dela e registra a execução. A lista de
-- campos fica aqui, junto com a de lgpd_redigir_audit_pessoa. A regra "sem vínculo válido" é da API (checada com a
-- linha travada antes de chamar). Devolve quantos registros da trilha foram redigidos.
CREATE FUNCTION lgpd_anonimizar_pessoa(p_pessoa_id uuid, p_motivo text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_foto uuid;
  v_anonimizada timestamptz;
  v_n integer;
BEGIN
  IF p_motivo IS NULL OR p_motivo NOT IN ('pedido', 'retencao') THEN
    RAISE EXCEPTION 'motivo de anonimização inválido' USING ERRCODE = 'check_violation';
  END IF;
  SELECT foto_documento_id, anonimizada_em INTO v_foto, v_anonimizada FROM pessoa WHERE id = p_pessoa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pessoa % não existe', p_pessoa_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_anonimizada IS NOT NULL THEN
    RAISE EXCEPTION 'pessoa % já está anonimizada', p_pessoa_id USING ERRCODE = 'check_violation';
  END IF;
  UPDATE pessoa
     SET nome = 'Pessoa anonimizada', documento_mascarado = NULL, documento_busca = NULL, telefone = NULL,
         empresa = NULL, servico = NULL, foto_documento_id = NULL,
         anonimizada_em = clock_timestamp(), atualizado_em = clock_timestamp()
   WHERE id = p_pessoa_id;
  IF v_foto IS NOT NULL THEN
    UPDATE documento SET eliminado_em = clock_timestamp() WHERE id = v_foto AND eliminado_em IS NULL;
  END IF;
  v_n := lgpd_redigir_audit_pessoa(p_pessoa_id);
  INSERT INTO retencao_execucao (tipo, quantidade, detalhes)
  VALUES ('pessoas', 1, jsonb_build_object('pessoa_id', p_pessoa_id, 'motivo', p_motivo, 'foto_documento_id', v_foto));
  RETURN v_n;
END $$;
--> statement-breakpoint

-- Eliminação de arquivos (foto ao fim do vínculo, anexo de ocorrência vencido): marca eliminado_em e registra a
-- execução. O arquivo cifrado é apagado do volume pela API depois do COMMIT; se a remoção falhar, a varredura de
-- órfãos da próxima execução apaga o arquivo de registro já eliminado. Só marca o que ainda não foi eliminado.
CREATE FUNCTION retencao_eliminar_documentos(p_ids uuid[], p_motivo text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ids uuid[];
  v_n integer;
BEGIN
  IF p_motivo IS NULL OR p_motivo NOT IN ('foto_fim_vinculo', 'anexo_ocorrencia') THEN
    RAISE EXCEPTION 'motivo de eliminação inválido' USING ERRCODE = 'check_violation';
  END IF;
  WITH x AS (
    UPDATE documento SET eliminado_em = clock_timestamp()
     WHERE id = ANY (p_ids) AND eliminado_em IS NULL
    RETURNING id
  )
  SELECT array_agg(id), count(*) INTO v_ids, v_n FROM x;
  IF v_n > 0 THEN
    INSERT INTO retencao_execucao (tipo, quantidade, detalhes)
    VALUES ('documentos', v_n, jsonb_build_object('motivo', p_motivo, 'documento_ids', to_jsonb(v_ids)));
  END IF;
  RETURN v_n;
END $$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION retencao_descartar_audit(), lgpd_anonimizar_pessoa(uuid, text),
  retencao_eliminar_documentos(uuid[], text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retencao_descartar_audit(), lgpd_anonimizar_pessoa(uuid, text),
  retencao_eliminar_documentos(uuid[], text) TO app_rw;
