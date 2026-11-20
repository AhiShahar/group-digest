import { describe, expect, it } from 'vitest';
import { decisionText, decisionWhen, upgradeDigest } from './decisions';
import { DigestSchema, SCHEMA_HINT, SYSTEM_PROMPT, mergeDigests } from './digest';
// @ts-expect-error plain JS module shared with the sync server
import { coerceDigest } from '../../public/bridge/digest.mjs';

const base = { headline: 'h', key_points: [], action_items: [], open_questions: [], events: [] };

describe('decisions', () => {
  it('upgrades old sentence decisions so old digests still show', () => {
    const old = { ...base, decisions: ['Supper club moved to Thursday', ''] };
    const up = upgradeDigest(old);
    expect(DigestSchema.safeParse(up).success).toBe(true);
    expect(up.decisions).toEqual([{ what: 'Supper club moved to Thursday', who: null, date: null, time: null, where: null }]);
    const fresh = { ...base, decisions: [{ what: 'x', who: null, date: null, time: null, where: null }] };
    expect(upgradeDigest(fresh)).toBe(fresh);
  });

  it('formats who, when and where', () => {
    const d = { what: 'Pick up Emily', who: 'Ahi', date: '2026-11-20', time: '16:30', where: 'Cherrybrook station' };
    expect(decisionWhen(d)).toMatch(/20/);
    expect(decisionWhen(d)).toMatch(/16:30$/);
    expect(decisionText(d)).toMatch(/^Pick up Emily \(Ahi; .*16:30; Cherrybrook station\)$/);
    expect(decisionText({ ...d, who: null, date: null, time: null, where: null })).toBe('Pick up Emily');
  });

  it('merges chunked digests without repeating a decision', () => {
    const d = (what: string, who: string | null) => ({ what, who, date: null, time: null, where: null });
    const m = mergeDigests([{ ...base, decisions: [d('Meet at 5', null)] }, { ...base, decisions: [d('meet at 5 ', 'Dana'), d('Bring food', null)] }]);
    expect(m.decisions.map((x) => x.who)).toEqual(['Dana', null]);
  });

  it('the server shapes decisions the same way, from objects or sentences', () => {
    const out = coerceDigest({
      headline: 'h',
      decisions: ['Old style', { what: 'New style', who: 'Ahi', date: '2026-11-19', time: '17:00', where: 'RSL' }, { what: 'Bad date', date: 'Thursday', time: '5pm' }, {}],
    });
    expect(out.decisions).toEqual([
      { what: 'Old style', who: null, date: null, time: null, where: null },
      { what: 'New style', who: 'Ahi', date: '2026-11-19', time: '17:00', where: 'RSL' },
      { what: 'Bad date', who: null, date: null, time: null, where: null },
    ]);
    expect(DigestSchema.safeParse(out).success).toBe(true);
    expect(SYSTEM_PROMPT).toContain('A decision is');
    expect(SCHEMA_HINT).toContain('"who"');
  });
});
