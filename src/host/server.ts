/**
 * The host's HTTP face: bearer-token auth, JSON in and out, and a
 * server-sent event stream per chat. Node's http module only — a host
 * is one bundled file with no dependencies to install.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { PermissionDecision } from '@shared/agent';
import {
  HOST_PROTOCOL_VERSION,
  type HostApproveBody,
  type HostFrame,
  type HostInfo,
  type HostRules,
  type HostSendBody,
  type HostSpawnBody,
} from '@shared/hostProtocol';
import { dlog } from '../main/diagLog';
import type { HostConfig } from './config';
import { listBranches } from './git';
import { HostError, HostSessions } from './sessions';

/** Attachments ride inline as base64, so requests can be sizeable. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const SSE_PING_MS = 15_000;

export function createHostServer(opts: {
  config: HostConfig;
  version: string;
  sessions: HostSessions;
  cli: { claude: string | null; codex: string | null };
}): Server {
  const { config, sessions } = opts;

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const want = Buffer.from(config.token);
    const got = Buffer.from(given);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const readJson = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HostError(413, 'request too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try { resolve(JSON.parse(text)); } catch { reject(new HostError(400, 'bad JSON')); }
      });
      req.on('error', reject);
    });

  const streamEvents = (res: ServerResponse, chatId: string, after: number): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': hello\n\n');
    const write = (frame: HostFrame): void => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    let off: () => void;
    try {
      off = sessions.subscribe(chatId, after, write);
    } catch (err) {
      write({ seq: after, kind: 'dead' });
      res.end();
      return void err;
    }
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    res.on('close', () => { clearInterval(ping); off(); });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://host');
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1') return json(res, 404, { error: 'not found' });

    if (req.method === 'GET' && parts[1] === 'info' && parts.length === 2) {
      const info: HostInfo = {
        protocol: HOST_PROTOCOL_VERSION,
        name: config.name,
        version: opts.version,
        platform: process.platform,
        claude: { ok: !!opts.cli.claude, path: opts.cli.claude },
        codex: { ok: !!opts.cli.codex, path: opts.cli.codex },
        repos: config.repos,
        chats: sessions.list(),
      };
      return json(res, 200, info);
    }

    if (req.method === 'GET' && parts[1] === 'repos' && parts[3] === 'branches' && parts.length === 4) {
      const repo = config.repos.find((r) => r.id === decodeURIComponent(parts[2]));
      if (!repo) return json(res, 404, { error: `no repo ${parts[2]}` });
      return json(res, 200, { branches: await listBranches(repo.path) });
    }

    if (parts[1] === 'chats' && parts.length === 4) {
      const chatId = decodeURIComponent(parts[2]);
      const action = parts[3];
      if (req.method === 'GET' && action === 'events') {
        return streamEvents(res, chatId, Number(url.searchParams.get('after') ?? '0') || 0);
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const body = (await readJson(req)) as Record<string, unknown>;
      switch (action) {
        case 'spawn':
          return json(res, 200, await sessions.spawn(chatId, body as unknown as HostSpawnBody));
        case 'send':
          if (typeof body.text !== 'string') return json(res, 400, { error: 'text required' });
          await sessions.send(chatId, body as unknown as HostSendBody);
          return json(res, 200, { ok: true });
        case 'approve': {
          const b = body as unknown as HostApproveBody;
          if (typeof b.permissionId !== 'string' || typeof b.decision !== 'string') return json(res, 400, { error: 'permissionId and decision required' });
          sessions.approve(chatId, b.permissionId, b.decision as PermissionDecision);
          return json(res, 200, { ok: true });
        }
        case 'stop':
          sessions.stop(chatId);
          return json(res, 200, { ok: true });
        case 'compact':
          return json(res, 200, { ok: await sessions.compact(chatId) });
        case 'rules':
          sessions.setRules(chatId, body.rules as HostRules | undefined);
          return json(res, 200, { ok: true });
        case 'dispose':
          await sessions.dispose(chatId);
          return json(res, 200, { ok: true });
        default:
          return json(res, 404, { error: 'not found' });
      }
    }
    return json(res, 404, { error: 'not found' });
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HostError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      dlog('host.request.failed', { url: req.url, status, message });
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    });
  });
}
