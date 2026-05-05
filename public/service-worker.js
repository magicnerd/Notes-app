const CACHE_NAME = 'notes-performance-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/helper.html',
  '/style.css',
  '/helper.css',
  '/performer.js',
  '/helper.js',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.url.includes('/ws')) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
