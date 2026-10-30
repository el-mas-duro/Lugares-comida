/* ═══════════════════════════════════════════════
   Service Worker — Mis Lugares de Comida
   Estrategia: cache-first para assets estáticos,
   network-first para tiles de CARTO.
═══════════════════════════════════════════════ */

const CACHE_NAME = 'mis-lugares-v3';

const STATIC_ASSETS = [
  '/Lugares-comida/',
  '/Lugares-comida/index.html',
  '/Lugares-comida/style.css',
  '/Lugares-comida/app.js',
  '/Lugares-comida/manifest.json',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

// Install: pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for static, network-first for CARTO tiles
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // CARTO tile requests → network first, fall back to cache
  if (url.hostname.endsWith('basemaps.cartocdn.com')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else → cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
