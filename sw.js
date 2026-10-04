const CACHE = 'git-wordpad-shell-v4';
const FILES = ['./','./index.html','./styles.css','./manifest.webmanifest','./icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./js/app.js','./js/auth.js','./js/config.js','./js/html.js','./js/storage.js','./js/github.js','./js/images.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  // Deliberately no skipWaiting: never replace a running editor mid-session.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('git-wordpad-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  // Cache ONLY the application shell. No tokens, API replies, HTML documents or private images.
  const path = url.href.slice(self.registration.scope.length).split('?')[0];
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.match(new URL('./index.html',self.registration.scope)).then(response => response || fetch(event.request)));
  } else if (FILES.includes('./'+path)) {
    event.respondWith(caches.match(event.request,{ignoreSearch:true}).then(response => response || fetch(event.request)));
  }
});
