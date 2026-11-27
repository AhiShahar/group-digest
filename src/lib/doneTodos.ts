// To-dos the user has ticked off. Shared by the group digest cards and the
// Across groups screen, so ticking an item in one place shows in the other.
// Keyed by group + normalised task text, so the tick survives reloads and
// re-summaries that repeat the same task.
import { useEffect, useState } from 'react';
import { getKv, setKv } from './store';

const KV = 'doneTodos';
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const todoKey = (chatId: string, task: string) => `${chatId}|${norm(task)}`;

let cache: string[] | null = null;
let loading: Promise<string[]> | null = null;
const subs = new Set<(d: string[]) => void>();

function load(): Promise<string[]> {
  if (cache) return Promise.resolve(cache);
  loading ??= getKv<string[]>(KV).then((d) => (cache = d ?? []));
  return loading;
}

export async function toggleDone(key: string): Promise<void> {
  const cur = await load();
  const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key].slice(-500);
  cache = next;
  subs.forEach((f) => f(next));
  await setKv(KV, next);
}

export function useDoneTodos(): string[] {
  const [done, setDone] = useState<string[]>(cache ?? []);
  useEffect(() => {
    subs.add(setDone);
    load().then(setDone);
    return () => void subs.delete(setDone);
  }, []);
  return done;
}
