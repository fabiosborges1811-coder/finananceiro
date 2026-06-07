const CACHE_NAME = "capita-v2";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
