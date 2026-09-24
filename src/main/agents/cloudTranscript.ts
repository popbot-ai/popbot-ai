/**
 * Read a Claude Code terminal session as a transcript.
 *
 * Cloud sessions can't be attached to programmatically (the account
 * flag is off) and leave nothing on disk, so the only local source of a
 * cloud chat's replies is the CLI that created the session, still
 * attached in the chat's terminal. Its output is a TUI — cursor moves,
 * redraws, spinners — so it goes through a headless terminal emulator
 * first: the same bytes the visible terminal draws, resolved into a
 * plain grid of lines with the scrollback intact. On that grid the
 * transcript has a small grammar:
 *
 *   ❯ text          a prompt (yours), in the transcript
 *   ⏺ text          the agent's text; continuation lines are indented
 *     Listed 1 dir… a collapsed tool call (indented summary line)
 *   ⏺ Bash(ls)      an expanded tool call, its output on ⎿ lines
 *   ✻ Worked for 3s the turn's status line; "esc to interrupt" = running
 *   ─────           the box around the input line, at the bottom
 *
 * Everything below the box's top edge is chrome; the banner above the
 * first prompt is too. Wrapped rows are joined back into lines. The
 * parser is pure and tested on captured sessions; a CLI release that
 * changes the glyphs breaks it visibly, never silently.
 */
import { Terminal } from '@xterm/headless';

export type TranscriptBlockKind = 'user' | 'agent' | 'tool';

export interface TranscriptBlock {
  kind: TranscriptBlockKind;
  /** For a tool: the summary or `Name(args)`; for text: the text. */
  text: string;
  /** Expanded tool output (⎿ lines), when shown. */
  output?: string;
}

export interface Transcript {
  blocks: TranscriptBlock[];
  /** The TUI's input box is on screen: the CLI is attached. */
  attached: boolean;
  /** A turn is in progress ("esc to interrupt" on the status line). */
  running: boolean;
}

const SEPARATOR = /^\s*─{12,}\s*$/;
const PROMPT = /^❯ ?(.*)$/;
const AGENT = /^⏺ ?(.*)$/;
const TOOL_OUTPUT = /^\s*⎿\s?(.*)$/;
const STATUS = /^[✻✽✶✳✢·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/;
/** `Name(args)` as the CLI prints an expanded tool call. */
const TOOL_CALL = /^[A-Z][A-Za-z0-9_]*\(.*\)$/;

/** Parse the grid's logical lines (wrapped rows already joined). */
export function parseTranscriptLines(allLines: string[]): Transcript {
  // Start at the CLI's banner: the shell prompt before it may well use ❯
  // itself (starship, pure) and would read as a user prompt otherwise.
  let start = 0;
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (/Claude Code v\d/.test(allLines[i])) { start = i; break; }
  }
  const lines = allLines.slice(start);
  // The input box: the last two separators. Above the upper one is the
  // transcript; between them the prompt being typed; below, the hints.
  const seps: number[] = [];
  lines.forEach((l, i) => { if (SEPARATOR.test(l)) seps.push(i); });
  const attached = seps.length >= 2 && seps[seps.length - 1] - seps[seps.length - 2] <= 6;
  const end = attached ? seps[seps.length - 2] : lines.length;
  const body = lines.slice(0, end);
  const tail = lines.slice(end);
  const running = [...body.slice(-4), ...tail].some((l) => /esc to interrupt/i.test(l));

  const blocks: TranscriptBlock[] = [];
  let current: TranscriptBlock | null = null;
  let seenPrompt = false;
  const flush = (): void => { if (current) { current.text = current.text.trimEnd(); blocks.push(current); current = null; } };

  for (const raw of body) {
    const line = raw.replace(/\s+$/, '');
    let m: RegExpExecArray | null;
    if ((m = PROMPT.exec(line))) {
      flush();
      seenPrompt = true;
      current = { kind: 'user', text: m[1] };
      continue;
    }
    if (!seenPrompt) continue; // the banner
    if ((m = AGENT.exec(line))) {
      flush();
      const text = m[1];
      current = TOOL_CALL.test(text) ? { kind: 'tool', text } : { kind: 'agent', text };
      continue;
    }
    if (STATUS.test(line)) { flush(); continue; }
    if ((m = TOOL_OUTPUT.exec(line))) {
      const piece = m[1].trim();
      if (current?.kind === 'tool') current.output = current.output ? `${current.output}\n${piece}` : piece;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s{2,}\S/.test(line)) {
      if (current) {
        // Continuation of the open block (agent prose, or more tool output).
        if (current.kind === 'tool' && current.output !== undefined) current.output += `\n${line.trim()}`;
        else current.text += `\n${line.trim()}`;
      } else {
        // A collapsed tool call: "  Listed 1 directory (ctrl+o to expand)".
        blocks.push({ kind: 'tool', text: line.trim().replace(/\s*\(ctrl\+o to expand\)$/i, '') });
      }
      continue;
    }
    // Anything else at column 0 continues the open block.
    if (current) current.text += `\n${line}`;
  }
  flush();
  return { blocks, attached, running };
}

/**
 * The headless terminal plus parser: feed it exactly what the pty emits,
 * ask for the transcript whenever convenient.
 */
export class TerminalTranscript {
  private readonly term: Terminal;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
  }

  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** The grid as logical lines: wrapped rows joined, trailing blanks cut. */
  lines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length > 0 && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  transcript(): Transcript {
    return parseTranscriptLines(this.lines());
  }

  dispose(): void {
    this.term.dispose();
  }
}
