-- Veículo na ENTRADA (decisão do usuário de 2026-10-26): placa, modelo e cor de quem entra (visitante, prestador,
-- entregador...), no próprio evento, não no cadastro da pessoa (a mesma pessoa vem de carro, moto ou a pé).
-- Parte gerada pelo drizzle-kit (schema.ts):
--   colunas veiculo_placa, veiculo_modelo, veiculo_cor (text, NULL; ADD COLUMN sem default = só catálogo, sem reescrever);
--   CHECKs: só em entrada; placa ^[A-Z0-9]{7}$ (a API confere antiga/Mercosul, como no veículo do morador); modelo e cor
--   só com placa, 1..60 e 1..30 caracteres; formato 2 <=> placa; evento_cadeia_ck passa a aceitar formato_hash 1 ou 2.
-- Parte manual (no fim):
--   1. evento_acesso_canonico: formato 2 = a serialização v1 + veiculo_placa, veiculo_modelo, veiculo_cor no fim.
--      Para formato 1 a saída é a MESMA de antes, byte a byte: nenhum hash gravado muda.
--   2. evento_acesso_antes_inserir: igual ao da 0001, exceto o formato, agora pelo conteúdo (placa => 2, senão 1).
-- Linhas existentes: todas formato 1 e sem veículo; passam nos CHECKs novos (o ADD CONSTRAINT valida na hora, uma
-- varredura da tabela por CHECK, sob o lock do ALTER). Nada é reescrito, e a cadeia antiga continua verificando.
-- Rollback de imagem (API anterior com esta migração aplicada): registra normalmente (sem veículo = formato 1). Mas o
-- verificador anterior só conhece a v1: depois da primeira entrada com veículo, a verificação de integridade da imagem
-- anterior falha nesse evento. Desfazer a migração depois de usada não é possível (o formato 2 está na cadeia).
ALTER TABLE "evento_acesso" DROP CONSTRAINT "evento_cadeia_ck";--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD COLUMN "veiculo_placa" text;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD COLUMN "veiculo_modelo" text;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD COLUMN "veiculo_cor" text;--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_veiculo_so_entrada_ck" CHECK (tipo = 'entrada' OR num_nonnulls(veiculo_placa, veiculo_modelo, veiculo_cor) = 0);--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_veiculo_placa_ck" CHECK (veiculo_placa IS NULL OR veiculo_placa ~ '^[A-Z0-9]{7}$');--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_veiculo_detalhe_ck" CHECK ((veiculo_placa IS NOT NULL OR (veiculo_modelo IS NULL AND veiculo_cor IS NULL))
    AND (veiculo_modelo IS NULL OR length(btrim(veiculo_modelo)) BETWEEN 1 AND 60)
    AND (veiculo_cor IS NULL OR length(btrim(veiculo_cor)) BETWEEN 1 AND 30));--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_veiculo_formato_ck" CHECK ((formato_hash = 2) = (veiculo_placa IS NOT NULL));--> statement-breakpoint
ALTER TABLE "evento_acesso" ADD CONSTRAINT "evento_cadeia_ck" CHECK (seq > 0 AND formato_hash IN (1, 2) AND hash ~ '^[0-9a-f]{64}$' AND hash_anterior ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION evento_acesso_canonico(e evento_acesso) RETURNS text
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
    || CASE WHEN e.formato_hash = 2 THEN
         ',"veiculo_placa":' || canon_texto(e.veiculo_placa)
         || ',"veiculo_modelo":' || canon_texto(e.veiculo_modelo)
         || ',"veiculo_cor":' || canon_texto(e.veiculo_cor)
       ELSE '' END
    || '}'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION evento_acesso_antes_inserir() RETURNS trigger
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
  -- Formato do hash pelo conteúdo (0013): entrada com placa = 2; o resto continua 1, serializado como antes
  NEW.formato_hash := CASE WHEN NEW.veiculo_placa IS NULL THEN 1 ELSE 2 END;
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
