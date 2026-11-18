import { z } from 'zod';
import type { ChatMessage } from './parser';

export const EventSchema = z.object({
  title: z.string(),
  date: z.string().describe('Absolute date, YYYY-MM-DD'),
  start_time: z.string().nullable().describe('24h HH:MM, or null if no time was given'),
  end_time: z.string().nullable().describe('24h HH:MM, or null'),
  location: z.string().nullable(),
  notes: z.string().nullable().describe('One line of useful detail: what to bring, who is coming'),
  source_quote: z.string().describe('The short message text the event came from'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const DigestSchema = z.object({
  headline: z.string().describe('One sentence: the most important thing that happened'),
  key_points: z.array(z.string()),
  decisions: z.array(z.string()),
  action_items: z.array(
    z.object({
      task: z.string(),
      owner: z.string().nullable(),
      due: z.string().nullable().describe('YYYY-MM-DD or null'),
    }),
  ),
  open_questions: z.array(z.string()),
  events: z.array(EventSchema),
});

export type Digest = z.infer<typeof DigestSchema>;
export type DigestEvent = z.infer<typeof EventSchema>;

export interface DigestRequest {
  chatName: string;
  messages: ChatMessage[];
  focus: string;
  language: string;
  timeZone: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Strip phone numbers that appear as sender names or in text. */
export function redactPhones(s: string): string {
  return s.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 9 ? `[phone …${digits.slice(-2)}]` : m;
  });
}

export function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const who = m.sender ? redactPhones(m.sender) : 'system';
      const text = m.media ? '[media]' : redactPhones(m.text);
      return `[${stamp(m.ts)}] ${who}: ${text}`;
    })
    .join('\n');
}

export const SYSTEM_PROMPT = `You summarize WhatsApp group chats for one member of the group who missed the conversation.
Rules:
- Be concise and concrete. Prefer names, dates, amounts and places over vague wording.
- Only report what the messages say. Never invent facts, times or people.
- Each message line starts with its own weekday, date and time. Resolve relative dates ("tomorrow", "next Thursday", "on the 25th") against the date of the message that mentions them, and output absolute dates as YYYY-MM-DD.
- An event is a plan with a date that the reader may want in their calendar (a meeting, a party, a deadline, a trip, a school day off). Skip events that were cancelled, and use the latest time if a plan was moved. If a plan has no date at all, put it in key_points, not events.
- Use null for unknown fields. Use empty arrays when there is nothing to report.
- Return only the JSON object, with no extra text.`;

export function buildUserPrompt(req: DigestRequest, transcript: string, partNote = ''): string {
  return [
    `Group: ${req.chatName}`,
    `Reader's time zone: ${req.timeZone}. Today is ${stamp(Date.now())}.`,
    `Write all text fields in ${req.language}.`,
    req.focus ? `The reader cares most about: ${req.focus}` : '',
    partNote,
    '',
    'Messages:',
    transcript,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** JSON shape description for providers without native schema enforcement. */
export const SCHEMA_HINT = `Return JSON with exactly these keys:
{"headline": string, "key_points": string[], "decisions": string[],
 "action_items": [{"task": string, "owner": string|null, "due": "YYYY-MM-DD"|null}],
 "open_questions": string[],
 "events": [{"title": string, "date": "YYYY-MM-DD", "start_time": "HH:MM"|null, "end_time": "HH:MM"|null,
             "location": string|null, "notes": string|null, "source_quote": string,
             "confidence": "high"|"medium"|"low"}]}`;

/** Roughly 4 characters per token. Default chunk is about 60k tokens of transcript. */
export function chunkMessages(messages: ChatMessage[], maxChars = 240_000): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  let cur: ChatMessage[] = [];
  let size = 0;
  for (const m of messages) {
    const len = m.text.length + 40;
    if (size + len > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Merge several partial digests (from chunked long chats) into one, dropping duplicates. */
export function mergeDigests(parts: Digest[]): Digest {
  if (parts.length === 1) return parts[0];
  const uniq = (xs: string[]) => [...new Set(xs)];
  const events = new Map<string, DigestEvent>();
  for (const p of parts) {
    for (const e of p.events) {
      // a later part wins, since a later message may have moved the plan
      events.set(`${e.title.toLowerCase().trim()}|${e.date}`, e);
    }
  }
  return {
    headline: parts[parts.length - 1].headline,
    key_points: uniq(parts.flatMap((p) => p.key_points)),
    decisions: uniq(parts.flatMap((p) => p.decisions)),
    action_items: parts.flatMap((p) => p.action_items),
    open_questions: uniq(parts.flatMap((p) => p.open_questions)),
    events: [...events.values()],
  };
}

/** Pull a JSON object out of model text that may include code fences or prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(body.slice(start, end + 1));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Check events in code rather than trusting the model: drop malformed dates,
 * clear bad times, and lower confidence for dates far from the chat window.
 */
export function sanitizeEvents(events: DigestEvent[], windowStart: number, windowEnd: number): DigestEvent[] {
  const day = 864e5;
  return events
    .filter((e) => DATE_RE.test(e.date) && !Number.isNaN(Date.parse(e.date)))
    .map((e) => {
      const out = { ...e };
      if (out.start_time && !TIME_RE.test(out.start_time)) out.start_time = null;
      if (out.end_time && (!TIME_RE.test(out.end_time) || !out.start_time)) out.end_time = null;
      const t = new Date(`${out.date}T00:00:00`).getTime();
      if (t < windowStart - 7 * day || t > windowEnd + 400 * day) out.confidence = 'low';
      return out;
    });
}
