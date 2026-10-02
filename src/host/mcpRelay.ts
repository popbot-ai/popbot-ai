/**
 * The host's stand-in for the desktop's popbot MCP server. Agents on the
 * host are pointed here (127.0.0.1, a random port, a per-launch secret
 * in the path, the chat id after it — the same shape as the desktop's
 * server); each request is handed to `relay`, which sends it up the
 * chat's event stream and resolves with the desktop's answer.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { HostMcpRequest, HostMcpResponse } from '@shared/hostProtocol';
import { dlog } from '../main/diagLog';

const PATH_RE = /^\/mcp\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/;
/** The headers the MCP transport reads; the rest stay on the host. */
const FORWARDED = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id'];
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type McpRelayFn = (
  chatId: string,
  request: HostMcpRequest,
  signal: AbortSignal,
) => Promise<Omit<HostMcpResponse, 'id'>>;

export interface McpRelayServer {
  urlFor(chatId: string): string;
  close(): Promise<void>;
}

export async function startMcpRelay(relay: McpRelayFn): Promise<McpRelayServer> {
  const secret = randomBytes(12).toString('base64url');

  const http: Server = createServer((req, res) => {
    const m = PATH_RE.exec(req.url ?? '');
    if (!m || m[1] !== secret) {
      res.writeHead(404).end();
      return;
    }
    const chatId = m[2];
    // Only POSTs carry calls. A GET would open a stream for messages the
    // server starts on its own — the popbot server sends none and would
    // hold it open forever — so it gets the spec's "no stream here".
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    // The agent hanging up (a stopped turn, its own tool timeout) ends
    // the wait, and the request drops out of the replay.
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());
    void readBody(req)
      .then((body) => {
        const headers: Record<string, string> = {};
        for (const name of FORWARDED) {
          const v = req.headers[name];
          if (typeof v === 'string') headers[name] = v;
        }
        return relay(chatId, { method: 'POST', headers, body }, ctl.signal);
      })
      .then((answer) => {
        if (res.writableEnded) return;
        res.writeHead(answer.status, answer.contentType ? { 'Content-Type': answer.contentType } : {});
        res.end(answer.body);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!ctl.signal.aborted) dlog('host.mcp.relay-failed', { chatId, error: message });
        if (res.writableEnded || res.headersSent) return void res.end();
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: `popbot relay: ${message}` }, id: null }));
      });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  dlog('host.mcp.relay-listening', { port });
  return {
    urlFor: (chatId) => `http://127.0.0.1:${port}/mcp/${secret}/${chatId}`,
    close: () => new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections?.(); }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
