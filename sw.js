self.addEventListener('install', event => event.waitUntil(caches.open('cathprn-v2').then(cache => cache.addAll(['/','/index.html','/manifest.webmanifest']))));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))));
