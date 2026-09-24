/**
 * Read-side helpers over a chat's transcript for the popbot MCP tools:
 * flatten the stored rows into numbered plain-text entries, render a
 * range of them, and search them with surrounding context. Pure — the
 * tools fetch the rows and hand them in.
 */
import type { MessageKind, MessageRecord, MessageRole } from '@shared/persistence';

export interface TranscriptEntry {
  /** Position in the chat, 0-based, stable for the life of the chat. */
  index: number;
  id: string;
  role: MessageRole;
  kind: MessageKind;
  ts: number;
  text: string;
}

const TOOL_TEXT_CAP = 800;

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

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

/** One text line per stored row. Tool rows are summarized (name, args,
 *  result) and can be left out; system rows can too. */
export function transcriptEntries(
  messages: MessageRecord[],
  opts: { includeTools?: boolean; includeSystem?: boolean } = {},
): TranscriptEntry[] {
  const includeTools = opts.includeTools ?? true;
  const includeSystem = opts.includeSystem ?? true;
  const out: TranscriptEntry[] = [];
  messages.forEach((m, index) => {
    let text: string | null = null;
    if (m.kind === 'text' || m.kind === 'system') {
      if (m.kind === 'system' && !includeSystem) return;
      const body = parse<{ text?: string; attachments?: unknown[] }>(m.body);
      text = body?.text ?? '';
      if (body?.attachments?.length) text += ` [${body.attachments.length} attachment(s)]`;
    } else if (m.kind === 'tool') {
      if (!includeTools) return;
      const body = parse<{ name?: string; args?: unknown; result?: unknown; isError?: boolean }>(m.body);
      const args = clip(stringify(body?.args), TOOL_TEXT_CAP);
      const result = body?.result === undefined ? '' : `\n→ ${body.isError ? 'ERROR ' : ''}${clip(stringify(body.result), TOOL_TEXT_CAP)}`;
      text = `[tool ${body?.name ?? '?'}] ${args}${result}`;
    } else if (m.kind === 'permission') {
      if (!includeTools) return;
      const body = parse<{ tool?: string; decision?: string }>(m.body);
      text = `[permission ${body?.tool ?? '?'}] ${body?.decision ?? 'pending'}`;
    }
    if (text === null) return;
    out.push({ index, id: m.id, role: m.role, kind: m.kind, ts: m.createdAt, text });
  });
  return out;
}

export interface RenderOptions {
  /** Inclusive entry indices (as in {@link TranscriptEntry.index}). */
  from?: number;
  to?: number;
  maxChars?: number;
}

/** Numbered, timestamped text; cut at `maxChars` with a note saying so. */
export function renderTranscript(entries: TranscriptEntry[], opts: RenderOptions = {}): { text: string; count: number; truncated: boolean } {
  const from = opts.from ?? 0;
  const to = opts.to ?? Number.MAX_SAFE_INTEGER;
  const picked = entries.filter((e) => e.index >= from && e.index <= to);
  const maxChars = opts.maxChars ?? 60_000;
  let text = '';
  let truncated = false;
  let count = 0;
  for (const e of picked) {
    const block = `#${e.index} ${e.role} @ ${new Date(e.ts).toISOString()}\n${e.text}\n\n`;
    if (text.length + block.length > maxChars) {
      truncated = true;
      break;
    }
    text += block;
    count += 1;
  }
  if (truncated) text += `… (${picked.length - count} more entries; ask for a narrower range)\n`;
  return { text, count, truncated };
}

export interface SearchOptions {
  contextChars?: number;
  maxResults?: number;
  caseSensitive?: boolean;
}

export interface SearchMatch {
  index: number;
  id: string;
  role: MessageRole;
  ts: number;
  /** Character offset of the match inside the entry's text. */
  offset: number;
  before: string;
  match: string;
  after: string;
}

/** Every occurrence of `query`, with `contextChars` on each side. */
export function searchTranscript(entries: TranscriptEntry[], query: string, opts: SearchOptions = {}): SearchMatch[] {
  const q = opts.caseSensitive ? query : query.toLowerCase();
  if (!q) return [];
  const context = Math.max(0, opts.contextChars ?? 200);
  const max = Math.max(1, opts.maxResults ?? 20);
  const out: SearchMatch[] = [];
  for (const e of entries) {
    const hay = opts.caseSensitive ? e.text : e.text.toLowerCase();
    let at = hay.indexOf(q);
    while (at >= 0 && out.length < max) {
      out.push({
        index: e.index,
        id: e.id,
        role: e.role,
        ts: e.ts,
        offset: at,
        before: e.text.slice(Math.max(0, at - context), at),
        match: e.text.slice(at, at + query.length),
        after: e.text.slice(at + query.length, at + query.length + context),
      });
      at = hay.indexOf(q, at + Math.max(1, q.length));
    }
    if (out.length >= max) break;
  }
  return out;
}

/** The conversation as plain text, one entry per line. */
export function transcriptPlainText(entries: TranscriptEntry[]): string {
  return entries.map((e) => `[#${e.index} ${e.role}] ${e.text}`).join('\n');
}
