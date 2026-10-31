// Serviço provisionador (F5, entrega 1; docs/05_arquitetura_saas.md §5.3 e docs/deploy.md seção 18): o MESMO
// `provisionar()` da CLI provisionar-condominio, atrás de um HTTP mínimo, para a tela "Novo condomínio" do Master.
//
// Por que um processo à parte e não a própria API: provisionar exige a senha do app_provisionador (CREATEDB + SET
// app_migrator) e a do app_migrator (dono de todos os bancos de condomínio e das trilhas append-only). A API é exposta à
// internet e não pode ter essas senhas (SAAS-10). Este serviço:
//   - roda num container próprio, SÓ na rede interna do compose (sem porta publicada), e só quando ligado à mão
//     (perfil `provisionar`): desligado, a tela responde 503 e nada no cluster aceita CREATE DATABASE vindo da API;
//   - aceita UMA operação, `POST /provisionar` com a entrada da CLI e o id do Master que pediu, autenticada por token
//     compartilhado (`PROVISIONADOR_TOKEN`, comparado em tempo constante). Sem "nova senha do síndico", sem exclusão.
//     Além dela, só `GET /saude` (mesmo token; 200 sem corpo útil), para a tela saber se vale a pena preencher;
//   - atende um provisionamento por vez (409 se ocupado), com corpo de até 512 KiB (a lista explícita de unidades
//     chega a LIMITE_UNIDADES = 5000 itens, uns 160 KiB);
//   - nunca loga corpo nem resposta (a resposta leva a senha temporária do síndico, uma vez, para a API devolver ao Master).
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { log } from '../comum/log';
import { ErroChave } from '../saas/chave-mestra';
import { ErroProvisionamento, type ResultadoProvisionamento, provisionar, validarEntrada } from '../saas/provisionar';
import { abrirPortas, lerAmbiente } from './provisionar-condominio';

export const LIMITE_CORPO = 512 * 1024;
export const PORTA_PADRAO = 3200;

const Pedido = z.strictObject({ entrada: z.unknown(), masterUsuarioId: z.uuid() });

export interface DepsServidor {
  token: string;
  provisionar(entrada: unknown, masterUsuarioId: string): Promise<ResultadoProvisionamento>;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
/** Bearer correto, em tempo constante (hash dos dois lados: tamanho diferente não vaza pelo tempo). */
export const autorizado = (cabecalho: string | undefined, token: string) => timingSafeEqual(digest(cabecalho ?? ''), digest(`Bearer ${token}`));

function responder(res: ServerResponse, status: number, corpo: unknown) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(texto) });
  res.end(texto);
}

function lerCorpo(req: IncomingMessage): Promise<string | null> {
  return new Promise((ok, falha) => {
    const partes: Buffer[] = [];
    let total = 0;
    req.on('data', (p: Buffer) => {
      total += p.length;
      if (total > LIMITE_CORPO) { ok(null); req.destroy(); return; }
      partes.push(p);
    });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

export function criarServidor(d: DepsServidor): Server {
  let ocupado = false;
  return createServer((req, res) => {
    void (async () => {
      const saude = req.method === 'GET' && req.url === '/saude';
      if (!saude && (req.method !== 'POST' || req.url !== '/provisionar')) return responder(res, 404, { erro: 'rota inexistente' });
      if (!autorizado(req.headers.authorization, d.token)) return responder(res, 401, { erro: 'não autorizado' });
      // Responde mesmo durante um provisionamento: "ocupado" não é "desligado" (o envio é que recebe 409).
      if (saude) return responder(res, 200, { ok: true });
      const texto = await lerCorpo(req);
      if (texto === null) return responder(res, 413, { erro: 'corpo grande demais' });
      let pedido: z.infer<typeof Pedido>;
      try { pedido = Pedido.parse(JSON.parse(texto)); } catch { return responder(res, 400, { erro: 'pedido inválido' }); }
      if (ocupado) return responder(res, 409, { erro: 'outro provisionamento em andamento' });
      ocupado = true;
      try {
        const resultado = await d.provisionar(pedido.entrada, pedido.masterUsuarioId);
        log('info', 'provisionador.ok', { condominio_id: resultado.condominioId, motivo: resultado.situacao });
        return responder(res, 200, { resultado });
      } catch (e) {
        if (e instanceof ErroProvisionamento) {
          log('warn', 'provisionador.recusado');
          return responder(res, 422, { erro: e.message });
        }
        // Só o tipo: a mensagem do pg não traz senha, mas pode trazer nome de banco e SQL.
        log('error', 'provisionador.falha', { erro: e instanceof Error ? e.name : typeof e });
        return responder(res, 500, { erro: 'falha interna no provisionamento (o condomínio, se registrado, segue provisionando: repita para retomar)' });
      } finally {
        ocupado = false;
      }
    })().catch(() => { if (!res.headersSent) responder(res, 500, { erro: 'falha interna' }); });
  });
}

/** Provisionamento de produção: as mesmas conexões da CLI, abertas e fechadas a cada pedido (raro). */
export function provisionarComAmbiente(env: NodeJS.ProcessEnv): DepsServidor['provisionar'] {
  return async (bruto, masterUsuarioId) => {
    const entrada = validarEntrada(bruto);
    const amb = lerAmbiente(env);
    const conexoes = abrirPortas(amb);
    try {
      return await provisionar(await conexoes.portas(), entrada, { masterUsuarioId });
    } finally {
      await conexoes.fechar();
      amb.mestra.chave.fill(0);
    }
  };
}

export function tokenDoAmbiente(env: NodeJS.ProcessEnv): string {
  const t = env.PROVISIONADOR_TOKEN?.trim();
  if (!t || t.length < 32) throw new ErroChave('PROVISIONADOR_TOKEN não definida ou com menos de 32 caracteres');
  return t;
}

if (typeof require !== 'undefined' && require.main === module) {
  try {
    const token = tokenDoAmbiente(process.env);
    lerAmbiente(process.env); // recusa subir sem as quatro URLs e a mestra (mensagem cita a variável, nunca o valor)
    const porta = Number(process.env.PORT ?? PORTA_PADRAO);
    const s = criarServidor({ token, provisionar: provisionarComAmbiente(process.env) });
    s.listen(porta, '0.0.0.0', () => log('info', 'provisionador.no_ar'));
    const sair = () => s.close(() => process.exit(0));
    process.once('SIGTERM', sair);
    process.once('SIGINT', sair);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
