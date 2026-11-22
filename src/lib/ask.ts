// Across groups: search every stored group, ask the AI a question about them,
// and gather open to-dos, upcoming dates and recent decisions from digests.
import { z } from 'zod';
import { formatTranscript, type Decision, type DigestEvent } from './digest';
import type { ChatMessage } from './parser';
import type { StoredChat, StoredDigest } from './store';
import { chatTitle } from './title';

export const AnswerSchema = z.object({
  answer: z.string().describe('A short, direct answer. Say plainly if the messages do not answer it.'),
  sources: z.array(
    z.object({
      group: z.string(),
      date: z.string().describe('YYYY-MM-DD of the message'),
      quote: z.string().describe('A short quote from the message'),
    }),
  ),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const ASK_SYSTEM = `You answer questions about the reader's WhatsApp groups, using only the messages given.
Rules:
- Answer briefly and concretely: names, dates, times, places, amounts.
- Only use what the messages say. If they do not answer the question, say so plainly.
- Each message line starts with its weekday, date and time. Resolve relative dates against the date of the message, and give absolute dates.
- When plans changed, give the latest version and say it changed.
- List up to 5 sources: the group, the message date (YYYY-MM-DD) and a short quote.
- Return only the JSON object, with no extra text.`;

export const ASK_HINT = `Return JSON with exactly these keys:
{"answer": string, "sources": [{"group": string, "date": "YYYY-MM-DD", "quote": string}]}`;

// ---- search ------------------------------------------------------------------------

export interface Hit {
  chatId: string;
  chat: string;
  m: ChatMessage;
  score: number;
}

const STOP = new Set(
  'the and for are was were what when where who whom which how why does did do is it its this that with from have has had will would can could about any there their they them our you your not but all into over just than then also been more some such only very של את על עם זה זו מה מי מתי איפה איך למה גם או אם כי לא כן יש אין הוא היא הם הן אני אנחנו אתה את אתם כל עוד רק'.split(' '),
);

/** Words worth matching: letters or digits in any script, 2+ characters, minus common filler. */
export function terms(q: string): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

/** Hebrew attaches prefixes (ו, ה, ב, ל, מ, ש, כ) to words: match a term inside a word too. */
function scoreText(text: string, ts: string[]): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const term of ts) if (t.includes(term)) score += term.length >= 4 ? 2 : 1;
  return score;
}

/** Messages matching the query, best and newest first. Every term must appear when there are 1-2 terms. */
export function search(chats: StoredChat[], q: string, limit = 100): Hit[] {
  const ts = terms(q);
  if (!ts.length) return [];
  const need = ts.length <= 2 ? ts.length : Math.ceil(ts.length / 2);
  const hits: Hit[] = [];
  for (const c of chats) {
    for (const m of c.messages) {
      if (!m.text) continue;
      const hay = `${m.sender ?? ''} ${m.text}`.toLowerCase();
      const matched = ts.filter((t) => hay.includes(t)).length;
      if (matched >= need) hits.push({ chatId: c.id, chat: chatTitle(c), m, score: scoreText(hay, ts) });
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.m.ts - a.m.ts).slice(0, limit);
}

/**
 * The messages to show the AI for a question: messages that match its words,
 * with a little context around each, grouped by chat in time order. Without
 * matches, the last week of every group. Capped at about maxChars.
 */
export function askContext(chats: StoredChat[], question: string, maxChars = 120_000): { text: string; count: number; groups: number } {
  const ts = terms(question);
  const picked = new Map<string, Set<number>>(); // chat id -> message indexes
  if (ts.length) {
    const scored: { c: StoredChat; i: number; s: number }[] = [];
    for (const c of chats) c.messages.forEach((m, i) => {
      const s = scoreText(`${m.sender ?? ''} ${m.text}`, ts);
      if (s) scored.push({ c, i, s });
    });
    scored.sort((a, b) => b.s - a.s || b.c.messages[b.i].ts - a.c.messages[a.i].ts);
    for (const { c, i } of scored.slice(0, 250)) {
      const set = picked.get(c.id) ?? new Set<number>();
      for (let j = Math.max(0, i - 2); j <= Math.min(c.messages.length - 1, i + 2); j++) set.add(j);
      picked.set(c.id, set);
    }
  }
  if (!picked.size) {
    const from = Date.now() - 7 * 864e5;
    for (const c of chats) {
      const set = new Set<number>();
      c.messages.forEach((m, i) => m.ts >= from && set.add(i));
      if (set.size) picked.set(c.id, set);
    }
  }
  const parts: string[] = [];
  let size = 0;
  let count = 0;
  // Newest groups first, so the cap trims old material.
  const order = chats.filter((c) => picked.has(c.id)).sort((a, b) => (b.messages.at(-1)?.ts ?? 0) - (a.messages.at(-1)?.ts ?? 0));
  for (const c of order) {
    let msgs = [...picked.get(c.id)!].sort((a, b) => a - b).map((i) => c.messages[i]);
    let block = `## Group: ${chatTitle(c)}\n${formatTranscript(msgs)}`;
    while (size + block.length > maxChars && msgs.length > 20) {
      msgs = msgs.slice(Math.ceil(msgs.length / 4));
      block = `## Group: ${chatTitle(c)}\n${formatTranscript(msgs)}`;
    }
    if (size + block.length > maxChars) break;
    parts.push(block);
    size += block.length;
    count += msgs.length;
  }
  return { text: parts.join('\n\n'), count, groups: parts.length };
}

export function askPrompt(question: string, context: string, language: string): string {
  return [`Reader's time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Today is ${new Date().toDateString()}.`, `Answer in ${language}.`, `Question: ${question}`, '', 'Messages:', context].join('\n');
}

// ---- overview from digests -----------------------------------------------------------

export interface TodoItem {
  key: string;
  chatId: string;
  chat: string;
  task: string;
  owner: string | null;
  due: string | null;
  from: number;
}

export interface DateItem {
  key: string;
  chatId: string;
  chat: string;
  e: DigestEvent;
}

export interface Overview {
  todos: TodoItem[];
  dates: DateItem[];
  decisions: { chatId: string; chat: string; d: Decision; at: number }[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * To-dos, upcoming dates and decisions from each group's recent digests (last
 * `days` days). A newer digest wins when two mention the same event.
 */
export function overview(chats: StoredChat[], digests: StoredDigest[], today: string, days = 21, now = Date.now()): Overview {
  const name = new Map(chats.map((c) => [c.id, chatTitle(c)]));
  const recent = digests.filter((d) => name.has(d.chatId) && d.createdAt >= now - days * 864e5).sort((a, b) => a.createdAt - b.createdAt);
  const todos = new Map<string, TodoItem>();
  const dates = new Map<string, DateItem>();
  const decisions: Overview['decisions'] = [];
  for (const d of recent) {
    const chat = name.get(d.chatId)!;
    for (const a of d.digest.action_items) {
      const key = `${d.chatId}|${norm(a.task)}`;
      todos.set(key, { key, chatId: d.chatId, chat, task: a.task, owner: a.owner, due: a.due, from: d.createdAt });
    }
    for (const e of d.digest.events) {
      if (e.date < today) continue;
      const key = `${d.chatId}|${norm(e.title)}`;
      dates.set(key, { key, chatId: d.chatId, chat, e });
    }
    for (const x of d.digest.decisions) decisions.push({ chatId: d.chatId, chat, d: x, at: d.createdAt });
  }
  const byDue = (a: TodoItem, b: TodoItem) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.from - a.from;
  return {
    todos: [...todos.values()].sort(byDue),
    dates: [...dates.values()].sort((a, b) => (a.e.date + (a.e.start_time ?? '')).localeCompare(b.e.date + (b.e.start_time ?? ''))),
    // Newest digest first; a decision repeated in a later digest shows once.
    decisions: [...new Map(decisions.sort((a, b) => b.at - a.at).reverse().map((x) => [`${x.chatId}|${norm(x.d.what)}`, x])).values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, 15),
  };
}
