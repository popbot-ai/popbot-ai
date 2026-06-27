/**
 * IPC channel names and request/response payload types shared between
 * the Electron main process and the renderer.
 *
 * Keep this file pure types + string constants. No runtime logic.
 *
 * Naming convention: `pb:<subsystem>:<action>`.
 */

import type { AgentEvent, PermissionDecision } from './agent';
import type {
  GitCommitInput,
  GitCommitResult,
  GitDetectPrResult,
  GitDiffInput,
  GitDiffResultOrErr,
  GitFilesInCommitInput,
  GitFilesInCommitResult,
  GitRevertInput,
  GitRevertResult,
  GitStatusResultOrErr,
  GitBaseBranchesResult,
} from './git';
import type {
  LinearIssueDto,
  LinearProjectDto,
  LinearTestResult,
  LinearWorkflowStateDto,
} from './linear';
import type {
  NotificationRecord,
  NotifyInput,
} from './notifications';
import type { ListReviewsResult } from './reviews';
import type { GithubTestResult, JiraSettings } from './ticketProvider';
import type { SentryTestResult } from './sentry';
import type { SlackTestResult } from './slack';
import type { UpdateInfo, UpdateCheckResult, UpdateProgress, UpdateReady } from './updates';
import type {
  AgentBackendId,
  ChatRecord,
  ClaudeModelId,
  ClaudeReasoningEffort,
  CodexModelId,
  CodexReasoningEffort,
  ChatAttachment,
  MessageRecord,
  PerforceRepoConfig,
  RepoRecord,
  RepoWorktreeMode,
} from './persistence';
import type { SourceControlProviderId } from './sourceControl';

export const IpcChannel = {
  AppGetVersion: 'pb:app:get-version',

  ChatsList: 'pb:chats:list',
  ChatsListClosed: 'pb:chats:list-closed',
  ChatsCreate: 'pb:chats:create',
  ChatsClose: 'pb:chats:close',
  ChatsReopen: 'pb:chats:reopen',
  ChatsDelete: 'pb:chats:delete',
  ChatsSearch: 'pb:chats:search',
  ChatsListSlots: 'pb:chats:list-slots',
  ChatsInitializeSlots: 'pb:chats:initialize-slots',
  ChatsInitializeOneSlot: 'pb:chats:initialize-one-slot',
  ChatsAttachSlot: 'pb:chats:attach-slot',
  ChatsDeleteAllSlots: 'pb:chats:delete-all-slots',
  ChatsClosePrep: 'pb:chats:close-prep',
  MessagesList: 'pb:messages:list',

  SettingsGet: 'pb:settings:get',
  SettingsSet: 'pb:settings:set',
  SettingsGetAll: 'pb:settings:get-all',
  SettingsDelete: 'pb:settings:delete',

  LinearTest: 'pb:linear:test',
  LinearListIssues: 'pb:linear:list-issues',
  LinearListProjects: 'pb:linear:list-projects',
  /** Workflow states (statuses) for a team's issues — populates the
   *  per-issue status picker. */
  LinearListStates: 'pb:linear:list-states',
  /** Fetch one Linear issue by its identifier (e.g. ENG-12345).
   *  Used by the manual-pin flow on PanelA — the auto-list only covers
   *  the user's active assignments, so manually-added items go through
   *  this single-issue fetch instead. */
  LinearGetIssue: 'pb:linear:get-issue',
  /** Bulk pull of recent issues across the configured team (or all
   *  teams visible to the API key when none configured), regardless
   *  of assignee. Runs on refresh + initial load; the WorkItemSearch
   *  picker fuzzy-matches against this cache so searches don't hit
   *  the API per keystroke. Capped to a generous-but-bounded page. */
  LinearListRecent: 'pb:linear:list-recent',
  /** Move an issue to a new workflow state. */
  LinearSetIssueState: 'pb:linear:set-issue-state',
  /** Idempotently promote an issue to "In Progress" if it's currently
   *  in an upstream (backlog/triage/unstarted) state. No-op for
   *  started/completed/canceled states — fired right after a chat is
   *  spawned for the ticket so the workflow reflects active dev. */
  LinearPromoteIssue: 'pb:linear:promote-issue',

  /** Verify Jira Cloud credentials (base URL + email + API token) by
   *  hitting `myself`. Used by the Jira form's Save button. The other
   *  ticket data channels (list/get/states/transition/promote) are shared
   *  with Linear and routed by the `ticketSource` setting in main. */
  JiraTest: 'pb:jira:test',
  /** List Jira projects visible to the supplied draft credentials — feeds
   *  the project picker in the Jira Preferences form. */
  JiraListProjects: 'pb:jira:list-projects',

  /** Verify the `gh` CLI is installed + authenticated and report how many
   *  configured repos the Tickets queue will span. GitHub has no
   *  credentials to enter (it reuses the `gh` login), so this takes no
   *  args. The shared ticket-data channels (list/get/states/promote) are
   *  routed by the `ticketSource` setting in main. */
  GithubTest: 'pb:github:test',

  /** Pending PRs (review-requested:@me OR review:none) for the configured repo. */
  ReviewsList: 'pb:reviews:list',
  /** Fetch one PR by number from the configured repo. Used by the
   *  manual-pin flow on PanelA so PRs outside the auto-queue can be
   *  pinned + displayed. */
  ReviewsGetPr: 'pb:reviews:get-pr',
  /** Bulk pull of recent open PRs in the configured repo (no
   *  review-rule filtering). Runs on refresh; the WorkItemSearch
   *  picker fuzzy-matches against this cache. */
  ReviewsListRecent: 'pb:reviews:list-recent',

  /** Find the 1-based line number of `needle` in a file, or null. */
  FilesLineOfText: 'pb:files:line-of-text',
  /** Open a native file picker for the chat input attach buttons.
   *  Returns the selected file's absolute path + metadata. */
  FilesPickAttachment: 'pb:files:pick-attachment',
  /** Save a pasted clipboard image to a temp file → attachment. */
  FilesSaveClipboardImage: 'pb:files:save-clipboard-image',
  /** Small data-URL thumbnail of an image file, for the composer chip. */
  FilesImageThumbnail: 'pb:files:image-thumbnail',
  /** Open a retained chat attachment in the OS default app. */
  FilesOpenAttachment: 'pb:files:open-attachment',
  /** Open a file referenced in chat in the configured external editor.
   *  Relative paths resolve against the chat's cwd. */
  FilesOpenInEditor: 'pb:files:open-in-editor',
  /** Open a native directory picker. Returns the absolute path or null
   *  on cancel. Used by the New Repo wizard to browse for the source
   *  clone instead of typing the path. */
  FilesPickDirectory: 'pb:files:pick-directory',

  /** Open / focus an external app for a slot's worktree. */
  AppsOpen: 'pb:apps:open',
  /** List installed Unity Editor versions found under Unity Hub. */
  UnityListVersions: 'pb:unity:list-versions',
  /** List currently-running Unity projects (project path + pid). */
  UnityRunningProjects: 'pb:unity:running-projects',
  /** Per-app status (terminal/editor/git/unity) for slot icon coloring. */
  AppsRunning: 'pb:apps:running',

  /** Working-tree status + recent commits for the focused chat's slot. */
  GitStatus: 'pb:git:status',
  /** Unified diff for one file (uncommitted, or scoped to a sha). */
  GitDiff: 'pb:git:diff',
  /** Stage selected paths and commit them with the supplied message. */
  GitCommit: 'pb:git:commit',
  /** Discard local changes for selected paths (delete if untracked). */
  GitRevert: 'pb:git:revert',
  /** Perforce: shelve checked files / unshelve checked changes. */
  GitShelve: 'pb:git:shelve',
  GitUnshelve: 'pb:git:unshelve',
  /** File list for an existing commit, used when browsing history. */
  GitFilesInCommit: 'pb:git:files-in-commit',
  /** Candidate PR base branches (develop + recent rc-1.*). */
  GitListBaseBranches: 'pb:git:list-target-branches',
  /** Detect an existing PR for the chat's branch via the `gh` CLI. */
  GitDetectPr: 'pb:git:detect-pr',
  /** Derive the branch-name username (settings override → gh login →
   *  git user.email/name → 'pop'). */
  GitUsername: 'pb:git:username',

  /** Open / re-attach the chat's persistent PTY. Returns the rolling
   *  output buffer to seed a freshly-mounted xterm. */
  TermOpen: 'pb:term:open',
  /** Write user input to a chat's PTY. */
  TermWrite: 'pb:term:write',
  /** Resize the PTY (cols × rows). */
  TermResize: 'pb:term:resize',
  /** Push channel — main → renderer. PTY output. */
  TermData: 'pb:term:data',

  /** Verify a Sentry token + org by hitting /organizations/{slug}/. */
  SentryTest: 'pb:sentry:test',
  /** Verify a Slack user token by hitting auth.test. */
  SlackTest: 'pb:slack:test',

  AgentSend: 'pb:agent:send',
  AgentStop: 'pb:agent:stop',
  AgentConfigure: 'pb:agent:configure',
  AgentApprove: 'pb:agent:approve',
  /** Probe whether the claude / codex CLIs are installed + runnable.
   *  Powers the "what's online" readiness panel in the empty chat pane. */
  AgentBackendsStatus: 'pb:agent:backends-status',

  /** Quit the app — used by the custom titlebar app menu on Windows,
   *  where the native menu bar (with its Quit accelerator) is hidden. */
  AppQuit: 'pb:app:quit',
  /** Window / edit / view command dispatched by the custom menu bar
   *  (frameless Windows/Linux). One channel, action string — see
   *  {@link WinActionName}. Returns the maximized state for the
   *  maximize/is-maximized actions, otherwise void. */
  WinAction: 'pb:win:action',
  /** Push — main → renderer — when the window is (un)maximized, so the
   *  menu bar can swap its Maximize/Restore labels live. */
  WinMaximizeChanged: 'pb:win:maximize-changed',
  /** Manual session-recovery trigger from the chat's Retry button. */
  AgentRecover: 'pb:agent:recover',
  /** List on-disk Claude sessions for the chat's worktree — used by
   *  the "Try reconnect" picker in chat settings. */
  AgentListSessions: 'pb:agent:list-sessions',
  /** Pin the chosen session as this chat's resume target and force
   *  a re-spawn into it. */
  AgentSetSession: 'pb:agent:set-session',
  /** Verify a chat's pinned session_id JSONL still exists on disk.
   *  Called by the renderer when a chat column mounts so we can warn
   *  before the user sends and triggers a "no conversation found". */
  AgentValidateSession: 'pb:agent:validate-session',
  /** Recover from a context-loss event: spawn a fresh SDK session and
   *  prime it with the chat's existing transcript so the agent picks
   *  up where it left off without the original Claude session. */
  AgentRestartWithContext: 'pb:agent:restart-with-context',

  /** Push channel — main → renderer. */
  AgentEvent: 'pb:agent:event',

  /** Push channel — main → renderer. A newer release exists but can't be
   *  installed in-app (unsigned build / updater error) — surface a
   *  manual "Download" link to the release page. */
  UpdateAvailable: 'pb:updates:available',

  /** Push channel — main → renderer. electron-updater download progress
   *  (0–100). */
  UpdateProgress: 'pb:updates:progress',

  /** Push channel — main → renderer. An update finished downloading and
   *  is staged — the renderer offers "Restart to install". */
  UpdateDownloaded: 'pb:updates:downloaded',

  /** Quit and install the staged update (autoUpdater.quitAndInstall). */
  UpdatesInstall: 'pb:updates:install',

  /** On-demand update check (About dialog). Returns UpdateCheckResult. */
  UpdatesCheck: 'pb:updates:check',

  /** Push channel — main → renderer. Open the About dialog (fired from
   *  the native macOS app menu). */
  ShowAbout: 'pb:app:show-about',

  /** Renderer → main. The UI language changed; main rebuilds the native
   *  app menu (macOS app menu / non-mac File menu) so its labels track
   *  the renderer's language without a restart. */
  LocaleChanged: 'pb:i18n:locale-changed',

  /** Multi-repo configuration. Each repo is either slot-pool or
   *  ephemeral; mode is set at create and is immutable thereafter
   *  (switching mode after chats exist would orphan their worktrees).
   *  Delete is unconditional but the renderer gates it behind a
   *  type-the-name confirm + a chat-count warning. */
  ReposList: 'pb:repos:list',
  ReposCreate: 'pb:repos:create',
  ReposUpdate: 'pb:repos:update',
  ReposDelete: 'pb:repos:delete',
  /** Pre-flight for the delete-confirm UI: how many non-deleted chats
   *  reference this repo. Detached chats persist + reattach if a repo
   *  with the same id is later re-added. */
  ReposCountChats: 'pb:repos:count-chats',
  /** Detect which SCM (git | perforce) backs a picked folder, so the Add
   *  Repository flow can infer the provider instead of asking. Null when
   *  undetected (UI falls back to a manual picker). */
  ReposDetectScm: 'pb:repos:detect-scm',
  /** Pull the connection + depot mapping + synced changelist from the P4
   *  client workspace rooted at a folder, so the Add-Repository flow can
   *  auto-fill (read-only) instead of asking the user to retype. */
  ReposDetectP4Workspace: 'pb:repos:detect-p4-workspace',
  /** Configure Slots flow — used by both the New Repo wizard's final
   *  step and the Edit Repo "Resize slots" button. The flow is
   *  per-slot so the renderer can render real progress; this set of
   *  channels is the building block. */
  ReposListSlotOccupants: 'pb:repos:list-slot-occupants',
  ReposInitializeOneSlot: 'pb:repos:initialize-one-slot',
  ReposDeleteOneSlot: 'pb:repos:delete-one-slot',
  ReposSetSlotCount: 'pb:repos:set-slot-count',
  /** Grow a slot pool: create+mount the new shado clones in one elevated
   *  batch (privileged), before the per-slot init loop. */
  ReposPrepareGrow: 'pb:repos:prepare-grow',
  /** Perforce base-build flow (Add Repository → Perforce). Preflight
   *  measures the warm folder + drive free space and gates on a 5% margin;
   *  build runs the elevated `shado create` (UAC) and captures the synced
   *  changelist so slots can flush to it. */
  ReposBasePreflight: 'pb:repos:base-preflight',
  ReposBuildBase: 'pb:repos:build-base',
  /** Main→renderer progress lines streamed during the (long) folder measure
   *  and base build, so the wizard shows live, accurate progress. */
  ReposBaseProgress: 'pb:repos:base-progress',
  /** Main→renderer progress while opening a huge changed-file set into a
   *  Perforce changelist (`p4 add/edit` over thousands of files). Empty = done. */
  P4OpenProgress: 'pb:p4:open-progress',

  /** Notifications. Anywhere in the app can `notify(...)` to record
   *  a row + fan out a toast + bell-icon update. The renderer also
   *  invokes the dispatch channel so renderer-detected events (new
   *  PR review, etc.) flow through the same dedup + persistence. */
  NotificationsList: 'pb:notifications:list',
  NotificationsUnreadCount: 'pb:notifications:unread-count',
  NotificationsMarkAllRead: 'pb:notifications:mark-all-read',
  NotificationsClearAll: 'pb:notifications:clear-all',
  NotificationsMarkRead: 'pb:notifications:mark-read',
  NotificationsDispatch: 'pb:notifications:dispatch',
  /** Push — main → renderer; fired when a fresh notification lands. */
  NotificationAdded: 'pb:notifications:added',
} as const;

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

export interface CreateChatInput {
  name: string;
  ticket?: string;
  pr?: number;
  branch?: string;
  type?: 'lite' | 'client_test' | 'server_test';
  /** Caller-chosen slot. When set, main verifies it's still free and
   *  sets up a git worktree on `branch`. */
  slotId?: number;
  /** Have main pick the lowest-numbered free slot. Mutually exclusive
   *  with `slotId`; `slotId` wins if both are set. */
  allocateSlot?: boolean;
  /** Branch to fork the chat's branch from. Falls back to git
   *  settings' `defaultBase` when omitted. Used both at chat creation
   *  (worktree base) and later as the PR target. */
  baseBranch?: string;
  /** Repo this chat belongs to. Defaults to `'app'` server-side
   *  for back-compat. Once multi-repo is fully wired, the renderer
   *  picks this from the per-repo new-chat flow. */
  repoId?: string;
  /** Agent backend to use from the first message onward. Defaults to
   *  Claude for back-compat. Model/effort settings are provider-scoped. */
  agent?: AgentBackendId;
  claudeModel?: ClaudeModelId;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
}

export type CreateChatResult =
  | { ok: true; chat: ChatRecord }
  | { ok: false; reason: 'slots-not-configured' }
  | { ok: false; reason: 'git-not-configured' }
  | { ok: false; reason: 'slot-taken'; slotId: number }
  | { ok: false; reason: 'no-free-slot' }
  | { ok: false; reason: 'worktree-failed'; message: string };

/** Result of `pb:chats:reopen`. `ok: false` lets the renderer surface
 *  a meaningful error (e.g. no-slots modal) instead of silently no-oping. */
export type ReopenChatResult =
  | { ok: true; chat: ChatRecord }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'no-free-slot' }
  | { ok: false; reason: 'worktree-failed'; message: string };

export interface SlotInfo {
  slotId: number;
  /** True when the slot's worktree has been created on disk. False
   *  means it'll be set up lazily on first use. */
  ready: boolean;
  /** null when this slot is free. */
  occupant: {
    chatId: string;
    chatName: string;
    ticket: string | null;
    pr: number | null;
    branch: string | null;
  } | null;
}

export interface ListSlotsResult {
  ok: true;
  maxCount: number;
  slots: SlotInfo[];
}
export type ListSlotsResultOrErr =
  | ListSlotsResult
  | { ok: false; reason: 'slots-not-configured' };

export interface SlotInitResult {
  slotId: number;
  /** Already had a worktree before this call (no-op). */
  alreadyReady: boolean;
  ok: boolean;
  /** Present when ok=false. */
  error?: string;
}
export type InitializeSlotsResult =
  | { ok: true; results: SlotInitResult[] }
  | { ok: false; reason: 'slots-not-configured' | 'git-not-configured' };

/** New-repo form payload. `id` is the user-chosen short name and is
 *  permanent — used as the folder segment in worktree paths and the
 *  prefix on slot parking branches. `mode` is also write-once. */
export interface CreateRepoInput {
  id: string;
  repoPath: string;
  color: string;
  slotPrefix: string;
  defaultBase: string;
  slotCount: number;
  mode: RepoWorktreeMode;
  /** Detected source control. Defaults to 'git' when omitted. Perforce repos
   *  are always slot-mode and carry a `p4` config built by the base flow. */
  scm?: SourceControlProviderId;
  /** Perforce connection + frozen-base config. Required when scm==='perforce'
   *  (the create handler rejects a perforce repo without it). */
  p4?: PerforceRepoConfig;
}

/** Result of the Perforce base disk preflight. All byte counts; the UI
 *  formats + decides messaging. `ok===false` ⇒ block the build. */
export interface BasePreflightInfo {
  folderBytes: number;
  fileCount: number;
  freeBytes: number;
  /** folderBytes × 1.05 — minimum free space to allow the build. */
  neededBytes: number;
  /** Suggested expandable-VHDX ceiling (`--size-gb`). */
  sizeGb: number;
  ok: boolean;
}

/** Connection + mapping discovered from the Perforce client workspace whose
 *  Root is the picked folder — everything the Add-Repository connect step
 *  would otherwise ask the user to retype. */
export interface P4WorkspaceInfo {
  client: string;
  port: string;
  user: string;
  /** Depot root from the client's View (e.g. //depot/PopBotGame). */
  depotPath: string;
  /** The changelist the workspace is synced to (#have), 0 if unknown. */
  baseChangelist: number;
}

/** Input to the elevated base build. `baseName` is the shado project name;
 *  `depotPath` + connection let us capture the synced changelist. */
export interface BuildBaseInput {
  repoPath: string;
  /** Repo short id — pins SHADO_HOME to workspaces/<id>/shado. */
  repoId: string;
  baseName: string;
  sizeGb: number;
  port: string;
  user: string;
  depotPath: string;
  /** Changelist already discovered from the workspace (#have). Used as a
   *  fallback when the server-side capture at build time can't resolve it. */
  baseChangelist?: number;
  /** Slot folder prefix + count. The base AND all slot clones are created in
   *  the SAME elevated session (one UAC), so slot-init stays non-privileged. */
  slotPrefix: string;
  slotCount: number;
}

export type BuildBaseResult =
  | { ok: true; baseChangelist: number; baseMb: number; log: string }
  | { ok: false; error: string };

/** Edit-existing-repo payload. `id` selects the row; `mode` is omitted
 *  by design (mode is creation-only). */
export interface UpdateRepoInput {
  id: string;
  repoPath: string;
  color: string;
  slotPrefix: string;
  defaultBase: string;
  slotCount: number;
}

export type RepoCreateResult =
  | { ok: true; repo: RepoRecord }
  | { ok: false; reason: 'duplicate-id' }
  | { ok: false; reason: 'duplicate-path'; existingId: string }
  | { ok: false; reason: 'invalid'; message: string };

export type RepoUpdateResult =
  | { ok: true; repo: RepoRecord }
  | { ok: false; reason: 'not-found' };

/** Per-slot result of one step in the Configure Slots flow. */
export type RepoSlotStepResult =
  | { ok: true; slotId: number; alreadyReady?: boolean }
  | { ok: false; slotId: number; error: string }
  | { ok: false; reason: 'repo-not-found' }
  | { ok: false; reason: 'wrong-mode' }
  | { ok: false; reason: 'slot-in-use'; chatName: string };

export type DeleteAllSlotsResult =
  | { ok: true; removed: number }
  | { ok: false; reason: 'git-not-configured' }
  | { ok: false; reason: 'slots-in-use'; chatNames: string[] };

export interface ClosePrepResult {
  hasWorktree: boolean;
  dirty: boolean;
  /** First N porcelain status lines for the close-confirm UI. */
  files: string[];
  /** Path of the worktree that will be removed (informational). */
  worktreePath: string | null;
}

export interface CloseChatOptions {
  /** When true and the worktree is dirty, run `git stash push` before
   *  removing so the user can recover. */
  stash?: boolean;
}

export interface SendMessageInput {
  chatId: string;
  text: string;
  /** Files attached to this turn. Images are read by the main process,
   *  base64-encoded, and sent to Claude as proper image content blocks
   *  (not as on-disk path references the agent has to Read separately).
   *  Non-image files keep the path-reference behaviour for now —
   *  Claude reads them with its Read tool, same as before. */
  attachments?: PickedAttachment[];
}

export interface ApprovePermissionInput {
  chatId: string;
  permissionId: string;
  decision: PermissionDecision;
}

export interface ConfigureAgentInput {
  chatId: string;
  agent: AgentBackendId;
  claudeModel?: ClaudeModelId;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
}

/** Result of probing a single agent CLI backend (claude / codex). */
export interface AgentBackendStatus {
  /** True when the CLI was found on PATH and `--version` ran. */
  ok: boolean;
  /** Version string from `--version`, when ok. */
  version?: string;
  /** Failure reason when not ok (e.g. "claude not found on PATH"). */
  error?: string;
}

/** Online/offline state of the agent CLI backends. */
export interface AgentBackendsStatus {
  claude: AgentBackendStatus;
  codex: AgentBackendStatus;
}

/** Commands the custom menu bar can dispatch to the host window. */
export type WinActionName =
  | 'minimize' | 'maximize-toggle' | 'close' | 'is-maximized'
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'select-all'
  | 'reload' | 'force-reload' | 'toggle-devtools'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset';

/** Surface exposed on `window.popbot` by the preload script. */
export type PickedAttachment = ChatAttachment;

export interface PopBotApi {
  /** Host OS (`process.platform`: 'darwin' | 'win32' | 'linux' | …),
   *  surfaced synchronously so the renderer can branch its chrome (e.g.
   *  the custom Windows titlebar) without an async round-trip. */
  platform: string;
  app: {
    getVersion(): Promise<string>;
    /** Quit the whole app (custom titlebar menu on Windows). */
    quit(): Promise<void>;
  };
  /** Localization. The renderer owns the active locale (persisted via
   *  `settings`); this lets it nudge main to re-localize native chrome. */
  i18n: {
    /** Tell main the UI language changed so it rebuilds the native menu. */
    localeChanged(locale: string): void;
  };
  /** Window chrome controls for the custom menu bar (frameless platforms). */
  win: {
    /** Dispatch a window/edit/view command. Resolves to the maximized
     *  state for 'maximize-toggle' / 'is-maximized', else undefined. */
    action(name: WinActionName): Promise<boolean | void>;
    /** Subscribe to (un)maximize so the menu can relabel. Returns an
     *  unsubscribe function. */
    onMaximizeChange(handler: (maximized: boolean) => void): () => void;
  };
  chats: {
    list(): Promise<ChatRecord[]>;
    listClosed(limit?: number): Promise<ChatRecord[]>;
    create(input: CreateChatInput): Promise<CreateChatResult>;
    close(chatId: string, opts?: CloseChatOptions): Promise<void>;
    closePrep(chatId: string): Promise<ClosePrepResult>;
    reopen(chatId: string): Promise<ReopenChatResult>;
    delete(chatId: string): Promise<void>;
    search(query: string, limit?: number): Promise<ChatRecord[]>;
    listSlots(): Promise<ListSlotsResultOrErr>;
    initializeSlots(): Promise<InitializeSlotsResult>;
    /** Initialize a single slot — used by the renderer's progress
     *  panel so it can show "creating slot N of M" + allow cancel. */
    initializeOneSlot(slotId: number): Promise<SlotInitResult | { ok: false; error: string }>;
    /** Attach a slot + worktree to an existing chat that doesn't yet
     *  have one (e.g. it was created before slots were configured). */
    attachSlot(chatId: string): Promise<CreateChatResult>;
    /** Tear down every slot worktree on disk + delete each parking
     *  branch. Refuses if any open chat is currently using a slot. */
    deleteAllSlots(): Promise<DeleteAllSlotsResult>;
    listMessages(chatId: string, tail?: number): Promise<MessageRecord[]>;
  };
  settings: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    getAll(): Promise<Record<string, unknown>>;
    delete(key: string): Promise<void>;
  };
  files: {
    /** Returns the 1-based line number of `needle`'s first occurrence
     *  in the file at `path`, or null if the file or text isn't found. */
    lineOfText(path: string, needle: string): Promise<number | null>;
    /** Open a native file picker. `kind: 'image'` filters to common
     *  image extensions; `'any'` accepts anything. Resolves to null
     *  when the user cancels. Supports multi-select. */
    pickAttachment(kind: 'image' | 'any'): Promise<PickedAttachment[] | null>;
    /** Save a pasted clipboard image (raw bytes) to a temp file and return it
     *  as an attachment, same shape as pickAttachment. */
    saveClipboardImage(bytes: ArrayBuffer, ext: string): Promise<PickedAttachment | null>;
    /** A small data-URL thumbnail for an image attachment (composer preview).
     *  Null when the file isn't a decodable raster image. */
    imageThumbnail(path: string): Promise<string | null>;
    /** Open a retained chat attachment in the OS default app. */
    openAttachment(path: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Open a file referenced in chat in the configured external editor
     *  (VS Code / Cursor). Relative paths resolve against the chat's cwd;
     *  an optional `:line` suffix on `path` (or the explicit `line` arg)
     *  jumps the cursor. `chatId` may be null for already-absolute paths. */
    openInEditor(
      chatId: string | null,
      path: string,
      line?: number,
    ): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Native directory picker. `defaultPath` seeds where the dialog
     *  opens (existing path or its parent if it doesn't exist; falls
     *  back to $HOME when omitted). Returns null on cancel. */
    pickDirectory(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  };
  unity: {
    /** Scan Unity Hub's Editor directory and return installed versions
     *  with their binary paths. */
    listVersions(): Promise<Array<{ version: string; binary: string }>>;
    /** Currently-running Unity instances. Used to color slot icons +
     *  decide whether the launcher should focus or spawn. */
    runningProjects(): Promise<Array<{ projectPath: string; pid: number }>>;
  };
  apps: {
    /** Open / focus an external app pointed at `worktreePath`.
     *  - 'terminal' → user's preferred terminal (iTerm by default)
     *  - 'editor'   → VS Code / Cursor (per editor pref)
     *  - 'git'      → GitHub Desktop or configured git client
     *  - 'unity'    → Unity Hub / Unity at `<worktreePath>/<unityProjectSubpath>` */
    open(
      kind: 'terminal' | 'editor' | 'git' | 'unity',
      worktreePath: string,
    ): Promise<{ ok: true } | { ok: false; error: string; reason?: 'unity-not-configured' }>;
    /** Snapshot of which apps are currently open for which slots, for
     *  the slot icon row's running indicator. Each kind maps to a Set
     *  of slot worktree basenames (e.g. 'slot-3') that the app
     *  appears to have a window for. */
    running(): Promise<{
      terminal: string[];
      editor: string[];
      git: string[];
      unity: string[];
    }>;
  };
  reviews: {
    list(): Promise<ListReviewsResult>;
    /** Fetch one PR by number for the manual-pin flow. */
    getPr(prNumber: number): Promise<
      | { ok: true; pr: import('./reviews').ReviewItem }
      | { ok: false; reason: 'not-found' | 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'error'; error?: string }
    >;
    /** Pull recent open PRs for the WorkItemSearch cache.
     *  Window is read from `settings.panela.search.recentDays`. */
    listRecent(): Promise<
      | { ok: true; prs: import('./reviews').ReviewItem[] }
      | { ok: false; reason: 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'error'; error?: string }
    >;
  };
  repos: {
    list(): Promise<RepoRecord[]>;
    /** Create a new repo. `mode` is set here ONCE — there's no update
     *  path for mode because switching after chats exist would orphan
     *  their worktrees. */
    create(input: CreateRepoInput): Promise<RepoCreateResult>;
    /** Update the editable fields (path / color / slot-prefix /
     *  default-base / slot-count). `mode` and `id` are immutable. */
    update(input: UpdateRepoInput): Promise<RepoUpdateResult>;
    /** Delete. UI must show a type-the-name confirm + a chat-count
     *  warning first. For slot repos this also tears down the shado base +
     *  clones and removes the repo's workspaces folder; a teardown failure
     *  returns `ok:false` (the row is kept) so the UI can show the error. */
    delete(id: string): Promise<{ ok: true } | { ok: false; message: string }>;
    /** Count of non-deleted chats referencing this repo. Powers the
     *  delete-confirm warning. */
    countChats(id: string): Promise<number>;
    /** Detect the SCM of a picked folder for the Add Repository flow.
     *  'git' | 'perforce', or null when it's neither — the UI then shows an
     *  "invalid repo path" error and blocks continuing. */
    detectScm(folder: string): Promise<'git' | 'perforce' | null>;
    /** Connection + depot + #have from the P4 client rooted at the folder,
     *  or null when none maps it (the connect step falls back to manual). */
    detectP4Workspace(folder: string): Promise<P4WorkspaceInfo | null>;
    /** Configure Slots flow building blocks. The renderer drives the
     *  loop one slot at a time so the user sees real progress. */
    listSlotOccupants(id: string): Promise<Array<{ slotId: number; chatName: string }>>;
    /** Idempotent — a slot already on disk reports `alreadyReady: true`. */
    initializeOneSlot(repoId: string, slotId: number): Promise<RepoSlotStepResult>;
    /** Grow prep: create+mount the new shado clones (slots currentCount+1..
     *  toCount) in ONE elevated batch, before the per-slot init loop. A grow
     *  needs `shado clone create`, which is privileged. No-op for a shrink or
     *  non-slot repo. */
    prepareGrow(repoId: string, toCount: number): Promise<{ ok: true } | { ok: false; message: string }>;
    /** Tear down one slot's worktree + delete its parking branch.
     *  Refuses if the slot is currently occupied. */
    deleteOneSlot(repoId: string, slotId: number): Promise<RepoSlotStepResult>;
    /** Commit the new pool size after the per-slot work succeeds. */
    setSlotCount(id: string, n: number): Promise<{ ok: true } | { ok: false; reason: 'not-found' }>;
    /** Perforce base-build preflight: measure the warm folder + the repo
     *  drive's free space and decide if a build can proceed (5% margin). */
    basePreflight(repoPath: string): Promise<BasePreflightInfo>;
    /** Run the elevated `shado create` (UAC) to freeze a base off the warm
     *  folder, then capture the synced changelist for slot flushes. */
    buildBase(input: BuildBaseInput): Promise<BuildBaseResult>;
    /** Subscribe to live progress lines from basePreflight()/buildBase().
     *  Returns an unsubscribe fn. */
    onBaseProgress(cb: (message: string) => void): () => void;
    /** Subscribe to progress while opening a large changed-file set into a
     *  Perforce changelist. Empty message = done. Returns an unsubscribe fn. */
    onP4OpenProgress(cb: (message: string) => void): () => void;
  };
  sentry: {
    /** Verify a Sentry auth token + org slug. The renderer passes the
     *  in-flight token from the prefs form; main hits Sentry once. */
    test(input: { token: string; orgSlug: string }): Promise<SentryTestResult>;
  };
  slack: {
    /** Verify a Slack xoxp- user token by hitting auth.test. */
    test(token: string): Promise<SlackTestResult>;
  };
  linear: {
    test(apiKey: string): Promise<LinearTestResult>;
    listIssues(): Promise<{
      issues: LinearIssueDto[];
      notConfigured?: boolean;
      authFailed?: boolean;
      error?: string;
    }>;
    /** List active projects for the configured account/team. Used by
     *  the project picker in Preferences. Pass an explicit apiKey when
     *  the user is editing a draft key that isn't saved yet. */
    listProjects(opts?: { apiKey?: string; teamKey?: string }): Promise<{
      projects: LinearProjectDto[];
      notConfigured?: boolean;
      authFailed?: boolean;
      error?: string;
    }>;
    /** Workflow states for a team — feeds the per-issue status picker. */
    listStates(teamId: string): Promise<{
      states: LinearWorkflowStateDto[];
      notConfigured?: boolean;
      authFailed?: boolean;
      error?: string;
    }>;
    /** Fetch one Linear issue by identifier (e.g. ENG-12345) for the
     *  manual-pin flow on PanelA. */
    getIssue(identifier: string): Promise<
      | { ok: true; issue: LinearIssueDto }
      | { ok: false; reason: 'not-found' | 'not-configured' | 'auth-failed' | 'error'; error?: string }
    >;
    /** Pull recent issues for the WorkItemSearch cache. */
    listRecent(): Promise<{
      issues: LinearIssueDto[];
      notConfigured?: boolean;
      authFailed?: boolean;
      error?: string;
    }>;
    /** Move an issue to a new workflow state. */
    setIssueState(issueId: string, stateId: string): Promise<
      | { ok: true; stateName: string | null }
      | { ok: false; reason: string }
    >;
    /** Idempotent promote-to-In-Progress. Returns `promoted: true`
     *  when we actually moved it, `promoted: false` when the state
     *  was already at-or-past dev work and we left it alone. */
    promoteIssue(identifier: string): Promise<
      | { ok: true; promoted: boolean; stateName?: string }
      | { ok: false; reason: string }
    >;
  };
  jira: {
    /** Verify draft Jira credentials. Returns the same result shape as
     *  `linear.test` so the Preferences forms can share status rendering. */
    test(settings: JiraSettings): Promise<LinearTestResult>;
    /** List projects for the supplied draft credentials. */
    listProjects(settings: JiraSettings): Promise<{
      projects: LinearProjectDto[];
      notConfigured?: boolean;
      authFailed?: boolean;
      error?: string;
    }>;
  };
  github: {
    /** Verify the `gh` CLI is installed + authenticated and report how
     *  many configured repos the Tickets queue spans. No args — GitHub
     *  reuses the `gh` login rather than its own credentials. Feeds the
     *  GitHub Preferences form's status line. */
    test(): Promise<GithubTestResult>;
  };
  term: {
    open(chatId: string, cwd: string, cols?: number, rows?: number): Promise<{ ok: true; buffer: string }>;
    write(chatId: string, data: string): Promise<void>;
    resize(chatId: string, cols: number, rows: number): Promise<void>;
    onData(handler: (event: { chatId: string; data: string }) => void): () => void;
  };
  git: {
    status(chatId: string): Promise<GitStatusResultOrErr>;
    diff(input: GitDiffInput): Promise<GitDiffResultOrErr>;
    commit(input: GitCommitInput): Promise<GitCommitResult>;
    revert(input: GitRevertInput): Promise<GitRevertResult>;
    /** Perforce: shelve the checked (depot-key) paths into a new shelf. */
    shelve(input: { chatId: string; paths: string[]; message?: string }): Promise<{ ok: true; change: string } | { ok: false; error: string }>;
    /** Perforce: unshelve (restore + remove) the checked shelved changelists. */
    unshelve(input: { chatId: string; changes: string[] }): Promise<{ ok: true } | { ok: false; error: string }>;
    filesInCommit(input: GitFilesInCommitInput): Promise<GitFilesInCommitResult>;
    /** Resolve a cwd from either the chat (its worktree) or the repo
     *  (the source clone path), in that order, then list base branches.
     *  Pre-chat callers (e.g. the new-chat dialog) pass `repoId`.
     *  Existing in-chat callers continue to pass `chatId`. */
    listBaseBranches(input: { chatId?: string | null; repoId?: string | null }): Promise<GitBaseBranchesResult>;
    /** The branch-name username (e.g. `benjcooley`), auto-derived from
     *  gh/git when not explicitly set in Source-control settings. */
    username(): Promise<string>;
    detectPr(chatId: string): Promise<GitDetectPrResult>;
  };
  agent: {
    send(input: SendMessageInput): Promise<void>;
    stop(chatId: string): Promise<void>;
    configure(input: ConfigureAgentInput): Promise<ChatRecord>;
    approve(input: ApprovePermissionInput): Promise<void>;
    recover(chatId: string): Promise<void>;
    listSessions(chatId: string): Promise<{
      ok: true;
      sessions: Array<{
        sessionId: string;
        summary: string;
        lastModified: number;
        fileSize?: number;
        firstPrompt?: string;
        gitBranch?: string;
        cwd?: string;
      }>;
    } | { ok: false; reason: 'no-worktree' | 'error'; error?: string }>;
    setSession(chatId: string, sessionId: string): Promise<void>;
    /** Confirm the SDK session JSONL for this chat still exists where
     *  the SDK expects it. `'ok'` when present (or no session pinned).
     *  `'missing'` when the JSONL is gone — UI should show a banner. */
    validateSession(chatId: string): Promise<{ state: 'ok' | 'missing' | 'unknown'; details?: string }>;
    /** Recover from a context-loss event by spawning fresh + priming
     *  with the existing transcript. Capped to keep the prompt size
     *  reasonable; older turns get trimmed first. */
    restartWithContext(chatId: string): Promise<void>;
    /** Probe the agent CLI backends (claude / codex) and report whether
     *  each is installed + runnable. Drives the readiness panel so the
     *  user can see which agents are online before starting a chat. */
    backendsStatus(): Promise<AgentBackendsStatus>;
    /**
     * Subscribe to the agent event push stream. The handler fires for
     * events from any chat; filter on `chatId` if needed.
     * Returns an unsubscribe function.
     */
    onEvent(handler: (event: AgentEvent) => void): () => void;
  };
  updates: {
    /** Subscribe to "newer release available, download manually" pushes
     *  (unsigned build / updater error fallback). Returns an unsubscribe
     *  function. */
    onAvailable(handler: (info: UpdateInfo) => void): () => void;
    /** Subscribe to download-progress pushes (0–100). Returns an
     *  unsubscribe function. */
    onProgress(handler: (progress: UpdateProgress) => void): () => void;
    /** Subscribe to "update downloaded, ready to install" pushes.
     *  Returns an unsubscribe function. */
    onDownloaded(handler: (info: UpdateReady) => void): () => void;
    /** Quit and install the staged update. The app relaunches. */
    install(): void;
    /** Run an on-demand update check (About dialog). */
    check(): Promise<UpdateCheckResult>;
    /** Subscribe to "open the About dialog" pushes (native macOS menu).
     *  Returns an unsubscribe function. */
    onShowAbout(handler: () => void): () => void;
  };
  notifications: {
    /** Most-recent notifications (default 50). */
    list(limit?: number): Promise<NotificationRecord[]>;
    unreadCount(): Promise<number>;
    markAllRead(): Promise<void>;
    /** Hard-delete every notification. Backs the bell's "Clear all"
     *  button — wiping the list so a busy queue doesn't pile up. */
    clearAll(): Promise<void>;
    markRead(id: string): Promise<void>;
    /** Dispatch from anywhere — main de-dups + persists + pushes a
     *  toast/dropdown update to every window. Returns the persisted
     *  record, or null if it was dropped as a duplicate. */
    dispatch(input: NotifyInput): Promise<NotificationRecord | null>;
    /** Subscribe to push events for newly-arrived notifications. */
    onAdded(handler: (rec: NotificationRecord) => void): () => void;
  };
}

declare global {
  interface Window {
    popbot: PopBotApi;
  }
}
