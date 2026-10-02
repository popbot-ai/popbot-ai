import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostFrame } from '@shared/hostProtocol';
import { FrameLog } from './frameLog';

const frame = (seq: number): HostFrame => ({ seq, kind: 'spawned', cwd: `/w/${seq}` });

describe("a bot chat's event log on disk", () => {
  it('continues the numbering after a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'framelog-')), 'events.jsonl');
    const first = FrameLog.open(path, 10);
    expect(first.seq).toBe(0);
    const kept: HostFrame[] = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      kept.push(frame(seq));
      first.log.append(frame(seq), kept);
    }
    const again = FrameLog.open(path, 10);
    expect(again.seq).toBe(3);
    expect(again.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('keeps only the newest frames, on disk too', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'framelog-')), 'events.jsonl');
    const { log } = FrameLog.open(path, 5);
    let kept: HostFrame[] = [];
    for (let seq = 1; seq <= 40; seq += 1) {
      kept = [...kept, frame(seq)].slice(-5);
      log.append(frame(seq), kept);
    }
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    const reopened = FrameLog.open(path, 5);
    expect(reopened.seq).toBe(40);
    expect(reopened.frames.map((f) => f.seq)).toEqual([36, 37, 38, 39, 40]);
  });

  it('skips a line torn by a crash', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'framelog-')), 'events.jsonl');
    writeFileSync(path, `${JSON.stringify(frame(1))}\n${JSON.stringify(frame(2))}\n{"seq":3,"ki`);
    const { frames, seq } = FrameLog.open(path, 10);
    expect(seq).toBe(2);
    expect(frames).toHaveLength(2);
  });
});
