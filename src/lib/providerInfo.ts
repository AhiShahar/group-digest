// Provider metadata, kept separate so the UI loads without the SDKs.

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'compatible';

export interface ProviderSettings {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string; // only for "compatible"
  model: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  keyHelp: string;
  keyUrl?: string;
  defaultModel: string;
  needsKey: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openrouter',
    label: 'Free: sign in with OpenRouter',
    keyHelp: 'One tap, no card needed. Uses free models (about 50 requests a day). Add OpenRouter credits later to use Claude, GPT or Gemini with the same sign-in.',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'openrouter/free',
    needsKey: true,
  },
  {
    id: 'gemini',
    label: 'Free: Google Gemini key',
    keyHelp: 'Free, no card needed: sign in to Google AI Studio, tap Create API key, and paste it here. Google may use free-tier content to improve its products.',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
  },
  {
    id: 'anthropic',
    label: 'Claude (paid API key)',
    keyHelp: 'Create a key in the Claude Console. A Claude.ai Pro or Max subscription cannot be used by other apps.',
    keyUrl: 'https://platform.claude.com/settings/keys',
    defaultModel: 'claude-opus-5-5',
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI (paid API key)',
    keyHelp: 'Create a key on the OpenAI platform. Usage is billed to that account.',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5-mini',
    needsKey: true,
  },
  {
    id: 'compatible',
    label: 'Local or other (OpenAI-compatible URL)',
    keyHelp: 'For Ollama, LM Studio or any OpenAI-compatible server. For Ollama use http://localhost:11434/v1 and allow this site in OLLAMA_ORIGINS.',
    defaultModel: 'llama3.1',
    needsKey: false,
  },
];

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!;

