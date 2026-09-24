/**
 * Cloud chats: a chat that drives a Claude Code CLOUD session (claude.ai/code)
 * instead of a local agent, so the work keeps running after PopBot quits.
 *
 * Everything goes through the user's own `claude` CLI, which owns the
 * account and the session — PopBot never talks to the cloud itself:
 *
 *   - First message → `claude --cloud "<task>"` typed into the chat's
 *     terminal at the repo root. That command is interactive (it shows a
 *     live provisioning checklist and takes questions), so it needs the
 *     real terminal, not a piped child. Main reads the terminal's output
 *     for the session id the CLI prints and links it to the chat. Should
 *     the CLI not print one, the user pastes the claude.ai/code link.
 *   - Later messages → `claude -p --cloud <id> --output-format json`,
 *     the message on stdin. Non-interactive; posts one message and exits
 *     with `{ok, session_id, url}`.
 *   - Teleport → `claude --teleport <id>` in the same terminal: fetches the
 *     session's branch, checks it out, loads the conversation locally.
 *
 * The chat's transcript is the user's side plus what the CLI reported;
 * the agent's side lives on claude.ai (the chip in the header links there).
 * Per CORE_MODEL.md the AgentHost-owned broadcast is passed in as `emit`.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { AgentEvent } from '@shared/agent';
import type { ChatRecord, CloudChatInfo, MessageBodyText } from '@shared/persistence';
import { dlog } from '../diagLog';
import { getChat, setChatCloud, updateChatStatus } from '../persistence/chats';
import { appendMessage } from '../persistence/messages';
import { getRepo } from '../persistence/repos';
import * as pty from '../term/ptyManager';
import { getClaudeBinaryPath, probeClaude } from './claudeProbe';

export type Emit = (event: AgentEvent) => void;

/** A cloud session id as the CLI prints it (`session_…`, older `cse_…`). */
const SESSION_ID_RE = /\b((?:session|cse)_[A-Za-z0-9]{8,})\b/;
/** ANSI colour / cursor sequences, which the terminal output is full of. */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;
/** How much terminal output to keep looking back over for an id — enough
 *  for a line, small enough to rescan on every chunk. */
const TAIL_CHARS = 4096;
/** A `-p --cloud` send is one HTTP post; this is generous. */
const SEND_TIMEOUT_MS = 90_000;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Find a cloud session in free text: a claude.ai/code URL, the CLI's
 * "Session ID: session_…" line, or a bare id — whichever appears first.
 */
export function parseCloudSessionRef(text: string): { sessionId: string; url: string } | null {
  const m = SESSION_ID_RE.exec(stripAnsi(text));
  if (!m) return null;
  return { sessionId: m[1], url: `https://claude.ai/code/${m[1]}` };
}

export type CloudSendOutcome =
  | { ok: true; sessionId: string | null; url: string | null }
  | { ok: false; error: string };

/**
 * Read the result of `claude -p --cloud <id> --output-format json`. The
 * JSON is the last thing on stdout ({ok, session_id, url} or
 * {ok: false, session_id, error}); configuration errors ("Cloud sessions
 * are disabled by your organization's policy…") go to stderr as plain
 * `Error: …` lines with no JSON at all.
 */
export function parseCloudSendOutput(stdout: string, stderr: string, code: number | null): CloudSendOutcome {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[i]) as { ok?: boolean; session_id?: string; url?: string; error?: string };
      if (parsed.ok) return { ok: true, sessionId: parsed.session_id ?? null, url: parsed.url ?? null };
      return { ok: false, error: parsed.error || 'the CLI reported a failure' };
    } catch {
      /* not the result line */
    }
  }
  // No JSON: fall back to the text form, then whatever was said.
  const ref = parseCloudSessionRef(stdout);
  if (code === 0 && (ref || /sent to cloud session/i.test(stdout))) {
    return { ok: true, sessionId: ref?.sessionId ?? null, url: ref?.url ?? null };
  }
  const said = `${stderr}\n${stdout}`.replace(/^\s*Error:\s*/im, '').trim();
  return { ok: false, error: said || `claude exited with code ${code ?? 'unknown'}` };
}

/** What a cloud chat does with a message: start the session, or queue a
 *  follow-up into it. Pure, so it can be tested. */
export function cloudActionFor(cloud: CloudChatInfo, started: boolean): 'start' | 'follow-up' | 'wait' {
  if (cloud.sessionId) return 'follow-up';
  return started ? 'wait' : 'start';
}

/** Chats whose `claude --cloud` has been typed into the terminal but
 *  whose session id hasn't shown up yet. */
const starting = new Set<string>();
const watchers = new Map<string, () => void>();

/** Where the CLI runs: the chat's worktree (a slot or ephemeral checkout
 *  on its own branch), else the repo root, else — no repo — home. */
function cloudCwd(chat: ChatRecord): string {
  return chat.worktreePath || chat.repoPath || getRepo(chat.repoId)?.repoPath || homedir();
}

/** `a && b` for the in-app shell. Windows PowerShell 5 has no `&&`. */
function andThen(a: string, b: string): string {
  return pty.shellKind() === 'powershell' ? `${a}; if ($?) { ${b} }` : `${a} && ${b}`;
}

/** The `claude` to type into the terminal. The absolute path when the
 *  probe found one (POSIX); on Windows the shell resolves the npm shim. */
async function claudeForShell(): Promise<string> {
  if (process.platform === 'win32') return 'claude';
  const cached = getClaudeBinaryPath() ?? (await probeClaude()).binaryPath ?? null;
  return cached ? pty.quoteForShell(cached) : 'claude';
}

async function claudeForSpawn(): Promise<string> {
  return getClaudeBinaryPath() ?? (await probeClaude()).binaryPath ?? 'claude';
}

function note(chatId: string, emit: Emit, text: string): void {
  const row = appendMessage({ chatId, role: 'system', kind: 'system', body: { text } });
  emit({ type: 'message-added', chatId, message: row, ts: Date.now() });
}

function emitChat(chatId: string, emit: Emit): void {
  const chat = getChat(chatId);
  if (chat) emit({ type: 'chat-updated', chatId, chat, ts: Date.now() });
}

function setStatus(chatId: string, status: 'run' | 'idle', emit: Emit, snippet?: string): void {
  updateChatStatus(chatId, status, snippet);
  emit({ type: 'session-status', chatId, status: status === 'run' ? 'running' : 'idle', ts: Date.now() });
}

/**
 * A user message on a cloud chat. Persists the user's row like an
 * ordinary send, then starts the session or queues a follow-up.
 */
export async function handleCloudSend(chat: ChatRecord, text: string, emit: Emit): Promise<void> {
  if (!chat.cloud) throw new Error(`handleCloudSend: ${chat.id} is not a cloud chat`);
  const userMsg = appendMessage({
    chatId: chat.id,
    role: 'user',
    kind: 'text',
    body: { text } satisfies MessageBodyText,
  });
  emit({ type: 'message-added', chatId: chat.id, message: userMsg, ts: Date.now() });

  const action = cloudActionFor(chat.cloud, starting.has(chat.id));
  dlog('cloud.send', { chatId: chat.id, action, sessionId: chat.cloud.sessionId, textLen: text.length });
  if (action === 'follow-up') {
    await sendFollowUp(chat, chat.cloud.sessionId!, text, emit);
  } else if (action === 'start') {
    await startSession(chat, text, emit);
  } else {
    note(chat.id, emit,
      'warning: The cloud session is still being created — its link has not appeared yet. ' +
      'Type into the terminal below to talk to it now, or wait for the link (or paste it in the chat settings) and send again.');
  }
}

async function startSession(chat: ChatRecord, task: string, emit: Emit): Promise<void> {
  const cwd = cloudCwd(chat);
  const claude = await claudeForShell();
  pty.open(chat.id, cwd);
  watchForSessionId(chat.id, emit);
  starting.add(chat.id);
  const cloudCmd = `${claude} --cloud ${pty.quoteForShell(task)}`;
  // A chat with its own branch (a slot or worktree): the cloud clones the
  // GitHub remote at that branch, so it has to be there first. Pushing in
  // the same terminal keeps any failure (no remote, no access) in view.
  const ownBranch = !!chat.worktreePath && !!chat.branch;
  pty.write(chat.id, `${ownBranch ? andThen(`git push -u origin ${pty.quoteForShell(chat.branch!)}`, cloudCmd) : cloudCmd}\r`);
  updateChatStatus(chat.id, 'idle', task.slice(0, 140));
  note(chat.id, emit,
    (ownBranch
      ? `cloud: Pushing ${chat.branch} to origin and creating the cloud session in the terminal below — the CLI shows its setup steps there and takes questions. `
      : 'cloud: Creating the cloud session in the terminal below — the CLI shows its setup steps there and takes questions. ') +
    'The session link will appear here once it is created; if it does not, paste it from claude.ai/code in the chat settings.');
  dlog('cloud.start', { chatId: chat.id, cwd, ownBranch });
}

/** Read the terminal for the id the CLI prints, then link it. */
function watchForSessionId(chatId: string, emit: Emit): void {
  watchers.get(chatId)?.();
  let tail = '';
  const off = pty.onOutput(chatId, (data) => {
    tail = (tail + data).slice(-TAIL_CHARS);
    const ref = parseCloudSessionRef(tail);
    if (!ref) return;
    stopWatching(chatId);
    linkSession(chatId, ref, emit, 'terminal');
  });
  watchers.set(chatId, off);
}

function stopWatching(chatId: string): void {
  watchers.get(chatId)?.();
  watchers.delete(chatId);
  starting.delete(chatId);
}

function linkSession(chatId: string, ref: { sessionId: string; url: string }, emit: Emit, how: 'terminal' | 'user'): void {
  const chat = getChat(chatId);
  if (!chat?.cloud) return;
  if (chat.cloud.sessionId === ref.sessionId) return;
  setChatCloud(chatId, { ...chat.cloud, sessionId: ref.sessionId, url: ref.url, startedAt: Date.now() });
  dlog('cloud.linked', { chatId, sessionId: ref.sessionId, how });
  note(chatId, emit, `cloud: ${how === 'terminal' ? 'Cloud session created.' : 'Cloud session linked.'} ${ref.url}`);
  emitChat(chatId, emit);
}

async function sendFollowUp(chat: ChatRecord, sessionId: string, text: string, emit: Emit): Promise<void> {
  setStatus(chat.id, 'run', emit, text.slice(0, 140));
  const claude = await claudeForSpawn();
  let outcome: CloudSendOutcome;
  try {
    outcome = await runCloudSend(claude, sessionId, text, cloudCwd(chat));
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  dlog('cloud.followUp', { chatId: chat.id, sessionId, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
  if (outcome.ok) {
    note(chat.id, emit, 'cloud: Sent to the cloud session.');
  } else {
    note(chat.id, emit, `error: The message could not be sent to the cloud session: ${outcome.error}`);
  }
  setStatus(chat.id, 'idle', emit);
}

/** `claude -p --cloud <id> --output-format json`, the message on stdin. */
function runCloudSend(claude: string, sessionId: string, text: string, cwd: string | null): Promise<CloudSendOutcome> {
  return new Promise((resolve) => {
    // An npm shim on Windows is a .cmd; Node launches those through a shell.
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude);
    const child = spawn(
      viaShell ? `"${claude}"` : claude,
      ['-p', '--cloud', sessionId, '--output-format', 'json'],
      {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: viaShell,
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
      },
    );
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (outcome: CloudSendOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `no answer from claude after ${SEND_TIMEOUT_MS / 1000}s` });
    }, SEND_TIMEOUT_MS);
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', (code) => finish(parseCloudSendOutput(stdout, stderr, code)));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(text);
  });
}

/** `claude --teleport <id>` in the chat's terminal at the repo root. */
export async function teleportCloudChat(chatId: string, emit: Emit): Promise<{ ok: true } | { ok: false; error: string }> {
  const chat = getChat(chatId);
  if (!chat?.cloud) return { ok: false, error: 'not a cloud chat' };
  if (!chat.cloud.sessionId) return { ok: false, error: 'no cloud session is linked to this chat yet' };
  const cwd = cloudCwd(chat);
  const claude = await claudeForShell();
  pty.open(chatId, cwd);
  pty.write(chatId, `${claude} --teleport ${chat.cloud.sessionId}\r`);
  note(chatId, emit,
    `cloud: Teleporting the session into the terminal below — it fetches the session’s branch, checks it out in ${chat.worktreePath ? 'this chat’s workspace' : 'the repo root'}, ` +
    'and loads the conversation there. Answer its prompts in the terminal (it asks before stashing uncommitted changes).');
  dlog('cloud.teleport', { chatId, sessionId: chat.cloud.sessionId, cwd });
  return { ok: true };
}

/** Link a session the user pasted (URL or bare id). */
export function linkCloudSession(chatId: string, ref: string, emit: Emit): { ok: true; chat: ChatRecord } | { ok: false; error: string } {
  const chat = getChat(chatId);
  if (!chat?.cloud) return { ok: false, error: 'not a cloud chat' };
  const parsed = parseCloudSessionRef(ref);
  if (!parsed) return { ok: false, error: 'not a claude.ai/code session link or id' };
  stopWatching(chatId);
  linkSession(chatId, parsed, emit, 'user');
  const updated = getChat(chatId);
  return updated ? { ok: true, chat: updated } : { ok: false, error: 'chat vanished' };
}

/** The chat is gone or closing: forget any in-progress start. */
export function forgetCloudChat(chatId: string): void {
  stopWatching(chatId);
}
