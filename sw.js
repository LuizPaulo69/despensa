// sw.js — o app abre e funciona sem internet. O que ele nunca guarda é resposta
// da base pública: produto encontrado já fica salvo no catálogo do aparelho.

const VERSAO = 'despensa-v1';

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
    // addAll falha inteiro se um arquivo falhar; um a um é mais tolerante.
    await Promise.all(CASCA.map((p) => cache.add(new Request(p, { cache: 'reload' })).catch(() => null)));
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

  // Fora da origem (base pública, fonte, CDN do leitor): rede, e nada de cache.
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
