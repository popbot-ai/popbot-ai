/**
 * Boot-time chat-session recovery.
 *
 * Runs on every launch. Idempotent. Two phases:
 *
 *  A. Content-based orphan attribution
 *     For each session_id with NULL chat_id, read the first ~10
 *     entries' payload text and look for ticket / PR markers
 *     (ENG-XXXXX, PR #NNN, "#NNN"). Match against `chats.ticket`
 *     and `chats.pr`. When a match is unambiguous, claim every row
 *     of that session for the chat (UPDATE chat_id).
 *
 *     Why this works: the first user message of a popbot-spawned
 *     chat is template-generated to include the linkage explicitly
 *     ("Linear ticket **ENG-20082**" / "PR #7301"). The text is
 *     stored verbatim in our payload column — no disk dependency,
 *     no SDK call.
 *
 *  B. Per-chat re-pin
 *     For each open chat:
 *       1. If chat.session_id is pinned AND our chat-keyed store
 *          has entries for it → fine.
 *       2. Else if any chat-keyed sessions exist for this chat →
 *          re-pin to the richest one (this is where freshly-claimed
 *          orphans land).
 *       3. Else fall back to branch-matched SDK sessions on disk
 *          (the slower path, kept as a safety net).
 *       4. Else log as unrecoverable.
 *
 * Logged per chat:
 *   chat.recover.ok          pin already valid
 *   chat.recover.repinned    pin switched to a richer session
 *   chat.recover.claimed     attributed orphan rows via content/branch
 *   chat.recover.failed      no candidate session found
 *
 * Plus chat.recover.attribute.done with content-phase counts and
 * chat.recover.done with overall counts. Grep these to confirm
 * everything that can be recovered, was.
 */
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { db, isDbOpen } from '../persistence/db';
import { dlog } from '../diagLog';
import { listOpenChats, setChatSessionId } from '../persistence/chats';
import { getSetting } from '../persistence/settings';
import { appendMessage, countAgentOrUserMessages, listMessages } from '../persistence/messages';
import { sqliteSessionStore } from './sqliteSessionStore';
import { applyPerforceAgentCwd, worktreePathForChat } from '../git/chatPaths';
import type { ChatRecord, MessageBodyText } from '@shared/persistence';

/** Append a system-note to the chat transcript so the user can see
 *  recovery actions when they reopen the chat. Markdown-flavored so
 *  the existing system-message renderer picks up the bold + code spans. */
/** A short marker baked into every recovery note so we can detect
 *  an existing identical note on re-runs and skip it (idempotency).
 *  The marker is invisible to humans — it sits inside a Markdown
 *  comment that the renderer collapses. */
const RECOVERY_NOTE_MARKER = '<!-- popbot.chat.recover -->';

function lastSystemNoteText(chatId: string): string | null {
  const msgs = listMessages(chatId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === 'system') {
      try { return (JSON.parse(m.body) as MessageBodyText).text ?? ''; } catch { return ''; }
    }
  }
  return null;
}

function noteRecoveryInTranscript(
  chatId: string,
  kind: 'repinned' | 'claimed' | 'failed',
  detail: { newSessionId?: string; oldSessionId?: string | null; entries?: number; source?: string },
): void {
  const lines: string[] = [RECOVERY_NOTE_MARKER];
  if (kind === 'repinned' || kind === 'claimed') {
    lines.push(`**Session recovered.** Re-linked this chat to its prior Claude session \`${detail.newSessionId}\` (${detail.entries ?? 0} entries).`);
    if (detail.oldSessionId) lines.push(`Previous (empty / mis-linked) session: \`${detail.oldSessionId}\`.`);
    if (detail.source) lines.push(`Source: ${detail.source}.`);
    lines.push('Continue chatting and the agent should pick up where it left off.');
  } else {
    lines.push(`**Session detached.** This chat's Claude memory couldn't be located automatically.`);
    lines.push('Open chat settings to attempt manual recovery, or send a new message to start a fresh conversation (the transcript above is preserved but the agent won\'t recall it).');
  }
  // Idempotency: if the most recent system message in this chat is
  // already a recovery note pointing at the same outcome
  // (same newSessionId for repin/claim, or already-detached state),
  // skip the append. Avoids piling up identical notes on every boot.
  const prev = lastSystemNoteText(chatId);
  if (prev && prev.startsWith(RECOVERY_NOTE_MARKER)) {
    const sameRepin = (kind === 'repinned' || kind === 'claimed')
      && detail.newSessionId
      && prev.includes(detail.newSessionId);
    const sameFailed = kind === 'failed' && prev.includes('Session detached');
    if (sameRepin || sameFailed) return;
  }
  try {
    appendMessage({
      chatId,
      role: 'system',
      kind: 'system',
      body: { text: lines.join('\n\n') } satisfies MessageBodyText,
    });
  } catch (err) {
    dlog('chat.recover.note-failed', { chatId, error: (err as Error).message });
  }
}

interface GitSettingsLite {
  repoPath?: string;
  repoName?: string;
  slotPrefix?: string;
  worktreesDir?: string;
}

interface SlotsSettingsLite {
  maxCount?: number;
}

// ----- Phase A: content-based attribution -----------------------------------

/** Snippet length we read from the first entries when looking for
 *  identifiers. Long enough to clear past JSON framing and into the
 *  template body, short enough to keep the scan cheap. */
const ATTRIBUTE_PAYLOAD_HEAD_CHARS = 4000;
/** Entries per session we inspect. The chat-spawn template lives in
 *  the very first user message; a few extra slots cover wrappers. */
const ATTRIBUTE_ENTRIES_PER_SESSION = 6;

function attributeSessionToChat(sessionId: string, chatId: string): number {
  const res = db().prepare(
    `UPDATE sdk_session_entries
        SET chat_id = ?
      WHERE session_id = ?
        AND chat_id IS NULL`,
  ).run(chatId, sessionId);
  return res.changes ?? 0;
}

interface OrphanScanRow { session_id: string }
interface PayloadRow { payload: string }

/** Pull a haystack of text from the first N entries of one session. */
function sessionHeadText(sessionId: string): string {
  const rows = db()
    .prepare<[string, number], PayloadRow>(
      `SELECT payload FROM sdk_session_entries
        WHERE session_id = ? AND subpath = ''
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .all(sessionId, ATTRIBUTE_ENTRIES_PER_SESSION);
  let acc = '';
  for (const r of rows) {
    acc += r.payload.slice(0, ATTRIBUTE_PAYLOAD_HEAD_CHARS) + '\n';
    if (acc.length >= ATTRIBUTE_PAYLOAD_HEAD_CHARS * 2) break;
  }
  return acc;
}

interface ChatLookups {
  byTicket: Map<string, string>; // ticket → chat.id
  byPr: Map<number, string>;     // pr     → chat.id
}

function buildChatLookups(): ChatLookups {
  const byTicket = new Map<string, string>();
  const byPr = new Map<number, string>();
  const rows = db()
    .prepare<[], { id: string; ticket: string | null; pr: number | null }>(
      `SELECT id, ticket, pr FROM chats WHERE deleted_at IS NULL`,
    )
    .all();
  for (const r of rows) {
    if (r.ticket && !byTicket.has(r.ticket)) byTicket.set(r.ticket, r.id);
    if (r.pr != null && !byPr.has(r.pr)) byPr.set(r.pr, r.id);
  }
  return { byTicket, byPr };
}

/** Sweep orphan sessions, attribute by ticket/PR markers in the
 *  payload text. Returns counts for logging. */
function attributeOrphansByContent(lookups: ChatLookups): {
  sessionsScanned: number;
  sessionsAttributed: number;
  rowsClaimed: number;
} {
  const orphanSessions = db()
    .prepare<[], OrphanScanRow>(
      `SELECT DISTINCT session_id FROM sdk_session_entries
        WHERE chat_id IS NULL AND subpath = ''`,
    )
    .all();
  let attributed = 0;
  let claimed = 0;
  for (const { session_id } of orphanSessions) {
    const text = sessionHeadText(session_id);
    if (!text) continue;
    // Ticket match: ENG-NNNNN (and similar 2-5 letter prefixes,
    // matching the parseTicketFromText in chatBackfill).
    const ticketMatch = /\b([A-Z]{2,5}-\d+)\b/.exec(text);
    if (ticketMatch) {
      const chatId = lookups.byTicket.get(ticketMatch[1]);
      if (chatId) {
        const n = attributeSessionToChat(session_id, chatId);
        if (n > 0) {
          attributed += 1;
          claimed += n;
          dlog('chat.recover.attribute.ticket', {
            chatId, sessionId: session_id, ticket: ticketMatch[1], rows: n,
          });
        }
        continue;
      }
    }
    // PR match: "PR #NNN" or "#NNN" where NNN >= 2 digits.
    const prMatch = /\bPR\s*#?(\d+)\b|#(\d{2,})\b/.exec(text);
    if (prMatch) {
      const prNum = Number.parseInt(prMatch[1] ?? prMatch[2], 10);
      const chatId = lookups.byPr.get(prNum);
      if (chatId) {
        const n = attributeSessionToChat(session_id, chatId);
        if (n > 0) {
          attributed += 1;
          claimed += n;
          dlog('chat.recover.attribute.pr', {
            chatId, sessionId: session_id, pr: prNum, rows: n,
          });
        }
      }
    }
  }
  return {
    sessionsScanned: orphanSessions.length,
    sessionsAttributed: attributed,
    rowsClaimed: claimed,
  };
}

// ----- Boilerplate verification ---------------------------------------------

/** Prefixes that pin a session to a popbot-spawned chat. See the
 *  DEFAULT_START_TICKET_TEMPLATE / DEFAULT_START_CODE_REVIEW_TEMPLATE
 *  in src/renderer/src/lib/templates.ts. Both phrases survive in
 *  user-edited variants — the boilerplate framing is what makes a
 *  session identifiable as belonging to "the ENG-NNNNN chat" or
 *  "the PR #NNN chat." */
const TICKET_TEMPLATE_MARKER = 'Linear ticket';
const CR_TEMPLATE_MARKER = 'pull request';

/** Strong verification that a session was started with this chat's
 *  spawn template. Requires both the template's distinctive phrasing
 *  AND the chat's specific ticket / PR id to appear in the first
 *  ~few entries' payload. A session that was attributed by v14's
 *  session_id match but doesn't have the boilerplate is almost
 *  certainly a fresh-respawn empty session that ended up tagged with
 *  this chat's id by accident — not the real history.
 *
 *  Returns true when verifiable AND verified; true also for chats
 *  with no identifiers (we can't verify, so don't reject); false
 *  when the chat has identifiers but the session lacks them. */
function sessionMatchesChatTemplate(sessionId: string, chat: ChatRecord): boolean {
  if (!chat.ticket && chat.pr == null && !chat.branch) return true;
  const text = sessionHeadText(sessionId);
  if (!text) return false;
  if (chat.ticket && text.includes(TICKET_TEMPLATE_MARKER) && text.includes(chat.ticket)) {
    return true;
  }
  if (chat.pr != null && text.includes(CR_TEMPLATE_MARKER) && text.includes(`#${chat.pr}`)) {
    return true;
  }
  // Branch-only chats: looser check (no template marker), branch
  // alone is the signal we have.
  if (!chat.ticket && chat.pr == null && chat.branch && text.includes(chat.branch)) {
    return true;
  }
  return false;
}

// ----- Phase B: per-chat pin resolution -------------------------------------

function candidateCwdsForChat(
  chat: ChatRecord,
  gitCfg: GitSettingsLite,
  slotsMaxCount: number,
): string[] {
  const out: string[] = [];
  const live = worktreePathForChat(chat);
  if (live) {
    out.push(live);
    // Perforce agent-cwd subpath: sessions are stored under the subdir the
    // agent actually runs in, so scan that too.
    const agentCwd = applyPerforceAgentCwd(live, chat);
    if (agentCwd && agentCwd !== live) out.push(agentCwd);
  }
  const repoName = gitCfg.repoName?.trim() || 'app';
  const slotPrefix = gitCfg.slotPrefix?.trim() || 'slot';
  const worktreesDir = gitCfg.worktreesDir || join(homedir(), 'popbot', 'workspaces', repoName);
  for (let i = 1; i <= slotsMaxCount; i++) {
    const p = join(worktreesDir, `${slotPrefix}-${i}`);
    if (!out.includes(p)) out.push(p);
  }
  if (gitCfg.repoPath && !out.includes(gitCfg.repoPath)) {
    out.push(gitCfg.repoPath);
  }
  return out;
}

async function findBranchMatchedSessions(
  chat: ChatRecord,
  cwds: string[],
): Promise<SDKSessionInfo[]> {
  if (!chat.branch) return [];
  const acc: SDKSessionInfo[] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    let list: SDKSessionInfo[] = [];
    try {
      list = await listSessions({ dir: cwd, includeWorktrees: false });
    } catch {
      continue;
    }
    for (const s of list) {
      if (seen.has(s.sessionId)) continue;
      if (s.gitBranch !== chat.branch) continue;
      seen.add(s.sessionId);
      acc.push(s);
    }
  }
  acc.sort((a, b) => b.lastModified - a.lastModified);
  return acc;
}

// ----- Public entrypoint ----------------------------------------------------

export async function recoverChatSessions(): Promise<void> {
  if (!isDbOpen()) return;
  const gitCfg = getSetting<GitSettingsLite>('git') ?? {};
  const slotsCfg = getSetting<SlotsSettingsLite>('slots') ?? {};
  const slotsMaxCount =
    typeof slotsCfg.maxCount === 'number' && slotsCfg.maxCount > 0
      ? Math.floor(slotsCfg.maxCount)
      : 8;

  const chats = listOpenChats();
  dlog('chat.recover.begin', { chats: chats.length });

  // Phase A: claim orphan sessions for their chats via content match.
  const lookups = buildChatLookups();
  const attribute = attributeOrphansByContent(lookups);
  dlog('chat.recover.attribute.done', attribute);

  // Phase B: resolve each chat's session pin.
  let ok = 0;
  let repinned = 0;
  let claimedByBranch = 0;
  let failed = 0;

  for (const chat of chats) {
    // Skip brand-new chats with no real activity — they've never had
    // an agent session, so they aren't "detached", just unused. The
    // failed-recovery branch below would otherwise post a confusing
    // "Session detached" note onto a chat the user just created.
    if (!chat.sessionId && countAgentOrUserMessages(chat.id) === 0) {
      dlog('chat.recover.skip-empty', { chatId: chat.id, name: chat.name.slice(0, 60) });
      continue;
    }
    // Filter chat-attributed sessions to those that actually started
    // with this chat's spawn template (= the real working sessions).
    // Unverified sessions are usually fresh respawns that got opened
    // when we couldn't link to the old chat — they have entries but
    // no template, and they're NOT what we want to resume into.
    const allSessions = sqliteSessionStore.listSessionsForChat(chat.id);
    const verified = allSessions.filter(
      (s) => s.entryCount > 0 && sessionMatchesChatTemplate(s.sessionId, chat),
    );
    if (verified.length > 0) {
      const best = verified[0]; // listSessionsForChat is already sorted DESC by entryCount
      if (chat.sessionId === best.sessionId) {
        ok += 1;
        dlog('chat.recover.ok', {
          chatId: chat.id, name: chat.name.slice(0, 60),
          sessionId: chat.sessionId, entries: best.entryCount,
          verifiedAlternates: verified.length - 1,
          unverifiedAlternates: allSessions.length - verified.length,
        });
      } else {
        setChatSessionId(chat.id, best.sessionId);
        repinned += 1;
        dlog('chat.recover.repinned', {
          chatId: chat.id, name: chat.name.slice(0, 60),
          oldSessionId: chat.sessionId ?? null,
          oldEntries: chat.sessionId
            ? (allSessions.find((s) => s.sessionId === chat.sessionId)?.entryCount ?? 0)
            : 0,
          newSessionId: best.sessionId,
          newEntries: best.entryCount,
          source: 'verified-template-match-richest',
        });
        noteRecoveryInTranscript(chat.id, 'repinned', {
          newSessionId: best.sessionId,
          oldSessionId: chat.sessionId,
          entries: best.entryCount,
          source: 'verified-template-match-richest',
        });
      }
      continue;
    }
    // Last-resort: branch-matched SDK sessions on disk.
    const cwds = candidateCwdsForChat(chat, gitCfg, slotsMaxCount);
    const matched = await findBranchMatchedSessions(chat, cwds);
    if (matched.length > 0) {
      let rows = 0;
      for (const s of matched) rows += attributeSessionToChat(s.sessionId, chat.id);
      // Re-apply template verification AFTER claiming — the rich
      // session we just attributed has the boilerplate, the fresh-
      // empty respawn that's been sitting at the top of the list
      // doesn't. Without this re-check we'd pin to the empty one
      // again (we already had it attributed) and the chat would
      // remain detached in practice.
      const after = sqliteSessionStore.listSessionsForChat(chat.id);
      const afterVerified = after.filter(
        (s) => s.entryCount > 0 && sessionMatchesChatTemplate(s.sessionId, chat),
      );
      const pick = afterVerified[0] ?? after[0];
      if (pick && pick.entryCount > 0) {
        setChatSessionId(chat.id, pick.sessionId);
        repinned += 1;
        claimedByBranch += rows;
        dlog('chat.recover.claimed', {
          chatId: chat.id, name: chat.name.slice(0, 60),
          branch: chat.branch, matched: matched.length, rows,
          newSessionId: pick.sessionId,
          verified: afterVerified.length > 0,
        });
        noteRecoveryInTranscript(chat.id, 'claimed', {
          newSessionId: pick.sessionId,
          oldSessionId: chat.sessionId,
          entries: pick.entryCount,
          source: afterVerified.length > 0
            ? `branch-match verified (${matched.length} sessions, ${rows} rows)`
            : `branch-match unverified (${matched.length} sessions, ${rows} rows)`,
        });
        continue;
      }
    }
    failed += 1;
    dlog('chat.recover.failed', {
      chatId: chat.id, name: chat.name.slice(0, 60),
      ticket: chat.ticket, pr: chat.pr, branch: chat.branch,
      reason: 'no-candidate-anywhere',
    });
    noteRecoveryInTranscript(chat.id, 'failed', {});
  }

  dlog('chat.recover.done', {
    total: chats.length, ok, repinned, claimedByBranch, failed,
    contentAttributed: attribute,
  });
}
