import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_LABELS,
  CODEX_MODELS,
  CODEX_MODEL_LABELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  codexReasoningEffortsForModel,
  normalizeClaudeModel,
  normalizeCodexModel,
} from './persistence';

describe('model registry', () => {
  it('defaults new Codex chats to GPT-5.6 Sol', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(normalizeCodexModel(null)).toBe('gpt-5.6-sol');
    expect(normalizeCodexModel('gpt-4o')).toBe('gpt-5.6-sol');
  });

  it('rolls retired gpt-5.5 chats forward to Terra, its price/performance equal', () => {
    // Not Sol: rolling a mid-tier chat onto the flagship would quietly raise
    // its cost, so retired models map to the closest tier, not the default.
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.6-terra');
    expect(CODEX_MODELS).not.toContain('gpt-5.5');
  });

  it('exposes the GPT-5.6 tiers and Claude Sonnet 5', () => {
    expect(CODEX_MODELS).toContain('gpt-5.6-sol');
    expect(CODEX_MODELS).toContain('gpt-5.6-terra');
    expect(CODEX_MODELS).toContain('gpt-5.6-luna');
    expect(CLAUDE_MODELS).toContain('claude-sonnet-5');
  });

  it('defaults new Claude chats to Opus 5', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5');
    expect(normalizeClaudeModel(null)).toBe('claude-opus-5');
    expect(normalizeClaudeModel('gpt-4o')).toBe('claude-opus-5');
  });

  it('rolls retired Opus chats forward to the current Opus', () => {
    // The Opus line supersedes itself and old versions retire upstream, so a
    // chat pinned to one must move rather than fail at request time.
    for (const retired of [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
    ]) {
      expect(normalizeClaudeModel(retired)).toBe('claude-opus-5');
    }
    expect(CLAUDE_MODELS).not.toContain('claude-opus-4-8');
  });

  it('leaves non-Opus Claude chats on their pinned model', () => {
    expect(normalizeClaudeModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizeClaudeModel('claude-fable-5')).toBe('claude-fable-5');
  });

  it('labels every model in the pickers', () => {
    for (const model of CLAUDE_MODELS) {
      expect(CLAUDE_MODEL_LABELS[model]).toBeTruthy();
    }
    for (const model of CODEX_MODELS) {
      expect(CODEX_MODEL_LABELS[model]).toBeTruthy();
    }
  });

  it('offers `max` reasoning only on Sol', () => {
    expect(codexReasoningEffortsForModel('gpt-5.6-sol')).toContain('max');
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna'] as const) {
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
