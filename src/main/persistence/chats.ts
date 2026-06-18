import { randomUUID } from 'node:crypto';
import type {
  AgentBackendId,
  ChatRecord,
  ChatType,
  ClaudeModelId,
  ClaudeReasoningEffort,
  CodexModelId,
  CodexReasoningEffort,
  PermissionRule,
} from '@shared/persistence';
import {
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  normalizeClaudeModel,
} from '@shared/persistence';
import type { ChatStatus } from '@shared/domain';
import { db } from './db';

/** Joined chat + repo row. The `repo_*` columns come from a LEFT JOIN
 *  on `repos`, so they're nullable for chats whose repo_id no longer
 *  resolves (shouldn't happen post-v15 since deleteRepo refuses while
 *  chats reference it, but the LEFT JOIN keeps the chat readable
 *  rather than vanishing). */
interface ChatRow {
  id: string;
  name: string;
  ticket: string | null;
  pr: number | null;
  branch: string | null;
  type: string;
  mode: string;
  agent: string;
  status: string;
  snippet: string;
  tokens_used: number;
  tokens_budget: number;
  slot_id: number | null;
  worktree_path: string | null;
  session_id: string | null;
  codex_thread_id: string | null;
  claude_model: string;
  claude_reasoning_effort: string;
  codex_model: string;
  codex_reasoning_effort: string;
  permission_rules: string;
  created_at: number;
  last_active_at: number;
  closed_at: number | null;
  repo_id: string;
  repo_color: string | null;
  repo_mode: string | null;
  repo_slot_prefix: string | null;
}

/** Standard column list for the chat queries below. Centralized so
 *  every read goes through the same JOIN — denormalized repo color +
 *  mode + slot prefix appear on every ChatRecord without a per-call
 *  repos lookup. */
const CHAT_COLUMNS = `
  c.id, c.name, c.ticket, c.pr, c.branch, c.type, c.mode, c.agent, c.status,
  c.snippet, c.tokens_used, c.tokens_budget, c.slot_id, c.worktree_path,
  c.session_id, c.codex_thread_id, c.claude_model, c.claude_reasoning_effort,
  c.codex_model, c.codex_reasoning_effort,
  c.permission_rules, c.created_at, c.last_active_at, c.closed_at,
  c.repo_id, r.color AS repo_color, r.mode AS repo_mode, r.slot_prefix AS repo_slot_prefix
`;
const CHAT_FROM = `FROM chats c LEFT JOIN repos r ON r.id = c.repo_id`;

function parseRules(json: string): PermissionRule[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is PermissionRule =>
        typeof r === 'object' && r !== null
        && typeof (r as { tool?: unknown }).tool === 'string'
        && ((r as { action?: unknown }).action === 'allow'
          || (r as { action?: unknown }).action === 'deny'),
    );
  } catch {
    return [];
  }
}

function rowToRecord(r: ChatRow): ChatRecord {
  return {
    id: r.id,
    name: r.name,
    ticket: r.ticket,
    pr: r.pr,
    branch: r.branch,
    type: r.type as ChatType,
    mode: r.mode as 'interactive' | 'autonomous',
    agent: normalizeAgent(r.agent),
    status: r.status as ChatStatus,
    snippet: r.snippet,
    tokensUsed: r.tokens_used,
    tokensBudget: r.tokens_budget,
    slotId: r.slot_id,
    worktreePath: r.worktree_path,
    sessionId: r.session_id,
    codexThreadId: r.codex_thread_id,
    claudeModel: normalizeClaudeModel(r.claude_model),
    claudeReasoningEffort: normalizeClaudeReasoningEffort(r.claude_reasoning_effort),
    codexModel: normalizeCodexModel(r.codex_model),
    codexReasoningEffort: normalizeCodexReasoningEffort(r.codex_reasoning_effort),
    permissionRules: parseRules(r.permission_rules),
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    repoId: r.repo_id,
    repoColor: r.repo_color,
    repoMode: (r.repo_mode === 'ephemeral' || r.repo_mode === 'slots')
      ? r.repo_mode
      : null,
    repoSlotPrefix: r.repo_slot_prefix,
  };
}

function normalizeAgent(value: string | null | undefined): AgentBackendId {
  return value === 'codex' ? 'codex' : 'claude';
}

function normalizeCodexModel(value: string | null | undefined): CodexModelId {
  return value === 'gpt-5.5' ? value : DEFAULT_CODEX_MODEL;
}

function normalizeClaudeReasoningEffort(value: string | null | undefined): ClaudeReasoningEffort {
  return closestReasoningEffort(
    value,
    CLAUDE_REASONING_EFFORTS,
    DEFAULT_CLAUDE_REASONING_EFFORT,
  );
}

function normalizeCodexReasoningEffort(value: string | null | undefined): CodexReasoningEffort {
  return closestReasoningEffort(
    value === 'minimal' ? 'none' : value,
    CODEX_REASONING_EFFORTS,
    DEFAULT_CODEX_REASONING_EFFORT,
  );
}

export function listOpenChats(): ChatRecord[] {
  // Oldest first → newest last. Lays out left-to-right in the column +
  // thumbnail strip with the most recently created chat on the far right.
  const rows = db()
    .prepare<[], ChatRow>(
      `SELECT ${CHAT_COLUMNS} ${CHAT_FROM}
        WHERE c.closed_at IS NULL AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC`,
    )
    .all();
  return rows.map(rowToRecord);
}

export function listClosedChats(limit = 100): ChatRecord[] {
  const rows = db()
    .prepare<[number], ChatRow>(
      `SELECT ${CHAT_COLUMNS} ${CHAT_FROM}
        WHERE c.closed_at IS NOT NULL AND c.deleted_at IS NULL
        ORDER BY c.closed_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToRecord);
}

/** Reopen a previously-closed chat — clears closed_at so it returns to
 *  the open chats list. The transcript and all metadata are preserved.
 *  Refuses to reopen a soft-deleted chat. Optionally re-attaches a
 *  workspace slot + worktree (the IPC handler does the git work). */
export function reopenChat(
  id: string,
  attach?: { slotId: number | null; worktreePath: string | null },
): ChatRecord | null {
  if (attach) {
    db().prepare(
      'UPDATE chats SET closed_at = NULL, slot_id = ?, worktree_path = ?, last_active_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).run(attach.slotId, attach.worktreePath, Date.now(), id);
  } else {
    db().prepare(
      'UPDATE chats SET closed_at = NULL, last_active_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).run(Date.now(), id);
  }
  return getChat(id);
}

/**
 * Lowest free slot, with a hint preference: if `prefer` is given AND
 * still free, returns that one. Otherwise the lowest unused 1..max.
 */
export function allocateSlotPreferring(maxCount: number, prefer?: number | null): number | null {
  const taken = new Set<number>(
    db()
      .prepare<[], { slot_id: number }>(
        'SELECT slot_id FROM chats WHERE slot_id IS NOT NULL AND closed_at IS NULL AND deleted_at IS NULL',
      )
      .all()
      .map((r) => r.slot_id),
  );
  if (prefer != null && prefer >= 1 && prefer <= maxCount && !taken.has(prefer)) {
    return prefer;
  }
  for (let i = 1; i <= maxCount; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}

/** Substring match across chat name + ticket + branch + snippet. Returns
 *  open chats first, then closed. Tiny LIKE search — fine for the
 *  hundreds-of-chats range; we'll move to FTS5 if we ever need it. */
export function searchChats(query: string, limit = 50): ChatRecord[] {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q}%`;
  const rows = db()
    .prepare<[string, string, string, string, number], ChatRow>(
      `SELECT ${CHAT_COLUMNS} ${CHAT_FROM}
        WHERE c.deleted_at IS NULL
          AND (c.name LIKE ? OR c.ticket LIKE ? OR c.branch LIKE ? OR c.snippet LIKE ?)
        ORDER BY (c.closed_at IS NULL) DESC, c.last_active_at DESC
        LIMIT ?`,
    )
    .all(like, like, like, like, limit);
  return rows.map(rowToRecord);
}

export function getChat(id: string): ChatRecord | null {
  const row = db()
    .prepare<[string], ChatRow>(`SELECT ${CHAT_COLUMNS} ${CHAT_FROM} WHERE c.id = ?`)
    .get(id);
  return row ? rowToRecord(row) : null;
}

export interface CreateChatArgs {
  name: string;
  ticket?: string | null;
  pr?: number | null;
  branch?: string | null;
  type?: ChatType;
  slotId?: number | null;
  worktreePath?: string | null;
  /** Repo this chat lives in. Defaults to `'app'` to match the
   *  pre-multi-repo install. The IPC layer should resolve the active
   *  repo from the create form and pass it through. */
  repoId?: string;
  agent?: AgentBackendId;
  claudeModel?: ClaudeModelId;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
}

export function createChat(args: CreateChatArgs): ChatRecord {
  const now = Date.now();
  const id = 'chat_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const agent = normalizeAgent(args.agent);
  const claudeModel = normalizeClaudeModel(args.claudeModel);
  const claudeReasoningEffort = normalizeClaudeReasoningEffort(args.claudeReasoningEffort);
  const codexModel = normalizeCodexModel(args.codexModel);
  const codexReasoningEffort = normalizeCodexReasoningEffort(args.codexReasoningEffort);
  db()
    .prepare(
      `INSERT INTO chats (
         id, name, ticket, pr, branch, type, mode, agent, status, snippet,
         tokens_used, tokens_budget, slot_id, worktree_path, created_at, last_active_at,
         repo_id, claude_model, claude_reasoning_effort, codex_model, codex_reasoning_effort
       )
       VALUES (?, ?, ?, ?, ?, ?, 'interactive', ?, 'idle', '', 0, 1000000, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.name,
      args.ticket ?? null,
      args.pr ?? null,
      args.branch ?? null,
      args.type ?? 'lite',
      agent,
      args.slotId ?? null,
      args.worktreePath ?? null,
      now,
      now,
      args.repoId ?? 'app',
      claudeModel,
      claudeReasoningEffort,
      codexModel,
      codexReasoningEffort,
    );
  const created = getChat(id);
  if (!created) throw new Error('createChat: row missing immediately after insert');
  return created;
}

/** Per-slot occupancy: which open chat (if any) holds each slot. The
 *  renderer renders this as a picker grid. */
export interface SlotOccupant {
  chatId: string;
  chatName: string;
  ticket: string | null;
  pr: number | null;
  branch: string | null;
}
export function listSlotOccupants(): Map<number, SlotOccupant> {
  const rows = db()
    .prepare<[], { id: string; name: string; slot_id: number; ticket: string | null; pr: number | null; branch: string | null }>(
      `SELECT id, name, slot_id, ticket, pr, branch
       FROM chats
       WHERE slot_id IS NOT NULL AND closed_at IS NULL AND deleted_at IS NULL`,
    )
    .all();
  const out = new Map<number, SlotOccupant>();
  for (const r of rows) {
    out.set(r.slot_id, {
      chatId: r.id,
      chatName: r.name,
      ticket: r.ticket,
      pr: r.pr,
      branch: r.branch,
    });
  }
  return out;
}

/** Same shape as {@link listSlotOccupants} but scoped to a single
 *  repo. Used by the Configure Slots flow's pre-flight check — we
 *  refuse a resize when any slot in the target repo is currently
 *  attached to an open chat. */
export function listSlotOccupantsForRepo(repoId: string): Map<number, SlotOccupant> {
  const rows = db()
    .prepare<[string], { id: string; name: string; slot_id: number; ticket: string | null; pr: number | null; branch: string | null }>(
      `SELECT id, name, slot_id, ticket, pr, branch
       FROM chats
       WHERE slot_id IS NOT NULL AND closed_at IS NULL AND deleted_at IS NULL AND repo_id = ?`,
    )
    .all(repoId);
  const out = new Map<number, SlotOccupant>();
  for (const r of rows) {
    out.set(r.slot_id, {
      chatId: r.id,
      chatName: r.name,
      ticket: r.ticket,
      pr: r.pr,
      branch: r.branch,
    });
  }
  return out;
}

/** Close (soft) — also frees the slot so it's available for reuse.
 *  `worktree_path` is treated as runtime-active state: present when the
 *  chat is currently attached to a slot, blank otherwise. Clearing it
 *  here means a closed chat never carries a stale path that could be
 *  read after the slot was reassigned to someone else. */
export function closeChat(id: string): void {
  db()
    .prepare(`UPDATE chats SET closed_at = ?, slot_id = NULL, worktree_path = '' WHERE id = ?`)
    .run(Date.now(), id);
}

/**
 * Find the lowest-numbered slot (1..maxCount) not currently held by an
 * open, non-deleted chat. Returns null if all slots are taken. The
 * caller decides what to do with that (typically: prompt the user).
 */
export function allocateSlot(maxCount: number): number | null {
  const taken = new Set<number>(
    db()
      .prepare<[], { slot_id: number }>(
        'SELECT slot_id FROM chats WHERE slot_id IS NOT NULL AND closed_at IS NULL AND deleted_at IS NULL',
      )
      .all()
      .map((r) => r.slot_id),
  );
  for (let i = 1; i <= maxCount; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}

/** Bind a slot + worktree to a chat that's already open. Used by the
 *  attach-slot flow when a pre-slot-system chat needs a workspace. */
export function setChatSlot(id: string, slotId: number, worktreePath: string): void {
  db()
    .prepare('UPDATE chats SET slot_id = ?, worktree_path = ?, last_active_at = ? WHERE id = ?')
    .run(slotId, worktreePath, Date.now(), id);
}

/** Bind an ephemeral chat to its just-created worktree. Same shape as
 *  `setChatSlot` minus the slot id — ephemeral chats never hold one. */
export function setChatWorktree(id: string, worktreePath: string): void {
  db()
    .prepare('UPDATE chats SET slot_id = NULL, worktree_path = ?, last_active_at = ? WHERE id = ?')
    .run(worktreePath, Date.now(), id);
}

/** Backfill the chat's Linear ticket id (e.g. 'ENG-1234') when we
 *  discover one — either by parsing the chat name or by extracting it
 *  from a PR's title/body. Idempotent: only writes when the ticket
 *  field is currently null and the new value is non-null. */
export function setChatTicketIfMissing(id: string, ticket: string): boolean {
  const r = db()
    .prepare('UPDATE chats SET ticket = ? WHERE id = ? AND ticket IS NULL')
    .run(ticket, id);
  return r.changes > 0;
}

/** Same idea for the PR number — backfilled when we parse it out of
 *  the chat name (e.g. `[CR] PR #8123 · …`). Idempotent on the same
 *  rule: only writes when the column is currently null. */
export function setChatPrIfMissing(id: string, pr: number): boolean {
  const r = db()
    .prepare('UPDATE chats SET pr = ? WHERE id = ? AND pr IS NULL')
    .run(pr, id);
  return r.changes > 0;
}

/** Soft-delete a chat. The row + transcript stay in the DB so we can
 *  restore later; lists/search filter on `deleted_at IS NULL`. Also
 *  clears slot + worktree_path so a deleted chat doesn't hold the slot
 *  or carry a path that could collide with whatever takes the slot
 *  next. (closeChat covers most paths; this catches the rare
 *  delete-from-open case.) */
export function deleteChat(id: string): void {
  db()
    .prepare(`UPDATE chats SET deleted_at = ?, slot_id = NULL, worktree_path = '' WHERE id = ?`)
    .run(Date.now(), id);
}

/** Restore a soft-deleted chat. Surfaces in Inactive (or Active if it
 *  was never closed). */
export function undeleteChat(id: string): ChatRecord | null {
  db().prepare('UPDATE chats SET deleted_at = NULL WHERE id = ?').run(id);
  return getChat(id);
}

/**
 * Reset every chat that's recorded as `run` back to `idle`. Called once
 * at app startup — no SDK sessions are alive yet, so any "thinking"
 * status carried over from the previous run is stale.
 */
export function clearStaleRunningStatuses(): void {
  db()
    .prepare(`UPDATE chats SET status = 'idle' WHERE status = 'run'`)
    .run();
}

export function updateChatStatus(id: string, status: ChatStatus, snippet?: string): void {
  if (snippet !== undefined) {
    db()
      .prepare('UPDATE chats SET status = ?, snippet = ?, last_active_at = ? WHERE id = ?')
      .run(status, snippet, Date.now(), id);
  } else {
    db()
      .prepare('UPDATE chats SET status = ?, last_active_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }
}

export function updateChatTokens(id: string, used: number, budget: number): void {
  db()
    .prepare('UPDATE chats SET tokens_used = ?, tokens_budget = ? WHERE id = ?')
    .run(used, budget, id);
}

/** Pin the Claude SDK session UUID we got back so future spawns can
 *  `resume` instead of starting a fresh conversation. Idempotent —
 *  silently ignores when the value already matches. */
export function setChatSessionId(id: string, sessionId: string): void {
  db().prepare('UPDATE chats SET session_id = ? WHERE id = ?').run(sessionId, id);
}

/** Clear the pinned session UUID — used by the self-heal flow when
 *  the SDK reports the saved session no longer exists on disk. */
export function clearChatSessionId(id: string): void {
  db().prepare('UPDATE chats SET session_id = NULL WHERE id = ?').run(id);
}

export function setChatCodexThreadId(id: string, threadId: string): void {
  db().prepare('UPDATE chats SET codex_thread_id = ? WHERE id = ?').run(threadId, id);
}

export function clearChatCodexThreadId(id: string): void {
  db().prepare('UPDATE chats SET codex_thread_id = NULL WHERE id = ?').run(id);
}

export function updateChatAgentConfig(
  id: string,
  input: {
    agent: AgentBackendId;
    claudeModel?: ClaudeModelId;
    claudeReasoningEffort?: ClaudeReasoningEffort;
    codexModel?: CodexModelId;
    codexReasoningEffort?: CodexReasoningEffort;
  },
): ChatRecord | null {
  const current = getChat(id);
  if (!current) return null;
  const claudeModel = normalizeClaudeModel(input.claudeModel ?? current.claudeModel);
  const claudeReasoningEffort = normalizeClaudeReasoningEffort(
    input.claudeReasoningEffort ?? current.claudeReasoningEffort,
  );
  const codexModel = normalizeCodexModel(input.codexModel ?? current.codexModel);
  const codexReasoningEffort = normalizeCodexReasoningEffort(
    input.codexReasoningEffort ?? current.codexReasoningEffort,
  );
  db()
    .prepare(
      `UPDATE chats
          SET agent = ?,
              claude_model = ?,
              claude_reasoning_effort = ?,
              codex_model = ?,
              codex_reasoning_effort = ?,
              last_active_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(
      input.agent,
      claudeModel,
      claudeReasoningEffort,
      codexModel,
      codexReasoningEffort,
      Date.now(),
      id,
    );
  return getChat(id);
}

export function appendCodexThreadEvent(input: {
  chatId: string;
  threadId: string;
  eventType: string;
  payload: unknown;
}): void {
  const now = Date.now();
  const row = db()
    .prepare<[string, string], { next_seq: number }>(
      `SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq
         FROM codex_thread_events
        WHERE chat_id = ? AND thread_id = ?`,
    )
    .get(input.chatId, input.threadId);
  db()
    .prepare(
      `INSERT INTO codex_thread_events
        (chat_id, thread_id, seq, event_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chatId,
      input.threadId,
      row?.next_seq ?? 0,
      input.eventType,
      JSON.stringify(input.payload),
      now,
    );
}

/** Get the per-chat permission rules. Empty array when none. */
export function getChatPermissionRules(id: string): PermissionRule[] {
  const row = db()
    .prepare<[string], { permission_rules: string }>(
      'SELECT permission_rules FROM chats WHERE id = ?',
    )
    .get(id);
  if (!row) return [];
  return parseRules(row.permission_rules);
}

/** Append a rule for this chat. Existing rules with the same `tool`
 *  are replaced — keeps the list canonical (one rule per tool name). */
export function addChatPermissionRule(id: string, rule: PermissionRule): void {
  const current = getChatPermissionRules(id);
  const next = [...current.filter((r) => r.tool !== rule.tool), rule];
  db()
    .prepare('UPDATE chats SET permission_rules = ? WHERE id = ?')
    .run(JSON.stringify(next), id);
}

/** Remove a rule by tool name. No-op when no rule exists for that tool. */
export function removeChatPermissionRule(id: string, tool: string): void {
  const current = getChatPermissionRules(id);
  const next = current.filter((r) => r.tool !== tool);
  if (next.length === current.length) return;
  db()
    .prepare('UPDATE chats SET permission_rules = ? WHERE id = ?')
    .run(JSON.stringify(next), id);
}
