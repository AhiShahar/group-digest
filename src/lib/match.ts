// Finds the group a re-export belongs to, so updates merge instead of
// creating a second copy of the same group.

import type { ChatMessage } from './parser';

interface ChatLike {
  id: string;
  name: string;
  messages: ChatMessage[];
}

/** Lowercase, no emoji or punctuation, single spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const sig = (m: ChatMessage) => `${Math.floor(m.ts / 60000)}|${m.sender ?? ''}|${m.text.slice(0, 80)}`;

/**
 * Same name first, then the same name ignoring case, emoji and punctuation,
 * then a group that shares at least 3 identical messages (a renamed group).
 */
export function findMatchingChat<T extends ChatLike>(chats: T[], name: string, messages: ChatMessage[]): T | undefined {
  const exact = chats.find((c) => c.name === name);
  if (exact) return exact;
  const n = normalizeName(name);
  const loose = n ? chats.find((c) => normalizeName(c.name) === n) : undefined;
  if (loose) return loose;
  const incoming = new Set(messages.filter((m) => m.text.length > 3).map(sig));
  let best: T | undefined;
  let bestHits = 0;
  for (const c of chats) {
    let hits = 0;
    for (const m of c.messages) if (incoming.has(sig(m)) && ++hits >= 50) break;
    if (hits > bestHits) {
      best = c;
      bestHits = hits;
    }
  }
  return bestHits >= 3 ? best : undefined;
}
