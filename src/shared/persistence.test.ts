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

  it('adds Claude Fable 5.1 and GPT-6 Astra without dropping the models already offered', () => {
    expect(CLAUDE_MODELS).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
    ]);
    expect(CODEX_MODELS).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']);
  });

  it('keeps Opus 5 and Sol as the defaults — the newest tiers are opt-in only', () => {
    // Fable 5.1 and Astra are limited-availability launches at top-tier
    // pricing. A chat lands on them only because the user picked them.
    expect(DEFAULT_CLAUDE_MODEL).not.toBe('claude-fable-5-1');
    expect(DEFAULT_CODEX_MODEL).not.toBe('gpt-6-astra');
    expect(normalizeClaudeModel(undefined)).toBe('claude-opus-5');
    expect(normalizeCodexModel(undefined)).toBe('gpt-5.6-sol');
  });

  it('never rolls an existing chat forward onto Fable 5.1 or Astra', () => {
    expect(normalizeClaudeModel('claude-fable-5')).toBe('claude-fable-5');
    expect(normalizeClaudeModel('claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeClaudeModel('claude-opus-4-8')).toBe('claude-opus-5');
    for (const current of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const) {
      expect(normalizeCodexModel(current)).toBe(current);
    }
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.6-terra');
  });

  it('pins a chat that explicitly chose the newest tier', () => {
    expect(normalizeClaudeModel('claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(normalizeCodexModel('gpt-6-astra')).toBe('gpt-6-astra');
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

  it('offers each Codex model the reasoning ladder from the CLI model catalog', () => {
    // Per the catalog in Codex 0.153.x: every model reaches `max`; `ultra`
    // is the new top rung on Sol, Terra and Astra (Luna caps at `max`);
    // Astra alone has no `none` — it starts at `low`.
    for (const model of CODEX_MODELS) {
      expect(codexReasoningEffortsForModel(model)).toContain('max');
    }
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'] as const) {
      expect(codexReasoningEffortsForModel(model)).toContain('ultra');
    }
    expect(codexReasoningEffortsForModel('gpt-5.6-luna')).not.toContain('ultra');
    expect(codexReasoningEffortsForModel('gpt-6-astra')).not.toContain('none');
    expect(codexReasoningEffortsForModel('gpt-6-astra')[0]).toBe('low');
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const) {
      expect(codexReasoningEffortsForModel(model)[0]).toBe('none');
    }
  });

  it('snaps an `ultra` chat to `max` — not the default — when it moves to Luna', () => {
    expect(
      closestReasoningEffort(
        'ultra',
        codexReasoningEffortsForModel('gpt-5.6-luna'),
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    ).toBe('max');
  });

  it('snaps a `none` chat to `low` — not the default — when it moves to Astra', () => {
    expect(
      closestReasoningEffort(
        'none',
        codexReasoningEffortsForModel('gpt-6-astra'),
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    ).toBe('low');
  });

  it('keeps a chat on its own effort when the new model supports it', () => {
    expect(
      closestReasoningEffort(
        'xhigh',
        codexReasoningEffortsForModel('gpt-6-astra'),
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    ).toBe('xhigh');
  });
});
