import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the sync server
import * as server from '../../public/bridge/digest.mjs';
import { DigestSchema, SCHEMA_HINT, SYSTEM_PROMPT, redactPhones } from './digest';

describe('scheduled digests on the sync server', () => {
  it('uses the same prompt as the app', () => {
    expect(server.SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
    expect(server.SCHEMA_HINT).toBe(SCHEMA_HINT);
    expect(server.redactPhones('call +972 50-123-4567')).toBe(redactPhones('call +972 50-123-4567'));
  });

  it('works out local time in the reader time zone', () => {
    // 2026-11-20 18:30 UTC is 20:30 in Jerusalem (UTC+2 in winter), a Friday.
    const ts = Date.UTC(2026, 10, 20, 18, 30);
    expect(server.localParts(ts, 'Asia/Jerusalem')).toMatchObject({ ymd: '2026-11-20', hour: 20, minute: 30, weekday: 5 });
    expect(server.localParts(ts, 'Not/AZone').hour).toBe(18);
    // Just after midnight UTC is still the previous day in New York.
    expect(server.localParts(Date.UTC(2026, 10, 21, 0, 10), 'America/New_York').ymd).toBe('2026-11-20');
  });

  it('is due from the chosen time until the end of that day', () => {
    const daily = { on: true, freq: 'daily', hour: 20, minute: 0, weekday: 0, tz: 'Asia/Jerusalem' };
    expect(server.duePeriod(daily, Date.UTC(2026, 10, 20, 17, 59))).toBeNull(); // 19:59 local
    expect(server.duePeriod(daily, Date.UTC(2026, 10, 20, 18, 0))).toBe('2026-11-20');
    expect(server.duePeriod(daily, Date.UTC(2026, 10, 20, 21, 59))).toBe('2026-11-20'); // 23:59 local, catching up
    expect(server.duePeriod({ ...daily, on: false }, Date.UTC(2026, 10, 20, 19))).toBeNull();
    const weekly = { ...daily, freq: 'weekly', weekday: 0 }; // Sunday
    expect(server.duePeriod(weekly, Date.UTC(2026, 10, 20, 19))).toBeNull(); // Friday
    expect(server.duePeriod(weekly, Date.UTC(2026, 10, 22, 19))).toBe('2026-11-22');
  });

  it('shapes loose model output into a digest the app accepts', () => {
    const d = server.coerceDigest({
      headline: 'Dinner moved',
      key_points: ['a', 3, null],
      action_items: [{ task: 'Book table', owner: '' }, { owner: 'x' }],
      events: [{ title: 'Dinner', date: '2026-11-27', start_time: '20:00', confidence: 'sure' }, { title: 'No date' }],
    });
    expect(DigestSchema.safeParse(d).success).toBe(true);
    expect(d.key_points).toEqual(['a', '3']);
    expect(d.action_items).toEqual([{ task: 'Book table', owner: null, due: null }]);
    expect(d.events).toHaveLength(1);
    expect(d.events[0].confidence).toBe('medium');
    expect(() => server.coerceDigest({ headline: '' })).toThrow();
  });

  it('calls the user AI and moves on when a model is gone', async () => {
    const calls: { url: string; body: { model: string } }[] = [];
    const fake = async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (body.model === 'old-model') return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
      const content = JSON.stringify({ headline: 'Picnic on Saturday', key_points: [], decisions: [], action_items: [], open_questions: [], events: [] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    const msgs = [
      { id: '1', ts: Date.UTC(2026, 10, 20, 9), sender: 'Dana', text: 'Picnic Saturday?', media: false },
      { id: '2', ts: Date.UTC(2026, 10, 20, 10), sender: '+972501234567', text: 'Yes!', media: false },
    ];
    const r = await server.summarizeGroup(
      { provider: 'openrouter', apiKey: 'k' },
      ['old-model', 'new-model'],
      { chatName: 'Park', focus: '', language: 'English', timeZone: 'Asia/Jerusalem' },
      msgs,
      { fetchImpl: fake, referer: 'https://x' },
    );
    expect(r.model).toBe('new-model');
    expect(r.digest.headline).toBe('Picnic on Saturday');
    expect(r.count).toBe(2);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const prompt = JSON.stringify(calls[1].body);
    expect(prompt).toContain('[Fri 2026-11-20 11:00] Dana: Picnic Saturday?');
    expect(prompt).not.toContain('501234567');
  });

  it('gives a plain reason when the AI fails', () => {
    expect(server.friendlyAiError(new server.AiError('x', 429))).toMatch(/limit/);
    expect(server.friendlyAiError(new server.AiError('x', 401))).toMatch(/key/);
  });
});
