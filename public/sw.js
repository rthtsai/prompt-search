const CACHE='prompt-dictionary-shell-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/offline.html','/icon.svg'])));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('prompt-dictionary-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  // Never cache private API responses or prompt bodies in the service worker.
  if(event.request.mode==='navigate') event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')));
});
