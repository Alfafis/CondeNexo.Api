// Senhas (spec §5.1): argon2id via @node-rs/argon2 (binário pré-compilado, inclusive linux-musl do Alpine; sem
// node-gyp). O algoritmo padrão da lib é argon2id; o CHECK usuario_senha_argon2id_ck confere o prefixo no banco.
import { hash, verify } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { CONFIG, type Config } from '../config/config';
import { erroApi } from '../comum/erros';
import { log } from '../comum/log';

/**
 * Lista curta embutida (spec §5.1: "checagem contra lista de senhas vazadas comuns"). Só entradas com 12+ caracteres,
 * porque as menores já caem na regra de tamanho. Comparação sem diferenciar maiúsculas.
 */
const SENHAS_COMUNS = new Set([
  '123456789012', '1234567890123', '12345678901234', '123456789123', '1234567890qw', 'qwertyuiop12', 'qwertyuiop123',
  'qwertyuiopas', 'qwerty123456', '1q2w3e4r5t6y', '1q2w3e4r5t6y7u', 'q1w2e3r4t5y6', 'asdfghjkl123', 'zxcvbnm12345',
  'password1234', 'password12345', 'password123456', 'passw0rd1234', 'senha1234567', 'senha12345678', 'senhasenha12',
  'mudar1234567', 'mudar@123456', 'trocar123456', 'admin1234567', 'administrador', 'administrador1', 'iloveyou1234',
  'brasil123456', 'portaria1234', 'portaria12345', 'condominio123', 'condominio1234', 'parque123456', 'sindico12345',
  'porteiro1234', '111111111111', '000000000000', 'aaaaaaaaaaaa', 'abcdefghijkl', 'abc123456789', 'abcd12345678',
  'minhasenha123', 'minhasenha1234', 'qazwsxedcrfv', '!qaz2wsx3edc', 'welcome12345', 'letmein12345', 'football1234',
]);

export const SENHA_MIN = 12;
export const SENHA_MAX = 256;

/**
 * Problemas da senha nova; vazio = aceita. Sem regra de composição (NIST 800-63B): tamanho + lista + contexto.
 * `minimo` só para quem exige mais que o padrão (o Master: SENHA_MIN_MASTER, de ../dominio/rbac-plataforma);
 * abaixo de SENHA_MIN é ignorado.
 */
export function problemasDaSenha(senha: string, contexto: { login?: string; minimo?: number } = {}): string[] {
  const p: string[] = [];
  const minimo = Math.max(SENHA_MIN, contexto.minimo ?? SENHA_MIN);
  if (senha.length < minimo) p.push(`A senha precisa ter pelo menos ${minimo} caracteres.`);
  if (senha.length > SENHA_MAX) p.push(`A senha pode ter no máximo ${SENHA_MAX} caracteres.`);
  const baixa = senha.toLowerCase();
  if (SENHAS_COMUNS.has(baixa)) p.push('Esta senha é muito comum. Escolha outra.');
  else if (/^(.)\1+$/.test(senha)) p.push('A senha não pode repetir um único caractere.');
  const login = contexto.login?.trim().toLowerCase();
  if (login && login.length >= 3 && baixa.includes(login)) p.push('A senha não pode conter o login.');
  return p;
}

// A senha temporária é ditada por telefone ou interfone: só minúsculas e dígitos, sem os pares que se confundem
// (0/o, 1/l). 32 símbolos = 5 bits cada; 16 símbolos = 80 bits, de sobra para senha de uso único com limite de login.
const ALFABETO = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Blocos de 4 separados por hífen (ex.: k7mq-x3rt-w9az-c2hp). Também usada pela CLI de provisionamento (síndico). */
export function gerarSenhaTemporaria(tamanho = 16): string {
  let s = '';
  for (let i = 0; i < tamanho; i++) s += (i && i % 4 === 0 ? '-' : '') + ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

@Injectable()
export class SenhaService {
  private emUso = 0;
  private readonly fila: (() => void)[] = [];
  private hashFicticio?: Promise<string>;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  /**
   * Semáforo POR PROCESSO: cada hash argon2 aloca `memoriaKib` (64 MiB). Sem teto, uma rajada de logins estoura o
   * mem_limit do container. Este limite é de memória local, por isso não vai ao banco (o de tentativas vai).
   */
  private async comPermissao<T>(fn: () => Promise<T>): Promise<T> {
    const { concorrencia, filaMax } = this.config.argon2;
    if (this.emUso >= concorrencia) {
      if (this.fila.length >= filaMax) throw erroApi(503, 'SERVICO_OCUPADO', 'Muitas requisições de login agora. Tente em instantes.');
      await new Promise<void>((ok) => this.fila.push(ok));
    } else {
      this.emUso++;
    }
    try {
      return await fn();
    } finally {
      const proximo = this.fila.shift();
      if (proximo) proximo(); else this.emUso--;
    }
  }

  private opcoes() {
    const a = this.config.argon2;
    return { memoryCost: a.memoriaKib, timeCost: a.iteracoes, parallelism: a.paralelismo };
  }

  async gerarHash(senha: string): Promise<string> {
    const h = await this.comPermissao(() => hash(senha, this.opcoes()));
    if (!h.startsWith('$argon2id$')) throw new Error('argon2: algoritmo inesperado');
    return h;
  }

  /** Nunca lança por hash malformado: é falha de verificação (e vai ao log sem o hash). */
  async verificar(senhaHash: string, senha: string): Promise<boolean> {
    return this.comPermissao(async () => {
      try {
        return await verify(senhaHash, senha);
      } catch {
        log('error', 'senha.hash_invalido');
        return false;
      }
    });
  }

  /** Verificação contra um hash fictício com os mesmos parâmetros: login inexistente custa o mesmo tempo. */
  async verificarFicticio(senha: string): Promise<void> {
    this.hashFicticio ??= hash('senha-ficticia-para-equalizar-tempo', this.opcoes());
    await this.verificar(await this.hashFicticio, senha);
  }

  /** Blocos de 4 separados por hífen (ex.: k7mq-x3rt-w9az-c2hp). O hífen faz parte da senha: digita-se o que se vê. */
  gerarTemporaria(tamanho = 16): string {
    return gerarSenhaTemporaria(tamanho);
  }
}
