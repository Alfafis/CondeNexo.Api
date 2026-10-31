// Regras de minimização da leitura do Master (src/plataforma/minimizacao.ts), sem banco. O efeito nas rotas de verdade está
// em test/master-leitura.test.ts. Nomes fictícios (repositório público).
import { describe, expect, it } from 'vitest';
import { Pagina } from '../src/comum/pagina';
import { mascararPlaca, minimizarLeituraPlataforma as minimizar, TEXTO_LIVRE_OCULTO } from '../src/plataforma/minimizacao';

describe('minimizarLeituraPlataforma', () => {
  it('nome de pessoa mascarado em qualquer profundidade; nome de usuário fica', () => {
    const ev = {
      pessoaNome: 'Ana Ribeiro', operadorNome: 'João Lima', autorizadoPorNome: 'Carla Mendes', pessoaNomeOriginal: null,
      correcao: { justificativa: 'a pedido de Carla Mendes', operadorNome: 'João Lima' },
      autorizacoes: [{ pessoaNome: 'Bruno Teixeira', solicitanteNome: 'Ana Ribeiro', registradaPorId: 'u1' }],
    };
    expect(minimizar(ev)).toEqual({
      pessoaNome: 'Ana R******', operadorNome: 'João Lima', autorizadoPorNome: 'Carla M******', pessoaNomeOriginal: null,
      correcao: { justificativa: TEXTO_LIVRE_OCULTO, operadorNome: 'João Lima' },
      autorizacoes: [{ pessoaNome: 'Bruno T******', solicitanteNome: 'Ana R******', registradaPorId: 'u1' }],
    });
  });

  it('`nome` só é mascarado em objeto de pessoa (documentoMascarado ou pessoaId)', () => {
    expect(minimizar({ nome: 'Ana Ribeiro', documentoMascarado: '123.45*.***-**' }).nome).toBe('Ana R******');
    expect(minimizar({ nome: 'Ana Ribeiro', pessoaId: 'p1' }).nome).toBe('Ana R******');
    // Usuário, área comum, ponto de acesso, anexo: ficam.
    expect(minimizar({ nome: 'Carlos Andrade', login: 'carlos.andrade', papel: 'sindico' }).nome).toBe('Carlos Andrade');
    expect(minimizar({ areasComuns: [{ nome: 'Salão de Festas' }] }).areasComuns[0]!.nome).toBe('Salão de Festas');
  });

  it('autorizador que é o usuário que cadastrou (área comum, sem solicitante) fica', () => {
    const v = 'Área comum — cadastrada por João Lima';
    expect(minimizar({ autorizadoPorNome: v }).autorizadoPorNome).toBe(v);
    expect(minimizar({ autorizadoPorNomeOriginal: 'Sem solicitante — cadastrada por João Lima' }).autorizadoPorNomeOriginal)
      .toBe('Sem solicitante — cadastrada por João Lima');
  });

  it('texto livre: preenchido vira o marcador; vazio e nulo ficam', () => {
    expect(minimizar({ descricao: 'Discussão com o morador Paulo Ribeiro', envolvidos: '', motivo: null, desativacaoMotivo: 'mudou' }))
      .toEqual({ descricao: TEXTO_LIVRE_OCULTO, envolvidos: '', motivo: null, desativacaoMotivo: TEXTO_LIVRE_OCULTO });
    expect(minimizar({ conferencia: { descricao: 'Certidão', observacao: '  ' } })).toEqual({ conferencia: { descricao: TEXTO_LIVRE_OCULTO, observacao: '  ' } });
  });

  it('placa: 3 primeiros caracteres', () => {
    expect(mascararPlaca('FKR2C41')).toBe('FKR****');
    expect(minimizar({ veiculo: { placa: 'ABC1234', modelo: 'Gol', cor: 'preto' }, veiculoPlaca: null }))
      .toEqual({ veiculo: { placa: 'ABC****', modelo: 'Gol', cor: 'preto' }, veiculoPlaca: null });
  });

  it('Pagina continua Pagina (o envelope depende disso), com os itens minimizados', () => {
    const p = minimizar(new Pagina([{ pessoaNome: 'Ana Ribeiro' }], 'c1'));
    expect(p).toBeInstanceOf(Pagina);
    expect([p.itens, p.proximoCursor]).toEqual([[{ pessoaNome: 'Ana R******' }], 'c1']);
  });

  it('Buffer (anexo) e Date passam como estão; classe desconhecida é erro (falha fechada)', () => {
    const b = Buffer.from('x');
    const d = new Date(0);
    const r = minimizar({ conteudo: b, nome: 'anexo-1.png', mime: 'image/png', em: d });
    expect(r.conteudo).toBe(b);
    expect(r.em).toBe(d);
    class Outra { pessoaNome = 'Ana Ribeiro'; }
    expect(() => minimizar({ x: new Outra() })).toThrow(/não previsto/);
  });

  it('não altera o valor recebido (a view do síndico é a mesma instância de dados)', () => {
    const v = { pessoaNome: 'Ana Ribeiro', lista: [{ descricao: 'texto' }] };
    minimizar(v);
    expect(v).toEqual({ pessoaNome: 'Ana Ribeiro', lista: [{ descricao: 'texto' }] });
  });
});
