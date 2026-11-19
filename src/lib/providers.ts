import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  DigestSchema,
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

import type { ProviderSettings } from './providerInfo';
import { isModelGone, rankModels } from './models';
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

async function callOnce(s: ProviderSettings, system: string, user: string, retryNote?: string): Promise<unknown> {
  const userText = retryNote ? `${user}\n\n${retryNote}` : user;
  switch (s.provider) {
    case 'anthropic':
      return callAnthropic(s, system, userText);
    case 'gemini':
      return callGemini(s, system, userText);
    default:
      return callOpenAiCompatible(s, system, userText);
  }
}

function anthropicClient(s: ProviderSettings) {
  // The key is the user's own and never leaves their device except to Anthropic.
  return new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
}

async function callAnthropic(s: ProviderSettings, system: string, user: string): Promise<unknown> {
  const client = anthropicClient(s);
  const useFallbacks = FALLBACK_MODELS.test(s.model);
  const stream = client.beta.messages.stream({
    model: s.model,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low', format: betaZodOutputFormat(DigestSchema) },
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

async function callGemini(s: ProviderSettings, system: string, user: string): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent?key=${encodeURIComponent(s.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${system}\n\n${SCHEMA_HINT}` }] },
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
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
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

async function callOpenAiCompatible(s: ProviderSettings, system: string, user: string): Promise<unknown> {
  const body: Record<string, unknown> = {
    model: s.model,
    messages: [
      { role: 'system', content: `${system}\n\n${SCHEMA_HINT}` },
      { role: 'user', content: user },
    ],
  };
  // json_object mode is widely supported (OpenAI, OpenRouter, Ollama, LM Studio).
  body.response_format = { type: 'json_object' };
  const headers: Record<string, string> = { 'content-type': 'application/json', ...bearer(s) };
  if (s.provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Group Digest';
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
  if (res.status === 401 || res.status === 403) throw new Error(`The provider rejected the key (${res.status}). ${detail}`);
  if (res.status === 429) throw new Error(`The AI is busy or the free daily limit is used up (429). Try again in a minute, or tomorrow. ${detail}`);
  if (res.status === 402) throw new Error(`The AI account has no credit left (402). ${detail}`);
  throw new Error(`Provider error ${res.status}: ${detail}`);
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
  const parsed = DigestSchema.safeParse(raw);
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
  return DigestSchema.parse(retry);
}

const listCache = new Map<string, string[]>();

/** Models to try, best first: the user's chosen model (if any), then the provider's newest suitable ones. */
export async function modelCandidates(s: ProviderSettings): Promise<string[]> {
  const key = `${s.provider}|${s.baseUrl}|${s.apiKey.slice(-8)}`;
  let ids = listCache.get(key);
  if (!ids) {
    try {
      ids = await listModels(s);
      listCache.set(key, ids);
    } catch (e) {
      if (!s.model) throw e;
      ids = [];
    }
  }
  const ranked = rankModels(s.provider, ids);
  const order = s.model ? [s.model, ...ranked.filter((m) => m !== s.model)] : ranked;
  if (!order.length) throw new Error('No models found for this AI. Type a model name in AI and settings.');
  return order;
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
  let pick = 0;
  let cur: ProviderSettings = { ...s, model: order[0] };
  onModel?.(cur.model);
  const chunks = chunkMessages(msgs);
  const parts: Digest[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(chunks.length > 1 ? `Summarizing part ${i + 1} of ${chunks.length}…` : 'Summarizing…');
    const note = chunks.length > 1 ? `This is part ${i + 1} of ${chunks.length} of the chat, in order.` : '';
    const prompt = buildUserPrompt(req, formatTranscript(chunks[i]), note);
    for (;;) {
      try {
        parts.push(await digestOnce(cur, prompt));
        break;
      } catch (e) {
        // The model was retired or renamed: move on to the next one on the provider's list.
        if (!isModelGone(e) || pick + 1 >= Math.min(order.length, 4)) throw e;
        pick++;
        cur = { ...s, model: order[pick] };
        onModel?.(cur.model);
        onProgress?.(`Switching to ${cur.model}…`);
      }
    }
  }
  const merged = mergeDigests(parts);
  merged.events = sanitizeEvents(merged.events, msgs[0].ts, msgs[msgs.length - 1].ts);
  return merged;
}
