// Roda com: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  digitoGtin, gtinValido, upcEparaUpcA, ehCodigoInterno, nomeFormatoGtin,
  normalizarLeitura, urlOff, produtoDeOff, parseNumeroBR, diasEntre,
  estadoItem, valorEstimado, casaBusca, lerImport, mesclar, paraCsv, montarExport,
} from '../core.js';

test('dígito verificador de código real de supermercado', () => {
  // Leite Moça 395 g — conferido contra a resposta da API.
  assert.equal(gtinValido('7891000100103'), true);
  assert.equal(digitoGtin('789100010010'), '3');
  // Um dígito trocado tem que cair.
  assert.equal(gtinValido('7891000100104'), false);
  assert.equal(gtinValido('7891000100113'), false);
});

test('dígito verificador nos outros tamanhos de GTIN', () => {
  const ean8 = '7891234' + digitoGtin('7891234');
  assert.equal(gtinValido(ean8), true);
  const upca = '01234567890' + digitoGtin('01234567890');
  assert.equal(gtinValido(upca), true);
  const itf14 = '1789100010010' + digitoGtin('1789100010010');
  assert.equal(gtinValido(itf14), true);
});

test('dígito verificador recusa o que não é GTIN', () => {
  assert.equal(gtinValido(''), false);
  assert.equal(gtinValido('123'), false);
  assert.equal(gtinValido('789100010010'), false); // 12 dígitos, mas não é UPC-A válido
  assert.equal(gtinValido('789100010010X'), false);
  assert.equal(gtinValido('78910001001034'), false);
});

test('UPC-E expande para UPC-A', () => {
  // Caso canônico do padrão UPC-E.
  assert.equal(upcEparaUpcA('01234565'), '012345000065');
  assert.equal(gtinValido(upcEparaUpcA('01234565')), true);
  // Cada regra de expansão gera um UPC-A com dígito válido.
  for (const ultimo of ['0', '1', '2', '3', '4', '5', '9']) {
    const upce = '0' + '12345'.slice(0, 5) + ultimo + '0';
    const upca = upcEparaUpcA(upce.slice(0, 8));
    assert.ok(upca, 'expandiu ' + upce);
    assert.equal(upca.length, 12);
    assert.equal(gtinValido(upca), true, 'dígito válido para final ' + ultimo);
  }
  assert.equal(upcEparaUpcA('91234565'), null); // sistema diferente de 0/1
  assert.equal(upcEparaUpcA('abc'), null);
});

test('código interno de loja é reconhecido', () => {
  assert.equal(ehCodigoInterno('2001234567890'), true); // etiqueta de balança
  assert.equal(ehCodigoInterno('20012345'), true);
  assert.equal(ehCodigoInterno('7891000100103'), false);
  assert.equal(ehCodigoInterno('2'), false);
});

test('nome do formato pelo tamanho', () => {
  assert.equal(nomeFormatoGtin('7891000100103'), 'ean_13');
  assert.equal(nomeFormatoGtin('012345000065'), 'upc_a');
  assert.equal(nomeFormatoGtin('78912344'), 'ean_8');
  assert.equal(nomeFormatoGtin('17891000100109'), 'itf_14');
});

test('normalizar leitura: o que a câmera entrega até o código do produto', () => {
  const bom = normalizarLeitura('7891000100103', 'ean_13');
  assert.deepEqual(bom, { ok: true, code: '7891000100103', formato: 'ean_13' });

  // Leitura parcial/errada é recusada em vez de virar produto fantasma.
  const ruim = normalizarLeitura('7891000100104', 'ean_13');
  assert.equal(ruim.ok, false);
  assert.match(ruim.motivo, /dígito verificador/);

  // UPC-E é expandido antes de validar — sem isso, leitura boa seria recusada.
  const upce = normalizarLeitura('01234565', 'upc_e');
  assert.equal(upce.ok, true);
  assert.equal(upce.code, '012345000065');
  assert.equal(upce.expandidoDe, 'upc_e');

  // Code 128 alfanumérico (caixa, fardo) não tem dígito verificador padrão.
  const c128 = normalizarLeitura(' ab-12345 ', 'code_128');
  assert.equal(c128.ok, true);
  assert.equal(c128.code, 'AB-12345');

  assert.equal(normalizarLeitura('', 'ean_13').ok, false);
  assert.equal(normalizarLeitura('12', 'ean_13').ok, false);
  assert.equal(normalizarLeitura(null, null).ok, false);

  // Numérico fora dos tamanhos de GTIN passa (ITF de caixa, por exemplo).
  assert.equal(normalizarLeitura('123456', 'itf').ok, true);
});

test('URL da API leva os campos e identifica o app', () => {
  const u = urlOff('7891000100103');
  assert.ok(u.startsWith('https://world.openfoodfacts.org/api/v2/product/7891000100103.json?'));
  assert.match(u, /product_name_pt/);
  assert.match(u, /app_name=despensa-lp/);
});

test('resposta real da API vira produto do catálogo', () => {
  // Corpo devolvido pela API para 7891000100103, com os campos que pedimos.
  const json = {
    code: '7891000100103',
    status: 1,
    status_verbose: 'product found',
    product: {
      brands: 'Nestlé, Moça',
      code: '7891000100103',
      image_front_small_url: 'https://images.openfoodfacts.org/images/products/789/100/010/0103/front_pt.34.200.jpg',
      product_name: 'Leite Condensado Integral moça',
      product_name_pt: 'Leite Condensado Integral moça',
      quantity: '395 g',
      categories_tags: ['en:dairies', 'pt:leite-condensado'],
    },
  };
  const p = produtoDeOff(json, '7891000100103');
  assert.equal(p.nome, 'Leite Condensado Integral moça');
  assert.equal(p.marca, 'Nestlé'); // só a primeira marca, não "Nestlé, Moça"
  assert.equal(p.embalagem, '395 g');
  assert.equal(p.categoria, 'leite condensado'); // prefixo de idioma removido
  assert.equal(p.origem, 'off');
});

test('produto sem nome ou não encontrado não entra no catálogo', () => {
  assert.equal(produtoDeOff({ status: 0 }, '123'), null);
  assert.equal(produtoDeOff({ status: 1, product: { brands: 'X' } }, '123'), null);
  assert.equal(produtoDeOff(null, '123'), null);
  // Nome só em branco também não serve.
  assert.equal(produtoDeOff({ status: 1, product: { product_name: '   ' } }, '123'), null);
});

test('preço digitado do jeito brasileiro', () => {
  assert.equal(parseNumeroBR('3,50'), 3.5);
  assert.equal(parseNumeroBR('R$ 3,50'), 3.5);
  assert.equal(parseNumeroBR('1.299,90'), 1299.9);
  assert.equal(parseNumeroBR('12.5'), 12.5);
  assert.equal(parseNumeroBR('7'), 7);
  assert.equal(parseNumeroBR(4.25), 4.25);
  assert.equal(parseNumeroBR(''), null);
  assert.equal(parseNumeroBR('abc'), null);
  assert.equal(parseNumeroBR('R$'), null);
  assert.equal(parseNumeroBR(null), null);
});

test('contagem de dias ignora horário', () => {
  assert.equal(diasEntre('2026-09-29T23:50:00Z', '2026-09-30T00:10:00Z'), 1);
  assert.equal(diasEntre('2026-09-29', '2026-09-29'), 0);
  assert.equal(diasEntre('2026-09-29', '2026-09-28'), -1);
  assert.equal(diasEntre('lixo', '2026-09-29'), null);
});

test('estado do item marca o que precisa de atenção', () => {
  const hoje = '2026-09-29T12:00:00Z';
  const acabando = estadoItem({ qtd: 1, minimo: 2 }, hoje);
  assert.equal(acabando.acabando, true);
  assert.equal(acabando.zerado, false);

  assert.equal(estadoItem({ qtd: 0, minimo: 2 }, hoje).zerado, true);
  assert.equal(estadoItem({ qtd: 5, minimo: 2 }, hoje).acabando, false);
  // Sem mínimo definido não existe "acabando".
  assert.equal(estadoItem({ qtd: 1, minimo: 0 }, hoje).acabando, false);

  const vencendo = estadoItem({ qtd: 1, validade: '2026-10-05' }, hoje);
  assert.equal(vencendo.vencendo, true);
  assert.equal(vencendo.vencido, false);
  assert.equal(vencendo.diasParaVencer, 6);

  const vencido = estadoItem({ qtd: 1, validade: '2026-09-20' }, hoje);
  assert.equal(vencido.vencido, true);
  assert.equal(vencido.vencendo, false);

  const longe = estadoItem({ qtd: 1, validade: '2027-01-01' }, hoje);
  assert.equal(longe.vencendo, false);
  assert.equal(longe.vencido, false);
});

test('valor estimado ignora item sem preço', () => {
  assert.equal(valorEstimado([{ qtd: 2, preco: 3.5 }, { qtd: 1, preco: 10 }]), 17);
  assert.equal(valorEstimado([{ qtd: 2, preco: null }, { qtd: 1, preco: 10 }]), 10);
  assert.equal(valorEstimado([]), 0);
  assert.equal(valorEstimado([{ qtd: 3, preco: 1.115 }]), 3.35);
});

test('busca acha sem acento e por código', () => {
  const p = { nome: 'Açúcar Refinado', marca: 'União', categoria: 'acucares' };
  const i = { code: '7891000100103', mercado: 'Assaí' };
  assert.equal(casaBusca('acucar', p, i), true);
  assert.equal(casaBusca('AÇÚCAR uniao', p, i), true);
  assert.equal(casaBusca('789100', p, i), true);
  assert.equal(casaBusca('assai', p, i), true);
  assert.equal(casaBusca('arroz', p, i), false);
  assert.equal(casaBusca('', p, i), true);
});

test('importar recusa arquivo que não é backup', () => {
  assert.match(lerImport('não é json').erro, /JSON válido/);
  assert.match(lerImport('{"app":"outro"}').erro, /não é um backup/);
  assert.match(lerImport('{"app":"despensa","formato":99,"estoque":[]}').erro, /versão mais nova/);

  const bom = lerImport(JSON.stringify({
    app: 'despensa', formato: 1,
    produtos: [{ code: '1', nome: 'X' }, { nome: 'sem código' }],
    estoque: [{ code: '1', qtd: 2 }, { qtd: 9 }],
  }));
  assert.equal(bom.ok, true);
  assert.equal(bom.produtos.length, 1); // registro sem código é descartado
  assert.equal(bom.estoque.length, 1);
});

test('exportar e importar fecham o ciclo', () => {
  const produtos = [{ code: '7891000100103', nome: 'Leite Moça', origem: 'off' }];
  const estoque = [{ code: '7891000100103', qtd: 2, preco: 8.49, atualizadoEm: '2026-09-29T10:00:00.000Z' }];
  const volta = lerImport(JSON.stringify(montarExport(produtos, estoque)));
  assert.equal(volta.ok, true);
  assert.deepEqual(volta.produtos, produtos);
  assert.deepEqual(volta.estoque, estoque);
});

test('mesclar mantém o registro mais recente', () => {
  const atuais = [
    { code: 'a', qtd: 1, atualizadoEm: '2026-09-01T00:00:00Z' },
    { code: 'b', qtd: 5, atualizadoEm: '2026-09-20T00:00:00Z' },
  ];
  const entrando = [
    { code: 'a', qtd: 9, atualizadoEm: '2026-09-28T00:00:00Z' }, // mais novo, vence
    { code: 'b', qtd: 2, atualizadoEm: '2026-09-10T00:00:00Z' }, // mais velho, perde
    { code: 'c', qtd: 3, atualizadoEm: '2026-09-25T00:00:00Z' }, // novo
  ];
  const r = mesclar(atuais, entrando);
  const porCode = Object.fromEntries(r.registros.map((x) => [x.code, x.qtd]));
  assert.deepEqual(porCode, { a: 9, b: 5, c: 3 });
  assert.equal(r.novos, 1);
  assert.equal(r.atualizados, 1);
  assert.equal(r.ignorados, 1);
});

test('CSV abre no Excel em português', () => {
  const csv = paraCsv([{
    codigo: '7891000100103', nome: 'Leite; Moça "raro"', marca: 'Nestlé',
    embalagem: '395 g', categoria: '', quantidade: 2, minimo: 1,
    preco: 8.5, mercado: 'Assaí', validade: '2027-01-10',
    atualizado_em: '2026-09-29T10:00:00.000Z', origem: 'off',
  }]);
  assert.ok(csv.startsWith('﻿'), 'tem BOM para os acentos');
  const linhas = csv.trim().split('\r\n');
  assert.equal(linhas[0].replace('﻿', '').split(';')[0], 'codigo');
  assert.match(linhas[1], /"Leite; Moça ""raro"""/); // ponto e vírgula e aspas escapados
  assert.match(linhas[1], /;8,50;/); // decimal com vírgula
});
