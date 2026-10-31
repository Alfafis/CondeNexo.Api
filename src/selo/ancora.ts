// Âncora externa do selo (spec §4.6). Por que existe: o hash encadeado detecta alteração PARCIAL da trilha, mas quem tem
// superusuário (ou é dono das tabelas) pode desligar os triggers, reescrever eventos e RECALCULAR a cadeia inteira, a
// cabeça e até os selos gravados no próprio banco; a verificação interna, que só lê o banco, não percebe. O resumo do
// selo (data, seq, hash) levado para fora, para um lugar que quem administra o servidor não reescreve, fixa o hash de
// cada dia: um hash ancorado em D que não coincide mais com o banco prova reescrita depois de D.
//
// Destinos:
//  - github (coleta): o servidor NÃO envia nada. Os selos diários ficam no endpoint público `GET /auditoria/selos/publico`
//    e um workflow agendado do GitHub Actions (.github/workflows/ancora-selo.yml) os lê e commita, só por append, no
//    branch `ancoras`. Nenhum segredo na VPS: quem toma o servidor não alcança o histórico já commitado.
//    Selo MANUAL não vai para o endpoint (só os diários): ele fica coberto pelo próximo selo diário, cujo hash depende
//    de todos os eventos anteriores, inclusive o do selo manual.
//  - e-mail (SMTP), opcional, para o síndico e o conselho (`ANCORA_EMAILS`). Em dev, o Mailpit do compose.
//  - arquivo append-only (`ANCORA_ARQUIVO`), uma linha JSON por selo, num volume separado do banco. Está no mesmo
//    servidor: é cópia local, não conta como âncora externa.
// O conteúdo não tem dado pessoal: só data, números de sequência e hashes.
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { CONFIG, type Config } from '../config/config';

export const ENVIO_ANCORA = Symbol('ENVIO_ANCORA');

export interface ResumoSelo {
  id: string;
  /** Dia BRT de referência ('AAAA-MM-DD'). */
  data: string;
  tipo: 'diario' | 'manual';
  ultimoSeq: number;
  ultimoHash: string;
  /** Eventos registrados no dia de referência até o seq selado. */
  eventosNoDia: number;
  seladoEm: Date;
}

export interface EnvioAncora {
  /** Descrição dos destinos configurados (para a tela). Vazio = a âncora fica pendente. */
  destinos(): string[];
  /** Envia a todos os destinos; devolve o texto de `enviado_para`. Lança se algum falhar (o selo fica pendente). */
  enviar(r: ResumoSelo): Promise<string>;
}

/** Destino `github`, como aparece em `enviado_para` e na tela: o selo diário fica disponível para a coleta. */
export const DESTINO_GITHUB = 'GitHub Actions (endpoint público, coleta diária)';

export class SemDestinoAncora extends Error {
  constructor() { super('nenhum destino de âncora configurado'); }
}

const ROTULO_TIPO = { diario: 'diário (último evento registrado até o fim do dia)', manual: 'manual (cabeça da cadeia no momento do pedido)' };

export function textoDoEmail(r: ResumoSelo): { assunto: string; texto: string } {
  return {
    assunto: `[CondNexo] Selo da trilha de acessos - ${r.data} - seq ${r.ultimoSeq}`,
    texto: [
      'Selo da trilha de acessos do condomínio (âncora externa).',
      '',
      `Dia de referência (horário de Brasília): ${r.data}`,
      `Tipo: ${ROTULO_TIPO[r.tipo]}`,
      `Último evento selado (seq): ${r.ultimoSeq}`,
      `Hash SHA-256 do evento selado: ${r.ultimoHash}`,
      `Eventos registrados no dia até o selo: ${r.eventosNoDia}`,
      `Selado em (UTC): ${r.seladoEm.toISOString()}`,
      `Identificador do selo: ${r.id}`,
      '',
      'Por que você recebe este e-mail: a trilha de acessos é encadeada por hash, mas quem administra o banco de dados',
      'poderia reescrevê-la inteira e recalcular os hashes. Este valor fica fora do servidor, com você. Se um dia o hash',
      'do evento acima, no sistema ou num arquivo exportado, for diferente deste, a trilha foi reescrita depois desta data.',
      '',
      'Como conferir: guarde este e-mail sem alterar. Para conferir, peça a exportação verificável da trilha (Histórico,',
      '"Exportar trilha") e confira com o verificar.js que o hash do evento de seq acima é igual ao deste e-mail. A tela',
      '"Conferir âncora" do Histórico faz a mesma comparação, mas depende do próprio servidor responder a verdade.',
      '',
      'Este e-mail não contém dado pessoal.',
    ].join('\n'),
  };
}

/** Condomínio sem destino de âncora (SaaS, F2: todos menos o piloto, até a F4). O selo fica pendente. */
export class AncoraSemDestino implements EnvioAncora {
  destinos(): string[] { return []; }
  async enviar(): Promise<string> { throw new SemDestinoAncora(); }
}

@Injectable()
export class EnvioAncoraReal implements EnvioAncora {
  private transporte: Transporter | null = null;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  destinos(): string[] {
    const { github, emails, arquivo } = this.config.ancora;
    return [
      ...(github ? [DESTINO_GITHUB] : []),
      ...(emails.length ? [`e-mail: ${emails.join(', ')}`] : []),
      ...(arquivo ? ['arquivo append-only'] : []),
    ];
  }

  async enviar(r: ResumoSelo): Promise<string> {
    const { github, emails, smtp, arquivo, remetente } = this.config.ancora;
    if (!github && !emails.length && !arquivo) throw new SemDestinoAncora();
    if (arquivo) await this.anexarAoArquivo(arquivo, r);
    if (emails.length && smtp) {
      const { assunto, texto } = textoDoEmail(r);
      await this.smtp().sendMail({ from: remetente, to: emails, subject: assunto, text: texto });
    }
    // github: nada a enviar (coleta). O texto diz o que de fato acontece com cada tipo de selo.
    return [
      ...(github ? [r.tipo === 'diario' ? DESTINO_GITHUB : 'GitHub Actions: coberto pelo próximo selo diário'] : []),
      ...(emails.length ? [`e-mail: ${emails.join(', ')}`] : []),
      ...(arquivo ? ['arquivo append-only'] : []),
    ].join('; ');
  }

  private smtp(): Transporter {
    const s = this.config.ancora.smtp!;
    this.transporte ??= createTransport({
      host: s.host, port: s.porta, secure: s.tls === 'implicito', requireTLS: s.tls === 'starttls', ignoreTLS: s.tls === 'nenhum',
      ...(s.usuario ? { auth: { user: s.usuario, pass: s.senha ?? '' } } : {}),
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
    return this.transporte;
  }

  /** Uma linha JSON por selo, com O_APPEND e fsync (a linha não fica só no cache do SO). */
  private async anexarAoArquivo(caminho: string, r: ResumoSelo) {
    await mkdir(dirname(caminho), { recursive: true, mode: 0o750 });
    const linha = JSON.stringify({
      selo: r.id, data: r.data, tipo: r.tipo, ultimoSeq: r.ultimoSeq, ultimoHash: r.ultimoHash, eventosNoDia: r.eventosNoDia,
      seladoEm: r.seladoEm.toISOString(), anotadoEm: new Date().toISOString(),
    });
    const fh = await open(caminho, 'a', 0o640);
    try {
      await fh.appendFile(`${linha}\n`, 'utf8');
      await fh.sync();
    } finally { await fh.close(); }
  }
}
