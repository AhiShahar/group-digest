// Scheduled digests on the sync server: the prompt (kept in step with the app's
// src/lib/digest.ts, which a test checks), a small AI client for the user's own
// provider, and the schedule maths. No dependencies, so it is easy to test.

export const SYSTEM_PROMPT = `You summarize WhatsApp group chats for one member of the group who missed the conversation.
Rules:
- Be concise and concrete. Prefer names, dates, amounts and places over vague wording.
- Only report what the messages say. Never invent facts, times or people.
- Each message line starts with its own weekday, date and time. Resolve relative dates ("tomorrow", "next Thursday", "on the 25th") against the date of the message that mentions them, and output absolute dates as YYYY-MM-DD.
- An event is a plan with a date that the reader may want in their calendar (a meeting, a party, a deadline, a trip, a school day off). Skip events that were cancelled, and use the latest time if a plan was moved. If a plan has no date at all, put it in key_points, not events.
- A decision is something the group agreed on or settled. For each, give what was decided in a few words, who decided or is responsible, and the date, time and place it is about, if any.
- Call people by the name others in the chat use for them when that is clear, rather than a username.
- Use null for unknown fields. Use empty arrays when there is nothing to report.
- Return only the JSON object, with no extra text.`;

export const SCHEMA_HINT = `Return JSON with exactly these keys:
{"headline": string, "key_points": string[],
 "decisions": [{"what": string, "who": string|null, "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "where": string|null}],
 "action_items": [{"task": string, "owner": string|null, "due": "YYYY-MM-DD"|null}],
 "open_questions": string[],
 "events": [{"title": string, "date": "YYYY-MM-DD", "start_time": "HH:MM"|null, "end_time": "HH:MM"|null,
             "location": string|null, "notes": string|null, "source_quote": string,
             "confidence": "high"|"medium"|"low"}]}`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local date parts in a time zone (the server runs in UTC; the reader does not). */
export function localParts(ts, tz) {
  let f;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  } catch {
    f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday), wd: p.weekday };
}

function stamp(ts, tz) {
  const p = localParts(ts, tz);
  return `${p.wd} ${p.ymd} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function redactPhones(s) {
  return s.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 9 ? `[phone …${digits.slice(-2)}]` : m;
  });
}

export function formatTranscript(messages, tz) {
  return messages
    .map((m) => `[${stamp(m.ts, tz)}] ${m.sender ? redactPhones(m.sender) : 'system'}: ${m.media ? '[media]' : redactPhones(m.text)}`)
    .join('\n');
}

export function buildUserPrompt({ chatName, focus, language, timeZone }, transcript, now = Date.now()) {
  return [
    `Group: ${chatName}`,
    `Reader's time zone: ${timeZone}. Today is ${stamp(now, timeZone)}.`,
    `Write all text fields in ${language}.`,
    focus ? `The reader cares most about: ${focus}` : '',
    '',
    'Messages:',
    transcript,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ---- schedule -------------------------------------------------------------------

/**
 * The period a scheduled digest belongs to, or null when it is not due yet.
 * Daily: every day from the chosen time. Weekly: on the chosen weekday from that time.
 * Twice a day: from each of the two chosen times (keys end in "a" and "b").
 * A server that was off at the time catches up later the same day.
 */
export function duePeriod(sched, now = Date.now()) {
  if (!sched || !sched.on) return null;
  const p = localParts(now, sched.tz);
  const nowMin = p.hour * 60 + p.minute;
  const at = (Number(sched.hour) || 0) * 60 + (Number(sched.minute) || 0);
  if (sched.freq === 'twice') {
    const at2 = (Number(sched.hour2 ?? 18) || 0) * 60 + (Number(sched.minute2) || 0);
    const [first, second] = at <= at2 ? [at, at2] : [at2, at];
    if (nowMin >= second && second !== first) return `${p.ymd}b`;
    if (nowMin >= first) return `${p.ymd}a`;
    return null;
  }
  if (nowMin < at) return null;
  if (sched.freq === 'weekly' && p.weekday !== (Number(sched.weekday) || 0)) return null;
  return p.ymd;
}

// ---- answers from the model --------------------------------------------------------

export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(body.slice(start, end + 1));
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v) => (Array.isArray(v) ? v.map(str).filter((x) => x.trim()) : []);

/** Shape whatever the model returned into a digest the app accepts. */
export function coerceDigest(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!str(r.headline).trim()) throw new Error('The model returned an empty summary.');
  return {
    headline: str(r.headline),
    key_points: strs(r.key_points),
    decisions: (Array.isArray(r.decisions) ? r.decisions : [])
      .map((d) => (typeof d === 'string' ? { what: d } : d && typeof d === 'object' ? d : {}))
      .filter((d) => str(d.what).trim())
      .map((d) => ({
        what: str(d.what),
        who: strOrNull(d.who),
        date: /^\d{4}-\d{2}-\d{2}$/.test(str(d.date)) ? str(d.date) : null,
        time: /^\d{1,2}:\d{2}$/.test(str(d.time)) ? str(d.time) : null,
        where: strOrNull(d.where),
      })),
    action_items: (Array.isArray(r.action_items) ? r.action_items : [])
      .filter((a) => a && str(a.task).trim())
      .map((a) => ({ task: str(a.task), owner: strOrNull(a.owner), due: strOrNull(a.due) })),
    open_questions: strs(r.open_questions),
    events: (Array.isArray(r.events) ? r.events : [])
      .filter((e) => e && str(e.title).trim() && /^\d{4}-\d{2}-\d{2}$/.test(str(e.date)))
      .map((e) => ({
        title: str(e.title),
        date: str(e.date),
        start_time: strOrNull(e.start_time),
        end_time: strOrNull(e.end_time),
        location: strOrNull(e.location),
        notes: strOrNull(e.notes),
        source_quote: str(e.source_quote),
        confidence: ['high', 'medium', 'low'].includes(e.confidence) ? e.confidence : 'medium',
      })),
  };
}

// ---- the user's AI provider -------------------------------------------------------

export class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** True when the model is gone or unknown, so the next one on the list may work. */
export const modelGone = (e) =>
  e?.status === 404 || /(no longer available|not found|not_found|does not exist|deprecated|decommissioned|retired|unknown model|invalid model)/i.test(String(e?.message ?? e));

async function check(res) {
  if (res.ok) return res.json();
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message ?? j?.message ?? JSON.stringify(j).slice(0, 200);
  } catch {
    detail = res.statusText;
  }
  throw new AiError(`AI error ${res.status}: ${detail}`, res.status);
}

/** One call to the user's AI. ai = {provider, apiKey, baseUrl}. Returns the model's text. */
export async function callAi(ai, model, system, user, { referer = '', fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(180e3);
  if (ai.provider === 'anthropic') {
    const j = await check(
      await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 16000, system: `${system}\n\n${SCHEMA_HINT}`, messages: [{ role: 'user', content: user }] }),
        signal: timeout,
      }),
    );
    if (j.stop_reason === 'refusal') throw new AiError('Claude declined to summarize this chat.', 400);
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (ai.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ai.apiKey)}`;
    const j = await check(
      await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${system}\n\n${SCHEMA_HINT}` }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: timeout,
      }),
    );
    if (j.promptFeedback?.blockReason) throw new AiError(`Gemini blocked the request (${j.promptFeedback.blockReason}).`, 400);
    return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  }
  const base =
    ai.provider === 'openai' ? 'https://api.openai.com/v1' : ai.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : String(ai.baseUrl || '').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (ai.apiKey) headers.authorization = `Bearer ${ai.apiKey}`;
  if (ai.provider === 'openrouter') Object.assign(headers, { 'HTTP-Referer': referer, 'X-Title': 'Nutshell' });
  const body = { model, messages: [{ role: 'system', content: `${system}\n\n${SCHEMA_HINT}` }, { role: 'user', content: user }], response_format: { type: 'json_object' } };
  let res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: timeout });
  if (res.status === 400) {
    delete body.response_format;
    res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: timeout });
  }
  const j = await check(res);
  const msg = j.choices?.[0]?.message;
  if (msg?.refusal) throw new AiError(`The model declined: ${msg.refusal}`, 400);
  return msg?.content ?? '';
}

const MAX_TRANSCRIPT = 200_000; // characters, about 50k tokens: plenty for a day or a week

/** Summarize one group. Tries the models in order when one is gone. Returns {digest, model}. */
export async function summarizeGroup(ai, models, req, messages, opts = {}) {
  let list = messages.filter((m) => m.text?.trim() || m.media);
  let transcript = formatTranscript(list, req.timeZone);
  while (transcript.length > MAX_TRANSCRIPT && list.length > 50) {
    list = list.slice(Math.ceil(list.length / 5)); // keep the newest
    transcript = formatTranscript(list, req.timeZone);
  }
  const user = buildUserPrompt(req, transcript, opts.now);
  const order = models?.length ? models.slice(0, 4) : [];
  if (!order.length) throw new AiError('No AI model chosen. Open AI and settings in the app and tap Check connection.', 400);
  let lastErr;
  for (const model of order) {
    try {
      let raw;
      try {
        raw = extractJson(await callAi(ai, model, SYSTEM_PROMPT, user, opts));
      } catch (e) {
        if (!(e instanceof SyntaxError) && !/did not return JSON/.test(String(e))) throw e;
        raw = extractJson(await callAi(ai, model, SYSTEM_PROMPT, `${user}\n\nYour last reply was not valid JSON. Reply with only the JSON object.`, opts));
      }
      return { digest: coerceDigest(raw), model, from: list[0]?.ts ?? 0, to: list[list.length - 1]?.ts ?? 0, count: list.length };
    } catch (e) {
      lastErr = e;
      if (!modelGone(e)) throw e;
    }
  }
  throw lastErr;
}

/** A short, plain reason for a failed scheduled digest, for the notification. */
export function friendlyAiError(e) {
  const s = e?.status;
  const msg = String(e?.message ?? e);
  if (s === 401 || s === 403) return 'The AI did not accept your key. Open AI and settings and sign in again.';
  if (s === 429) return 'The free AI limit was used up. It will try again at the next scheduled time.';
  if (s === 402) return 'The AI account has no credit left.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|timeout/i.test(msg)) return 'The server could not reach your AI.';
  return 'The AI could not make the summary this time.';
}
