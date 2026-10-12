/**
 * Auto-continue: a chat that has gone quiet is nudged to carry on.
 *
 *   forever          "Please check for and continue any outstanding work."
 *                    every time it has been idle a minute.
 *   until-complete   "Please check and continue any outstanding work. If
 *                    all work is complete respond ALL WORK COMPLETE" — and
 *                    once a reply says ALL WORK COMPLETE, the chat is
 *                    marked done and the mode switches itself off.
 *
 * Only an open chat that is idle — not mid-turn, not failed — and has
 * been for IDLE_MS. An agent whose last act was to start something it
 * expects to be woken from (a background command, a scheduled wakeup, a
 * monitor) is left BACKGROUND_GRACE_MS longer to be woken by it.
 *
 * A chat paused on its user is not left there either — in this mode an
 * agent is never idle or paused for good. After AWAY_MS a permission it
 * asked for is denied, "User not available. Auto-continue mode on", and
 * its turn goes on without that step; a question is answered "User is not
 * available now." with the nudge.
 *
 * The nudge shows in the chat as a folded "Auto-continue" row, sent as it
 * is (no attribution: it is not a message from another chat).
 */
import type { MessageBodyPermission, MessageBodyTool } from '@shared/persistence';
import { getChat, listOpenChats, updateChatStatus } from '../persistence/chats';
import { isDbOpen } from '../persistence/db';
import { lastMessageOfKind, listMessages } from '../persistence/messages';
import { getSetting, setSetting } from '../persistence/settings';
import { dlog } from '../diagLog';
import { AgentHost } from './AgentHost';

export type AutoContinueMode = 'forever' | 'until-complete';

const KEY = 'chats.autoContinue';
const IDLE_MS = 60_000;
/** A chat waiting on its user hears it is away after this. */
const AWAY_MS = 3 * 60_000;
const BACKGROUND_GRACE_MS = 10 * 60_000;
const TICK_MS = 10_000;
export const COMPLETE_MARK = 'ALL WORK COMPLETE';
export const CONTINUE_PROMPTS: Record<AutoContinueMode, string> = {
  forever: 'Please check for and continue any outstanding work.',
  'until-complete': `Please check and continue any outstanding work. If all work is complete respond ${COMPLETE_MARK}`,
};
/** Every nudge says what it is, so the agent never takes it for its user. */
export const AUTO_CONTINUE_TAG = '[Auto-continue from PopBot, not from the user]';

export function autoContinueModes(): Record<string, AutoContinueMode> {
  return getSetting<Record<string, AutoContinueMode>>(KEY) ?? {};
}

export function setAutoContinue(chatId: string, mode: AutoContinueMode | null): void {
  const all = { ...autoContinueModes() };
  if (mode) all[chatId] = mode;
  else delete all[chatId];
  setSetting(KEY, all);
  AgentHost.emit({ type: 'chats-changed', chatId, reason: 'auto-continue', ts: Date.now() });
}

/** Since when each chat has been idle, from the agent events. */
const idleSince = new Map<string, number>();
/** Since when each chat has been waiting on its user. */
const waitingSince = new Map<string, number>();
/** Nudges sent, waiting for the turn they start — and when. One that
 *  starts none within NUDGE_STALE_MS no longer holds the chat back. */
const nudged = new Map<string, number>();
const NUDGE_STALE_MS = 5 * 60_000;
/** When each chat was last nudged: a reply after it may say it is done. */
const lastNudgeAt = new Map<string, number>();
/** Quiet is counted from launch at the earliest, so a restart does not
 *  wake every chat at once. */
let startedAt = 0;

/** The last thing the agent did starts work that wakes it later. */
function waitingOnBackground(chatId: string): boolean {
  const tool = lastMessageOfKind(chatId, 'tool', 'agent');
  if (!tool) return false;
  try {
    const body = JSON.parse(tool.body) as MessageBodyTool;
    const args = (body.args ?? {}) as Record<string, unknown>;
    return (body.name === 'Bash' && args.run_in_background === true) || /^(ScheduleWakeup|Monitor)$/.test(body.name ?? '');
  } catch {
    return false;
  }
}

export const AWAY_DENIAL = 'User not available. Auto-continue mode on';

/** The permissions it is still waiting for (several, when tools ran in
 *  parallel) — among its recent rows. */
function pendingPermissions(chatId: string): string[] {
  const ids: string[] = [];
  for (const row of listMessages(chatId, 100)) {
    if (row.kind !== 'permission') continue;
    try {
      const body = JSON.parse(row.body) as MessageBodyPermission;
      if (body.permissionId && !body.decision) ids.push(body.permissionId);
    } catch {
      // not a permission row
    }
  }
  return ids;
}

async function tick(): Promise<void> {
  if (!isDbOpen()) return;
  const modes = autoContinueModes();
  if (Object.keys(modes).length === 0) return;
  const open = new Set(listOpenChats().map((c) => c.id));
  const now = Date.now();
  for (const [chatId, mode] of Object.entries(modes)) {
    const chat = getChat(chatId);
    if (!chat || !open.has(chatId) || chat.host?.botId) continue;
    const pendingNudge = nudged.get(chatId);
    if (pendingNudge !== undefined) {
      if (now - pendingNudge < NUDGE_STALE_MS) continue;
      nudged.delete(chatId);
    }
    let text = CONTINUE_PROMPTS[mode];
    if (chat.status === 'wait') {
      // Waiting on its user: after a while, it is told the user is away.
      const waited = now - Math.max(waitingSince.get(chatId) ?? chat.lastActiveAt, startedAt);
      if (waited < AWAY_MS) continue;
      waitingSince.delete(chatId);
      // Permissions it is waiting on: denied, and its turn goes on without
      // those steps — while its session is there to hear it. (After a
      // restart there is none: it is told the user is away instead.)
      const permissions = AgentHost.isAttached(chatId) ? pendingPermissions(chatId) : [];
      if (permissions.length > 0) {
        nudged.set(chatId, now);
        dlog('autocontinue.deny', { chatId, permissions });
        for (const id of permissions) AgentHost.approve(chatId, id, 'deny', AWAY_DENIAL);
        continue;
      }
      // A question: the user is away; carry on.
      text = `User is not available now. ${text}`;
    } else {
      // Otherwise idle only: not working, not failed.
      if (chat.status !== 'idle') continue;
      const quiet = now - Math.max(idleSince.get(chatId) ?? chat.lastActiveAt, startedAt);
      if (quiet < IDLE_MS) continue;
      if (quiet < BACKGROUND_GRACE_MS && waitingOnBackground(chatId)) continue;
    }
    nudged.set(chatId, now);
    lastNudgeAt.set(chatId, now);
    idleSince.delete(chatId);
    dlog('autocontinue.nudge', { chatId, mode, status: chat.status });
    void AgentHost.send(chatId, `${AUTO_CONTINUE_TAG} ${text}`, undefined, {
      chatId: 'popbot',
      chatName: 'Auto-continue',
      waiting: false,
      summary: mode === 'forever' ? 'Continue' : 'Continue until complete',
      notice: true,
    }).catch((err: unknown) => {
      nudged.delete(chatId);
      dlog('autocontinue.failed', { chatId, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Until-complete: the turn just ended — did it say it is all done? */
function checkComplete(chatId: string): void {
  if (autoContinueModes()[chatId] !== 'until-complete') return;
  // Its text is on the row by now; give the last delta a moment to land.
  setTimeout(() => {
    if (!isDbOpen()) return;
    // The answer to a nudge, ending with the mark — not a mention of it,
    // or something said before the mode was on.
    const nudgedAt = lastNudgeAt.get(chatId);
    const last = lastMessageOfKind(chatId, 'text', 'agent');
    if (!last || nudgedAt === undefined || last.createdAt < nudgedAt) return;
    let text = '';
    try { text = (JSON.parse(last.body) as { text?: string }).text ?? ''; } catch { /* not text */ }
    if (!/ALL WORK COMPLETE[\s.!*_`]*$/.test(text.trim())) return;
    setAutoContinue(chatId, null);
    updateChatStatus(chatId, 'done');
    AgentHost.emit({ type: 'session-status', chatId, status: 'complete', ts: Date.now() });
    dlog('autocontinue.complete', { chatId });
  }, 500);
}

let timer: ReturnType<typeof setInterval> | null = null;
let listening = false;

/** Stop the clock (tests; quitting). */
export function stopAutoContinue(): void {
  if (timer) clearInterval(timer);
  timer = null;
  idleSince.clear();
  waitingSince.clear();
  nudged.clear();
  lastNudgeAt.clear();
}

export function startAutoContinue(): void {
  if (timer) return;
  startedAt = Date.now();
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  if (listening) return;
  listening = true;
  AgentHost.onEvent((event) => {
    if (event.type === 'turn-start') {
      idleSince.delete(event.chatId);
      nudged.delete(event.chatId);
    } else if (event.type === 'permission-request') {
      if (!waitingSince.has(event.chatId)) waitingSince.set(event.chatId, event.ts);
    } else if (event.type === 'session-status') {
      if (event.status === 'paused') {
        if (!waitingSince.has(event.chatId)) waitingSince.set(event.chatId, event.ts);
        return;
      }
      waitingSince.delete(event.chatId);
      if (event.status === 'idle' || event.status === 'complete') {
        idleSince.set(event.chatId, event.ts);
        nudged.delete(event.chatId);
        checkComplete(event.chatId);
      } else {
        idleSince.delete(event.chatId);
      }
    }
  });
}
