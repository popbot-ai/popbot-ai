import type {
  AgentBackendId,
  ClaudeModelId,
  ClaudeReasoningEffort,
  CodexModelId,
  CodexReasoningEffort,
} from '@shared/persistence';
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_LABELS,
  CLAUDE_REASONING_EFFORTS,
  CODEX_MODELS,
  CODEX_MODEL_LABELS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  codexReasoningEffortsForModel,
  normalizeClaudeModel,
  normalizeCodexModel,
} from '@shared/persistence';
import type { MessageKey, Translator } from '@shared/i18n';
import { useTranslation } from '../lib/i18n';

export interface AgentCreateConfig {
  agent: AgentBackendId;
  claudeModel?: ClaudeModelId;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
}

export const AGENT_EFFORT_DEFAULTS_SETTING = 'agent.effortDefaults';

export type AgentEffortDefaultContext = 'general' | 'codeReview';

export interface AgentEffortDefaultsSettings {
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexReasoningEffort?: CodexReasoningEffort;
  codeReviewClaudeReasoningEffort?: ClaudeReasoningEffort;
  codeReviewCodexReasoningEffort?: CodexReasoningEffort;
}

export type NormalizedAgentEffortDefaults = Required<AgentEffortDefaultsSettings>;

const MODEL_OPTIONS = [
  ...CLAUDE_MODELS.map((model) => ({
    value: `claude:${model}`,
    label: CLAUDE_MODEL_LABELS[model],
    agent: 'claude' as const,
    model,
  })),
  ...CODEX_MODELS.map((model) => ({
    value: `codex:${model}`,
    label: CODEX_MODEL_LABELS[model],
    agent: 'codex' as const,
    model,
  })),
];

/** i18n keys for each reasoning-effort label — resolved via `t()` so the
 *  option labels follow the active locale. */
const REASONING_LABEL_KEYS: Record<ClaudeReasoningEffort | CodexReasoningEffort, MessageKey> = {
  none: 'agent.effort.none',
  low: 'agent.effort.low',
  medium: 'agent.effort.medium',
  high: 'agent.effort.high',
  xhigh: 'agent.effort.xhigh',
  max: 'agent.effort.max',
};

/** Localized label for a reasoning-effort value. Takes the caller's `t()`
 *  so the text follows the active locale (used by both the create-controls
 *  dropdown and the Preferences effort defaults). */
export function reasoningEffortLabel(
  effort: ClaudeReasoningEffort | CodexReasoningEffort,
  t: Translator,
): string {
  return t(REASONING_LABEL_KEYS[effort]);
}

export const DEFAULT_AGENT_CREATE_CONFIG: AgentCreateConfig = {
  agent: 'claude',
  claudeModel: DEFAULT_CLAUDE_MODEL,
  claudeReasoningEffort: DEFAULT_CLAUDE_REASONING_EFFORT,
  codexModel: DEFAULT_CODEX_MODEL,
  codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
};

export const DEFAULT_AGENT_EFFORT_DEFAULTS: NormalizedAgentEffortDefaults = {
  claudeReasoningEffort: DEFAULT_CLAUDE_REASONING_EFFORT,
  codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  codeReviewClaudeReasoningEffort: DEFAULT_CLAUDE_REASONING_EFFORT,
  codeReviewCodexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
};

export function normalizeAgentEffortDefaults(value: unknown): NormalizedAgentEffortDefaults {
  if (typeof value !== 'object' || value === null) return DEFAULT_AGENT_EFFORT_DEFAULTS;
  const raw = value as Partial<AgentEffortDefaultsSettings>;
  return {
    claudeReasoningEffort: closestReasoningEffort(
      raw.claudeReasoningEffort,
      CLAUDE_REASONING_EFFORTS,
      DEFAULT_CLAUDE_REASONING_EFFORT,
    ),
    codexReasoningEffort: closestReasoningEffort(
      raw.codexReasoningEffort,
      CODEX_REASONING_EFFORTS,
      DEFAULT_CODEX_REASONING_EFFORT,
    ),
    codeReviewClaudeReasoningEffort: closestReasoningEffort(
      raw.codeReviewClaudeReasoningEffort,
      CLAUDE_REASONING_EFFORTS,
      DEFAULT_CLAUDE_REASONING_EFFORT,
    ),
    codeReviewCodexReasoningEffort: closestReasoningEffort(
      raw.codeReviewCodexReasoningEffort,
      CODEX_REASONING_EFFORTS,
      DEFAULT_CODEX_REASONING_EFFORT,
    ),
  };
}

export function normalizeAgentCreateConfig(value: unknown): AgentCreateConfig {
  if (typeof value !== 'object' || value === null) return DEFAULT_AGENT_CREATE_CONFIG;
  const raw = value as Partial<AgentCreateConfig>;
  return {
    agent: raw.agent === 'codex' ? 'codex' : 'claude',
    claudeModel: normalizeClaudeModel(raw.claudeModel),
    claudeReasoningEffort: closestReasoningEffort(
      raw.claudeReasoningEffort,
      CLAUDE_REASONING_EFFORTS,
      DEFAULT_CLAUDE_REASONING_EFFORT,
    ),
    codexModel: normalizeCodexModel(raw.codexModel),
    codexReasoningEffort: closestReasoningEffort(
      raw.codexReasoningEffort,
      codexReasoningEffortsForModel(raw.codexModel),
      DEFAULT_CODEX_REASONING_EFFORT,
    ),
  };
}

export function agentCreateConfigWithEffortDefaults(
  value: unknown,
  defaultsValue: unknown,
  context: AgentEffortDefaultContext,
): AgentCreateConfig {
  const base = normalizeAgentCreateConfig(value);
  const defaults = normalizeAgentEffortDefaults(defaultsValue);
  return compactAgentCreateConfig({
    ...base,
    claudeReasoningEffort: context === 'codeReview'
      ? defaults.codeReviewClaudeReasoningEffort
      : defaults.claudeReasoningEffort,
    codexReasoningEffort: context === 'codeReview'
      ? defaults.codeReviewCodexReasoningEffort
      : defaults.codexReasoningEffort,
  });
}

export function compactAgentCreateConfig(value: AgentCreateConfig): AgentCreateConfig {
  return {
    agent: value.agent,
    claudeModel: normalizeClaudeModel(value.claudeModel),
    claudeReasoningEffort: closestReasoningEffort(
      value.claudeReasoningEffort,
      CLAUDE_REASONING_EFFORTS,
      DEFAULT_CLAUDE_REASONING_EFFORT,
    ),
    codexModel: normalizeCodexModel(value.codexModel),
    codexReasoningEffort: closestReasoningEffort(
      value.codexReasoningEffort,
      codexReasoningEffortsForModel(value.codexModel),
      DEFAULT_CODEX_REASONING_EFFORT,
    ),
  };
}

export function AgentCreateControls({
  value,
  onChange,
}: {
  value: AgentCreateConfig;
  onChange: (next: AgentCreateConfig) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const agent = value.agent;
  const claudeModel = normalizeClaudeModel(value.claudeModel);
  const codexModel = normalizeCodexModel(value.codexModel);
  const claudeEffort = value.claudeReasoningEffort ?? DEFAULT_CLAUDE_REASONING_EFFORT;
  const codexEffort = value.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
  const codexEffortOptions = codexReasoningEffortsForModel(codexModel);
  const effort = agent === 'codex'
    ? closestReasoningEffort(codexEffort, codexEffortOptions, DEFAULT_CODEX_REASONING_EFFORT)
    : closestReasoningEffort(claudeEffort, CLAUDE_REASONING_EFFORTS, DEFAULT_CLAUDE_REASONING_EFFORT);
  const effortOptions = agent === 'codex' ? codexEffortOptions : CLAUDE_REASONING_EFFORTS;
  const selectedModelValue = agent === 'codex'
    ? `codex:${codexModel}`
    : `claude:${claudeModel}`;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>{t('agent.label')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select
          className={`agent-select ${agent}`}
          title={t('agent.model')}
          aria-label={t('agent.model')}
          value={selectedModelValue}
          onChange={(e) => {
            const next = MODEL_OPTIONS.find((item) => item.value === e.currentTarget.value);
            if (!next) return;
            onChange({
              ...compactAgentCreateConfig(value),
              agent: next.agent,
              ...(next.agent === 'claude'
                ? { claudeModel: next.model }
                : { codexModel: next.model }),
            });
          }}
        >
          {MODEL_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
        <select
          className={`reasoning-select ${agent}`}
          title={t('agent.effort')}
          aria-label={t('agent.effort')}
          value={effort}
          onChange={(e) => {
            if (agent === 'codex') {
              onChange({
                ...compactAgentCreateConfig(value),
                codexReasoningEffort: e.currentTarget.value as CodexReasoningEffort,
              });
            } else {
              onChange({
                ...compactAgentCreateConfig(value),
                claudeReasoningEffort: e.currentTarget.value as ClaudeReasoningEffort,
              });
            }
          }}
        >
          {effortOptions.map((item) => (
            <option key={item} value={item}>{t(REASONING_LABEL_KEYS[item])}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
