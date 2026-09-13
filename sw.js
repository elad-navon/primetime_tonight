const CACHE = 'primetime-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

/* מטרת ה‑Service Worker היא רק לאפשר התקנה כאפליקציה ולוח ריק כשאין רשת –
   נתוני השידורים עצמם תמיד נשלפים ישירות מה‑API של yes, בלי מטמון. */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if(url.origin !== location.origin){
    return; // בקשות ה‑API של yes תמיד יוצאות לרשת כרגיל
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
