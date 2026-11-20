// Web push reminders for the website (the Android app uses its own alarms).
// The browser subscribes to push; reminders go to this site's Worker
// (worker/push.ts), which sends each one at its time. Only the event title and
// a short "when" line leave the device; event ids are hashed first, so the
// group name is not sent either.

import { isAndroidApp } from './android';
import type { ScheduledReminder } from './reminders';

const API = './api/push/';
const MIRROR = 'push-reminders'; // localStorage: [{id, at}] of reminders sent to the server

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () =>
  (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

/** Push works in this browser (on iPhone only once the app is on the Home Screen). */
export const pushSupported = () => !isAndroidApp && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhone Safari in a normal tab: push needs Add to Home Screen first (iOS 16.4 or newer). */
export const pushNeedsHomeScreen = () => !isAndroidApp && isIos() && !standalone();

/** Short, stable, non-reversible-at-a-glance id for an event key (FNV-1a, 64-bit as two halves). */
export function hashKey(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

type Mirror = { id: string; at: number }[];
function readMirror(): Mirror {
  try {
    return ((JSON.parse(localStorage.getItem(MIRROR) ?? '[]') as Mirror) ?? []).filter((r) => r.at > Date.now());
  } catch {
    return [];
  }
}
function writeMirror(m: Mirror) {
  try {
    localStorage.setItem(MIRROR, JSON.stringify(m));
  } catch {
    /* private mode */
  }
}

/** Hashed event ids that have reminders waiting on the server. */
export function pushScheduledHashes(): Set<string> {
  return new Set(readMirror().map((r) => r.id.split('#')[0]));
}

let keyPromise: Promise<string> | null = null;
function serverKey(): Promise<string> {
  keyPromise ??= fetch(API + 'key')
    .then((r) => {
      if (!r.ok) throw new Error('The reminder service is not available right now.');
      return r.json() as Promise<{ publicKey: string }>;
    })
    .then((j) => j.publicKey)
    .catch((e) => {
      keyPromise = null;
      throw e;
    });
  return keyPromise;
}

/** Fetch the server key early, so the permission prompt can follow a tap without waiting. */
export function prefetchPushKey(): void {
  if (pushSupported()) serverKey().catch(() => {});
}

function toBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask for permission (call from a tap) and subscribe. */
export async function enablePush(): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error(pushNeedsHomeScreen() ? 'Add Nutshell to your Home Screen first.' : 'This browser cannot show reminders.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your browser settings.');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(await serverKey()) });
}

async function call(path: string, body: unknown): Promise<{ ok?: boolean; ids?: string[] }> {
  const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; ids?: string[] };
  if (!res.ok) throw new Error(`The reminder service said no (${res.status}).`);
  return j;
}

/** Sends reminders (ids are eventKey#minutes) and cancels the given event keys first. */
export async function pushSchedule(reminders: ScheduledReminder[], cancelKeys: string[]): Promise<number> {
  const sub = await enablePush();
  const add = reminders.map((r) => {
    const cut = r.id.lastIndexOf('#');
    const key = r.id.slice(0, cut);
    const m = r.id.slice(cut + 1);
    return { id: `${hashKey(key)}#${m}`, at: r.at, title: r.title, body: r.body };
  });
  const res = await call('sync', { sub: sub.toJSON(), add, cancel: cancelKeys.map((k) => hashKey(k) + '#') });
  const mine = new Set(res.ids ?? []);
  writeMirror([...readMirror().filter((r) => mine.has(r.id) && !add.some((a) => a.id === r.id)), ...add.map(({ id, at }) => ({ id, at }))]);
  return add.length;
}

export async function pushCancel(key: string): Promise<void> {
  const sub = await currentSubscription();
  const prefix = hashKey(key) + '#';
  writeMirror(readMirror().filter((r) => !r.id.startsWith(prefix)));
  if (sub) await call('sync', { sub: sub.toJSON(), cancel: [prefix] });
}

export async function pushTest(): Promise<void> {
  const sub = await enablePush();
  await call('test', { sub: sub.toJSON() });
}

/** Turn reminders off on this device: forget them on the server and drop the subscription. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  writeMirror([]);
  if (!sub) return;
  await call('unsubscribe', { sub: sub.toJSON() }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
