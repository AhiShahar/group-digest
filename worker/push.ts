// Web push reminders for the website version of Group Digest.
//
// The app subscribes to push in the browser and sends its reminders here:
// only the event title, a short "when" line and the times to remind. No chat
// content is stored. Each browser subscription gets its own Durable Object
// (SQLite-backed, free plan), which keeps its reminders and wakes itself with
// a Durable Object alarm when the next one is due, then sends a Web Push
// message (RFC 8030) encrypted for that browser (RFC 8291) and signed with
// VAPID (RFC 8292). The VAPID key pair is created on first use and kept in
// one more Durable Object, so there is nothing to configure.
//
//   GET  /api/push/key                         VAPID public key
//   POST /api/push/sync   {sub, add?, cancel?} add reminders and/or cancel by id prefix; returns ids
//   POST /api/push/unsubscribe {sub}           forget this browser
//   POST /api/push/test   {sub}                send one test notification now
//
// `sub` is the browser's PushSubscription JSON: {endpoint, keys: {p256dh, auth}}.
// A subscription's Durable Object only accepts calls that carry its own keys.

import { DurableObject } from 'cloudflare:workers';

export interface PushEnv {
  PUSH: DurableObjectNamespace<PushBox>;
}

interface Sub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Reminder {
  id: string;
  at: number;
  title: string;
  body: string;
}

const MAX_REMINDERS = 300;
const KEYS_ROOM = '__vapid__';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
}

// ---------- base64url ----------

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ---------- validation ----------

function asSub(v: unknown): Sub | null {
  const s = v as Sub;
  try {
    const u = new URL(s.endpoint);
    if (u.protocol !== 'https:' && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return null;
    if (s.endpoint.length > 1000) return null;
    if (unb64u(s.keys.p256dh).length !== 65 || unb64u(s.keys.auth).length !== 16) return null;
    return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
  } catch {
    return null;
  }
}

function asReminders(v: unknown): Reminder[] {
  if (!Array.isArray(v)) return [];
  const now = Date.now();
  const out: Reminder[] = [];
  for (const r of v.slice(0, MAX_REMINDERS)) {
    if (!r || typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.body !== 'string' || typeof r.at !== 'number') continue;
    if (r.at < now - 60_000 || r.at > now + 400 * 864e5) continue;
    out.push({ id: r.id.slice(0, 300), at: Math.round(r.at), title: r.title.slice(0, 120), body: r.body.slice(0, 200) });
  }
  return out;
}

async function subId(endpoint: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(endpoint)));
  return b64u(d.slice(0, 18));
}

// ---------- router ----------

export async function handlePush(req: Request, env: PushEnv, path: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (path === 'key' && req.method === 'GET') {
    const pub = await env.PUSH.get(env.PUSH.idFromName(KEYS_ROOM)).publicKey();
    return json({ publicKey: pub });
  }
  if (req.method !== 'POST' || !['sync', 'unsubscribe', 'test'].includes(path)) return json({ error: 'not found' }, 404);
  if (Number(req.headers.get('content-length') ?? 0) > 200_000) return json({ error: 'too large' }, 413);
  let body: { sub?: unknown; add?: unknown; cancel?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad body' }, 400);
  }
  const sub = asSub(body.sub);
  if (!sub) return json({ error: 'bad subscription' }, 400);
  const box = env.PUSH.get(env.PUSH.idFromName(await subId(sub.endpoint)));
  const origin = new URL(req.url).origin;
  if (path === 'unsubscribe') {
    await box.forget(sub);
    return json({ ok: true });
  }
  if (path === 'test') {
    const r = await box.test(sub, origin);
    return json(r, r.ok ? 200 : 502);
  }
  const cancel = Array.isArray(body.cancel) ? body.cancel.filter((x): x is string => typeof x === 'string').slice(0, 100) : [];
  const r = await box.sync(sub, origin, asReminders(body.add), cancel);
  return json(r, r.ok ? 200 : 403);
}

// ---------- the Durable Object ----------

type Stored = { sub: Sub; origin: string };

export class PushBox extends DurableObject<PushEnv> {
  // --- VAPID keys (only used on the KEYS_ROOM instance) ---

  async publicKey(): Promise<string> {
    return (await this.vapid()).pub;
  }

  async vapid(): Promise<{ pub: string; jwk: JsonWebKey }> {
    const have = await this.ctx.storage.get<{ pub: string; jwk: JsonWebKey }>('vapid');
    if (have) return have;
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
    const v = { pub: b64u(raw), jwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey };
    await this.ctx.storage.put('vapid', v);
    return v;
  }

  // --- one browser subscription ---

  /** True when no subscription is stored yet, or the caller holds the stored one's keys. */
  private async allowed(sub: Sub): Promise<boolean> {
    const st = await this.ctx.storage.get<Stored>('sub');
    return !st || (st.sub.endpoint === sub.endpoint && st.sub.keys.auth === sub.keys.auth);
  }

  async sync(sub: Sub, origin: string, add: Reminder[], cancel: string[]): Promise<{ ok: boolean; ids?: string[] }> {
    if (!(await this.allowed(sub))) return { ok: false };
    await this.ctx.storage.put('sub', { sub, origin } satisfies Stored);
    let list = ((await this.ctx.storage.get<Reminder[]>('reminders')) ?? []).filter((r) => r.at > Date.now() - 60_000);
    if (cancel.length) list = list.filter((r) => !cancel.some((p) => r.id.startsWith(p)));
    const ids = new Set(add.map((r) => r.id));
    list = [...list.filter((r) => !ids.has(r.id)), ...add].sort((a, b) => a.at - b.at).slice(0, MAX_REMINDERS);
    await this.ctx.storage.put('reminders', list);
    await this.arm(list);
    return { ok: true, ids: list.map((r) => r.id) };
  }

  async forget(sub: Sub): Promise<void> {
    if (!(await this.allowed(sub))) return;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async test(sub: Sub, origin: string): Promise<{ ok: boolean; status?: number }> {
    if (!(await this.allowed(sub))) return { ok: false };
    const status = await this.send({ sub, origin }, { id: 'test', at: Date.now(), title: 'Group Digest', body: 'Notifications are on. Reminders will look like this.' });
    return { ok: status >= 200 && status < 300, status };
  }

  private async arm(list: Reminder[]): Promise<void> {
    if (list.length) await this.ctx.storage.setAlarm(Math.max(list[0].at, Date.now() + 1000));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const st = await this.ctx.storage.get<Stored>('sub');
    const list = (await this.ctx.storage.get<Reminder[]>('reminders')) ?? [];
    if (!st) return;
    const now = Date.now();
    const due = list.filter((r) => r.at <= now + 5_000);
    let rest = list.filter((r) => r.at > now + 5_000);
    for (const r of due) {
      // Skip reminders that are badly late (the phone may have been off the network for hours).
      if (r.at < now - 6 * 3600_000) continue;
      const status = await this.send(st, r);
      if (status === 404 || status === 410) {
        // The browser unsubscribed or the subscription expired: forget it.
        await this.ctx.storage.deleteAll();
        return;
      }
      if (status === 429 || status >= 500) rest.push({ ...r, at: now + 5 * 60_000 }); // try again in 5 minutes
    }
    rest = rest.sort((a, b) => a.at - b.at);
    await this.ctx.storage.put('reminders', rest);
    await this.arm(rest);
  }

  private async send(st: Stored, r: Reminder): Promise<number> {
    const keys = await this.env.PUSH.get(this.env.PUSH.idFromName(KEYS_ROOM)).vapid();
    const payload = JSON.stringify({ title: r.title, body: r.body, tag: r.id.split('#')[0] });
    const bodyBytes = await encryptPayload(st.sub, enc.encode(payload));
    const jwt = await vapidJwt(keys.jwk, new URL(st.sub.endpoint).origin, st.origin);
    try {
      const res = await fetch(st.sub.endpoint, {
        method: 'POST',
        headers: {
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(6 * 3600),
          urgency: 'high',
          topic: b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(r.id))).slice(0, 24)),
          authorization: `vapid t=${jwt}, k=${keys.pub}`,
        },
        body: bodyBytes,
      });
      return res.status;
    } catch {
      return 503;
    }
  }
}

// ---------- RFC 8292 VAPID ----------

export async function vapidJwt(jwk: JsonWebKey, audience: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64u(sig)}`;
}

// ---------- RFC 8291 message encryption (aes128gcm) ----------

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF with a single expand block (all outputs here are 32 bytes or less). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

export async function encryptPayload(sub: Sub, plaintext: Uint8Array, fixed?: { salt: Uint8Array; pair: CryptoKeyPair }): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const pair = fixed?.pair ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0], pair.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(plaintext, new Uint8Array([2])); // 0x02: last record, no padding
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}
