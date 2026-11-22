// Automatic backups of this device's Nutshell data (groups, messages,
// digests, settings, live-sync pairing) to the live-sync relay, sealed with
// the pairing key, so a lost or reset phone can get everything back with the
// recovery key. Needs live sync, because the relay room and key come from it.
import { RELAY_URL, loadPairing, savePairing, type SyncPairing } from './liveSync';
import { allDigests, getKv, listChats, mergeMessages, putChat, putDigest, saveSettings, setKv, type AppSettings, type StoredChat, type StoredDigest } from './store';
import { b64url, deriveKeys, openBytes, sealBytes, unb64url, type SyncKeys } from './syncCrypto';

const PART = 120_000;
const EVERY = 20 * 3600e3; // about daily, whenever the app is open
const INFO = 'backupInfo';

export interface BackupInfo {
  at: number;
  size: number;
}

interface AppBackup {
  v: 1;
  at: number;
  chats: StoredChat[];
  digests: StoredDigest[];
  settings: AppSettings | undefined;
  pairing: SyncPairing;
}

async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function call<T>(p: { relay: string; room: string }, k: SyncKeys, method: string, op: string, body?: unknown, query = ''): Promise<T> {
  const res = await fetch(`${p.relay}/api/sync/${p.room}/${op}${query}`, {
    method,
    headers: { authorization: `Bearer ${k.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (res.status === 404) throw new Error('No backup was found for this recovery key.');
  if (res.status === 403) throw new Error('This recovery key does not match.');
  if (!res.ok) throw new Error(`Backup service error ${res.status}`);
  return (await res.json()) as T;
}

export const backupInfo = () => getKv<BackupInfo>(INFO);

/** The key that brings this device's data back on another phone. Keep it private. */
export function recoveryKey(p: SyncPairing): string {
  return `gd1-${p.room}-${p.secret}`;
}

export function parseRecoveryKey(text: string): { room: string; secret: string } | null {
  const m = /gd1-([a-f0-9]{32})-([A-Za-z0-9_-]{40,})/.exec(text.replace(/\s+/g, ''));
  return m ? { room: m[1], secret: m[2] } : null;
}

/** Seal and upload a backup now. Returns its size in bytes (sealed). */
export async function backupNow(): Promise<BackupInfo> {
  const p = await loadPairing();
  if (!p) throw new Error('Set up live sync first: backups are kept with your sync server.');
  const k = await deriveKeys(p.room, p.secret);
  const data: AppBackup = { v: 1, at: Date.now(), chats: await listChats(), digests: await allDigests(), settings: await getKv<AppSettings>('settings'), pairing: p };
  const sealed = b64url(await sealBytes(k, 'backup-app', await gzip(new TextEncoder().encode(JSON.stringify(data)))));
  const gen = Date.now();
  const parts = Math.max(1, Math.ceil(sealed.length / PART));
  for (let i = 0; i < parts; i++) {
    await call(p, k, 'PUT', 'backup', { blob: sealed.slice(i * PART, (i + 1) * PART) }, `?name=app&gen=${gen}&part=${i}`);
  }
  await call(p, k, 'POST', 'backup-commit', { name: 'app', gen, parts, size: sealed.length });
  const info = { at: gen, size: sealed.length };
  await setKv(INFO, info);
  return info;
}

/** Called when the app opens: back up if the last one is about a day old. */
export async function autoBackup(): Promise<void> {
  const p = await loadPairing();
  if (!p || p.backup === false) return;
  const last = await backupInfo();
  if (last && Date.now() - last.at < EVERY) return;
  await backupNow();
}

/** Restore from a recovery key: groups and digests are merged into what is here; settings and live sync come back. */
export async function restoreFromKey(text: string, relay = RELAY_URL): Promise<{ chats: number; digests: number; at: number }> {
  const parsed = parseRecoveryKey(text);
  if (!parsed) throw new Error('That does not look like a recovery key. It starts with gd1-.');
  const k = await deriveKeys(parsed.room, parsed.secret);
  const p = { relay, room: parsed.room };
  const man = await call<{ parts: number; at: number }>(p, k, 'GET', 'backup', undefined, '?name=app');
  let sealed = '';
  for (let i = 0; i < man.parts; i++) sealed += (await call<{ blob: string }>(p, k, 'GET', 'backup', undefined, `?name=app&part=${i}`)).blob;
  const data = JSON.parse(new TextDecoder().decode(await gunzip(await openBytes(k, 'backup-app', unb64url(sealed))))) as AppBackup;

  const here = await listChats();
  const idMap = new Map<string, string>();
  for (const c of data.chats) {
    const same = here.find((h) => h.name === c.name);
    if (same) {
      idMap.set(c.id, same.id);
      await putChat({ ...same, messages: mergeMessages(same.messages, c.messages), lastDigestEnd: Math.max(same.lastDigestEnd ?? 0, c.lastDigestEnd ?? 0) || null, focus: same.focus || c.focus, alias: same.alias || c.alias });
    } else {
      idMap.set(c.id, c.id);
      await putChat(c);
    }
  }
  for (const d of data.digests) await putDigest({ ...d, chatId: idMap.get(d.chatId) ?? d.chatId });
  const cur = await getKv<AppSettings>('settings');
  if (data.settings && !cur?.apiKey) await saveSettings(data.settings);
  if (!(await loadPairing())) await savePairing({ ...data.pairing, relay: data.pairing.relay || relay });
  await setKv(INFO, { at: data.at, size: sealed.length });
  return { chats: data.chats.length, digests: data.digests.length, at: data.at };
}
