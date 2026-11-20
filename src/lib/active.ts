// Long group lists: show the groups that had a message in the last month, and
// tuck the quiet ones away behind a "show" button.

export const ACTIVE_DAYS = 30;

export interface Split<T> {
  shown: T[];
  hidden: T[];
  /** No item has a known last-message time yet, so everything is shown. */
  unknown: boolean;
}

/**
 * Split items into recently active (or kept, e.g. already chosen) and quiet.
 * When nothing has a known time yet (a server that just started watching),
 * everything is shown rather than hiding the whole list.
 */
export function splitActive<T>(
  items: T[],
  lastOf: (t: T) => number | undefined,
  keep: (t: T) => boolean = () => false,
  now = Date.now(),
  days = ACTIVE_DAYS,
): Split<T> {
  if (!items.some((t) => (lastOf(t) ?? 0) > 0)) return { shown: items, hidden: [], unknown: true };
  const cutoff = now - days * 864e5;
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const t of items) ((lastOf(t) ?? 0) >= cutoff || keep(t) ? shown : hidden).push(t);
  return { shown, hidden, unknown: false };
}
