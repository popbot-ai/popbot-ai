import type {
  AgentBackendId,
  ClaudeModelId,
  ClaudeReasoningEffort,
  CodexModelId,
  CodexReasoningEffort,
} from '@shared/persistence';
import {
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  normalizeClaudeModel,
} from '@shared/persistence';
import type { MessageKey } from '@shared/i18n';
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
  {
    value: `claude:${DEFAULT_CLAUDE_MODEL}`,
    label: 'Claude Opus 4.8',
    agent: 'claude' as const,
    model: DEFAULT_CLAUDE_MODEL,
  },
  {
    value: 'claude:claude-fable-5',
    label: 'Claude Fable 5',
    agent: 'claude' as const,
    model: 'claude-fable-5' as const,
  },
  {
    value: `codex:${DEFAULT_CODEX_MODEL}`,
    label: 'GPT-5.5',
    agent: 'codex' as const,
    model: DEFAULT_CODEX_MODEL,
  },
] as const;

const REASONING_LABELS: Record<ClaudeReasoningEffort | CodexReasoningEffort, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

/** i18n keys for each reasoning-effort label — resolved inside the
 *  component via `t()` so the option labels follow the active locale. */
const REASONING_LABEL_KEYS: Record<ClaudeReasoningEffort | CodexReasoningEffort, MessageKey> = {
  none: 'agent.effort.none',
  low: 'agent.effort.low',
  medium: 'agent.effort.medium',
  high: 'agent.effort.high',
  xhigh: 'agent.effort.xhigh',
  max: 'agent.effort.max',
};

export function reasoningEffortLabel(effort: ClaudeReasoningEffort | CodexReasoningEffort): string {
  return REASONING_LABELS[effort];
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
    codexModel: DEFAULT_CODEX_MODEL,
    codexReasoningEffort: closestReasoningEffort(
      raw.codexReasoningEffort,
      CODEX_REASONING_EFFORTS,
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
    codexModel: DEFAULT_CODEX_MODEL,
    codexReasoningEffort: closestReasoningEffort(
      value.codexReasoningEffort,
      CODEX_REASONING_EFFORTS,
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
  const claudeEffort = value.claudeReasoningEffort ?? DEFAULT_CLAUDE_REASONING_EFFORT;
  const codexEffort = value.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
  const effort = agent === 'codex'
    ? closestReasoningEffort(codexEffort, CODEX_REASONING_EFFORTS, DEFAULT_CODEX_REASONING_EFFORT)
    : closestReasoningEffort(claudeEffort, CLAUDE_REASONING_EFFORTS, DEFAULT_CLAUDE_REASONING_EFFORT);
  const effortOptions = agent === 'codex' ? CODEX_REASONING_EFFORTS : CLAUDE_REASONING_EFFORTS;
  const selectedModelValue = agent === 'codex'
    ? `codex:${DEFAULT_CODEX_MODEL}`
    : `claude:${DEFAULT_CLAUDE_MODEL}`;

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
