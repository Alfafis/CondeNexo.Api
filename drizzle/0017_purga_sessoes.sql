-- Purga de sessões mortas e de contadores de login vencidos (revisão por skills, 2026-11-02).
-- Até aqui `sessao` e `login_limite` só cresciam: app_rw não tem DELETE (0003) e retencao_limpar_sessoes (0007) só zerava
-- ip e user_agent. Cada login criava uma linha para sempre, e logins aleatórios sem autenticação inflavam `login_limite`.
--
-- Mesma função, mesmo nome, assinatura e retorno (integer): a API publicada continua chamando-a sem mudança, dono e GRANT
-- (app_rw) ficam como estão. SECURITY DEFINER roda como o dono (app_migrator), que tem DELETE; app_rw continua SEM DELETE.
-- O cabeçalho (SET search_path) é repetido por inteiro: CREATE OR REPLACE troca a cláusula SET e sem ela perderia o endurecimento.
--
--  sessao:        some a linha cuja expiração ABSOLUTA passou há mais de 90 dias (sessão longa dura no máximo 15 dias), revogada
--                 ou não. Nenhuma tabela referencia sessao (sem FK, sem trigger). Mesmo prazo de 90 dias dos logs (spec 9.4).
--  login_limite:  some o contador parado há mais de 7 dias e sem bloqueio em vigor (a janela é de minutos; 7 dias é margem larga).
--  ip e user_agent das sessões que sobram continuam zerados aos 90 dias do último uso, como antes.
--
-- A contagem entra no mesmo tipo 'sessoes' de retencao_execucao (há CHECK nesse tipo e a plataforma sincroniza o registro).
-- Só expande o comportamento: rollback de imagem funciona. Desfazer: reaplicar o corpo da função de 0007.
CREATE OR REPLACE FUNCTION retencao_limpar_sessoes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n integer := 0;
  v_k integer;
BEGIN
  DELETE FROM sessao WHERE expira_em < now() - interval '90 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;

  DELETE FROM login_limite
   WHERE atualizado_em < now() - interval '7 days' AND (bloqueado_ate IS NULL OR bloqueado_ate < now());
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;

  UPDATE sessao SET ip = NULL, user_agent = NULL
   WHERE ultimo_uso_em < now() - interval '90 days' AND (ip IS NOT NULL OR user_agent IS NOT NULL);
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;

  IF v_n > 0 THEN
    INSERT INTO retencao_execucao (tipo, quantidade) VALUES ('sessoes', v_n);
  END IF;
  RETURN v_n;
END $$;
