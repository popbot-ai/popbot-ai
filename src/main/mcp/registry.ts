/**
 * The running popbot MCP server, if any, and the one question AgentHost
 * asks at spawn time: what URL does this chat get? Kept apart from
 * server.ts (which knows nothing about PopBot) and popbotTools.ts (which
 * knows everything, including AgentHost) so neither imports the other in
 * a cycle.
 */
import { app } from 'electron';
import { POPBOT_MCP_SETTINGS_KEY, popbotMcpEnabled, type PopbotMcpSettings } from '@shared/persistence';
import { dlog } from '../diagLog';
import { getSetting } from '../persistence/settings';
import { startPopbotMcpServer, type PopbotMcpServer, type PopbotToolHandlers } from './server';

let running: PopbotMcpServer | null = null;

export async function startPopbotMcp(handlers: PopbotToolHandlers): Promise<void> {
  if (running) return;
  try {
    running = await startPopbotMcpServer(handlers, { version: safeVersion() });
    dlog('mcp.popbot.started', { port: running.port });
  } catch (err) {
    dlog('mcp.popbot.start-failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function stopPopbotMcp(): Promise<void> {
  const server = running;
  running = null;
  if (server) await server.close().catch(() => undefined);
}

/** The chat's URL for the popbot server — null when the server isn't up
 *  or the user switched the tools off in Preferences ▸ Agents. */
export function popbotMcpUrlForChat(chatId: string): string | null {
  if (!running) return null;
  if (!popbotMcpEnabled(getSetting<PopbotMcpSettings>(POPBOT_MCP_SETTINGS_KEY))) return null;
  return running.urlFor(chatId);
}

function safeVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0';
  }
}
