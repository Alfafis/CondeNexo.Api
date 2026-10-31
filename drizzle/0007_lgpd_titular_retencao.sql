-- LGPD: anonimização que alcança o texto livre, retenção de veículo, operador e sessão, e dependente menor (art. 14).
-- Parte gerada pelo drizzle-kit (schema.ts):
--   pessoa            + menor_idade: dependente menor sem CPF e sem telefone (não é "sem CPF": entra como morador).
--                       pessoa_documento_coerente_ck e pessoa_telefone_obrigatorio_ck aceitam o menor; pessoa_menor_ck.
--   usuario_sistema   + desativado_em (fato gerador "ativo + 3 anos") e anonimizado_em.
--   veiculo           + desativado_em (fato gerador da retenção do veículo).
--   retencao_execucao + tipos 'veiculos', 'operadores', 'sessoes'.
-- Parte manual (no fim): backfill das datas de desativação e trigger que as mantém, funções de nome (padrão de busca acento-insensível),
-- exceção controlada nos triggers de congelamento, lgpd_anonimizar_titular (substitui o corpo de lgpd_anonimizar_pessoa),
-- funções de retenção novas e GRANTs. Nenhuma função toca evento_acesso: a cadeia de hash não muda.
ALTER TABLE "pessoa" DROP CONSTRAINT "pessoa_documento_coerente_ck";--> statement-breakpoint
ALTER TABLE "pessoa" DROP CONSTRAINT "pessoa_telefone_obrigatorio_ck";--> statement-breakpoint
ALTER TABLE "retencao_execucao" DROP CONSTRAINT "retencao_tipo_ck";--> statement-breakpoint
ALTER TABLE "pessoa" ADD COLUMN "menor_idade" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usuario_sistema" ADD COLUMN "desativado_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "usuario_sistema" ADD COLUMN "anonimizado_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "veiculo" ADD COLUMN "desativado_em" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_menor_ck" CHECK (NOT menor_idade OR (NOT sem_cpf AND categoria = 'morador'));--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_documento_coerente_ck" CHECK (anonimizada_em IS NOT NULL
    OR (sem_cpf AND documento_busca IS NULL AND documento_mascarado IS NULL)
    OR (NOT sem_cpf AND documento_busca IS NOT NULL AND documento_mascarado IS NOT NULL)
    OR (menor_idade AND NOT sem_cpf AND documento_busca IS NULL AND documento_mascarado IS NULL));--> statement-breakpoint
ALTER TABLE "pessoa" ADD CONSTRAINT "pessoa_telefone_obrigatorio_ck" CHECK (telefone IS NOT NULL OR anonimizada_em IS NOT NULL OR importacao_id IS NOT NULL OR menor_idade);--> statement-breakpoint
ALTER TABLE "retencao_execucao" ADD CONSTRAINT "retencao_tipo_ck" CHECK (tipo IN ('eventos', 'audit_redacao', 'pessoas', 'documentos', 'audit_descarte', 'veiculos', 'operadores', 'sessoes'));--> statement-breakpoint
ALTER TABLE "usuario_sistema" ADD CONSTRAINT "usuario_desativado_ck" CHECK (NOT ativo OR (desativado_em IS NULL AND anonimizado_em IS NULL));--> statement-breakpoint
ALTER TABLE "veiculo" ADD CONSTRAINT "veiculo_desativado_ck" CHECK (NOT ativo OR desativado_em IS NULL);
--> statement-breakpoint
-- ===== Parte manual =========================================================================================

-- Backfill do fato gerador: a data real da desativação, se a trilha ainda a tem; senão, agora (conservador: só atrasa
-- a retenção, nunca a antecipa).
UPDATE usuario_sistema u
   SET desativado_em = coalesce((SELECT max(a.em) FROM audit_log a WHERE a.acao = 'usuario.desativar' AND a.registro_id = u.id), clock_timestamp())
 WHERE NOT u.ativo AND u.desativado_em IS NULL;
--> statement-breakpoint
UPDATE veiculo v
   SET desativado_em = coalesce((SELECT max(a.em) FROM audit_log a WHERE a.acao = 'veiculo.editar' AND a.registro_id = v.id
                                   AND a.depois ->> 'ativo' = 'false'), clock_timestamp())
 WHERE NOT v.ativo AND v.desativado_em IS NULL;
--> statement-breakpoint

-- O fato gerador é mantido pelo banco, não só pela API: qualquer caminho que mude `ativo` (inclusive uma imagem anterior
-- da API, num rollback) marca ou limpa a data. Se quem atualiza já mandou a data (a API usa o relógio dela), vale a dela.
CREATE FUNCTION marcar_desativacao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ativo IS DISTINCT FROM OLD.ativo THEN
    NEW.desativado_em := CASE WHEN NEW.ativo THEN NULL ELSE coalesce(NEW.desativado_em, clock_timestamp()) END;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER veiculo_desativacao BEFORE UPDATE OF ativo ON veiculo
FOR EACH ROW EXECUTE FUNCTION marcar_desativacao();
--> statement-breakpoint
CREATE TRIGGER usuario_sistema_desativacao BEFORE UPDATE OF ativo ON usuario_sistema
FOR EACH ROW EXECUTE FUNCTION marcar_desativacao();
--> statement-breakpoint

-- Nome normalizado: sem acento (maiúsculas e minúsculas, antes do lower: não depende do locale), minúsculo, espaço simples.
CREATE FUNCTION lgpd_nome_normalizado(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(lower(translate(coalesce(p, ''),
    'áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
    'aaaaaaeeeeiiiiooooouuuucnyaaaaaaeeeeiiiiooooouuuucny')), '\s+', ' ', 'g'))
$$;
--> statement-breakpoint

-- Padrão (regex ARE, usar com flag 'i') que encontra o NOME COMPLETO em texto livre, sem diferenciar acento nem caixa
-- e com qualquer espaço entre as partes. Nulo quando o nome é curto demais para ser procurado com segurança (uma
-- palavra só, ou menos de 5 letras): "Ana" casaria com qualquer texto. Não acha apelido, abreviação nem erro de digitação.
CREATE FUNCTION lgpd_padrao_nome(p_nome text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_norm text := lgpd_nome_normalizado(p_nome);
  v_tokens text[];
  v_partes text[] := '{}';
  v_tok text;
  v_c text;
  v_out text;
BEGIN
  IF v_norm = '' THEN
    RETURN NULL;
  END IF;
  v_tokens := regexp_split_to_array(v_norm, ' ');
  IF cardinality(v_tokens) < 2 OR length(replace(v_norm, ' ', '')) < 5 THEN
    RETURN NULL;
  END IF;
  FOREACH v_tok IN ARRAY v_tokens LOOP
    v_out := '';
    FOREACH v_c IN ARRAY regexp_split_to_array(v_tok, '') LOOP
      v_out := v_out || CASE v_c
        WHEN 'a' THEN '[aáàâãäåAÁÀÂÃÄÅ]' WHEN 'e' THEN '[eéèêëEÉÈÊË]' WHEN 'i' THEN '[iíìîïIÍÌÎÏ]'
        WHEN 'o' THEN '[oóòôõöOÓÒÔÕÖ]' WHEN 'u' THEN '[uúùûüUÚÙÛÜ]' WHEN 'c' THEN '[cçCÇ]' WHEN 'n' THEN '[nñNÑ]'
        WHEN 'y' THEN '[yýYÝ]'
        ELSE CASE
          WHEN v_c ~ '^[a-z0-9]$' THEN v_c
          WHEN v_c IN (']', '^', '-', '\') THEN '\' || v_c
          ELSE '[' || v_c || ']'
        END
      END;
    END LOOP;
    v_partes := v_partes || v_out;
  END LOOP;
  RETURN '(?<![[:alnum:]])' || array_to_string(v_partes, '\s+') || '(?![[:alnum:]])';
END $$;
--> statement-breakpoint

CREATE FUNCTION lgpd_trocar_nome(p_texto text, p_padrao text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_texto IS NULL OR p_padrao IS NULL THEN p_texto
              ELSE regexp_replace(p_texto, p_padrao, '[anonimizado]', 'gi') END
$$;
--> statement-breakpoint

-- Exceção controlada dos triggers de congelamento: só vale dentro de lgpd_anonimizar_titular (SECURITY DEFINER, roda
-- como o dono da tabela, que liga 'portaria.operacao'). O app_rw pode ligar o GUC, mas não é o dono: não passa.
CREATE FUNCTION lgpd_limpeza_controlada(p_relid oid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('portaria.operacao', true), '') = 'lgpd_anonimizar'
     AND current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = p_relid)
$$;
--> statement-breakpoint

-- Triggers de congelamento (0001/0002) com a exceção acima. Fora dela, o comportamento é o mesmo de antes.
CREATE OR REPLACE FUNCTION encomenda_retirada_congela() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retirada_em IS NOT NULL AND NOT lgpd_limpeza_controlada(TG_RELID) THEN
    RAISE EXCEPTION 'encomenda % já foi retirada', OLD.numero USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION revogacao_congela() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revogada_em IS NOT NULL AND NOT lgpd_limpeza_controlada(TG_RELID) THEN
    RAISE EXCEPTION '% % já foi revogada: registro congelado', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ocorrencia_transicao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'aberta' THEN
      RAISE EXCEPTION 'ocorrência nasce aberta' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status AND lgpd_limpeza_controlada(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'encerrada' THEN
    RAISE EXCEPTION 'ocorrência encerrada não pode ser alterada' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'aberta' AND NEW.status = 'em_andamento')
    OR (OLD.status = 'em_andamento' AND NEW.status = 'encerrada')) THEN
    RAISE EXCEPTION 'transição de ocorrência inválida: % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vinculo_unidade_transicao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pendente', 'legado') THEN
      RAISE EXCEPTION 'vínculo nasce pendente ou legado, não %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Anonimização: só texto livre muda (o status nunca; a função controla as colunas).
  IF NEW.status = OLD.status AND lgpd_limpeza_controlada(TG_RELID) THEN
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
--> statement-breakpoint

-- Anonimização completa (art. 18, VI, e retenção), numa transação só:
--  1. pessoa: como na 0004 (nome genérico, sem documento, telefone, empresa, serviço e foto) + redação da trilha dela;
--  2. texto livre LIGADO À PESSOA POR ID (é sobre ela): nota, justificativa e observação dos vínculos dela, motivo das
--     restrições contra ela e justificativa das autorizações prévias para ela são SUBSTITUÍDOS por um texto fixo;
--  3. o NOME COMPLETO dela em texto livre sem FK (destinatário de encomenda, descrição e envolvidos de ocorrência,
--     motivo/justificativa/nota de outros registros, mensagens da importação e snapshots do audit_log) é trocado por
--     "[anonimizado]". Só quando o nome é procurável (lgpd_padrao_nome) e não há OUTRA pessoa ou operador cujo nome
--     contenha o mesmo nome (homônimo): trocar ali apagaria a menção a um terceiro. O resultado diz qual caso valeu;
--  4. evento_acesso NÃO é tocado: o texto livre do evento entra no hash (spec 9.1). Só se conta quantos eventos dela
--     citam o nome, para a resposta ao titular dizer o que fica até o descarte.
-- Devolve as contagens (sem dado pessoal), as mesmas gravadas em retencao_execucao.
CREATE FUNCTION lgpd_anonimizar_titular(p_pessoa_id uuid, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c_removido constant text := 'Removido na anonimização (LGPD)';
  v_foto uuid;
  v_anonimizada timestamptz;
  v_nome text;
  v_padrao text;
  v_texto text := 'substituido';
  v_redigidos integer;
  v_vinculos integer := 0;
  v_restricoes integer := 0;
  v_autorizacoes integer := 0;
  v_encomendas integer := 0;
  v_ocorrencias integer := 0;
  v_importacao integer := 0;
  v_trilha integer := 0;
  v_eventos integer := 0;
  v_n integer;
  v_r jsonb;
BEGIN
  IF p_motivo IS NULL OR p_motivo NOT IN ('pedido', 'retencao') THEN
    RAISE EXCEPTION 'motivo de anonimização inválido' USING ERRCODE = 'check_violation';
  END IF;
  SELECT foto_documento_id, anonimizada_em, nome INTO v_foto, v_anonimizada, v_nome FROM pessoa WHERE id = p_pessoa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pessoa % não existe', p_pessoa_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_anonimizada IS NOT NULL THEN
    RAISE EXCEPTION 'pessoa % já está anonimizada', p_pessoa_id USING ERRCODE = 'check_violation';
  END IF;

  v_padrao := lgpd_padrao_nome(v_nome);
  IF v_padrao IS NULL THEN
    v_texto := 'nome_curto';
  ELSIF EXISTS (SELECT 1 FROM pessoa WHERE id <> p_pessoa_id AND anonimizada_em IS NULL AND nome ~* v_padrao)
     OR EXISTS (SELECT 1 FROM usuario_sistema WHERE anonimizado_em IS NULL AND nome ~* v_padrao) THEN
    v_texto := 'homonimo';
    v_padrao := NULL;
  END IF;

  -- 1. Cadastro e trilha da pessoa
  UPDATE pessoa
     SET nome = 'Pessoa anonimizada', documento_mascarado = NULL, documento_busca = NULL, telefone = NULL,
         empresa = NULL, servico = NULL, foto_documento_id = NULL,
         anonimizada_em = clock_timestamp(), atualizado_em = clock_timestamp()
   WHERE id = p_pessoa_id;
  IF v_foto IS NOT NULL THEN
    UPDATE documento SET eliminado_em = clock_timestamp() WHERE id = v_foto AND eliminado_em IS NULL;
  END IF;
  v_redigidos := lgpd_redigir_audit_pessoa(p_pessoa_id);

  -- 3a. Snapshots do audit_log que citam o nome (qualquer entidade). A troca não cria aspas nem barra: o jsonb continua válido.
  IF v_padrao IS NOT NULL THEN
    PERFORM set_config('portaria.operacao', 'redacao_audit', true);
    UPDATE audit_log
       SET antes = lgpd_trocar_nome(antes::text, v_padrao)::jsonb, depois = lgpd_trocar_nome(depois::text, v_padrao)::jsonb,
           redigido_em = coalesce(redigido_em, clock_timestamp())
     WHERE antes::text ~* v_padrao OR depois::text ~* v_padrao;
    GET DIAGNOSTICS v_trilha = ROW_COUNT;
  END IF;

  PERFORM set_config('portaria.operacao', 'lgpd_anonimizar', true);
  -- 2. Texto livre ligado à pessoa pelo id
  UPDATE vinculo_unidade
     SET nota = NULL, conferencia_observacao = NULL,
         conferencia_descricao = CASE WHEN conferencia_descricao IS NULL THEN NULL ELSE 'Removido (LGPD)' END,
         justificativa = CASE WHEN justificativa IS NULL THEN NULL ELSE c_removido END
   WHERE pessoa_id = p_pessoa_id AND num_nonnulls(nota, conferencia_observacao, conferencia_descricao, justificativa) > 0;
  GET DIAGNOSTICS v_vinculos = ROW_COUNT;
  UPDATE restricao SET motivo = c_removido WHERE pessoa_id = p_pessoa_id AND motivo <> c_removido;
  GET DIAGNOSTICS v_restricoes = ROW_COUNT;
  UPDATE autorizacao_previa SET justificativa = c_removido WHERE pessoa_id = p_pessoa_id AND justificativa IS NOT NULL;
  GET DIAGNOSTICS v_autorizacoes = ROW_COUNT;

  -- 3b. O nome completo em texto livre sem FK
  IF v_padrao IS NOT NULL THEN
    UPDATE encomenda SET destinatario = lgpd_trocar_nome(destinatario, v_padrao) WHERE destinatario ~* v_padrao;
    GET DIAGNOSTICS v_encomendas = ROW_COUNT;
    UPDATE ocorrencia SET descricao = lgpd_trocar_nome(descricao, v_padrao), envolvidos = lgpd_trocar_nome(envolvidos, v_padrao)
     WHERE descricao ~* v_padrao OR envolvidos ~* v_padrao;
    GET DIAGNOSTICS v_ocorrencias = ROW_COUNT;
    UPDATE restricao SET motivo = lgpd_trocar_nome(motivo, v_padrao) WHERE motivo ~* v_padrao;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_restricoes := v_restricoes + v_n;
    UPDATE autorizacao_previa SET justificativa = lgpd_trocar_nome(justificativa, v_padrao) WHERE justificativa ~* v_padrao;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_autorizacoes := v_autorizacoes + v_n;
    UPDATE vinculo_unidade
       SET nota = lgpd_trocar_nome(nota, v_padrao), justificativa = lgpd_trocar_nome(justificativa, v_padrao),
           conferencia_observacao = left(lgpd_trocar_nome(conferencia_observacao, v_padrao), 200),
           conferencia_descricao = left(lgpd_trocar_nome(conferencia_descricao, v_padrao), 80)
     WHERE nota ~* v_padrao OR justificativa ~* v_padrao OR conferencia_observacao ~* v_padrao OR conferencia_descricao ~* v_padrao;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_vinculos := v_vinculos + v_n;
    UPDATE importacao_inconsistencia SET mensagem = lgpd_trocar_nome(mensagem, v_padrao) WHERE mensagem ~* v_padrao;
    GET DIAGNOSTICS v_importacao = ROW_COUNT;
  END IF;
  PERFORM set_config('portaria.operacao', '', true);

  -- 4. Eventos da pessoa cujo texto livre (no hash) cita o nome: só contados
  IF lgpd_padrao_nome(v_nome) IS NOT NULL THEN
    SELECT count(*) INTO v_eventos FROM evento_acesso
     WHERE (pessoa_id = p_pessoa_id OR autorizado_por_pessoa_id = p_pessoa_id)
       AND concat_ws(' ', justificativa, observacao, formulario_contingencia, empresa, servico) ~* lgpd_padrao_nome(v_nome);
  END IF;

  v_r := jsonb_build_object(
    'registrosRedigidos', v_redigidos, 'textoLivre', v_texto, 'vinculos', v_vinculos, 'restricoes', v_restricoes,
    'autorizacoes', v_autorizacoes, 'encomendas', v_encomendas, 'ocorrencias', v_ocorrencias, 'importacao', v_importacao,
    'trilhaTexto', v_trilha, 'eventosComTexto', v_eventos);
  INSERT INTO retencao_execucao (tipo, quantidade, detalhes)
  VALUES ('pessoas', 1, jsonb_build_object('pessoa_id', p_pessoa_id, 'motivo', p_motivo, 'foto_documento_id', v_foto) || v_r);
  RETURN v_r;
END $$;
--> statement-breakpoint

-- A função da 0004 passa a delegar (quem ainda a chamar, como a API anterior durante o deploy, ganha a limpeza completa).
CREATE OR REPLACE FUNCTION lgpd_anonimizar_pessoa(p_pessoa_id uuid, p_motivo text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (lgpd_anonimizar_titular(p_pessoa_id, p_motivo) ->> 'registrosRedigidos')::integer
$$;
--> statement-breakpoint

-- Veículo (seção 7: "enquanto houver vínculo + 3 anos"): o veículo é da unidade; o fato gerador é a desativação
-- (o morador saiu, a administração desativa o veículo). 3 anos depois, pelo relógio do banco, a linha é apagada
-- (nada referencia veiculo). Os snapshots da trilha saem com a retenção da própria trilha (3 anos do registro).
CREATE FUNCTION retencao_eliminar_veiculos() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ids uuid[];
  v_n integer;
BEGIN
  WITH x AS (DELETE FROM veiculo WHERE NOT ativo AND desativado_em < now() - interval '3 years' RETURNING id)
  SELECT array_agg(id), count(*) INTO v_ids, v_n FROM x;
  IF v_n > 0 THEN
    INSERT INTO retencao_execucao (tipo, quantidade, detalhes) VALUES ('veiculos', v_n, jsonb_build_object('veiculo_ids', to_jsonb(v_ids)));
  END IF;
  RETURN v_n;
END $$;
--> statement-breakpoint

-- Operador (seção 7: "enquanto ativo + 3 anos"): nome e login genéricos; a linha fica (eventos e trilha apontam para o
-- id). A senha (hash argon2id) fica: não identifica ninguém e o usuário inativo não autentica. Na trilha, o nome do
-- operador some das linhas que sobrarem (as dele são anteriores ao desligamento e já venceram) e dos snapshots dele.
CREATE FUNCTION retencao_anonimizar_operadores() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ids uuid[];
  v_n integer;
BEGIN
  WITH x AS (
    UPDATE usuario_sistema SET nome = 'Operador anonimizado', login = 'anonimizado-' || id::text,
           anonimizado_em = clock_timestamp(), atualizado_em = clock_timestamp()
     WHERE NOT ativo AND anonimizado_em IS NULL AND desativado_em < now() - interval '3 years'
    RETURNING id)
  SELECT array_agg(id), count(*) INTO v_ids, v_n FROM x;
  IF v_n = 0 THEN
    RETURN 0;
  END IF;
  PERFORM set_config('portaria.operacao', 'redacao_audit', true);
  UPDATE audit_log SET usuario_nome = 'Operador anonimizado', redigido_em = coalesce(redigido_em, clock_timestamp())
   WHERE usuario_id = ANY (v_ids);
  UPDATE audit_log SET antes = antes - ARRAY['nome', 'login'], depois = depois - ARRAY['nome', 'login'],
         redigido_em = coalesce(redigido_em, clock_timestamp())
   WHERE entidade = 'usuario_sistema' AND registro_id = ANY (v_ids);
  PERFORM set_config('portaria.operacao', '', true);
  INSERT INTO retencao_execucao (tipo, quantidade, detalhes) VALUES ('operadores', v_n, jsonb_build_object('usuario_ids', to_jsonb(v_ids)));
  RETURN v_n;
END $$;
--> statement-breakpoint

-- Sessão: IP e navegador (user_agent) 90 dias depois do último uso, o mesmo prazo dos logs de aplicação (spec 9.4).
-- A sessão já morreu muito antes (inatividade de 30 min, absoluta de 12 h); a linha fica (token só como hash).
CREATE FUNCTION retencao_limpar_sessoes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE sessao SET ip = NULL, user_agent = NULL
   WHERE ultimo_uso_em < now() - interval '90 days' AND (ip IS NOT NULL OR user_agent IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO retencao_execucao (tipo, quantidade) VALUES ('sessoes', v_n);
  END IF;
  RETURN v_n;
END $$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION lgpd_anonimizar_titular(uuid, text), retencao_eliminar_veiculos(), retencao_anonimizar_operadores(),
  retencao_limpar_sessoes() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lgpd_anonimizar_titular(uuid, text), retencao_eliminar_veiculos(), retencao_anonimizar_operadores(),
  retencao_limpar_sessoes(), lgpd_padrao_nome(text), lgpd_nome_normalizado(text) TO app_rw;
