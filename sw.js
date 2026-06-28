/* Service Worker — Plantinha da Vovó
   Estratégia: cache-first para assets estáticos, network-only para /api/.
   Suporta push notifications (lembretes de rega). */

const CACHE = 'pv-v1';
const PRECACHE = ['/', '/index.html', '/logo.png', '/logo_escuro.png', '/frame.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // API calls: sempre pela rede
  if (url.pathname.startsWith('/api/')) return;
  // Só cacheia requests GET do mesmo origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      });
    })
  );
});

/* ---------- PUSH NOTIFICATIONS (lembretes de rega) ---------- */
self.addEventListener('push', e => {
  const data = e.data ? e.data.json().catch(() => ({})) : {};
  const title = data.title || 'Plantinha da Vovó 🌱';
  const options = {
    body: data.body || 'Hora de cuidar das suas plantinhas! 💧',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'pv-reminder',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const win = list.find(c => c.url.includes(self.location.origin));
      if (win) { win.focus(); return win.navigate(target); }
      return clients.openWindow(target);
    })
  );
});
