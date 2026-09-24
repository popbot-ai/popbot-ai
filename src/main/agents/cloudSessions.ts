/**
 * Cloud chats, the parts outside the agent session: is the cloud set
 * up, does a key work, and pulling the sandbox's commits back into the
 * chat's checkout. The session itself is ManagedAgentsBackend.ts.
 * Per CORE_MODEL.md the AgentHost-owned broadcast is passed in as `emit`.
 */
import type { AgentEvent } from '@shared/agent';
import type { CloudStatus } from '@shared/ipc';
import { dlog } from '../diagLog';
import { getChat } from '../persistence/chats';
import { appendMessage } from '../persistence/messages';
import { getRepo } from '../persistence/repos';
import { pullBranch } from './cloudGit';
import { cloudSettings, resolveCloudApiKey, resolveGithubToken, testCloudApiKey } from './managedAgentsClient';

export type Emit = (event: AgentEvent) => void;

/** What the new-chat dialog and Preferences show about the setup. */
export async function cloudStatus(): Promise<CloudStatus> {
  const key = resolveCloudApiKey();
  const github = await resolveGithubToken();
  return {
    apiKey: key?.source ?? null,
    githubToken: github?.source ?? null,
    hasSettingsKey: !!cloudSettings().apiKey?.trim(),
  };
}

export { testCloudApiKey };

function note(chatId: string, emit: Emit, text: string): void {
  const row = appendMessage({ chatId, role: 'system', kind: 'system', body: { text } });
  emit({ type: 'message-added', chatId, message: row, ts: Date.now() });
}

/**
 * Fast-forward the chat's checkout to what the cloud pushed. The slot /
 * worktree for a chat with its own branch, else the repo root, which
 * has to be on the session's branch.
 */
export async function pullCloudBranch(chatId: string, emit: Emit): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const chat = getChat(chatId);
  if (!chat?.cloud) return { ok: false, error: 'not a cloud chat' };
  const branch = chat.cloud.branch ?? chat.branch;
  if (!branch) return { ok: false, error: 'this cloud chat has no repository branch to pull' };
  const cwd = chat.worktreePath || chat.repoPath || getRepo(chat.repoId)?.repoPath || null;
  if (!cwd) return { ok: false, error: 'no local checkout for this chat' };
  try {
    const summary = await pullBranch(cwd, branch);
    dlog('cloud.pull', { chatId, branch, cwd, summary });
    note(chatId, emit, `cloud: ${summary} ${branch} from origin into ${cwd}.`);
    return { ok: true, summary };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    dlog('cloud.pull.failed', { chatId, branch, cwd, error });
    note(chatId, emit, `error: Could not pull ${branch}: ${error}`);
    return { ok: false, error };
  }
}
