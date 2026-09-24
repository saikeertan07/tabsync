// Minimal Service Worker to enable PWA installability on Android Chrome / Samsung Internet
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Pass-through to network for real-time WebSocket sync
  e.respondWith(fetch(e.request).catch(() => new Response('Offline')));
});
