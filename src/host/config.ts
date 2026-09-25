/**
 * Host configuration: a JSON file (default `~/.popbot-host/config.json`)
 * the operator edits or `--init` writes, plus command-line overrides.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { HostRepo } from '@shared/hostProtocol';

export interface HostConfig {
  /** Address to bind. Localhost by default: reach it over an SSH tunnel. */
  bind: string;
  port: number;
  /** Bearer token every request must carry. */
  token: string;
  /** Shown to the desktop; defaults to the machine's hostname. */
  name: string;
  /** Where per-chat worktrees and attachments go. */
  workspacesDir: string;
  repos: HostRepo[];
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.popbot-host', 'config.json');

export function defaultConfig(): HostConfig {
  return {
    bind: '127.0.0.1',
    port: 7677,
    token: randomBytes(24).toString('base64url'),
    name: require('node:os').hostname(),
    workspacesDir: join(homedir(), '.popbot-host', 'workspaces'),
    repos: [],
  };
}

export function loadConfig(path: string): HostConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostConfig>;
  const base = defaultConfig();
  const repos = Array.isArray(raw.repos)
    ? raw.repos
        .filter((r): r is HostRepo => !!r && typeof r.id === 'string' && typeof r.path === 'string')
        .map((r) => ({ id: r.id, path: resolve(r.path), defaultBase: r.defaultBase || 'main' }))
    : [];
  return {
    bind: typeof raw.bind === 'string' && raw.bind ? raw.bind : base.bind,
    port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : base.port,
    token: typeof raw.token === 'string' && raw.token ? raw.token : base.token,
    name: typeof raw.name === 'string' && raw.name ? raw.name : base.name,
    workspacesDir: typeof raw.workspacesDir === 'string' && raw.workspacesDir ? resolve(raw.workspacesDir) : base.workspacesDir,
    repos,
  };
}

export function writeConfig(path: string, config: HostConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/** `--key value` and `--flag` pairs, plus repeated `--repo id=path`. */
export function parseArgs(argv: string[]): Record<string, string | string[] | true> {
  const out: Record<string, string | string[] | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i += 1, next) : true;
    if (key === 'repo') {
      const list = Array.isArray(out.repo) ? out.repo : [];
      if (typeof value === 'string') list.push(value);
      out.repo = list;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Resolve the effective config: the file (created on --init), then flags. */
export function resolveConfig(argv: string[]): { config: HostConfig; path: string; created: boolean } {
  const args = parseArgs(argv);
  const path = typeof args.config === 'string' ? resolve(args.config) : DEFAULT_CONFIG_PATH;
  let created = false;
  let config: HostConfig;
  if (existsSync(path)) {
    config = loadConfig(path);
  } else {
    config = defaultConfig();
    created = true;
  }
  if (typeof args.port === 'string') config.port = Number(args.port) || config.port;
  if (typeof args.bind === 'string') config.bind = args.bind;
  if (typeof args.token === 'string') config.token = args.token;
  if (typeof args.name === 'string') config.name = args.name;
  if (typeof args.workspaces === 'string') config.workspacesDir = resolve(args.workspaces);
  if (Array.isArray(args.repo)) {
    for (const spec of args.repo) {
      const eq = spec.indexOf('=');
      const id = eq > 0 ? spec.slice(0, eq) : require('node:path').basename(spec);
      const p = resolve(eq > 0 ? spec.slice(eq + 1) : spec);
      const existing = config.repos.find((r) => r.id === id);
      if (existing) existing.path = p;
      else config.repos.push({ id, path: p, defaultBase: 'main' });
    }
  }
  if (created || args.init === true || Array.isArray(args.repo)) writeConfig(path, config);
  return { config, path, created };
}
