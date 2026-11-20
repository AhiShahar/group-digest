// Helpers for scheduled digests and server notices (digest ready, health alerts).
import { bridge, isAndroidApp } from './android';
import { fetchNotices, registerPush, unregisterPush, type SyncNotice, type SyncPairing } from './liveSync';
import type { AppSettings } from './store';
import { currentSubscription, enablePush, pushSupported } from './webpush';

/** Models for the server to try, best first (the same automatic choice the app makes). */
export async function pickModels(s: AppSettings): Promise<string[]> {
  const { modelCandidates } = await import('./providers');
  return (await modelCandidates(s)).slice(0, 4);
}

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const ANDROID_WATCH = 'android';

/** This phone can show live-sync notices while the app is closed. */
export const noticesSupported = () => pushSupported() || !!bridge?.setNoticeWatch;

/** Turn on notices for this room on this phone (Web Push, or the Android app's background check). */
export async function turnOnNotices(p: SyncPairing, onUpdate: (p: SyncPairing) => Promise<void>): Promise<string> {
  if (isAndroidApp) {
    if (!bridge?.setNoticeWatch) throw new Error('Update the Nutshell app to get alerts.');
    bridge.askNotificationPermission?.();
    const seen = await fetchNotices(p).catch(() => [] as SyncNotice[]);
    bridge.setNoticeWatch(JSON.stringify({ relay: p.relay, room: p.room, secret: p.secret, after: Math.max(0, ...seen.map((n) => n.seq)) }));
    await onUpdate({ ...p, pushEndpoint: ANDROID_WATCH });
    return 'Alerts are on. The app checks about every half hour.';
  }
  const sub = await enablePush();
  await registerPush(p, sub.toJSON());
  await onUpdate({ ...p, pushEndpoint: sub.endpoint });
  return 'Notifications are on for this phone.';
}

/** Stop notices on this phone (when leaving or forgetting the sync server). */
export async function turnOffNotices(p: SyncPairing): Promise<void> {
  if (isAndroidApp) return bridge?.setNoticeWatch?.('');
  const sub = await currentSubscription().catch(() => null);
  if (sub && p.pushEndpoint === sub.endpoint) await unregisterPush(p, sub.endpoint).catch(() => undefined);
}

/** On app start: keep the Android background check pointed at the current room. */
export function refreshAndroidWatch(p: SyncPairing | undefined | null): void {
  if (!bridge?.setNoticeWatch) return;
  if (p?.pushEndpoint === ANDROID_WATCH) bridge.setNoticeWatch(JSON.stringify({ relay: p.relay, room: p.room, secret: p.secret, after: 0 }));
}

/** Health problems worth a banner: the newest offline/unlinked/health notice, unless a later one says it is fixed. */
export function openProblem(list: SyncNotice[]): SyncNotice | null {
  const health = list.filter((n) => ['offline', 'unlinked', 'health'].includes(n.tag)).sort((a, b) => a.seq - b.seq);
  const last = health[health.length - 1];
  if (!last || /back online|again|linked$/i.test(last.title) || Date.now() - last.at > 3 * 864e5) return null;
  return last;
}
