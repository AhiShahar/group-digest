import { describe, expect, it } from 'vitest';
import { DigestSchema, normalizeDigest } from './digest';
import { canTryAnotherModel, isTransient } from './models';
import { withFallback } from './providers';
import type { ProviderSettings } from './providerInfo';

const s = { provider: 'gemini', apiKey: 'k', model: '', baseUrl: '' } as unknown as ProviderSettings;
const err = (m: string, status?: number) => Object.assign(new Error(m), status ? { status } : {});

describe('normalizeDigest', () => {
  it('fills missing lists and null fields so a small summary is kept', () => {
    const raw = {
      headline: 'Picnic on Sunday',
      key_points: ['Bring snacks'],
      events: [{ title: 'Picnic', date: '2026-11-22', confidence: 'High' }],
      decisions: [{ what: 'Meet at the park' }],
    };
    const d = DigestSchema.parse(normalizeDigest(raw));
    expect(d.open_questions).toEqual([]);
    expect(d.action_items).toEqual([]);
    expect(d.events[0]).toMatchObject({ start_time: null, location: null, source_quote: '', confidence: 'high' });
    expect(d.decisions[0]).toMatchObject({ what: 'Meet at the park', who: null });
  });
  it('unwraps a wrapper object', () => {
    const d = DigestSchema.parse(normalizeDigest({ digest: { headline: 'Hi', key_points: [] } }));
    expect(d.headline).toBe('Hi');
  });
  it('leaves unrelated JSON alone so it still fails', () => {
    expect(DigestSchema.safeParse(normalizeDigest({ foo: 1 })).success).toBe(false);
  });
});

describe('error kinds', () => {
  it('tries another model for quota, overload, bad request and bad shape, not for a bad key', () => {
    expect(canTryAnotherModel(err('The AI is busy or the free limit is used up (429). limit: 0', 429))).toBe(true);
    expect(canTryAnotherModel(err('Provider error 503: The model is overloaded.', 503))).toBe(true);
    expect(canTryAnotherModel(err('Provider error 400: Invalid argument', 400))).toBe(true);
    expect(canTryAnotherModel(err('The answer was not in the shape the app needs'))).toBe(true);
    expect(canTryAnotherModel(err('The provider rejected the key (403).', 403))).toBe(false);
    expect(canTryAnotherModel(err('Failed to fetch'))).toBe(false);
    expect(isTransient(err('Provider error 503: overloaded', 503))).toBe(true);
    expect(isTransient(err('Provider error 400: bad', 400))).toBe(false);
  });
});

describe('withFallback', () => {
  it('moves to the next model and reports which one worked', async () => {
    const used: string[] = [];
    const v = await withFallback(s, ['a', 'b', 'c'], { pick: 0 }, async (cur) => {
      if (cur.model === 'a') throw err('quota (429) limit: 0', 429);
      return cur.model;
    }, (m) => used.push(m));
    expect(v).toBe('b');
    expect(used).toEqual(['a', 'b']);
  });
  it('stops at once on a bad key', async () => {
    let calls = 0;
    await expect(
      withFallback(s, ['a', 'b'], { pick: 0 }, async () => {
        calls++;
        throw err('The provider rejected the key (401).', 401);
      }),
    ).rejects.toThrow(/a: The provider rejected the key/);
    expect(calls).toBe(1);
  });
  it('lists every model when all fail', async () => {
    await expect(
      withFallback(s, ['a', 'b'], { pick: 0 }, async (cur) => {
        throw err(`Provider error 400: nope ${cur.model}`, 400);
      }),
    ).rejects.toThrow(/Tried 2 models and none worked.\na: Provider error 400: nope a\nb: Provider error 400/);
  });
});

describe('modelCandidates', () => {
  it('starts with the picked model and keeps only known Gemini models as backups', async () => {
    const { modelCandidates } = await import('./providers');
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-carbon', 'gemini-3.1-flash-lite'].map((n) => ({
            name: `models/${n}`,
            supportedGenerationMethods: ['generateContent'],
          })),
        }),
      )) as typeof fetch;
    try {
      const order = await modelCandidates({ ...s, apiKey: 'test-list-key', model: 'gemini-3.5-flash-lite' });
      expect(order).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);
      const dflt = await modelCandidates({ ...s, apiKey: 'test-list-key', model: '' });
      expect(dflt[0]).toBe('gemini-3.8-flash');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
