// Tar (ustar) mínimo, só para escrever: junta os arquivos da linha de base num fluxo único que vai direto para o `age`,
// sem passar texto claro pelo disco do servidor. Lido por qualquer `tar -x` (GNU e bsdtar). Sem dependência nova.
// Só arquivos regulares, nomes ASCII curtos (até 100 bytes), sem diretório: é o que a linha de base precisa.
const BLOCO = 512;

function campo(h: Buffer, pos: number, tam: number, valor: string) {
  h.write(valor, pos, tam, 'ascii');
}

/** Octal com zeros à esquerda e o terminador NUL, no tamanho do campo. */
const octal = (n: number, tam: number) => n.toString(8).padStart(tam - 1, '0') + '\0';

function cabecalho(nome: string, tamanho: number, mtimeSeg: number): Buffer {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(nome)) throw new Error(`nome de arquivo inválido para o tar: ${nome}`);
  const h = Buffer.alloc(BLOCO, 0);
  campo(h, 0, 100, nome);
  campo(h, 100, 8, octal(0o600, 8));
  campo(h, 108, 8, octal(0, 8));
  campo(h, 116, 8, octal(0, 8));
  campo(h, 124, 12, octal(tamanho, 12));
  campo(h, 136, 12, octal(mtimeSeg, 12));
  campo(h, 148, 8, '        '); // checksum: espaços durante o cálculo
  campo(h, 156, 1, '0');
  campo(h, 257, 6, 'ustar\0');
  campo(h, 263, 2, '00');
  let soma = 0;
  for (const b of h) soma += b;
  campo(h, 148, 8, soma.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

export function montarTar(arquivos: { nome: string; conteudo: Buffer }[], mtime: Date): Buffer {
  const partes: Buffer[] = [];
  const seg = Math.floor(mtime.getTime() / 1000);
  for (const a of arquivos) {
    partes.push(cabecalho(a.nome, a.conteudo.length, seg), a.conteudo);
    const resto = a.conteudo.length % BLOCO;
    if (resto) partes.push(Buffer.alloc(BLOCO - resto, 0));
  }
  partes.push(Buffer.alloc(BLOCO * 2, 0)); // fim do arquivo: dois blocos zerados
  return Buffer.concat(partes);
}
