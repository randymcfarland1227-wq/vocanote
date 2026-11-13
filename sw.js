// Offline support: try the network first so updates always arrive, fall back to the last saved copy.
const CACHE = 'vocanote-1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'styles.css?v=5', 'js/app.js?v=5', 'js/parse.js?v=5', 'js/audio.js?v=5']).catch(() => {}))); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || !r.url.startsWith('http')) return;
  e.respondWith(fetch(r).then(res => { if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; }).catch(() => caches.match(r, { ignoreSearch: r.mode === 'navigate' }).then(m => m || Response.error())));
});
