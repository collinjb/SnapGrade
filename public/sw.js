/* SnapGrade service worker.
 *
 * Its whole job is making the installed app open instantly and survive a dead
 * network: the shell is cached, grading calls are not. A scan taken offline
 * is already handled above this layer — it sits in the app's own pending
 * queue — so the worker must never serve a stale or fabricated API response.
 */
const VERSION = 'v1';
const SHELL = `snapgrade-shell-${VERSION}`;
const ASSETS = `snapgrade-assets-${VERSION}`;

/* Enough to boot offline; everything else is cached as it is requested. */
const PRECACHE = ['./', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      // A missing precache entry must not wedge the install.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('snapgrade-') && key !== SHELL && key !== ASSETS)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Never touch anything that is not ours: Supabase, the Anthropic proxy,
     the KaTeX CDN. A cached grade would be worse than no grade. */
  if (url.origin !== self.location.origin) return;

  /* Navigations: network first so a deploy is picked up, cache as the
     offline fallback. A SPA has one real document, so any navigation
     falls back to it. */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL).then((cache) => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  /* Static assets: serve from cache immediately, refresh in the background.
     Expo fingerprints its bundles, so a stale hit is never the wrong file. */
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(ASSETS).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    }),
  );
});
