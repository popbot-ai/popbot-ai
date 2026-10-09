/**
 * The wire between the desktop app and a PopBot host: a box that runs
 * agents (the real `claude` / `codex` CLIs, in its own checkouts) for
 * chats whose transcript, search and settings stay in the desktop's
 * database. Plain HTTP with a bearer token, and one server-sent event
 * stream per chat; no state on the host beyond the live sessions and
 * their event log, which a reconnecting desktop replays from where it
 * left off.
 *
 *   GET  /v1/info                          → HostInfo
 *   GET  /v1/repos/:id/branches            → { branches }
 *   GET  /v1/repos/:id/slots               → HostSlotsInfo
 *   PUT  /v1/repos/:id                     Partial<HostRepo> → HostRepo   (adds or changes; rewrites the config)
 *   DELETE /v1/repos/:id                   → { ok }
 *   POST /v1/chats/:chatId/workspace       HostWorkspaceRequest → HostWorkspaceResult
 *   POST /v1/chats/:chatId/release         { stash } → { released }  (parks the slot / removes the worktree)
 *   POST /v1/chats/:chatId/pack            HostPackBody → { work: PackedWork | null }  (a chat moving away, or forked)
 *   POST /v1/chats/:chatId/unpack          HostUnpackBody → HostWorkspaceResult  (a chat moving here)
 *   POST /v1/chats/:chatId/spawn           HostSpawnBody → { cwd, seq }
 *   POST /v1/chats/:chatId/send            HostSendBody
 *   POST /v1/chats/:chatId/approve         { permissionId, decision }
 *   POST /v1/chats/:chatId/stop | compact | dispose
 *   POST /v1/chats/:chatId/rules           { rules }
 *   PUT  /v1/chats/:chatId/meta            HostChatMeta → { ok }  (renamed, closed, reopened, gone)
 *   POST /v1/chats/:chatId/mcp-response    HostMcpResponse
 *   GET  /v1/chats/:chatId/events?after=N  SSE of HostFrame, replaying seq > N
 *   GET  /v1/bots                          → { bots: HostBotInfo[] }
 *   POST /v1/bots                          HostBotInput → HostBotInfo  (a new bot)
 *   PUT  /v1/bots/:id                      HostBotInput → HostBotInfo  (rewrites the config)
 *   DELETE /v1/bots/:id                    → { ok }
 *   POST /v1/bots/:id/wake | pause | resume | reset → { ok }
 *   GET  /v1/files/stat?path=&hash=1       → FileStat  (a file transfer — see src/main/transfer/)
 *   GET  /v1/files/read?path=&offset=N     → the bytes from N on, streamed
 *   PUT  /v1/files/write?path=&offset=N    body streamed into <path>.popbot-part from N → { partSize }
 *   POST /v1/files/commit                  { path, size, sha256, overwrite } → { path, size, sha256 }
 *   POST /v1/files/abort                   { path } → { ok }
 *
 * A bot's chat is an ordinary chat on this wire, under `botChatId(id)`:
 * the desktop attaches to it like any other. Only who drives it differs
 * — the host does, so it runs while no desktop is there.
 *
 * The agent's popbot MCP calls go the other way: the host serves a
 * stand-in endpoint on its own localhost, sends each request up the
 * chat's event stream as an `mcp-request` frame, and the desktop runs it
 * against its real popbot server and posts the answer back — so the
 * host never needs a route to the desktop.
 */
import type { AgentEvent, PermissionDecision, PermissionRule } from './agent';
import type {
  AgentBackendId,
  ClaudeModelId,
  ClaudeReasoningEffort,
  CodexModelId,
  CodexReasoningEffort,
} from './persistence';

export const HOST_PROTOCOL_VERSION = 1;

/** A repository the host has a checkout of, and how it hands out
 *  workspaces in it — the desktop's repo settings, on the host. */
export interface HostRepo {
  id: string;
  /** Absolute path on the host. */
  path: string;
  /** Branch new chat branches fork from when none is given. */
  defaultBase: string;
  /** Slot worktrees are `<workspaces>/<id>/<slotPrefix>-N`. */
  slotPrefix: string;
  /** Size of the slot pool; 0 with `slots` mode means no worktrees. */
  slotCount: number;
  /** A pool of warm slots, or a throwaway worktree per chat. */
  mode: 'slots' | 'ephemeral';
}

/** What a chat asks the host for: nothing but a scratch folder, the
 *  repo root, or a worktree on its branch (a slot or an ephemeral one,
 *  as the repo is configured). */
export type HostWorkspaceKind = 'scratch' | 'root' | 'worktree';

export interface HostWorkspaceRequest {
  kind: HostWorkspaceKind;
  repoId?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  /** A particular slot, when the desktop wants one; else the lowest free. */
  slotId?: number | null;
}

export interface HostWorkspaceResult {
  cwd: string;
  kind: 'scratch' | 'root' | 'slot' | 'ephemeral';
  slotId: number | null;
  branch: string | null;
}

export type HostWorkspaceErrorCode = 'no-repo' | 'no-free-slot' | 'slot-taken' | 'worktree-failed';

/** A repository's pool as the host sees it. */
export interface HostSlotsInfo {
  slotPrefix: string;
  slotCount: number;
  mode: 'slots' | 'ephemeral';
  slots: Array<{ slotId: number; path: string; chatId: string | null; branch: string | null }>;
}

export interface HostInfo {
  protocol: number;
  name: string;
  version: string;
  platform: string;
  claude: { ok: boolean; path: string | null };
  codex: { ok: boolean; path: string | null };
  repos: HostRepo[];
  /** Chats with a live session on the host, for a desktop that comes back. */
  chats: Array<{ chatId: string; alive: boolean; lastSeq: number }>;
  /** Every ordinary chat the host knows, as its own tools left it — what a
   *  desktop that was away adopts: chats made, closed or reopened on the
   *  host meanwhile. An older host leaves it out. */
  roster?: HostRosterChat[];
  /** The bots this host runs. An older host leaves it out. */
  bots?: HostBotInfo[];
}

/**
 * A bot: a chat the host keeps running on its own, woken by triggers.
 * It lives in the host's config and runs whether or not any desktop is
 * connected; a desktop that is finds its chat and shows it like any
 * other host chat. What it does is its prompt. See src/host/bots.ts.
 */
export interface HostBot {
  /** Short name without spaces, e.g. `webreviewer`; made from the name. */
  id: string;
  /** Shown as the chat's name. */
  name: string;
  /** Its standing orders — what it is for and how to do it. */
  prompt: string;
  /** The host repository it works in; null for a scratch folder. */
  repoId: string | null;
  /** What wakes it. None: only a person or another bot writing to it. */
  triggers: BotTrigger[];
  /** The bots it may message, by id or name — set with its config, and
   *  untouched when those bots come and go. Only the ones running on its
   *  host exist for it. Any bot that messages it, it may answer. */
  peers: string[];
  /** The GitHub account it acts as — for every trigger and every push —
   *  and how it tells its own comments apart. */
  githubLogin: string | null;
  /** That account's token, kept in the host's config — never sent back
   *  to a desktop. Or name an environment variable that holds it. */
  githubToken: string | null;
  githubTokenEnv: string | null;
  /** Commit author name; defaults to the login. */
  gitName: string | null;
  /** The bot's email: who it is, and the address on every commit it
   *  makes. Empty: commits carry the login's GitHub noreply address.
   *  GitHub credits a commit to the account with that address verified. */
  email: string | null;
  /** Its picture: a small square image as a data: URL. */
  avatar: string | null;
  claudeModel: ClaudeModelId | null;
  claudeReasoningEffort: ClaudeReasoningEffort | null;
  /** Off: paused — no trigger wakes it; its chat stays. */
  enabled: boolean;
}

/**
 * Something that wakes a bot. The host runs it — no model is involved
 * until it fires — and posts what happened into the bot's chat.
 *
 *  - `github`: open pull requests in a repository carrying any of the
 *    labels. Fires when one is new to the bot, gets new commits (by
 *    anyone but the bot), finishes CI, gets comments or reviews from
 *    someone else, gains or loses conflicts, or leaves draft.
 *  - `cron`: a five-field cron schedule (minute hour day month weekday,
 *    the host's local time) and the message the bot gets.
 */
export type BotTrigger = GithubTrigger | CronTrigger;

export interface GithubTrigger {
  id: string;
  kind: 'github';
  /** `owner/name`; empty: the bot repo's GitHub origin. */
  repo: string | null;
  /** Any of these on an open pull request wakes the bot — whoever opened
   *  it, whoever put the label on. Putting one on takes triage access to
   *  the repository, so the label is the gate. */
  labels: string[];
  /** Seconds between looks. */
  pollSeconds: number;
}

export interface CronTrigger {
  id: string;
  kind: 'cron';
  schedule: string;
  message: string;
}

export const DEFAULT_GITHUB_POLL_SECONDS = 30;
export const MIN_GITHUB_POLL_SECONDS = 15;

/** A bot as a desktop sees it: its config without secrets, its chat,
 *  and what it is doing. */
export interface HostBotInfo extends Omit<HostBot, 'githubToken' | 'githubTokenEnv'> {
  chatId: string;
  /** It has a token to act as its account. */
  hasToken: boolean;
  state: 'idle' | 'working' | 'error' | 'paused';
  /** Last time any trigger looked, and what went wrong if one failed. */
  lastPollAt: number | null;
  lastError: string | null;
  /** Pull requests its GitHub triggers are watching. */
  watching: BotWatchedPr[];
}

/** A pull request a bot is paying attention to, as it last saw it. */
export interface BotWatchedPr {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** Head commit, CI rollup (SUCCESS, FAILURE, PENDING, …), review
   *  decision (APPROVED, CHANGES_REQUESTED, …), MERGEABLE/CONFLICTING. */
  head: string;
  ci: string;
  decision: string;
  mergeable: string;
  draft: boolean;
  /** When it last woke the bot; null if it has not yet. */
  lastWokeAt: number | null;
}

/** A bot to make or change, from a desktop. `githubToken` absent keeps
 *  the stored one; an empty string clears it. */
export type HostBotInput = Partial<Omit<HostBot, 'id'>> & { name: string };

/** A file on a machine, as a transfer sees it (src/main/transfer/). */
export interface FileStat {
  /** The path, absolute, as the machine resolved it (`~` expanded). */
  path: string;
  exists: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
  /** Bytes of an unfinished transfer to this path already there. */
  partSize: number;
  /** Present when asked for (`hash=1`). */
  sha256?: string;
}

/** A bot's chat id, the same on the host and every desktop. */
export function botChatId(botId: string): string {
  return `chat_bot_${botId}`;
}

export interface HostSpawnBody {
  agent: AgentBackendId;
  /** Native session to resume (Claude session id / Codex thread id). */
  sessionId?: string | null;
  claudeModel?: ClaudeModelId | null;
  claudeReasoningEffort?: ClaudeReasoningEffort | null;
  codexModel?: CodexModelId | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  /** The desktop's permission rules, resolved on the host at call time. */
  rules: HostRules;
  /** Where the agent runs. Absent: the host's scratch directory. A
   *  workspace the chat already holds is reused. */
  workspace?: HostWorkspaceRequest | null;
  /** Give the agent the desktop's popbot tools, relayed over the chat's
   *  event stream. An older desktop leaves it out and gets none. */
  popbotMcp?: boolean;
  /** The chat's name, for the host's own popbot tools — what other chats
   *  on the host see when the desktop is away (see localPopbot.ts). */
  chatName?: string | null;
}

/** A chat as the host remembers it (src/host/chatRoster.ts). */
export interface HostRosterChat {
  chatId: string;
  name: string;
  open: boolean;
  /** Who last opened or closed it: a desktop, or the host's own tools
   *  while no desktop could be reached — a change a desktop applies. */
  changedBy: 'desktop' | 'host';
  changedAt: number;
  /** Made by the host's own tools; a desktop that has never seen it
   *  adopts it. */
  createdByHost: boolean;
  agent: AgentBackendId;
  claudeModel: ClaudeModelId | null;
  claudeReasoningEffort: ClaudeReasoningEffort | null;
  codexModel: CodexModelId | null;
  codexReasoningEffort: CodexReasoningEffort | null;
  kind: 'worktree' | 'root' | 'scratch';
  repoId: string | null;
  branch: string | null;
  baseBranch: string | null;
  slotId: number | null;
  cwd: string | null;
}

/** What the desktop tells a host about a chat it runs, so the host's own
 *  popbot tools (used while the desktop is away) show it as it is: its
 *  name, whether it is open — a closed chat is not woken — and that it
 *  has left the host altogether (deleted, or moved elsewhere). */
export interface HostChatMeta {
  name?: string;
  open?: boolean;
  gone?: boolean;
}

/** Permission rules as the desktop keeps them: the chat's own rules
 *  answer first, the global ones only when they are silent. */
export interface HostRules {
  chat: PermissionRule[];
  global: PermissionRule[];
}

/** What spawn answers: where the agent runs, and the event-log seq the
 *  desktop should read from (`?after=seq`) to see this session's frames
 *  and none of an earlier session's. */
export interface HostSpawnResult {
  cwd: string;
  seq: number;
  workspace: HostWorkspaceResult;
}

/** A chat's work, packed to move between machines (src/main/git/moveWork.ts). */
export interface PackedWork {
  branch: string;
  /** The branch's tip commit. */
  head: string;
  /** The commits no remote has, as a git bundle (base64); null when the
   *  tip is already on a remote, so the other side fetches it. */
  bundleBase64: string | null;
  /** Uncommitted changes, untracked files included, as a binary patch
   *  against `head` (base64); null when the checkout was clean or there
   *  is no checkout to read. */
  patchBase64: string | null;
}

/** Pack a chat's work to move it off this host (see git/moveWork.ts):
 *  from the checkout it holds, with its uncommitted changes, or — when
 *  it holds none — the branch's commits from the repository. */
export interface HostPackBody {
  repoId?: string | null;
  branch?: string | null;
  /** The chat is being forked, not moved: read its work and leave its
   *  session running. (A host that predates this stops the session, which
   *  only costs it a restart on its next message.) */
  keepSession?: boolean;
}

/** Give a chat moving here its workspace, with its work in it: the
 *  branch put in place from the packed commits, a checkout made as the
 *  repo is configured, the uncommitted changes laid on top. */
export interface HostUnpackBody {
  workspace: HostWorkspaceRequest;
  work: PackedWork | null;
}

export interface HostAttachment {
  name: string;
  isImage: boolean;
  /** File bytes, base64. Small by construction (images, text files). */
  dataBase64: string;
}

export interface HostSendBody {
  text: string;
  attachments?: HostAttachment[];
}

export interface HostApproveBody {
  permissionId: string;
  decision: PermissionDecision;
}

/** An MCP Streamable HTTP request the agent made to its popbot server.
 *  The desktop replays it against its own server under the chat's own
 *  id — the host does not get to say which chat is calling. */
export interface HostMcpRequest {
  /** Always POST: the relay answers anything else itself. */
  method: 'POST';
  /** The MCP-relevant ones: accept, content-type, mcp-protocol-version,
   *  mcp-session-id. */
  headers: Record<string, string>;
  body: string;
}

export interface HostMcpResponse {
  /** The `mcp-request` frame's id. */
  id: string;
  status: number;
  contentType: string | null;
  body: string;
}

/** One entry of a chat's event log on the host. `seq` is per chat and
 *  climbs by one; a desktop reconnects with the last seq it applied. */
export type HostFrame =
  | { seq: number; kind: 'event'; event: AgentEvent }
  | { seq: number; kind: 'session-id'; sessionId: string }
  | { seq: number; kind: 'spawned'; cwd: string }
  /** The agent is waiting on this popbot MCP call; answer with
   *  `mcp-response`. A replay leaves out the ones already answered. */
  | { seq: number; kind: 'mcp-request'; id: string; request: HostMcpRequest }
  /** The host itself sent the agent a message — a bot's trigger,
   *  another bot, or another chat on the host while the desktop was away
   *  — which no desktop typed, so a desktop records it as the user turn
   *  it is. `from` names the sender. */
  | { seq: number; kind: 'prompt'; text: string; from: { id: string; name: string; waiting?: boolean } }
  /** A bot answered a chat's message (its bots tool reply_to_chat),
   *  naming the reply id that message carried — never a chat. The
   *  desktop that issued the id delivers it, once: now, or when it next
   *  reads this log. */
  | { seq: number; kind: 'reply'; replyId: string; text: string }
  /** What a desktop sent the agent, kept so the host's own transcript
   *  tools have both sides. A desktop has it already and skips it. */
  | { seq: number; kind: 'user'; text: string; ts: number }
  /** The backend session is gone (its query ended); spawn again to go on. */
  | { seq: number; kind: 'dead' };
