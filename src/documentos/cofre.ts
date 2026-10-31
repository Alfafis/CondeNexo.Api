// Armazenamento cifrado dos anexos (RNF-03, spec §9.2). Envelope: cada arquivo tem a própria chave (DEK, 32 bytes
// aleatórios); o conteúdo é cifrado com AES-256-GCM pela DEK, e a DEK é cifrada (também AES-256-GCM) pela KEK, que
// vem do ambiente (`PORTARIA_KEK`) e nunca vai ao banco. O banco guarda só a DEK cifrada, o nonce, a versão da KEK, o
// SHA-256 do conteúdo em claro, o tipo e o tamanho. O disco guarda só o conteúdo cifrado.
// SaaS (F2): a KEK e a pasta são as do condomínio da subárvore de injeção (saas/condominio.ts), não mais do ambiente.
// Cada condomínio tem a sua KEK: a DEK de um anexo de A, aberta com a KEK de B, falha na autenticação do GCM.
//
// - AAD amarra o arquivo e a DEK ao id do documento: trocar o arquivo ou a DEK de um registro por outro falha na
//   autenticação do GCM, em vez de entregar o anexo de outra ocorrência.
// - O nome no disco é `<uuid>.bin`, gerado aqui. Nada do nome enviado pelo cliente chega ao sistema de arquivos, e o
//   caminho lido do banco é conferido contra o mesmo formato antes de virar caminho (path traversal fechado nos dois lados).
// - Escrita atômica: arquivo temporário exclusivo (0600) + rename. Se a transação do banco falhar depois, quem chamou
//   remove o arquivo (`descartar`). Queda do processo entre os dois deixa um arquivo órfão sem registro: inofensivo
//   (ilegível sem a DEK, que não foi gravada) e removível por varredura.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { erroApi } from '../comum/erros';
import { log } from '../comum/log';
import { CONFIG, type Config } from '../config/config';
import { CONDOMINIO, type CondominioResolvido, pastaDocumentos } from '../saas/condominio';

const NONCE = 12;
const TAG = 16;
const NOME_ARQUIVO = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/;
/** Temporário da escrita atômica (`<uuid>.tmp`): sobra de queda do processo entre o write e o rename. */
const NOME_TEMPORARIO = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

/** Arquivo do volume, para a varredura de órfãos da retenção. Nada fora dos dois formatos é listado (nem apagado). */
export interface ArquivoNoVolume { nome: string; id: string; temporario: boolean; modificadoEm: number }

export interface Guardado {
  id: string;
  caminhoStorage: string;
  dekCifrada: Buffer;
  nonce: Buffer;
  chaveVersao: number;
  sha256Conteudo: string;
  tamanhoBytes: number;
}

export interface DocumentoCifrado {
  id: string;
  caminhoStorage: string;
  dekCifrada: Uint8Array;
  nonce: Uint8Array;
  chaveVersao: number;
  sha256Conteudo: string;
  eliminadoEm: Date | null;
}

function cifrar(chave: Buffer, nonce: Buffer, aad: string, claro: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', chave, nonce, { authTagLength: TAG });
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([c.update(claro), c.final(), c.getAuthTag()]);
}

function decifrar(chave: Buffer, nonce: Buffer, aad: string, cifrado: Buffer): Buffer {
  if (cifrado.length < TAG) throw new Error('cifrado curto');
  const d = createDecipheriv('aes-256-gcm', chave, nonce, { authTagLength: TAG });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(cifrado.subarray(cifrado.length - TAG));
  return Buffer.concat([d.update(cifrado.subarray(0, cifrado.length - TAG)), d.final()]);
}

const aadConteudo = (id: string) => `portaria:documento:${id}`;
const aadDek = (id: string, versao: number) => `portaria:dek:${id}:v${versao}`;

/**
 * Confere uma KEK contra a DEK cifrada de um documento existente (checagem de boot, saas/resolvedor.ts): true se a DEK
 * abre e autentica. Não lê o arquivo nem devolve a DEK (zerada aqui).
 */
export function kekAbreDek(kek: Buffer, d: { id: string; dekCifrada: Uint8Array; chaveVersao: number }): boolean {
  try {
    const env = Buffer.from(d.dekCifrada);
    const dek = decifrar(kek, env.subarray(0, NONCE), aadDek(d.id, d.chaveVersao), env.subarray(NONCE));
    dek.fill(0);
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class CofreDocumentos {
  private readonly dir: string;

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(CONDOMINIO) private readonly condominio: CondominioResolvido | null,
  ) {
    this.dir = condominio ? pastaDocumentos(config.documentos.dir, condominio) : '';
  }

  /** Chaves do condomínio; sem condomínio (subárvore de falha fechada), nada é cifrado nem decifrado. */
  private chaves() {
    if (!this.condominio) throw new Error('cofre de documentos sem condomínio resolvido');
    return this.condominio.chaves;
  }

  private caminho(nome: string): string {
    if (!NOME_ARQUIVO.test(nome)) throw erroApi(500, 'DOCUMENTO_INVALIDO', 'Registro de documento inconsistente.');
    this.chaves();
    return join(this.dir, nome);
  }

  /** Cifra e grava o conteúdo. Devolve os metadados para a linha de `documento` (com o id já definido). */
  async guardar(conteudo: Buffer): Promise<Guardado> {
    const { kek, kekVersao } = this.chaves();
    const dir = this.dir;
    const id = randomUUID();
    const dek = randomBytes(32);
    const nonce = randomBytes(NONCE);
    const cifrado = cifrar(dek, nonce, aadConteudo(id), conteudo);
    const nonceDek = randomBytes(NONCE);
    const dekCifrada = Buffer.concat([nonceDek, cifrar(kek, nonceDek, aadDek(id, kekVersao), dek)]);
    dek.fill(0);

    const nome = `${id}.bin`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${id}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(cifrado);
      await fh.sync();
    } finally { await fh.close(); }
    await rename(tmp, this.caminho(nome));
    return {
      id, caminhoStorage: nome, dekCifrada, nonce, chaveVersao: kekVersao,
      sha256Conteudo: createHash('sha256').update(conteudo).digest('hex'), tamanhoBytes: conteudo.length,
    };
  }

  /** Remove o arquivo de uma gravação cuja transação falhou. Nunca lança (o erro original é o que importa). */
  async descartar(caminhoStorage: string): Promise<void> {
    try { await rm(this.caminho(caminhoStorage), { force: true }); } catch {
      log('warn', 'documento.descarte_falhou', {});
    }
  }

  /**
   * Apaga o arquivo cifrado de um documento eliminado (LGPD) ou órfão. Idempotente (já ausente = ok). Devolve false
   * se a remoção falhou: o registro continua eliminado no banco e a próxima varredura tenta de novo.
   */
  async eliminar(nome: string): Promise<boolean> {
    if (!NOME_ARQUIVO.test(nome) && !NOME_TEMPORARIO.test(nome)) return false;
    this.chaves();
    try { await rm(join(this.dir, nome), { force: true }); return true; } catch {
      log('warn', 'documento.eliminacao_falhou', { detalhe: nome.slice(0, 36) });
      return false;
    }
  }

  /** Arquivos `<uuid>.bin` e `<uuid>.tmp` do volume (pasta ausente = vazio). */
  async listar(): Promise<ArquivoNoVolume[]> {
    this.chaves();
    let nomes: string[];
    try { nomes = await readdir(this.dir); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const saida: ArquivoNoVolume[] = [];
    for (const nome of nomes) {
      const temporario = NOME_TEMPORARIO.test(nome);
      if (!temporario && !NOME_ARQUIVO.test(nome)) continue;
      try {
        const st = await stat(join(this.dir, nome));
        if (st.isFile()) saida.push({ nome, id: nome.slice(0, 36), temporario, modificadoEm: st.mtimeMs });
      } catch { /* sumiu entre o readdir e o stat: nada a fazer */ }
    }
    return saida;
  }

  /** Lê e decifra. Confere a versão da KEK, a autenticação do GCM e o SHA-256 gravado. */
  async ler(d: DocumentoCifrado): Promise<Buffer> {
    if (d.eliminadoEm) throw erroApi(410, 'DOCUMENTO_ELIMINADO', 'Este anexo foi eliminado (retenção).');
    const { kek, kekVersao } = this.chaves();
    // Rotação de KEK (spec §9.2) ainda não existe: documento de outra versão não tem chave disponível.
    if (d.chaveVersao !== kekVersao) throw erroApi(500, 'CHAVE_INDISPONIVEL', 'A chave deste anexo não está disponível no servidor.');
    let cifrado: Buffer;
    try { cifrado = await readFile(this.caminho(d.caminhoStorage)); } catch (e) {
      if ((e as { status?: number }).status) throw e;
      log('error', 'documento.arquivo_ausente', { detalhe: d.id });
      throw erroApi(500, 'DOCUMENTO_INDISPONIVEL', 'O arquivo deste anexo não foi encontrado no servidor.');
    }
    try {
      const dekEnv = Buffer.from(d.dekCifrada);
      const dek = decifrar(kek, dekEnv.subarray(0, NONCE), aadDek(d.id, d.chaveVersao), dekEnv.subarray(NONCE));
      const claro = decifrar(dek, Buffer.from(d.nonce), aadConteudo(d.id), cifrado);
      dek.fill(0);
      if (createHash('sha256').update(claro).digest('hex') !== d.sha256Conteudo) throw new Error('sha256');
      return claro;
    } catch {
      // Falha de autenticação: arquivo trocado, corrompido ou DEK de outro registro. Nunca devolve conteúdo parcial.
      log('error', 'documento.integridade', { detalhe: d.id });
      throw erroApi(500, 'DOCUMENTO_CORROMPIDO', 'O anexo não passou na verificação de integridade.');
    }
  }
}
