/**
 * Bots: chats this host runs on its own. A bot is one chat — one
 * conversation, never cleared — that the host keeps alive and wakes
 * when one of its triggers fires (see `BotTrigger`). The host does the
 * watching itself, with no model involved, and posts what happened into
 * the chat; the bot's prompt says what to do about it. It hands each
 * piece of work to a sub-agent so its own context stays small.
 *
 * Nothing here needs a desktop. A desktop that is connected finds the
 * bot's chat (`botChatId`) and shows it like any host chat; one that
 * was away catches up on what the capped log still holds.
 *
 * Bots on this host can reach each other — and only each other —
 * through the bots MCP server (botMcp.ts). They never get the
 * desktop's popbot tools.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  botChatId,
  type BotTrigger,
  type CronTrigger,
  type GithubTrigger,
  type HostBot,
  type HostBotInfo,
  type HostBotInput,
  type HostRules,
  type BotWatchedPr,
} from '@shared/hostProtocol';
import { cronWakeText, githubWakeLine, githubWakeText } from '@shared/botTriggers';
import { ensureChatWorktree, removeChatWorktree } from '../main/git/worktrees';
import { dlog } from '../main/diagLog';
import { removeBot, upsertBot, type HostConfig } from './config';
import { cronMatches } from './cron';
import type { BotHooks, BotSpawn, HostSessions } from './sessions';

/** Frames of a bot's chat a returning desktop can catch up on. */
const BOT_LOG_CAP = 5_000;
/** A pull request that wakes its bot more often than this in a day is
 *  ping-ponging; it is left alone until the day rolls over. */
const MAX_WAKES_PER_PR_PER_DAY = 30;
/** A bot that messages another more often than this an hour is looping. */
const MAX_BOT_MESSAGES_PER_HOUR = 20;
/** After a turn ends, look again soon: whatever changed meanwhile was
 *  held back while the bot was busy. */
const AFTER_TURN_POLL_MS = 5_000;
const GH_TIMEOUT_MS = 60_000;

/** Nobody is there to answer: every tool is allowed, except the ones
 *  that only wait for a person. */
const BOT_RULES: HostRules = {
  chat: [],
  global: [
    { tool: 'AskUserQuestion', action: 'deny' },
    { tool: 'EnterPlanMode', action: 'deny' },
    { tool: 'ExitPlanMode', action: 'deny' },
    { tool: '*', action: 'allow' },
  ],
};

/** What a GitHub trigger last saw of a pull request. */
interface PrSeen {
  repo: string;
  title: string;
  url: string;
  author: string;
  head: string;
  ci: string;
  decision: string;
  mergeable: string;
  draft: boolean;
  /** Newest comment or review by anyone but the bot. */
  activity: string;
  /** When it woke the bot, for the daily cap. */
  wakes: number[];
}

interface BotState {
  sessionId: string | null;
  /** GitHub trigger id → PR number → what was seen. */
  github: Record<string, Record<string, PrSeen>>;
  /** Cron trigger id → the minute (epoch ms) it last fired. */
  cronFired: Record<string, number>;
  lastPollAt: number | null;
  lastError: string | null;
}

interface PrNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable: string | null;
  author: { login: string } | null;
  commits: { nodes: Array<{ commit: { oid: string; author: { user: { login: string } | null } | null; statusCheckRollup: { state: string } | null } }> };
  comments: { nodes: Array<{ author: { login: string } | null; createdAt: string }> };
  reviews: { nodes: Array<{ author: { login: string } | null; submittedAt: string | null; state: string }> };
}

const PR_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url isDraft reviewDecision mergeable
        author { login }
        commits(last: 1) { nodes { commit { oid author { user { login } } statusCheckRollup { state } } } }
        comments(last: 20) { nodes { author { login } createdAt } }
        reviews(last: 20) { nodes { author { login } submittedAt state } }
      }
    }
  }
}`;

interface Runtime {
  state: BotState;
  /** GitHub trigger id → its next look. */
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** One trigger at a time talks to the bot. */
  chain: Promise<unknown>;
  /** When this bot messaged other bots, for the hourly cap. */
  sent: number[];
  /** Bots that messaged it, and when: it may answer them. */
  heardFrom: Map<string, number>;
  /** Its config changed while its session ran: start a new session
   *  (resuming the conversation) at the next idle moment. */
  restartDue: boolean;
}

export class HostBots implements BotHooks {
  private readonly runtimes = new Map<string, Runtime>();
  private mcpUrlFor: ((botId: string) => string) | null = null;
  private cronTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: HostConfig,
    private readonly configPath: string,
    private readonly sessions: HostSessions,
  ) {}

  /** Where bots reach the bots MCP server (botMcp.ts). */
  useMcp(urlFor: (botId: string) => string): void {
    this.mcpUrlFor = urlFor;
  }

  /** Start every bot: its session, its watchers, the cron clock. */
  start(): void {
    for (const bot of this.config.bots) this.arm(bot, 2_000);
    this.scheduleCron();
  }

  stop(): void {
    for (const rt of this.runtimes.values()) for (const t of rt.timers.values()) clearTimeout(t);
    if (this.cronTimer) clearTimeout(this.cronTimer);
  }

  list(): HostBotInfo[] {
    return this.config.bots.map((bot) => this.info(bot));
  }

  bot(id: string): HostBot | null {
    return this.config.bots.find((b) => b.id === id) ?? null;
  }

  // ── Made, changed, killed ───────────────────────────────────────────

  /** Make a bot (`id` null) or change one. A changed prompt reaches the
   *  bot at its next session; triggers apply now. */
  save(id: string | null, input: HostBotInput): HostBotInfo {
    const bot = upsertBot(this.config, this.configPath, id, input);
    dlog('host.bot.saved', { bot: bot.id, created: !id, triggers: bot.triggers.length, peers: bot.peers.length });
    // Its orders (prompt, triggers, who it talks to) are read at spawn.
    if (id && this.sessions.get(botChatId(bot.id))) this.runtime(bot.id).restartDue = true;
    void this.serial(bot.id, () => this.restartIfDue(bot));
    this.arm(bot, 0);
    return this.info(bot);
  }

  /** Kill: the bot stops, its session ends, its checkout and state go,
   *  and it is gone from the config. */
  async kill(id: string): Promise<boolean> {
    const bot = this.bot(id);
    if (!bot) return false;
    const rt = this.runtimes.get(id);
    if (rt) for (const t of rt.timers.values()) clearTimeout(t);
    this.runtimes.delete(id);
    removeBot(this.config, this.configPath, id);
    await this.sessions.dispose(botChatId(id));
    const repo = this.config.repos.find((r) => r.id === bot.repoId);
    const checkout = join(this.dir(id), 'checkout');
    if (repo && existsSync(checkout)) {
      await removeChatWorktree({ repoPath: repo.path, worktreePath: checkout, discard: true }).catch((err: unknown) => {
        dlog('host.bot.checkout-remove-failed', { bot: id, error: err instanceof Error ? err.message : String(err) });
      });
    }
    rmSync(this.dir(id), { recursive: true, force: true });
    dlog('host.bot.killed', { bot: id });
    return true;
  }

  /** Run its triggers now. */
  wake(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.arm(bot, 0);
    return true;
  }

  /** Pause or resume: no trigger wakes a paused bot. Its chat stays,
   *  and a person (or a bot) can still talk to it. */
  setEnabled(id: string, enabled: boolean): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    upsertBot(this.config, this.configPath, id, { name: bot.name, enabled });
    dlog('host.bot.enabled', { bot: id, enabled });
    this.arm(bot, 0);
    return true;
  }

  /** One bot's message to another, delivered as a turn in the other's
   *  chat. Never waits for the answer — a reply, if one is wanted, comes
   *  back the same way — so two bots can never block on each other. */
  async message(fromId: string, toId: string, text: string): Promise<{ ok: true } | { error: string }> {
    const from = this.bot(fromId);
    if (!from) return { error: `no bot "${fromId}" on this host` };
    const rt = this.runtime(from.id);
    // It knows the bots on its list, and any that spoke to it. Every
    // other bot does not exist, as far as it can tell — the same answer
    // as a name nobody has.
    const known = (b: HostBot): boolean => onList(from, b) || (rt.heardFrom.get(b.id) ?? 0) > Date.now() - 86_400_000;
    // By id or by name, whichever it was given.
    const key = toId.trim().toLowerCase();
    const named = this.config.bots.find((b) => b.id.toLowerCase() === key || b.name.toLowerCase() === key) ?? null;
    if (named?.id === from.id) return { error: 'that is you' };
    const to = named && known(named) ? named : null;
    if (!to) return { error: `no bot "${toId}"` };
    const hourAgo = Date.now() - 3_600_000;
    rt.sent = rt.sent.filter((t) => t > hourAgo);
    if (rt.sent.length >= MAX_BOT_MESSAGES_PER_HOUR) {
      return { error: `you have sent ${rt.sent.length} messages to bots in the last hour, the limit — the bots are probably going round in circles` };
    }
    rt.sent.push(Date.now());
    const body =
      `Message from the bot "${from.name}" (id ${from.id}) on this machine — not from a person. ` +
      `It is not waiting: to answer, use message_bot with to "${from.id}".\n\n${text}`;
    try {
      this.runtime(to.id).heardFrom.set(from.id, Date.now());
      await this.deliver(to, body, { id: botChatId(from.id), name: from.name });
      dlog('host.bot.message', { from: from.id, to: to.id, len: text.length });
      return { ok: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A bot's answer to a chat's message, by the reply id that message
   *  carried. The host cannot reach a desktop, so the answer goes in the
   *  bot's log; the desktop that issued the id delivers it, once. A bot
   *  answers chats — it never names one, so it cannot start a
   *  conversation with one. */
  async replyToChat(botId: string, replyId: string, text: string): Promise<{ ok: true } | { error: string }> {
    const bot = this.bot(botId);
    if (!bot) return { error: `no bot "${botId}" on this host` };
    if (!/^r_[a-f0-9]{8,64}$/.test(replyId)) {
      return { error: `"${replyId}" is not a reply id; a chat's message to you gives one when it can be answered` };
    }
    const rt = this.runtime(bot.id);
    const hourAgo = Date.now() - 3_600_000;
    rt.sent = rt.sent.filter((t) => t > hourAgo);
    if (rt.sent.length >= MAX_BOT_MESSAGES_PER_HOUR) return { error: `you have sent ${rt.sent.length} messages in the last hour, the limit` };
    rt.sent.push(Date.now());
    await this.ensureLive(bot);
    this.sessions.reply(botChatId(bot.id), replyId, text);
    dlog('host.bot.reply', { bot: bot.id, replyId, len: text.length });
    return { ok: true };
  }

  // ── BotHooks ────────────────────────────────────────────────────────

  spawnFor(chatId: string): BotSpawn | null {
    const bot = this.config.bots.find((b) => botChatId(b.id) === chatId);
    if (!bot) return null;
    const rt = this.runtime(bot.id);
    return {
      cwd: () => this.checkout(bot),
      sessionId: rt.state.sessionId,
      claudeModel: bot.claudeModel,
      claudeReasoningEffort: bot.claudeReasoningEffort,
      env: this.env(bot),
      appendSystemPrompt: charter(bot, this.config.name),
      mcpServers: this.mcpUrlFor ? { bots: { type: 'http', url: this.mcpUrlFor(bot.id) } } : {},
      rules: BOT_RULES,
      logPath: join(this.dir(bot.id), 'events.jsonl'),
      logCap: BOT_LOG_CAP,
      onSessionId: (sessionId) => {
        if (rt.state.sessionId === sessionId) return;
        rt.state.sessionId = sessionId;
        this.saveState(bot.id);
      },
    };
  }

  idle(chatId: string): void {
    const bot = this.config.bots.find((b) => botChatId(b.id) === chatId);
    if (!bot) return;
    void this.serial(bot.id, () => this.restartIfDue(bot));
    this.arm(bot, AFTER_TURN_POLL_MS);
  }

  /** Start a new session with its current orders, resuming the same
   *  conversation — when its config changed and it is between turns. */
  private async restartIfDue(bot: HostBot): Promise<void> {
    const rt = this.runtime(bot.id);
    const chatId = botChatId(bot.id);
    if (!rt.restartDue || !this.sessions.isIdle(chatId)) return;
    rt.restartDue = false;
    await this.sessions.spawn(chatId, { agent: 'claude', rules: BOT_RULES });
    dlog('host.bot.restarted', { bot: bot.id });
  }

  /** The bots this one may know about: those on its list that are
   *  running on this host now. */
  peersOf(id: string): HostBotInfo[] {
    const bot = this.bot(id);
    if (!bot) return [];
    return this.config.bots.filter((b) => b.id !== bot.id && onList(bot, b)).map((b) => this.info(b));
  }

  // ── Triggers ────────────────────────────────────────────────────────

  /** (Re)start a bot's GitHub watchers, the first look after `delayMs`,
   *  and make sure its session is up. */
  private arm(bot: HostBot, delayMs: number): void {
    const rt = this.runtime(bot.id);
    for (const t of rt.timers.values()) clearTimeout(t);
    rt.timers.clear();
    // Forget what triggers no longer there had seen.
    const ids = new Set(bot.triggers.map((t) => t.id));
    for (const k of Object.keys(rt.state.github)) if (!ids.has(k)) delete rt.state.github[k];
    for (const k of Object.keys(rt.state.cronFired)) if (!ids.has(k)) delete rt.state.cronFired[k];
    void this.ensureLive(bot).catch((err: unknown) => this.fail(bot.id, err));
    for (const trigger of bot.triggers) {
      if (trigger.kind === 'github') this.scheduleGithub(bot.id, trigger.id, delayMs);
    }
  }

  private scheduleGithub(botId: string, triggerId: string, delayMs: number): void {
    const rt = this.runtime(botId);
    const prior = rt.timers.get(triggerId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      rt.timers.delete(triggerId);
      const bot = this.bot(botId);
      const trigger = bot?.triggers.find((t): t is GithubTrigger => t.id === triggerId && t.kind === 'github');
      if (!bot || !trigger) return;
      void this.serial(bot.id, () => this.pollGithub(bot, trigger))
        .then(() => this.clearError(bot.id))
        .catch((err: unknown) => this.fail(bot.id, err))
        .finally(() => {
          if (this.bot(botId)?.triggers.some((t) => t.id === triggerId)) this.scheduleGithub(botId, triggerId, trigger.pollSeconds * 1000);
        });
    }, delayMs);
    timer.unref?.();
    rt.timers.set(triggerId, timer);
  }

  /** Look at a GitHub trigger's pull requests; tell the bot about the
   *  ones that changed since it last heard. While it is mid-turn nothing
   *  is sent and nothing is marked seen — the next look, after the turn,
   *  finds the same changes and sends them then. */
  private async pollGithub(bot: HostBot, trigger: GithubTrigger): Promise<void> {
    if (!bot.enabled) return;
    await this.ensureLive(bot);
    if (!this.sessions.isIdle(botChatId(bot.id))) return;

    const rt = this.runtime(bot.id);
    const repo = trigger.repo ?? (await this.originSlug(bot));
    const q = `repo:${repo} is:pr is:open label:${trigger.labels.map((l) => JSON.stringify(l)).join(',')}`;
    const out = await this.gh(bot, ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `q=${q}`]);
    const nodes = ((JSON.parse(out) as { data?: { search?: { nodes?: PrNode[] } } }).data?.search?.nodes ?? [])
      .filter((n): n is PrNode => typeof n?.number === 'number');
    rt.state.lastPollAt = Date.now();

    const before = rt.state.github[trigger.id] ?? {};
    const me = (bot.githubLogin ?? '').toLowerCase();
    const dayAgo = Date.now() - 86_400_000;
    const lines: string[] = [];
    const next: Record<string, PrSeen> = {};
    for (const pr of nodes) {
      const key = String(pr.number);
      const was = before[key];
      const commit = pr.commits.nodes[0]?.commit;
      const others = [
        ...pr.comments.nodes.map((c) => ({ who: c.author?.login ?? '', at: c.createdAt })),
        ...pr.reviews.nodes.filter((r) => r.submittedAt).map((r) => ({ who: r.author?.login ?? '', at: r.submittedAt! })),
      ].filter((a) => a.who.toLowerCase() !== me);
      const seen: PrSeen = {
        repo,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login ?? '?',
        head: commit?.oid ?? '',
        ci: commit?.statusCheckRollup?.state ?? 'NONE',
        decision: pr.reviewDecision ?? 'NONE',
        mergeable: pr.mergeable ?? 'UNKNOWN',
        draft: pr.isDraft,
        activity: others.reduce((m, a) => (a.at > m ? a.at : m), ''),
        wakes: (was?.wakes ?? []).filter((t) => t > dayAgo),
      };
      const changes = describeChanges(was, seen, pr, others, me);
      if (changes.length > 0 && seen.wakes.length < MAX_WAKES_PER_PR_PER_DAY) {
        seen.wakes.push(Date.now());
        lines.push(githubWakeLine({ number: pr.number, title: pr.title, author: pr.author?.login ?? '?', draft: pr.isDraft, url: pr.url }, changes));
      } else if (changes.length > 0) {
        dlog('host.bot.wake-capped', { bot: bot.id, pr: pr.number, wakes: seen.wakes.length });
      }
      next[key] = seen;
    }
    if (lines.length > 0) {
      const gone = Object.keys(before).filter((k) => !next[k]);
      await this.deliver(bot, githubWakeText(repo, trigger, lines, gone), { id: 'github', name: 'GitHub' });
      dlog('host.bot.woke', { bot: bot.id, trigger: trigger.id, prs: lines.length });
    }
    rt.state.github[trigger.id] = next;
    this.saveState(bot.id);
  }

  /** One clock for every bot's schedules, ticking on the minute. */
  private scheduleCron(): void {
    const now = new Date();
    const ms = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50;
    this.cronTimer = setTimeout(() => {
      this.cronTimer = null;
      this.runCron(new Date());
      this.scheduleCron();
    }, ms);
    this.cronTimer.unref?.();
  }

  private runCron(at: Date): void {
    const minute = Math.floor(at.getTime() / 60_000) * 60_000;
    for (const bot of this.config.bots) {
      if (!bot.enabled) continue;
      for (const trigger of bot.triggers) {
        if (trigger.kind !== 'cron' || !cronMatches(trigger.schedule, at)) continue;
        const rt = this.runtime(bot.id);
        if (rt.state.cronFired[trigger.id] === minute) continue;
        rt.state.cronFired[trigger.id] = minute;
        this.saveState(bot.id);
        void this.serial(bot.id, () => this.fireCron(bot, trigger)).catch((err: unknown) => this.fail(bot.id, err));
      }
    }
  }

  private async fireCron(bot: HostBot, trigger: CronTrigger): Promise<void> {
    await this.deliver(bot, cronWakeText(trigger), { id: 'schedule', name: 'Schedule' });
    dlog('host.bot.cron', { bot: bot.id, trigger: trigger.id });
  }

  // ── Internals ───────────────────────────────────────────────────────

  private info(bot: HostBot): HostBotInfo {
    const rt = this.runtime(bot.id);
    const { githubToken, githubTokenEnv, ...rest } = bot;
    const chatId = botChatId(bot.id);
    const live = this.sessions.get(chatId);
    const working = !!live?.session.isAlive() && !this.sessions.isIdle(chatId);
    const watching = new Map<string, BotWatchedPr>();
    for (const prs of Object.values(rt.state.github)) {
      for (const [n, pr] of Object.entries(prs)) {
        watching.set(`${pr.repo}#${n}`, {
          repo: pr.repo ?? '',
          number: Number(n),
          title: pr.title ?? '',
          url: pr.url ?? '',
          author: pr.author ?? '',
          head: pr.head,
          ci: pr.ci,
          decision: pr.decision,
          mergeable: pr.mergeable,
          draft: pr.draft,
          lastWokeAt: pr.wakes.length ? pr.wakes[pr.wakes.length - 1] : null,
        });
      }
    }
    return {
      ...rest,
      chatId,
      hasToken: !!(githubToken || (githubTokenEnv && process.env[githubTokenEnv])),
      state: !bot.enabled ? 'paused' : working ? 'working' : rt.state.lastError ? 'error' : 'idle',
      lastPollAt: rt.state.lastPollAt,
      lastError: rt.state.lastError,
      watching: [...watching.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number),
    };
  }

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = { state: this.loadState(id), timers: new Map(), chain: Promise.resolve(), sent: [], heardFrom: new Map(), restartDue: false };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  private serial(id: string, fn: () => Promise<void>): Promise<void> {
    const rt = this.runtime(id);
    const run = rt.chain.then(fn);
    rt.chain = run.catch(() => undefined);
    return run;
  }

  private fail(id: string, err: unknown): void {
    if (!this.bot(id)) return;
    const rt = this.runtime(id);
    rt.state.lastError = err instanceof Error ? err.message : String(err);
    dlog('host.bot.failed', { bot: id, error: rt.state.lastError });
    this.saveState(id);
  }

  private clearError(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt?.state.lastError) {
      rt.state.lastError = null;
      this.saveState(id);
    }
  }

  private dir(id: string): string {
    return join(this.config.workspacesDir, 'bots', id);
  }

  private loadState(id: string): BotState {
    const empty: BotState = { sessionId: null, github: {}, cronFired: {}, lastPollAt: null, lastError: null };
    const path = join(this.dir(id), 'state.json');
    if (!existsSync(path)) return empty;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BotState>;
      return {
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
        github: raw.github && typeof raw.github === 'object' ? raw.github : {},
        cronFired: raw.cronFired && typeof raw.cronFired === 'object' ? raw.cronFired : {},
        lastPollAt: typeof raw.lastPollAt === 'number' ? raw.lastPollAt : null,
        lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      };
    } catch (err) {
      dlog('host.bot.state-unreadable', { bot: id, error: err instanceof Error ? err.message : String(err) });
      return empty;
    }
  }

  private saveState(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt || !this.bot(id)) return;
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'state.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(rt.state, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  /** The bot's session, started (resuming its conversation) if it is not. */
  private async ensureLive(bot: HostBot): Promise<void> {
    const chatId = botChatId(bot.id);
    if (this.sessions.get(chatId)?.session.isAlive()) return;
    await this.sessions.spawn(chatId, { agent: 'claude', rules: BOT_RULES });
  }

  private async deliver(bot: HostBot, text: string, from: { id: string; name: string }): Promise<void> {
    await this.ensureLive(bot);
    await this.sessions.prompt(botChatId(bot.id), text, from);
  }

  /** The bot's own worktree on its own branch — never a slot, so a bot
   *  never takes a checkout from the host's chats. A bot with no repo
   *  gets a plain folder. */
  private async checkout(bot: HostBot): Promise<string> {
    mkdirSync(join(this.dir(bot.id), 'gh'), { recursive: true });
    const path = join(this.dir(bot.id), 'checkout');
    if (!bot.repoId) {
      mkdirSync(path, { recursive: true });
      return path;
    }
    const repo = this.config.repos.find((r) => r.id === bot.repoId);
    if (!repo) throw new Error(`no repo "${bot.repoId}" on this host`);
    await ensureChatWorktree({ repoPath: repo.path, worktreePath: path, branch: `popbot-bot/${bot.id}`, baseBranch: repo.defaultBase || 'main' });
    return path;
  }

  private token(bot: HostBot): string | null {
    return bot.githubToken ?? (bot.githubTokenEnv ? process.env[bot.githubTokenEnv] ?? null : null);
  }

  /**
   * The bot acts as its own GitHub account, and as nobody else — fail
   * closed. Every process in its session (its sub-agents' too) gets:
   *
   *  - GH_TOKEN: `gh` uses it before any stored login.
   *  - GH_CONFIG_DIR: a folder of its own, so there is no stored login
   *    to fall back on — a bot with no token cannot act as whoever ran
   *    `gh auth login` on this machine.
   *  - git: the machine's credential helpers for github.com cleared (an
   *    empty value resets the list; Git Credential Manager would answer
   *    as its owner), then `gh auth git-credential`, which answers from
   *    GH_TOKEN.
   *  - the commit author and committer: its login and noreply address.
   */
  private env(bot: HostBot): Record<string, string> {
    const env: Record<string, string> = {
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GH_CONFIG_DIR: join(this.dir(bot.id), 'gh'),
    };
    const token = this.token(bot);
    if (token) env.GH_TOKEN = token;
    const config: Array<[string, string]> = [['credential.https://github.com.helper', '']];
    if (token) config.push(['credential.https://github.com.helper', '!gh auth git-credential']);
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    const name = bot.gitName ?? bot.githubLogin;
    const email = bot.gitEmail ?? (bot.githubLogin ? `${bot.githubLogin}@users.noreply.github.com` : null);
    if (name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name;
    if (email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email;
    return env;
  }

  private gh(bot: HostBot, args: string[]): Promise<string> {
    if (!this.token(bot)) {
      return Promise.reject(new Error(
        bot.githubTokenEnv && !bot.githubToken
          ? `${bot.githubTokenEnv} is not set on this host, so the bot has no GitHub account to act as`
          : 'the bot has no GitHub token, so it has no GitHub account to act as — add one in its settings',
      ));
    }
    mkdirSync(join(this.dir(bot.id), 'gh'), { recursive: true });
    return run('gh', args, { ...process.env, ...this.env(bot) }, GH_TIMEOUT_MS);
  }

  private async originSlug(bot: HostBot): Promise<string> {
    const repo = this.config.repos.find((r) => r.id === bot.repoId);
    if (!repo) throw new Error('a GitHub trigger with no repository needs the bot to have a repo');
    const url = (await run('git', ['-C', repo.path, 'remote', 'get-url', 'origin'], process.env, 15_000)).trim();
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    if (!m) throw new Error(`repo "${repo.id}"'s origin is not on GitHub (${url}); give the trigger a repository`);
    return `${m[1]}/${m[2]}`;
  }
}

/** Is `other` on `bot`'s list — by its id or its name? */
function onList(bot: HostBot, other: HostBot): boolean {
  const names = new Set(bot.peers.map((p) => p.toLowerCase()));
  return names.has(other.id.toLowerCase()) || names.has(other.name.toLowerCase());
}

/** What changed about a pull request since the bot last heard, in words. */
function describeChanges(
  before: PrSeen | undefined,
  now: PrSeen,
  pr: PrNode,
  others: Array<{ who: string; at: string }>,
  me: string,
): string[] {
  if (!before) return ['new to you'];
  const out: string[] = [];
  const author = pr.commits.nodes[0]?.commit.author?.user?.login?.toLowerCase() ?? '';
  // The head commit, not a timestamp: comments and label edits bump a
  // PR's updatedAt without anything to re-review. Its own push is not
  // news to it (the CI run that follows is). The old head goes along so
  // the bot can review just `old..new` — a force-push leaves it
  // unreachable, and then it reviews the whole change again.
  if (now.head !== before.head && !(me && author === me)) {
    out.push(`new commits — head ${now.head.slice(0, 7)}, was ${before.head.slice(0, 7)}`);
  }
  if (now.ci !== before.ci && now.ci !== 'PENDING' && now.ci !== 'EXPECTED') out.push(`CI ${now.ci.toLowerCase()}`);
  if (now.activity > before.activity) {
    const who = [...new Set(others.filter((a) => a.at > before.activity).map((a) => `@${a.who}`))];
    out.push(`new comments or reviews from ${who.join(', ')}`);
  }
  if (now.decision !== before.decision && now.decision !== 'NONE') out.push(`review decision ${now.decision.toLowerCase().replace(/_/g, ' ')}`);
  if (now.mergeable !== before.mergeable) {
    if (now.mergeable === 'CONFLICTING') out.push('has merge conflicts');
    else if (before.mergeable === 'CONFLICTING' && now.mergeable === 'MERGEABLE') out.push('conflicts resolved');
  }
  if (now.draft !== before.draft) out.push(now.draft ? 'back to draft' : 'ready for review');
  return out;
}

/** How a bot works — the same for every bot — followed by its prompt. */
function charter(bot: HostBot, hostName: string): string {
  const who = bot.githubLogin
    ? `You act on GitHub as @${bot.githubLogin}: \`gh\` and \`git push\` are signed in as that account.`
    : 'On GitHub you act as whatever account `gh` is signed in with on this machine.';
  const wakes = bot.triggers.map(describeTrigger);
  return [
    `You are "${bot.name}", a bot that PopBot runs unattended on the machine "${hostName}". ${who} ` +
      `No person is watching this conversation as it happens and nobody will answer a question: decide, act, and say what you did. ` +
      `A person may read this chat later or write to you in it; treat what they write as instructions.`,
    wakes.length
      ? `What wakes you:\n${wakes.map((w) => `- ${w}`).join('\n')}\nMessages from other bots arrive the same way, attributed to them.`
      : 'Nothing wakes you on its own: you act when a person or another bot writes to you.',
    `How you work: this conversation is never cleared, so keep it small. Hand each piece of work — each pull request — to a ` +
      `sub-agent (the Task tool) with everything it needs: what to work on, what changed, and your orders below. Keep only its summary. ` +
      `One at a time: sub-agents share your checkout. What you remember of a pull request is what you said about it here and what is on ` +
      `GitHub; read its history there when you need more. When a wake needs nothing from you, say so in one line.`,
    // Its list is not named here: list_bots is the only way it learns of
    // a bot, and it shows only the running ones it may message — so a
    // bot cannot tell one it may not message from one that never was.
    `Other bots: list_bots shows the bots you may message, and message_bot reaches them whenever you like. ` +
      `A bot that messages you, you may answer with message_bot. A message does not wait for an answer. ` +
      `People's PopBot chats may message you too. When one can be answered its message gives a reply id: answer it, once, with reply_to_chat. ` +
      `That is the only way to reach a chat — you cannot start a conversation with one.`,
    `Your orders:\n\n${bot.prompt.trim() || '(none yet — ask for them in your next reply)'}`,
  ].join('\n\n');
}

function describeTrigger(t: BotTrigger): string {
  if (t.kind === 'github') {
    return `"GitHub" messages: open pull requests in ${t.repo ?? 'your repository'} labeled ${t.labels.map((l) => `"${l}"`).join(' or ')} that ` +
      `are new to you, got new commits (the old and new head are given), finished CI, got comments or reviews, gained or lost conflicts, or left draft.`;
  }
  return `"Schedule" messages, at ${t.schedule} (cron, this machine's time).`;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const why = (stderr || '').trim().split('\n').slice(-3).join(' ') || err.message;
        reject(new Error(`${cmd} ${args[0]}: ${why}`));
        return;
      }
      resolve(stdout);
    });
  });
}
