import { describe, expect, it } from 'vitest';
import { findMatchingChat, normalizeName } from './match';

const msg = (ts: number, text: string) => ({ ts, sender: 'Dana', text, media: false });
const chats = [
  { id: 'a', name: 'Parents 3B 🎒', messages: [msg(1e12, 'Trip on Friday'), msg(1e12 + 6e4, 'Pay by Monday please'), msg(1e12 + 12e4, 'Bring a hat')] },
  { id: 'b', name: 'Book Club', messages: [msg(2e12, 'Next book?')] },
];

describe('findMatchingChat', () => {
  it('matches exact names', () => expect(findMatchingChat(chats, 'Book Club', [])?.id).toBe('b'));
  it('ignores case, emoji and punctuation', () => expect(findMatchingChat(chats, 'parents 3b', [])?.id).toBe('a'));
  it('finds a renamed group by shared messages', () =>
    expect(findMatchingChat(chats, 'Class 3B parents', [...chats[0].messages, msg(1e12 + 9e5, 'new one')])?.id).toBe('a'));
  it('creates a new group when nothing matches', () => expect(findMatchingChat(chats, 'Neighbours', [msg(3e12, 'hello there')])).toBeUndefined());
  it('normalizes names', () => expect(normalizeName('  Parents—3B!! 🎒 ')).toBe('parents 3b'));
});
