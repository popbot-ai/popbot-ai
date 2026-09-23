/**
 * Pieces shared by PopBot's two Codex backends — the exec SDK one
 * (CodexBackend) and the app-server one (CodexAppServerBackend). Both
 * have to translate PopBot's permission policy and effort ladder the
 * same way, classify the same failures the same way, and mint row ids
 * that can never collide, whichever one a chat happens to be running on.
 */
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  codexReasoningEffortsForModel,
} from '@shared/persistence';
import type { SpawnOpts } from './types';

/**
 * Turn failures that are the account's situation rather than a fault in
 * PopBot or Codex: the model isn't offered to this login (GPT-6 Astra is
 * API-key only today — a ChatGPT-account login gets "not supported when
 * using Codex with a ChatGPT account"), or usage / rate limits are hit.
 * Retrying can't help, and nothing is broken; the user just needs to know.
 * Yellow, not red.
 */
export const EXPECTED_CODEX_LIMIT =
  /not supported when using codex|not (?:available|supported) (?:for|on|with) (?:your|this)|(?:do not|don't|doesn't) have access|usage limit|rate limit|quota|out of (?:usage|credits?)|insufficient (?:credit|quota|balance)|billing|payment|upgrade your plan|limit (?:will )?reset/i;

/** The value Codex expects for `model_reasoning_effort`. */
export type CodexWireReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export function codexWireReasoningEffort(
  model: string,
  effort: SpawnOpts['codexReasoningEffort'] | undefined,
): CodexWireReasoningEffort {
  // Snap to a rung this model actually accepts. The floor and ceiling
  // both vary — GPT-6 Astra has no `none` (it starts at `low`), and
  // `max` / `ultra` aren't on every model — so a chat that switches
  // models keeps the nearest equivalent instead of sending a value the
  // API would reject.
  const resolved = closestReasoningEffort(
    effort ?? DEFAULT_CODEX_REASONING_EFFORT,
    codexReasoningEffortsForModel(model),
    DEFAULT_CODEX_REASONING_EFFORT,
  );
  // PopBot calls the API's `minimal` rung `none` in the UI.
  return resolved === 'none' ? 'minimal' : resolved;
}

export interface CodexPermissions {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  networkAccessEnabled: boolean;
  webSearchMode: 'disabled' | 'cached' | 'live';
}

/** Translate PopBot's provider-neutral permission policy into the coarser
 * controls exposed by Codex. Unspecified/Ask capabilities fail closed because
 * neither backend surfaces interactive approval events to PopBot yet. */
export function codexPermissions(opts: Pick<SpawnOpts, 'resolveRule'>): CodexPermissions {
  const decision = (tool: string) => opts.resolveRule?.(tool) ?? null;
  const writesAllowed = ['Write', 'Edit', 'NotebookEdit'].every(
    (tool) => decision(tool) === 'allow',
  );
  const broadFilesystemAllowed =
    decision('Bash') === 'allow'
    && decision('Read') === 'allow'
    && writesAllowed;
  // Both web capabilities must be allowed before arbitrary command execution
  // receives network. This is deliberately fail-closed: once Bash has network,
  // it can fetch URLs regardless of which executable performs the request.
  const networkAccessEnabled =
    decision('WebFetch') === 'allow' && decision('WebSearch') === 'allow';
  const sandboxMode: CodexPermissions['sandboxMode'] = broadFilesystemAllowed && networkAccessEnabled
    ? 'danger-full-access'
    : writesAllowed
      ? 'workspace-write'
      : 'read-only';
  return {
    sandboxMode,
    networkAccessEnabled,
    webSearchMode: decision('WebSearch') === 'allow' ? 'live' : 'disabled',
  };
}

export function codexMessageId(chatId: string, itemId: string): string {
  return `codex_msg_${safeId(chatId)}_${safeId(itemId)}`;
}

export function codexToolId(chatId: string, itemId: string): string {
  return `codex_tool_${safeId(chatId)}_${safeId(itemId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 160);
}

export function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 5000 ? `${json.slice(0, 5000)}...` : json;
  } catch {
    return String(value);
  }
}
