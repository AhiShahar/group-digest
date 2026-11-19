import { createContext, useContext, useEffect, useState } from 'react';
import { bridge, canRemind, reminderIds } from './lib/android';
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

export const RemindersContext = createContext<ReminderPrefs>(DEFAULT_REMINDERS);
export const useReminderPrefs = () => useContext(RemindersContext);

/** Event keys that have reminders scheduled on this phone. Refreshes when reminders change. */
function useScheduled(): Set<string> {
  const read = () => new Set(reminderIds().map((id) => id.split('#')[0]));
  const [keys, setKeys] = useState(read);
  useEffect(() => {
    const f = () => setKeys(read());
    window.addEventListener('groupdigest-reminders', f);
    window.addEventListener('groupdigest-resume', f);
    return () => {
      window.removeEventListener('groupdigest-reminders', f);
      window.removeEventListener('groupdigest-resume', f);
    };
  }, []);
  return keys;
}

const changed = () => window.dispatchEvent(new Event('groupdigest-reminders'));

/** Schedules phone notifications for these events. Returns how many reminders were set. */
export function scheduleEvents(events: DigestEvent[], chatName: string, prefs: ReminderPrefs): number {
  if (!bridge?.scheduleReminders) return 0;
  if (bridge.notificationsAllowed && !bridge.notificationsAllowed()) bridge.askNotificationPermission?.();
  const all = events.flatMap((e) => {
    bridge!.cancelReminders!(eventKey(e, chatName) + '#');
    return remindersFor(e, chatName, prefs);
  });
  if (all.length) bridge.scheduleReminders(JSON.stringify(all));
  changed();
  return all.length;
}

export function ReminderButton({ e, chatName, onToast }: { e: DigestEvent; chatName: string; onToast: (s: string) => void }) {
  const prefs = useReminderPrefs();
  const scheduled = useScheduled();
  if (!canRemind || !prefs.lead) return null;
  const key = eventKey(e, chatName);
  if (!scheduled.has(key) && !remindersFor(e, chatName, prefs).length) return null; // already passed
  if (scheduled.has(key)) {
    return (
      <button
        className="on-chip"
        onClick={() => {
          bridge!.cancelReminders!(key + '#');
          changed();
          onToast('Reminders turned off for this event.');
        }}
      >
        Reminders on ✓
      </button>
    );
  }
  return (
    <button
      onClick={() => {
        const n = scheduleEvents([e], chatName, prefs);
        onToast(n ? `Reminder set: ${describePrefs(prefs).toLowerCase()}.` : 'That time has already passed.');
      }}
    >
      Remind me
    </button>
  );
}

export function RemindAllButton({ events, chatName, onToast }: { events: DigestEvent[]; chatName: string; onToast: (s: string) => void }) {
  const prefs = useReminderPrefs();
  useScheduled();
  const upcoming = events.filter((e) => remindersFor(e, chatName, prefs).length);
  if (!canRemind || !prefs.lead || upcoming.length < 2) return null;
  return (
    <button
      onClick={() => {
        const n = scheduleEvents(upcoming, chatName, prefs);
        onToast(n ? `${n} reminder${n === 1 ? '' : 's'} set.` : 'These events have already passed.');
      }}
    >
      Remind me about all {upcoming.length}
    </button>
  );
}

export function ReminderSettings({ prefs, onChange }: { prefs: ReminderPrefs; onChange: (p: ReminderPrefs) => void }) {
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
          {canRemind
            ? 'Tap Remind me on an event to get phone notifications at these times, even when the app is closed.'
            : 'Events you add with Apple / .ics carry these reminders, so your calendar alerts you even when this app is closed. Google and Outlook links use your calendar’s own default reminder.'}
        </p>
      </div>
    </>
  );
}
