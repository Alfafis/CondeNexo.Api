// Confere uma exportação da trilha (Histórico, "Exportar trilha": JSONL v2) contra o arquivo de âncoras do GitHub
// (selos.jsonl do branch `ancoras`). Offline: não conecta ao banco nem à API, não precisa de .env. Spec §4.6.
//
//   git show origin/ancoras:selos.jsonl > selos.jsonl          (ou baixe o arquivo pelo GitHub)
//   node dist/cli/verificar-ancoras.js trilha-condnexo-AAAAMMDD-HHMM.jsonl selos.jsonl
// Precisa só do Node e do build da API (npm ci && npm run build), em qualquer máquina: de preferência
// numa que NÃO seja o servidor, já que a conferência existe para o caso de o servidor estar adulterado.
//
// Códigos de saída: 0 confere; 1 nenhuma âncora no intervalo exportado (inconclusivo: exporte um período maior);
// 2 divergência ou trilha inconsistente (a trilha foi alterada depois da âncora); 3 uso ou arquivo ilegível.
import { readFileSync } from 'node:fs';
import { conferirAncoras } from '../selo/conferir-ancoras';

async function principal(): Promise<number> {
  const [trilha, ancoras] = process.argv.slice(2);
  if (!trilha || !ancoras) {
    console.error('uso: verificar-ancoras.js <trilha exportada .jsonl> <selos.jsonl do branch ancoras>');
    return 3;
  }
  const r = await conferirAncoras(readFileSync(trilha, 'utf8'), readFileSync(ancoras, 'utf8'));
  console.log(JSON.stringify(r, null, 2));
  const msg = {
    confere: `CONFERE: ${r.conferidas.length} dia(s) ancorado(s) batem com a trilha exportada (seq ${r.trilha.primeiroSeq} a ${r.trilha.ultimoSeq}).`,
    divergente: `DIVERGENTE: ${r.divergentes.length} dia(s) ancorado(s) com hash diferente na trilha. A trilha foi reescrita depois da âncora.`,
    trilha_invalida: `TRILHA INVÁLIDA: a exportação não é coerente por dentro (${r.trilha.motivo} no seq ${r.trilha.primeiroSeqInvalido}).`,
    sem_ancora_no_intervalo: 'INCONCLUSIVO: nenhum dia ancorado cai no intervalo exportado. Exporte um período que inclua dias ancorados.',
  }[r.conclusao];
  console.error(msg);
  return r.conclusao === 'confere' ? 0 : r.conclusao === 'sem_ancora_no_intervalo' ? 1 : 2;
}

principal().then((c) => { process.exitCode = c; }, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 3;
});
