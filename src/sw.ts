/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Android share sheet: WhatsApp > Export chat > share to this app posts the
// file here. Stash it in a cache and open the app, which picks it up.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || !url.pathname.endsWith('/share-target')) return;
  event.respondWith(
    (async () => {
      const form = await event.request.formData();
      const cache = await caches.open('share-target');
      const files = form.getAll('chat').filter((f): f is File => f instanceof File);
      let i = 0;
      for (const f of files) {
        await cache.put(
          new Request(`./shared/${Date.now()}-${i++}`),
          new Response(f, {
            headers: { 'content-type': f.type || 'text/plain', 'x-filename': encodeURIComponent(f.name) },
          }),
        );
      }
      const text = form.get('text');
      if (!files.length && typeof text === 'string' && text.trim()) {
        await cache.put(
          new Request(`./shared/${Date.now()}-text`),
          new Response(text, { headers: { 'content-type': 'text/plain', 'x-filename': 'shared.txt' } }),
        );
      }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).toString(), 303);
    })(),
  );
});

// Tapping a "digest ready" notification focuses the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (all.length) return all[0].focus();
      return self.clients.openWindow(self.registration.scope);
    })(),
  );
});
