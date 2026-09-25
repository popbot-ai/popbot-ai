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
 *   GET  /v1/repos/:id/slots               → HostSlotsInfo
 *   PUT  /v1/repos/:id                     Partial<HostRepo> → HostRepo   (adds or changes; rewrites the config)
 *   DELETE /v1/repos/:id                   → { ok }
 *   POST /v1/chats/:chatId/workspace       HostWorkspaceRequest → HostWorkspaceResult
 *   POST /v1/chats/:chatId/release         { stash } → { released }  (parks the slot / removes the worktree)
 *   POST /v1/chats/:chatId/spawn           HostSpawnBody → { cwd, seq }
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

/** A repository the host has a checkout of, and how it hands out
 *  workspaces in it — the desktop's repo settings, on the host. */
export interface HostRepo {
  id: string;
  /** Absolute path on the host. */
  path: string;
  /** Branch new chat branches fork from when none is given. */
  defaultBase: string;
  /** Slot worktrees are `<workspaces>/<id>/<slotPrefix>-N`. */
  slotPrefix: string;
  /** Size of the slot pool; 0 with `slots` mode means no worktrees. */
  slotCount: number;
  /** A pool of warm slots, or a throwaway worktree per chat. */
  mode: 'slots' | 'ephemeral';
}

/** What a chat asks the host for: nothing but a scratch folder, the
 *  repo root, or a worktree on its branch (a slot or an ephemeral one,
 *  as the repo is configured). */
export type HostWorkspaceKind = 'scratch' | 'root' | 'worktree';

export interface HostWorkspaceRequest {
  kind: HostWorkspaceKind;
  repoId?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  /** A particular slot, when the desktop wants one; else the lowest free. */
  slotId?: number | null;
}

export interface HostWorkspaceResult {
  cwd: string;
  kind: 'scratch' | 'root' | 'slot' | 'ephemeral';
  slotId: number | null;
  branch: string | null;
}

export type HostWorkspaceErrorCode = 'no-repo' | 'no-free-slot' | 'slot-taken' | 'worktree-failed';

/** A repository's pool as the host sees it. */
export interface HostSlotsInfo {
  slotPrefix: string;
  slotCount: number;
  mode: 'slots' | 'ephemeral';
  slots: Array<{ slotId: number; path: string; chatId: string | null; branch: string | null }>;
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
  /** The desktop's permission rules, resolved on the host at call time. */
  rules: HostRules;
  /** Where the agent runs. Absent: the host's scratch directory. A
   *  workspace the chat already holds is reused. */
  workspace?: HostWorkspaceRequest | null;
}

/** Permission rules as the desktop keeps them: the chat's own rules
 *  answer first, the global ones only when they are silent. */
export interface HostRules {
  chat: PermissionRule[];
  global: PermissionRule[];
}

/** What spawn answers: where the agent runs, and the event-log seq the
 *  desktop should read from (`?after=seq`) to see this session's frames
 *  and none of an earlier session's. */
export interface HostSpawnResult {
  cwd: string;
  seq: number;
  workspace: HostWorkspaceResult;
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
