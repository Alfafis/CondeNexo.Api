// Vínculo válido em SQL: a mesma regra de `vinculoValido` (../dominio/rules), usada pela UI e pela API.
//   aprovado: dentro da vigência (início e fim inclusivos, em dias BRT; nulo = sem limite)
//   legado:   até o prazo de regularização (inclusivo)
// `hoje` é o dia BRT do relógio da API (diaBrt), passado como parâmetro: nada de now() no SQL (os testes movem o relógio).
import { sql, type SQL } from 'drizzle-orm';
import { vinculoUnidade as v } from '../db/schema';

export const vinculoValidoSql = (hoje: string): SQL => sql`(
  (${v.status} = 'aprovado'
    AND (${v.vigenciaInicio} IS NULL OR ${v.vigenciaInicio} <= ${hoje}::date)
    AND (${v.vigenciaFim} IS NULL OR ${v.vigenciaFim} >= ${hoje}::date))
  OR (${v.status} = 'legado' AND ${v.prazoRegularizacao} >= ${hoje}::date))`;
