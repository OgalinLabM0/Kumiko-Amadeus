/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST || []);

export {};

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Phase 5 Part A: Web Push ──────────────────────────────────────
//
// The desktop's push-notifications.cjs dispatches three payload shapes:
//
//   { type: 'message', title, body, tag, messageId, url, badgeIncrement }
//     → a chat message from Kumiko. Shown as a system notification with
//       the text preview. The `tag` collapses repeated pushes for the
//       same message id so rapid retries don't stack.
//
//   { type: 'badge', badgeCount: number }
//     → a silent badge update. The OS-level dot is refreshed without
//       a visible notification. Support varies (Safari iOS only
//       refreshes when the PWA is installed to home screen), so we
//       fall back to a silent-but-visible notification on browsers
//       that don't support `setAppBadge`.
//
//   { type: 'call', title, body, tag, url }  [Phase 5 Part D]
//     → an incoming reminder call. Rendered with `requireInteraction`
//       so the banner doesn't auto-dismiss before the user sees it,
//       which is especially important when the phone is locked. Tap
//       opens the PWA and the in-app VoiceCallOverlay (mirrored from
//       the PC via WS) renders the full-screen UI with answer/reject
//       buttons. We don't add reply/dismiss actions here because iOS
//       silently drops them for installed PWAs and Android would route
//       them back through the PWA anyway.
//
// Anything else we receive is treated as a generic "something happened"
// notification, because Chrome will kill the service worker in a few
// seconds if `showNotification` isn't called at all, and the user
// notices the enforcement-abuse warning sooner or later.
interface PushMessagePayload {
  type?: 'message' | 'badge' | 'call';
  title?: string;
  body?: string;
  tag?: string;
  messageId?: string;
  url?: string;
  badgeIncrement?: number;
  badgeCount?: number;
}

self.addEventListener('push', (event) => {
  let data: PushMessagePayload = {};
  try {
    if (event.data) {
      data = event.data.json() as PushMessagePayload;
    }
  } catch (e) {
    console.warn('[SW] Could not parse push data', e);
  }

  event.waitUntil((async () => {
    if (data.type === 'badge') {
      const count = typeof data.badgeCount === 'number' ? data.badgeCount : 0;
      // Prefer native badge APIs when available (Android Chrome ≥ 81,
      // desktop Edge/Chrome, iOS 16.4+ installed PWA). `setAppBadge`
      // may reject if the permission is missing; we don't want to
      // surface a visible notification in that case either.
      const nav = (self as unknown as { navigator?: Navigator }).navigator;
      const nativeBadge = (nav as Navigator & {
        setAppBadge?: (count?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      }) || null;
      if (nativeBadge && typeof nativeBadge.setAppBadge === 'function') {
        try {
          if (count === 0) {
            await (nativeBadge.clearAppBadge ? nativeBadge.clearAppBadge() : nativeBadge.setAppBadge(0));
          } else {
            await nativeBadge.setAppBadge(count);
          }
        } catch {
          // Badge API rejected (permission, OS constraint). Swallow —
          // we don't want to turn every missed badge into a toast.
        }
      }
      return;
    }

    const title = typeof data.title === 'string' && data.title.length > 0
      ? data.title
      : 'Kumiko·Amadeus';
    const body = typeof data.body === 'string' && data.body.length > 0
      ? data.body
      : '有新消息';

    // `renotify` is widely supported at runtime (Chrome/Edge/Firefox/
    // Android) but the TypeScript lib.webworker definitions still omit
    // it. Cast through a loose option shape to keep the feature while
    // silencing the static check. The 'call' variant also needs
    // `requireInteraction` so the banner sticks around long enough
    // for the user to see it on a locked phone.
    const isCall = data.type === 'call';
    const options: NotificationOptions & { renotify?: boolean; requireInteraction?: boolean; vibrate?: number[] } = {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: typeof data.tag === 'string' ? data.tag : 'kumiko-default',
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [400, 200, 400, 200, 400] : undefined,
      data: {
        url: typeof data.url === 'string' ? data.url : '/',
        messageId: data.messageId,
        callIncoming: isCall,
      },
    };
    await self.registration.showNotification(title, options);

    // Bump OS badge by the increment hint. We don't know the current
    // count here so this is best-effort — iOS will reconcile when the
    // PWA next runs setAppBadge from its own runtime.
    const inc = typeof data.badgeIncrement === 'number' ? data.badgeIncrement : 0;
    if (inc > 0) {
      const nav = (self as unknown as { navigator?: Navigator }).navigator;
      const nativeBadge = (nav as Navigator & {
        setAppBadge?: (count?: number) => Promise<void>;
      }) || null;
      if (nativeBadge && typeof nativeBadge.setAppBadge === 'function') {
        try { await nativeBadge.setAppBadge(); } catch { /* ignore */ }
      }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data;
  const target = raw && typeof raw.url === 'string' ? raw.url : '/';
  const targetUrl = new URL(target, self.location.origin).href;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      // Focus any window whose origin matches. Using startsWith avoids
      // a strict path match so deep links still land on an already-open
      // app without reopening.
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        try {
          await (client as WindowClient).focus();
          if ('navigate' in client && typeof (client as WindowClient).navigate === 'function') {
            try { await (client as WindowClient).navigate(targetUrl); } catch { /* ignore */ }
          }
          return;
        } catch { /* ignore, fall through to openWindow */ }
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
