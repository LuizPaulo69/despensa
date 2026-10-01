// app.js — câmera, banco local e tela. As regras puras ficam em core.js.

import {
  normalizarLeitura, ehCodigoInterno, chaveDeBalanca, urlOff, produtoDeOff, parseNumeroBR,
  fmtBRL, fmtDataCurta, estadoItem, valorEstimado, casaBusca,
  montarExport, lerImport, mesclar, paraCsv,
} from './core.js';

export const VERSAO = '1.0.0';

const CDN_ZXING = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js';
const FORMATOS_DESEJADOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'];
const ESPERA_ENTRE_CONSULTAS = 2100; // a base pública aceita 15 por minuto
const COOLDOWN_MESMO_CODIGO = 3000;

/* ================================ atalhos ================================= */

const $ = (id) => document.getElementById(id);
const el = (tag, classe, texto) => {
  const n = document.createElement(tag);
  if (classe) n.className = classe;
  if (texto != null) n.textContent = texto;
  return n;
};

/* ================================= estado ================================= */

const estado = {
  produtos: new Map(),   // code -> { code, nome, marca, embalagem, imagem, categoria, origem }
  estoque: new Map(),    // code -> { code, qtd, preco, mercado, validade, minimo, atualizadoEm }
  recentes: [],          // leituras desta sessão
  consultas: 0,
  modoLeitor: 'verificando',
  aba: 'escanear',
  filtro: 'todos',
  ordem: 'recente',
  busca: '',
  dbOk: true,
};

const painel = { code: null, produto: null, novo: false, interno: false, carregando: false };

/* ============================== preferências ============================== */

function prefLer(chave, padrao) {
  try {
    const v = localStorage.getItem('despensa:' + chave);
    return v == null ? padrao : v;
  } catch (e) {
    return padrao;
  }
}

function prefGravar(chave, valor) {
  try {
    localStorage.setItem('despensa:' + chave, String(valor));
  } catch (e) { /* modo privado: segue sem lembrar */ }
}

/* ============================== banco local =============================== */

const DB_NOME = 'despensa';
const DB_VER = 1;
let db = null;

function abrirBanco() {
  return new Promise((ok, erro) => {
    const req = indexedDB.open(DB_NOME, DB_VER);
    req.onupgradeneeded = () => {
      const b = req.result;
      if (!b.objectStoreNames.contains('produtos')) b.createObjectStore('produtos', { keyPath: 'code' });
      if (!b.objectStoreNames.contains('estoque')) b.createObjectStore('estoque', { keyPath: 'code' });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
    req.onblocked = () => erro(new Error('banco bloqueado por outra aba'));
  });
}

function pedido(req) {
  return new Promise((ok, erro) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

async function dbTodos(loja) {
  if (!db) return [];
  return pedido(db.transaction(loja, 'readonly').objectStore(loja).getAll());
}

async function dbGravar(loja, valor) {
  if (!db) return;
  return pedido(db.transaction(loja, 'readwrite').objectStore(loja).put(valor));
}

async function dbGravarVarios(loja, valores) {
  if (!db || !valores.length) return;
  const t = db.transaction(loja, 'readwrite');
  const s = t.objectStore(loja);
  for (const v of valores) s.put(v);
  return new Promise((ok, erro) => {
    t.oncomplete = () => ok();
    t.onerror = () => erro(t.error);
  });
}

async function dbApagar(loja, code) {
  if (!db) return;
  return pedido(db.transaction(loja, 'readwrite').objectStore(loja).delete(code));
}

async function dbLimpar(loja) {
  if (!db) return;
  return pedido(db.transaction(loja, 'readwrite').objectStore(loja).clear());
}

/* ================================ avisos ================================= */

function aviso(texto, tipo) {
  const caixa = $('avisos');
  const n = el('div', 'aviso' + (tipo ? ' aviso-' + tipo : ''), texto);
  caixa.appendChild(n);
  setTimeout(() => {
    n.style.transition = 'opacity .25s';
    n.style.opacity = '0';
    setTimeout(() => n.remove(), 260);
  }, tipo === 'ruim' ? 4200 : 2300);
}

/* ============================ som e vibração ============================= */

let audio = null;

function bip(ok = true) {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const vol = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = ok ? 1180 : 320;
    vol.gain.setValueAtTime(0.0001, audio.currentTime);
    vol.gain.exponentialRampToValueAtTime(0.09, audio.currentTime + 0.01);
    vol.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (ok ? 0.1 : 0.22));
    osc.connect(vol).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.11 : 0.24));
  } catch (e) { /* som é bônus */ }
}

function vibrar(ms) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch (e) { /* idem */ }
}

/* =============================== câmera ================================== */

const video = $('video');
const visor = $('visor');

let escaneando = false;
let pausado = false;
let streamAtual = null;
let detectorNativo = null;
let leitorZxing = null;
let controlesZxing = null;
let timerLoop = null;
let trilhaVideo = null;
let wakeLock = null;

let candidato = { code: null, vezes: 0, r: null };
let ultimoAceito = { code: null, quando: 0 };

async function prepararLeitor() {
  if (window.BarcodeDetector) {
    try {
      const suportados = await window.BarcodeDetector.getSupportedFormats();
      const usar = FORMATOS_DESEJADOS.filter((f) => suportados.includes(f));
      if (usar.length) {
        detectorNativo = new window.BarcodeDetector({ formats: usar });
        estado.modoLeitor = 'nativo';
        return;
      }
    } catch (e) { /* cai no plano B */ }
  }
  estado.modoLeitor = 'zxing';
}

function carregarScript(src) {
  return new Promise((ok, erro) => {
    const s = document.createElement('script');
    // CORS em vez de "opaco": o service worker consegue ler a resposta,
    // guardá-la para uso offline e conferir se ela veio inteira.
    s.crossOrigin = 'anonymous';
    s.src = src;
    s.async = true;
    s.onload = () => ok();
    s.onerror = () => erro(new Error('não baixou ' + src));
    document.head.appendChild(s);
  });
}

async function prepararZxing() {
  if (leitorZxing) return leitorZxing;
  if (!window.ZXingBrowser) await carregarScript(CDN_ZXING);
  // Só leitores de barras 1D: não perde tempo procurando QR Code, que aqui não serve.
  leitorZxing = new window.ZXingBrowser.BrowserMultiFormatOneDReader(undefined, {
    delayBetweenScanAttempts: 120,
    delayBetweenScanSuccess: 600,
  });
  return leitorZxing;
}

function nomeFormatoZxing(valor) {
  try {
    const tabela = window.ZXingBrowser && window.ZXingBrowser.BarcodeFormat;
    if (tabela && typeof valor === 'number' && tabela[valor]) return String(tabela[valor]).toLowerCase();
  } catch (e) { /* segue sem o nome */ }
  return '';
}

async function ligarCamera() {
  if (escaneando) return desligarCamera();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    aviso('Este navegador não dá acesso à câmera. Use o campo de digitar o código.', 'ruim');
    return;
  }

  $('bt-camera').disabled = true;
  try {
    streamAtual = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (e) {
    const negado = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    aviso(negado
      ? 'Permissão de câmera negada. Libere nas permissões do site e tente de novo.'
      : 'Não consegui abrir a câmera. Use o campo de digitar o código.', 'ruim');
    $('bt-camera').disabled = false;
    return;
  }

  escaneando = true;
  pausado = false;
  candidato = { code: null, vezes: 0, r: null };
  visor.classList.add('ligado');
  $('bt-camera').textContent = 'Desligar câmera';
  $('bt-camera').disabled = false;
  prepararLanterna();
  pedirWakeLock();
  bip(true);

  try {
    if (estado.modoLeitor === 'nativo') {
      video.srcObject = streamAtual;
      await video.play();
      loopNativo();
    } else {
      const leitor = await prepararZxing();
      controlesZxing = await leitor.decodeFromStream(streamAtual, video, (resultado) => {
        if (!resultado) return;
        aoLer(resultado.getText(), nomeFormatoZxing(resultado.getBarcodeFormat && resultado.getBarcodeFormat()));
      });
    }
    atualizarStatusLeitor();
  } catch (e) {
    aviso('A leitura automática falhou aqui. Dá para digitar o código abaixo.', 'ruim');
    desligarCamera();
  }
}

function desligarCamera() {
  escaneando = false;
  clearTimeout(timerLoop);
  timerLoop = null;

  if (controlesZxing) {
    try { controlesZxing.stop(); } catch (e) { /* já parou */ }
    controlesZxing = null;
  }
  if (streamAtual) {
    for (const t of streamAtual.getTracks()) { try { t.stop(); } catch (e) { /* idem */ } }
    streamAtual = null;
  }
  trilhaVideo = null;
  video.srcObject = null;
  visor.classList.remove('ligado', 'lendo');
  $('bt-camera').textContent = 'Ligar câmera';
  $('bt-lanterna').hidden = true;
  $('bt-lanterna').setAttribute('aria-pressed', 'false');
  soltarWakeLock();
  atualizarStatusLeitor();
}

async function loopNativo() {
  if (!escaneando) return;
  if (!pausado && video.readyState >= 2 && video.videoWidth) {
    try {
      const achados = await detectorNativo.detect(video);
      if (achados && achados.length) aoLer(achados[0].rawValue, achados[0].format);
    } catch (e) { /* quadro ruim: tenta o próximo */ }
  }
  timerLoop = setTimeout(loopNativo, 110);
}

/**
 * Só aceita o código quando ele vem igual duas vezes seguidas e o dígito
 * verificador fecha. Sem isso, uma leitura parcial entra como produto errado.
 */
function aoLer(valor, formato) {
  if (!escaneando || pausado) return;

  const r = normalizarLeitura(valor, formato);
  if (!r.ok) {
    candidato = { code: null, vezes: 0, r: null };
    return;
  }

  if (candidato.code !== r.code) {
    candidato = { code: r.code, vezes: 1, r };
    return;
  }

  candidato.vezes += 1;
  if (candidato.vezes < 2) return;
  candidato = { code: null, vezes: 0, r: null };

  if (r.code === ultimoAceito.code && Date.now() - ultimoAceito.quando < COOLDOWN_MESMO_CODIGO) return;
  ultimoAceito = { code: r.code, quando: Date.now() };

  bip(true);
  vibrar(60);
  visor.classList.add('lendo');
  setTimeout(() => visor.classList.remove('lendo'), 260);

  processarCodigo(r.code, true);
}

function prepararLanterna() {
  const bt = $('bt-lanterna');
  bt.hidden = true;
  if (!streamAtual) return;
  trilhaVideo = streamAtual.getVideoTracks()[0];
  if (!trilhaVideo || !trilhaVideo.getCapabilities) return;
  let cap = {};
  try { cap = trilhaVideo.getCapabilities() || {}; } catch (e) { /* nem todo aparelho responde */ }
  if (cap.torch) bt.hidden = false;
}

async function alternarLanterna() {
  if (!trilhaVideo) return;
  const bt = $('bt-lanterna');
  const ligar = bt.getAttribute('aria-pressed') !== 'true';
  try {
    await trilhaVideo.applyConstraints({ advanced: [{ torch: ligar }] });
    bt.setAttribute('aria-pressed', String(ligar));
  } catch (e) {
    aviso('A lanterna não respondeu neste aparelho.', 'ruim');
  }
}

async function pedirWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* a tela apaga, e paciência */ }
}

function soltarWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* idem */ }
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && escaneando && !wakeLock) pedirWakeLock();
});

function atualizarStatusLeitor() {
  const nome = estado.modoLeitor === 'nativo'
    ? 'leitor do próprio navegador'
    : (estado.modoLeitor === 'zxing' ? 'leitor ZXing (plano B deste navegador)' : 'verificando…');
  $('leitor-status').textContent = escaneando ? 'Lendo com o ' + nome + '.' : '';
  $('info-leitor').textContent = nome;
}

/* ========================== consulta à base pública ======================= */

let ultimaConsulta = 0;

async function consultarOff(code) {
  if (!navigator.onLine) return { erro: 'offline' };

  const falta = ESPERA_ENTRE_CONSULTAS - (Date.now() - ultimaConsulta);
  if (falta > 0) await new Promise((r) => setTimeout(r, falta));
  ultimaConsulta = Date.now();

  estado.consultas += 1;
  renderInfo();

  const ctrl = new AbortController();
  const corta = setTimeout(() => ctrl.abort(), 9000);
  try {
    const resp = await fetch(urlOff(code), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (resp.status === 429 || resp.status === 503) return { erro: 'limite' };
    if (!resp.ok) return { erro: 'http' };
    const produto = produtoDeOff(await resp.json(), code);
    return produto ? { produto } : { erro: 'nao-achou' };
  } catch (e) {
    return { erro: e && e.name === 'AbortError' ? 'demorou' : 'rede' };
  } finally {
    clearTimeout(corta);
  }
}

/* ============================ fluxo de leitura ============================ */

async function processarCodigo(codeLido, veioDoLeitor) {
  // Etiqueta de balança muda a cada pesagem: o catálogo guarda pelo código do
  // produto na loja, senão cada pacote de queijo viraria um produto novo.
  const balanca = chaveDeBalanca(codeLido);
  const code = balanca ?? codeLido;
  const interno = balanca !== null || ehCodigoInterno(codeLido);

  const conhecido = estado.produtos.get(code);

  if (conhecido) {
    if (veioDoLeitor && $('modo-rapido').checked) {
      const total = await somar(code, 1);
      aviso(conhecido.nome + ' · agora ' + total, 'bom');
      registrarRecente(code, conhecido.nome, '+1');
      return;
    }
    abrirPainel(code, conhecido, { novo: false });
    return;
  }

  if (interno) {
    abrirPainel(code, { code, nome: '', marca: '', embalagem: '', imagem: '', categoria: '', origem: 'loja' },
      { novo: true, interno: true });
    return;
  }

  abrirPainel(code, null, { novo: true, carregando: true });
  const r = await consultarOff(code);
  if (painel.code !== code) return; // o usuário já fechou ou leu outro

  if (r.produto) {
    await gravarProduto(r.produto);
    painel.produto = r.produto;
    painel.novo = false;
    painel.carregando = false;
    pintarPainel();
    return;
  }

  painel.carregando = false;
  painel.produto = { code, nome: '', marca: '', embalagem: '', imagem: '', categoria: '', origem: 'manual' };
  pintarPainel();

  const recado = {
    offline: 'Sem internet agora — dá para cadastrar o nome à mão.',
    limite: 'A base pública pediu para esperar um pouco. Cadastre à mão ou tente daqui a um minuto.',
    demorou: 'A base pública demorou demais para responder.',
    'nao-achou': 'Este produto não está na base pública. Cadastre o nome uma vez e ele fica salvo.',
  }[r.erro] || 'Não consegui consultar a base pública agora.';
  $('p-erro').textContent = recado;
  $('p-erro').hidden = false;
}

function registrarRecente(code, nome, marcaTexto) {
  estado.recentes.unshift({ code, nome, nota: marcaTexto, quando: Date.now() });
  estado.recentes = estado.recentes.slice(0, 12);
  renderRecentes();
}

/* =============================== painel ================================== */

function abrirPainel(code, produto, opcoes) {
  const o = opcoes || {};
  painel.code = code;
  painel.produto = produto;
  painel.novo = !!o.novo;
  painel.interno = !!o.interno;
  painel.carregando = !!o.carregando;
  pausado = true;
  $('painel').hidden = false;
  pintarPainel();
}

function fecharPainel() {
  $('painel').hidden = true;
  painel.code = null;
  painel.produto = null;
  painel.carregando = false;
  pausado = false;
}

function pintarPainel() {
  const code = painel.code;
  const p = painel.produto;
  const item = estado.estoque.get(code);

  $('p-codigo').textContent = code;
  $('p-erro').hidden = true;

  const img = $('p-imagem');
  if (p && p.imagem) {
    // o handler vem antes do src: se a foto falhar, o fallback ainda roda
    img.onerror = () => { img.hidden = true; };
    img.alt = p.nome || '';
    img.hidden = false;
    img.src = p.imagem;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }

  const selo = $('p-selo');
  if (painel.carregando) {
    selo.textContent = 'consultando a base';
    selo.className = 'selo';
  } else if (painel.interno) {
    selo.textContent = 'código interno da loja';
    selo.className = 'selo selo-aviso';
  } else if (p && p.origem === 'off') {
    selo.textContent = 'base pública';
    selo.className = 'selo';
  } else if (item) {
    selo.textContent = 'já na sua despensa';
    selo.className = 'selo';
  } else {
    selo.textContent = 'cadastro seu';
    selo.className = 'selo selo-aviso';
  }

  if (painel.carregando) {
    $('p-nome').textContent = 'Procurando o produto…';
    $('p-sub').textContent = 'Consultando o Open Food Facts.';
  } else if (p && p.nome) {
    $('p-nome').textContent = p.nome;
    $('p-sub').textContent = [p.marca, p.embalagem, p.categoria].filter(Boolean).join(' · ');
  } else {
    $('p-nome').textContent = painel.interno ? 'Item de balança ou granel' : 'Produto novo';
    $('p-sub').textContent = painel.interno
      ? 'Esse código só existe dentro daquele mercado, então o nome é você quem dá.'
      : 'Dê um nome e ele fica salvo para as próximas vezes.';
  }

  const precisaNome = !painel.carregando && (!p || !p.nome);
  $('p-novos').hidden = !precisaNome;
  if (precisaNome) {
    $('p-in-nome').value = (p && p.nome) || '';
    $('p-in-marca').value = (p && p.marca) || '';
    $('p-in-categoria').value = (p && p.categoria) || '';
  }

  $('p-qtd').value = item ? Number(item.qtd) || 0 : 1;
  $('p-preco').value = item && item.preco != null && item.preco !== '' ? String(item.preco).replace('.', ',') : '';
  $('p-minimo').value = item && item.minimo != null ? item.minimo : 1;
  $('p-mercado').value = (item && item.mercado) || prefLer('ultimoMercado', '');
  $('p-validade').value = (item && item.validade) || '';

  $('bt-remover').hidden = !item;
  $('bt-mais-um').hidden = painel.carregando;
  $('bt-salvar').disabled = painel.carregando;
  $('bt-mais-um').textContent = item ? 'Só somar +1 (tem ' + (Number(item.qtd) || 0) + ')' : 'Só somar +1';
}

async function salvarDoPainel() {
  const code = painel.code;
  if (!code) return;

  let produto = painel.produto;
  const precisaNome = !produto || !produto.nome;

  if (precisaNome) {
    const nome = $('p-in-nome').value.trim();
    if (!nome) {
      $('p-erro').textContent = 'Dê um nome ao produto para poder salvar.';
      $('p-erro').hidden = false;
      $('p-in-nome').focus();
      return;
    }
    produto = {
      code,
      nome,
      marca: $('p-in-marca').value.trim(),
      embalagem: (produto && produto.embalagem) || '',
      imagem: (produto && produto.imagem) || '',
      categoria: $('p-in-categoria').value.trim(),
      origem: painel.interno ? 'loja' : 'manual',
    };
  }

  const qtd = Math.max(0, Math.round(Number($('p-qtd').value) || 0));
  const minimo = Math.max(0, Math.round(Number($('p-minimo').value) || 0));
  const precoTexto = $('p-preco').value.trim();
  const preco = precoTexto ? parseNumeroBR(precoTexto) : null;

  if (precoTexto && preco == null) {
    $('p-erro').textContent = 'Não entendi o preço. Escreva como 8,49.';
    $('p-erro').hidden = false;
    $('p-preco').focus();
    return;
  }

  const mercado = $('p-mercado').value.trim();
  const item = {
    code,
    qtd,
    minimo,
    preco,
    mercado,
    validade: $('p-validade').value || '',
    atualizadoEm: new Date().toISOString(),
  };

  await gravarProduto(produto);
  await gravarItem(item);
  if (mercado) prefGravar('ultimoMercado', mercado);

  registrarRecente(code, produto.nome, qtd + ' un');
  aviso(produto.nome + ' salvo.', 'bom');
  fecharPainel();
  renderTudo();
}

async function gravarProduto(produto) {
  estado.produtos.set(produto.code, produto);
  try {
    await dbGravar('produtos', produto);
  } catch (e) {
    estado.dbOk = false;
  }
}

async function gravarItem(item) {
  estado.estoque.set(item.code, item);
  try {
    await dbGravar('estoque', item);
  } catch (e) {
    estado.dbOk = false;
    aviso('Não consegui gravar no aparelho. Confira as permissões do navegador.', 'ruim');
  }
}

async function somar(code, delta) {
  const atual = estado.estoque.get(code);
  const item = atual
    ? { ...atual }
    : { code, qtd: 0, minimo: 1, preco: null, mercado: prefLer('ultimoMercado', ''), validade: '' };
  item.qtd = Math.max(0, (Number(item.qtd) || 0) + delta);
  item.atualizadoEm = new Date().toISOString();
  await gravarItem(item);
  renderTudo();
  return item.qtd;
}

async function removerItem(code) {
  estado.estoque.delete(code);
  try {
    await dbApagar('estoque', code);
  } catch (e) { /* já não estava lá */ }
  renderTudo();
}

/* ================================ render ================================= */

function itensOrdenados() {
  const hoje = new Date().toISOString();
  let linhas = [...estado.estoque.values()].map((item) => ({
    item,
    produto: estado.produtos.get(item.code) || { code: item.code, nome: item.code, origem: 'manual' },
    st: estadoItem(item, hoje),
  }));

  linhas = linhas.filter(({ item, produto }) => casaBusca(estado.busca, produto, item));

  if (estado.filtro === 'acabando') linhas = linhas.filter(({ st }) => st.acabando || st.zerado);
  else if (estado.filtro === 'validade') linhas = linhas.filter(({ st }) => st.vencendo || st.vencido);
  else if (estado.filtro === 'sem-preco') linhas = linhas.filter(({ item }) => item.preco == null || item.preco === '');

  const porNome = (a, b) => String(a.produto.nome).localeCompare(String(b.produto.nome), 'pt-BR');
  const ordens = {
    recente: (a, b) => String(b.item.atualizadoEm || '').localeCompare(String(a.item.atualizadoEm || '')),
    nome: porNome,
    quantidade: (a, b) => (Number(a.item.qtd) || 0) - (Number(b.item.qtd) || 0) || porNome(a, b),
    validade: (a, b) => {
      const va = a.item.validade || '9999-99-99';
      const vb = b.item.validade || '9999-99-99';
      return va.localeCompare(vb) || porNome(a, b);
    },
    preco: (a, b) => (Number(b.item.preco) || 0) - (Number(a.item.preco) || 0) || porNome(a, b),
  };
  linhas.sort(ordens[estado.ordem] || ordens.recente);
  return linhas;
}

function renderLista() {
  const lista = $('lista');
  lista.textContent = '';
  const linhas = itensOrdenados();

  const vazio = $('lista-vazia');
  if (!linhas.length) {
    vazio.hidden = false;
    vazio.textContent = estado.estoque.size === 0
      ? 'A despensa está vazia. Vá na aba Escanear e leia o primeiro produto.'
      : 'Nada aqui com esse filtro.';
    return;
  }
  vazio.hidden = true;

  for (const { item, produto, st } of linhas) {
    const li = el('li', 'item');
    li.classList.add(st.vencido ? 'st-vencido'
      : st.zerado ? 'st-zerado'
        : (st.acabando || st.vencendo) ? 'st-acabando' : 'st-ok');

    const abrir = el('button', 'bt-abrir', 'Abrir ' + (produto.nome || item.code));
    abrir.type = 'button';
    abrir.addEventListener('click', () => abrirPainel(item.code, produto, { novo: false }));
    li.appendChild(abrir);

    if (produto.imagem) {
      const img = el('img', 'item-thumb');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        const rep = el('span', 'item-thumb', (produto.nome || '?').trim().charAt(0).toUpperCase());
        img.replaceWith(rep);
      });
      img.src = produto.imagem; // src por último: o handler de erro já está armado
      li.appendChild(img);
    } else {
      li.appendChild(el('span', 'item-thumb', (produto.nome || '?').trim().charAt(0).toUpperCase()));
    }

    const info = el('div', 'item-info');
    info.appendChild(el('span', 'item-nome', produto.nome || item.code));

    const meta = el('span', 'item-meta');
    const pedacos = [produto.marca, produto.embalagem].filter(Boolean).join(' · ');
    if (pedacos) meta.appendChild(document.createTextNode(pedacos + ' · '));
    meta.appendChild(el('span', 'codigo', item.code));
    if (item.preco != null && item.preco !== '') {
      meta.appendChild(document.createTextNode(' · ' + fmtBRL(item.preco)));
    }
    info.appendChild(meta);

    const tags = el('div', 'item-tags');
    if (st.zerado) tags.appendChild(el('span', 'tag', 'acabou'));
    else if (st.acabando) tags.appendChild(el('span', 'tag tag-aviso', 'acabando'));
    if (st.vencido) tags.appendChild(el('span', 'tag tag-risco', 'venceu ' + fmtDataCurta(item.validade)));
    else if (st.vencendo) {
      tags.appendChild(el('span', 'tag tag-aviso',
        st.diasParaVencer === 0 ? 'vence hoje' : 'vence em ' + st.diasParaVencer + ' d'));
    }
    if (item.mercado) tags.appendChild(el('span', 'tag', item.mercado));
    if (tags.childNodes.length) info.appendChild(tags);
    li.appendChild(info);

    const ctrl = el('div', 'item-ctrl');
    const menos = el('button', 'bt-mini', '−');
    menos.type = 'button';
    menos.setAttribute('aria-label', 'Tirar uma unidade de ' + (produto.nome || item.code));
    menos.addEventListener('click', () => somar(item.code, -1));
    const conta = el('span', 'item-qtd', String(Number(item.qtd) || 0));
    const mais = el('button', 'bt-mini', '+');
    mais.type = 'button';
    mais.setAttribute('aria-label', 'Somar uma unidade de ' + (produto.nome || item.code));
    mais.addEventListener('click', () => somar(item.code, 1));
    ctrl.append(menos, conta, mais);
    li.appendChild(ctrl);

    lista.appendChild(li);
  }
}

function renderResumo() {
  const itens = [...estado.estoque.values()];
  const unidades = itens.reduce((s, i) => s + (Number(i.qtd) || 0), 0);
  $('num-itens').textContent = String(itens.length);
  $('num-unidades').textContent = String(unidades);
  const valor = valorEstimado(itens);
  $('num-valor').textContent = valor > 0 ? fmtBRL(valor) : '—';

  const hoje = new Date().toISOString();
  const atencao = itens.filter((i) => {
    const st = estadoItem(i, hoje);
    return st.zerado || st.acabando || st.vencendo || st.vencido;
  }).length;
  const badge = $('tab-badge');
  badge.hidden = atencao === 0;
  badge.textContent = String(atencao);
}

function renderRecentes() {
  const bloco = $('recentes-bloco');
  const ul = $('recentes');
  ul.textContent = '';
  if (!estado.recentes.length) {
    bloco.hidden = true;
    return;
  }
  bloco.hidden = false;
  for (const r of estado.recentes) {
    const li = el('li', 'recente');
    li.appendChild(el('span', null, r.nome || r.code));
    li.appendChild(el('span', 'codigo', r.code));
    li.appendChild(el('span', 'qt', r.nota || ''));
    ul.appendChild(li);
  }
}

function renderDatalists() {
  const mercados = new Set();
  for (const i of estado.estoque.values()) if (i.mercado) mercados.add(i.mercado);
  const dlM = $('lista-mercados');
  dlM.textContent = '';
  for (const m of [...mercados].sort()) {
    const o = document.createElement('option');
    o.value = m;
    dlM.appendChild(o);
  }

  const cats = new Set();
  for (const p of estado.produtos.values()) if (p.categoria) cats.add(p.categoria);
  const dlC = $('lista-categorias');
  dlC.textContent = '';
  for (const c of [...cats].sort()) {
    const o = document.createElement('option');
    o.value = c;
    dlC.appendChild(o);
  }
}

function renderInfo() {
  $('info-catalogo').textContent = String(estado.produtos.size);
  $('info-consultas').textContent = estado.consultas + ' nesta sessão';
  $('info-versao').textContent = VERSAO;
}

function renderTudo() {
  renderResumo();
  renderLista();
  renderDatalists();
  renderInfo();
}

/* ============================== exportar ================================= */

function baixar(nome, conteudo, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function hojeArquivo() {
  return new Date().toISOString().slice(0, 10);
}

function exportarJson() {
  const dados = montarExport(estado.produtos.values(), estado.estoque.values());
  baixar('despensa-' + hojeArquivo() + '.json', JSON.stringify(dados, null, 2), 'application/json');
  aviso('Backup baixado.', 'bom');
}

function exportarCsv() {
  const linhas = [...estado.estoque.values()].map((item) => {
    const p = estado.produtos.get(item.code) || {};
    return {
      codigo: item.code,
      nome: p.nome || '',
      marca: p.marca || '',
      embalagem: p.embalagem || '',
      categoria: p.categoria || '',
      quantidade: Number(item.qtd) || 0,
      minimo: Number(item.minimo) || 0,
      preco: item.preco,
      mercado: item.mercado || '',
      validade: item.validade || '',
      atualizado_em: item.atualizadoEm || '',
      origem: p.origem || '',
    };
  });
  baixar('despensa-' + hojeArquivo() + '.csv', paraCsv(linhas), 'text/csv;charset=utf-8');
  aviso('Planilha baixada.', 'bom');
}

async function importarArquivo(arquivo) {
  const msg = $('import-msg');
  msg.hidden = false;
  msg.textContent = 'Lendo o arquivo…';

  let texto;
  try {
    texto = await arquivo.text();
  } catch (e) {
    msg.textContent = 'Não consegui ler esse arquivo.';
    return;
  }

  const r = lerImport(texto);
  if (!r.ok) {
    msg.textContent = r.erro;
    aviso(r.erro, 'ruim');
    return;
  }

  const prod = mesclar([...estado.produtos.values()], r.produtos);
  const est = mesclar([...estado.estoque.values()], r.estoque);

  try {
    await dbGravarVarios('produtos', prod.registros);
    await dbGravarVarios('estoque', est.registros);
  } catch (e) {
    msg.textContent = 'O arquivo foi lido, mas não consegui gravar no aparelho.';
    return;
  }

  estado.produtos = new Map(prod.registros.map((p) => [String(p.code), p]));
  estado.estoque = new Map(est.registros.map((i) => [String(i.code), i]));
  renderTudo();

  msg.textContent = 'Pronto: ' + est.novos + ' novos, ' + est.atualizados
    + ' atualizados, ' + est.ignorados + ' já estavam mais recentes aqui.';
  aviso('Backup restaurado.', 'bom');
}

function pedirConfirmacaoApagar() {
  const zona = $('zona-apagar');
  zona.textContent = '';
  zona.appendChild(el('p', 'fraco', 'Tem certeza? Isso apaga ' + estado.estoque.size
    + ' produto(s) do estoque e ' + estado.produtos.size + ' do catálogo.'));
  const linha = el('div', 'linha-acoes');
  const sim = el('button', 'bt bt-risco', 'Apagar mesmo');
  sim.type = 'button';
  sim.addEventListener('click', apagarTudo);
  const nao = el('button', 'bt bt-quieto', 'Deixa pra lá');
  nao.type = 'button';
  nao.addEventListener('click', restaurarZonaApagar);
  linha.append(sim, nao);
  zona.appendChild(linha);
}

function restaurarZonaApagar() {
  const zona = $('zona-apagar');
  zona.textContent = '';
  const bt = el('button', 'bt bt-risco', 'Apagar a despensa');
  bt.type = 'button';
  bt.id = 'bt-apagar';
  bt.addEventListener('click', pedirConfirmacaoApagar);
  zona.appendChild(bt);
}

async function apagarTudo() {
  try {
    await dbLimpar('estoque');
    await dbLimpar('produtos');
  } catch (e) { /* segue e limpa a memória de todo jeito */ }
  estado.produtos.clear();
  estado.estoque.clear();
  estado.recentes = [];
  renderTudo();
  renderRecentes();
  restaurarZonaApagar();
  aviso('Despensa apagada.', 'bom');
}

/* ================================= abas ================================== */

function trocarAba(nome) {
  estado.aba = nome;
  prefGravar('aba', nome);
  for (const n of ['escanear', 'despensa', 'ajustes']) {
    $('aba-' + n).hidden = n !== nome;
    const tab = $('tab-' + n);
    tab.classList.toggle('ativo', n === nome);
    tab.setAttribute('aria-selected', String(n === nome));
  }
  if (nome !== 'escanear' && escaneando) desligarCamera();
  if (nome === 'despensa') renderLista();
  document.querySelector('main').scrollTop = 0;
}

/* ================================= tema ================================== */

function aplicarTema(tema) {
  if (tema === 'claro') document.documentElement.setAttribute('data-theme', 'light');
  else if (tema === 'escuro') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  $('bt-tema-txt').textContent = tema === 'claro' ? '☀' : tema === 'escuro' ? '☾' : '◐';
  prefGravar('tema', tema);
}

/* ============================ service worker ============================= */

function registrarSw() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const novo = reg.installing;
      if (!novo) return;
      novo.addEventListener('statechange', () => {
        if (novo.state === 'installed' && navigator.serviceWorker.controller) {
          $('barra-atualizar').hidden = false;
        }
      });
    });
  }).catch(() => { /* sem offline, o app ainda funciona online */ });
}

/* ================================= início ================================ */

function ligarEventos() {
  $('bt-camera').addEventListener('click', ligarCamera);
  $('bt-lanterna').addEventListener('click', alternarLanterna);

  $('form-manual').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const campo = $('codigo-manual');
    const r = normalizarLeitura(campo.value, '');
    if (!r.ok) {
      aviso(r.motivo, 'ruim');
      bip(false);
      campo.focus();
      campo.select();
      return;
    }
    campo.value = '';
    campo.blur();
    processarCodigo(r.code, false);
  });

  $('modo-rapido').addEventListener('change', (ev) => {
    prefGravar('modoRapido', ev.target.checked ? '1' : '0');
    aviso(ev.target.checked
      ? 'Compra rápida ligada: produto conhecido entra com +1 sozinho.'
      : 'Compra rápida desligada.');
  });

  for (const n of ['escanear', 'despensa', 'ajustes']) {
    $('tab-' + n).addEventListener('click', () => trocarAba(n));
  }

  $('bt-tema').addEventListener('click', () => {
    const atual = prefLer('tema', 'sistema');
    aplicarTema(atual === 'sistema' ? 'claro' : atual === 'claro' ? 'escuro' : 'sistema');
  });

  $('busca').addEventListener('input', (ev) => {
    estado.busca = ev.target.value;
    renderLista();
  });

  $('ordem').addEventListener('change', (ev) => {
    estado.ordem = ev.target.value;
    prefGravar('ordem', estado.ordem);
    renderLista();
  });

  $('chips-filtro').addEventListener('click', (ev) => {
    const bt = ev.target.closest('.chip');
    if (!bt) return;
    estado.filtro = bt.dataset.filtro;
    for (const c of $('chips-filtro').querySelectorAll('.chip')) {
      c.classList.toggle('ativo', c === bt);
    }
    renderLista();
  });

  $('painel-fundo').addEventListener('click', fecharPainel);
  $('bt-fechar').addEventListener('click', fecharPainel);
  $('painel-caixa').addEventListener('submit', (ev) => {
    ev.preventDefault();
    salvarDoPainel();
  });
  $('bt-mais-um').addEventListener('click', async () => {
    const code = painel.code;
    const p = painel.produto;
    if (!code) return;
    if (!p || !p.nome) {
      $('p-erro').textContent = 'Este produto ainda não tem nome. Preencha e use Salvar.';
      $('p-erro').hidden = false;
      $('p-in-nome').focus();
      return;
    }
    await gravarProduto(p);
    const total = await somar(code, 1);
    registrarRecente(code, p.nome, '+1');
    aviso(p.nome + ' · agora ' + total, 'bom');
    fecharPainel();
  });
  $('bt-remover').addEventListener('click', async () => {
    const code = painel.code;
    if (!code) return;
    await removerItem(code);
    aviso('Tirado da despensa.');
    fecharPainel();
  });

  for (const bt of document.querySelectorAll('.bt-step')) {
    bt.addEventListener('click', () => {
      const campo = $('p-qtd');
      const passo = Number(bt.dataset.passo) || 0;
      campo.value = String(Math.max(0, (Number(campo.value) || 0) + passo));
    });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('painel').hidden) fecharPainel();
  });

  $('bt-export-json').addEventListener('click', exportarJson);
  $('bt-export-csv').addEventListener('click', exportarCsv);
  $('arq-import').addEventListener('change', (ev) => {
    const arq = ev.target.files && ev.target.files[0];
    if (arq) importarArquivo(arq);
    ev.target.value = '';
  });
  $('bt-apagar').addEventListener('click', pedirConfirmacaoApagar);

  $('bt-recarregar').addEventListener('click', () => location.reload());

  const marcarRede = () => { $('selo-offline').hidden = navigator.onLine; };
  window.addEventListener('online', marcarRede);
  window.addEventListener('offline', marcarRede);
  marcarRede();

  window.addEventListener('pagehide', desligarCamera);
}

async function iniciar() {
  aplicarTema(prefLer('tema', 'sistema'));
  $('modo-rapido').checked = prefLer('modoRapido', '0') === '1';
  estado.ordem = prefLer('ordem', 'recente');
  $('ordem').value = estado.ordem;

  ligarEventos();
  renderInfo();

  try {
    db = await abrirBanco();
    const [produtos, itens] = await Promise.all([dbTodos('produtos'), dbTodos('estoque')]);
    estado.produtos = new Map(produtos.map((p) => [String(p.code), p]));
    estado.estoque = new Map(itens.map((i) => [String(i.code), i]));
  } catch (e) {
    estado.dbOk = false;
    aviso('Não consegui abrir o banco local. A sessão funciona, mas nada será guardado.', 'ruim');
  }

  renderTudo();
  await prepararLeitor();
  atualizarStatusLeitor();

  const abaSalva = prefLer('aba', 'escanear');
  trocarAba(['escanear', 'despensa', 'ajustes'].includes(abaSalva) ? abaSalva : 'escanear');

  registrarSw();
}

iniciar();
