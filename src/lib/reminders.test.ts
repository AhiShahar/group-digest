import { describe, expect, it } from 'vitest';
import { buildIcs } from './calendar';
import type { DigestEvent } from './digest';
import { icsAlarms, reminderOffsets, remindersFor } from './reminders';

const ev = (over: Partial<DigestEvent> = {}): DigestEvent => ({
  title: 'Class trip',
  date: '2026-11-20',
  start_time: '08:30',
  end_time: null,
  location: 'Museum',
  notes: null,
  source_quote: 'trip on Friday',
  confidence: 'high',
  ...over,
});

describe('reminderOffsets', () => {
  it('reminds once by default', () => expect(reminderOffsets({ lead: 1440, repeat: 0 })).toEqual([1440]));
  it('repeats until the event', () => expect(reminderOffsets({ lead: 2880, repeat: 1440 })).toEqual([2880, 1440]));
  it('caps the number of reminders', () => expect(reminderOffsets({ lead: 10080, repeat: 60 }).length).toBe(8));
  it('can be turned off', () => expect(reminderOffsets({ lead: 0, repeat: 0 })).toEqual([]));
});

describe('remindersFor', () => {
  it('skips reminders in the past and counts from 9:00 for all-day events', () => {
    const e = ev({ start_time: null });
    const now = new Date(2026, 10, 18, 12).getTime(); // 18 Nov noon
    const r = remindersFor(e, 'Parents', { lead: 2880, repeat: 1440 }, now);
    // 2 days before 9:00 on the 20th is the 18th 9:00 (past); 1 day before is the 19th 9:00.
    expect(r.map((x) => new Date(x.at).getDate())).toEqual([19]);
    expect(new Date(r[0].at).getHours()).toBe(9);
    expect(r[0].body).toContain('In 1 day');
  });
});

describe('calendar alarms', () => {
  it('adds VALARMs to the .ics file', async () => {
    const ics = await buildIcs([ev()], 'Parents', { lead: 120, repeat: 60 });
    expect(ics).toContain('TRIGGER:-PT120M');
    expect(ics).toContain('TRIGGER:-PT60M');
    expect(ics.match(/BEGIN:VALARM/g)?.length).toBe(2);
  });
  it('shifts all-day alarms to 9:00', () => {
    expect(icsAlarms(ev({ start_time: null }), { lead: 1440, repeat: 0 })).toContain('TRIGGER:-PT900M');
    expect(icsAlarms(ev({ start_time: null }), { lead: 60, repeat: 0 })).toContain('TRIGGER:PT480M');
  });
});
