/**
 * Fork an agent's native conversation for a forked chat, so the fork
 * carries the agent's REAL context (its own memory of the work) rather
 * than a replayed transcript.
 *
 *   - Claude: the session lives in PopBot's SQLite session store. Copy
 *     its rows under a fresh session id and the CLI resumes the copy with
 *     full context (verified live).
 *   - Codex: threads are rollouts under ~/.codex/sessions. A transient
 *     `codex app-server` forks one with `thread/fork` and the exec SDK —
 *     or the app-server backend — resumes the new thread (verified live).
 *
 * Either can fail (no session yet, a thread Codex can't find, an old
 * CLI). That's not fatal: the fork then starts with no native session,
 * and the first message primes the agent from the transcript through the
 * ordinary provider-context bridge.
 */
import { randomUUID } from 'node:crypto';
import { dlog } from '../diagLog';
import { CodexRpcClient, spawnCodexAppServer } from './codexRpc';
import { resolveCodexBinary } from './CodexAppServerBackend';
import { sqliteSessionStore } from './sqliteSessionStore';

export interface ForkedContext {
  /** The fork's own session / thread id, or null when nothing could be forked. */
  id: string | null;
  /** Why it's null, for the log and the transcript note. */
  reason?: string;
}

export function forkClaudeSession(sourceSessionId: string | null, forkChatId: string): ForkedContext {
  if (!sourceSessionId) return { id: null, reason: 'no session yet' };
  const newId = randomUUID();
  try {
    const rows = sqliteSessionStore.forkSession(sourceSessionId, newId, forkChatId);
    if (rows === 0) {
      dlog('chat.fork.claude.empty', { forkChatId, sourceSessionId });
      return { id: null, reason: 'session has no stored transcript' };
    }
    dlog('chat.fork.claude', { forkChatId, sourceSessionId, newId, rows });
    return { id: newId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    dlog('chat.fork.claude.failed', { forkChatId, sourceSessionId, error: reason });
    return { id: null, reason };
  }
}

/** Fork a Codex thread through a one-shot app-server. `cwd` is the fork's
 *  workspace; the new thread is created there. */
export async function forkCodexThread(
  sourceThreadId: string | null,
  cwd: string | null,
  codexPath: string | null,
): Promise<ForkedContext> {
  if (!sourceThreadId) return { id: null, reason: 'no thread yet' };
  let client: CodexRpcClient | null = null;
  try {
    const bin = resolveCodexBinary(codexPath);
    const transport = spawnCodexAppServer(bin.path, bin.pathDirs);
    client = new CodexRpcClient(transport, {
      onNotification: () => undefined,
      // Nothing we send here can prompt for an approval; refuse anyway
      // rather than leave a request hanging.
      onServerRequest: (id) => client?.respondError(id, -32601, 'not handled during fork'),
      onClose: () => undefined,
    });
    const rpc = client;
    const result = await withTimeout(
      (async () => {
        await rpc.request('initialize', {
          clientInfo: { name: 'popbot', title: 'PopBot', version: '0' },
          capabilities: null,
        });
        rpc.notify('initialized');
        return rpc.request<{ thread: { id: string } }>('thread/fork', {
          threadId: sourceThreadId,
          ...(cwd ? { cwd } : {}),
        });
      })(),
      30_000,
      'codex thread/fork',
    );
    const newId = result?.thread?.id ?? null;
    dlog('chat.fork.codex', { sourceThreadId, newId, cwd });
    return newId ? { id: newId } : { id: null, reason: 'codex returned no thread id' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    dlog('chat.fork.codex.failed', { sourceThreadId, error: reason });
    return { id: null, reason };
  } finally {
    client?.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
