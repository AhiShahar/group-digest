import { LEGACY_DEFAULTS } from './models';
import { DEFAULT_REMINDERS, type ReminderPrefs } from './reminders';
// Everything is stored on this device only, in IndexedDB.
import type { Digest } from './digest';
import type { ChatMessage } from './parser';
import type { ProviderSettings } from './providerInfo';

export interface StoredChat {
  id: string;
  name: string;
  importedAt: number;
  messages: ChatMessage[];
  focus: string;
  lastDigestEnd: number | null; // ts of the last message covered by a digest
}

export interface StoredDigest {
  id: string;
  chatId: string;
  createdAt: number;
  from: number;
  to: number;
  messageCount: number;
  model: string;
  digest: Digest;
}

export interface AppSettings extends ProviderSettings {
  language: string;
  retentionDays: number;
  notify: boolean;
  reminders: ReminderPrefs;
}

const DB_NAME = 'group-digest';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('digests')) {
          const s = d.createObjectStore('digests', { keyPath: 'id' });
          s.createIndex('chatId', 'chatId');
        }
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode = 'readonly') {
  return (await db()).transaction(name, mode).objectStore(name);
}

export const newId = () => crypto.randomUUID();

export async function listChats(): Promise<StoredChat[]> {
  const all = (await wrap((await store('chats')).getAll())) as StoredChat[];
  return all.sort((a, b) => b.importedAt - a.importedAt);
}
export async function getChat(id: string): Promise<StoredChat | undefined> {
  return (await wrap((await store('chats')).get(id))) as StoredChat | undefined;
}
export async function putChat(c: StoredChat): Promise<void> {
  await wrap((await store('chats', 'readwrite')).put(c));
}
export async function deleteChat(id: string): Promise<void> {
  await wrap((await store('chats', 'readwrite')).delete(id));
  for (const d of await listDigests(id)) await wrap((await store('digests', 'readwrite')).delete(d.id));
}

export async function listDigests(chatId: string): Promise<StoredDigest[]> {
  const s = await store('digests');
  const all = (await wrap(s.index('chatId').getAll(chatId))) as StoredDigest[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function putDigest(d: StoredDigest): Promise<void> {
  await wrap((await store('digests', 'readwrite')).put(d));
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await wrap((await store('kv')).get(key))) as T | undefined;
}
export async function setKv(key: string, value: unknown): Promise<void> {
  await wrap((await store('kv', 'readwrite')).put(value, key));
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'openrouter',
  apiKey: '',
  baseUrl: 'http://localhost:11434/v1',
  model: 'openrouter/free',
  language: 'English',
  retentionDays: 30,
  notify: true,
  reminders: DEFAULT_REMINDERS,
};

export async function loadSettings(): Promise<AppSettings> {
  const s = { ...DEFAULT_SETTINGS, ...((await getKv<AppSettings>('settings')) ?? {}) };
  // Older builds saved fixed model IDs that providers have since retired.
  if (LEGACY_DEFAULTS.has(s.model)) s.model = '';
  return s;
}
export async function saveSettings(s: AppSettings): Promise<void> {
  await setKv('settings', s);
}

/** Delete raw messages older than the retention window. Digests are kept. */
export async function applyRetention(days: number): Promise<void> {
  if (!days) return;
  const cutoff = Date.now() - days * 864e5;
  for (const c of await listChats()) {
    const kept = c.messages.filter((m) => m.ts >= cutoff);
    if (kept.length !== c.messages.length) await putChat({ ...c, messages: kept });
  }
}

/** Merge a fresh export of the same group into the stored chat, keeping order and dropping repeats. */
export function mergeMessages(oldMsgs: ChatMessage[], newMsgs: ChatMessage[]): ChatMessage[] {
  // Minute precision: exports drop seconds, live capture keeps them.
  const key = (m: ChatMessage) => `${Math.floor(m.ts / 60000)}|${m.sender}|${m.text.trim()}`;
  const seen = new Set(oldMsgs.map(key));
  return [...oldMsgs, ...newMsgs.filter((m) => !seen.has(key(m)))].sort((a, b) => a.ts - b.ts);
}

/**
 * Store messages captured live from notifications, grouped into chats by group name.
 * Returns how many new messages were added.
 */
export async function storeCaptured(items: { chat: string; ts: number; sender: string | null; text: string }[]): Promise<number> {
  if (!items.length) return 0;
  const byChat = new Map<string, ChatMessage[]>();
  for (const it of items) {
    const list = byChat.get(it.chat) ?? [];
    const media = /^(📷|🎥|🎤|📄|🖼|GIF|Sticker|Photo|Video|Voice message|Audio)\b/u.test(it.text.trim());
    list.push({ ts: it.ts, sender: it.sender, text: it.text, media });
    byChat.set(it.chat, list);
  }
  const chats = await listChats();
  let added = 0;
  for (const [name, msgs] of byChat) {
    const existing = chats.find((c) => c.name === name);
    if (existing) {
      const merged = mergeMessages(existing.messages, msgs);
      added += merged.length - existing.messages.length;
      await putChat({ ...existing, messages: merged, importedAt: Date.now() });
    } else {
      const merged = mergeMessages([], msgs);
      added += merged.length;
      await putChat({ id: newId(), name, importedAt: Date.now(), messages: merged, focus: '', lastDigestEnd: null });
    }
  }
  return added;
}

/** Pick up a file shared into the app from another app (Android share sheet). */
export async function takeSharedFiles(): Promise<File[]> {
  try {
    const cache = await caches.open('share-target');
    const keys = await cache.keys();
    const files: File[] = [];
    for (const req of keys) {
      const res = await cache.match(req);
      if (!res) continue;
      const name = decodeURIComponent(res.headers.get('x-filename') ?? 'shared.txt');
      files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') ?? '' }));
      await cache.delete(req);
    }
    return files;
  } catch {
    return [];
  }
}
