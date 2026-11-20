import { createContext, useContext, useEffect, useState } from 'react';
import { bridge, canRemind as androidCanRemind, reminderIds } from './lib/android';
import type { DigestEvent } from './lib/digest';
import {
  DEFAULT_REMINDERS,
  LEAD_OPTIONS,
  REPEAT_OPTIONS,
  describePrefs,
  eventKey,
  remindersFor,
  type ReminderPrefs,
} from './lib/reminders';
import {
  currentSubscription,
  disablePush,
  hashKey,
  prefetchPushKey,
  pushCancel,
  pushNeedsHomeScreen,
  pushSchedule,
  pushScheduledHashes,
  pushSupported,
  pushTest,
} from './lib/webpush';

export const RemindersContext = createContext<ReminderPrefs>(DEFAULT_REMINDERS);
export const useReminderPrefs = () => useContext(RemindersContext);

/** Phone notifications come from the Android app's alarms, or from web push on the website. */
const webPush = !androidCanRemind && pushSupported();
const canRemind = androidCanRemind || webPush;
if (webPush) prefetchPushKey();

const changed = () => window.dispatchEvent(new Event('groupdigest-reminders'));

function isScheduled(key: string): boolean {
  if (androidCanRemind) return reminderIds().some((id) => id.slice(0, id.lastIndexOf('#')) === key);
  return pushScheduledHashes().has(hashKey(key));
}

/** Re-renders when reminders change. */
function useRemindersVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const f = () => setV((x) => x + 1);
    window.addEventListener('groupdigest-reminders', f);
    window.addEventListener('groupdigest-resume', f);
    return () => {
      window.removeEventListener('groupdigest-reminders', f);
      window.removeEventListener('groupdigest-resume', f);
    };
  }, []);
  return v;
}

/** Schedules notifications for these events. Returns how many reminders were set. */
export async function scheduleEvents(events: DigestEvent[], chatName: string, prefs: ReminderPrefs): Promise<number> {
  const keys = events.map((e) => eventKey(e, chatName));
  if (androidCanRemind && bridge?.scheduleReminders) {
    if (bridge.notificationsAllowed && !bridge.notificationsAllowed()) bridge.askNotificationPermission?.();
    keys.forEach((k) => bridge!.cancelReminders!(k + '#'));
    const all = events.flatMap((e) => remindersFor(e, chatName, prefs));
    if (all.length) bridge.scheduleReminders(JSON.stringify(all));
    changed();
    return all.length;
  }
  const all = events.flatMap((e) => remindersFor(e, chatName, prefs, Date.now(), true));
  const n = await pushSchedule(all, keys);
  changed();
  return n;
}

async function cancelEvent(key: string): Promise<void> {
  if (androidCanRemind) bridge!.cancelReminders!(key + '#');
  else await pushCancel(key);
  changed();
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ReminderButton({ e, chatName, onToast }: { e: DigestEvent; chatName: string; onToast: (s: string) => void }) {
  const prefs = useReminderPrefs();
  useRemindersVersion();
  const [busy, setBusy] = useState(false);
  if (!canRemind || !prefs.lead) return null;
  const key = eventKey(e, chatName);
  const on = isScheduled(key);
  if (!on && !remindersFor(e, chatName, prefs).length) return null; // already passed
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    try {
      onToast(await f());
    } catch (err) {
      onToast(errText(err));
    } finally {
      setBusy(false);
    }
  };
  if (on) {
    return (
      <button className="on-chip" disabled={busy} onClick={() => run(async () => (await cancelEvent(key), 'Reminders turned off for this event.'))}>
        Reminders on ✓
      </button>
    );
  }
  return (
    <button
      disabled={busy}
      onClick={() =>
        run(async () => {
          const n = await scheduleEvents([e], chatName, prefs);
          return n ? `Reminder set: ${describePrefs(prefs).toLowerCase()}.` : 'That time has already passed.';
        })
      }
    >
      Remind me
    </button>
  );
}

export function RemindAllButton({ events, chatName, onToast }: { events: DigestEvent[]; chatName: string; onToast: (s: string) => void }) {
  const prefs = useReminderPrefs();
  useRemindersVersion();
  const [busy, setBusy] = useState(false);
  const upcoming = events.filter((e) => remindersFor(e, chatName, prefs).length);
  if (!canRemind || !prefs.lead || upcoming.length < 2) return null;
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const n = await scheduleEvents(upcoming, chatName, prefs);
          onToast(n ? `${n} reminder${n === 1 ? '' : 's'} set.` : 'These events have already passed.');
        } catch (err) {
          onToast(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      Remind me about all {upcoming.length}
    </button>
  );
}

function WebPushControls({ onToast }: { onToast: (s: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  useRemindersVersion();
  useEffect(() => {
    currentSubscription().then((s) => setOn(!!s));
  }, []);
  if (pushNeedsHomeScreen()) {
    return (
      <p className="small">
        <strong>On iPhone:</strong> tap Share, then <b>Add to Home Screen</b>, and open Nutshell from there. Then you can turn on reminders
        here (iOS 16.4 or newer).
      </p>
    );
  }
  if (!pushSupported()) return <p className="muted small">This browser can't show reminders. Add events to your calendar instead.</p>;
  const act = async (f: () => Promise<void>, msg: string) => {
    try {
      await f();
      onToast(msg);
    } catch (err) {
      onToast(errText(err));
    }
    setOn(!!(await currentSubscription()));
    changed();
  };
  return (
    <div className="row">
      {on ? (
        <>
          <span className="small ok">Reminders are on for this device</span>
          <button onClick={() => act(pushTest, 'Test sent. It should arrive in a few seconds.')}>Send a test</button>
          <button className="link" onClick={() => act(disablePush, 'Reminders turned off on this device.')}>
            Turn off
          </button>
        </>
      ) : (
        <button className="primary" onClick={() => act(pushTest, 'Reminders are on. A test notification is on its way.')}>
          Turn on reminders
        </button>
      )}
    </div>
  );
}

export function ReminderSettings({ prefs, onChange, onToast }: { prefs: ReminderPrefs; onChange: (p: ReminderPrefs) => void; onToast: (s: string) => void }) {
  return (
    <>
      <h2>Event reminders</h2>
      <div className="card">
        <label>
          First reminder
          <select id="reminder-lead" value={prefs.lead} onChange={(ev) => onChange({ ...prefs, lead: Number(ev.target.value) })}>
            {LEAD_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {prefs.lead > 0 && (
          <label>
            Then
            <select id="reminder-repeat" value={prefs.repeat} onChange={(ev) => onChange({ ...prefs, repeat: Number(ev.target.value) })}>
              {REPEAT_OPTIONS.filter(([v]) => v === 0 || v < prefs.lead).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small">
          Tap <b>Remind me</b> on an event to get a notification at these times, even when the app is closed. Events you add with Apple / .ics
          also carry these reminders. Google and Outlook links use your calendar's own default reminder.
          {!androidCanRemind && ' Reminders from the website go through this app’s server with only the event title and time, never your chat.'}
        </p>
        {!androidCanRemind && prefs.lead > 0 && <WebPushControls onToast={onToast} />}
      </div>
    </>
  );
}
