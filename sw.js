/* myRepairTools service worker.
 *
 * WHY: installed home-screen apps (iOS especially) cling to their HTTP cache
 * and revalidate on their own schedule — owners saw week-old pages until they
 * deleted and re-added the app. This SW is NETWORK-FIRST: every request goes
 * to the live site (navigations force revalidation), and the cache is used
 * ONLY as an offline fallback. Normal deploys need no changes here — content
 * flows through automatically. Bump VERSION only to garbage-collect the old
 * cache bucket after big structural changes.
 *
 * This is also the future home of push (self.addEventListener('push', …))
 * for the notifications project.
 */
const VERSION = 'mrt-v1';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // Supabase / fonts / CDNs untouched

  e.respondWith((async () => {
    try {
      // navigations revalidate with the server every time (304s are cheap);
      // assets ride the normal HTTP cache window
      const fresh = await fetch(req, req.mode === 'navigate' ? { cache: 'no-cache' } : undefined);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
