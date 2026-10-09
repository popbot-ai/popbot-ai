/**
 * A chat's transcript as its host has it: built from the chat's event log
 * (sessions.ts), for the host's own get_chat_transcript and search_chats
 * while no desktop can be reached. The desktop's transcript is the full
 * record; this is what the log holds — its most recent part.
 *
 * Entries come out in the desktop's shape (src/main/mcp/transcript.ts),
 * so the same rendering and search apply. An entry's index is the seq of
 * the frame that began it: stable as the log is trimmed, but its own
 * numbering, not the desktop's.
 */
import type { HostFrame } from '@shared/hostProtocol';
import type { TranscriptEntry } from '../main/mcp/transcript';

const TOOL_TEXT_CAP = 800;

function clip(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}… (${s.length - cap} more chars)` : s;
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** What the desktop puts in front of a first message — where the agent
 *  is — is for the agent, not part of the conversation. */
function withoutPreamble(text: string): string {
  return text.replace(/^\[System\][\s\S]*?\n\n/, '');
}

export function frameEntries(frames: HostFrame[], opts: { includeTools?: boolean } = {}): TranscriptEntry[] {
  const includeTools = opts.includeTools ?? true;
  const out: TranscriptEntry[] = [];
  const agentText = new Map<string, TranscriptEntry>();
  const tools = new Map<string, TranscriptEntry>();
  let ts = 0;
  const add = (seq: number, role: TranscriptEntry['role'], kind: TranscriptEntry['kind'], text: string): TranscriptEntry => {
    const entry: TranscriptEntry = { index: seq, id: `seq_${seq}`, role, kind, ts, text };
    out.push(entry);
    return entry;
  };
  for (const f of frames) {
    switch (f.kind) {
      case 'user':
        ts = f.ts;
        add(f.seq, 'user', 'text', withoutPreamble(f.text));
        break;
      case 'prompt':
        add(f.seq, 'user', 'text', `(from ${f.from.name}) ${f.text}`);
        break;
      case 'event': {
        const e = f.event;
        ts = e.ts || ts;
        switch (e.type) {
          case 'message-start':
            agentText.set(e.messageId, add(f.seq, 'agent', 'text', ''));
            break;
          case 'text-delta': {
            const entry = agentText.get(e.messageId) ?? add(f.seq, 'agent', 'text', '');
            agentText.set(e.messageId, entry);
            entry.text += e.delta;
            break;
          }
          case 'tool-use':
            if (includeTools) tools.set(e.toolUseId, add(f.seq, 'agent', 'tool', `[tool ${e.name}] ${clip(stringify(e.args), TOOL_TEXT_CAP)}`));
            break;
          case 'tool-result': {
            const entry = tools.get(e.toolUseId);
            if (entry) entry.text += `\n→ ${e.isError ? 'ERROR ' : ''}${clip(e.text, TOOL_TEXT_CAP)}`;
            break;
          }
          case 'permission-request':
            if (includeTools) add(f.seq, 'agent', 'permission', `[permission ${e.tool}] pending`);
            break;
          case 'note':
            add(f.seq, 'system', 'system', e.text);
            break;
          case 'error':
            add(f.seq, 'system', 'system', `error: ${e.message}`);
            break;
          default:
            break;
        }
        break;
      }
      default:
        break;
    }
  }
  return out.filter((e) => e.kind !== 'text' || e.role !== 'agent' || e.text.trim() !== '');
}
