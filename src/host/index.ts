/**
 * popbot-host — run PopBot chats on this box for a desktop elsewhere.
 *
 *   popbot-host --init [--repo id=/path ...]   write ~/.popbot-host/config.json
 *   popbot-host [--config path] [--port n] [--bind addr] [--token t]
 *
 * The desktop keeps every transcript, search index and setting; this
 * process only runs the `claude` / `codex` CLIs it finds on PATH, in
 * checkouts listed in its config, and streams what they do.
 */
import { resolveCliPath } from '../main/agents/resolveCli';
import { dlog } from '../main/diagLog';
import { resolveConfig } from './config';
import { startBotMcp } from './botMcp';
import { HostBots } from './bots';
import { startMcpRelay } from './mcpRelay';
import { createHostServer } from './server';
import { HostSessions } from './sessions';
import { HostWorkspaces } from './workspaces';

declare const __POPBOT_HOST_VERSION__: string | undefined;
const VERSION = typeof __POPBOT_HOST_VERSION__ === 'string' ? __POPBOT_HOST_VERSION__ : 'dev';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'popbot-host [--init] [--config path] [--port n] [--bind addr] [--token t] [--name n] [--workspaces dir] [--repo id=/path]... [--slots id=N|ephemeral]...\n',
    );
    return;
  }
  const { config, path, created } = resolveConfig(argv);
  if (created) process.stdout.write(`Wrote ${path}\n`);
  if (argv.includes('--init')) {
    process.stdout.write(`Token: ${config.token}\nRepos: ${config.repos.map((r) => `${r.id}=${r.path}`).join(', ') || '(none; add with --repo id=/path)'}\n`);
    return;
  }
  const cli = {
    claude: await resolveCliPath('claude').catch(() => null),
    codex: await resolveCliPath('codex').catch(() => null),
  };
  const workspaces = new HostWorkspaces(config);
  workspaces.load();
  const sessions = new HostSessions(config, cli, workspaces);
  const mcpRelay = await startMcpRelay((chatId, request, signal) => sessions.relayMcp(chatId, request, signal));
  sessions.useMcpRelay(mcpRelay.urlFor);
  // Bots run whether or not a desktop is connected (bots.ts).
  const bots = new HostBots(config, path, sessions);
  sessions.useBots(bots);
  const botMcp = await startBotMcp(bots, VERSION);
  bots.useMcp(botMcp.urlFor);
  const server = createHostServer({ config, version: VERSION, configPath: path, sessions, workspaces, bots, cli });
  server.listen(config.port, config.bind, () => {
    process.stdout.write(
      `popbot-host ${VERSION} listening on http://${config.bind}:${config.port} as "${config.name}"\n` +
      // A first start made the token: say it once so `docker logs` (or
      // the terminal) has what PopBot needs.
      (created ? `  token:  ${config.token}\n` : '') +
      `  claude: ${cli.claude ?? 'not found'}\n  codex:  ${cli.codex ?? 'not found'}\n` +
      `  repos:  ${config.repos.map((r) => `${r.id}=${r.path} (${r.mode === 'ephemeral' ? 'ephemeral' : `${r.slotCount} slots as ${r.slotPrefix}-N`})`).join(', ') || '(none)'}\n` +
      `  bots:   ${config.bots.map((b) => `${b.id}${b.enabled ? '' : ' (paused)'}`).join(', ') || '(none)'}\n` +
      `  config: ${path}\n`,
    );
    dlog('host.listening', { bind: config.bind, port: config.port, repos: config.repos.length, bots: config.bots.length });
    bots.start();
  });
  const shutdown = async (): Promise<void> => {
    server.close();
    bots.stop();
    await sessions.disposeAll();
    await mcpRelay.close();
    await botMcp.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// A crash says why before the process goes: the service layer restarts
// it (scripts/install-host-service.ps1), and the log is the only place
// the reason survives.
process.on('uncaughtException', (err) => {
  dlog('host.crash', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.stderr.write(`popbot-host: crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
// A promise nobody awaited failing is logged, not fatal: one bot's bad
// turn must not take every chat on the host down with it.
process.on('unhandledRejection', (reason) => {
  dlog('host.unhandled-rejection', { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});

main().catch((err) => {
  process.stderr.write(`popbot-host: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
