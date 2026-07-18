/*
 * SECH_LIMS service worker — offline-first *app shell* only.
 *
 * Design rule for a live LIMS: NEVER cache API responses. Laboratory data
 * (results, QC, alerts) must always be read live from the Host; a stale cached
 * record could be clinically misleading. This worker therefore:
 *   - passes every /api request straight through to the network (no caching);
 *   - caches only the static shell (HTML/JS/CSS/icons) so the app launches fast
 *     and the interface still opens when briefly offline;
 *   - serves the cached shell for SPA navigations when the network is down.
 *
 * Bumping CACHE invalidates the old shell on activate.
 */
const CACHE = 'sech-lims-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => { /* best-effort precache */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin alone
  if (url.pathname.startsWith('/api')) return;      // API is always live, never cached

  // SPA navigations: try the network, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }

  // Static assets: serve from cache, revalidate in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fromNetwork = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fromNetwork;
    })
  );
});
