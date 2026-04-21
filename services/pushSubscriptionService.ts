// services/pushSubscriptionService.ts
//
// Phase 5 Part A: client-side (PWA) push subscription orchestration.
//
// The mobile App.tsx calls `ensurePushSubscription()` after pairing
// succeeds. This function walks the full registration flow:
//
//   1. Fetch the VAPID public key from the PC via
//      GET /api/push/vapid-public-key.
//   2. Ask the browser for notification permission (user gesture
//      required on iOS). If denied, bail early — we never retry on a
//      "denied" response because that would pester the user every
//      launch.
//   3. Get the active service worker registration.
//   4. Either return the existing subscription (if still valid for the
//      same VAPID key) or call `pushManager.subscribe(...)` to create
//      a new one.
//   5. POST the resulting subscription to /api/push/subscribe so the
//      PC persists it and can send pushes later.
//
// The function is idempotent: safe to call on every mount. We also
// surface an `unsubscribe()` helper that revokes both the browser
// subscription AND tells the PC to stop sending pushes to this device.

import { getApiBaseUrl, isMobilePwa } from './environment';
import { HttpApiError } from './httpApi';

interface VapidResponse {
  ok: boolean;
  publicKey?: string;
  error?: string;
}

interface SubscribeResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

async function getVapidPublicKey(): Promise<string | null> {
  const base = getApiBaseUrl();
  try {
    const res = await fetch(`${base}/api/push/vapid-public-key`, {
      method: 'GET',
      credentials: 'include',
    });
    if (res.status === 401) {
      throw new HttpApiError('unauthorized', { code: 'E_AUTH', status: 401 });
    }
    if (!res.ok) return null;
    const body = await res.json() as VapidResponse;
    if (body.ok && typeof body.publicKey === 'string' && body.publicKey.length > 0) {
      return body.publicKey;
    }
    return null;
  } catch (e) {
    if (e instanceof HttpApiError) throw e;
    console.warn('[PUSH-CLIENT] fetch VAPID key failed:', (e as Error).message);
    return null;
  }
}

async function postSubscription(subscription: PushSubscription): Promise<boolean> {
  const base = getApiBaseUrl();
  const json = subscription.toJSON() as PushSubscriptionJSON & { keys?: Record<string, string> };
  try {
    const res = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys || {},
      }),
    });
    if (!res.ok) return false;
    const body = await res.json() as SubscribeResponse;
    return body.ok === true;
  } catch (e) {
    console.warn('[PUSH-CLIENT] POST subscribe failed:', (e as Error).message);
    return false;
  }
}

async function postUnsubscribe(endpoint: string): Promise<boolean> {
  const base = getApiBaseUrl();
  try {
    const res = await fetch(`${base}/api/push/unsubscribe`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[PUSH-CLIENT] POST unsubscribe failed:', (e as Error).message);
    return false;
  }
}

export interface EnsurePushSubscriptionResult {
  ok: boolean;
  reason?: 'not_mobile' | 'no_sw' | 'no_push_api' | 'permission_denied' | 'no_vapid' | 'subscribe_failed' | 'post_failed';
}

export async function ensurePushSubscription(): Promise<EnsurePushSubscriptionResult> {
  if (!isMobilePwa()) return { ok: false, reason: 'not_mobile' };
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return { ok: false, reason: 'no_sw' };
  }
  if (!('PushManager' in window)) {
    return { ok: false, reason: 'no_push_api' };
  }

  // Permission: on iOS Safari this MUST be invoked from a user gesture.
  // We assume the caller is running inside one (the pairing handler in
  // MobilePairingGate is, and the "enable notifications" button in
  // Settings is).
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'permission_denied' };
  }
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      return { ok: false, reason: 'permission_denied' };
    }
  }

  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch {
    return { ok: false, reason: 'no_sw' };
  }
  if (!registration) return { ok: false, reason: 'no_sw' };

  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return { ok: false, reason: 'no_vapid' };

  let sub = await registration.pushManager.getSubscription();
  if (sub) {
    // If the existing subscription was made against a different VAPID
    // key (e.g. user reinstalled the desktop and a new key pair was
    // generated), wipe it and re-subscribe so pushes we send today
    // actually reach the device.
    const existingKey = sub.options && sub.options.applicationServerKey;
    const existingKeyB64 = arrayBufferToBase64Url(existingKey);
    if (existingKeyB64 !== vapidKey) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
      sub = null;
    }
  }

  if (!sub) {
    try {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch (e) {
      console.warn('[PUSH-CLIENT] subscribe() rejected:', (e as Error).message);
      return { ok: false, reason: 'subscribe_failed' };
    }
  }

  const posted = await postSubscription(sub);
  if (!posted) return { ok: false, reason: 'post_failed' };
  return { ok: true };
}

export async function disablePushSubscription(): Promise<boolean> {
  if (!isMobilePwa()) return false;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;

  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch {
    return false;
  }
  if (!registration) return false;

  const sub = await registration.pushManager.getSubscription();
  if (!sub) return true; // already off — success is the happy path here.

  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch { /* ignore */ }
  await postUnsubscribe(endpoint);
  return true;
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
