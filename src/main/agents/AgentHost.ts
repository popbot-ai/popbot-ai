import type { WebContents } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  RAW_CHAT_REPO_ID,
  type ClaudeModelId,
  type ChatRecord,
  type ClaudeReasoningEffort,
  type CodexModelId,
  type CodexReasoningEffort,
  type MessageBodyPermission,
  type MessageBodyText,
  type MessageBodyTool,
  type PermissionRule,
} from '@shared/persistence';
// MessageBodyPermission imported above; re-tag it here for clarity in approve().
import { IpcChannel } from '@shared/ipc';
import {
  addChatPermissionRule,
  appendCodexThreadEvent,
  clearChatSessionId,
  clearChatCodexThreadId,
  getChat,
  getChatPermissionRules,
  setChatCodexThreadId,
  setChatSessionId,
  updateChatAgentConfig,
  updateChatStatus,
  updateChatTokens,
} from '../persistence/chats';
import { isDbOpen } from '../persistence/db';
import { getRepo } from '../persistence/repos';
import { dlog } from '../diagLog';
import { getClaudeBinaryPath } from './claudeProbe';
import { getSetting, setSetting } from '../persistence/settings';
import { appendMessage, getMessage, listMessages, updateMessageBody } from '../persistence/messages';
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { applyPerforceAgentCwd, worktreePathForChat } from '../git/chatPaths';
import { sqliteSessionStore } from './sqliteSessionStore';
import { looksLikeQuestion } from '@shared/questionDetect';
import type { AgentBackend, AgentSession } from './types';
import { StubBackend } from './StubBackend';
import { ClaudeBackend } from './ClaudeBackend';
import { CodexBackend } from './CodexBackend';
import { getCodexBinaryPath } from './codexProbe';
import { persistChatAttachments } from '../attachments/store';

/**
 * Where the Claude SDK stores per-session JSONLs. The SDK encodes a
 * cwd by NFC-normalizing it, then replacing every non-alphanumeric char
 * with `-` (e.g. `/Users/you/code/my-app` → `-Users-you-code-my-app`,
 * and on Windows `C:\Users\you\app` → `C--Users-you-app`), and stores
 * transcripts under `~/.claude/projects/<encoded>/<session-id>.jsonl`.
 * We replicate that encoding so we can confirm a session JSONL is
 * actually on disk before asking the SDK to resume it — that lets us
 * turn "SDK rejects pinned id" loops into a clean "spawn fresh" path
 * with diagnostics.
 *
 * IMPORTANT — why the `/`-only replacement was wrong: it leaves Windows
 * backslashes / drive-colon untouched, so the path never matches what
 * the SDK wrote, the existence check always fails, and the boot-time
 * pin repair wrongly wipes every chat's session_id.
 *
 * CAVEAT — long paths: when the encoded string exceeds 200 chars the SDK
 * truncates to the first 200 + `-` + an internal hash of the original
 * path. We deliberately do NOT reproduce that hash here (it's an
 * undocumented SDK internal we can't track reliably), so we return null
 * for the over-length case. Returning null is the safe choice: every
 * caller treats it as "can't determine the JSONL path" and skips — in
 * particular `repairBrokenSessionPins()` leaves the pin intact rather
 * than wiping a valid session_id. Such sessions still self-heal via the
 * worktree-scan discovery path. (Realistic trigger: very long Windows
 * user paths or deeply-nested workspaces.)
 */
const SDK_ENCODED_DIR_MAX = 200;

/**
 * The cwd the SDK keys a chat's session by: the slot worktree, else the chat's
 * OWN repo root (not the legacy global `git` setting), with the Perforce
 * agentCwd subpath applied. Shared by resume + validate so they resolve the
 * same cwd the agent actually spawned in.
 */
export function sessionCwdForChat(
  chat: Pick<ChatRecord, 'slotId' | 'repoId' | 'worktreePath'> | null | undefined,
): string | null {
  const base =
    worktreePathForChat(chat)
    ?? (chat?.repoId ? getRepo(chat.repoId)?.repoPath : undefined)
    ?? getSetting<{ repoPath?: string }>('git')?.repoPath
    ?? null;
  return applyPerforceAgentCwd(base, chat);
}

export function sdkSessionJsonlPath(cwd: string, sessionId: string): string | null {
  if (!cwd || !sessionId) return null;
  const encoded = cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');
  // Over the SDK's truncation threshold we can't faithfully reproduce
  // the hashed directory name; bail rather than guess a wrong path.
  if (encoded.length > SDK_ENCODED_DIR_MAX) return null;
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

function rawChatCwd(): string {
  const dir = join(homedir(), 'popbot', 'raw-chats');
  mkdirSync(dir, { recursive: true });
  return dir;
}


/**
 * Singleton orchestrator. The model invariant from CORE_MODEL.md:
 *
 *   "AgentHost is the only thing that mutates Chat status / snippet /
 *    tokens during a session. Backends never write to the DB — they emit
 *    events; AgentHost persists."
 *
 * One AgentHost instance per app; one AgentSession per active chat.
 * Sessions are lazy: spawned on first send, disposed on chat close.
 */
class AgentHostImpl {
  private webContents: WebContents | null = null;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly textBuffers = new Map<
    string,
    { chatId: string; messageId: string; buffer: string; flushTimer: NodeJS.Timeout | null }
  >();
  // Health is now state-machine driven (see ClaudeBackend.handleSDKMessage):
  //   - SDKSystemMessage with subtype 'init' → session is alive.
  //   - SDKResultMessage with subtype 'success' → turn complete.
  //   - SDKResultMessage with any other subtype → real turn error.
  //   - Iterator throws / subprocess exits → real session error.
  //   - SDKMirrorErrorMessage → SqliteSessionStore.append failed; durability
  //     is compromised, surface as red.
  // Silence between events is no longer treated as a failure — slow turns
  // (long thinking, big tool calls, stale-chat resume) used to false-flag
  // under the old 15s watchdog. The state-machine path catches the actual
  // failure modes, the timer never did.

  /** Wired at app boot so events can reach the renderer. */
  attachWindow(webContents: WebContents): void {
    this.webContents = webContents;
  }

  /** Send a user message to a chat. Spawns a session if none exists. */
  async send(chatId: string, text: string, attachments?: PickedAttachment[]): Promise<void> {
    const chat = getChat(chatId);
    if (!chat) throw new Error(`send: chat ${chatId} not found`);

    dlog('agent.send', {
      chatId,
      textLen: text.length,
      pinnedSessionId: chat.sessionId ?? null,
      worktree: chat.worktreePath ?? null,
      branch: chat.branch ?? null,
    });

    const storedAttachments = await persistChatAttachments(chatId, attachments);
    const userMsg = appendMessage({
      chatId,
      role: 'user',
      kind: 'text',
      body: {
        text,
        ...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
      } satisfies MessageBodyText,
    });
    updateChatStatus(chatId, 'run', text.slice(0, 140));

    // Broadcast the user message so the renderer sees it immediately —
    // without this, the user's own typing only shows up after a refetch
    // (or never, if no refetch happens this session).
    this.broadcast({
      type: 'message-added',
      chatId,
      message: userMsg,
      ts: Date.now(),
    });
    // Also broadcast the status flip — the renderer's wait-preserving
    // guard only releases on a real session-status event, so without
    // this the chat stays orange/yellow after the user answers a
    // question with text.
    this.broadcast({
      type: 'session-status',
      chatId,
      status: 'running',
      ts: Date.now(),
    });

    try {
      const session = await this.getOrSpawnSession(chatId);
      await session.sendUser(text, storedAttachments);
    } catch (err) {
      // Spawn-time failure: surface immediately as a chat error so the
      // user sees something instead of a silent stuck 'run' status.
      dlog('agent.send.spawn-failed', { chatId, error: (err as Error).message });
      this.surfaceSpawnError(chatId, (err as Error).message);
      throw err;
    }
  }

  /** Spawn-failure surface: synchronously when getOrSpawnSession or
   *  sendUser throws. Watchdog-on-silence is gone (see the class-level
   *  comment near the textBuffers field); this is the only place we
   *  auto-mark a chat 'err' from AgentHost. ClaudeBackend handles the
   *  in-flight error signals (SDK throw / result.subtype error /
   *  mirror_error / subprocess exit). */
  private surfaceSpawnError(chatId: string, message: string): void {
    if (!isDbOpen()) return;
    const agent = getChat(chatId)?.agent ?? 'claude';
    const label = agent === 'codex' ? 'Codex' : 'Claude';
    const note = appendMessage({
      chatId,
      role: 'system',
      kind: 'system',
      body: {
        text:
          `error: failed to spawn the ${label} agent.\n` +
          message + '\n\n' +
          (agent === 'codex'
            ? 'This usually means Codex is not authenticated or the `codex` CLI could not start. '
            : 'This usually means the `claude` CLI isn\'t on PATH for the packaged app. ') +
          'Try restarting PopBot, or check ~/Library/Logs/PopBot/popbot-agent.log.',
      },
    });
    this.broadcast({ type: 'message-added', chatId, message: note, ts: Date.now() });
    updateChatStatus(chatId, 'err');
  }

  approve(chatId: string, permissionId: string, decision: PermissionDecision): void {
    // Logged at IPC entry so we can correlate user-click → approve IPC
    // → session.approve → ClaudeBackend.approve → resolve in the log.
    // Captures whether the session is still alive at decision time
    // (race between user clicking and the session disappearing).
    dlog('agent.approve', {
      chatId,
      permissionId,
      decision,
      sessionPresent: this.sessions.has(chatId),
    });
    const session = this.sessions.get(chatId);
    if (!session) {
      console.warn(`approve: no active session for chat ${chatId}`);
      return;
    }

    // Persist the decision onto the matching permission row + broadcast
    // so the renderer can collapse its big card to a one-liner.
    const id = 'perm_' + permissionId;
    const existing = getMessage(id);
    let toolForRule: string | null = null;
    if (existing) {
      try {
        const prev = JSON.parse(existing.body) as MessageBodyPermission;
        toolForRule = prev.tool;
        updateMessageBody(id, { ...prev, decision } satisfies MessageBodyPermission);
      } catch {
        // ignore body-shape errors; the decision broadcast still flips the UI
      }
    }
    // If the user picked a permanent scope, save the rule so future
    // canUseTool prompts for the same tool short-circuit. Per-chat
    // rules are stored on the chat record; global rules go to settings.
    // Tool name comes from the permission row body — if we couldn't
    // read it (parse failure / missing row), we can't store a rule
    // and silently fall back to the once-only behavior.
    if (toolForRule) {
      const action: 'allow' | 'deny' = decision.startsWith('allow') ? 'allow' : 'deny';
      if (decision === 'allow-chat') {
        addChatPermissionRule(chatId, { tool: toolForRule, action });
        dlog('perm.rule.added', { scope: 'chat', chatId, tool: toolForRule, action });
      } else if (decision === 'allow-everywhere' || decision === 'deny-everywhere') {
        const current = getSetting<PermissionRule[]>('permissions.rules') ?? [];
        const next = [
          ...current.filter((r) => r.tool !== toolForRule),
          { tool: toolForRule, action },
        ];
        setSetting('permissions.rules', next);
        dlog('perm.rule.added', { scope: 'global', tool: toolForRule, action });
      }
    }
    this.broadcast({
      type: 'permission-decided',
      chatId,
      permissionId,
      decision,
      ts: Date.now(),
    });

    // The user just answered — release the chat from its 'wait' state
    // so the thumbnail/column stop pulsing yellow before the SDK gets
    // around to emitting its own status change.
    updateChatStatus(chatId, 'run');
    this.broadcast({
      type: 'session-status',
      chatId,
      status: 'running',
      ts: Date.now(),
    });

    session.approve(permissionId, decision);
  }

  stop(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    session.stop();
    updateChatStatus(chatId, 'idle');
  }

  async configureAgent(input: {
    chatId: string;
    agent: 'claude' | 'codex';
    claudeModel?: ClaudeModelId;
    claudeReasoningEffort?: ClaudeReasoningEffort;
    codexModel?: CodexModelId;
    codexReasoningEffort?: CodexReasoningEffort;
  }) {
    const existing = this.sessions.get(input.chatId);
    if (existing) {
      await existing.dispose().catch(() => undefined);
      this.sessions.delete(input.chatId);
      this.flushAllBuffersForChat(input.chatId);
    }
    const updated = updateChatAgentConfig(input.chatId, {
      agent: input.agent,
      claudeModel: input.claudeModel,
      claudeReasoningEffort: input.claudeReasoningEffort,
      codexModel: input.codexModel,
      codexReasoningEffort: input.codexReasoningEffort,
    });
    if (!updated) throw new Error(`configureAgent: chat ${input.chatId} not found`);
    if (updated.status === 'run') {
      updateChatStatus(input.chatId, 'idle');
    }
    this.broadcast({
      type: 'session-status',
      chatId: input.chatId,
      status: updated.status === 'wait' ? 'paused' : 'idle',
      ts: Date.now(),
    });
    return getChat(input.chatId) ?? updated;
  }

  /** User-triggered recovery — used by the Retry button on a chat in
   *  the 'err' state. Walks the on-disk session pool one more time,
   *  pins the best candidate, and replays the last user message. Only
   *  fires when the user clicks, so it can't loop on its own; if the
   *  fresh spawn also errors, the auto path surfaces the same error
   *  message and waits for the next user action. */
  async recoverChat(chatId: string): Promise<void> {
    if (!isDbOpen()) return;
    const chat = getChat(chatId);
    if (!chat) return;

    dlog('agent.manual-retry', { chatId, blacklistSize: this.badSessionIds.get(chatId)?.size ?? 0 });

    // Drop the in-memory blacklist — user may have manually fixed the
    // session JSONL on disk, or the previous rejection might have been
    // a transient SDK glitch. We give every candidate a fresh shot.
    this.badSessionIds.delete(chatId);
    if (chat.agent === 'codex') clearChatCodexThreadId(chatId);
    else clearChatSessionId(chatId);
    const existing = this.sessions.get(chatId);
    if (existing) {
      void existing.dispose().catch(() => undefined);
      this.sessions.delete(chatId);
      this.flushAllBuffersForChat(chatId);
    }

    const all = listMessages(chatId);
    const { text: lastText, attachments } = this.lastUserTurn(all);

    this.broadcast({ type: 'session-status', chatId, status: 'running', ts: Date.now() });
    if (!lastText.trim() && attachments.length === 0) {
      updateChatStatus(chatId, 'idle');
      return;
    }
    try {
      const session = await this.getOrSpawnSession(chatId);
      await session.sendUser(lastText, attachments);
    } catch (err) {
      dlog('agent.manual-retry.failed', { chatId, error: (err as Error).message });
      updateChatStatus(chatId, 'err');
    }
  }

  /** Pull the most recent user turn's text + retained attachments from
   *  persisted history. The retry/recovery paths replay this turn, and
   *  a turn that carried attachments must re-send them — the retained
   *  copies under userData survive even if the source file moved — not
   *  silently degrade to a text-only resend. */
  private lastUserTurn(
    messages: ReturnType<typeof listMessages>,
  ): { text: string; attachments: PickedAttachment[] } {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.kind === 'text');
    if (!lastUser) return { text: '', attachments: [] };
    try {
      const body = JSON.parse(lastUser.body) as MessageBodyText;
      return { text: body.text ?? '', attachments: body.attachments ?? [] };
    } catch {
      return { text: '', attachments: [] };
    }
  }

  /** Surface every SDK session stored in the chat's cwd, so the
   *  chat-settings UI can let the user manually pick one to reconnect
   *  to (handy when auto-discovery picked the wrong one). Slotless
   *  chats (CR chats, etc.) don't have a worktree — fall back to the
   *  repo root, which is what AgentHost.spawn passed as the cwd. */
  async listSessionsForChat(chatId: string): Promise<
    | { ok: true; sessions: SDKSessionInfo[] }
    | { ok: false; reason: 'no-worktree' | 'error'; error?: string }
  > {
    const chat = getChat(chatId);
    if (!chat) return { ok: false, reason: 'no-worktree' };
    const cwd = sessionCwdForChat(chat);
    if (!cwd) return { ok: false, reason: 'no-worktree' };
    try {
      // Same `includeWorktrees: false` rationale as discoverSessionId
      // — without it the SDK returns sessions from sibling worktrees
      // of the repo, which can't be resumed in this cwd.
      const infos = await listSessions({ dir: cwd, includeWorktrees: false });
      infos.sort((a, b) => b.lastModified - a.lastModified);
      return { ok: true, sessions: infos };
    } catch (err) {
      return { ok: false, reason: 'error', error: (err as Error).message };
    }
  }

  /** Force-pin a specific session UUID to the chat and re-spawn into
   *  it. Used by the manual reconnect picker. */
  async setChatSession(chatId: string, sessionId: string): Promise<void> {
    setChatSessionId(chatId, sessionId);
    // Forget any prior blacklist so this id isn't excluded.
    this.badSessionIds.delete(chatId);
    const existing = this.sessions.get(chatId);
    if (existing) {
      void existing.dispose().catch(() => undefined);
      this.sessions.delete(chatId);
      this.flushAllBuffersForChat(chatId);
    }
    // Spawn now so the session attaches immediately; user's next send
    // goes to the right place.
    await this.getOrSpawnSession(chatId);
    this.broadcast({ type: 'session-status', chatId, status: 'idle', ts: Date.now() });
  }

  /** Tear down the session for a chat (e.g. on close). Awaits the
   *  backend's flush so we don't lose in-flight session JSONL writes. */
  async dispose(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;
    this.sessions.delete(chatId);
    this.flushAllBuffersForChat(chatId);
    try { await session.dispose(); } catch { /* swallow */ }
  }

  /** Tear down every session in parallel (e.g. on app quit). Returns
   *  a Promise so `before-quit` can `await` before letting Electron
   *  exit — that's what keeps the SDK subprocess from being killed
   *  mid-write to its session JSONL. */
  async disposeAll(): Promise<void> {
    dlog('agent.disposeAll.begin', { activeSessions: this.sessions.size });
    const all = [...this.sessions.keys()];
    await Promise.all(all.map((chatId) => this.dispose(chatId)));
    dlog('agent.disposeAll.done', {});
  }

  // ---- internals ----

  private async getOrSpawnSession(chatId: string): Promise<AgentSession> {
    const existing = this.sessions.get(chatId);
    if (existing && existing.isAlive()) return existing;
    if (existing) {
      // Zombie session — its SDK query has finished iterating, so any
      // sendUser would push into a queue nobody's reading. Drop it
      // and spawn a fresh one (which will resume into the pinned
      // session_id, so context is preserved).
      void existing.dispose().catch(() => undefined);
      this.sessions.delete(chatId);
      this.flushAllBuffersForChat(chatId);
    }

    const backend = this.pickBackend(chatId);
    const chat = getChat(chatId);
    // Resolve the backend-native session this chat should resume into.
    // Claude uses chats.session_id + our SQLite SessionStore; Codex
    // uses chats.codex_thread_id + ~/.codex/sessions. Keep them
    // separate so switching backends doesn't overwrite either handle.
    const isCodex = backend.id === 'codex';
    let sessionId = isCodex ? chat?.codexThreadId ?? null : chat?.sessionId ?? null;
    let discoverySource: 'pinned' | 'jsonl-discovery' | 'fresh' = sessionId ? 'pinned' : 'fresh';
    // Only run JSONL discovery for chats that already have an AGENT
    // message in them — that's the marker of a real legacy chat from
    // before the session_id column existed. A brand-new chat has just
    // the user-message we appended seconds ago in send(), and the
    // slot worktree may have stale sessions from a previous occupant
    // that would otherwise mis-match.
    // Derive the chat's current worktree from its slotId + git
    // settings on every spawn — never trust a stale chat.worktreePath
    // value. The slot a chat occupies is transient; the chat's
    // identity is (id, branch). Settings can change (slotPrefix,
    // worktreesDir, repoName) and we want every chat to follow.
    const liveWorktree = worktreePathForChat(chat);
    // Slot-bound + ephemeral chats use their derived worktree. Slot-less
    // chats (CR / Slack) deliberately run in the repo root so `gh`
    // and other repo-aware tools have a sensible cwd. Raw chats are the
    // exception: they get a stable scratch cwd and no repo fallback.
    let repoFallback: string | null = null;
    const isRawChat = chat?.repoId === RAW_CHAT_REPO_ID;
    if (!liveWorktree && !isRawChat) {
      const repo = chat?.repoId ? getRepo(chat.repoId) : null;
      repoFallback = repo?.repoPath ?? getSetting<{ repoPath?: string }>('git')?.repoPath ?? null;
    }
    // The AGENT cwd: a Perforce repo may start the agent in a configured subdir
    // of the mount root (so repo-committed `.claude/skills` are discoverable).
    // Applied here — and at every other session-cwd site — so the SDK's per-cwd
    // session store stays consistent across spawn/resume/recover.
    const cwd = applyPerforceAgentCwd(
      liveWorktree ?? repoFallback ?? (isRawChat ? rawChatCwd() : null),
      chat,
    );
    // Session discovery must use the SAME cwd we'll spawn in.
    if (!isCodex && !sessionId && liveWorktree && cwd) {
      const hasPriorAgent = listMessages(chatId).some((m) => m.role === 'agent');
      if (hasPriorAgent) {
        sessionId = await this.discoverSessionId(cwd, chatId, chat?.branch ?? null);
        if (sessionId) {
          setChatSessionId(chatId, sessionId);
          discoverySource = 'jsonl-discovery';
        }
      }
    }
    if (!cwd) {
      // No worktree AND no configured repo path. There's nowhere we
      // can spawn — surface clearly instead of letting the SDK throw
      // a vague "ENOENT" inside its bootstrap.
      throw new Error(
        `cannot spawn session for chat ${chatId}: no worktreePath and no git repo path configured. ` +
        `Set a repository in Preferences → Source control, or assign this chat to a slot.`,
      );
    }

    // Pre-spawn diagnostic: log whether the SDK's per-cwd JSONL
    // exists. Pre-sessionStore, missing JSONL meant unresumable; we
    // cleared the pin and spawned fresh. With sessionStore, the SDK
    // reads from `sqliteSessionStore.load()` — claude's local JSONL
    // is just a redundant cache. We log for diagnostics but no
    // longer treat its absence as a context-loss event.
    if (!isCodex && sessionId && cwd) {
      const jsonlPath = sdkSessionJsonlPath(cwd, sessionId);
      const present = jsonlPath ? existsSync(jsonlPath) : false;
      dlog('agent.spawn.jsonl-check', {
        chatId, sessionId, cwd, jsonlPath, present, source: discoverySource,
      });
    }

    dlog('agent.spawn', {
      chatId, cwd, sessionId, source: discoverySource,
      backend: backend.id,
    });

    const session = backend.spawn({
      chatId,
      history: [],
      cwd,
      sessionId,
      claudeModel: !isCodex ? chat?.claudeModel ?? DEFAULT_CLAUDE_MODEL : null,
      claudeReasoningEffort: !isCodex
        ? chat?.claudeReasoningEffort ?? DEFAULT_CLAUDE_REASONING_EFFORT
        : null,
      codexModel: isCodex ? chat?.codexModel ?? DEFAULT_CODEX_MODEL : null,
      codexReasoningEffort: isCodex
        ? chat?.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT
        : null,
      pathToClaudeCodeExecutable: getClaudeBinaryPath(),
      pathToCodexExecutable: getCodexBinaryPath(),
      onEvent: (event) => this.handleEvent(event),
      onCodexEvent: (event) => {
        if (!isDbOpen()) return;
        appendCodexThreadEvent(event);
      },
      onSessionId: (sid) => {
        if (!isDbOpen()) return;
        const current = getChat(chatId);
        const prior = isCodex ? current?.codexThreadId ?? null : current?.sessionId ?? null;
        if (prior !== sid) {
          dlog('agent.session-id', { chatId, prior, reported: sid });
        }
        if (isCodex) setChatCodexThreadId(chatId, sid);
        else setChatSessionId(chatId, sid);
      },
      // Per-chat rules win over global rules so a chat can override a
      // global allow with a deny (or vice versa). null/undefined → no
      // saved rule for this tool, prompt the user.
      resolveRule: (toolName: string) => {
        const chatRules = getChatPermissionRules(chatId);
        const chatHit = chatRules.find((r) => r.tool === toolName);
        if (chatHit) return chatHit.action;
        const globalRules = getSetting<PermissionRule[]>('permissions.rules') ?? [];
        const globalHit = globalRules.find((r) => r.tool === toolName);
        return globalHit ? globalHit.action : null;
      },
    });
    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * Best-effort session-discovery for chats that don't have a pinned
   * session_id yet. Walks `listSessions` for the worktree dir and
   * picks one whose `gitBranch` matches; falls back to a `firstPrompt`
   * match against the chat's first user message. Returns null when no
   * confident match is found (caller will start fresh).
   */
  /**
   * Self-heal a chat whose pinned `session_id` points to a JSONL the
   * SDK can't find. Clears the bad id, tears down the broken session,
   * and replays the most-recent user message on a fresh session so the
   * agent's reply lands as if nothing happened. Adds a one-line system
   * note so the user knows the chat was auto-recovered.
   */
  /** Per-chat blacklist of session_ids that the SDK has rejected this
   *  process. Discovery skips these so we don't keep picking a known-
   *  broken session. Cleared when the chat closes / disposes. */
  private readonly badSessionIds = new Map<string, Set<string>>();
  /** Last auto-recovery attempt per chat. Used to prevent the recover
   *  -> replay -> reject -> recover loop that bit users in v0.0.4 by
   *  forcing a 30s cooldown between attempts; manual retry via the
   *  Retry button bypasses this. */
  private readonly lastAutoRecoveryAt = new Map<string, number>();
  private static readonly AUTO_RECOVERY_COOLDOWN_MS = 30_000;

  /**
   * Auto-recover when the SDK rejects a pinned session_id. Tries
   * discovery + one replay attempt, but only ONCE per chat per 30s
   * window — that breaks the recover→replay→reject loop that bit
   * users in v0.0.4 (the agent's initial prompt would resurface over
   * and over). After cooldown the chat just lands in 'err' with a
   * one-line note, and the user can hit Retry or send a new message.
   */
  private async recoverFromBadSession(chatId: string, badId: string | null): Promise<void> {
    if (!isDbOpen()) return;
    const chat = getChat(chatId);
    if (!chat) return;

    const now = Date.now();
    const lastAt = this.lastAutoRecoveryAt.get(chatId) ?? 0;
    const sinceLast = now - lastAt;
    dlog('agent.bad-session', {
      chatId, badId, worktree: chat.worktreePath, sinceLastMs: sinceLast,
    });

    if (badId) {
      let set = this.badSessionIds.get(chatId);
      if (!set) { set = new Set(); this.badSessionIds.set(chatId, set); }
      set.add(badId);
    }
    clearChatSessionId(chatId);
    const existing = this.sessions.get(chatId);
    if (existing) {
      void existing.dispose().catch(() => undefined);
      this.sessions.delete(chatId);
      this.flushAllBuffersForChat(chatId);
    }

    // Cooldown trip — don't replay. Surface the error and wait for
    // a manual retry or a brand-new user message.
    if (sinceLast < AgentHostImpl.AUTO_RECOVERY_COOLDOWN_MS) {
      dlog('agent.bad-session.cooldown-skip', { chatId, sinceLastMs: sinceLast });
      this.surfaceSessionLost(chatId);
      return;
    }
    this.lastAutoRecoveryAt.set(chatId, now);

    // First attempt this window: try discovery + replay last user.
    const all = listMessages(chatId);
    const hasPriorAgent = all.some((m) => m.role === 'agent');
    const { text: lastText, attachments } = this.lastUserTurn(all);

    let nextSessionId: string | null = null;
    const liveWorktreeForRecovery = applyPerforceAgentCwd(worktreePathForChat(chat), chat);
    if (hasPriorAgent && liveWorktreeForRecovery) {
      const candidate = await this.discoverSessionId(liveWorktreeForRecovery, chatId, chat.branch);
      if (candidate && !this.badSessionIds.get(chatId)?.has(candidate)) {
        nextSessionId = candidate;
      }
    }
    if (hasPriorAgent && !nextSessionId) {
      this.surfaceSessionLost(chatId);
      return;
    }
    if (nextSessionId) setChatSessionId(chatId, nextSessionId);

    this.broadcast({ type: 'session-status', chatId, status: 'running', ts: Date.now() });
    if (!lastText.trim() && attachments.length === 0) {
      updateChatStatus(chatId, 'idle');
      return;
    }
    try {
      const session = await this.getOrSpawnSession(chatId);
      await session.sendUser(lastText, attachments);
    } catch (err) {
      dlog('agent.auto-recover.failed', { chatId, error: (err as Error).message });
      this.surfaceSessionLost(chatId);
    }
  }

  // NOTE: a `surfaceContextLost` helper used to live here for the case
  // where a pinned session_id's JSONL was missing on disk. Since
  // sqliteSessionStore became the canonical context store, JSONL
  // absence is no longer a context-loss event — the SDK resumes from
  // SQLite regardless. The helper is gone; if the SDK genuinely can't
  // resume, that surfaces via the result.error path which now feeds
  // the actual error string into the chat.

  /**
   * Spawn a fresh SDK session and prime it with a compact rendering of
   * this chat's existing transcript. Used to recover after a context-
   * loss event — the agent gets enough history to continue the work
   * even though the original Claude session is gone.
   *
   * "Within reason" means: text turns only, capped at the last 50
   * user/agent messages and ~80k characters total — older turns get
   * trimmed (oldest-first) so the most recent context survives.
   */
  async restartWithContext(
    chatId: string,
    opts?: { continueLatestInstruction?: boolean },
  ): Promise<void> {
    if (!isDbOpen()) return;
    const chat = getChat(chatId);
    if (!chat) return;

    dlog('agent.restart-with-context.begin', { chatId });

    // Tear down whatever's there. Drop the bad-id memory + clear the
    // pinned id so we spawn fresh.
    this.badSessionIds.delete(chatId);
    if (chat.agent === 'codex') clearChatCodexThreadId(chatId);
    else clearChatSessionId(chatId);
    const existing = this.sessions.get(chatId);
    if (existing) {
      void existing.dispose().catch(() => undefined);
      this.sessions.delete(chatId);
      this.flushAllBuffersForChat(chatId);
    }

    // Build the priming prompt. We only include user + agent text
    // turns — tool-call/result messages get summarized away to keep
    // the size manageable.
    const all = listMessages(chatId);
    const turns: Array<{ role: 'user' | 'agent'; text: string }> = [];
    for (const m of all) {
      if (m.kind !== 'text') continue;
      if (m.role !== 'user' && m.role !== 'agent') continue;
      try {
        const t = (JSON.parse(m.body) as MessageBodyText).text ?? '';
        if (t.trim()) turns.push({ role: m.role, text: t });
      } catch { /* malformed body — skip */ }
    }
    // Head + tail trimming. The first few turns usually establish the
    // chat's goal (ticket/PR description, "review this", etc.) — those
    // stay no matter what. The rest is the recent action; we keep as
    // many of the newest as fit under the char cap.
    const HEAD_KEEP = 3;
    const MAX_CHARS = 80_000;
    const head = turns.slice(0, HEAD_KEEP);
    const candidates = turns.slice(HEAD_KEEP);
    let total = head.reduce((n, t) => n + t.text.length, 0);
    const tail: typeof turns = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const len = candidates[i].text.length;
      if (total + len > MAX_CHARS && tail.length > 0) break;
      tail.unshift(candidates[i]);
      total += len;
    }
    const omitted = candidates.length - tail.length;
    const render = (t: { role: 'user' | 'agent'; text: string }): string =>
      `### ${t.role === 'user' ? 'User' : 'Assistant'}\n${t.text}`;
    const omittedMarker = `### ... [${omitted} turn${omitted === 1 ? '' : 's'} omitted for length] ...\n`;
    const sections = [
      ...head.map(render),
      ...(omitted > 0 ? [omittedMarker] : []),
      ...tail.map(render),
    ];
    const transcript = sections.join('\n\n');
    const nextStep = opts?.continueLatestInstruction
      ? 'After reading, continue from the latest user instruction using this recovered context.'
      : 'After reading, briefly summarize what you understand we\'re working on, then wait for the user\'s next instruction.';
    const preamble =
      `Context-recovery: this chat lost its previous ${chat.agent === 'codex' ? 'Codex' : 'Claude'} session. ` +
      `Below is the prior conversation${omitted > 0 ? ` (with ${omitted} middle turn(s) omitted for length)` : ''}, ` +
      `so you can pick up where we left off. ${nextStep}\n\n` +
      '--- prior conversation ---\n\n';
    const primer = preamble + transcript;

    dlog('agent.restart-with-context.prompt', {
      chatId,
      turnsKept: head.length + tail.length,
      omitted,
      charCount: primer.length,
    });

    updateChatStatus(chatId, 'run', 'Restarting with prior context…');
    this.broadcast({ type: 'session-status', chatId, status: 'running', ts: Date.now() });
    try {
      const session = await this.getOrSpawnSession(chatId);
      await session.sendUser(primer);
    } catch (err) {
      dlog('agent.restart-with-context.failed', { chatId, error: (err as Error).message });
      updateChatStatus(chatId, 'err');
    }
  }

  /** One-shot system note + 'err' status for a chat whose SDK session
   *  can't be loaded. Re-used by the cooldown branch and the manual
   *  retry path. */
  private surfaceSessionLost(chatId: string): void {
    const agent = getChat(chatId)?.agent ?? 'claude';
    const label = agent === 'codex' ? 'Codex thread' : 'Claude session';
    const note = appendMessage({
      chatId,
      role: 'system',
      kind: 'system',
      body: {
        text:
          `error: this chat's saved ${label} can no longer be loaded.\n` +
          'The transcript above is preserved, but the agent has lost its memory of it. ' +
          'Send a new message to continue with a fresh context (the agent will not recall earlier turns), ' +
          'or click Retry to attempt reconnection again.',
      },
    });
    this.broadcast({ type: 'message-added', chatId, message: note, ts: Date.now() });
    updateChatStatus(chatId, 'err');
  }

  private shouldRestartCodexWithContext(chatId: string, message: string): boolean {
    const chat = getChat(chatId);
    if (chat?.agent !== 'codex') return false;
    if (!chat.codexThreadId) return false;
    const lower = message.toLowerCase();
    return (
      lower.includes('no conversation found')
      || lower.includes('thread') && (lower.includes('not found') || lower.includes('missing'))
      || lower.includes('session') && (lower.includes('not found') || lower.includes('missing'))
      || lower.includes('resume') && (lower.includes('failed') || lower.includes('not found'))
    );
  }

  /** Pre-flight check used when a chat is opened in the UI: does its
   *  pinned session_id actually exist on disk? Returns 'ok' if there's
   *  no pinned id (fresh chats are fine), or if the JSONL file is
   *  present where the SDK expects it. Otherwise 'missing'. The
   *  renderer can show a clear "this chat needs to start fresh"
   *  banner before the user sends and triggers the SDK error. */
  validateChatSession(chatId: string): { state: 'ok' | 'missing' | 'unknown'; details?: string } {
    const chat = getChat(chatId);
    if (!chat) return { state: 'unknown', details: 'chat not found' };
    if (chat.agent === 'codex') return { state: 'ok' };
    if (!chat.sessionId) return { state: 'ok' };
    const cwd = sessionCwdForChat(chat);
    if (!cwd) return { state: 'unknown', details: 'no cwd' };
    const jsonl = sdkSessionJsonlPath(cwd, chat.sessionId);
    const present = jsonl ? existsSync(jsonl) : false;
    dlog('agent.validate', { chatId, sessionId: chat.sessionId, cwd, jsonl, present });
    return present ? { state: 'ok' } : { state: 'missing', details: jsonl ?? undefined };
  }

  /**
   * Find a session this chat can resume into.
   *
   * Now queries our `sqliteSessionStore` directly by `chat_id` — no
   * disk scanning, no cwd / project_key dependency, no branch /
   * prompt disambiguation. The chat OWNS its sessions through the
   * `chat_id` column on `sdk_session_entries`. Slot reassignment
   * doesn't move the data and doesn't move the ownership; the
   * lookup is stable across the chat's full lifetime.
   *
   * Picks the session with the most entries (= the real working
   * session; fresh-error sessions are tiny), tie-breaking on most-
   * recent activity. Blacklists from this run are still honored.
   *
   * The `cwd` and `chatBranch` parameters are unused — kept on the
   * signature for now to avoid call-site churn during this change.
   */
  private async discoverSessionId(
    _cwd: string,
    chatId: string,
    _chatBranch: string | null,
  ): Promise<string | null> {
    const sessions = sqliteSessionStore.listSessionsForChat(chatId);
    if (sessions.length === 0) {
      dlog('agent.discover.no-candidates', { chatId, why: 'no-rows-for-chat' });
      return null;
    }
    const blacklist = this.badSessionIds.get(chatId);
    const available = blacklist && blacklist.size > 0
      ? sessions.filter((s) => !blacklist.has(s.sessionId))
      : sessions;
    if (available.length === 0) {
      dlog('agent.discover.no-candidates', {
        chatId, why: 'all-blacklisted', blacklisted: blacklist?.size ?? 0,
      });
      return null;
    }
    available.sort((a, b) => {
      if (b.entryCount !== a.entryCount) return b.entryCount - a.entryCount;
      return b.mtime - a.mtime;
    });
    const picked = available[0];
    dlog('agent.discover.picked', {
      chatId,
      sessionId: picked.sessionId,
      why: 'chat-keyed-most-entries',
      entryCount: picked.entryCount,
      mtime: picked.mtime,
      candidates: sessions.length,
      blacklisted: blacklist?.size ?? 0,
    });
    return picked.sessionId;
  }

  private pickBackend(chatId: string): AgentBackend {
    const chat = getChat(chatId);
    if (!chat) throw new Error(`pickBackend: chat ${chatId} not found`);
    // Set POPBOT_USE_STUB=1 to force the echo backend (useful for UI work
    // when you don't want to burn API credits).
    if (process.env.POPBOT_USE_STUB === '1') return StubBackend;
    if (chat.agent === 'claude') return ClaudeBackend;
    if (chat.agent === 'codex') return CodexBackend;
    return ClaudeBackend;
  }

  /**
   * The single sink for every event a session produces. Persists +
   * broadcasts. Order matters: persist first so a renderer that reloads
   * mid-stream sees a consistent view.
   */
  private handleEvent(event: AgentEvent): void {
    // The SDK can keep emitting events for a beat after disposeAll on
    // app quit, after closeDb has already nulled out the connection.
    // Drop those silently — there's no UI to broadcast to either.
    if (!isDbOpen()) return;
    try {
      this.persist(event);
    } catch (err) {
      console.error('AgentHost.persist failed', err);
    }
    this.broadcast(event);
  }

  private persist(event: AgentEvent): void {
    switch (event.type) {
      case 'message-start': {
        appendMessage({
          id: event.messageId,
          chatId: event.chatId,
          role: event.role,
          kind: 'text',
          body: { text: '' } satisfies MessageBodyText,
        });
        this.textBuffers.set(event.messageId, {
          chatId: event.chatId,
          messageId: event.messageId,
          buffer: '',
          flushTimer: null,
        });
        return;
      }

      case 'text-delta': {
        const buf = this.textBuffers.get(event.messageId);
        if (!buf) {
          // Late delta with no message-start — recover by inserting a row.
          appendMessage({
            id: event.messageId,
            chatId: event.chatId,
            role: 'agent',
            kind: 'text',
            body: { text: event.delta } satisfies MessageBodyText,
          });
          this.textBuffers.set(event.messageId, {
            chatId: event.chatId,
            messageId: event.messageId,
            buffer: event.delta,
            flushTimer: null,
          });
          return;
        }
        buf.buffer += event.delta;
        this.scheduleFlush(buf.messageId);
        return;
      }

      case 'message-end': {
        this.flushBuffer(event.messageId);
        // Snapshot a snippet for the chat thumbnail. Also detect the
        // "agent ended with a question" case — flip to wait so the
        // thumbnail goes yellow + the chat column rail tints.
        const buf = this.textBuffers.get(event.messageId);
        if (buf) {
          const trimmed = buf.buffer.trimEnd();
          const endsInQuestion = looksLikeQuestion(trimmed);
          const status = endsInQuestion ? 'wait' : 'idle';
          updateChatStatus(event.chatId, status, trimmed.slice(0, 140));
          if (endsInQuestion) {
            // Broadcast a synthetic paused session-status so the
            // renderer's in-memory chat status mirrors the DB. The
            // result-message's session-status='idle' that follows is
            // filtered out by the guard in the session-status branch.
            this.broadcast({
              type: 'session-status',
              chatId: event.chatId,
              status: 'paused',
              ts: Date.now(),
            });
          }
          this.textBuffers.delete(event.messageId);
        }
        return;
      }

      case 'tool-use': {
        // Tool-use can fire twice: early via stream_event content_block_start
        // (we get name + id, args may still be partial) and later via the
        // finalized assistant SDKMessage (complete args). Upsert-and-merge
        // so the second emission updates rather than throws on UNIQUE.
        const id = 'tool_' + event.toolUseId;
        const existing = getMessage(id);
        if (!existing) {
          appendMessage({
            id,
            chatId: event.chatId,
            role: 'agent',
            kind: 'tool',
            body: {
              toolUseId: event.toolUseId,
              name: event.name,
              args: event.args,
            } satisfies MessageBodyTool,
          });
          return;
        }
        let prevBody: MessageBodyTool = { toolUseId: event.toolUseId, name: '', args: {} };
        try {
          prevBody = JSON.parse(existing.body) as MessageBodyTool;
        } catch {
          // fall through with default
        }
        updateMessageBody(id, {
          toolUseId: event.toolUseId,
          // Prefer non-empty incoming values over prior, so a finalized
          // emission with full args overwrites a partial-empty earlier one.
          name: event.name || prevBody.name,
          args: Object.keys(event.args).length > 0 ? event.args : prevBody.args,
          result: prevBody.result,
          isError: prevBody.isError,
        } satisfies MessageBodyTool);
        return;
      }

      case 'tool-result': {
        const id = 'tool_' + event.toolUseId;
        // Read the existing tool row so we don't blow away name + args
        // when the result arrives (the live renderer preserves them via
        // its in-place patch, but the DB has to be merged explicitly).
        const existing = getMessage(id);
        let prevBody: MessageBodyTool | null = null;
        if (existing) {
          try {
            prevBody = JSON.parse(existing.body) as MessageBodyTool;
          } catch {
            prevBody = null;
          }
        }
        updateMessageBody(id, {
          toolUseId: event.toolUseId,
          name: prevBody?.name ?? '',
          args: prevBody?.args ?? {},
          result: event.text,
          isError: event.isError,
        } satisfies MessageBodyTool);
        return;
      }

      case 'permission-request': {
        appendMessage({
          id: 'perm_' + event.permissionId,
          chatId: event.chatId,
          role: 'system',
          kind: 'permission',
          body: {
            permissionId: event.permissionId,
            tool: event.tool,
            args: event.args,
            reason: event.reason,
          } satisfies MessageBodyPermission,
        });
        updateChatStatus(event.chatId, 'wait', `needs you: ${event.tool}`);
        return;
      }

      case 'session-status': {
        const map = {
          running: 'run',
          idle: 'idle',
          paused: 'wait',
          errored: 'err',
          complete: 'done',
        } as const;
        const next = map[event.status];
        // Don't let the SDK's end-of-turn 'idle' clobber a 'wait' that
        // message-end just set (ends-in-question case).
        if (next === 'idle') {
          const chat = getChat(event.chatId);
          if (chat?.status === 'wait') return;
        }
        updateChatStatus(event.chatId, next);
        return;
      }

      case 'usage': {
        updateChatTokens(event.chatId, event.tokens.used, event.tokens.budget);
        return;
      }

      case 'error': {
        // Self-heal: when the SDK reports a stale resume session, clear
        // the pinned id and replay the most recent user message on a
        // fresh session. The user sees a one-line note that the chat
        // was recovered, then the agent's normal reply.
        const badIdMatch = /no conversation found with session id:\s*([a-f0-9-]+)/i.exec(event.message);
        if (badIdMatch) {
          const badId = badIdMatch[1] ?? null;
          void this.recoverFromBadSession(event.chatId, badId);
          return;
        }
        if (this.shouldRestartCodexWithContext(event.chatId, event.message)) {
          dlog('agent.codex-thread-lost', { chatId: event.chatId, error: event.message });
          void this.restartWithContext(event.chatId, { continueLatestInstruction: true });
          return;
        }
        appendMessage({
          chatId: event.chatId,
          role: 'system',
          kind: 'system',
          body: { text: `error: ${event.message}` },
        });
        updateChatStatus(event.chatId, 'err', event.message.slice(0, 140));
        return;
      }
    }
  }

  private scheduleFlush(messageId: string): void {
    const buf = this.textBuffers.get(messageId);
    if (!buf || buf.flushTimer) return;
    buf.flushTimer = setTimeout(() => this.flushBuffer(messageId), 250);
  }

  private flushBuffer(messageId: string): void {
    const buf = this.textBuffers.get(messageId);
    if (!buf) return;
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    updateMessageBody(messageId, { text: buf.buffer } satisfies MessageBodyText);
  }

  private flushAllBuffersForChat(chatId: string): void {
    for (const [messageId, buf] of this.textBuffers) {
      if (buf.chatId === chatId) {
        this.flushBuffer(messageId);
        this.textBuffers.delete(messageId);
      }
    }
  }

  private broadcast(event: AgentEvent): void {
    if (!this.webContents) return;
    if (this.webContents.isDestroyed()) return;
    this.webContents.send(IpcChannel.AgentEvent, event);
  }
}

export const AgentHost = new AgentHostImpl();
