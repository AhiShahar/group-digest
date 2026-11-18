import type { DigestEvent } from './digest';

const p2 = (n: number) => String(n).padStart(2, '0');

/** Event start/end as Date objects in the device's local time zone. */
export function eventTimes(e: DigestEvent): { start: Date; end: Date; allDay: boolean } {
  const [y, m, d] = e.date.split('-').map(Number);
  if (!e.start_time) {
    return { start: new Date(y, m - 1, d), end: new Date(y, m - 1, d + 1), allDay: true };
  }
  const [sh, sm] = e.start_time.split(':').map(Number);
  const start = new Date(y, m - 1, d, sh, sm);
  let end: Date;
  if (e.end_time) {
    const [eh, em] = e.end_time.split(':').map(Number);
    end = new Date(y, m - 1, d, eh, em);
    if (end <= start) end = new Date(end.getTime() + 864e5); // ends after midnight
  } else {
    end = new Date(start.getTime() + 60 * 60 * 1000); // default 1 hour
  }
  return { start, end, allDay: false };
}

const utc = (d: Date) =>
  `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}00Z`;
const dateOnly = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines at 75 octets as RFC 5545 requires, without splitting UTF-8 characters. */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

async function uid(e: DigestEvent, chatName: string): Promise<string> {
  // Stable UID: the same plan imported twice updates instead of duplicating.
  const data = new TextEncoder().encode(`${chatName}|${e.title.toLowerCase().trim()}|${e.date}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
  return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('') + '@group-digest';
}

function describe(e: DigestEvent, chatName: string): string {
  return [e.notes, `From WhatsApp group "${chatName}": "${e.source_quote}"`].filter(Boolean).join('\n\n');
}

export async function buildIcs(events: DigestEvent[], chatName: string): Promise<string> {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Group Digest//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const now = utc(new Date());
  for (const e of events) {
    const { start, end, allDay } = eventTimes(e);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${await uid(e, chatName)}`);
    lines.push(`DTSTAMP:${now}`);
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(start)}`, `DTEND;VALUE=DATE:${dateOnly(end)}`);
    } else {
      lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    lines.push(`DESCRIPTION:${escapeText(describe(e, chatName))}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Google Calendar "add event" link: works on any device without signing in to this app. */
export function googleCalendarUrl(e: DigestEvent, chatName: string): string {
  const { start, end, allDay } = eventTimes(e);
  const dates = allDay ? `${dateOnly(start)}/${dateOnly(end)}` : `${utc(start)}/${utc(end)}`;
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', e.title);
  u.searchParams.set('dates', dates);
  u.searchParams.set('details', describe(e, chatName));
  if (e.location) u.searchParams.set('location', e.location);
  return u.toString();
}

/** Outlook.com / Microsoft 365 web "add event" link. */
export function outlookCalendarUrl(e: DigestEvent, chatName: string): string {
  const { start, end, allDay } = eventTimes(e);
  const u = new URL('https://outlook.live.com/calendar/0/action/compose');
  u.searchParams.set('subject', e.title);
  u.searchParams.set('startdt', start.toISOString());
  u.searchParams.set('enddt', end.toISOString());
  if (allDay) u.searchParams.set('allday', 'true');
  u.searchParams.set('body', describe(e, chatName));
  if (e.location) u.searchParams.set('location', e.location);
  return u.toString();
}

export function downloadFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFilename(s: string): string {
  return s.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'events';
}
