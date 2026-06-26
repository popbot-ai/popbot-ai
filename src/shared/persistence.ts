/**
 * Persistence-layer types shared between main and renderer. Mirrors the
 * SQLite row shapes so renderer code and main-side queries stay aligned.
 */

import type { ChatStatus } from './domain';
import type { SourceControlProviderId } from './sourceControl';

export const RAW_CHAT_REPO_ID = '__none__';

export type AgentBackendId = 'claude' | 'codex';

export const CLAUDE_MODELS = ['claude-opus-4-8', 'claude-fable-5'] as const;
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8' as const;
export const DEFAULT_CODEX_MODEL = 'gpt-5.5' as const;
export const DEFAULT_CLAUDE_REASONING_EFFORT = 'high' as const;
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium' as const;

export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number];
export type CodexModelId = typeof DEFAULT_CODEX_MODEL;
export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_EFFORTS)[number];
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export type AgentReasoningEffort = ClaudeReasoningEffort | CodexReasoningEffort;

/** Coerce a persisted/raw model string to a known Claude model, falling
 *  back to the default for unknown or legacy values. Single source of
 *  truth shared by the renderer create-config normalizers and the
 *  main-side row mappers. */
export function normalizeClaudeModel(value: string | null | undefined): ClaudeModelId {
  return CLAUDE_MODELS.includes(value as ClaudeModelId)
    ? (value as ClaudeModelId)
    : DEFAULT_CLAUDE_MODEL;
}

const REASONING_EFFORT_RANK: Record<AgentReasoningEffort, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export function closestReasoningEffort<T extends AgentReasoningEffort>(
  value: string | null | undefined,
  options: readonly T[],
  fallback: T,
): T {
  if (value && options.includes(value as T)) return value as T;
  if (!value) return fallback;
  const target = REASONING_EFFORT_RANK[value as AgentReasoningEffort];
  if (target === undefined) return fallback;
  return options.reduce<T>((best, item) => {
    const bestDelta = Math.abs(REASONING_EFFORT_RANK[best] - target);
    const itemDelta = Math.abs(REASONING_EFFORT_RANK[item] - target);
    return itemDelta < bestDelta ? item : best;
  }, fallback);
}
export type ChatType = 'lite' | 'client_test' | 'server_test';
export type ChatMode = 'interactive' | 'autonomous';

export interface ChatRecord {
  id: string;
  name: string;
  /** Linear ticket key (e.g. ENG-20512) */
  ticket: string | null;
  /** GitHub PR number */
  pr: number | null;
  branch: string | null;
  type: ChatType;
  mode: ChatMode;
  agent: AgentBackendId;
  status: ChatStatus;
  /** Most recent agent prose, cached for thumbnail rendering. */
  snippet: string;
  tokensUsed: number;
  tokensBudget: number;
  /** 1-based slot index allocated to this chat, or null. Slots are
   *  drawn from a fixed pool whose size is set in Preferences. The
   *  slot is freed when the chat is closed or deleted. */
  slotId: number | null;
  /** Absolute path of the git worktree backing this chat, or null. We
   *  store the resolved path so cleanup still works after the user
   *  changes their worktrees directory in Preferences. */
  worktreePath: string | null;
  /** ID of the repo this chat lives in. Defaults to `'app'` for
   *  pre-multi-repo rows. Raw chats use {@link RAW_CHAT_REPO_ID} and
   *  deliberately do not join to a repo row. */
  repoId: string;
  /** Denormalized from `repos.color` at query time. Convenience field
   *  for the slot-pip / chat-header rendering — saves the renderer a
   *  separate repos lookup per chat. */
  repoColor: string | null;
  /** Denormalized from `repos.mode` at query time. Determines whether
   *  the chat's slot pip renders filled (slots) or outlined (ephemeral
   *  worktree). */
  repoMode: RepoWorktreeMode | null;
  /** Denormalized from `repos.slot_prefix` at query time. Lets the
   *  chat-header slot pill render `${prefix}-${slotId}` (e.g. `ops-4`)
   *  directly from the repo's configured prefix, without relying on
   *  the stored `worktreePath` basename — which may be stale from
   *  before the per-repo path resolver landed. */
  repoSlotPrefix: string | null;
  /** Claude SDK session UUID, captured on first message. Passed back
   *  as `resume` so the agent keeps conversation history across opens. */
  sessionId: string | null;
  /** Codex thread UUID. Kept separate from Claude's session id so a
   *  chat can switch backends without overwriting the other backend's
   *  native resume handle. */
  codexThreadId: string | null;
  /** Provider model + effort settings are stored independently so a
   *  chat can switch agents without forgetting the other provider's
   *  preferred setting. */
  claudeModel: ClaudeModelId;
  claudeReasoningEffort: ClaudeReasoningEffort;
  codexModel: CodexModelId;
  codexReasoningEffort: CodexReasoningEffort;
  /** Per-chat permission rules. Auto-resolves matching `canUseTool`
   *  prompts without user interaction. Rules from this list win over
   *  global rules from settings (so a chat can locally override a
   *  global allow with a deny, or vice-versa). */
  permissionRules: PermissionRule[];
  createdAt: number;
  lastActiveAt: number;
}

/** Tool-name based permission rule. v1 — no command-pattern matching. */
export interface PermissionRule {
  tool: string;
  action: 'allow' | 'deny';
}

/** Worktree management mode for a repo.
 *  - `slots`: pre-allocated pool of N parking-branch worktrees that
 *    chats borrow and return. Worktree paths are stable across opens.
 *  - `ephemeral`: each chat gets its own short-lived worktree, created
 *    on open and removed on close. No parking branches. */
export type RepoWorktreeMode = 'slots' | 'ephemeral';

/**
 * A source repository popbot can run chats against. Each repo picks one
 * worktree mode (`slots` or `ephemeral`) at creation. Mode determines
 * how `chats:create`, `chats:reopen`, and `chats:close` allocate and
 * tear down the chat's worktree — see `RepoWorktreeMode`.
 */
export interface RepoRecord {
  /** Stable identifier — also the folder segment in slot worktree paths
   *  (`<workspaces>/<id>/<slotPrefix>-N`) and the prefix on parking
   *  branches. Lowercase, filesystem-safe. */
  id: string;
  /** Absolute path to the source clone. */
  repoPath: string;
  /** Slot-pill background color for chats in this repo. Any CSS color. */
  color: string;
  /** Folder + parking-branch prefix per slot. Defaults to `slot`.
   *  Unused when `mode === 'ephemeral'`. */
  slotPrefix: string;
  /** Base branch new chats fork from when no explicit base picked. */
  defaultBase: string;
  /** Concurrent-slot capacity for this repo. Per-repo because each
   *  repo has its own Unity / build cost profile and you may want to
   *  budget them independently. Unused when `mode === 'ephemeral'`. */
  slotCount: number;
  /** See {@link RepoWorktreeMode}. Defaults to `slots` for back-compat. */
  mode: RepoWorktreeMode;
  /** Which source-control provider backs this repo. Optional for
   *  back-compat — repos created before multi-SCM support are git.
   *  See {@link SourceControlProviderId}. */
  scm?: SourceControlProviderId;
  createdAt: number;
  updatedAt: number;
}

export type MessageKind =
  | 'text'        // Free-form prose from agent or user.
  | 'tool'        // Tool invocation (name, args, optional result).
  | 'permission'  // canUseTool permission request, with decision.
  | 'system';     // App-emitted notes (errors, lifecycle markers).

export type MessageRole = 'user' | 'agent' | 'system';

/**
 * Body shape varies by `kind`. We persist as a JSON blob and let the
 * renderer dispatch on `kind` for rendering.
 *
 * - text:       { text: string }
 * - tool:       { toolUseId, name, args, result?, isError? }
 * - permission: { permissionId, tool, args, reason?, decision?: PermissionDecision }
 * - system:     { text: string }
 */
export interface MessageRecord {
  id: string;
  chatId: string;
  role: MessageRole;
  kind: MessageKind;
  /** JSON-encoded body; shape depends on `kind`. */
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageBodyText {
  text: string;
  attachments?: ChatAttachment[];
}

export interface ChatAttachment {
  /** Stable id generated when the file is picked. */
  id: string;
  /** Absolute path PopBot should open/read. After send this points at
   *  PopBot's retained copy under app userData. */
  path: string;
  /** Original source path, retained for debugging/user context. */
  originalPath?: string;
  /** Basename shown in pending chips and chat history. */
  name: string;
  sizeBytes: number;
  isImage: boolean;
  storedAt?: number;
  expiresAt?: number;
}

/** Retained chat attachments are copied into PopBot's userData store and
 *  swept after this many days. Configurable in Preferences → Runtime. */
export const ATTACHMENT_TTL_DAYS_DEFAULT = 60;
export const ATTACHMENT_TTL_DAYS_MIN = 1;
export const ATTACHMENT_TTL_DAYS_MAX = 365;

/** Settings stored under the `attachments` key. */
export interface AttachmentsSettings {
  /** Days to keep retained attachments before the startup prune deletes
   *  them. Clamped to [MIN, MAX]; undefined → DEFAULT. */
  ttlDays?: number;
}

/** Coerce a stored/typed TTL into a safe day count. Non-finite or
 *  out-of-range values fall back to the default / nearest bound. */
export function clampAttachmentTtlDays(days: number | undefined | null): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return ATTACHMENT_TTL_DAYS_DEFAULT;
  return Math.min(ATTACHMENT_TTL_DAYS_MAX, Math.max(ATTACHMENT_TTL_DAYS_MIN, Math.round(days)));
}

/** Max changed files rendered in the source-control change view before the
 *  list is capped (and a "showing N of M" row is shown). Guards the panel
 *  against pathological changesets — a Perforce slot off a huge depot can
 *  open tens of thousands of files. Configurable in Preferences → Source
 *  Control. Applies to git and Perforce alike (capped in the SCM IPC layer). */
export const MAX_CHANGED_FILES_DEFAULT = 500;
export const MAX_CHANGED_FILES_MIN = 50;
export const MAX_CHANGED_FILES_MAX = 10000;

/** Settings stored under the `sourceControl` key. */
export interface SourceControlSettings {
  /** Max changed files shown in the change view. Clamped to [MIN, MAX];
   *  undefined → DEFAULT. */
  maxChangedFiles?: number;
}

/** Coerce a stored/typed cap into a safe file count. Non-finite or
 *  out-of-range values fall back to the default / nearest bound. */
export function clampMaxChangedFiles(n: number | undefined | null): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return MAX_CHANGED_FILES_DEFAULT;
  return Math.min(MAX_CHANGED_FILES_MAX, Math.max(MAX_CHANGED_FILES_MIN, Math.round(n)));
}

export interface MessageBodyTool {
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface MessageBodyPermission {
  permissionId: string;
  tool: string;
  args: Record<string, unknown>;
  reason?: string;
  decision?:
    | 'allow' | 'allow-chat' | 'allow-everywhere'
    | 'deny'  | 'deny-everywhere';
}

export interface MessageBodySystem {
  text: string;
}
