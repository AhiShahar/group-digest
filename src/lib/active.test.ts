import { describe, expect, it } from 'vitest';
import { splitActive } from './active';
// @ts-expect-error plain JS module shared with the sync server
import { Activity } from '../../public/bridge/activity.mjs';

const now = Date.UTC(2026, 10, 20);
const day = 864e5;

describe('splitActive', () => {
  const items = [
    { id: 'a', last: now - 2 * day },
    { id: 'b', last: now - 45 * day },
    { id: 'c', last: undefined },
    { id: 'd', last: now - 90 * day },
  ];
  it('shows groups active in the last month and keeps chosen ones', () => {
    const s = splitActive(items, (t) => t.last, (t) => t.id === 'd', now);
    expect(s.shown.map((t) => t.id)).toEqual(['a', 'd']);
    expect(s.hidden.map((t) => t.id)).toEqual(['b', 'c']);
    expect(s.unknown).toBe(false);
  });
  it('shows everything when no activity is known yet', () => {
    const s = splitActive([{ last: undefined }, { last: 0 }], (t) => t.last, undefined, now);
    expect(s.shown).toHaveLength(2);
    expect(s.unknown).toBe(true);
  });
});

describe('server Activity', () => {
  it('learns group times from messages and chats, ignoring private chats', () => {
    const a = new Activity({ 'old@g.us': 5, 'x@s.whatsapp.net': 9 });
    expect(a.last).toEqual({ 'old@g.us': 5 });
    a.noteMessage({ key: { remoteJid: '1@g.us' }, messageTimestamp: 100 }, now);
    a.noteMessage({ key: { remoteJid: '1@g.us' }, messageTimestamp: 50 }, now); // older: ignored
    a.noteMessage({ key: { remoteJid: 'p@s.whatsapp.net' }, messageTimestamp: 100 }, now);
    a.noteChat({ id: '2@g.us', conversationTimestamp: { toString: () => '200' } }, now);
    a.noteChat({ id: '3@g.us', lastMessageRecvTimestamp: 9e12 }, now); // in the future: capped
    expect(a.last).toEqual({ 'old@g.us': 5, '1@g.us': 100e3, '2@g.us': 200e3, '3@g.us': now });
    expect(a.dirty).toBe(true);
    a.keepOnly(['1@g.us', '2@g.us']);
    expect(Object.keys(a.last)).toEqual(['1@g.us', '2@g.us']);
  });
});
