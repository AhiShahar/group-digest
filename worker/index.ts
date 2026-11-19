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
// Auth: "Authorization: Bearer <token>". The room remembers the SHA-256 of the
// first token it sees and refuses any other. Room ids are 128-bit random.

import { DurableObject } from 'cloudflare:workers';

interface Env {
  ASSETS: Fetcher;
  SYNC: DurableObjectNamespace<SyncRoom>;
}

const MAX_BLOB = 256 * 1024; // bytes of base64 text per request
const KEEP_MS = 7 * 864e5; // undelivered batches are dropped after 7 days
const MAX_BATCHES = 2000;

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
    const m = /^\/api\/sync\/([a-f0-9]{32})\/(state|config|messages|ack|reset)$/.exec(url.pathname);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!m) return json({ error: 'not found' }, 404);
    const token = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return json({ error: 'missing token' }, 401);
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_BLOB + 1024) return json({ error: 'too large' }, 413);
    const room = env.SYNC.get(env.SYNC.idFromName(m[1]));
    const body = req.method === 'GET' ? '' : await req.text();
    if (body.length > MAX_BLOB + 1024) return json({ error: 'too large' }, 413);
    const res = (await room.handle(await sha256(token), req.method, m[2], url.searchParams.get("after"), body)) as unknown as Result;
    return json(res.body, res.status);
  },
} satisfies ExportedHandler<Env>;

type Result = { status: number; body: unknown };

export class SyncRoom extends DurableObject<Env> {
  async handle(tokenHash: string, method: string, op: string, after: string | null, body: string): Promise<Result> {
    const s = this.ctx.storage;
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
    if (op === 'reset' && method === 'POST') {
      await s.deleteAll();
      return { status: 200, body: { ok: true } };
    }
    return { status: 405, body: { error: 'method not allowed' } };
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
