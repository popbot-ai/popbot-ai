/**
 * The live mirror of a cloud chat: what the attached `claude --cloud` CLI
 * shows in the chat's terminal, kept in step as rows in the chat column.
 *
 * The terminal's bytes go into a headless terminal (cloudTranscript.ts),
 * whose grid is parsed into blocks after each burst of output. Each
 * block becomes a persisted message — a prompt, the agent's text, a
 * tool call — updated in place while it is still streaming, so the
 * column shows the reply as the cloud produces it. A prompt PopBot typed
 * in itself is echoed by the TUI and is not persisted twice.
 *
 * While the input box is on screen the CLI is attached and sending means
 * typing into it (the cloud queues it). Once the CLI has exited the
 * mirror goes quiet and cloudSessions.ts falls back to `claude -p
 * --cloud <id>`, which delivers but can't show the reply.
 */
import type { AgentEvent } from '@shared/agent';
import type { MessageBodyText, MessageBodyTool } from '@shared/persistence';
import { dlog } from '../diagLog';
import { getChat, updateChatStatus } from '../persistence/chats';
import { appendMessage, getMessage, updateMessageBody } from '../persistence/messages';
import * as pty from '../term/ptyManager';
import { TerminalTranscript, type TranscriptBlock } from './cloudTranscript';

type Emit = (event: AgentEvent) => void;

interface PersistedBlock {
  /** '' for a prompt PopBot typed itself (already in the transcript). */
  id: string;
  kind: TranscriptBlock['kind'];
  text: string;
  output?: string;
}

interface Mirror {
  term: TerminalTranscript;
  offData: () => void;
  offResize: () => void;
  timer: NodeJS.Timeout | null;
  rows: PersistedBlock[];
  /** Prompts typed by PopBot, normalized, awaiting their echo. */
  sent: string[];
  attached: boolean;
  running: boolean;
  emit: Emit;
}

const mirrors = new Map<string, Mirror>();
const PARSE_DEBOUNCE_MS = 200;
const SUBMIT_DELAY_MS = 150;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function startCloudMirror(chatId: string, emit: Emit): boolean {
  stopCloudMirror(chatId);
  const size = pty.size(chatId);
  if (!size) return false;
  const term = new TerminalTranscript(size.cols, size.rows);
  term.write(pty.replayBuffer(chatId));
  const mirror: Mirror = {
    term,
    offData: pty.onOutput(chatId, (data) => { term.write(data); schedule(chatId); }),
    offResize: pty.onResize(chatId, (cols, rows) => { term.resize(cols, rows); schedule(chatId); }),
    timer: null,
    rows: [],
    sent: [],
    attached: false,
    running: false,
    emit,
  };
  mirrors.set(chatId, mirror);
  dlog('cloud.mirror.start', { chatId, cols: size.cols, rows: size.rows });
  return true;
}

export function stopCloudMirror(chatId: string): void {
  const m = mirrors.get(chatId);
  if (!m) return;
  mirrors.delete(chatId);
  if (m.timer) clearTimeout(m.timer);
  m.offData();
  m.offResize();
  m.term.dispose();
  dlog('cloud.mirror.stop', { chatId });
}

/** The CLI's input box is on screen: a message can be typed into it. */
export function isCloudTuiAttached(chatId: string): boolean {
  const m = mirrors.get(chatId);
  if (!m || !pty.has(chatId)) return false;
  sync(chatId);
  return m.attached;
}

/** Remember a prompt PopBot is about to type (or pass on the command
 *  line), so its echo in the transcript isn't persisted a second time. */
export function noteOwnPrompt(chatId: string, text: string): void {
  mirrors.get(chatId)?.sent.push(norm(text));
}

/** Type a message into the attached CLI: a bracketed paste (multi-line
 *  safe), then Enter a beat later so it reads as a submit, not a paste
 *  with a newline in it. */
export function typeIntoCloudTui(chatId: string, text: string): void {
  noteOwnPrompt(chatId, text);
  pty.write(chatId, `\x1b[200~${text}\x1b[201~`);
  setTimeout(() => pty.write(chatId, '\r'), SUBMIT_DELAY_MS);
}

function schedule(chatId: string): void {
  const m = mirrors.get(chatId);
  if (!m) return;
  if (m.timer) clearTimeout(m.timer);
  m.timer = setTimeout(() => { m.timer = null; sync(chatId); }, PARSE_DEBOUNCE_MS);
}

function bodyFor(b: TranscriptBlock, id: string): MessageBodyText | MessageBodyTool {
  if (b.kind !== 'tool') return { text: b.text } satisfies MessageBodyText;
  // "Bash(ls src)" → name + args the tool cards know; a collapsed
  // summary ("Listed 1 directory") stays a plain line.
  const call = /^([A-Z][A-Za-z0-9_]*)\((.*)\)$/s.exec(b.text);
  const name = call ? call[1] : b.text;
  const args = call ? (call[1] === 'Bash' ? { command: call[2] } : { input: call[2] }) : {};
  return {
    toolUseId: `cloud_${id}`,
    name,
    args,
    ...(b.output !== undefined ? { result: b.output } : {}),
  } satisfies MessageBodyTool;
}

function sync(chatId: string): void {
  const m = mirrors.get(chatId);
  if (!m) return;
  if (!getChat(chatId)) { stopCloudMirror(chatId); return; }
  const tr = m.term.transcript();
  m.attached = tr.attached;
  if (tr.running !== m.running) {
    m.running = tr.running;
    updateChatStatus(chatId, tr.running ? 'run' : 'idle');
    m.emit({ type: 'session-status', chatId, status: tr.running ? 'running' : 'idle', ts: Date.now() });
  }
  // The screen was cleared (or the CLI restarted): start over. Rows
  // already in the transcript stay.
  if (tr.blocks.length < m.rows.length) m.rows = [];

  tr.blocks.forEach((b, i) => {
    const have = m.rows[i];
    if (!have) {
      if (b.kind === 'user') {
        const k = m.sent.indexOf(norm(b.text));
        if (k >= 0) {
          m.sent.splice(k, 1);
          m.rows[i] = { id: '', kind: b.kind, text: b.text };
          return;
        }
      }
      const row = appendMessage({
        chatId,
        role: b.kind === 'user' ? 'user' : 'agent',
        kind: b.kind === 'tool' ? 'tool' : 'text',
        body: bodyFor(b, `${chatId}_${i}`),
      });
      m.rows[i] = { id: row.id, kind: b.kind, text: b.text, output: b.output };
      m.emit({ type: 'message-added', chatId, message: row, ts: Date.now() });
      return;
    }
    if (!have.id) return; // our own prompt's echo
    if (have.kind === b.kind && have.text === b.text && have.output === b.output) return;
    // Still streaming: rewrite the row. The renderer drops and re-adds it
    // by id, which is fine for the row at the bottom (where streaming is).
    updateMessageBody(have.id, bodyFor(b, `${chatId}_${i}`));
    have.text = b.text;
    have.output = b.output;
    const fresh = getMessage(have.id);
    if (fresh) {
      m.emit({ type: 'message-removed', chatId, messageId: have.id, ts: Date.now() });
      m.emit({ type: 'message-added', chatId, message: fresh, ts: Date.now() });
    }
  });
}
