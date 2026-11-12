// Offline support: the app shell is cached so the app opens at the gym without signal.
// Pages are fetched fresh when online (so updates arrive) and fall back to the cache offline.
const CACHE = 'coach-v15';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !isFont) return; // the sheet and the Claude API always go to the network
  if (sameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'))) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); }
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
// Tapping the rest-over notification brings Coach back to the front (or opens it).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow ? self.clients.openWindow('./') : null;
  }));
});
// Rest alerts sent by the Cloudflare Worker (push/). Every push must show a notification.
// Two kinds share one tag: "resting" arrives as he ticks a set (quiet), "over" replaces it when the rest ends.
// The old one is closed first as well, in case the phone doesn't replace by tag on its own.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = {}; }
  const tag = d.tag || 'coach-rest'; const resting = d.kind === 'resting';
  e.waitUntil((async () => {
    try { const old = await self.registration.getNotifications({ tag }); old.forEach(n => n.close()); } catch (er) {}
    await self.registration.showNotification(d.title || 'Rest over', {
      body: d.body || 'Time for your next set.', tag, renotify: !resting, silent: resting,
      icon: 'icon-192.png', badge: 'icon-192.png', ...(resting ? {} : { vibrate: [200, 100, 200] }),
    });
  })());
});
