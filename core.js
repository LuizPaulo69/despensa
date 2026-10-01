// core.js — as regras que não dependem de câmera, tela nem rede.
// Fica separado de propósito: tudo aqui é testável no Node (tests/core.test.mjs).

export const APP_NAME = 'despensa-lp';
export const APP_VERSION = '1';
export const FORMATO_EXPORT = 1;

// Quantos dias antes do vencimento o item já aparece marcado.
export const DIAS_ALERTA_VALIDADE = 15;

/* ============================ códigos de barras ============================ */

/** Dígito verificador de GTIN (EAN-13, EAN-8, UPC-A, ITF-14). */
export function digitoGtin(semDigito) {
  let soma = 0;
  let peso = 3;
  for (let i = semDigito.length - 1; i >= 0; i--) {
    soma += Number(semDigito[i]) * peso;
    peso = peso === 3 ? 1 : 3;
  }
  return String((10 - (soma % 10)) % 10);
}

/** Confere o dígito verificador. É o que derruba leitura errada da câmera. */
export function gtinValido(code) {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(code)) return false;
  return digitoGtin(code.slice(0, -1)) === code.slice(-1);
}

/**
 * UPC-E tem 8 dígitos, igual ao EAN-8, mas com outra regra de verificação.
 * Sem expandir para UPC-A antes de validar, uma leitura boa seria recusada.
 */
export function upcEparaUpcA(upce) {
  let s = String(upce);
  if (/^\d{6}$/.test(s)) s = '0' + s + '0';
  if (/^\d{7}$/.test(s)) s = s + '0';
  if (!/^\d{8}$/.test(s)) return null;

  const sistema = s[0];
  if (sistema !== '0' && sistema !== '1') return null;

  const m = s.slice(1, 7);
  const ultimo = m[5];
  let corpo;
  if (ultimo === '0' || ultimo === '1' || ultimo === '2') {
    corpo = m[0] + m[1] + ultimo + '0000' + m[2] + m[3] + m[4];
  } else if (ultimo === '3') {
    corpo = m[0] + m[1] + m[2] + '00000' + m[3] + m[4];
  } else if (ultimo === '4') {
    corpo = m[0] + m[1] + m[2] + m[3] + '00000' + m[4];
  } else {
    corpo = m[0] + m[1] + m[2] + m[3] + m[4] + '0000' + ultimo;
  }

  const semDigito = sistema + corpo;
  return semDigito + digitoGtin(semDigito);
}

/**
 * Prefixo 2 é "distribuição restrita" da GS1: balança, granel, fracionado.
 * Esse código só vale dentro daquele mercado, então não faz sentido consultar
 * uma base mundial com ele — vai direto para cadastro manual.
 */
export function ehCodigoInterno(code) {
  return /^2\d{7}$|^2\d{11}$|^2\d{12}$/.test(code);
}

/**
 * Etiqueta de balança (frios, carnes, padaria): EAN-13 que começa com 2. As
 * posições 2 a 7 são o código do produto na loja; as posições 8 a 12 trazem o
 * preço ou o peso DAQUELA pesagem. Por isso o código completo muda a cada
 * compra, e usá-lo como chave transformava cada pacote de queijo num produto
 * novo. A chave estável são os 7 primeiros dígitos.
 *
 * Limite conhecido: duas lojas podem usar o mesmo código para produtos
 * diferentes. Numa despensa de casa isso é raro, e o nome pode ser corrigido.
 */
export function chaveDeBalanca(code) {
  return /^2\d{12}$/.test(code) ? code.slice(0, 7) : null;
}

export function nomeFormatoGtin(code) {
  if (code.length === 13) return 'ean_13';
  if (code.length === 12) return 'upc_a';
  if (code.length === 8) return 'ean_8';
  if (code.length === 14) return 'itf_14';
  return 'desconhecido';
}

/**
 * Passo obrigatório entre "a câmera leu algo" e "isso é um produto".
 * Devolve { ok, code, formato } ou { ok: false, motivo }.
 */
export function normalizarLeitura(valor, formato) {
  const bruto = String(valor == null ? '' : valor).trim().toUpperCase().replace(/\s+/g, '');
  if (!bruto) return { ok: false, motivo: 'Nada foi lido.' };

  const f = String(formato || '').toLowerCase().replace(/[-_\s]/g, '');

  if (f.includes('upce')) {
    const expandido = upcEparaUpcA(bruto);
    if (!expandido) return { ok: false, motivo: 'Código UPC-E inválido.' };
    return { ok: true, code: expandido, formato: 'upc_a', expandidoDe: 'upc_e' };
  }

  if (/^\d+$/.test(bruto)) {
    if ([8, 12, 13, 14].includes(bruto.length)) {
      if (!gtinValido(bruto)) {
        return { ok: false, motivo: 'O dígito verificador não fecha — leitura incompleta ou código digitado errado.' };
      }
      return { ok: true, code: bruto, formato: nomeFormatoGtin(bruto) };
    }
    if (bruto.length >= 4) return { ok: true, code: bruto, formato: f || 'numerico' };
    return { ok: false, motivo: 'Código curto demais para ser de produto.' };
  }

  if (bruto.length >= 4) return { ok: true, code: bruto, formato: f || 'code_128' };
  return { ok: false, motivo: 'Código curto demais para ser de produto.' };
}

/* ============================== Open Food Facts ============================= */

export function urlOff(code) {
  const campos = [
    'code', 'product_name', 'product_name_pt', 'generic_name', 'generic_name_pt',
    'brands', 'quantity', 'image_front_small_url', 'categories_tags',
  ].join(',');
  return 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code)
    + '.json?fields=' + campos
    + '&app_name=' + APP_NAME + '&app_version=' + APP_VERSION;
}

function texto(...candidatos) {
  for (const c of candidatos) {
    const t = String(c == null ? '' : c).trim();
    if (t) return t.replace(/\s+/g, ' ');
  }
  return '';
}

function categoriaDeTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  const ultima = String(tags[tags.length - 1]);
  return ultima.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ').trim();
}

/** Traduz a resposta da API para o formato do catálogo. null = não serve. */
export function produtoDeOff(json, code) {
  const p = json && json.product;
  if (!p || json.status !== 1) return null;
  const nome = texto(p.product_name_pt, p.product_name, p.generic_name_pt, p.generic_name);
  if (!nome) return null;
  return {
    code,
    nome,
    marca: texto(String(p.brands || '').split(',')[0]),
    embalagem: texto(p.quantity),
    imagem: texto(p.image_front_small_url),
    categoria: categoriaDeTags(p.categories_tags),
    origem: 'off',
  };
}

/* ================================= números ================================= */

/** Aceita o jeito que se digita preço aqui: "3,50", "R$ 3,50", "1.299,90". */
export function parseNumeroBR(txt) {
  if (typeof txt === 'number') return Number.isFinite(txt) ? txt : null;
  let s = String(txt == null ? '' : txt).trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (!s) return null;
  const temVirgula = s.includes(',');
  const temPonto = s.includes('.');
  if (temVirgula && temPonto) s = s.replace(/\./g, '').replace(',', '.');
  else if (temVirgula) s = s.replace(',', '.');
  if (!/^-?\d*\.?\d*$/.test(s) || s === '.' || s === '-' || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function fmtBRL(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function fmtDataCurta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Diferença em dias inteiros, ignorando o horário. */
export function diasEntre(deIso, ateIso) {
  const a = new Date(deIso);
  const b = new Date(ateIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const dia = 86400000;
  return Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())
    - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / dia);
}

/* ================================= estoque ================================= */

export function estadoItem(item, hojeIso) {
  const qtd = Number(item.qtd) || 0;
  const minimo = Number(item.minimo) || 0;
  const dias = item.validade ? diasEntre(hojeIso, item.validade) : null;
  return {
    zerado: qtd <= 0,
    acabando: qtd > 0 && minimo > 0 && qtd <= minimo,
    diasParaVencer: dias,
    vencido: dias != null && dias < 0,
    vencendo: dias != null && dias >= 0 && dias <= DIAS_ALERTA_VALIDADE,
  };
}

export function valorEstimado(itens) {
  let total = 0;
  for (const it of itens) {
    const p = Number(it.preco);
    const q = Number(it.qtd);
    if (Number.isFinite(p) && Number.isFinite(q)) total += p * q;
  }
  return Math.round(total * 100) / 100;
}

export function semAcento(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Busca por nome, marca, categoria, código ou mercado — sem acento e sem caixa. */
export function casaBusca(termo, produto, item) {
  const t = semAcento(termo).trim();
  if (!t) return true;
  const alvo = semAcento([
    produto && produto.nome, produto && produto.marca, produto && produto.categoria,
    item && item.code, item && item.mercado,
  ].filter(Boolean).join(' '));
  return t.split(/\s+/).every((parte) => alvo.includes(parte));
}

/* ============================== exportar / importar ======================== */

export function montarExport(produtos, estoque) {
  return {
    app: 'despensa',
    formato: FORMATO_EXPORT,
    exportadoEm: new Date().toISOString(),
    produtos: [...produtos],
    estoque: [...estoque],
  };
}

export function lerImport(conteudo) {
  let json;
  try {
    json = JSON.parse(conteudo);
  } catch (e) {
    return { ok: false, erro: 'O arquivo não é um JSON válido.' };
  }
  if (!json || json.app !== 'despensa' || !Array.isArray(json.estoque)) {
    return { ok: false, erro: 'Esse JSON não é um backup da Despensa.' };
  }
  if (Number(json.formato) > FORMATO_EXPORT) {
    return { ok: false, erro: 'O backup é de uma versão mais nova do app. Atualize a página e tente de novo.' };
  }
  return {
    ok: true,
    produtos: Array.isArray(json.produtos) ? json.produtos.filter((p) => p && p.code) : [],
    estoque: json.estoque.filter((e) => e && e.code),
  };
}

/** Junta backup com o que já existe: para cada código, o mais recente vence. */
export function mesclar(atuais, entrando) {
  const mapa = new Map(atuais.map((r) => [String(r.code), r]));
  let novos = 0;
  let atualizados = 0;
  let ignorados = 0;
  for (const reg of entrando) {
    const code = String(reg.code);
    const atual = mapa.get(code);
    if (!atual) {
      mapa.set(code, reg);
      novos++;
    } else if (String(reg.atualizadoEm || '') > String(atual.atualizadoEm || '')) {
      mapa.set(code, reg);
      atualizados++;
    } else {
      ignorados++;
    }
  }
  return { registros: [...mapa.values()], novos, atualizados, ignorados };
}

/* =================================== CSV =================================== */

// Ponto e vírgula e decimal com vírgula: é o que o Excel em português abre sem
// jogar a planilha toda numa coluna só.
function campoCsv(v) {
  const s = String(v == null ? '' : v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const COLUNAS_CSV = [
  'codigo', 'nome', 'marca', 'embalagem', 'categoria', 'quantidade',
  'minimo', 'preco', 'mercado', 'validade', 'atualizado_em', 'origem',
];

export function paraCsv(linhas) {
  const saida = [COLUNAS_CSV.join(';')];
  for (const l of linhas) {
    saida.push(COLUNAS_CSV.map((c) => {
      const v = l[c];
      if (c === 'preco' && v != null && v !== '' && Number.isFinite(Number(v))) {
        return campoCsv(Number(v).toFixed(2).replace('.', ','));
      }
      return campoCsv(v);
    }).join(';'));
  }
  // BOM na frente para o Excel não estragar os acentos.
  return '﻿' + saida.join('\r\n') + '\r\n';
}
