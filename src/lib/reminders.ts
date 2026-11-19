// Event reminders: how far ahead and how often to remind. Used for the alarms
// inside calendar files and for phone notifications in the Android app.

import type { DigestEvent } from './digest';
import { eventTimes } from './calendar';

export interface ReminderPrefs {
  /** Minutes before the event of the first reminder. 0 turns reminders off. */
  lead: number;
  /** Minutes between reminders after the first one, until the event. 0 means only once. */
  repeat: number;
}

export const DEFAULT_REMINDERS: ReminderPrefs = { lead: 1440, repeat: 0 };

export const LEAD_OPTIONS: [number, string][] = [
  [0, 'No reminders'],
  [15, '15 minutes before'],
  [30, '30 minutes before'],
  [60, '1 hour before'],
  [120, '2 hours before'],
  [1440, '1 day before'],
  [2880, '2 days before'],
  [10080, '1 week before'],
];

export const REPEAT_OPTIONS: [number, string][] = [
  [0, 'Just once'],
  [60, 'Every hour until it starts'],
  [180, 'Every 3 hours until it starts'],
  [1440, 'Every day until it starts'],
];

/** All-day events are reminded relative to 9:00 on the day. */
export const ALL_DAY_HOUR = 9;
const MAX_REMINDERS = 8;

/** Minutes before the start for each reminder, earliest first. */
export function reminderOffsets(p: ReminderPrefs): number[] {
  if (!p.lead) return [];
  const out: number[] = [];
  for (let m = p.lead; m > 0 && out.length < MAX_REMINDERS; m -= p.repeat || p.lead) out.push(m);
  return out;
}

export function describePrefs(p: ReminderPrefs): string {
  if (!p.lead) return 'No reminders';
  const lead = LEAD_OPTIONS.find(([v]) => v === p.lead)?.[1] ?? `${p.lead} minutes before`;
  if (!p.repeat) return lead;
  const rep = REPEAT_OPTIONS.find(([v]) => v === p.repeat)?.[1].toLowerCase() ?? '';
  return `${lead}, then ${rep}`;
}

/** The moment reminders count back from: the start time, or 9:00 for all-day events. */
export function reminderBase(e: DigestEvent): Date {
  const { start, allDay } = eventTimes(e);
  return allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), ALL_DAY_HOUR) : start;
}

export interface ScheduledReminder {
  id: string;
  at: number;
  title: string;
  body: string;
}

const fmtLead = (m: number) =>
  m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`;

/** Reminders still in the future for one event. `minimal` leaves the place and group name out of the text, for reminders sent through the push server. */
export function remindersFor(e: DigestEvent, chatName: string, p: ReminderPrefs, now = Date.now(), minimal = false): ScheduledReminder[] {
  const base = reminderBase(e).getTime();
  const when = new Date(eventTimes(e).start).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(e.start_time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  return reminderOffsets(p)
    .map((m) => ({
      id: `${eventKey(e, chatName)}#${m}`,
      at: base - m * 60_000,
      title: e.title,
      body: minimal ? `In ${fmtLead(m)}: ${when}` : `In ${fmtLead(m)}: ${when}${e.location ? ` · ${e.location}` : ''} (${chatName})`,
    }))
    .filter((r) => r.at > now);
}

/** Stable key for an event, so the same plan found twice is reminded once. */
export function eventKey(e: DigestEvent, chatName: string): string {
  return `${chatName}|${e.title.trim().toLowerCase()}|${e.date}`;
}

/** VALARM blocks for a calendar file, matching the reminder settings. */
export function icsAlarms(e: DigestEvent, p: ReminderPrefs): string[] {
  const allDay = !e.start_time;
  const lines: string[] = [];
  for (const m of reminderOffsets(p)) {
    // All-day DTSTART is midnight, so shift the trigger to count back from 9:00.
    const minutes = allDay ? m - ALL_DAY_HOUR * 60 : m;
    const trigger = minutes >= 0 ? `-PT${minutes}M` : `PT${-minutes}M`;
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${e.title.replace(/[,;\\]/g, ' ').replace(/\r?\n/g, ' ')}`, `TRIGGER:${trigger}`, 'END:VALARM');
  }
  return lines;
}
