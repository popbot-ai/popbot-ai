import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  codexReasoningEffortsForModel,
  normalizeCodexModel,
} from './persistence';

describe('model registry', () => {
  it('defaults new Codex chats to GPT-5.6 Sol', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(normalizeCodexModel(null)).toBe('gpt-5.6-sol');
    expect(normalizeCodexModel('gpt-4o')).toBe('gpt-5.6-sol');
  });

  it('keeps existing gpt-5.5 chats on gpt-5.5 rather than silently re-pointing them', () => {
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.5');
  });

  it('exposes the GPT-5.6 tiers and Claude Sonnet 5', () => {
    expect(CODEX_MODELS).toContain('gpt-5.6-sol');
    expect(CODEX_MODELS).toContain('gpt-5.6-terra');
    expect(CODEX_MODELS).toContain('gpt-5.6-luna');
    expect(CLAUDE_MODELS).toContain('claude-sonnet-5');
  });

  it('offers `max` reasoning only on Sol', () => {
    expect(codexReasoningEffortsForModel('gpt-5.6-sol')).toContain('max');
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'] as const) {
      expect(codexReasoningEffortsForModel(model)).not.toContain('max');
    }
  });

  it('snaps a `max` chat to xhigh — not the default — when it moves off Sol', () => {
    expect(
      closestReasoningEffort(
        'max',
        codexReasoningEffortsForModel('gpt-5.6-terra'),
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    ).toBe('xhigh');
  });
});
