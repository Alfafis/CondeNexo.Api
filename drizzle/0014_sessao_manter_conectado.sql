-- "Manter conectado neste computador" (decisão do usuário de 2026-10-29): prazos da sessão por tipo de uso.
-- A sessão guarda só SE é longa; os prazos (padrão 4 h / 14 h, longa 1 dia / 15 dias) ficam na config da API, então
-- mudar o número não exige migração. Gravado false para o porteiro mesmo que ele marque (terminal compartilhado).
-- Linhas existentes: recebem false = prazo padrão. ADD COLUMN com default constante é só catálogo no PostgreSQL 11+
-- (sem reescrever a tabela; lock curto do ALTER): segura com tráfego. app_rw já tem INSERT e SELECT na tabela inteira
-- (0003), o que cobre a coluna nova; UPDATE dela não é concedido (o valor nasce no login e não muda).
-- Rollback de imagem (API anterior com esta migração aplicada): funciona (não lê a coluna; insere com o default false),
-- e as sessões longas já abertas passam a valer pelo prazo antigo. Desfazer: ALTER TABLE "sessao" DROP COLUMN "manter_conectado".
ALTER TABLE "sessao" ADD COLUMN "manter_conectado" boolean DEFAULT false NOT NULL;
