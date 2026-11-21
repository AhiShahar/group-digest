// Provider metadata, kept separate so the UI loads without the SDKs.

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'compatible';

export interface ProviderSettings {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string; // only for "compatible"
  model: string;
}

export interface ModelChoice {
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  keyHelp: string;
  keyUrl?: string;
  /** The first entry of `models`, or empty when the user must type one. */
  defaultModel: string;
  /** Known, main models for this AI, best first. The settings dropdown lists these. */
  models: ModelChoice[];
  needsKey: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openrouter',
    label: 'Free: sign in with OpenRouter',
    keyHelp: 'One tap, no card needed. Uses free models (about 50 requests a day). Add OpenRouter credits later to use Claude, GPT or Gemini with the same sign-in.',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'openrouter/free',
    models: [{ id: 'openrouter/free', label: 'Free models, picked by OpenRouter' }],
    needsKey: true,
  },
  {
    id: 'gemini',
    label: 'Free: Google Gemini key',
    keyHelp: 'Free, no card needed: sign in to Google AI Studio, tap Create API key, and paste it here. Google may use free-tier content to improve its products.',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.8-flash',
    // Free-tier models as of November 2026. Flash-Lite gives more free summaries a day.
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (best)' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (more free uses a day)' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    ],
    needsKey: true,
  },
  {
    id: 'anthropic',
    label: 'Claude (paid API key)',
    keyHelp: 'Create a key in the Claude Console. A Claude.ai Pro or Max subscription cannot be used by other apps.',
    keyUrl: 'https://platform.claude.com/settings/keys',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
    ],
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI (paid API key)',
    keyHelp: 'Create a key on the OpenAI platform. Usage is billed to that account.',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5-mini',
    models: [
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-5', label: 'GPT-5' },
    ],
    needsKey: true,
  },
  {
    id: 'compatible',
    label: 'Local or other (OpenAI-compatible URL)',
    keyHelp: 'For Ollama, LM Studio or any OpenAI-compatible server. For Ollama use http://localhost:11434/v1 and allow this site in OLLAMA_ORIGINS.',
    defaultModel: '',
    models: [],
    needsKey: false,
  },
];

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!;


/** The label for a model ID: the dropdown name when it is a known model, else the ID itself. */
export const modelLabel = (id: string, p: ProviderId) => providerInfo(p).models.find((m) => m.id === id)?.label ?? id;
