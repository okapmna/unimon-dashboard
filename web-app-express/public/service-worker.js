const CACHE_NAME = 'unimon-v3';
const ASSETS_TO_CACHE = [
  '/assets/css/style.css',
  '/assets/images/unimon-logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
