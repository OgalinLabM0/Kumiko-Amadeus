/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST || []);

export {};

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // 1. Receive the empty ping from the "Dumb Server"
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    console.warn("Could not parse push data", e);
  }

  // 2. We use event.waitUntil to keep the Service Worker alive while we do our Async tasks!
  event.waitUntil(
    (async () => {
      // PROTOTYPE: Instead of just showing a static message, 
      // in the real implementation here we will:
      // a) Open Dexie DB (db.ts) and read conversation history & AI Keys
      // b) Make a fetch request directly to Gemini API
      // c) Catch the response and use it as `notificationBody`
      
      const notificationTitle = 'Kumiko Amadeus';
      const notificationBody = '这是一个测试的本地 AI 唤醒消息！由于现在还在原型阶段，以后这里的话会是由 Gemini 本地生成的。';

      // 3. Show the notification
      await self.registration.showNotification(notificationTitle, {
        body: notificationBody,
        icon: '/icon-192.png',
        badge: '/icon-192.png', // Small icon for Android status bar
        data: {
          url: '/' // When clicked, open the root path
        }
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Open the app when notification is clicked
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it
      for (const client of clientList) {
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
