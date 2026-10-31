// Linha de base da fase F0 (docs/05_arquitetura_saas.md): gerada sobre a API real em PGlite, conferida contra um
// selos.jsonl montado pelo mesmo script do workflow (scripts/ancoras), empacotada em tar e comparada com o estado
// seguinte (o que o restore de teste e as fases F2/F3/F4 fazem).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { principal as anexarSelos } from '../scripts/ancoras/anexar-selos.mjs';
import { diaBrt } from '../src/comum/datas';
import * as s from '../src/db/schema';
import { seedPessoasDev } from '../src/db/seed-pessoas-dev';
import { compararComReferencia, gerarLinhaDeBase, problemasDaLinhaDeBase } from '../src/saas/linha-de-base';
import { montarTar } from '../src/saas/tar';
import { SeloService } from '../src/selo/selo.module';
import { type ApiDeTeste, novaApi } from './helpers/app';
import { CHAVE_HMAC_TESTE } from './helpers/banco';

const JUST = 'Morador não atende o interfone, entrega urgente';
const ANCORA_GITHUB = { github: true, emails: [], remetente: 'portaria@localhost', smtp: null, arquivo: null };

describe('linha de base (F0)', () => {
  let api: ApiDeTeste;
  let selos: string;
  let movimentar: (n: number) => Promise<void>;
  const dir = mkdtempSync(join(tmpdir(), 'linha-de-base-'));

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    api = await novaApi({ ancora: ANCORA_GITHUB });
    await seedPessoasDev(api.db, { chaveHmac: CHAVE_HMAC_TESTE, agora: api.relogio.agora() });
    const { cookie } = await api.como('porteiro');
    const [pessoa] = await api.db.select().from(s.pessoa).where(eq(s.pessoa.nome, 'Marcos Pereira'));
    const [d32] = await api.db.select().from(s.unidade).where(and(eq(s.unidade.bloco, 'D'), eq(s.unidade.numero, '32')));
    movimentar = async (n) => {
      for (let i = 0; i < n; i++) {
        const e = await api.http().post('/api/v1/eventos-acesso').set('Cookie', cookie)
          .send({ pessoaId: pessoa!.id, unidadeDestinoId: d32!.id, autorizadoPorTipo: 'excecao_porteiro', justificativa: JUST });
        if (e.status !== 201) throw new Error(`entrada falhou: ${JSON.stringify(e.body)}`);
        await api.http().post(`/api/v1/eventos-acesso/${e.body.data.id}/saida`).set('Cookie', cookie);
      }
    };
    await movimentar(2); // seq 1..4
    await (await api.servico<SeloService>(SeloService)).selarDia(diaBrt(new Date())); // diário de hoje: seq 4 (o registrado_em é do relógio real)
    // selos.jsonl como o workflow monta: resposta do endpoint público -> script do workflow
    writeFileSync(join(dir, 'resposta.json'), (await api.http().get('/api/v1/auditoria/selos/publico')).text);
    expect(anexarSelos(['--resposta', join(dir, 'resposta.json'), '--arquivo', join(dir, 'selos.jsonl')]).codigo).toBe(0);
    selos = readFileSync(join(dir, 'selos.jsonl'), 'utf8');
    expect(selos.trim().split('\n')).toHaveLength(1);
  });
  afterAll(async () => { vi.restoreAllMocks(); await api.app.close(); await api.client.close(); });

  it('cabeça, verificação interna, âncoras e contagens; trilha verificável e SEM nomes de exibição', async () => {
    const lb = await gerarLinhaDeBase(api.db, selos, api.relogio);
    const r = lb.resumo;
    const [cab] = await api.db.select().from(s.eventoAcessoCadeia);
    expect(r.cabeca).toEqual({ seq: 4, hash: cab!.ultimoHash });
    expect(r.eventos).toEqual({ quantidade: 4, primeiroSeq: 1, ultimoSeq: 4 });
    expect(r.integridade).toMatchObject({ valido: true, verificados: 4, ultimoSeq: 4, selosConferidos: 1 });
    expect(r.ancoras).toMatchObject({ conclusao: 'confere', dias: 1, divergentes: [] });
    expect(problemasDaLinhaDeBase(r)).toEqual([]);
    expect(r.contagens).toMatchObject({ evento_acesso: 4, selo_cadeia: 1, evento_acesso_cadeia: 1 });
    expect(Object.keys(r.contagens).length).toBeGreaterThan(20);
    expect(r.ultimaMigracao).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Sem nomes (pessoa, operador): só os campos canônicos, que o hash exige
    for (const nome of ['Marcos Pereira', 'João Lima']) expect(lb.trilha).not.toContain(nome);
    const linhas = lb.trilha.trim().split('\n').map((l) => JSON.parse(l));
    expect(linhas.filter((l) => l.tipo === 'evento').every((l) => l.exibicao.pessoa === null && l.exibicao.operador === null)).toBe(true);
    // O resumo não carrega dado nenhum de evento (nem o texto livre da justificativa)
    expect(JSON.stringify(r)).not.toContain(JUST);
  });

  it('tar: lido pelo tar do sistema, com os três arquivos íntegros', async () => {
    const lb = await gerarLinhaDeBase(api.db, selos, api.relogio);
    const json = Buffer.from(`${JSON.stringify(lb.resumo, null, 2)}\n`);
    const arq = join(dir, 'lb.tar');
    writeFileSync(arq, montarTar([
      { nome: 'linha-de-base.json', conteudo: json },
      { nome: 'trilha.jsonl', conteudo: Buffer.from(lb.trilha) },
      { nome: 'selos.jsonl', conteudo: Buffer.from(selos) },
    ], new Date('2026-10-22T12:00:00Z')));
    expect(spawnSync('tar', ['-tf', arq], { encoding: 'utf8' }).stdout.trim().split('\n')).toEqual(['linha-de-base.json', 'trilha.jsonl', 'selos.jsonl']);
    expect(spawnSync('tar', ['-xOf', arq, 'trilha.jsonl'], { encoding: 'utf8' }).stdout).toBe(lb.trilha);
    expect(spawnSync('tar', ['-xOf', arq, 'linha-de-base.json']).stdout.equals(json)).toBe(true);
    expect(() => montarTar([{ nome: '../fora', conteudo: Buffer.alloc(1) }], new Date())).toThrow(/nome de arquivo inválido/);
  });

  it('comparação: estado posterior confere; cabeça antiga reescrita (cadeia recalculada) não confere', async () => {
    const ref = (await gerarLinhaDeBase(api.db, selos, api.relogio)).resumo;
    await movimentar(1); // seq 5..6: a cadeia cresce, a antiga fica
    const depois = await gerarLinhaDeBase(api.db, selos, api.relogio);
    expect(compararComReferencia(depois, ref)).toEqual({ problemas: [], observacoes: [] });

    // Superusuário reescreve o evento 2 e recalcula a cadeia e a cabeça: a verificação interna volta a dizer íntegra,
    // mas o hash do seq da linha de base mudou, e as âncoras do GitHub divergem.
    await api.client.exec(`
      ALTER TABLE evento_acesso DISABLE TRIGGER evento_acesso_imutavel;
      ALTER TABLE selo_cadeia DISABLE TRIGGER USER;
      UPDATE evento_acesso SET justificativa = 'Reescrito depois, fora da API, sem rastro' WHERE seq = 2;
      DO $$ DECLARE r evento_acesso%ROWTYPE; ant text := encode(sha256(convert_to('genesis', 'UTF8')), 'hex'); h text; BEGIN
        FOR r IN SELECT * FROM evento_acesso ORDER BY seq LOOP
          h := encode(sha256(convert_to(ant || evento_acesso_canonico(r), 'UTF8')), 'hex');
          UPDATE evento_acesso SET hash_anterior = ant, hash = h WHERE id = r.id;
          UPDATE selo_cadeia SET ultimo_hash = h WHERE ultimo_seq = r.seq;
          ant := h;
        END LOOP;
        UPDATE evento_acesso_cadeia SET ultimo_hash = ant WHERE id = 1;
      END $$;
      ALTER TABLE selo_cadeia ENABLE TRIGGER USER;
      ALTER TABLE evento_acesso ENABLE TRIGGER evento_acesso_imutavel;`);
    const adulterado = await gerarLinhaDeBase(api.db, selos, api.relogio);
    expect(adulterado.resumo.integridade.valido).toBe(true);
    const c = compararComReferencia(adulterado, ref);
    expect(c.problemas).toEqual(expect.arrayContaining([
      'âncoras do GitHub: divergente',
      `hash do seq 4 difere da referência: a cadeia antiga mudou`,
    ]));
  });
});
