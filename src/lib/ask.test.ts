import { describe, expect, it } from 'vitest';
import { askContext, overview, search, terms } from './ask';
import type { StoredChat, StoredDigest } from './store';

const now = Date.now();
const chat = (id: string, name: string, texts: string[]): StoredChat => ({
  id,
  name,
  importedAt: now,
  focus: '',
  lastDigestEnd: null,
  messages: texts.map((text, i) => ({ ts: now - (texts.length - i) * 3600e3, sender: 'Dana', text, media: false })),
});
const chats = [
  chat('a', 'School 3B', ['Trip to the zoo on Thursday', 'Bring a hat', 'הטיול נדחה ליום ראשון', 'ok']),
  chat('b', 'Book club', ['Next book: Dune', 'Meeting moved to Monday at the library', 'nice']),
];

describe('across groups', () => {
  it('drops filler words, keeps Hebrew', () => {
    expect(terms('When is the zoo trip?')).toEqual(['zoo', 'trip']);
    expect(terms('מתי הטיול?')).toEqual(['הטיול']);
  });

  it('searches every group and needs all of one or two words', () => {
    expect(search(chats, 'zoo trip').map((h) => h.m.text)).toEqual(['Trip to the zoo on Thursday']);
    expect(search(chats, 'meeting').map((h) => h.chat)).toEqual(['Book club']);
    expect(search(chats, 'טיול')).toHaveLength(1); // matches inside the prefixed word
    expect(search(chats, 'the')).toEqual([]);
  });

  it('gives the AI matches with context, by group', () => {
    const ctx = askContext(chats, 'when is the trip?');
    expect(ctx.groups).toBe(1);
    expect(ctx.text).toContain('## Group: School 3B');
    expect(ctx.text).toContain('Bring a hat'); // neighbour of the match
    expect(ctx.text).not.toContain('Dune');
    // no matching words: the last week of everything
    expect(askContext(chats, 'xyzzy').groups).toBe(2);
  });

  it('collects to-dos and upcoming dates, newest digest wins', () => {
    const d = (id: string, chatId: string, ageDays: number, digest: Partial<StoredDigest['digest']>): StoredDigest => ({
      id,
      chatId,
      createdAt: now - ageDays * 864e5,
      from: 0,
      to: 0,
      messageCount: 1,
      model: 'x',
      digest: { headline: 'h', key_points: [], decisions: [], action_items: [], open_questions: [], events: [], ...digest },
    });
    const ev = (title: string, date: string, start_time: string | null = null) => ({ title, date, start_time, end_time: null, location: null, notes: null, source_quote: '', confidence: 'high' as const });
    const ov = overview(
      chats,
      [
        d('1', 'a', 3, { events: [ev('Zoo trip', '2026-11-26', '08:00'), ev('Old', '2026-11-01')], action_items: [{ task: 'Pay 20 NIS', owner: null, due: '2026-11-24' }] }),
        d('2', 'a', 1, { events: [ev('Zoo trip', '2026-11-29', '09:00')], decisions: [{ what: 'Trip moved to Sunday', who: 'Dana', date: '2026-11-29', time: null, where: null }] }),
        d('5', 'a', 2, { decisions: [{ what: 'Trip moved to Sunday', who: null, date: null, time: null, where: null }] }),
        d('3', 'b', 2, { action_items: [{ task: 'Read Dune', owner: 'You', due: null }] }),
        d('4', 'b', 40, { action_items: [{ task: 'Too old', owner: null, due: null }] }),
      ],
      '2026-11-20',
    );
    expect(ov.dates.map((x) => `${x.e.title} ${x.e.date}`)).toEqual(['Zoo trip 2026-11-29']);
    expect(ov.todos.map((t) => t.task)).toEqual(['Pay 20 NIS', 'Read Dune']);
    expect(ov.decisions).toHaveLength(1); // the same decision in two digests shows once, from the newer
    expect(ov.decisions[0].d.who).toBe('Dana');
  });
});
