/**
 * The Anthropic client for cloud chats and the two resources every
 * session hangs off: one cloud environment for the account and one
 * agent per model + effort. Both are created on first use and their ids
 * cached in settings (`agent.cloud.cache`); a cached id that no longer
 * resolves is recreated.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  CLOUD_CACHE_SETTINGS_KEY,
  CLOUD_SETTINGS_KEY,
  CLAUDE_MODEL_LABELS,
  type ClaudeModelId,
  type ClaudeReasoningEffort,
  type CloudCache,
  type CloudSettings,
} from '@shared/persistence';
import { dlog } from '../diagLog';
import { getSetting, setSetting } from '../persistence/settings';
import { ghAuthToken } from './cloudGit';
import { CLOUD_SYSTEM_PROMPT, agentCacheKey } from './managedAgents';

const ENVIRONMENT_NAME = 'PopBot';

export function cloudSettings(): CloudSettings {
  return getSetting<CloudSettings>(CLOUD_SETTINGS_KEY) ?? {};
}

/** The API key cloud chats run on: Preferences first, then the
 *  environment. `source` tells the UI which one is in play. */
export function resolveCloudApiKey(): { key: string; source: 'settings' | 'env' } | null {
  const fromSettings = cloudSettings().apiKey?.trim();
  if (fromSettings) return { key: fromSettings, source: 'settings' };
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return null;
}

/** The GitHub token the sandbox clones with: Preferences, else `gh`. */
export async function resolveGithubToken(): Promise<{ token: string; source: 'settings' | 'gh' } | null> {
  const fromSettings = cloudSettings().githubToken?.trim();
  if (fromSettings) return { token: fromSettings, source: 'settings' };
  const fromGh = await ghAuthToken();
  return fromGh ? { token: fromGh, source: 'gh' } : null;
}

export class CloudNotConfiguredError extends Error {
  constructor() {
    super('No Anthropic API key. Add one in Preferences ▸ Agents ▸ Cloud chats (or set ANTHROPIC_API_KEY).');
    this.name = 'CloudNotConfiguredError';
  }
}

export function cloudClient(apiKey?: string): Anthropic {
  const key = apiKey ?? resolveCloudApiKey()?.key;
  if (!key) throw new CloudNotConfiguredError();
  return new Anthropic({ apiKey: key, maxRetries: 3 });
}

/** Does the key work for Managed Agents? One cheap list call, bounded
 *  so a blocked network cannot hang the Preferences save. */
export async function testCloudApiKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!apiKey) return { ok: false, error: 'no key given' };
  try {
    await cloudClient(apiKey).beta.environments.list({ limit: 1 }, { timeout: 15_000, maxRetries: 1 });
    dlog('cloud.key.ok', { prefix: apiKey.slice(0, 10) });
    return { ok: true };
  } catch (err) {
    const error = describeApiError(err);
    dlog('cloud.key.failed', { prefix: apiKey.slice(0, 10), error });
    return { ok: false, error };
  }
}

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: string } } | undefined;
    const said = body?.error?.message ?? err.message;
    if (err.status === 401) return `the API key was rejected (${said})`;
    if (err.status === 403) return `the API key is not allowed to use Managed Agents (${said})`;
    return said;
  }
  return err instanceof Error ? err.message : String(err);
}

function cache(): CloudCache {
  return getSetting<CloudCache>(CLOUD_CACHE_SETTINGS_KEY) ?? {};
}

function saveCache(patch: Partial<CloudCache>): void {
  setSetting(CLOUD_CACHE_SETTINGS_KEY, { ...cache(), ...patch });
}

/** The account's PopBot environment, created on first use. */
export async function ensureEnvironment(client: Anthropic): Promise<string> {
  const cached = cache().environmentId;
  if (cached) {
    try {
      const env = await client.beta.environments.retrieve(cached);
      if (!env.archived_at) return env.id;
    } catch (err) {
      dlog('cloud.environment.stale', { id: cached, error: describeApiError(err) });
    }
  }
  const env = await client.beta.environments.create({
    name: ENVIRONMENT_NAME,
    description: 'Cloud chats from the PopBot desktop app.',
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
  });
  saveCache({ environmentId: env.id });
  dlog('cloud.environment.created', { id: env.id });
  return env.id;
}

/**
 * The PopBot agent for a model + effort, created on first use. The
 * definition is the same for every chat: the full agent toolset, run
 * without confirmation prompts (the sandbox is isolated; pushing is the
 * one thing that leaves it, and the preamble scopes that to the chat's
 * branch), and the shared system prompt.
 */
export async function ensureAgent(
  client: Anthropic,
  model: ClaudeModelId,
  effort: ClaudeReasoningEffort,
): Promise<string> {
  const key = agentCacheKey(model, effort);
  const cached = cache().agents?.[key];
  if (cached) {
    try {
      const agent = await client.beta.agents.retrieve(cached.id);
      if (!agent.archived_at) return agent.id;
    } catch (err) {
      dlog('cloud.agent.stale', { id: cached.id, error: describeApiError(err) });
    }
  }
  const agent = await client.beta.agents.create({
    name: `PopBot · ${CLAUDE_MODEL_LABELS[model] ?? model} · ${effort}`,
    description: 'Cloud chats from the PopBot desktop app.',
    model: { id: model, effort },
    system: CLOUD_SYSTEM_PROMPT,
    tools: [{ type: 'agent_toolset_20260401', default_config: { permission_policy: { type: 'always_allow' } } }],
    metadata: { popbot: 'cloud-chat', model, effort },
  });
  saveCache({ agents: { ...(cache().agents ?? {}), [key]: { id: agent.id, version: agent.version } } });
  dlog('cloud.agent.created', { id: agent.id, model, effort });
  return agent.id;
}
