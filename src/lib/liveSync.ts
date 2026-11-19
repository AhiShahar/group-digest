// Live sync: talks to the relay in the Worker (worker/index.ts). The sync
// server (public/bridge/bridge.mjs) links WhatsApp and drops encrypted batches
// of messages there; this pulls, decrypts and stores them, then deletes them
// from the relay. Nothing here can be read by the relay.
import { getKv, setKv, storeCaptured } from './store';
import { deriveKeys, newPairing, open, seal, type SyncKeys } from './syncCrypto';

/** Where the relay lives. The web app uses its own origin; the Android app uses the hosted one. */
export const RELAY_URL: string =
  (import.meta.env.VITE_RELAY_URL as string | undefined) ||
  (import.meta.env.VITE_TARGET !== 'android' && location.protocol === 'https:' ? location.origin : 'https://group-digest.ahi-shahar1.workers.dev');

export interface SyncPairing {
  room: string;
  secret: string;
  relay: string;
  createdAt: number;
  cursor: number; // last batch stored
  groups: string[]; // chosen group ids
  linkRequestedAt: number;
  unlink: number;
}

export interface SyncGroup {
  id: string;
  name: string;
  size: number;
}

export interface BridgeState {
  v: number;
  version: string;
  status: 'starting' | 'unlinked' | 'qr' | 'connected' | 'error';
  qr: string | null;
  me: { name: string | null; number: string } | null;
  groups: SyncGroup[];
  error: string | null;
  lastMessageAt: number;
  at: number; // when the server last reported
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
  const p: SyncPairing = { room, secret, relay: RELAY_URL, createdAt: Date.now(), cursor: 0, groups: [], linkRequestedAt: Date.now(), unlink: 0 };
  await savePairing(p);
  await pushConfig(p); // claims the room with this token
  return p;
}

export async function pushConfig(p: SyncPairing): Promise<void> {
  const k = await keysFor(p);
  const blob = await seal(k, 'config', { v: 1, groups: p.groups, linkRequestedAt: p.linkRequestedAt, unlink: p.unlink });
  await call(p, 'PUT', 'config', { blob });
}

export async function fetchState(p: SyncPairing): Promise<BridgeState | null> {
  const r = await call<{ blob: string | null }>(p, 'GET', 'state');
  if (!r.blob) return null;
  return open<BridgeState>(await keysFor(p), 'state', r.blob);
}

/** Pull new messages into the local store. Returns how many were new. */
export async function pullMessages(p: SyncPairing): Promise<number> {
  const k = await keysFor(p);
  let cursor = p.cursor;
  let added = 0;
  for (let round = 0; round < 20; round++) {
    const r = await call<{ batches: { seq: number; blob: string }[] }>(p, 'GET', 'messages', undefined, `?after=${cursor}`);
    if (!r.batches.length) break;
    const items: SyncedMessage[] = [];
    for (const b of r.batches) {
      try {
        items.push(...(await open<{ messages: SyncedMessage[] }>(k, 'messages', b.blob)).messages);
      } catch {
        /* a batch we cannot read (old pairing): skip it */
      }
      cursor = Math.max(cursor, b.seq);
    }
    added += await storeCaptured(items.filter((m) => p.groups.includes(m.group)));
    const latest = (await loadPairing()) ?? p;
    await savePairing({ ...latest, cursor });
    await call(p, 'POST', 'ack', { upTo: cursor });
    if (r.batches.length < 100) break;
  }
  return added;
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
