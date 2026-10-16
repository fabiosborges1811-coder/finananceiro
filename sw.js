const CACHE_NAME = 'capita-v3';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key =>
            key.startsWith('capita-') && key !== CACHE_NAME
          )
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Não guarda consultas ao Supabase ou recursos externos.
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !['document', 'style', 'script', 'image', 'manifest']
      .includes(request.destination)
  ) {
    return;
  }

  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then(response => {
        if (response.ok) {
          const copy = response.clone();

          event.waitUntil(
            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, copy))
              .catch(() => {})
          );
        }

        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const saved = await cache.match(request);

        return saved || Response.error();
      })
  );
});
