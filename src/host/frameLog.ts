/**
 * A bot chat's event log on disk. An ordinary host chat's log lives in
 * memory only — its desktop is usually attached, and a host restart is
 * an event it notices. A bot runs for weeks with no desktop watching,
 * so its log has to outlive the host process, and so does its seq: a
 * desktop that comes back asks for `after=N` against the same numbering.
 *
 * Bounded on purpose: a desktop that was away longer than `cap` frames
 * gets the most recent ones, not the bot's whole history. What a bot did
 * is on GitHub — its reviews, comments and commits — and that is the
 * record; this is only what the chat shows.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostFrame } from '@shared/hostProtocol';
import { dlog } from '../main/diagLog';

export class FrameLog {
  private constructor(private readonly path: string, readonly cap: number, private onDisk: number) {}

  /** Open the log at `path`, returning it with the frames it keeps (the
   *  newest `cap`) and the seq to continue from. */
  static open(path: string, cap: number): { log: FrameLog; frames: HostFrame[]; seq: number } {
    let frames: HostFrame[] = [];
    let lines = 0;
    if (existsSync(path)) {
      try {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line) continue;
          lines += 1;
          try {
            frames.push(JSON.parse(line) as HostFrame);
          } catch {
            // A line torn by a crash mid-write; the rest are good.
          }
        }
      } catch (err) {
        dlog('host.framelog.read-failed', { path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const seq = frames.reduce((n, f) => Math.max(n, f.seq), 0);
    if (frames.length > cap) frames = frames.slice(-cap);
    const log = new FrameLog(path, cap, lines);
    if (lines > frames.length) log.rewrite(frames);
    return { log, frames, seq };
  }

  append(frame: HostFrame, kept: HostFrame[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(frame) + '\n');
      this.onDisk += 1;
      // Rewrite when the file has grown to twice what is kept, so it
      // stays bounded without a rewrite per frame.
      if (this.onDisk > this.cap * 2) this.rewrite(kept);
    } catch (err) {
      dlog('host.framelog.append-failed', { path: this.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private rewrite(frames: HostFrame[]): void {
    const tmp = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, frames.map((f) => JSON.stringify(f)).join('\n') + (frames.length ? '\n' : ''));
    renameSync(tmp, this.path);
    this.onDisk = frames.length;
  }
}
