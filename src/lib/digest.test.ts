import { describe, expect, it } from 'vitest';
import { buildIcs, eventTimes } from './calendar';
import { extractJson, mergeDigests, redactPhones, sanitizeEvents, type Digest, type DigestEvent } from './digest';

const ev = (over: Partial<DigestEvent> = {}): DigestEvent => ({
  title: 'Trip',
  date: '2026-11-20',
  start_time: '08:30',
  end_time: '14:00',
  location: null,
  notes: null,
  source_quote: 'trip on Friday',
  confidence: 'high',
  ...over,
});

const dg = (over: Partial<Digest> = {}): Digest => ({
  headline: 'h',
  key_points: [],
  decisions: [],
  action_items: [],
  open_questions: [],
  events: [],
  ...over,
});

describe('digest helpers', () => {
  it('masks phone numbers but keeps short numbers', () => {
    expect(redactPhones('+972 54-123-4567: hi')).toBe('[phone …67]: hi');
    expect(redactPhones('45 shekels by 14:00')).toBe('45 shekels by 14:00');
  });

  it('extracts JSON from fenced or chatty output', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":2} hope that helps')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('sanitizes bad dates and times', () => {
    const start = new Date(2026, 10, 10).getTime();
    const out = sanitizeEvents(
      [ev(), ev({ date: 'next friday' }), ev({ start_time: '25:00', end_time: '26:00' }), ev({ date: '2031-01-01' })],
      start,
      start,
    );
    expect(out).toHaveLength(3);
    expect(out[1].start_time).toBeNull();
    expect(out[1].end_time).toBeNull();
    expect(out[2].confidence).toBe('low');
  });

  it('merges chunked digests and lets the later part win for the same event', () => {
    const m = mergeDigests([
      dg({ key_points: ['a', 'b'], events: [ev({ start_time: '08:00' })] }),
      dg({ headline: 'last', key_points: ['b', 'c'], events: [ev({ title: 'trip ', start_time: '09:00' })] }),
    ]);
    expect(m.headline).toBe('last');
    expect(m.key_points).toEqual(['a', 'b', 'c']);
    expect(m.events).toHaveLength(1);
    expect(m.events[0].start_time).toBe('09:00');
  });
});

describe('calendar', () => {
  it('handles all-day, default 1 hour, and past-midnight events', () => {
    expect(eventTimes(ev({ start_time: null, end_time: null })).allDay).toBe(true);
    const t = eventTimes(ev({ end_time: null }));
    expect(t.end.getTime() - t.start.getTime()).toBe(3600_000);
    const late = eventTimes(ev({ start_time: '22:00', end_time: '01:00' }));
    expect(late.end > late.start).toBe(true);
  });

  it('builds valid folded ICS with escaped text', async () => {
    const ics = await buildIcs([ev({ title: 'Dinner, drinks; fun', notes: 'א'.repeat(60) })], 'Group');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('SUMMARY:Dinner\\, drinks\\; fun');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    // the same event gives the same UID, so re-adding updates instead of duplicating
    const again = await buildIcs([ev({ title: 'Dinner, drinks; fun' })], 'Group');
    expect(/UID:(.*)/.exec(ics)![1]).toBe(/UID:(.*)/.exec(again)![1]);
  });
});
