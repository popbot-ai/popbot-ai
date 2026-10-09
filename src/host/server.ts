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
  type HostBotInput,
  type HostChatMeta,
  type HostPackBody,
  type HostUnpackBody,
  type HostFrame,
  type HostInfo,
  type HostMcpResponse,
  type HostRepo,
  type HostRules,
  type HostSendBody,
  type HostSpawnBody,
  type HostWorkspaceRequest,
} from '@shared/hostProtocol';
import { dlog } from '../main/diagLog';
import type { HostBots } from './bots';
import { removeRepo, upsertRepo, type HostConfig } from './config';
import { listBranches } from './git';
import { FileOpError, abortPart, commitPart, readFileFrom, statFile, writePartFrom } from '../main/transfer/fileOps';
import { applyWorkChanges, packWork, unpackBranch } from '../main/git/moveWork';
import { HostError, HostSessions } from './sessions';
import { HostWorkspaceError, type HostWorkspaces } from './workspaces';

/** Attachments ride inline as base64, so requests can be sizeable. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const SSE_PING_MS = 15_000;

export function createHostServer(opts: {
  config: HostConfig;
  version: string;
  /** Where the config lives, for edits from the desktop. */
  configPath: string;
  sessions: HostSessions;
  workspaces: HostWorkspaces;
  bots: HostBots;
  cli: { claude: string | null; codex: string | null };
}): Server {
  const { config, sessions, workspaces, bots } = opts;

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
        bots: bots.list(),
      };
      return json(res, 200, info);
    }

    // A file transfer to or from this machine (src/main/transfer/). Reads
    // and writes stream: a file of any size passes through without being
    // held in memory.
    if (parts[1] === 'files' && parts.length === 3) {
      const action = parts[2];
      const path = url.searchParams.get('path') ?? '';
      const offset = Number(url.searchParams.get('offset') ?? '0');
      try {
        if (req.method === 'GET' && action === 'stat') {
          return json(res, 200, await statFile(path, { hash: url.searchParams.get('hash') === '1' }));
        }
        if (req.method === 'GET' && action === 'read') {
          const { stream, size } = await readFileFrom(path, offset);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(size - offset),
            'X-File-Size': String(size),
          });
          res.on('close', () => stream.destroy());
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
        if (req.method === 'PUT' && action === 'write') {
          return json(res, 200, await writePartFrom(path, offset, req));
        }
        if (req.method === 'POST' && action === 'commit') {
          const b = (await readJson(req)) as { path?: unknown; size?: unknown; sha256?: unknown; overwrite?: unknown };
          if (typeof b.path !== 'string' || typeof b.size !== 'number' || typeof b.sha256 !== 'string') {
            return json(res, 400, { error: 'path, size and sha256 required' });
          }
          return json(res, 200, await commitPart(b.path, { size: b.size, sha256: b.sha256, overwrite: b.overwrite === true }));
        }
        if (req.method === 'POST' && action === 'abort') {
          const b = (await readJson(req)) as { path?: unknown };
          if (typeof b.path !== 'string') return json(res, 400, { error: 'path required' });
          await abortPart(b.path);
          return json(res, 200, { ok: true });
        }
      } catch (err) {
        if (err instanceof FileOpError) return json(res, err.status, { error: err.message });
        throw err;
      }
      return json(res, 404, { error: 'not found' });
    }

    if (parts[1] === 'bots') {
      if (req.method === 'GET' && parts.length === 2) return json(res, 200, { bots: bots.list() });
      const asInput = async (): Promise<HostBotInput> => {
        const body = (await readJson(req)) as HostBotInput;
        if (!body || typeof body !== 'object' || typeof body.name !== 'string') throw new HostError(400, 'a bot needs a name');
        return body;
      };
      const saved = (fn: () => unknown): unknown => {
        try {
          return fn();
        } catch (err) {
          throw new HostError(400, err instanceof Error ? err.message : String(err));
        }
      };
      if (req.method === 'POST' && parts.length === 2) {
        const input = await asInput();
        return json(res, 200, saved(() => bots.save(null, input)));
      }
      const id = parts[2] ? decodeURIComponent(parts[2]) : '';
      if (!bots.bot(id)) return json(res, 404, { error: `no bot "${id}" on this host` });
      if (req.method === 'PUT' && parts.length === 3) {
        const input = await asInput();
        return json(res, 200, saved(() => bots.save(id, input)));
      }
      if (req.method === 'DELETE' && parts.length === 3) return json(res, 200, { ok: await bots.kill(id) });
      if (req.method === 'POST' && parts.length === 4) {
        if (parts[3] === 'wake') return json(res, 200, { ok: bots.wake(id) });
        if (parts[3] === 'pause') return json(res, 200, { ok: bots.setEnabled(id, false) });
        if (parts[3] === 'resume') return json(res, 200, { ok: bots.setEnabled(id, true) });
        if (parts[3] === 'reset') return json(res, 200, { ok: await bots.reset(id) });
      }
      return json(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET' && parts[1] === 'repos' && parts[3] === 'branches' && parts.length === 4) {
      const repo = config.repos.find((r) => r.id === decodeURIComponent(parts[2]));
      if (!repo) return json(res, 404, { error: `no repo ${parts[2]}` });
      return json(res, 200, { branches: await listBranches(repo.path) });
    }

    if (req.method === 'GET' && parts[1] === 'repos' && parts[3] === 'slots' && parts.length === 4) {
      return json(res, 200, workspaces.list(decodeURIComponent(parts[2])));
    }

    if (parts[1] === 'repos' && parts.length === 3 && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = decodeURIComponent(parts[2]);
      if (req.method === 'DELETE') {
        return json(res, removeRepo(config, opts.configPath, id) ? 200 : 404, { ok: true });
      }
      const body = (await readJson(req)) as Partial<HostRepo>;
      try {
        return json(res, 200, upsertRepo(config, opts.configPath, { ...body, id }));
      } catch (err) {
        throw new HostError(400, err instanceof Error ? err.message : String(err));
      }
    }

    if (parts[1] === 'chats' && parts.length === 4) {
      const chatId = decodeURIComponent(parts[2]);
      const action = parts[3];
      if (req.method === 'GET' && action === 'events') {
        return streamEvents(res, chatId, Number(url.searchParams.get('after') ?? '0') || 0);
      }
      if (req.method === 'PUT' && action === 'meta') {
        // Renamed, closed, reopened, or gone from this host — for the
        // host's own popbot tools (localPopbot.ts).
        const b = (await readJson(req)) as HostChatMeta;
        sessions.setMeta(chatId, {
          ...(typeof b.name === 'string' ? { name: b.name } : {}),
          ...(typeof b.open === 'boolean' ? { open: b.open } : {}),
          ...(b.gone === true ? { gone: true } : {}),
        });
        return json(res, 200, { ok: true });
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
        case 'mcp-response': {
          const b = body as unknown as HostMcpResponse;
          if (typeof b.id !== 'string' || typeof b.status !== 'number' || typeof b.body !== 'string') {
            return json(res, 400, { error: 'id, status and body required' });
          }
          return json(res, 200, { ok: sessions.answerMcp(chatId, b) });
        }
        case 'dispose':
          await sessions.dispose(chatId);
          return json(res, 200, { ok: true });
        case 'workspace':
          return json(res, 200, await workspaces.ensure(chatId, body as unknown as HostWorkspaceRequest));
        case 'pack': {
          // A chat moving away: its work, packed. The session goes first so
          // nothing changes the checkout while it is read — unless the chat
          // is only being forked, and stays (it is idle: forks wait for that).
          const b = body as HostPackBody;
          if (b.keepSession !== true) await sessions.dispose(chatId);
          const held = workspaces.held(chatId);
          const heldRepo = workspaces.heldRepo(chatId);
          try {
            if (held?.branch && heldRepo) {
              return json(res, 200, { work: await packWork(held.cwd, held.branch, { withChanges: true }) });
            }
            const repo = config.repos.find((r) => r.id === b.repoId);
            if (repo && b.branch) return json(res, 200, { work: await packWork(repo.path, b.branch, { withChanges: false }) });
          } catch (err) {
            throw new HostError(409, err instanceof Error ? err.message : String(err));
          }
          return json(res, 200, { work: null });
        }
        case 'unpack': {
          // A chat moving here: its branch put in place, a checkout made,
          // its uncommitted changes laid on top. Undone if any step fails.
          const b = body as unknown as HostUnpackBody;
          if (!b.workspace || typeof b.workspace !== 'object') return json(res, 400, { error: 'workspace required' });
          const repo = config.repos.find((r) => r.id === b.workspace.repoId);
          if (b.work) {
            if (!repo) return json(res, 404, { error: `no repo "${b.workspace.repoId ?? ''}" on this host` });
            try {
              await unpackBranch(repo.path, b.work);
            } catch (err) {
              throw new HostError(409, err instanceof Error ? err.message : String(err));
            }
          }
          const ws = await workspaces.ensure(chatId, b.workspace);
          if (b.work?.patchBase64) {
            try {
              await applyWorkChanges(ws.cwd, b.work);
            } catch (err) {
              await workspaces.release(chatId, false).catch(() => undefined);
              throw new HostError(409, err instanceof Error ? err.message : String(err));
            }
          }
          return json(res, 200, ws);
        }
        case 'release':
          // A process still running in the worktree would fight the park.
          await sessions.dispose(chatId);
          return json(res, 200, await workspaces.release(chatId, body.stash === true, { moved: body.moved === true }));
        default:
          return json(res, 404, { error: 'not found' });
      }
    }
    return json(res, 404, { error: 'not found' });
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HostError ? err.status : err instanceof HostWorkspaceError ? 409 : 500;
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof HostWorkspaceError ? err.code : undefined;
      dlog('host.request.failed', { url: req.url, status, message, code });
      if (!res.headersSent) json(res, status, { error: message, ...(code ? { code } : {}) });
      else res.end();
    });
  });
}
