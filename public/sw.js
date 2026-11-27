// JK2M Repuestos — service worker: permite instalar la tienda y muestra una
// página propia si no hay conexión. Siempre pide primero a la red (así nunca
// se queda con una versión vieja); la copia guardada solo se usa sin internet.
const CACHE = 'jk2m-v20261127a';
const BASICOS = ['offline.html', 'logo-jk2m.png', 'icon-192.png', 'favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== location.origin) return;   // Supabase y CDNs: directo a la red
  e.respondWith(
    fetch(req).then(res => {
      if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('offline.html') : Response.error())))
  );
});
