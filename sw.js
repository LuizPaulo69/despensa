// sw.js — o app abre e funciona sem internet. O que ele nunca guarda é resposta
// da base pública: produto encontrado já fica salvo no catálogo do aparelho.

const VERSAO = 'despensa-v2';

// Leitor de código de barras para navegadores sem BarcodeDetector (iPhone,
// Firefox). Versão fixa na URL e marcada como immutable pela CDN: pode ficar
// no cache para sempre. Sem isto, no iPhone sem internet o scanner não abria.
const LEITOR_IPHONE = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js';

// Caminhos relativos ao escopo, porque no GitHub Pages o app vive num subdiretório.
const CASCA = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'core.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSAO);
    // Sem leitor nativo (iPhone, Firefox), o leitor da CDN já vem junto na
    // instalação: assim o scanner funciona offline desde o primeiro uso, sem
    // precisar ter sido aberto antes com internet. O Chrome expõe o
    // BarcodeDetector também aqui no worker, e não baixa nada a mais.
    const arquivos = 'BarcodeDetector' in self ? CASCA : [...CASCA, LEITOR_IPHONE];
    // addAll falha inteiro se um arquivo falhar; um a um é mais tolerante.
    await Promise.all(arquivos.map((p) => cache.add(new Request(p, { cache: 'reload' })).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const nome of await caches.keys()) {
      if (nome !== VERSAO) await caches.delete(nome);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // O leitor do iPhone é a exceção à regra de não guardar nada de fora:
  // é baixado só por quem precisa, e na primeira vez fica guardado.
  if (req.url === LEITOR_IPHONE) {
    ev.respondWith((async () => {
      const cache = await caches.open(VERSAO);
      const guardado = await cache.match(req);
      if (guardado) return guardado;
      const resp = await fetch(req);
      if (resp.ok) await cache.put(req, resp.clone());
      return resp;
    })());
    return;
  }

  // Resto de fora da origem (base pública, fontes): rede, e nada de cache.
  if (url.origin !== self.location.origin) return;

  // Navegação: tenta a rede, cai para a casca guardada quando não há sinal.
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(VERSAO);
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Arquivos do app: cache primeiro para abrir rápido, com atualização em segundo plano.
  ev.respondWith((async () => {
    const cache = await caches.open(VERSAO);
    const guardado = await cache.match(req);
    const daRede = fetch(req).then((resp) => {
      if (resp && resp.ok) cache.put(req, resp.clone());
      return resp;
    }).catch(() => null);
    return guardado || (await daRede) || Response.error();
  })());
});
