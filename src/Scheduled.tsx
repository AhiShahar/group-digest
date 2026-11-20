// Live sync > Scheduled digests: the sync server summarizes the chosen groups
// every day or week with this person's own AI, and the phone gets a push.
import { useEffect, useState } from 'react';
import {
  DEFAULT_SCHEDULE,
  fetchNotices,
  serverCanUse,
  type BridgeState,
  type DigestSchedule,
  type SyncNotice,
  type SyncPairing,
} from './lib/liveSync';
import { providerInfo } from './lib/providerInfo';
import type { AppSettings } from './lib/store';
import { ANDROID_WATCH, fmtWhen, noticesSupported, pickModels, turnOnNotices } from './lib/schedule';
import { isAndroidApp } from './lib/android';
import { currentSubscription, pushNeedsHomeScreen } from './lib/webpush';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

export function useNoticesOn(p: SyncPairing): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (isAndroidApp) return setOn(p.pushEndpoint === ANDROID_WATCH);
    currentSubscription().then((s) => setOn(!!s && s.endpoint === p.pushEndpoint), () => setOn(false));
  }, [p.pushEndpoint]);
  return on;
}

/** Live sync > Alerts: offline server, WhatsApp unlinked, digest ready. */
export function AlertsToggle({ p, member, onUpdate, onToast }: { p: SyncPairing; member: boolean; onUpdate: (p: SyncPairing) => Promise<void>; onToast: (s: string) => void }) {
  const on = useNoticesOn(p);
  if (on) return <p className="small ok">Alerts on for this phone</p>;
  if (!noticesSupported())
    return pushNeedsHomeScreen() ? <p className="small muted">Add Nutshell to your Home Screen to get alerts on this iPhone.</p> : null;
  return (
    <div className="row">
      <span className="small" style={{ flex: '1 1 200px' }}>
        {member ? 'Get a notification if WhatsApp unlinks you, or when a digest is ready.' : 'Get a notification if your server goes offline, WhatsApp unlinks it, or a digest is ready.'}
      </span>
      <button
        className="primary"
        onClick={async () => {
          try {
            onToast(await turnOnNotices(p, onUpdate));
          } catch (e) {
            onToast(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        Turn on alerts
      </button>
    </div>
  );
}

export function RecentNotices({ p }: { p: SyncPairing }) {
  const [list, setList] = useState<SyncNotice[]>([]);
  useEffect(() => {
    let stop = false;
    const load = () => fetchNotices(p).then((n) => !stop && setList(n.slice(-5).reverse()), () => undefined);
    load();
    const t = setInterval(load, 60e3);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [p]);
  if (!list.length) return null;
  return (
    <details className="small">
      <summary>Recent notices from the server ({list.length})</summary>
      <ul>
        {list.map((n) => (
          <li key={n.seq}>
            <b>{n.title}</b> <span className="muted">· {fmtWhen(n.at)}</span>
            <br />
            <span style={{ whiteSpace: 'pre-line' }}>{n.body}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function Scheduled({
  p,
  st,
  settings,
  onUpdate,
  onToast,
}: {
  p: SyncPairing;
  st: BridgeState;
  settings: AppSettings;
  onUpdate: (p: SyncPairing) => Promise<void>;
  onToast: (s: string) => void;
}) {
  const d: DigestSchedule = { ...DEFAULT_SCHEDULE, ...(p.digest ?? {}) };
  const [busy, setBusy] = useState(false);
  const noticesOn = useNoticesOn(p);
  const canServer = serverCanUse(settings);
  const tooOld = st.version < '0.4.0';
  const synced = st.groups.filter((g) => p.groups.includes(g.id));

  const save = async (patch: Partial<DigestSchedule>) => {
    setBusy(true);
    try {
      const next: DigestSchedule = { ...d, ...patch, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || d.tz };
      if (next.on && (!next.models.length || patch.on)) next.models = await pickModels(settings);
      await onUpdate({ ...p, digest: next });
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <>
      <h3>Scheduled digests</h3>
      {tooOld ? (
        <p className="small warn">
          Your sync server needs an update for this. It installs updates by itself within a few hours, or right away if you press Reboot on your
          instance in Oracle Cloud.
        </p>
      ) : (
        <>
          <p className="small muted">
            Your sync server summarizes your synced groups with your own AI ({providerInfo(settings.provider).label.replace(/^Free: /, '')}) and
            sends the digest here, even when the app is closed.
          </p>
          {!canServer && (
            <p className="small warn">
              {settings.provider === 'compatible'
                ? 'Your sync server cannot reach an AI on this computer. Pick another AI in AI and settings to use scheduled digests.'
                : 'Connect an AI in AI and settings first.'}
            </p>
          )}
          <div className="row">
            <label>
              How often
              <select
                value={d.on ? d.freq : 'off'}
                disabled={busy || (!canServer && !d.on)}
                onChange={(e) => save(e.target.value === 'off' ? { on: false } : { on: true, freq: e.target.value as DigestSchedule['freq'] })}
              >
                <option value="off">Off</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </select>
            </label>
            {d.on && d.freq === 'weekly' && (
              <label>
                On
                <select value={d.weekday} disabled={busy} onChange={(e) => save({ weekday: Number(e.target.value) })}>
                  {DAYS.map((name, i) => (
                    <option key={i} value={i}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {d.on && (
              <label>
                At
                <input
                  type="time"
                  value={`${pad(d.hour)}:${pad(d.minute)}`}
                  disabled={busy}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(':').map(Number);
                    if (!Number.isNaN(h)) save({ hour: h, minute: m || 0 });
                  }}
                />
              </label>
            )}
          </div>
          {d.on && (
            <>
              {synced.length > 1 && (
                <details className="small">
                  <summary>{d.groups.length ? `${d.groups.filter((g) => p.groups.includes(g)).length} of ${synced.length} groups` : 'All synced groups'}</summary>
                  <ul className="groups">
                    {synced.map((g) => (
                      <li key={g.id}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={!d.groups.length || d.groups.includes(g.id)}
                            onChange={(e) => {
                              const cur = d.groups.length ? d.groups : synced.map((x) => x.id);
                              const next = e.target.checked ? [...new Set([...cur, g.id])] : cur.filter((x) => x !== g.id);
                              save({ groups: next.length === synced.length ? [] : next });
                            }}
                          />
                          {g.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="small muted">
                To do this, the server keeps the chosen groups' messages, encrypted with your key, for up to {d.freq === 'weekly' ? 'nine' : 'three'}{' '}
                days. The first digest covers messages from when you turned this on. Groups with no new messages are skipped.
              </p>
              <div className="row">
                <button
                  disabled={busy}
                  onClick={async () => {
                    await save({ testAt: Date.now() });
                    onToast('Asked the server for a test digest of the last day. It arrives in a minute or two.');
                  }}
                >
                  Send a test digest now
                </button>
              </div>
              {!noticesOn && <p className="small muted">Turn on alerts above to get a notification when a digest is ready.</p>}
            </>
          )}
        </>
      )}
    </>
  );
}
