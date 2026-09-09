import type { WebContents } from 'electron';
import { compactionNoteText } from '@shared/contextUsage';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import { resolvePermissionRules, mcpServerOfTool, mcpServerWildcard } from '@shared/agent';
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
  setChatProviderContextAt,
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
import { LOCALES, LOCALE_SETTING_KEY, resolveLocale } from '@shared/i18n';
import { mcpEndpointForChat } from '../ipc/apps';
import type { AgentBackend, AgentSession } from './types';
import { StubBackend } from './StubBackend';
import { ClaudeBackend } from './ClaudeBackend';
import { CodexBackend } from './CodexBackend';
import { getCodexBinaryPath } from './codexProbe';
import { persistChatAttachments } from '../attachments/store';

type ProviderAgent = 'claude' | 'codex';

/**
 * Render the part of PopBot's shared SQLite transcript a provider has not seen.
 *
 * Claude and Codex each keep their own native session, but the visible chat is
 * one conversation. On a provider switch this bridge is prepended invisibly to
 * the next user turn. It contains text only: replaying tool records would imply
 * that tools should run again, which is both misleading and unsafe.
 *
 * The bridge is bounded just like restartWithContext: preserve the opening
 * turns (usually the task definition), then as much recent context as fits.
 */
function providerContextBridge(
  messages: ReturnType<typeof listMessages>,
  contextAt: number,
  provider: ProviderAgent,
): string {
  const missed: Array<{ role: 'user' | 'agent'; text: string; at: number }> = [];
  for (const message of messages) {
    if (message.updatedAt <= contextAt || message.kind !== 'text') continue;
    if (message.role !== 'user' && message.role !== 'agent') continue;
    try {
      const text = (JSON.parse(message.body) as MessageBodyText).text ?? '';
      if (text.trim()) missed.push({ role: message.role, text, at: message.updatedAt });
    } catch {
      // A malformed historical row must not prevent the next provider turn.
    }
  }
  if (missed.length === 0) return '';

  const HEAD_KEEP = 3;
  const MAX_CHARS = 80_000;
  const head = contextAt === 0 ? missed.slice(0, HEAD_KEEP) : [];
  const candidates = contextAt === 0 ? missed.slice(HEAD_KEEP) : missed;
  let total = head.reduce((n, item) => n + item.text.length, 0);
  const tail: typeof missed = [];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (total + candidates[i].text.length > MAX_CHARS && tail.length > 0) break;
    tail.unshift(candidates[i]);
    total += candidates[i].text.length;
  }
  const omitted = candidates.length - tail.length;
  const render = (item: (typeof missed)[number]): string =>
    `### ${item.role === 'user' ? 'User' : 'Assistant'}\n${item.text}`;
  const transcript = [
    ...head.map(render),
    ...(omitted > 0 ? [`### ... [${omitted} older turn${omitted === 1 ? '' : 's'} omitted] ...`] : []),
    ...tail.map(render),
  ].join('\n\n');
  const label = provider === 'codex' ? 'Codex' : 'Claude';
  return (
    `[PopBot context synchronization for ${label}]\n`
    + 'This is the same PopBot chat, continued across another model. '
    + 'The following transcript turns happened outside your native session. '
    + 'Absorb them as prior conversation; do not summarize or respond to this block separately.\n\n'
    + transcript
    + '\n\n[End PopBot context synchronization]\n\n'
  );
}

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

/**
 * An invisible one-line preamble prepended to the FIRST message an agent
 * receives in a spawned session. It is NOT stored or shown in the transcript —
 * only the agent sees it — so the chat history stays clean.
 *
 * Three cases:
 *   - `isFresh` (no prior agent message): a brand-new chat → announce the cwd,
 *     the user's language, and promise a heads-up on resume.
 *   - `resumed` (reopened from the inactive list — flagged by the reopen
 *     handler): the chat was closed and re-attached to a slot, so re-state the
 *     current cwd because it may differ from the path the agent recalls. We
 *     can't tell if the slot number actually changed (closeChat nulls the old
 *     slot_id), so we always re-state on resume rather than risk staying silent.
 *   - neither (a live in-session turn): the agent already knows its cwd → '' .
 *
 * Returns '' when there's no resolvable cwd (raw scratch chats, mis-config).
 * MCP config is handled automatically at editor-launch time, so it is
 * deliberately NOT mentioned here.
 */
export function firstMessageCwdPreamble(
  chat: Pick<ChatRecord, 'slotId' | 'repoId' | 'worktreePath'> | null | undefined,
  isFresh: boolean,
  resumed: boolean,
): string {
  if (!isFresh && !resumed) return '';
  const cwd = sessionCwdForChat(chat);
  if (!cwd) return '';
  // A LOCAL (not UTC) timestamp so the agent can gauge how much wall-clock time
  // has passed (e.g. a resume hours/days after the last turn). The `sv-SE`
  // locale gives a compact, sortable ISO-like "YYYY-MM-DD HH:MM" in local time.
  const now = new Date().toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
  return isFresh
    ? `[System] Starting up at ${now} in this working directory: ${cwd}.${languageDirective()} ` +
        `Instructions will follow. If this chat is later paused and resumed, you'll be told here ` +
        `its working directory (which may have changed).\n\n`
    : `[System] This chat resumed at ${now}. Its working directory is now: ${cwd} — this may ` +
        `differ from before (a resumed chat can move to a new slot), so use this path for all ` +
        `file reads, edits, and commands from here on; any path you recall from earlier may be stale.\n\n`;
}

/** A sentence telling the agent to respond in the user's chosen UI language,
 *  or '' when that language is English (the default — no directive needed).
 *  Prefixed with a leading space so it slots into the fresh-start preamble. */
function languageDirective(): string {
  const locale = resolveLocale(getSetting<string>(LOCALE_SETTING_KEY) ?? undefined);
  if (locale === 'en') return '';
  const meta = LOCALES.find((l) => l.code === locale);
  if (!meta) return '';
  return ` The user's language is ${meta.englishName} (${meta.nativeName}); respond in ${meta.englishName} unless they write to you in another language.`;
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
  /** Latest failure text per chat, kept until a real reply lands. Lets a
   *  manual Retry tell "the native session is gone" from a passing API
   *  error, and keep the conversation handle in the latter case. */
  private readonly lastErrorText = new Map<string, string>();
  // Chats that were just reopened from the inactive list. The next first-message
  // preamble re-states the current working directory (it may have moved slots),
  // then the flag is cleared. Set by the reopen handler.
  private readonly resumedChats = new Set<string>();
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
  //
  // EXCEPT for one failure the state machine provably cannot see: the
  // upstream request hangs. The CLI accepts the turn (we get
  // `claude.init`) and then the API call never produces a token — logs
  // show real cases at duration_api_ms 612271 with output_tokens 0. No
  // iterator throw, no result message, no subprocess exit; the session
  // stays isAlive() so every later send just queues behind the wedged
  // turn. The chat spins forever with no error, and only a dispose
  // (close/reopen the chat, or quit the app) clears it.
  //
  // stallTimers is a NARROW watchdog for exactly that: armed when a user
  // turn is handed to the backend, disarmed by the first byte of model
  // output. It never runs during tool execution or a permission wait —
  // those disarm it — so the old watchdog's false-flag mode can't recur.
  private readonly stallTimers = new Map<string, NodeJS.Timeout>();
  // Nothing here used to track how many user turns were outstanding, and
  // that is the other half of the "sent it, got nothing back" report.
  // Status was derived 1:1 from the SDK: the agent finishes the turn it
  // was on, we see `result`, we set idle. But the composer lets you hit
  // Enter mid-turn (only the Send BUTTON is swapped for Stop), so a
  // message sent while the agent is busy just queues inside the CLI. The
  // in-flight turn then ends, we flip the chat to IDLE — and the message
  // the user just typed has never been looked at. It reads exactly like
  // "it spun for a second and then ignored me".
  //
  // queuedTurns counts user turns handed to the backend that no turn has
  // STARTED on yet (turn-start resets it). While it's non-zero the chat
  // is held in 'run' and the stall clock keeps running, so the queued
  // message either gets answered or surfaces as a failure.
  //
  // Counting sends-since-turn-start rather than sends-minus-results is
  // what makes this safe against the CLI coalescing several queued
  // messages into one turn: coalesced messages are all queued BEFORE the
  // turn starts, so turn-start zeroes them together and the single
  // result correctly ends the chat as idle.
  private readonly queuedTurns = new Map<string, number>();
  // The counter above drains on turn-start, which assumes every dequeued
  // message gets its own turn. It doesn't: the CLI can FOLD a message
  // that arrives mid-turn into the turn already running, answer it
  // there, and never emit a second init. Observed live — user asked a
  // question at :06, agent answered at :11 inside the running turn, and
  // the count was still 1 when that turn's result landed at :20.
  //
  // From the outside those two cases are indistinguishable: "answered
  // inside the running turn" and "still sitting unqueued" produce the
  // same events. So the hold is a heuristic, and a heuristic must not
  // drive a destructive recovery. settleTimers bounds it — if no further
  // turn materializes, the chat just goes quietly idle. Killing the
  // session is reserved for the unambiguous case (see TURN_STALL_MS:
  // a send that produced NO output whatsoever).
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  /** Consecutive silent replays per chat, reset the moment a turn
   *  produces real output or the user sends something new. */
  private readonly autoRetries = new Map<string, number>();
  /** How many times to quietly redo a turn that came back with nothing
   *  before giving up and telling the user why. Two is enough to ride
   *  out an overloaded upstream or a dropped stream without turning a
   *  persistent failure into an endless loop. */
  private static readonly MAX_AUTO_RETRIES = 5;

  /** How long to hold a chat in 'run' waiting for a queued message to
   *  get its own turn, before concluding it was folded into the turn
   *  that just ended and settling to idle. */
  private static readonly QUEUED_TURN_SETTLE_MS = 45_000;
  /** Chats on a backend that reports turn starts (Claude). Only these
   *  can be held in 'run' by queuedTurns — for a backend that never
   *  emits turn-start the count would never drain and every chat would
   *  wedge at 'run'. */
  private readonly turnAwareChats = new Set<string>();
  /** Chats between a backend-native turn-start and terminal status. Used as a
   * hard guard against heuristic settle timers overriding real activity. */
  private readonly activeTurns = new Set<string>();
  /** Chats explicitly stopped by the user. Providers may report their
   * cancellation as an error after stop() returns; those errors are an
   * implementation detail, not a failed chat turn. The marker remains until
   * the next send so delayed cancellation events cannot turn the chat red. */
  private readonly stoppedChats = new Set<string>();
  /** How long a turn may produce NOTHING before we call it wedged.
   *  Generous by design: a healthy turn emits its first stream event in
   *  seconds (includePartialMessages is on), so minutes of total silence
   *  is never normal. */
  private static readonly TURN_STALL_MS = 180_000;

  /** Wired at app boot so events can reach the renderer. */
  attachWindow(webContents: WebContents): void {
    this.webContents = webContents;
  }

  /** Record that a chat was just reopened, so the next first-message preamble
   *  re-states its (possibly moved) working directory to the agent. Called by
   *  the reopen handler. */
  markResumed(chatId: string): void {
    this.resumedChats.add(chatId);
  }

  /** Send a user message to a chat. Spawns a session if none exists. */
  async send(chatId: string, text: string, attachments?: PickedAttachment[]): Promise<void> {
    const chat = getChat(chatId);
    if (!chat) throw new Error(`send: chat ${chatId} not found`);
    // A new instruction ends the stopped state. Failures from this turn are
    // genuine and must be surfaced normally.
    this.stoppedChats.delete(chatId);
    // A fresh user action gets a fresh self-heal budget. Recovery attempts are
    // bounded per unanswered request, not forever across the life of a chat.
    this.autoRetries.delete(chatId);
    const provider: ProviderAgent = chat.agent === 'codex' ? 'codex' : 'claude';
    const nativeHandle = provider === 'codex' ? chat.codexThreadId : chat.sessionId;
    const providerContextAt = nativeHandle
      ? (provider === 'codex' ? chat.codexContextAt : chat.claudeContextAt)
      : 0;
    // Snapshot before appending the new user message: the bridge is prior
    // conversation only. The current instruction is sent once, normally.
    const priorMessages = listMessages(chatId);

    dlog('agent.send', {
      chatId,
      provider,
      textLen: text.length,
      claudeSessionId: chat.sessionId ?? null,
      codexThreadId: chat.codexThreadId ?? null,
      providerContextAt,
      worktree: chat.worktreePath ?? null,
      branch: chat.branch ?? null,
    });

    // Prepend an invisible working-directory preamble on the FIRST message of a
    // spawned session (no live session yet) — only the agent sees it (the
    // stored/broadcast user bubble below uses the raw `text`). A fresh chat gets
    // a "starting up here" note; a reopened chat (flagged by the reopen handler)
    // gets its current cwd re-stated in case it moved slots. A live in-session
    // turn gets nothing — the agent already knows its cwd.
    const firstOfSession = !this.sessions.get(chatId)?.isAlive();
    const isFresh = !priorMessages.some((m) => m.role === 'agent');
    // Read (don't consume) the resume flag — we only clear it AFTER the message
    // is actually delivered, so a spawn/send failure preserves it for the retry.
    const resumed = this.resumedChats.has(chatId);
    // A typed `/compact` is a command for the CLI, not prose for the model:
    // anything prepended to it (the cwd preamble, the provider context
    // bridge) would turn it into an ordinary message. Send it bare — the
    // same thing the context gauge does.
    const isCompactCommand = provider === 'claude' && /^\/compact(\s|$)/.test(text.trim());
    const preamble = firstOfSession && !isCompactCommand
      ? firstMessageCwdPreamble(chat, isFresh, resumed)
      : '';

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
      const contextBridge = firstOfSession && !isCompactCommand
        ? providerContextBridge(priorMessages, providerContextAt, provider)
        : '';
      // The preamble (if any) rides on the first message to the agent only; it
      // is intentionally absent from the persisted/broadcast user bubble above.
      await session.sendUser(preamble + contextBridge + text, storedAttachments);
      // Advance only THIS provider's watermark. The other provider remains
      // behind until it is selected and receives its own transcript bridge.
      setChatProviderContextAt(chatId, provider, userMsg.updatedAt);
      // Handed to the backend — from here the turn is on a clock until
      // the agent shows any sign of life. See onTurnStalled.
      this.noteTurnSent(chatId);
      // Delivered — now consume the resume flag so it doesn't re-fire next turn.
      if (resumed) this.resumedChats.delete(chatId);
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
    this.surfaceDiagnostic(
      chatId,
      'error',
      `failed to spawn the ${label} agent. ${message} — `
      + (agent === 'codex'
        ? 'Codex may not be authenticated, or the `codex` CLI could not start.'
        : 'The `claude` CLI may not be on PATH for the packaged app.'),
    );
    updateChatStatus(chatId, 'err');
  }

  /**
   * Show a diagnostic WITHOUT writing it to the transcript.
   *
   * Diagnostics are never persisted: they're broadcast to the renderer,
   * which holds them in memory and drops them the moment a real reply
   * arrives (and on any reload). A transcript should be the
   * conversation — a timeout that resolved itself two seconds later is
   * not part of it, and shouldn't still be there tomorrow.
   *
   * `level` picks the treatment: 'notice' a small grey line, 'warning'
   * a yellow notification, 'error' the red box.
   */
  private surfaceDiagnostic(
    chatId: string,
    level: 'error' | 'warning' | 'notice',
    message: string,
  ): void {
    this.broadcast({ type: 'error', chatId, message, level, ts: Date.now() });
  }

  /** Record that a user turn has been handed to the backend: it's owed a
   *  reply, and it's on the clock until the agent shows a sign of life. */
  private noteTurnSent(chatId: string): void {
    this.disarmSettleTimer(chatId);
    this.queuedTurns.set(chatId, (this.queuedTurns.get(chatId) ?? 0) + 1);
    this.armStallWatchdog(chatId);
  }

  /**
   * Silently redo a turn that came back with nothing.
   *
   * The user's ask is an answer, not an explanation: when a turn
   * produces no output at all — upstream overloaded, stream dropped,
   * request hung, empty reply — the right move is to just do it again.
   * Safe precisely because `retryable` means nothing was produced, so
   * there is no partial work to duplicate.
   *
   * Respawns rather than reusing the session: a subprocess that just
   * returned nothing is exactly the one that tends to keep returning
   * nothing, and the pinned session_id means the retry resumes with
   * full context anyway.
   *
   * Returns false once the budget is spent, at which point the caller
   * surfaces the reason instead.
   */
  private tryAutoRetry(chatId: string, why: string): boolean {
    const used = this.autoRetries.get(chatId) ?? 0;
    if (used >= AgentHostImpl.MAX_AUTO_RETRIES) return false;
    const all = listMessages(chatId);
    const { text, attachments } = this.lastUserTurn(all);
    if (!text.trim() && attachments.length === 0) return false;
    this.autoRetries.set(chatId, used + 1);
    dlog('agent.auto-retry', { chatId, attempt: used + 1, why });
    // Account for the silence while it's happening. Ephemeral: the
    // renderer drops it the instant the retry produces a reply.
    this.surfaceDiagnostic(
      chatId,
      'notice',
      `No response, retrying… (${used + 1}/${AgentHostImpl.MAX_AUTO_RETRIES})`,
    );
    // Keep the chat looking busy — from the user's side this is still
    // the same request being worked on.
    updateChatStatus(chatId, 'run');
    this.broadcast({ type: 'session-status', chatId, status: 'running', ts: Date.now() });
    void (async () => {
      try {
        const agent = getChat(chatId)?.agent ?? 'claude';
        if (agent === 'codex') {
          // An empty Codex completion commonly means the native thread itself
          // is poisoned. Resuming it repeats the same empty success, so replace
          // it and restore the whole conversation from SQLite in one step.
          await this.restartWithContext(chatId, { continueLatestInstruction: true });
          return;
        }
        await this.dispose(chatId);
        const session = await this.getOrSpawnSession(chatId);
        // Replay WITHOUT appending — the user's message is already in
        // the transcript; this is a redo of it, not a new turn.
        await session.sendUser(text, attachments);
        this.noteTurnSent(chatId);
      } catch (err) {
        dlog('agent.auto-retry.failed', { chatId, error: (err as Error).message });
        this.surfaceNotice(chatId, `${why} (retry failed: ${(err as Error).message})`);
      }
    })();
    return true;
  }

  /** Tell the user why a turn produced no answer, without painting the
   *  chat red — this is an explained non-answer, not a fault. */
  private surfaceNotice(chatId: string, message: string): void {
    this.surfaceDiagnostic(chatId, 'notice', message);
    updateChatStatus(chatId, 'idle', message.slice(0, 140));
    this.broadcast({ type: 'session-status', chatId, status: 'idle', ts: Date.now() });
  }

  /** True when the user has sent something no turn has started on yet —
   *  i.e. the agent still owes them a reply even if the turn it was
   *  working on has just finished. */
  private hasQueuedTurn(chatId: string): boolean {
    return this.turnAwareChats.has(chatId) && (this.queuedTurns.get(chatId) ?? 0) > 0;
  }

  /** Arm the turn-stall watchdog. Called right after a user turn is
   *  handed to a backend. Re-arming replaces the previous timer, so a
   *  follow-up message sent while the first is in flight extends the
   *  window instead of stacking timers. */
  private armStallWatchdog(chatId: string): void {
    this.disarmStallWatchdog(chatId);
    this.stallTimers.set(
      chatId,
      setTimeout(() => this.onTurnStalled(chatId), AgentHostImpl.TURN_STALL_MS),
    );
  }

  private disarmStallWatchdog(chatId: string): void {
    const timer = this.stallTimers.get(chatId);
    if (!timer) return;
    clearTimeout(timer);
    this.stallTimers.delete(chatId);
  }

  private armSettleTimer(chatId: string): void {
    this.disarmSettleTimer(chatId);
    this.settleTimers.set(
      chatId,
      setTimeout(() => this.onQueuedTurnSettled(chatId), AgentHostImpl.QUEUED_TURN_SETTLE_MS),
    );
  }

  private disarmSettleTimer(chatId: string): void {
    const timer = this.settleTimers.get(chatId);
    if (!timer) return;
    clearTimeout(timer);
    this.settleTimers.delete(chatId);
  }

  /**
   * The hold expired with no new turn. Overwhelmingly this means the
   * queued message was folded into the turn that just ended and has
   * already been answered — so release the chat to idle and say
   * nothing. No error, no session teardown: there is no evidence
   * anything is wrong, only an absence of evidence that it's still
   * working.
   */
  private onQueuedTurnSettled(chatId: string): void {
    this.settleTimers.delete(chatId);
    if (this.activeTurns.has(chatId)) {
      dlog('agent.queued-turn.settle-skipped-active', { chatId });
      return;
    }
    this.queuedTurns.delete(chatId);
    if (!isDbOpen()) return;
    const chat = getChat(chatId);
    if (!chat || chat.status !== 'run') return;
    dlog('agent.queued-turn.settled', { chatId });
    updateChatStatus(chatId, 'idle');
    this.broadcast({ type: 'session-status', chatId, status: 'idle', ts: Date.now() });
  }

  /** Events that prove the backend is really producing a turn — any one
   *  of them disarms the watchdog. `session-status: running` is
   *  deliberately excluded: that's our own echo of the send, not the
   *  agent answering. A permission request counts (the turn is live and
   *  now waiting on the user), and so does a tool-use — everything that
   *  follows it is tool-execution silence, which must never be timed. */
  private static respondedToTurn(event: AgentEvent): boolean {
    switch (event.type) {
      case 'message-start':
      case 'text-delta':
      case 'tool-use':
      case 'tool-result':
      case 'permission-request':
      case 'message-end':
      case 'usage':
      case 'compaction':
      case 'error':
        return true;
      case 'session-status':
        return event.status !== 'running';
      default:
        return false;
    }
  }

  /**
   * The turn produced nothing whatsoever inside TURN_STALL_MS — no
   * stream event, no tool call, no result, no error. The upstream
   * request is hung, and because the SDK session is still technically
   * alive, every later send just queues behind it.
   *
   * Heal it without user intervention: abort the wedged local session,
   * clear its native handle, start a fresh provider session, and prime it
   * from the canonical SQLite transcript. The recovery prompt continues
   * the latest instruction, so every persisted user turn remains covered.
   * A bounded retry budget prevents a broken upstream from looping forever.
   */
  private onTurnStalled(chatId: string): void {
    this.stallTimers.delete(chatId);
    if (!isDbOpen()) return;
    const chat = getChat(chatId);
    // Chat is gone, or already surfaced as failed — nothing to add.
    // Deliberately NOT gated on status === 'run': the point of this
    // path is that the status can be wrong.
    if (!chat || chat.status === 'err') return;
    dlog('agent.turn-stalled', {
      chatId,
      afterMs: AgentHostImpl.TURN_STALL_MS,
      provider: chat.agent,
      nativeHandle: chat.agent === 'codex' ? chat.codexThreadId : chat.sessionId,
      queuedTurns: this.queuedTurns.get(chatId) ?? 0,
      hadLiveSession: this.sessions.has(chatId),
    });
    this.queuedTurns.delete(chatId);
    const used = this.autoRetries.get(chatId) ?? 0;
    if (used >= AgentHostImpl.MAX_AUTO_RETRIES) {
      dlog('agent.stall-recovery.exhausted', { chatId, attempts: used });
      this.surfaceDiagnostic(
        chatId,
        'error',
        `agent remained unresponsive after ${used} automatic session recoveries`,
      );
      updateChatStatus(chatId, 'err', 'automatic session recovery exhausted');
      this.broadcast({ type: 'session-status', chatId, status: 'errored', ts: Date.now() });
      return;
    }

    const attempt = used + 1;
    this.autoRetries.set(chatId, attempt);
    dlog('agent.stall-recovery.begin', { chatId, provider: chat.agent, attempt });
    this.surfaceDiagnostic(
      chatId,
      'notice',
      `No response — recovering the ${chat.agent === 'codex' ? 'OpenAI' : 'Claude'} session automatically…`,
    );
    void this.restartWithContext(chatId, { continueLatestInstruction: true }).catch((err) => {
      dlog('agent.stall-recovery.failed', {
        chatId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
      } else if (
        decision === 'allow-everywhere' ||
        decision === 'deny-everywhere' ||
        decision === 'allow-mcp-server'
      ) {
        // allow-mcp-server stores a wildcard for the WHOLE MCP server so the
        // user isn't prompted per-tool; the others store the exact tool.
        const server = decision === 'allow-mcp-server' ? mcpServerOfTool(toolForRule) : null;
        const rulePattern = server ? mcpServerWildcard(server) : toolForRule;
        const current = getSetting<PermissionRule[]>('permissions.rules') ?? [];
        const next = [
          ...current.filter((r) => r.tool !== rulePattern),
          { tool: rulePattern, action },
        ];
        setSetting('permissions.rules', next);
        dlog('perm.rule.added', { scope: 'global', tool: rulePattern, action });
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

  /**
   * Compact the chat's context on request — the composer's context
   * gauge. Same thing as the user typing `/compact`, minus the user
   * bubble in the transcript. The backend reports progress as
   * `compaction` events: the renderer shows "Compacting…" while it runs,
   * and the outcome is written to the transcript in persist().
   *
   * Runs as a turn: the CLI answers a `/compact` with its own init and
   * result, so the ordinary bookkeeping (stall watchdog, queued-turn
   * count, idle on result) applies unchanged.
   */
  async compact(chatId: string): Promise<void> {
    const chat = getChat(chatId);
    if (!chat) throw new Error(`compact: chat ${chatId} not found`);
    if (chat.agent === 'codex') {
      // Codex compacts on its own as its window fills; its SDK has no
      // manual compaction call to make.
      this.surfaceDiagnostic(
        chatId,
        'warning',
        'Codex manages its own context and compacts it automatically — there is no manual compaction for Codex chats.',
      );
      return;
    }
    this.stoppedChats.delete(chatId);
    const session = await this.getOrSpawnSession(chatId);
    if (!session.compact) {
      this.surfaceDiagnostic(chatId, 'warning', 'This agent does not support manual compaction.');
      return;
    }
    dlog('agent.compact', { chatId, agent: chat.agent, sessionId: chat.sessionId ?? null });
    updateChatStatus(chatId, 'run');
    this.broadcast({ type: 'session-status', chatId, status: 'running', ts: Date.now() });
    try {
      await session.compact();
      this.noteTurnSent(chatId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dlog('agent.compact.failed', { chatId, error: message });
      updateChatStatus(chatId, 'idle');
      this.broadcast({ type: 'session-status', chatId, status: 'idle', ts: Date.now() });
      this.surfaceDiagnostic(chatId, 'error', `couldn’t start compaction: ${message}`);
      throw err;
    }
  }

  stop(chatId: string): void {
    // The user interrupting is a deliberate end to the turn, not a
    // stall — don't let the watchdog fire behind it, and drop the
    // outstanding-turn count so the chat can settle to idle.
    this.disarmStallWatchdog(chatId);
    this.disarmSettleTimer(chatId);
    this.queuedTurns.delete(chatId);
    this.activeTurns.delete(chatId);
    this.stoppedChats.add(chatId);
    const session = this.sessions.get(chatId);
    dlog('agent.stop', { chatId, hadLiveSession: !!session, agent: getChat(chatId)?.agent ?? null });
    try {
      session?.stop();
    } catch (err) {
      // A provider is allowed to implement stop by throwing/aborting. From the
      // user's perspective the requested stop still succeeded.
      dlog('agent.stop-error-suppressed', {
        chatId,
        source: 'stop-call',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    updateChatStatus(chatId, 'idle');
    this.broadcast({ type: 'session-status', chatId, status: 'idle', ts: Date.now() });
  }

  async configureAgent(input: {
    chatId: string;
    agent: 'claude' | 'codex';
    claudeModel?: ClaudeModelId;
    claudeReasoningEffort?: ClaudeReasoningEffort;
    codexModel?: CodexModelId;
    codexReasoningEffort?: CodexReasoningEffort;
  }) {
    const previous = getChat(input.chatId);
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
    if (previous && previous.agent !== input.agent) {
      const provider = input.agent === 'codex' ? 'OpenAI' : 'Claude';
      const note = appendMessage({
        chatId: input.chatId,
        role: 'system',
        kind: 'system',
        body: { text: `switch: Switched to ${provider} · conversation context will synchronize with your next message.` },
      });
      this.broadcast({
        type: 'message-added',
        chatId: input.chatId,
        message: note,
        ts: Date.now(),
      });
    }
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
    // Keep the native conversation unless the failure said it was gone.
    // Retry used to drop the handle unconditionally, so a passing API
    // error — a model this login can't use, an expired token — cost the
    // whole Codex thread, and the chat came back with its history
    // bridged from SQLite instead of intact.
    const lastError = this.lastErrorText.get(chatId) ?? '';
    const handleLost = chat.agent === 'codex'
      ? this.shouldRestartCodexWithContext(chatId, lastError)
      : /no conversation found|session[^.]*(?:not found|missing)/i.test(lastError);
    if (handleLost) {
      dlog('agent.manual-retry.drop-handle', {
        chatId,
        agent: chat.agent,
        lastError: lastError.slice(0, 200),
      });
      if (chat.agent === 'codex') clearChatCodexThreadId(chatId);
      else clearChatSessionId(chatId);
    }
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
      this.noteTurnSent(chatId);
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
    // Always clear the timer, even with no live session — otherwise a
    // closed chat can still fire onTurnStalled and resurrect itself
    // into 'err' after the user walked away from it.
    this.disarmStallWatchdog(chatId);
    this.disarmSettleTimer(chatId);
    this.queuedTurns.delete(chatId);
    this.turnAwareChats.delete(chatId);
    this.activeTurns.delete(chatId);
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
    // Chats can hold a stall timer without a live session; clear the
    // whole map so nothing fires against a closing DB on quit.
    for (const chatId of [...this.stallTimers.keys()]) this.disarmStallWatchdog(chatId);
    for (const chatId of [...this.settleTimers.keys()]) this.disarmSettleTimer(chatId);
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

    // Per-slot editor MCP: if this chat's worktree is a Unity/Unreal project
    // with MCP enabled, hand the agent its slot's editor MCP server (a unique
    // localhost port per slot). Registered in-memory in the SDK options — no
    // file on disk, no git-tracked config touched. Only the mcpHttp-capable
    // backend (Claude) consumes it; others ignore it. Detect from the WORKTREE
    // ROOT (liveWorktree), not `cwd` — for Perforce, cwd can be a subdir and the
    // engine markers (a .uproject / ProjectSettings) live at the root.
    const editorMcp =
      backend.capabilities.mcpHttp ? mcpEndpointForChat(chatId, liveWorktree ?? cwd) : null;
    const mcpServers = editorMcp
      ? { [editorMcp.name]: { type: 'http' as const, url: editorMcp.url } }
      : undefined;

    dlog('agent.spawn', {
      chatId, cwd, sessionId, source: discoverySource,
      backend: backend.id,
      editorMcp: editorMcp?.url ?? null,
    });

    const session = backend.spawn({
      chatId,
      history: [],
      cwd,
      sessionId,
      mcpServers,
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
        // Per-chat rules win over global; within each set, deny beats allow and
        // a more specific pattern beats a broader one. Rules support trailing-`*`
        // wildcards, so a single `mcp__unrealEditor__*` (written by the Unreal
        // MCP permission toggle) allows this chat's whole editor MCP server.
        const chatDecision = resolvePermissionRules(getChatPermissionRules(chatId), toolName);
        if (chatDecision) return chatDecision;
        const globalRules = getSetting<PermissionRule[]>('permissions.rules') ?? [];
        return resolvePermissionRules(globalRules, toolName);
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
      this.noteTurnSent(chatId);
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
      this.noteTurnSent(chatId);
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

    // Cancellation commonly arrives as an asynchronous provider error after
    // stop() has already returned. Do not persist it, show it, retry it, or let
    // an accompanying errored status overwrite the deliberate idle state.
    if (
      this.stoppedChats.has(event.chatId)
      && (event.type === 'error'
        || (event.type === 'session-status' && event.status === 'errored'))
    ) {
      this.activeTurns.delete(event.chatId);
      this.queuedTurns.delete(event.chatId);
      this.disarmStallWatchdog(event.chatId);
      this.disarmSettleTimer(event.chatId);
      dlog('agent.stop-error-suppressed', {
        chatId: event.chatId,
        source: event.type,
        error: event.type === 'error' ? event.message : 'errored session status',
      });
      return;
    }

    if (event.type === 'error') this.lastErrorText.set(event.chatId, event.message);
    else if (event.type === 'message-start') this.lastErrorText.delete(event.chatId);

    // A turn has actually started, so everything the user had queued is
    // now being worked on. Purely internal bookkeeping — nothing to
    // persist, and the renderer already shows 'run'.
    if (event.type === 'turn-start') {
      this.turnAwareChats.add(event.chatId);
      this.activeTurns.add(event.chatId);
      this.queuedTurns.delete(event.chatId);
      this.disarmSettleTimer(event.chatId);
      // RE-arm, never disarm. A turn STARTING is not a turn producing
      // anything, and init-then-total-silence is the precise shape of
      // the hang this watchdog exists for — observed live at 01:40:46:
      // send, init 62ms later, then nothing for ten minutes. Disarming
      // here cancelled the one timer that could have caught it. Arming
      // instead restarts the clock from the turn's actual start, which
      // is the right thing to measure.
      this.armStallWatchdog(event.chatId);
      return;
    }

    if (
      event.type === 'session-status'
      && (event.status === 'idle' || event.status === 'complete' || event.status === 'errored')
    ) {
      this.activeTurns.delete(event.chatId);
    }

    // 'idle' from the backend means "the turn I was working on is
    // finished" — it does NOT mean the user has nothing outstanding. If
    // they typed while that turn was running, their message is still
    // queued behind it, and letting this through drops the chat to IDLE
    // with the message unanswered and nothing to show for it. Hold the
    // chat in 'run' and restart the stall clock: the queued message now
    // either gets a turn or surfaces as a failure.
    // A turn that produced nothing gets silently redone rather than
    // reported — an answer is what was asked for. Swallow the event
    // entirely while a replay is in flight; only when the retry budget
    // is spent does the reason reach the chat.
    if (event.type === 'error' && event.retryable) {
      this.activeTurns.delete(event.chatId);
      this.disarmStallWatchdog(event.chatId);
      this.disarmSettleTimer(event.chatId);
      this.queuedTurns.delete(event.chatId);
      if (this.tryAutoRetry(event.chatId, event.message)) return;
      dlog('agent.auto-retry.exhausted', { chatId: event.chatId, why: event.message });
      // Retries are spent. A blip that never clears isn't a blip — it's
      // a real failure, so this one earns the red box. A limit the user
      // has to act on (sign-in expired, plan exhausted) stays yellow:
      // nothing is broken, they just have to do the thing.
      const expected = event.level === 'warning';
      this.surfaceDiagnostic(
        event.chatId,
        expected ? 'warning' : 'error',
        expected
          ? `${event.message} (still failing after ${AgentHostImpl.MAX_AUTO_RETRIES} retries)`
          : `no response after ${AgentHostImpl.MAX_AUTO_RETRIES} retries — ${event.message}`,
      );
      updateChatStatus(event.chatId, 'err', event.message.slice(0, 140));
      this.broadcast({ type: 'session-status', chatId: event.chatId, status: 'errored', ts: Date.now() });
      return;
    }

    // Real output means we're back on track: erase the provisional
    // "retrying…" line so the answer stands in its place, and forget
    // the retry history so a later hiccup gets a full budget of its own.
    if (
      event.type === 'text-delta'
      || event.type === 'tool-use'
      || event.type === 'tool-result'
    ) {
      this.autoRetries.delete(event.chatId);
    }

    // A failed turn is terminal and already visible to the user — drop
    // the outstanding count so a held 'idle' can't strand the chat in
    // 'run' after the error has been surfaced.
    if (event.type === 'error' || (event.type === 'session-status' && event.status === 'errored')) {
      this.queuedTurns.delete(event.chatId);
    }

    let live = event;
    if (event.type === 'session-status' && event.status === 'idle' && this.hasQueuedTurn(event.chatId)) {
      dlog('agent.idle-held', {
        chatId: event.chatId,
        queuedTurns: this.queuedTurns.get(event.chatId) ?? 0,
      });
      live = { ...event, status: 'running' };
      // A bounded, NON-destructive hold — not the stall watchdog. The
      // agent may well have already answered inside the turn that just
      // ended; we can't tell, so the worst this may do is show 'run'
      // for a few extra seconds.
      this.armSettleTimer(event.chatId);
    }

    // The agent is demonstrably alive — stand the stall watchdog down
    // before anything else, so a slow persist can't let it fire.
    if (AgentHostImpl.respondedToTurn(live)) {
      this.disarmStallWatchdog(live.chatId);
      this.disarmSettleTimer(live.chatId);
    }
    try {
      this.persist(live);
    } catch (err) {
      console.error('AgentHost.persist failed', err);
    }
    this.broadcast(live);
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
        const active = getChat(event.chatId)?.agent;
        if (active === 'claude' || active === 'codex') {
          // The provider's own reply is part of its native context too. This
          // watermark lets the other provider receive it on the next switch,
          // while preventing it from being replayed back to its author.
          setChatProviderContextAt(event.chatId, active, event.ts);
        }
        // Snapshot a snippet for the chat thumbnail. Also detect the
        // "agent ended with a question" case — flip to wait so the
        // thumbnail goes yellow + the chat column rail tints.
        const buf = this.textBuffers.get(event.messageId);
        if (buf) {
          const trimmed = buf.buffer.trimEnd();
          const endsInQuestion = looksLikeQuestion(trimmed);
          // Same rule as the 'idle' hold in handleEvent: with a message
          // still queued the agent isn't done, and a trailing question
          // isn't waiting on the user either — they've already typed
          // past it. Keep the snippet, keep the chat running.
          const queued = this.hasQueuedTurn(event.chatId);
          const status = queued ? 'run' : endsInQuestion ? 'wait' : 'idle';
          updateChatStatus(event.chatId, status, trimmed.slice(0, 140));
          if (endsInQuestion && !queued) {
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

      case 'compaction': {
        // Only the outcome belongs in the transcript. "Compacting…" and
        // a failure are shown by the renderer as ephemeral rows, the way
        // diagnostics are, and vanish with the next reply.
        if (event.phase !== 'done') return;
        const note = appendMessage({
          chatId: event.chatId,
          role: 'system',
          kind: 'system',
          body: { text: `context: ${compactionNoteText(event)}` },
        });
        this.broadcast({ type: 'message-added', chatId: event.chatId, message: note, ts: event.ts });
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
        // Deliberately NOT persisted — the renderer holds diagnostics in
        // memory and drops them on the next real reply. Only the chat's
        // status is durable:
        //   notice  — being retried; chat carries on.
        //   warning — an ordinary limit (tokens used up, resets at 2pm);
        //             idle, because nothing is broken.
        //   error   — actual breakage; 'err'.
        const level = event.level ?? 'error';
        updateChatStatus(
          event.chatId,
          level === 'error' ? 'err' : 'idle',
          event.message.slice(0, 140),
        );
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
