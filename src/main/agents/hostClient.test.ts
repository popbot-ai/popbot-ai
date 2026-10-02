import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostFrame } from '@shared/hostProtocol';

vi.mock('../diagLog', () => ({ dlog: () => undefined }));
const { readHostEvents } = await import('./hostClient');

let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** A host whose stream says hello, sends `frames`, then `then`. */
async function host(frames: HostFrame[], then: (res: ServerResponse) => void): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': hello\n\n');
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
    then(res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("following a host chat's event stream", () => {
  it('gives up on a stream that goes silent — a network change killed it — instead of waiting minutes', async () => {
    // Says one thing, then nothing: no pings, no close — what a dead
    // connection looks like from this end.
    const url = await host([{ seq: 1, kind: 'spawned', cwd: '/w' }], () => undefined);
    const seen: HostFrame[] = [];
    const started = Date.now();
    await expect(
      readHostEvents({ url, token: 't', name: 'Box' }, 'chat_x', 0, new AbortController().signal, (f) => seen.push(f), 300),
    ).rejects.toThrow(/no word from the host/);
    expect(seen.map((f) => f.seq)).toEqual([1]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('keeps a stream that only pings', async () => {
    const url = await host([], (res) => {
      const ping = setInterval(() => res.write(': ping\n\n'), 100);
      setTimeout(() => { clearInterval(ping); res.end(); }, 700);
    });
    // Ends because the host closed it, not because of silence.
    await expect(
      readHostEvents({ url, token: 't', name: 'Box' }, 'chat_x', 0, new AbortController().signal, () => undefined, 300),
    ).resolves.toBeUndefined();
  });

  it('ends quietly when the caller stops following', async () => {
    const url = await host([], () => undefined);
    const ctl = new AbortController();
    const reading = readHostEvents({ url, token: 't', name: 'Box' }, 'chat_x', 0, ctl.signal, () => undefined, 5_000);
    setTimeout(() => ctl.abort(), 100);
    await expect(reading).resolves.toBeUndefined();
  });
});
