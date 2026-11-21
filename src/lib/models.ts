// Automatic model choice. Providers retire models often, so the app never
// relies on a fixed model ID: it reads the provider's live model list and
// picks the newest fast general model. An empty model setting means automatic.

import type { ProviderId } from './providerInfo';

export const AUTO = '';

/** Model IDs the app used to hard-code. Saved settings holding one of these become automatic. */
export const LEGACY_DEFAULTS = new Set(['gemini-2.5-flash', 'gpt-5-mini', 'llama3.1']);

const SKIP = /(preview|exp|image|tts|audio|live|thinking|embed|vision|search|realtime|transcribe|instruct|codex|nano|guard|learnlm|aqa|gemma|veo|imagen|robotics|computer|lite)/i;

function version(id: string, re: RegExp): number | null {
  const m = id.match(re);
  if (!m) return null;
  const [maj, min = '0'] = m[1].split('.');
  return Number(maj) * 1000 + Number(min);
}

function newest(ids: string[], re: RegExp): string[] {
  return ids
    .filter((id) => !SKIP.test(id))
    .map((id) => ({ id, v: version(id, re) }))
    .filter((x): x is { id: string; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v || a.id.length - b.id.length)
    .map((x) => x.id);
}

/** Models in order of preference for summarizing. The first is the pick; the rest are fallbacks. */
export function rankModels(provider: ProviderId, ids: string[]): string[] {
  const out: string[] = [];
  const add = (xs: string[]) => xs.forEach((x) => ids.includes(x) && !out.includes(x) && out.push(x));
  switch (provider) {
    case 'gemini':
      add(newest(ids, /^gemini-(\d+(?:\.\d+)?)-flash(?:-\d{3})?$/));
      add(['gemini-flash-latest']);
      add(newest(ids, /^gemini-(\d+(?:\.\d+)?)-pro(?:-\d{3})?$/));
      add(ids.filter((id) => id.includes('flash') && !/(image|tts|audio|live|embed)/.test(id)));
      break;
    case 'openai':
      add(newest(ids, /^gpt-(\d+(?:\.\d+)?)-mini$/));
      add(newest(ids, /^gpt-(\d+(?:\.\d+)?)$/));
      break;
    case 'anthropic':
      // The list comes newest first. Opus 5.5 at low effort is the tested default.
      add(['claude-opus-5-5']);
      add(ids.filter((id) => /^claude-(opus|sonnet)-/.test(id)));
      break;
    case 'openrouter':
      add(['openrouter/free']);
      add(ids.filter((id) => id.endsWith(':free')));
      break;
  }
  add(ids);
  return out;
}

/** True when an error means the model itself is gone or unknown, so another model may work. */
export function isModelGone(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  const msg = String((e as Error)?.message ?? e);
  if (status === 404) return true;
  if (/Provider error 404/.test(msg)) return true;
  return /(no longer available|not found|not_found|does not exist|deprecated|decommissioned|retired|unknown model|invalid model|model .*not (?:supported|available))/i.test(msg);
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: number })?.status;
  if (typeof s === 'number') return s;
  const m = String((e as Error)?.message ?? e).match(/\((\d{3})\)|Provider error (\d{3})/);
  return m ? Number(m[1] ?? m[2]) : undefined;
}

/** The key itself is wrong: no other model will help. */
export function isKeyProblem(e: unknown): boolean {
  const s = statusOf(e);
  const msg = String((e as Error)?.message ?? e);
  return s === 401 || s === 403 || /rejected the key|API key not valid|invalid api key/i.test(msg);
}

/** The phone is offline or the provider can't be reached at all. */
export function isNetworkProblem(e: unknown): boolean {
  return /Failed to fetch|NetworkError|Load failed|network connection/i.test(String((e as Error)?.message ?? e));
}

/** A short hiccup on the provider's side: worth one more try on the same model. */
export function isTransient(e: unknown): boolean {
  const s = statusOf(e);
  if (s !== undefined && s >= 500) return true;
  return /overloaded|UNAVAILABLE|try again later|temporarily|high demand|internal error/i.test(String((e as Error)?.message ?? e));
}

/**
 * Whether another model on the same account might work. True for almost
 * everything: a model that is gone, paid-only on the free tier (429 with a
 * zero quota), overloaded, rejecting the request (400), or replying in a shape
 * the app can't read. False only when no model could help.
 */
export function canTryAnotherModel(e: unknown): boolean {
  if (isKeyProblem(e) || isNetworkProblem(e)) return false;
  const msg = String((e as Error)?.message ?? e);
  if (/No messages in this time range|credit left|\(402\)/i.test(msg)) return false;
  return true;
}
