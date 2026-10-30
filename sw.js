/* Under 200KB service worker
 * v3 — network-first for pages so existing installs pick up UI changes,
 * stale-while-revalidate for the app shell, and runtime caching for the
 * self-hosted PDF libraries. The tool's processing stays entirely local.
 */
const CACHE_VERSION = 'u200kb-v3';
const CORE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/analytics.js',
  '/manifest.json',
  '/fonts/inter-400.woff2',
  '/fonts/inter-600.woff2',
  '/fonts/space-mono-700.woff2',
  '/ushcodex-logo.svg',
  '/ushcodex-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const CACHE_PREFIX = 'u200kb-';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Cache each file independently: one miss must not block the install.
    await Promise.all(CORE.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response && response.ok) await cache.put(url, response);
      } catch (error) { /* offline during install: keep what we can */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isAnalytics(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/_vercel/');
}

function isVendor(url) {
  return url.pathname.startsWith('/vendor/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }

  // Analytics and API traffic is never cached.
  if (url.origin === self.location.origin && isAnalytics(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put('/index.html', fresh.clone());
        }
        return fresh;
      } catch (error) {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('/index.html')) || (await cache.match('/')) ||
          new Response('<h1>Offline</h1><p>Reconnect once to reload Under 200KB.</p>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            status: 200
          });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);

    const network = fetch(request).then((response) => {
      if (response && response.ok && (response.type === 'basic' || response.type === 'default')) {
        cache.put(request, response.clone());
      }
      return response;
    }).catch(() => null);

    if (cached) {
      // Serve fast, refresh in the background.
      event.waitUntil(network.then(() => undefined));
      return cached;
    }

    const fresh = await network;
    if (fresh) return fresh;

    if (isVendor(url)) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
    return new Response('', { status: 504, statusText: 'Offline' });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
