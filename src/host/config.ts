/**
 * Host configuration: a JSON file (default `~/.popbot-host/config.json`)
 * the operator edits or `--init` writes, plus command-line overrides.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_GITHUB_POLL_SECONDS,
  MIN_GITHUB_POLL_SECONDS,
  type BotTrigger,
  type HostBot,
  type HostBotInput,
  type HostRepo,
} from '@shared/hostProtocol';
import { CLAUDE_MODELS, CLAUDE_REASONING_EFFORTS } from '@shared/persistence';
import { teamSpecProblems } from '@shared/botTeams';
import { cronProblem } from './cron';

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
  /** Chats this host runs on its own, woken by triggers. See bots.ts. */
  bots: HostBot[];
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
    bots: [],
  };
}

export function loadConfig(path: string): HostConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostConfig>;
  const base = defaultConfig();
  const repos = Array.isArray(raw.repos)
    ? raw.repos
        .filter((r): r is HostRepo => !!r && typeof r.id === 'string' && typeof r.path === 'string')
        .map((r) => normalizeRepo(r as Partial<HostRepo> & { id: string; path: string }))
    : [];
  return {
    bind: typeof raw.bind === 'string' && raw.bind ? raw.bind : base.bind,
    port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : base.port,
    token: typeof raw.token === 'string' && raw.token ? raw.token : base.token,
    name: typeof raw.name === 'string' && raw.name ? raw.name : base.name,
    workspacesDir: typeof raw.workspacesDir === 'string' && raw.workspacesDir ? resolve(raw.workspacesDir) : base.workspacesDir,
    repos,
    bots: Array.isArray(raw.bots)
      ? raw.bots
          .filter((b): b is HostBot => !!b && typeof b.id === 'string' && BOT_ID_RE.test(b.id))
          .map((b) => normalizeBot(b))
      : [],
  };
}

const BOT_ID_RE = /^[A-Za-z0-9_-]+$/;
/** A bot's picture rides in the config and in every bot listing, so it
 *  is kept small: the form shrinks it to a thumbnail before it is sent. */
const AVATAR_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR_CHARS = 256 * 1024;

export function normalizeBot(b: Partial<HostBot> & { id: string }): HostBot {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    id: b.id,
    name: str(b.name) ?? b.id,
    prompt: typeof b.prompt === 'string' ? b.prompt : '',
    repoId: str(b.repoId),
    triggers: Array.isArray(b.triggers) ? b.triggers.map(normalizeTrigger).filter((t): t is BotTrigger => !!t) : [],
    peers: Array.isArray(b.peers)
      ? [...new Set(b.peers.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter((p) => p && p !== b.id))]
      : [],
    githubLogin: str(b.githubLogin)?.replace(/^@/, '') ?? null,
    githubToken: str(b.githubToken),
    githubTokenEnv: str(b.githubTokenEnv),
    gitName: str(b.gitName),
    email: str(b.email),
    avatar: typeof b.avatar === 'string' && AVATAR_RE.test(b.avatar) && b.avatar.length <= MAX_AVATAR_CHARS ? b.avatar : null,
    claudeModel: (CLAUDE_MODELS as readonly string[]).includes(b.claudeModel as string) ? b.claudeModel! : null,
    claudeReasoningEffort: (CLAUDE_REASONING_EFFORTS as readonly string[]).includes(b.claudeReasoningEffort as string) ? b.claudeReasoningEffort! : null,
    enabled: b.enabled !== false,
  };
}

function normalizeTrigger(t: unknown, i: number): BotTrigger | null {
  if (!t || typeof t !== 'object') return null;
  const raw = t as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `t${i + 1}`;
  if (raw.kind === 'github') {
    const poll = typeof raw.pollSeconds === 'number' ? Math.floor(raw.pollSeconds) : DEFAULT_GITHUB_POLL_SECONDS;
    return {
      id,
      kind: 'github',
      repo: typeof raw.repo === 'string' && raw.repo.trim()
        ? raw.repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/(\.git)?\/*$/, '')
        : null,
      labels: Array.isArray(raw.labels) ? raw.labels.map((l) => String(l).trim()).filter(Boolean) : [],
      // Absent in an older config: no one, until it is set.
      team: typeof raw.team === 'string' ? raw.team.trim() : '',
      pollSeconds: Math.max(MIN_GITHUB_POLL_SECONDS, poll || DEFAULT_GITHUB_POLL_SECONDS),
    };
  }
  if (raw.kind === 'cron') {
    return {
      id,
      kind: 'cron',
      schedule: typeof raw.schedule === 'string' ? raw.schedule.trim() : '',
      message: typeof raw.message === 'string' ? raw.message : '',
    };
  }
  return null;
}

/** An id for a new bot from its name: lower-case, dashes, unique here. */
function botIdFor(config: HostConfig, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot';
  let id = base;
  for (let n = 2; config.bots.some((b) => b.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Make a bot (`id` null) or change one, and rewrite the file. A token
 *  left out keeps the stored one; an empty one clears it. */
export function upsertBot(config: HostConfig, configPath: string, id: string | null, input: HostBotInput): HostBot {
  const existing = id ? config.bots.find((b) => b.id === id) : undefined;
  if (id && !existing) throw new Error(`no bot "${id}" on this host`);
  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('a bot needs a name');
  const next = normalizeBot({
    ...existing,
    ...input,
    githubToken: input.githubToken === undefined ? existing?.githubToken ?? null : input.githubToken,
    name,
    id: existing?.id ?? botIdFor(config, name),
  });
  if (next.repoId && !config.repos.some((r) => r.id === next.repoId)) throw new Error(`no repo "${next.repoId}" on this host`);
  if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw new Error(`"${next.email}" is not an email address`);
  if (typeof input.avatar === 'string' && input.avatar && !next.avatar) {
    throw new Error(`the picture must be a PNG, JPEG, WebP or GIF of at most ${Math.round(MAX_AVATAR_CHARS / 1024)} KB`);
  }
  for (const t of next.triggers) {
    if (t.kind === 'github' && t.labels.length === 0) throw new Error('a GitHub trigger needs at least one label');
    if (t.kind === 'github' && !t.repo && !next.repoId) throw new Error('a GitHub trigger needs a repository (owner/name), or give the bot a repo');
    if (t.kind === 'github') {
      const bad = teamSpecProblems(t.team);
      if (bad.length) throw new Error(`"${bad.join('", "')}" is not a team: use a team name, org/team, org/* or *`);
    }
    if (t.kind === 'cron') {
      const why = cronProblem(t.schedule);
      if (why) throw new Error(`schedule "${t.schedule}": ${why}`);
    }
  }
  if (existing) Object.assign(existing, next);
  else config.bots.push(next);
  writeConfig(configPath, config);
  return next;
}

export function removeBot(config: HostConfig, configPath: string, id: string): boolean {
  const at = config.bots.findIndex((b) => b.id === id);
  if (at < 0) return false;
  config.bots.splice(at, 1);
  writeConfig(configPath, config);
  return true;
}

/** Slot pool defaults match a fresh desktop repository. */
export const DEFAULT_SLOT_COUNT = 4;

export function normalizeRepo(r: Partial<HostRepo> & { id: string; path: string }): HostRepo {
  const slotCount = typeof r.slotCount === 'number' && r.slotCount >= 0 ? Math.floor(r.slotCount) : DEFAULT_SLOT_COUNT;
  return {
    id: r.id,
    path: resolve(r.path),
    defaultBase: r.defaultBase || 'main',
    slotPrefix: (r.slotPrefix || '').trim() || r.id,
    slotCount,
    mode: r.mode === 'ephemeral' ? 'ephemeral' : 'slots',
  };
}

/** Add or change a repository in the running config and rewrite the
 *  file. `id` is the key; other fields keep their current value when
 *  absent. Returns the normalized record. */
export function upsertRepo(config: HostConfig, configPath: string, patch: Partial<HostRepo> & { id: string }): HostRepo {
  const id = patch.id.trim();
  if (!id || /[\\/\s]/.test(id)) throw new Error('a repo id is a short name without spaces or slashes');
  const existing = config.repos.find((r) => r.id === id);
  const path = (patch.path ?? existing?.path ?? '').trim();
  if (!path) throw new Error('a repo needs a path on this host');
  const next = normalizeRepo({
    id,
    path,
    defaultBase: patch.defaultBase ?? existing?.defaultBase,
    slotPrefix: patch.slotPrefix ?? existing?.slotPrefix,
    slotCount: patch.slotCount ?? existing?.slotCount,
    mode: patch.mode ?? existing?.mode,
  });
  if (existing) Object.assign(existing, next);
  else config.repos.push(next);
  writeConfig(configPath, config);
  return next;
}

export function removeRepo(config: HostConfig, configPath: string, id: string): boolean {
  const at = config.repos.findIndex((r) => r.id === id);
  if (at < 0) return false;
  config.repos.splice(at, 1);
  writeConfig(configPath, config);
  return true;
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
    if (key === 'repo' || key === 'slots') {
      const list = Array.isArray(out[key]) ? (out[key] as string[]) : [];
      if (typeof value === 'string') list.push(value);
      out[key] = list;
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
      else config.repos.push(normalizeRepo({ id, path: p }));
    }
  }
  // `--slots id=N` sizes a repo's pool; `--slots id=ephemeral` switches
  // it to a worktree per chat.
  if (Array.isArray(args.slots) || typeof args.slots === 'string') {
    for (const spec of Array.isArray(args.slots) ? args.slots : [args.slots]) {
      const eq = spec.indexOf('=');
      if (eq <= 0) continue;
      const repo = config.repos.find((r) => r.id === spec.slice(0, eq));
      if (!repo) continue;
      const value = spec.slice(eq + 1).trim();
      if (value === 'ephemeral') repo.mode = 'ephemeral';
      else {
        repo.mode = 'slots';
        repo.slotCount = Math.max(0, Number(value) || 0);
      }
    }
  }
  if (created || args.init === true || Array.isArray(args.repo) || Array.isArray(args.slots)) writeConfig(path, config);
  return { config, path, created };
}
