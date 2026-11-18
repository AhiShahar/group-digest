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
  provider: 'anthropic',
  apiKey: '',
  baseUrl: 'http://localhost:11434/v1',
  model: 'claude-opus-5-5',
  language: 'English',
  retentionDays: 30,
  notify: true,
};

export async function loadSettings(): Promise<AppSettings> {
  return { ...DEFAULT_SETTINGS, ...((await getKv<AppSettings>('settings')) ?? {}) };
}
export async function saveSettings(s: AppSettings): Promise<void> {
  await setKv('settings', s);
}

/** Delete raw messages older than the retention window. Digests are kept. */
export async function applyRetention(days: number): Promise<void> {
  if (!days) return;
  const cutoff = Date.now() - days * 864e5;
  for (const c of await listChats()) {
    if (c.importedAt < cutoff && c.messages.length) {
      await putChat({ ...c, messages: [] });
    }
  }
}

/** Merge a fresh export of the same group into the stored chat, keeping order and dropping repeats. */
export function mergeMessages(oldMsgs: ChatMessage[], newMsgs: ChatMessage[]): ChatMessage[] {
  const key = (m: ChatMessage) => `${m.ts}|${m.sender}|${m.text}`;
  const seen = new Set(oldMsgs.map(key));
  return [...oldMsgs, ...newMsgs.filter((m) => !seen.has(key(m)))].sort((a, b) => a.ts - b.ts);
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
