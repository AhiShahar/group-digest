// Live sync: talks to the relay in the Worker (worker/index.ts). The sync
// server (public/bridge/bridge.mjs) links WhatsApp and drops encrypted batches
// of messages there; this pulls, decrypts and stores them, then deletes them
// from the relay. Nothing here can be read by the relay.
import { DigestSchema, sanitizeEvents, type Digest } from './digest';
import { upgradeDigest } from './decisions';
import type { ProviderSettings } from './providerInfo';
import { getKv, listChats, loadSettings, newId, putChat, putDigest, setKv, storeCaptured, type StoredDigest } from './store';
import { deriveKeys, newInviteCode, newPairing, open, seal, sealTo, type SyncKeys } from './syncCrypto';

/** Where the relay lives. The web app uses its own origin; the Android app uses the hosted one. */
export const RELAY_URL: string =
  (import.meta.env.VITE_RELAY_URL as string | undefined) ||
  (import.meta.env.VITE_TARGET !== 'android' && typeof location !== 'undefined' && location.protocol === 'https:' ? location.origin : 'https://group-digest.ahi-shahar1.workers.dev');

export interface SyncPairing {
  room: string;
  secret: string;
  relay: string;
  createdAt: number;
  cursor: number; // last batch stored
  groups: string[]; // chosen group ids
  linkRequestedAt: number;
  unlink: number;
  /** Link with phone number instead of a QR code: digits with country code, and when it was asked. */
  pairPhone?: string;
  pairAt?: number;
  /** owner only: bump to make the server install updates now. */
  update?: number;
  /** owner: runs the sync server. member: joined someone else's server with an invite. */
  role?: 'owner' | 'member';
  /** The server's inbox and public key, for invites and nudges. */
  host?: HostInfo;
  /** owner only: invites handed out, and friends to remove. */
  invites?: Invite[];
  remove?: string[];
  /** member only: who invited them, and a request to leave. */
  hostName?: string;
  leave?: boolean;
  /** member only: what the server's owner may see about this person. */
  share?: { status: boolean };
  /** Scheduled digests made by the sync server with this person's own AI. */
  digest?: DigestSchedule;
  /** false turns off the daily backup of this device's data to the relay. */
  backup?: boolean;
  /** This phone gets notices (digests ready, alerts) by Web Push. */
  pushEndpoint?: string;
}

export interface DigestSchedule {
  on: boolean;
  freq: 'daily' | 'weekly';
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
  tz: string;
  groups: string[]; // empty = every synced group
  /** Models to try in order, picked by the app from the provider's live list. */
  models: string[];
  testAt?: number;
}

export const DEFAULT_SCHEDULE: DigestSchedule = {
  on: false,
  freq: 'daily',
  hour: 20,
  minute: 0,
  weekday: 0,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  groups: [],
  models: [],
};

/** AI providers the sync server can call by itself (a local Ollama on this computer it cannot reach). */
export function serverCanUse(s: ProviderSettings): boolean {
  if (s.provider !== 'compatible') return !!s.apiKey;
  return /^https:\/\//.test(s.baseUrl) && !/localhost|127\.0\.0\.1|\.local\b|192\.168\./.test(s.baseUrl);
}

export interface HostInfo {
  inbox: string;
  pub: string;
}

export interface Invite {
  code: string;
  name: string;
  createdAt: number;
}

export interface Member {
  room: string;
  name: string | null;
  code: string | null;
  joinedAt: number;
  status: BridgeState['status'] | 'hidden';
  lastMessageAt: number;
}

/** Invites work for a week; the server refuses older ones. */
export const INVITE_DAYS = 7;
export const inviteExpired = (i: Invite, now = Date.now()) => now - i.createdAt > INVITE_DAYS * 864e5;

export interface SyncGroup {
  id: string;
  name: string;
  size: number;
  last?: number; // when the group last had a message, if the server has seen one (server 0.5.1+)
}

export interface BridgeState {
  v: number;
  version: string;
  status: 'starting' | 'unlinked' | 'qr' | 'code' | 'connected' | 'error' | 'removed';
  code?: string | null; // pairing code for 'Link with phone number'
  qr: string | null;
  me: { name: string | null; number: string } | null;
  groups: SyncGroup[];
  error: string | null;
  lastMessageAt: number;
  at: number; // when the server last reported
  host?: HostInfo & { max: number; members: Member[] }; // owner only
  backupAt?: number; // owner only: last server backup
  hygiene?: { readOnly: boolean; reconnectsLastHour: number; blockedWrites: number };
}

interface SyncedDigest {
  group: string;
  chat: string;
  from: number;
  to: number;
  messageCount: number;
  model: string;
  digest: Digest;
}

interface SyncedMessage {
  id: string;
  group: string;
  chat: string;
  ts: number;
  sender: string | null;
  text: string;
  media: boolean;
}

const KV = 'liveSync';
let keysCache: { room: string; keys: Promise<SyncKeys> } | null = null;

export const loadPairing = () => getKv<SyncPairing>(KV);
export const savePairing = (p: SyncPairing | null) => setKv(KV, p);

function keysFor(p: SyncPairing): Promise<SyncKeys> {
  if (keysCache?.room !== p.room) keysCache = { room: p.room, keys: deriveKeys(p.room, p.secret) };
  return keysCache.keys;
}

async function call<T>(p: SyncPairing, method: string, op: string, body?: unknown, query = ''): Promise<T> {
  const k = await keysFor(p);
  const res = await fetch(`${p.relay}/api/sync/${p.room}/${op}${query}`, {
    method,
    headers: { authorization: `Bearer ${k.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (res.status === 403) throw new Error('This sync server belongs to a different setup. Set up live sync again.');
  if (!res.ok) throw new Error(`Sync relay error ${res.status}`);
  return (await res.json()) as T;
}

export async function createPairing(): Promise<SyncPairing> {
  const { room, secret } = newPairing();
  const p: SyncPairing = { room, secret, relay: RELAY_URL, createdAt: Date.now(), cursor: 0, groups: [], linkRequestedAt: Date.now(), unlink: 0, role: 'owner' };
  await savePairing(p);
  await pushConfig(p); // claims the room with this token
  return p;
}

/** The schedule as the server needs it: with this phone's AI settings and the chats' focus notes. */
async function digestConfig(p: SyncPairing) {
  if (!p.digest?.on) return undefined;
  const s = await loadSettings();
  if (!serverCanUse(s)) return { ...p.digest, on: false };
  const focus: Record<string, string> = {};
  for (const c of await listChats()) if (c.focus) focus[c.name] = c.focus;
  return { ...p.digest, ai: { provider: s.provider, apiKey: s.apiKey, baseUrl: s.baseUrl }, language: s.language, focus };
}

export async function pushConfig(p: SyncPairing): Promise<void> {
  const k = await keysFor(p);
  const digest = await digestConfig(p);
  const config =
    p.role === 'member'
      ? { v: 2, groups: p.groups, linkRequestedAt: p.linkRequestedAt, unlink: p.unlink, pairPhone: p.pairPhone, pairAt: p.pairAt, leave: !!p.leave, digest, share: p.share ?? { status: true } }
      : {
          v: 2,
          groups: p.groups,
          linkRequestedAt: p.linkRequestedAt,
          unlink: p.unlink,
          pairPhone: p.pairPhone,
          pairAt: p.pairAt,
          update: p.update ?? 0,
          invites: p.invites ?? [],
          remove: p.remove ?? [],
          digest,
        };
  await call(p, 'PUT', 'config', { blob: await seal(k, 'config', config) });
  if (p.host) await nudge(p.relay, p.host, { type: 'ping', room: p.room }).catch(() => undefined);
}

/** Drop a sealed note in the server's inbox, so it reacts now instead of on its next check. */
async function nudge(relay: string, host: HostInfo, note: unknown): Promise<void> {
  const res = await fetch(`${relay}/api/sync/${host.inbox}/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob: await sealTo(host.pub, note) }),
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'That sync server is not running.' : `Could not reach the sync server (${res.status}).`);
}

// ---- invites -----------------------------------------------------------------------

export interface ParsedInvite extends HostInfo {
  code: string;
  from: string;
}

/** Invite links look like https://<app>/#join=<inbox>.<pub>.<code>.<from> */
export function parseInvite(hash: string): ParsedInvite | null {
  const m = /[#&]join=([a-f0-9]{32})\.([A-Za-z0-9_-]{80,100})\.([A-Za-z0-9_-]{10,40})(?:\.([^&]*))?/.exec(hash);
  if (!m) return null;
  let from = '';
  try {
    from = decodeURIComponent(m[4] ?? '').slice(0, 40);
  } catch {
    /* ignore */
  }
  return { inbox: m[1], pub: m[2], code: m[3], from };
}

export function inviteLink(p: SyncPairing, inv: Invite, from: string): string {
  if (!p.host) throw new Error('Your sync server has not checked in yet.');
  return `${p.relay}/#join=${p.host.inbox}.${p.host.pub}.${inv.code}.${encodeURIComponent(from)}`;
}

export function newInvite(name: string): Invite {
  return { code: newInviteCode(), name: name.trim().slice(0, 40), createdAt: Date.now() };
}

/** Join a friend's sync server with an invite. */
export async function joinWithInvite(inv: ParsedInvite, name: string): Promise<SyncPairing> {
  const { room, secret } = newPairing();
  const p: SyncPairing = {
    room,
    secret,
    relay: RELAY_URL,
    createdAt: Date.now(),
    cursor: 0,
    groups: [],
    linkRequestedAt: Date.now(),
    unlink: 0,
    role: 'member',
    host: { inbox: inv.inbox, pub: inv.pub },
    hostName: inv.from,
  };
  const k = await keysFor(p);
  // Claim our own room first, so only this phone and the server can use it.
  await call(p, 'PUT', 'config', { blob: await seal(k, 'config', { v: 2, groups: [], linkRequestedAt: p.linkRequestedAt, unlink: 0, leave: false }) });
  await nudge(p.relay, p.host!, { type: 'join', code: inv.code, room, secret, name: name.trim().slice(0, 40) });
  await savePairing(p);
  return p;
}

export async function fetchState(p: SyncPairing): Promise<BridgeState | null> {
  const r = await call<{ blob: string | null }>(p, 'GET', 'state');
  if (!r.blob) return null;
  return open<BridgeState>(await keysFor(p), 'state', r.blob);
}

/** Pull new messages into the local store. Returns how many were new. */
export let lastDigests = 0;

export async function pullMessages(p: SyncPairing): Promise<number> {
  const k = await keysFor(p);
  let cursor = p.cursor;
  let added = 0;
  lastDigests = 0;
  for (let round = 0; round < 20; round++) {
    const r = await call<{ batches: { seq: number; blob: string }[] }>(p, 'GET', 'messages', undefined, `?after=${cursor}`);
    if (!r.batches.length) break;
    const items: SyncedMessage[] = [];
    const digests: SyncedDigest[] = [];
    for (const b of r.batches) {
      try {
        const v = await open<{ messages: SyncedMessage[]; digests?: SyncedDigest[] }>(k, 'messages', b.blob);
        items.push(...(v.messages ?? []));
        digests.push(...(v.digests ?? []));
      } catch {
        /* a batch we cannot read (old pairing): skip it */
      }
      cursor = Math.max(cursor, b.seq);
    }
    added += await storeCaptured(items.filter((m) => p.groups.includes(m.group)));
    lastDigests += await storeDigests(digests);
    const latest = (await loadPairing()) ?? p;
    await savePairing({ ...latest, cursor });
    await call(p, 'POST', 'ack', { upTo: cursor });
    if (r.batches.length < 100) break;
  }
  return added;
}

/** Save digests the server made on schedule, next to the chat they belong to. */
export async function storeDigests(list: SyncedDigest[]): Promise<number> {
  let n = 0;
  for (const x of list) {
    const parsed = DigestSchema.safeParse(upgradeDigest(x.digest));
    if (!parsed.success || !x.chat) continue;
    const digest = { ...parsed.data, events: sanitizeEvents(parsed.data.events, x.from, x.to) };
    let chat = (await listChats()).find((c) => c.name === x.chat);
    if (!chat) {
      chat = { id: newId(), name: x.chat, importedAt: Date.now(), messages: [], focus: '', lastDigestEnd: null };
    }
    const rec: StoredDigest = {
      id: newId(),
      chatId: chat.id,
      createdAt: Date.now(),
      from: x.from,
      to: x.to,
      messageCount: x.messageCount,
      model: `${x.model} · scheduled`,
      digest,
    };
    await putDigest(rec);
    await putChat({ ...chat, lastDigestEnd: Math.max(chat.lastDigestEnd ?? 0, x.to) });
    n++;
  }
  return n;
}

// ---- notices by Web Push ----------------------------------------------------------

export interface SyncNotice {
  seq: number;
  at: number;
  tag: string;
  title: string;
  body: string;
}

/** Ask the relay to push this room's notices to this phone. */
export async function registerPush(p: SyncPairing, sub: PushSubscriptionJSON): Promise<void> {
  await call(p, 'PUT', 'push', { sub, offline: p.role !== 'member' });
}

export async function unregisterPush(p: SyncPairing, endpoint: string): Promise<void> {
  await call(p, 'POST', 'push-remove', { endpoint });
}

/** Recent notices, opened. Plain alerts from the relay itself have no seal. */
export async function fetchNotices(p: SyncPairing, after = 0): Promise<SyncNotice[]> {
  const k = await keysFor(p);
  const r = await call<{ notices: { seq: number; at: number; tag: string; blob?: string; title?: string; body?: string }[] }>(p, 'GET', 'notices', undefined, `?after=${after}`);
  const out: SyncNotice[] = [];
  for (const n of r.notices) {
    if (n.blob) {
      try {
        const v = await open<{ title: string; body: string }>(k, 'notice', n.blob);
        out.push({ seq: n.seq, at: n.at, tag: n.tag, title: v.title, body: v.body });
      } catch {
        /* sealed with another key */
      }
    } else if (n.title) out.push({ seq: n.seq, at: n.at, tag: n.tag, title: n.title, body: n.body ?? '' });
  }
  return out;
}

/** Delete every undelivered batch from the relay. */
export async function dropPending(p: SyncPairing): Promise<void> {
  await call(p, 'POST', 'ack', { upTo: Number.MAX_SAFE_INTEGER });
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The line that installs the sync server on a Linux machine. */
export function installLine(p: SyncPairing): string {
  return `curl -fsSL ${p.relay}/bridge/setup.sh | sudo bash -s -- ${q(p.relay)} ${p.room} ${p.secret}`;
}

/** Oracle Cloud: paste into "Advanced options > Initialization script" when creating the VM. */
export function oracleScript(p: SyncPairing): string {
  return `#!/bin/bash\n${installLine(p).replace('sudo bash', 'bash')}\n`;
}

/** Google Cloud Shell: creates a free-tier e2-micro and installs the server on it. */
export function gcloudCommand(p: SyncPairing): string {
  const startup = installLine(p).replace('sudo bash', 'bash');
  return [
    `gcloud services enable compute.googleapis.com &&`,
    `gcloud compute instances create group-digest-sync`,
    `  --zone=us-central1-a --machine-type=e2-micro`,
    `  --image-family=debian-12 --image-project=debian-cloud`,
    `  --boot-disk-size=30GB --boot-disk-type=pd-standard`,
    `  --no-service-account --no-scopes`,
    `  --metadata=startup-script=${q(startup)}`,
  ].join(' \\\n');
}
