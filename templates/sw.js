// MAMS Prediction Market service worker (rendered by app.py's /sw.js route).
//
// What it caches, and why so little:
// - Pages are never cached. They show live prices, your balance and one-time form tokens, so an old copy would be
//   wrong or would fail when you submit it. Pages always come from the network; if that fails you get /offline.
// - Static files (CSS, JS, icons) have the site version in their URL (?v=...), so they're cached forever and a
//   deploy simply asks for new URLs.
// - Google Fonts are reused from the cache and refreshed in the background.
// - Everything else (/api/quote, form posts, ...) goes straight to the network.
const VERSION = {{ version|tojson }};
const STATIC_CACHE = `mams-static-${VERSION}`;
const FONT_CACHE = 'mams-fonts';
const OFFLINE_URL = {{ offline_url|tojson }};
const PRECACHE = [OFFLINE_URL, ...{{ precache|tojson }}];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('mams-static-') && key !== STATIC_CACHE) await caches.delete(key);
    }
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return (await event.preloadResponse) || await fetch(req);
      } catch (err) {
        return (await caches.match(OFFLINE_URL)) || Response.error();
      }
    })());
    return;
  }

  if (url.origin === location.origin && url.pathname.startsWith('/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && url.searchParams.has('v')) cache.put(req, res.clone());  // only versioned URLs are safe to keep
      return res;
    })());
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req);
      const refresh = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })());
  }
});
