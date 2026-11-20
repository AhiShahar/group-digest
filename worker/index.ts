// Cloudflare Worker: serves the web app (static assets) and a small relay for
// live WhatsApp sync under /api/sync/<room>/...
//
// The relay is a mailbox between the sync server (which links to WhatsApp) and
// the app. Everything stored here is encrypted end to end with a secret that
// only the app and the sync server know, so this Worker cannot read messages.
// Each room is one Durable Object (SQLite-backed, available on the free plan).
//
//   PUT  /state     sync server -> app   status, QR code, group list (one blob)
//   GET  /state
//   PUT  /config    app -> sync server   chosen groups (one blob)
//   GET  /config
//   POST /messages  sync server -> app   a batch of new messages (blob)
//   GET  /messages?after=<seq>           batches after seq, oldest first
//   POST /ack       {"upTo": seq}        delete delivered batches
//   POST /reset                          wipe the room (unlink)
//
// Notices (scheduled digests ready, health alerts): the sync server posts a
// small sealed note; the Worker keeps the last few and sends each one by Web
// Push to the phones that asked for it. The push carries only the sealed
// note, which the app's service worker opens with the room key.
//   PUT  /push        {sub, offline?}  this phone wants notices (offline: also server-offline alerts)
//   POST /push-remove {endpoint}
//   POST /notice      {blob, tag?}     sync server -> phones
//   GET  /notices?after=<seq>
//
// Host inbox (a sync server that hosts friends): anyone who has the inbox id
// from an invite link may drop a small sealed note (join request, "my config
// changed"); only the server can read and clear it.
//   POST /inbox      no auth, body {"blob": ...} <= 4 KB, at most 500 waiting
//   GET  /inbox?after=<seq>
//   POST /inbox-ack  {"upTo": seq}
//
// Auth: "Authorization: Bearer <token>". The room remembers the SHA-256 of the
// first token it sees and refuses any other. Room ids are 128-bit random.

import { DurableObject } from 'cloudflare:workers';
import { asSub, handlePush, PushBox, sendPush, type PushEnv, type Stored } from './push';

export { PushBox };

interface Env extends PushEnv {
  ASSETS: Fetcher;
  SYNC: DurableObjectNamespace<SyncRoom>;
}

const MAX_BLOB = 256 * 1024; // bytes of base64 text per request
const KEEP_MS = 7 * 864e5; // undelivered batches are dropped after 7 days
const MAX_BATCHES = 2000;
const MAX_NOTE = 4096; // inbox notes
const MAX_NOTES = 500;
const MAX_NOTICE = 2800; // sealed notice, so the push payload stays under 4 KB
const KEEP_NOTICES = 30;
const NOTICES_PER_DAY = 40;
const MAX_SUBS = 5;

export interface RoomSub extends Stored {
  offline: boolean;
  at: number;
}

export interface Notice {
  seq: number;
  at: number;
  tag: string;
  blob?: string; // sealed by the sync server
  title?: string; // plain alerts written by the Worker itself
  body?: string;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/api\/sync\/([a-f0-9]{32})\/(state|config|messages|ack|reset|inbox|inbox-ack|push|push-remove|notice|notices)$/.exec(url.pathname);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const push = /^\/api\/push\/([a-z]+)$/.exec(url.pathname);
    if (push) return handlePush(req, env, push[1]);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!m) return json({ error: 'not found' }, 404);
    if (m[2] === 'inbox' && req.method === 'POST') {
      const body = await req.text();
      if (body.length > MAX_NOTE + 64) return json({ error: 'too large' }, 413);
      const room = env.SYNC.get(env.SYNC.idFromName(m[1]));
      const res = (await room.drop(body)) as unknown as Result;
      return json(res.body, res.status);
    }
    const token = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return json({ error: 'missing token' }, 401);
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_BLOB + 1024) return json({ error: 'too large' }, 413);
    const room = env.SYNC.get(env.SYNC.idFromName(m[1]));
    const body = req.method === 'GET' ? '' : await req.text();
    if (body.length > MAX_BLOB + 1024) return json({ error: 'too large' }, 413);
    const res = (await room.handle(await sha256(token), req.method, m[2], url.searchParams.get('after'), body, url.origin, m[1])) as unknown as Result;
    return json(res.body, res.status);
  },
} satisfies ExportedHandler<Env>;

type Result = { status: number; body: unknown };

export class SyncRoom extends DurableObject<Env> {
  async handle(tokenHash: string, method: string, op: string, after: string | null, body: string, origin = '', room = ''): Promise<Result> {
    const s = this.ctx.storage;
    this.room = room;
    const known = await s.get<string>('auth');
    if (!known) await s.put('auth', tokenHash);
    else if (!sameString(known, tokenHash)) return { status: 403, body: { error: 'wrong token' } };

    const blobOf = (): string | null => {
      try {
        const v = (JSON.parse(body) as { blob?: unknown }).blob;
        return typeof v === 'string' && v.length <= MAX_BLOB ? v : null;
      } catch {
        return null;
      }
    };

    if ((op === 'state' || op === 'config') && method === 'GET') {
      const v = await s.get<{ blob: string; at: number }>(op);
      return { status: 200, body: v ?? { blob: null, at: 0 } };
    }
    if ((op === 'state' || op === 'config') && method === 'PUT') {
      const blob = blobOf();
      if (!blob) return { status: 400, body: { error: 'bad body' } };
      await s.put(op, { blob, at: Date.now() });
      return { status: 200, body: { ok: true } };
    }
    if (op === 'messages' && method === 'POST') {
      const blob = blobOf();
      if (!blob) return { status: 400, body: { error: 'bad body' } };
      const seq = ((await s.get<number>('seq')) ?? 0) + 1;
      await s.put({ seq, [`m:${String(seq).padStart(12, '0')}`]: { blob, at: Date.now() } });
      await this.prune();
      return { status: 200, body: { seq } };
    }
    if (op === 'messages' && method === 'GET') {
      const from = Math.max(0, Number(after) || 0);
      const rows = await s.list<{ blob: string; at: number }>({ prefix: 'm:', start: `m:${String(from + 1).padStart(12, '0')}`, limit: 100 });
      const batches = [...rows].map(([k, v]) => ({ seq: Number(k.slice(2)), blob: v.blob, at: v.at }));
      return { status: 200, body: { batches, seq: (await s.get<number>('seq')) ?? 0 } };
    }
    if (op === 'ack' && method === 'POST') {
      let upTo = 0;
      try {
        upTo = Number((JSON.parse(body) as { upTo?: unknown }).upTo) || 0;
      } catch {
        /* ignore */
      }
      const rows = await s.list({ prefix: 'm:', end: `m:${String(upTo + 1).padStart(12, '0')}` });
      if (rows.size) await s.delete([...rows.keys()]);
      return { status: 200, body: { deleted: rows.size } };
    }
    if (op === 'inbox' && method === 'GET') {
      const from = Math.max(0, Number(after) || 0);
      const rows = await s.list<{ blob: string; at: number }>({ prefix: 'i:', start: `i:${String(from + 1).padStart(12, '0')}`, limit: 200 });
      return { status: 200, body: { notes: [...rows].map(([k, v]) => ({ seq: Number(k.slice(2)), blob: v.blob, at: v.at })) } };
    }
    if (op === 'inbox-ack' && method === 'POST') {
      let upTo = 0;
      try {
        upTo = Number((JSON.parse(body) as { upTo?: unknown }).upTo) || 0;
      } catch {
        /* ignore */
      }
      const rows = await s.list({ prefix: 'i:', end: `i:${String(upTo + 1).padStart(12, '0')}` });
      const keys = [...rows.keys()];
      for (let i = 0; i < keys.length; i += 128) await s.delete(keys.slice(i, i + 128));
      return { status: 200, body: { deleted: keys.length } };
    }
    if (op === 'push' && method === 'PUT') {
      let v: { sub?: unknown; offline?: unknown } = {};
      try {
        v = JSON.parse(body);
      } catch {
        /* bad body */
      }
      const sub = asSub(v.sub);
      if (!sub) return { status: 400, body: { error: 'bad subscription' } };
      const subs = ((await s.get<RoomSub[]>('subs')) ?? []).filter((x) => x.sub.endpoint !== sub.endpoint);
      subs.push({ sub, origin, offline: v.offline === true, at: Date.now() });
      await s.put('subs', subs.slice(-MAX_SUBS));
      return { status: 200, body: { ok: true, devices: Math.min(subs.length, MAX_SUBS) } };
    }
    if (op === 'push-remove' && method === 'POST') {
      let endpoint = '';
      try {
        endpoint = String((JSON.parse(body) as { endpoint?: unknown }).endpoint ?? '');
      } catch {
        /* ignore */
      }
      const subs = ((await s.get<RoomSub[]>('subs')) ?? []).filter((x) => x.sub.endpoint !== endpoint);
      await s.put('subs', subs);
      return { status: 200, body: { ok: true } };
    }
    if (op === 'notice' && method === 'POST') {
      let v: { blob?: unknown; tag?: unknown } = {};
      try {
        v = JSON.parse(body);
      } catch {
        /* bad body */
      }
      if (typeof v.blob !== 'string' || v.blob.length > MAX_NOTICE || !/^[A-Za-z0-9_-]+$/.test(v.blob)) return { status: 400, body: { error: 'bad body' } };
      const tag = typeof v.tag === 'string' ? v.tag.replace(/[^a-z0-9-]/g, '').slice(0, 24) : 'notice';
      const day = new Date().toISOString().slice(0, 10);
      const quota = (await s.get<{ day: string; n: number }>('noticeQuota')) ?? { day, n: 0 };
      if (quota.day !== day) Object.assign(quota, { day, n: 0 });
      if (quota.n >= NOTICES_PER_DAY) return { status: 429, body: { error: 'too many notices today' } };
      quota.n++;
      await s.put('noticeQuota', quota);
      const seq = await this.addNotice({ tag, blob: v.blob });
      const sent = await this.fanOut({ room: this.roomId(), sealed: v.blob, tag }, `n${seq}`, false);
      return { status: 200, body: { seq, sent } };
    }
    if (op === 'notices' && method === 'GET') {
      const from = Math.max(0, Number(after) || 0);
      const list = ((await s.get<Notice[]>('notices')) ?? []).filter((n) => n.seq > from);
      return { status: 200, body: { notices: list } };
    }
    if (op === 'reset' && method === 'POST') {
      await s.deleteAll();
      return { status: 200, body: { ok: true } };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }

  /** Unauthenticated drop into the host inbox. Only a room that has an owner accepts notes. */
  async drop(body: string): Promise<Result> {
    const s = this.ctx.storage;
    if (!(await s.get<string>('auth'))) return { status: 404, body: { error: 'no such inbox' } };
    let blob: unknown;
    try {
      blob = (JSON.parse(body) as { blob?: unknown }).blob;
    } catch {
      /* fall through */
    }
    if (typeof blob !== 'string' || blob.length > MAX_NOTE || !/^[A-Za-z0-9_-]+$/.test(blob)) return { status: 400, body: { error: 'bad body' } };
    const count = (await s.get<number>('notes')) ?? 0;
    const waiting = await s.list({ prefix: 'i:', limit: MAX_NOTES });
    if (waiting.size >= MAX_NOTES) return { status: 429, body: { error: 'inbox full, try again later' } };
    const seq = count + 1;
    await s.put({ notes: seq, [`i:${String(seq).padStart(12, '0')}`]: { blob, at: Date.now() } });
    return { status: 200, body: { ok: true } };
  }

  private room = '';
  private roomId(): string {
    return this.room;
  }

  /** Keep the last few notices so phones without Web Push (the Android app) can fetch them. */
  async addNotice(n: Omit<Notice, 'seq' | 'at'>): Promise<number> {
    const s = this.ctx.storage;
    const seq = ((await s.get<number>('noticeSeq')) ?? 0) + 1;
    const cutoff = Date.now() - 14 * 864e5;
    const list = ((await s.get<Notice[]>('notices')) ?? []).filter((x) => x.at > cutoff);
    list.push({ ...n, seq, at: Date.now() });
    await s.put({ noticeSeq: seq, notices: list.slice(-KEEP_NOTICES) });
    return seq;
  }

  /** Web Push to every phone that asked; forgets subscriptions the push service says are gone. */
  async fanOut(payload: unknown, topic: string, offlineOnly: boolean): Promise<number> {
    const s = this.ctx.storage;
    const subs = (await s.get<RoomSub[]>('subs')) ?? [];
    let sent = 0;
    const keep: RoomSub[] = [];
    for (const sub of subs) {
      if (offlineOnly && !sub.offline) {
        keep.push(sub);
        continue;
      }
      const status = await sendPush(this.env, sub, payload, topic, 24 * 3600);
      if (status === 404 || status === 410) continue;
      keep.push(sub);
      if (status >= 200 && status < 300) sent++;
    }
    if (keep.length !== subs.length) await s.put('subs', keep);
    return sent;
  }

  private async prune(): Promise<void> {
    const s = this.ctx.storage;
    const rows = await s.list<{ at: number }>({ prefix: 'm:' });
    const cutoff = Date.now() - KEEP_MS;
    const drop: string[] = [];
    let left = rows.size;
    for (const [k, v] of rows) {
      if (v.at < cutoff || left > MAX_BATCHES) {
        drop.push(k);
        left--;
      } else break;
    }
    for (let i = 0; i < drop.length; i += 128) await s.delete(drop.slice(i, i + 128));
  }
}
