// Decisions in digests: who, when, where and what. No zod here, so the store
// and the service worker can use it cheaply.
import type { Decision } from './digest';

/**
 * Decisions used to be plain sentences. Turn those (in stored digests, from an
 * older sync server, or from a model that ignored the shape) into the new form.
 */
export function upgradeDigest<T>(raw: T): T {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { decisions?: unknown }).decisions)) return raw;
  const r = raw as unknown as { decisions: unknown[] };
  if (r.decisions.every((x) => x && typeof x === 'object')) return raw;
  return {
    ...raw,
    decisions: r.decisions
      .filter((x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object'))
      .map((x) => (typeof x === 'string' ? { what: x, who: null, date: null, time: null, where: null } : x)),
  };
}

/** "Thu 19 Nov, 16:30", "Thu 19 Nov", "16:30" or null. */
export function decisionWhen(d: Decision): string | null {
  const day = d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
  return [day, d.time].filter(Boolean).join(', ') || null;
}

/** One line for sharing as text: "What (who; when; where)". */
export function decisionText(d: Decision): string {
  const extra = [d.who, decisionWhen(d), d.where].filter(Boolean).join('; ');
  return extra ? `${d.what} (${extra})` : d.what;
}
