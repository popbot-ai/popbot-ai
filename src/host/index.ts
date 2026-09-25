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
  const server = createHostServer({ config, version: VERSION, configPath: path, sessions, workspaces, cli });
  server.listen(config.port, config.bind, () => {
    process.stdout.write(
      `popbot-host ${VERSION} listening on http://${config.bind}:${config.port} as "${config.name}"\n` +
      `  claude: ${cli.claude ?? 'not found'}\n  codex:  ${cli.codex ?? 'not found'}\n` +
      `  repos:  ${config.repos.map((r) => `${r.id}=${r.path} (${r.mode === 'ephemeral' ? 'ephemeral' : `${r.slotCount} slots as ${r.slotPrefix}-N`})`).join(', ') || '(none)'}\n` +
      `  config: ${path}\n`,
    );
    dlog('host.listening', { bind: config.bind, port: config.port, repos: config.repos.length });
  });
  const shutdown = async (): Promise<void> => {
    server.close();
    await sessions.disposeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`popbot-host: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
