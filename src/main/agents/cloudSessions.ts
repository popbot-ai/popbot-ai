/**
 * Cloud chats, the parts outside the agent session: is the cloud set
 * up, does a key work, and pulling the sandbox's commits back into the
 * chat's checkout. The session itself is ManagedAgentsBackend.ts.
 * Per CORE_MODEL.md the AgentHost-owned broadcast is passed in as `emit`.
 */
import type { AgentEvent } from '@shared/agent';
import type { CloudStatus } from '@shared/ipc';
import { dlog } from '../diagLog';
import { getChat, setChatCloud } from '../persistence/chats';
import { appendMessage } from '../persistence/messages';
import { getRepo } from '../persistence/repos';
import { pullBranch } from './cloudGit';
import {
  cloudClient,
  cloudSettings,
  describeApiError,
  resolveCloudApiKey,
  resolveGithubToken,
  testCloudApiKey,
} from './managedAgentsClient';

/** How long to wait for an interrupted session to go idle before
 *  archiving it — a tool call in flight can take a while to stop. */
const END_IDLE_WAIT_MS = 30_000;

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
 * "Shut down cloud chat" (the chat menu, or a right-click on the Cloud
 * chip) ends the chat's session on the server. Nothing else does:
 * closing or deleting the chat only detaches from the session, and
 * quitting PopBot is when a session is meant to carry on. A running
 * session cannot be archived, so it is interrupted first and given a
 * moment to go idle. Best effort: a failure is logged and the chat is
 * still marked ended.
 */
export async function endCloudSession(chatId: string, emit: Emit | null): Promise<void> {
  const chat = getChat(chatId);
  const info = chat?.cloud;
  if (!info?.sessionId || info.ended) return;
  const sessionId = info.sessionId;
  try {
    const client = cloudClient();
    let status = (await client.beta.sessions.retrieve(sessionId)).status;
    if (status === 'running' || status === 'rescheduling') {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] });
      const until = Date.now() + END_IDLE_WAIT_MS;
      while (Date.now() < until && (status === 'running' || status === 'rescheduling')) {
        await new Promise((r) => setTimeout(r, 1500));
        status = (await client.beta.sessions.retrieve(sessionId)).status;
      }
    }
    if (status === 'idle') await client.beta.sessions.archive(sessionId);
    dlog('cloud.session.ended', { chatId, sessionId, status, archived: status === 'idle' });
  } catch (err) {
    dlog('cloud.session.end.failed', { chatId, sessionId, error: describeApiError(err) });
  }
  // Ended for the chat either way: reopening starts a new session
  // primed with the conversation, rather than reattaching to one that
  // is archived or on its way out.
  setChatCloud(chatId, { ...info, ended: true });
  if (emit) note(chatId, emit, 'cloud: The cloud session was shut down. Your next message starts a new one, primed with this conversation.');
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
