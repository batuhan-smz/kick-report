// Kick Report service worker
// Amaç: uygulama kabuğunu (HTML/JS/CSS/ikonlar) önbellekte tutup bağlantı yokken de açılabilmek.
// Her zaman önce ağ denenir; böylece yeni sürüm yayınlanınca kullanıcı hemen onu görür.
// API istekleri, Kick videoları ve başka sitelerden gelen dosyalar önbelleğe alınmaz.

const CACHE = 'kick-report-v1';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/offline.html', '/icons/icon-192.png', '/icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Kick, hls.js CDN vb.
  if (url.pathname.startsWith('/api/')) return;              // canlı veri
  if (url.pathname.startsWith('/.well-known/')) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        // /players/... gibi sayfa adresleri hep aynı index.html; tek kopya yeter
        const key = req.mode === 'navigate' ? '/' : req;
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    } catch {
      const cache = await caches.open(CACHE);
      if (req.mode === 'navigate') return (await cache.match('/')) || (await cache.match('/offline.html'));
      return (await cache.match(req)) || Response.error();
    }
  })());
});
