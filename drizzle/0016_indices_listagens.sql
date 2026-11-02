-- Índices das listagens (revisão por skills, 2026-11-02): só expande, nenhuma coluna muda.
--  encomenda e ocorrencia: a listagem por cursor ordena por (recebida_em | aberta_em, id) DESC; sem índice a leitura ordenava a tabela inteira.
--    Índice em ordem ASC de propósito: a varredura reversa entrega DESC NULLS FIRST (o ORDER BY ... DESC); um índice DESC NULLS LAST não era usado (EXPLAIN mostrava Sort).
--  restricao: a lista de unidades conta as restrições vigentes por unidade (subconsulta por linha da página).
--  veiculo: a unidade lista os próprios veículos.
-- CREATE INDEX comum (não CONCURRENTLY: o migrador roda em transação): lock de escrita só enquanto indexa, e as tabelas
-- são pequenas. Rollback de imagem (API anterior com esta migração aplicada): funciona, índice a mais não muda consulta.
-- Desfazer: DROP INDEX de cada um.
CREATE INDEX "encomenda_recebida_ix" ON "encomenda" USING btree ("recebida_em","id");--> statement-breakpoint
CREATE INDEX "ocorrencia_aberta_ix" ON "ocorrencia" USING btree ("aberta_em","id");--> statement-breakpoint
CREATE INDEX "restricao_unidade_vigente_ix" ON "restricao" USING btree ("unidade_id") WHERE revogada_em IS NULL;--> statement-breakpoint
CREATE INDEX "veiculo_unidade_ix" ON "veiculo" USING btree ("unidade_id");
