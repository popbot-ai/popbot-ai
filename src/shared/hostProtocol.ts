/**
 * The wire between the desktop app and a PopBot host: a box that runs
 * agents (the real `claude` / `codex` CLIs, in its own checkouts) for
 * chats whose transcript, search and settings stay in the desktop's
 * database. Plain HTTP with a bearer token, and one server-sent event
 * stream per chat; no state on the host beyond the live sessions and
 * their event log, which a reconnecting desktop replays from where it
 * left off.
 *
 *   GET  /v1/info                          → HostInfo
 *   GET  /v1/repos/:id/branches            → { branches }
 *   POST /v1/chats/:chatId/spawn           HostSpawnBody → { cwd }
 *   POST /v1/chats/:chatId/send            HostSendBody
 *   POST /v1/chats/:chatId/approve         { permissionId, decision }
 *   POST /v1/chats/:chatId/stop | compact | dispose
 *   POST /v1/chats/:chatId/rules           { rules }
 *   GET  /v1/chats/:chatId/events?after=N  SSE of HostFrame, replaying seq > N
 */
import type { AgentEvent, PermissionDecision, PermissionRule } from './agent';
import type {
  AgentBackendId,
  ClaudeModelId,
  ClaudeReasoningEffort,
  CodexModelId,
  CodexReasoningEffort,
} from './persistence';

export const HOST_PROTOCOL_VERSION = 1;

/** A repository the host has a checkout of. */
export interface HostRepo {
  id: string;
  /** Absolute path on the host. */
  path: string;
  /** Branch new chat branches fork from when none is given. */
  defaultBase: string;
}

export interface HostInfo {
  protocol: number;
  name: string;
  version: string;
  platform: string;
  claude: { ok: boolean; path: string | null };
  codex: { ok: boolean; path: string | null };
  repos: HostRepo[];
  /** Chats with a live session on the host, for a desktop that comes back. */
  chats: Array<{ chatId: string; alive: boolean; lastSeq: number }>;
}

export interface HostSpawnBody {
  agent: AgentBackendId;
  /** Native session to resume (Claude session id / Codex thread id). */
  sessionId?: string | null;
  claudeModel?: ClaudeModelId | null;
  claudeReasoningEffort?: ClaudeReasoningEffort | null;
  codexModel?: CodexModelId | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  /** The desktop's permission rules for this chat (chat rules first,
   *  then global), resolved on the host at call time. */
  rules: PermissionRule[];
  /** Where the agent runs: a host repo, at its root or in a worktree on
   *  `branch` (created off `baseBranch` if new). Absent: the host's
   *  scratch directory. */
  workspace?: { repoId: string; branch?: string | null; baseBranch?: string | null } | null;
}

export interface HostAttachment {
  name: string;
  isImage: boolean;
  /** File bytes, base64. Small by construction (images, text files). */
  dataBase64: string;
}

export interface HostSendBody {
  text: string;
  attachments?: HostAttachment[];
}

export interface HostApproveBody {
  permissionId: string;
  decision: PermissionDecision;
}

/** One entry of a chat's event log on the host. `seq` is per chat and
 *  climbs by one; a desktop reconnects with the last seq it applied. */
export type HostFrame =
  | { seq: number; kind: 'event'; event: AgentEvent }
  | { seq: number; kind: 'session-id'; sessionId: string }
  | { seq: number; kind: 'spawned'; cwd: string }
  /** The backend session is gone (its query ended); spawn again to go on. */
  | { seq: number; kind: 'dead' };
