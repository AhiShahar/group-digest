/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { deriveKeys, open } from './lib/syncCrypto';

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

// Event reminders sent by the push server (worker/push.ts), and live-sync
// notices (scheduled digest ready, server alerts). A notice from the sync
// server arrives sealed; open it with the room key kept in IndexedDB, so the
// relay never sees what it says.
type PushData = { title?: string; body?: string; tag?: string; room?: string; sealed?: string };

function readPairing(): Promise<{ room: string; secret: string } | undefined> {
  return new Promise((resolve) => {
    const req = indexedDB.open('group-digest');
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      try {
        const get = req.result.transaction('kv').objectStore('kv').get('liveSync');
        get.onsuccess = () => resolve(get.result as { room: string; secret: string } | undefined);
        get.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    };
  });
}

async function showPush(data: PushData) {
  let { title, body } = data;
  if (data.sealed) {
    const p = await readPairing();
    try {
      if (!p || p.room !== data.room) throw new Error('not ours');
      const n = await open<{ title: string; body: string }>(await deriveKeys(p.room, p.secret), 'notice', data.sealed);
      ({ title, body } = n);
    } catch {
      title = 'Group Digest';
      body = 'Something new from your sync server. Open the app to see it.';
    }
  }
  await self.registration.showNotification(title || 'Group Digest', {
    body: body ?? '',
    tag: data.tag,
    icon: './pwa-192x192.png',
    badge: './pwa-64x64.png',
  });
}

self.addEventListener('push', (event) => {
  let data: PushData = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(showPush(data));
});

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
