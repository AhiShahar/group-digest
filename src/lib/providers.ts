import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  DigestSchema,
  normalizeDigest,
  SCHEMA_HINT,
  SYSTEM_PROMPT,
  buildUserPrompt,
  chunkMessages,
  extractJson,
  formatTranscript,
  mergeDigests,
  sanitizeEvents,
  type Digest,
  type DigestRequest,
} from './digest';

import { providerInfo, type ProviderSettings } from './providerInfo';
import { upgradeDigest } from './decisions';
import { canTryAnotherModel, isTransient, rankModels } from './models';
import { z } from 'zod';
import { ASK_HINT, ASK_SYSTEM, AnswerSchema, type Answer } from './ask';
export type { ProviderSettings };

// Claude models that accept server-side fallbacks on refusal.
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5|sonnet-5-5)/;

// ---------- model lists ----------

export async function listModels(s: ProviderSettings): Promise<string[]> {
  switch (s.provider) {
    case 'anthropic': {
      const client = anthropicClient(s);
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    }
    case 'gemini': {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(s.apiKey)}`,
      );
      await assertOk(res);
      const data = (await res.json()) as { models: { name: string; supportedGenerationMethods?: string[] }[] };
      return data.models
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
    }
    case 'openrouter': {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      await assertOk(res);
      const data = (await res.json()) as { data: { id: string }[] };
      const ids = data.data.map((m) => m.id);
      // free models first, so the list is useful without credits
      return ['openrouter/free', ...ids.filter((id) => id.endsWith(':free')), 'openrouter/auto', ...ids.filter((id) => !id.endsWith(':free'))];
    }
    default: {
      const res = await fetch(`${openAiBase(s)}/models`, { headers: bearer(s) });
      await assertOk(res);
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data.map((m) => m.id).sort();
    }
  }
}

// ---------- one call ----------

/** What the model must return: a zod schema (Claude enforces it) and a text hint for the others. */
interface Shape {
  schema: z.ZodType;
  hint: string;
}
const DIGEST_SHAPE: Shape = { schema: DigestSchema, hint: SCHEMA_HINT };

async function callOnce(s: ProviderSettings, system: string, user: string, retryNote?: string, shape: Shape = DIGEST_SHAPE): Promise<unknown> {
  const userText = retryNote ? `${user}\n\n${retryNote}` : user;
  switch (s.provider) {
    case 'anthropic':
      return callAnthropic(s, system, userText, shape);
    case 'gemini':
      return callGemini(s, system, userText, shape);
    default:
      return callOpenAiCompatible(s, system, userText, shape);
  }
}

function anthropicClient(s: ProviderSettings) {
  // The key is the user's own and never leaves their device except to Anthropic.
  return new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
}

async function callAnthropic(s: ProviderSettings, system: string, user: string, shape: Shape): Promise<unknown> {
  const client = anthropicClient(s);
  const useFallbacks = FALLBACK_MODELS.test(s.model);
  const stream = client.beta.messages.stream({
    model: s.model,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low', format: betaZodOutputFormat(shape.schema as typeof DigestSchema) },
    ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error('Claude declined to summarize this chat.');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('The summary was cut off. Try a shorter time range.');
  }
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return extractJson(text);
}

async function callGemini(s: ProviderSettings, system: string, user: string, shape: Shape): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent?key=${encodeURIComponent(s.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${system}\n\n${shape.hint}` }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  await assertOk(res);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${data.promptFeedback.blockReason}).`);
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new Error(`Gemini sent back an empty answer${cand?.finishReason ? ` (finish reason ${cand.finishReason})` : ''}.`);
  return extractJson(text);
}

function openAiBase(s: ProviderSettings): string {
  if (s.provider === 'openai') return 'https://api.openai.com/v1';
  if (s.provider === 'openrouter') return 'https://openrouter.ai/api/v1';
  return s.baseUrl.replace(/\/+$/, '');
}

function bearer(s: ProviderSettings): Record<string, string> {
  return s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};
}

async function callOpenAiCompatible(s: ProviderSettings, system: string, user: string, shape: Shape): Promise<unknown> {
  const body: Record<string, unknown> = {
    model: s.model,
    messages: [
      { role: 'system', content: `${system}\n\n${shape.hint}` },
      { role: 'user', content: user },
    ],
  };
  // json_object mode is widely supported (OpenAI, OpenRouter, Ollama, LM Studio).
  body.response_format = { type: 'json_object' };
  const headers: Record<string, string> = { 'content-type': 'application/json', ...bearer(s) };
  if (s.provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Nutshell';
  }
  let res = await fetch(`${openAiBase(s)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status === 400) {
    // Some servers or models reject response_format: retry without it.
    delete body.response_format;
    res = await fetch(`${openAiBase(s)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  await assertOk(res);
  const data = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new Error(`The model declined: ${msg.refusal}`);
  return extractJson(msg?.content ?? '');
}

async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message ?? j?.message ?? JSON.stringify(j).slice(0, 300);
  } catch {
    detail = res.statusText;
  }
  const fail = (m: string) => Object.assign(new Error(m), { status: res.status });
  if (res.status === 401 || res.status === 403) throw fail(`The provider rejected the key (${res.status}). ${detail}`);
  if (res.status === 429) throw fail(`The AI is busy or the free limit is used up (429). ${detail}`);
  if (res.status === 402) throw fail(`The AI account has no credit left (402). ${detail}`);
  throw fail(`Provider error ${res.status}: ${detail}`);
}

// ---------- full digest ----------

async function digestOnce(s: ProviderSettings, user: string): Promise<Digest> {
  let raw: unknown;
  try {
    raw = await callOnce(s, SYSTEM_PROMPT, user);
  } catch (e) {
    if (!(e instanceof SyntaxError) && !String(e).includes('did not return JSON')) throw e;
    raw = await callOnce(s, SYSTEM_PROMPT, user, 'Your last reply was not valid JSON. Reply with only the JSON object.');
  }
  const parsed = DigestSchema.safeParse(normalizeDigest(upgradeDigest(raw)));
  if (parsed.success) return parsed.data;
  // Weaker models: retry once with the validation errors.
  const retry = await callOnce(
    s,
    SYSTEM_PROMPT,
    user,
    `Your last reply did not match the required shape: ${parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')}. Reply with only a corrected JSON object.`,
  );
  const again = DigestSchema.safeParse(normalizeDigest(upgradeDigest(retry)));
  if (again.success) return again.data;
  throw new Error(
    `The answer was not in the shape the app needs: ${again.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'reply'} ${i.message}`)
      .join('; ')}.`,
  );
}

const listCache = new Map<string, string[]>();

/**
 * Models to try, best first: the model picked in settings, then the other known
 * main models for that AI as backups. Backups the provider no longer lists are
 * left out. Only a custom server with no known list falls back to its own list.
 */
export async function modelCandidates(s: ProviderSettings): Promise<string[]> {
  const known = providerInfo(s.provider).models.map((m) => m.id);
  const chosen = s.model || known[0] || '';
  if (known.length) {
    let ids: string[] | null = null;
    try {
      ids = await cachedList(s);
    } catch {
      /* no list: keep every known model */
    }
    const backups = known.filter((m) => m !== chosen && (!ids || ids.includes(m)));
    return chosen ? [chosen, ...backups] : backups;
  }
  if (chosen) return [chosen];
  const ranked = rankModels(s.provider, await cachedList(s));
  if (!ranked.length) throw new Error('No models found for this AI. Type a model name in AI and settings.');
  return ranked;
}

async function cachedList(s: ProviderSettings): Promise<string[]> {
  const key = `${s.provider}|${s.baseUrl}|${s.apiKey.slice(-8)}`;
  let ids = listCache.get(key);
  if (!ids) {
    ids = await listModels(s);
    listCache.set(key, ids);
  }
  return ids;
}

export async function summarize(
  s: ProviderSettings,
  req: DigestRequest,
  onProgress?: (note: string) => void,
  onModel?: (model: string) => void,
): Promise<Digest> {
  const msgs = req.messages.filter((m) => m.text.trim() || m.media);
  if (!msgs.length) throw new Error('No messages in this time range.');
  const order = await modelCandidates(s);
  const state = { pick: 0 };
  const chunks = chunkMessages(msgs);
  const parts: Digest[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(chunks.length > 1 ? `Summarizing part ${i + 1} of ${chunks.length}…` : 'Summarizing…');
    const note = chunks.length > 1 ? `This is part ${i + 1} of ${chunks.length} of the chat, in order.` : '';
    const prompt = buildUserPrompt(req, formatTranscript(chunks[i]), note);
    parts.push(await withFallback(s, order, state, (cur) => digestOnce(cur, prompt), onModel, onProgress));
  }
  const merged = mergeDigests(parts);
  merged.events = sanitizeEvents(merged.events, msgs[0].ts, msgs[msgs.length - 1].ts);
  return merged;
}

// ---------- ask across groups ----------

/** Answer a question from the given transcript. Tries the next model when one is gone. */
export async function ask(s: ProviderSettings, user: string, onModel?: (m: string) => void): Promise<Answer> {
  const order = await modelCandidates(s);
  const shape: Shape = { schema: AnswerSchema, hint: ASK_HINT };
  return withFallback(s, order, { pick: 0 }, async (cur) => {
    let raw: unknown;
    try {
      raw = await callOnce(cur, ASK_SYSTEM, user, undefined, shape);
    } catch (e) {
      if (!(e instanceof SyntaxError) && !String(e).includes('did not return JSON')) throw e;
      raw = await callOnce(cur, ASK_SYSTEM, user, 'Your last reply was not valid JSON. Reply with only the JSON object.', shape);
    }
    const parsed = AnswerSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const r = raw as { answer?: unknown };
    if (typeof r?.answer === 'string') return { answer: r.answer, sources: [] };
    throw new Error('The AI answered in an unexpected shape.');
  }, onModel);
}

// ---------- trying models in turn ----------

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_MODELS = 5;

/**
 * Run one request, moving down the model list when a model fails for a reason
 * another model might not have (retired, paid-only on the free tier, overloaded,
 * unreadable reply). A busy model gets one more try first. `state.pick` carries
 * the working model across the parts of a long chat. When every model fails,
 * the error lists what each one said.
 */
export async function withFallback<T>(
  s: ProviderSettings,
  order: string[],
  state: { pick: number },
  run: (cur: ProviderSettings) => Promise<T>,
  onModel?: (model: string) => void,
  onProgress?: (note: string) => void,
): Promise<T> {
  const max = Math.min(order.length, MAX_MODELS);
  const tries: string[] = [];
  for (; state.pick < max; state.pick++) {
    const cur: ProviderSettings = { ...s, model: order[state.pick] };
    onModel?.(cur.model);
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await run(cur);
        return value;
      } catch (e) {
        if (attempt === 0 && isTransient(e)) {
          onProgress?.('The AI is busy, trying again…');
          await sleep(2500);
          continue;
        }
        tries.push(`${cur.model}: ${errText(e)}`);
        if (!canTryAnotherModel(e)) {
          throw new Error(tries.length > 1 ? `Tried ${tries.length} models.\n${tries.join('\n')}` : `${cur.model}: ${errText(e)}`);
        }
        break;
      }
    }
    if (state.pick + 1 < max) onProgress?.(`Trying another model (${order[state.pick + 1]})…`);
  }
  throw new Error(`Tried ${tries.length} model${tries.length === 1 ? '' : 's'} and none worked.\n${tries.join('\n')}`);
}
