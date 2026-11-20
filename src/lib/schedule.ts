// Helpers for scheduled digests and server notices.
import { registerPush, type SyncPairing } from './liveSync';
import type { AppSettings } from './store';
import { enablePush } from './webpush';

/** Models for the server to try, best first (the same automatic choice the app makes). */
export async function pickModels(s: AppSettings): Promise<string[]> {
  const { modelCandidates } = await import('./providers');
  return (await modelCandidates(s)).slice(0, 4);
}

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Turn on Web Push for this room on this phone. Returns a message for the toast. */
export async function turnOnNotices(p: SyncPairing, onUpdate: (p: SyncPairing) => Promise<void>): Promise<string> {
  const sub = await enablePush();
  await registerPush(p, sub.toJSON());
  await onUpdate({ ...p, pushEndpoint: sub.endpoint });
  return 'Notifications are on for this phone.';
}

