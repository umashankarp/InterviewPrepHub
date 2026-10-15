/* Offline support. The shell is precached; everything else (Next.js chunks, topic data, fonts) is cached
   on first use, so anything you have opened once works offline afterwards.
   Pages use network-first: a stale cached page could reference build chunks that no longer exist after a
   deploy. Static assets are content-hashed (and topic data is ?v= versioned), so they use stale-while-revalidate.
   Bump VERSION when this file's behaviour changes. */
const VERSION = 'iq-next-v2';
const SCOPE = self.registration.scope;
const SHELL = ['', 'manifest.webmanifest', 'icon.svg'].map(p => new URL(p, SCOPE).href);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  if (req.mode === 'navigate') {
    e.respondWith(caches.open(VERSION).then(async cache => {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req)) || (await cache.match(SHELL[0])) || Response.error();
      }
    }));
    return;
  }

  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req);
    const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || net;
  }));
});
