import { describe, expect, it } from 'vitest';
import { friendlyClaudeModel, lastAssistantModel } from '../src/claude-transcript-model.js';

const assistant = (model: string) => JSON.stringify({ type: 'assistant', message: { model, content: [] } });
const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'say "assistant"' } });

describe('lastAssistantModel', () => {
  it('names the model of the newest assistant record, so it follows an in-session /model', () => {
    const tail = [assistant('claude-opus-5-5'), user, assistant('claude-sonnet-5'), user, ''].join('\n');
    expect(lastAssistantModel(tail)).toBe('claude-sonnet-5');
  });

  it('skips the cut first line of a byte tail and records claude writes itself', () => {
    const cut = assistant('claude-haiku-5-5').slice(20);
    expect(lastAssistantModel(`${cut}\n${user}\n`)).toBeUndefined();
    const tail = [assistant('claude-opus-5-5'), assistant('<synthetic>'), user].join('\n');
    expect(lastAssistantModel(tail)).toBe('claude-opus-5-5');
  });

  it('is undefined for an empty tail or one without an assistant record', () => {
    expect(lastAssistantModel('')).toBeUndefined();
    expect(lastAssistantModel(`${user}\n${JSON.stringify({ type: 'assistant', message: {} })}`)).toBeUndefined();
  });
});

describe('friendlyClaudeModel', () => {
  it('names a model id the way the statusline does', () => {
    expect(friendlyClaudeModel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(friendlyClaudeModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(friendlyClaudeModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('leaves an id it does not recognize alone', () => {
    expect(friendlyClaudeModel('qwen3.8-27b')).toBe('qwen3.8-27b');
    expect(friendlyClaudeModel('claude-sonnet')).toBe('claude-sonnet');
  });
});
