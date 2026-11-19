import { describe, expect, it } from 'vitest';
import { isModelGone, rankModels } from './models';

describe('rankModels', () => {
  it('picks the newest stable Gemini flash and skips previews and lite', () => {
    const ids = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-4.0-flash-preview-11-2026', 'gemini-3.8-pro', 'gemini-flash-latest', 'text-embedding-004'];
    const r = rankModels('gemini', ids);
    expect(r[0]).toBe('gemini-3.8-flash');
    expect(r[1]).toBe('gemini-2.5-flash');
    expect(r).toContain('gemini-flash-latest');
  });
  it('picks the newest GPT mini', () => {
    expect(rankModels('openai', ['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.2-mini', 'gpt-5.2'])[0]).toBe('gpt-5.2-mini');
  });
  it('keeps the OpenRouter free router first', () => {
    expect(rankModels('openrouter', ['openrouter/free', 'x/y:free'])[0]).toBe('openrouter/free');
  });
  it('falls back to the first Claude model when the default is gone', () => {
    expect(rankModels('anthropic', ['claude-sonnet-6', 'claude-haiku-6'])[0]).toBe('claude-sonnet-6');
  });
});

describe('isModelGone', () => {
  it('recognizes retired-model errors', () => {
    expect(isModelGone(new Error('Provider error 404: This model models/gemini-2.5-flash is no longer available to new users.'))).toBe(true);
    expect(isModelGone({ status: 404, message: 'not_found_error' })).toBe(true);
    expect(isModelGone(new Error('The provider rejected the key (401).'))).toBe(false);
  });
});
