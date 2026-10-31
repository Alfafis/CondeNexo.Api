-- Migração manual (drizzle-kit generate --custom): o que o Drizzle não expressa.
--   1. Pré-requisito: roles criados pelo bootstrap (db/bootstrap/00_roles.sh), fora das migrações.
--   2. Cabeça da cadeia e serialização canônica do hash (spec §4.3).
--   3. Trigger BEFORE INSERT do evento: validações entre linhas, seq, registrado_em e hash.
--   4. Append-only (camada 2, spec §4.2) de evento_acesso, audit_log, selo_cadeia e históricos.
--   5. Máquinas de estado: vínculo, ocorrência, revogação, retirada de encomenda.
--   6. Procedimentos controlados de LGPD: descarte de eventos por retenção e redação do audit_log.
--   7. GRANT/REVOKE para app_rw (camada 1, spec §4.1).
-- Cada comando é separado pelo marcador de breakpoint do Drizzle (o migrator executa um comando por vez).
-- ATENÇÃO: nunca escreva o marcador dentro de comentário ou de corpo de função; o splitter corta ali.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    RAISE EXCEPTION 'role app_rw não existe: rode db/bootstrap/00_roles.sh como superusuário antes das migrações (db/README.md)';
  END IF;
END $$;
--> statement-breakpoint

-- ===== 2. Cabeça da cadeia e serialização canônica =================================================

-- Gênese: seq 0, hash = SHA-256 hex da string "genesis" (o mesmo valor de packages/domain/hashChain.ts).
INSERT INTO evento_acesso_cadeia (id, ultimo_seq, ultimo_hash)
VALUES (1, 0, encode(sha256(convert_to('genesis', 'UTF8')), 'hex'));
--> statement-breakpoint

-- Texto como literal JSON (aspas e escapes idênticos ao JSON.stringify); NULL vira null.
CREATE FUNCTION canon_texto(v text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(to_json(v)::text, 'null') $$;
--> statement-breakpoint

-- Instante em UTC com milissegundos, igual a Date.prototype.toISOString(): "2026-10-17T12:34:56.789Z".
CREATE FUNCTION canon_instante(t timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t IS NULL THEN 'null'
         ELSE '"' || to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '"' END
$$;
--> statement-breakpoint

-- correcao_valores: objeto só com as chaves presentes, nesta ordem fixa. Chave nova entra no FIM da lista,
-- sem mudar o hash de correções antigas.
CREATE FUNCTION canon_correcao(v jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN v IS NULL THEN 'null' ELSE coalesce((
    SELECT '{' || string_agg(to_json(c.k)::text || ':' || canon_texto(v ->> c.k), ',' ORDER BY c.ord) || '}'
      FROM unnest(ARRAY['unidade_destino_id', 'ocorrido_em', 'pessoa_id', 'autorizado_por_pessoa_id'])
           WITH ORDINALITY AS c(k, ord)
     WHERE v ? c.k), '{}') END
$$;
--> statement-breakpoint

-- Serialização canônica v1 do evento: JSON compacto, chaves nesta ordem, null explícito.
-- hash = sha256_hex( hash_anterior || evento_acesso_canonico(e) ), em UTF-8.
-- O verificador independente (apps/api/src/db/cadeia.ts) reproduz isto fora do banco.
CREATE FUNCTION evento_acesso_canonico(e evento_acesso) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT '{"v":' || e.formato_hash
    || ',"seq":' || e.seq
    || ',"id":' || canon_texto(e.id::text)
    || ',"tipo":' || canon_texto(e.tipo::text)
    || ',"categoria_pessoa":' || canon_texto(e.categoria_pessoa::text)
    || ',"pessoa_id":' || canon_texto(e.pessoa_id::text)
    || ',"unidade_destino_id":' || canon_texto(e.unidade_destino_id::text)
    || ',"area_comum_id":' || canon_texto(e.area_comum_id::text)
    || ',"ponto_acesso_id":' || canon_texto(e.ponto_acesso_id::text)
    || ',"autorizado_por_tipo":' || canon_texto(e.autorizado_por_tipo::text)
    || ',"autorizado_por_pessoa_id":' || canon_texto(e.autorizado_por_pessoa_id::text)
    || ',"autorizacao_previa_id":' || canon_texto(e.autorizacao_previa_id::text)
    || ',"justificativa":' || canon_texto(e.justificativa)
    || ',"restricao_id":' || canon_texto(e.restricao_id::text)
    || ',"operador_id":' || canon_texto(e.operador_id::text)
    || ',"operador_papel":' || canon_texto(e.operador_papel::text)
    || ',"ocorrido_em":' || canon_instante(e.ocorrido_em)
    || ',"registrado_em":' || canon_instante(e.registrado_em)
    || ',"retroativo":' || CASE WHEN e.retroativo THEN 'true' ELSE 'false' END
    || ',"formulario_contingencia":' || canon_texto(e.formulario_contingencia)
    || ',"refere_evento_id":' || canon_texto(e.refere_evento_id::text)
    || ',"corrige_evento_id":' || canon_texto(e.corrige_evento_id::text)
    || ',"correcao_valores":' || canon_correcao(e.correcao_valores)
    || ',"empresa":' || canon_texto(e.empresa)
    || ',"servico":' || canon_texto(e.servico)
    || ',"observacao":' || canon_texto(e.observacao)
    || '}'
$$;
--> statement-breakpoint

-- ===== 3. Inserção do evento ==========================================================================
-- SECURITY DEFINER: app_rw não tem UPDATE na cabeça da cadeia; só este trigger a avança.
-- Serialização: SELECT ... FOR UPDATE na linha única da cabeça. Duas inserções concorrentes esperam uma pela
-- outra até o COMMIT; em READ COMMITTED a segunda relê a cabeça já atualizada. Em REPEATABLE READ/SERIALIZABLE
-- a segunda falha com 40001 e a API repete. Rollback desfaz também o avanço da cabeça: não há lacuna de seq.
CREATE FUNCTION evento_acesso_antes_inserir() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ref_tipo tipo_evento;
  v_cadeia evento_acesso_cadeia%ROWTYPE;
  v_agora timestamptz;
  v_chave text;
  v_valor text;
  v_norm jsonb := '{}'::jsonb;
BEGIN
  -- Referências entre eventos (sem FK; ver schema.ts)
  IF NEW.tipo = 'saida' THEN
    SELECT tipo INTO v_ref_tipo FROM evento_acesso WHERE id = NEW.refere_evento_id;
    IF v_ref_tipo IS DISTINCT FROM 'entrada' THEN
      RAISE EXCEPTION 'saída precisa referenciar uma entrada existente (refere_evento_id %)', NEW.refere_evento_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.tipo = 'correcao' THEN
    SELECT tipo INTO v_ref_tipo FROM evento_acesso WHERE id = NEW.corrige_evento_id;
    IF v_ref_tipo IS NULL THEN
      RAISE EXCEPTION 'evento corrigido % não existe', NEW.corrige_evento_id USING ERRCODE = 'check_violation';
    END IF;
    IF v_ref_tipo = 'correcao' THEN
      RAISE EXCEPTION 'não se corrige uma correção: corrija o evento original (RN-04)' USING ERRCODE = 'check_violation';
    END IF;
    -- Normaliza correcao_valores (o CHECK já garante objeto não vazio só em correção)
    IF NEW.correcao_valores IS NOT NULL AND jsonb_typeof(NEW.correcao_valores) = 'object' THEN
      FOR v_chave IN SELECT jsonb_object_keys(NEW.correcao_valores) LOOP
        IF v_chave NOT IN ('unidade_destino_id', 'ocorrido_em', 'pessoa_id', 'autorizado_por_pessoa_id') THEN
          RAISE EXCEPTION 'campo % não é corrigível', v_chave USING ERRCODE = 'check_violation';
        END IF;
        IF jsonb_typeof(NEW.correcao_valores -> v_chave) NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'correcao_valores.% deve ser texto ou null', v_chave USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
      IF NEW.correcao_valores ? 'ocorrido_em' THEN
        v_valor := NEW.correcao_valores ->> 'ocorrido_em';
        IF v_valor IS NULL OR v_valor !~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
          RAISE EXCEPTION 'correcao_valores.ocorrido_em exige instante ISO 8601 com fuso' USING ERRCODE = 'check_violation';
        END IF;
        IF v_valor::timestamptz >= clock_timestamp() THEN
          RAISE EXCEPTION 'a data corrigida deve ser anterior ao momento atual' USING ERRCODE = 'check_violation';
        END IF;
        v_norm := v_norm || jsonb_build_object('ocorrido_em',
          to_char(date_trunc('milliseconds', v_valor::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      END IF;
      IF NEW.correcao_valores ? 'unidade_destino_id' THEN
        v_valor := NEW.correcao_valores ->> 'unidade_destino_id';
        IF v_valor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unidade WHERE id = v_valor::uuid) THEN
          RAISE EXCEPTION 'unidade corrigida % não existe', v_valor USING ERRCODE = 'foreign_key_violation';
        END IF;
        v_norm := v_norm || jsonb_build_object('unidade_destino_id', v_valor::uuid::text);
      END IF;
      IF NEW.correcao_valores ? 'pessoa_id' THEN
        v_valor := NEW.correcao_valores ->> 'pessoa_id';
        IF v_valor IS NULL OR NOT EXISTS (SELECT 1 FROM pessoa WHERE id = v_valor::uuid) THEN
          RAISE EXCEPTION 'pessoa corrigida % não existe', v_valor USING ERRCODE = 'foreign_key_violation';
        END IF;
        v_norm := v_norm || jsonb_build_object('pessoa_id', v_valor::uuid::text);
      END IF;
      IF NEW.correcao_valores ? 'autorizado_por_pessoa_id' THEN
        v_valor := NEW.correcao_valores ->> 'autorizado_por_pessoa_id';
        IF v_valor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pessoa WHERE id = v_valor::uuid) THEN
          RAISE EXCEPTION 'autorizador corrigido % não existe', v_valor USING ERRCODE = 'foreign_key_violation';
        END IF;
        v_norm := v_norm || jsonb_build_object('autorizado_por_pessoa_id', v_valor::uuid::text);
      END IF;
      NEW.correcao_valores := v_norm;
    END IF;
  END IF;

  -- Pessoa sem CPF só entra por exceção do porteiro (decisão de MVP)
  IF NEW.tipo = 'entrada' AND NEW.autorizado_por_tipo IS DISTINCT FROM 'excecao_porteiro'
     AND EXISTS (SELECT 1 FROM pessoa WHERE id = NEW.pessoa_id AND sem_cpf) THEN
    RAISE EXCEPTION 'pessoa cadastrada sem CPF só entra por exceção do porteiro, com justificativa'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Cadeia: trava a cabeça, numera, carimba o tempo do servidor e calcula o hash
  SELECT * INTO v_cadeia FROM evento_acesso_cadeia WHERE id = 1 FOR UPDATE;
  v_agora := date_trunc('milliseconds', clock_timestamp());
  IF v_cadeia.ultimo_registrado_em IS NOT NULL AND v_agora < v_cadeia.ultimo_registrado_em THEN
    v_agora := v_cadeia.ultimo_registrado_em; -- registrado_em nunca anda para trás em relação a seq
  END IF;
  NEW.seq := v_cadeia.ultimo_seq + 1;
  NEW.formato_hash := 1;
  NEW.registrado_em := v_agora;
  IF NEW.retroativo THEN
    NEW.ocorrido_em := date_trunc('milliseconds', NEW.ocorrido_em);
  ELSE
    NEW.ocorrido_em := v_agora; -- fora da contingência, o relógio é sempre o do servidor
  END IF;
  NEW.hash_anterior := v_cadeia.ultimo_hash;
  NEW.hash := encode(sha256(convert_to(NEW.hash_anterior || evento_acesso_canonico(NEW), 'UTF8')), 'hex');

  UPDATE evento_acesso_cadeia
     SET ultimo_seq = NEW.seq, ultimo_hash = NEW.hash, ultimo_registrado_em = v_agora, atualizado_em = clock_timestamp()
   WHERE id = 1;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER evento_acesso_antes_inserir BEFORE INSERT ON evento_acesso
FOR EACH ROW EXECUTE FUNCTION evento_acesso_antes_inserir();
--> statement-breakpoint

-- ===== 4. Append-only (camada 2) ========================================================================
-- Bloqueia UPDATE/DELETE/TRUNCATE mesmo que alguém conceda permissão por engano. Exceções controladas, só
-- dentro das funções SECURITY DEFINER da seção 6 (current_user = dono da tabela E marcador da transação):
--   DELETE em evento_acesso pelo descarte de retenção; UPDATE em audit_log pela redação LGPD.
CREATE FUNCTION trilha_bloqueia_alteracao() RETURNS trigger
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
  END IF;
  RAISE EXCEPTION 'tabela % é append-only (RN-04): % bloqueado', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER evento_acesso_imutavel BEFORE UPDATE OR DELETE ON evento_acesso
FOR EACH ROW EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER evento_acesso_sem_truncate BEFORE TRUNCATE ON evento_acesso
FOR EACH STATEMENT EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER audit_log_imutavel BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER audit_log_sem_truncate BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER ocorrencia_historico_imutavel BEFORE UPDATE OR DELETE ON ocorrencia_status_historico
FOR EACH ROW EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER ocorrencia_historico_sem_truncate BEFORE TRUNCATE ON ocorrencia_status_historico
FOR EACH STATEMENT EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER retencao_execucao_imutavel BEFORE UPDATE OR DELETE ON retencao_execucao
FOR EACH ROW EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER retencao_execucao_sem_truncate BEFORE TRUNCATE ON retencao_execucao
FOR EACH STATEMENT EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER evento_acesso_cadeia_sem_delete BEFORE DELETE ON evento_acesso_cadeia
FOR EACH ROW EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER evento_acesso_cadeia_sem_truncate BEFORE TRUNCATE ON evento_acesso_cadeia
FOR EACH STATEMENT EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER selo_cadeia_sem_delete BEFORE DELETE ON selo_cadeia
FOR EACH ROW EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER selo_cadeia_sem_truncate BEFORE TRUNCATE ON selo_cadeia
FOR EACH STATEMENT EXECUTE FUNCTION trilha_bloqueia_alteracao();
--> statement-breakpoint

-- Selo (spec §4.6): o hash selado tem de existir na cadeia; depois, só o registro do envio, uma única vez.
CREATE FUNCTION selo_cadeia_validar() RETURNS trigger
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
     OR (NEW.id, NEW.data, NEW.ultimo_seq, NEW.ultimo_hash, NEW.criado_em)
        IS DISTINCT FROM (OLD.id, OLD.data, OLD.ultimo_seq, OLD.ultimo_hash, OLD.criado_em) THEN
    RAISE EXCEPTION 'selo é imutável: só o envio da âncora pode ser registrado, uma vez'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER selo_cadeia_validar BEFORE INSERT OR UPDATE ON selo_cadeia
FOR EACH ROW EXECUTE FUNCTION selo_cadeia_validar();
--> statement-breakpoint

-- ===== 5. Máquinas de estado =============================================================================

-- Vínculo: nasce pendente (cadastro) ou legado (importação). Transições permitidas:
-- pendente -> aprovado | rejeitado; aprovado -> encerrado; legado -> aprovado (regularização) | encerrado.
-- rejeitado e encerrado são finais (registro congelado).
CREATE FUNCTION vinculo_unidade_transicao() RETURNS trigger
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
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER vinculo_unidade_transicao BEFORE INSERT OR UPDATE ON vinculo_unidade
FOR EACH ROW EXECUTE FUNCTION vinculo_unidade_transicao();
--> statement-breakpoint

-- Ocorrência: nasce aberta; aberta -> em_andamento -> encerrada; encerrada é final.
CREATE FUNCTION ocorrencia_transicao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'aberta' THEN
      RAISE EXCEPTION 'ocorrência nasce aberta' USING ERRCODE = 'check_violation';
    END IF;
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
CREATE TRIGGER ocorrencia_transicao BEFORE INSERT OR UPDATE ON ocorrencia
FOR EACH ROW EXECUTE FUNCTION ocorrencia_transicao();
--> statement-breakpoint

-- Autorização prévia e restrição revogadas ficam congeladas (revogar duas vezes é proibido).
CREATE FUNCTION revogacao_congela() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revogada_em IS NOT NULL THEN
    RAISE EXCEPTION '% % já foi revogada: registro congelado', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER autorizacao_previa_congela BEFORE UPDATE ON autorizacao_previa
FOR EACH ROW EXECUTE FUNCTION revogacao_congela();
--> statement-breakpoint
CREATE TRIGGER restricao_congela BEFORE UPDATE ON restricao
FOR EACH ROW EXECUTE FUNCTION revogacao_congela();
--> statement-breakpoint

-- Restrição: a aprovação do síndico (RN-06) é dada uma vez e não muda.
CREATE FUNCTION restricao_aprovacao_unica() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.aprovada_em IS NOT NULL
     AND (NEW.aprovada_em, NEW.aprovada_por_id, NEW.escopo) IS DISTINCT FROM (OLD.aprovada_em, OLD.aprovada_por_id, OLD.escopo) THEN
    RAISE EXCEPTION 'restrição % já aprovada: aprovação e escopo não mudam', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER restricao_aprovacao_unica BEFORE UPDATE ON restricao
FOR EACH ROW EXECUTE FUNCTION restricao_aprovacao_unica();
--> statement-breakpoint

-- Encomenda retirada fica congelada (a retirada é registrada uma vez).
CREATE FUNCTION encomenda_retirada_congela() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retirada_em IS NOT NULL THEN
    RAISE EXCEPTION 'encomenda % já foi retirada', OLD.numero USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER encomenda_retirada_congela BEFORE UPDATE ON encomenda
FOR EACH ROW EXECUTE FUNCTION encomenda_retirada_congela();
--> statement-breakpoint

-- ===== 6. Procedimentos controlados de LGPD ================================================================

-- Descarte do prefixo da cadeia (seq <= p_ate_seq). Exige um selo exatamente nesse seq: depois do descarte,
-- o primeiro evento restante tem hash_anterior = selo.ultimo_hash, e a verificação recomeça dali.
-- Interno: não confere o prazo. Sem EXECUTE para app_rw.
CREATE FUNCTION retencao_descartar_prefixo(p_ate_seq bigint) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_hash text;
  v_n integer;
BEGIN
  PERFORM 1 FROM evento_acesso_cadeia WHERE id = 1 FOR UPDATE; -- serializa com as inserções
  SELECT hash INTO v_hash FROM evento_acesso WHERE seq = p_ate_seq;
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'evento seq % não existe', p_ate_seq USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM selo_cadeia WHERE ultimo_seq = p_ate_seq AND ultimo_hash = v_hash) THEN
    RAISE EXCEPTION 'não há selo no seq %: sele a cadeia antes de descartar', p_ate_seq USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('portaria.operacao', 'retencao_eventos', true);
  DELETE FROM evento_acesso WHERE seq <= p_ate_seq;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('portaria.operacao', '', true);
  INSERT INTO retencao_execucao (tipo, ate_seq, quantidade) VALUES ('eventos', p_ate_seq, v_n);
  RETURN v_n;
END $$;
--> statement-breakpoint

-- Público (job de retenção via API): só descarta eventos registrados há mais de 3 anos (seção 7 dos
-- requisitos). Como registrado_em é monotônico em seq, o prefixo é exatamente o conjunto vencido.
CREATE FUNCTION retencao_descartar_eventos(p_ate_seq bigint) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ultimo timestamptz;
BEGIN
  SELECT max(registrado_em) INTO v_ultimo FROM evento_acesso WHERE seq <= p_ate_seq;
  IF v_ultimo IS NULL THEN
    RETURN 0;
  END IF;
  IF v_ultimo >= now() - interval '3 years' THEN
    RAISE EXCEPTION 'há eventos até o seq % ainda dentro do prazo de retenção de 3 anos', p_ate_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN retencao_descartar_prefixo(p_ate_seq);
END $$;
--> statement-breakpoint

-- Redação do audit_log de uma pessoa já anonimizada: remove nome, telefone, documento e empresa dos
-- snapshots. O audit_log NÃO é encadeado por hash justamente para permitir isto (ver spec §3.3).
CREATE FUNCTION lgpd_redigir_audit_pessoa(p_pessoa_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_campos text[] := ARRAY['nome', 'telefone', 'documento_mascarado', 'empresa', 'servico'];
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
--> statement-breakpoint

-- ===== 7. Permissões (camada 1) =============================================================================
-- Sem ALTER DEFAULT PRIVILEGES de propósito: tabela nova sem GRANT explícito falha fechada (a API não a acessa).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_rw;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_rw;
--> statement-breakpoint
-- Cadastros: inserir e alterar; nunca apagar (remoção lógica).
GRANT INSERT, UPDATE ON unidade, area_comum, ponto_acesso, usuario_sistema, documento, importacao, pessoa,
  funcionario, vinculo_unidade, veiculo, autorizacao_previa, restricao, encomenda, ocorrencia TO app_rw;
--> statement-breakpoint
-- Registros que só crescem.
GRANT INSERT ON evento_acesso, audit_log, selo_cadeia, importacao_inconsistencia, autorizacao_retirada,
  ocorrencia_status_historico, ocorrencia_evento, ocorrencia_anexo TO app_rw;
--> statement-breakpoint
GRANT UPDATE (enviado_para, enviado_em) ON selo_cadeia TO app_rw;
--> statement-breakpoint
-- Trilhas: explícito, para documentar e anular qualquer GRANT amplo anterior.
REVOKE UPDATE, DELETE, TRUNCATE ON evento_acesso, audit_log, ocorrencia_status_historico, retencao_execucao,
  evento_acesso_cadeia FROM app_rw;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON selo_cadeia FROM app_rw;
--> statement-breakpoint
REVOKE INSERT ON evento_acesso_cadeia, retencao_execucao FROM app_rw;
--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_rw;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION evento_acesso_antes_inserir(), retencao_descartar_prefixo(bigint),
  retencao_descartar_eventos(bigint), lgpd_redigir_audit_pessoa(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retencao_descartar_eventos(bigint), lgpd_redigir_audit_pessoa(uuid) TO app_rw;
