import { existsSync } from 'node:fs';
import { dlog } from '../diagLog';
import { listOpenChats, clearChatSessionId } from '../persistence/chats';
import { getSetting } from '../persistence/settings';
import { sdkSessionJsonlPath } from './AgentHost';
import { worktreePathForChat } from '../git/chatPaths';

/**
 * One-shot boot-time sweep: clear `chat.sessionId` for any open chat
 * whose pinned id has no JSONL on disk.
 *
 * Why this exists: pin drift (now fixed in ClaudeBackend) used to
 * promote transient SDK-error session ids into the chat record. The
 * resulting pin pointed at a session that was never written, so
 * every subsequent resume returned "No conversation found" and the
 * SDK created another transient id → cycle. Clearing the broken pin
 * lets the next spawn fall through to `discoverSessionId` (worktree
 * scan) and recover whichever session actually has content.
 *
 * Conservative: we only clear when JSONL is missing. We don't try to
 * verify session-store rows here because the SDK's resume path
 * empirically reads the JSONL first; if the JSONL is gone, the pin
 * is functionally dead regardless of what's in our SQLite store.
 */
export function repairBrokenSessionPins(): void {
  const repoPath = getSetting<{ repoPath?: string }>('git')?.repoPath ?? null;
  let scanned = 0;
  let cleared = 0;
  for (const chat of listOpenChats()) {
    scanned += 1;
    if (!chat.sessionId) continue;
    // Slot chats use their worktree as cwd; slot-less chats (CR chats)
    // fall back to the configured repo root, matching what AgentHost
    // would pass to the SDK on spawn.
    const cwd = worktreePathForChat(chat) ?? repoPath;
    if (!cwd) continue;
    const jsonlPath = sdkSessionJsonlPath(cwd, chat.sessionId);
    if (!jsonlPath) continue;
    if (existsSync(jsonlPath)) continue;
    clearChatSessionId(chat.id);
    cleared += 1;
    dlog('chat.repair.cleared-pin', {
      chatId: chat.id,
      brokenSessionId: chat.sessionId,
      cwd,
      jsonlPath,
    });
  }
  dlog('chat.repair.done', { scanned, cleared });
}
