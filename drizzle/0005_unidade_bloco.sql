-- RF-01: a unidade deixa de ser torre numérica (1..9) e passa a ser BLOCO texto ("A", "4", "B2"), com o número
-- canônico de 2 dígitos no mínimo ("03", "32"), para "3" e "03" não virarem duas unidades. O nome exibido
-- ("Bloco"/"Torre") é configuração da API (@portaria/domain/units), não dado.
-- Parte escrita à mão no lugar do `drizzle-kit generate` (que pergunta, interativo, se `bloco` é coluna nova ou a
-- `torre` renomeada); o snapshot 0005 é o do schema.ts, e `drizzle-kit generate` depois dela não acusa diferença.
-- NÃO destrutiva e genérica: nenhuma linha é apagada e o id (uuid) não muda. A torre vira texto (4 -> '4') e o número é
-- normalizado ('3' -> '03', '032' -> '32'). Vínculos, eventos, encomendas etc. apontam para o id; a cadeia de hash usa
-- unidade_destino_id (uuid), não torre/número: nenhum hash gravado muda. Não há view, trigger nem função que leia torre.
-- Aborta inteira (nada muda) se a normalização juntar duas unidades do mesmo bloco ("32" e "032").
-- Trocar as unidades pela estrutura nova NÃO é feito aqui (seria apagar dado de negócio numa migração): é a CLI
-- recriar-estrutura, que usa a função do fim deste arquivo.
ALTER TABLE "unidade" DROP CONSTRAINT "unidade_torre_numero_uq";--> statement-breakpoint
ALTER TABLE "unidade" DROP CONSTRAINT "unidade_torre_ck";--> statement-breakpoint
ALTER TABLE "unidade" DROP CONSTRAINT "unidade_numero_ck";--> statement-breakpoint
ALTER TABLE "unidade" RENAME COLUMN "torre" TO "bloco";--> statement-breakpoint
ALTER TABLE "unidade" ALTER COLUMN "bloco" SET DATA TYPE text USING "bloco"::text;--> statement-breakpoint
DO $$
DECLARE
  v_colisoes text;
BEGIN
  SELECT string_agg(format('%s: %s', bloco, numeros), '; ') INTO v_colisoes
    FROM (SELECT bloco, string_agg(numero, ', ' ORDER BY numero) AS numeros
            FROM unidade
           GROUP BY bloco, CASE WHEN length(ltrim(numero, '0')) < 2 THEN lpad(ltrim(numero, '0'), 2, '0') ELSE ltrim(numero, '0') END
          HAVING count(*) > 1) c;
  IF v_colisoes IS NOT NULL THEN
    RAISE EXCEPTION 'unidades que viram a mesma depois de normalizar o número (corrija à mão antes de migrar): %', v_colisoes
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "unidade"
   SET "numero" = CASE WHEN length(ltrim(numero, '0')) < 2 THEN lpad(ltrim(numero, '0'), 2, '0') ELSE ltrim(numero, '0') END
 WHERE "numero" !~ '^(0[0-9]|[1-9][0-9]+)$';--> statement-breakpoint
ALTER TABLE "unidade" ADD CONSTRAINT "unidade_bloco_numero_uq" UNIQUE("bloco","numero");--> statement-breakpoint
ALTER TABLE "unidade" ADD CONSTRAINT "unidade_bloco_ck" CHECK (bloco ~ '^[A-Z0-9]{1,3}$');--> statement-breakpoint
ALTER TABLE "unidade" ADD CONSTRAINT "unidade_numero_ck" CHECK (numero ~ '^(0[0-9]|[1-9][0-9]+)$');--> statement-breakpoint

-- ===== Parte manual: descarte da estrutura (CLI recriar-estrutura) =========================================
-- Apaga TODAS as unidades, e só se nenhuma tiver referência. O app_rw não tem DELETE (cadastro é remoção lógica, 0001);
-- este é o único caminho, e só funciona num banco em que nenhuma unidade foi usada. As referências vêm do catálogo
-- (toda FK que aponta para unidade, inclusive as de migrações futuras; todas de uma coluna) mais a correção de evento,
-- que cita a unidade dentro do jsonb, sem FK. A CLI reinsere a estrutura e grava o audit_log na MESMA transação.
CREATE FUNCTION unidade_descartar_estrutura() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
  v_usada boolean;
  v_refs text[] := ARRAY[]::text[];
  v_n integer;
BEGIN
  -- Ninguém lê nem passa a referenciar unidade até o fim da transação da CLI (que já terá reinserido a estrutura).
  LOCK TABLE unidade IN ACCESS EXCLUSIVE MODE;
  FOR r IN
    SELECT c.conrelid::regclass AS tabela, a.attname AS coluna
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.unidade'::regclass
     ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I IS NOT NULL)', r.tabela, r.coluna) INTO v_usada;
    IF v_usada THEN
      v_refs := v_refs || format('%s.%s', r.tabela, r.coluna);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM evento_acesso WHERE correcao_valores ? 'unidade_destino_id') THEN
    v_refs := v_refs || 'evento_acesso.correcao_valores'::text;
  END IF;
  IF cardinality(v_refs) > 0 THEN
    RAISE EXCEPTION 'há unidades referenciadas (%): a estrutura não pode ser recriada', array_to_string(v_refs, ', ')
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  DELETE FROM unidade;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION unidade_descartar_estrutura() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION unidade_descartar_estrutura() TO app_rw;
