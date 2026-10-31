-- Tempo de permanência com prazo por tipo de visita e prorrogação "+1h" (decisão de 2026-10-23, spec §14).
-- Tabela À PARTE, fora da cadeia de hash: evento_acesso, evento_acesso_canonico, o trigger da cadeia e o formato do hash
-- NÃO mudam. A API grava a linha da entrada (ordem 0) na MESMA transação do evento; cada prorrogação é uma linha nova.
-- Parte gerada pelo drizzle-kit (schema.ts):
--   tipo_visita (enum) e permanencia (evento_entrada_id FK com cascade, ordem 0..4, tipo_visita, prazo_ate, motivo,
--   definido_por_id, definido_em); índice único (evento, ordem): limite e concorrência das prorrogações.
-- Parte manual (no fim):
--   1. trigger BEFORE INSERT permanencia_antes_inserir: entrada de visitante/prestador, sequência sem buraco, mesmo tipo,
--      prazo crescente e no máximo 12 h depois da entrada (PERMANENCIA_MAXIMA_MS do domain), prorrogação só sem saída;
--   2. append-only: UPDATE/DELETE/TRUNCATE bloqueados, exceto o DELETE em cascata do descarte da entrada por retenção
--      (retencao_descartar_prefixo), reconhecido por a entrada já não existir;
--   3. GRANT SELECT, INSERT para app_rw (sem UPDATE/DELETE).
-- LGPD: nenhuma coluna pessoal (só ids, enum e instantes): a anonimização do titular não precisa tocar aqui; a retenção
-- de 3 anos vem junto com a do evento (cascade). O operador (definido_por_id) segue a regra de usuario_sistema.
-- Só *expand*: tabela nova, vazia; nenhuma linha existente muda. Entradas de antes desta migração ficam sem prazo (a tela
-- usa o alerta antigo de 8 h). Rollback de imagem (API anterior com esta migração aplicada) é compatível: a imagem
-- anterior não lê nem grava a tabela; entradas registradas por ela ficam sem prazo.
CREATE TYPE "public"."tipo_visita" AS ENUM('visita', 'entrega', 'transporte_app', 'servico');--> statement-breakpoint
CREATE TABLE "permanencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evento_entrada_id" uuid NOT NULL,
	"ordem" smallint NOT NULL,
	"tipo_visita" "tipo_visita" NOT NULL,
	"prazo_ate" timestamp (3) with time zone NOT NULL,
	"motivo" text NOT NULL,
	"definido_por_id" uuid NOT NULL,
	"definido_em" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "permanencia_ordem_ck" CHECK (ordem BETWEEN 0 AND 4),
	CONSTRAINT "permanencia_motivo_ck" CHECK (motivo IN ('entrada', 'prorrogacao') AND (motivo = 'entrada') = (ordem = 0))
);
--> statement-breakpoint
ALTER TABLE "permanencia" ADD CONSTRAINT "permanencia_evento_entrada_id_evento_acesso_id_fk" FOREIGN KEY ("evento_entrada_id") REFERENCES "public"."evento_acesso"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permanencia" ADD CONSTRAINT "permanencia_definido_por_id_usuario_sistema_id_fk" FOREIGN KEY ("definido_por_id") REFERENCES "public"."usuario_sistema"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permanencia_evento_ordem_uq" ON "permanencia" USING btree ("evento_entrada_id","ordem");
--> statement-breakpoint
-- ===== Parte manual =========================================================================================

-- 1. Validações entre linhas e tabelas (o CHECK não alcança). Mensagens lidas só pela API (traduzirErroPermanencia).
-- O 12 h é o PERMANENCIA_MAXIMA_MS do domain; o 4 do CHECK de ordem é o MAX_PRORROGACOES.
-- Conta a partir do ocorrido_em GRAVADO da entrada (uma correção posterior da hora não move o teto).
CREATE FUNCTION permanencia_antes_inserir() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tipo tipo_evento;
  v_categoria categoria_pessoa;
  v_entrada_em timestamptz;
  v_ant_tipo tipo_visita;
  v_ant_prazo timestamptz;
BEGIN
  SELECT tipo, categoria_pessoa, ocorrido_em INTO v_tipo, v_categoria, v_entrada_em
    FROM evento_acesso WHERE id = NEW.evento_entrada_id;
  IF v_tipo IS DISTINCT FROM 'entrada' THEN
    RAISE EXCEPTION 'permanência precisa referenciar uma entrada (evento %)', NEW.evento_entrada_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_categoria NOT IN ('visitante', 'prestador') THEN
    RAISE EXCEPTION 'permanência só se aplica a visitante e prestador' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prazo_ate <= v_entrada_em OR NEW.prazo_ate > v_entrada_em + interval '12 hours' THEN
    RAISE EXCEPTION 'prazo de permanência fora do intervalo: depois da entrada e até 12 h' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ordem > 0 THEN
    SELECT tipo_visita, prazo_ate INTO v_ant_tipo, v_ant_prazo
      FROM permanencia WHERE evento_entrada_id = NEW.evento_entrada_id AND ordem = NEW.ordem - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'prorrogação de permanência fora de sequência' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.tipo_visita <> v_ant_tipo THEN
      RAISE EXCEPTION 'a prorrogação mantém o tipo de visita' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.prazo_ate <= v_ant_prazo THEN
      RAISE EXCEPTION 'a prorrogação precisa estender o prazo de permanência' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM evento_acesso WHERE tipo = 'saida' AND refere_evento_id = NEW.evento_entrada_id) THEN
      RAISE EXCEPTION 'a pessoa já saiu: prorrogação de permanência recusada' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.definido_em := clock_timestamp(); -- relógio do banco, como registrado_em do evento
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER permanencia_antes_inserir BEFORE INSERT ON permanencia
FOR EACH ROW EXECUTE FUNCTION permanencia_antes_inserir();
--> statement-breakpoint

-- 2. Append-only. Única exceção: o DELETE em cascata do descarte por retenção do evento (retencao_descartar_prefixo).
-- Quando a cascata roda, a entrada já foi apagada pelo mesmo comando; fora dela, a entrada existe e o DELETE é recusado.
-- (O app_rw nem tem DELETE: isto é a camada 2, como trilha_bloqueia_alteracao.)
CREATE FUNCTION permanencia_bloqueia_alteracao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM evento_acesso WHERE id = OLD.evento_entrada_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tabela % é append-only: % bloqueado', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER permanencia_imutavel BEFORE UPDATE OR DELETE ON permanencia
FOR EACH ROW EXECUTE FUNCTION permanencia_bloqueia_alteracao();
--> statement-breakpoint
CREATE TRIGGER permanencia_sem_truncate BEFORE TRUNCATE ON permanencia
FOR EACH STATEMENT EXECUTE FUNCTION permanencia_bloqueia_alteracao();
--> statement-breakpoint

-- 3. Permissões (camada 1). Explícito, para documentar e anular qualquer GRANT amplo.
GRANT SELECT, INSERT ON permanencia TO app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON permanencia FROM app_rw;
