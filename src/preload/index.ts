import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentEvent } from '@shared/agent';
import type { UpdateInfo, UpdateProgress, UpdateReady } from '@shared/updates';
import type { NotificationRecord, NotifyInput } from '@shared/notifications';
import type {
  GitCommitInput,
  GitDiffInput,
  GitFilesInCommitInput,
  GitRevertInput,
} from '@shared/git';
import {
  IpcChannel,
  type ApprovePermissionInput,
  type BuildBaseInput,
  type CloseChatOptions,
  type ConfigureAgentInput,
  type CreateChatInput,
  type CreateRepoInput,
  type PopBotApi,
  type SendMessageInput,
  type UpdateRepoInput,
} from '@shared/ipc';

const api: PopBotApi = {
  platform: process.platform,
  app: {
    getVersion: () => ipcRenderer.invoke(IpcChannel.AppGetVersion),
    quit: () => ipcRenderer.invoke(IpcChannel.AppQuit),
  },
  i18n: {
    localeChanged: (locale: string) => ipcRenderer.send(IpcChannel.LocaleChanged, locale),
  },
  win: {
    action: (name) => ipcRenderer.invoke(IpcChannel.WinAction, name),
    onMaximizeChange: (handler: (maximized: boolean) => void) => {
      const listener = (_e: IpcRendererEvent, maximized: boolean) => handler(maximized);
      ipcRenderer.on(IpcChannel.WinMaximizeChanged, listener);
      return () => ipcRenderer.removeListener(IpcChannel.WinMaximizeChanged, listener);
    },
  },
  chats: {
    list: () => ipcRenderer.invoke(IpcChannel.ChatsList),
    listClosed: (limit?: number) => ipcRenderer.invoke(IpcChannel.ChatsListClosed, limit),
    create: (input: CreateChatInput) => ipcRenderer.invoke(IpcChannel.ChatsCreate, input),
    close: (chatId: string, opts?: CloseChatOptions) =>
      ipcRenderer.invoke(IpcChannel.ChatsClose, chatId, opts),
    closePrep: (chatId: string) => ipcRenderer.invoke(IpcChannel.ChatsClosePrep, chatId),
    reopen: (chatId: string) => ipcRenderer.invoke(IpcChannel.ChatsReopen, chatId),
    delete: (chatId: string) => ipcRenderer.invoke(IpcChannel.ChatsDelete, chatId),
    search: (query: string, limit?: number) =>
      ipcRenderer.invoke(IpcChannel.ChatsSearch, query, limit),
    attachSlot: (chatId: string) => ipcRenderer.invoke(IpcChannel.ChatsAttachSlot, chatId),
    listMessages: (chatId: string, tail?: number) =>
      ipcRenderer.invoke(IpcChannel.MessagesList, chatId, tail),
  },
  settings: {
    get: <T = unknown>(key: string) =>
      ipcRenderer.invoke(IpcChannel.SettingsGet, key) as Promise<T | null>,
    set: (key: string, value: unknown) => ipcRenderer.invoke(IpcChannel.SettingsSet, key, value),
    getAll: () => ipcRenderer.invoke(IpcChannel.SettingsGetAll),
    delete: (key: string) => ipcRenderer.invoke(IpcChannel.SettingsDelete, key),
  },
  files: {
    lineOfText: (path: string, needle: string) =>
      ipcRenderer.invoke(IpcChannel.FilesLineOfText, path, needle),
    pickAttachment: (kind: 'image' | 'any') =>
      ipcRenderer.invoke(IpcChannel.FilesPickAttachment, kind),
    saveClipboardImage: (bytes: ArrayBuffer, ext: string) =>
      ipcRenderer.invoke(IpcChannel.FilesSaveClipboardImage, bytes, ext),
    imageThumbnail: (path: string) =>
      ipcRenderer.invoke(IpcChannel.FilesImageThumbnail, path),
    openAttachment: (path: string) =>
      ipcRenderer.invoke(IpcChannel.FilesOpenAttachment, path),
    openInEditor: (chatId: string | null, path: string, line?: number) =>
      ipcRenderer.invoke(IpcChannel.FilesOpenInEditor, chatId, path, line),
    pickDirectory: (opts?: { title?: string; defaultPath?: string }) =>
      ipcRenderer.invoke(IpcChannel.FilesPickDirectory, opts),
  },
  apps: {
    open: (kind: 'terminal' | 'editor' | 'git' | 'unity', worktreePath: string) =>
      ipcRenderer.invoke(IpcChannel.AppsOpen, kind, worktreePath),
    running: () => ipcRenderer.invoke(IpcChannel.AppsRunning),
  },
  unity: {
    listVersions: () => ipcRenderer.invoke(IpcChannel.UnityListVersions),
    runningProjects: () => ipcRenderer.invoke(IpcChannel.UnityRunningProjects),
  },
  reviews: {
    list: () => ipcRenderer.invoke(IpcChannel.ReviewsList),
    getPr: (prNumber: number) => ipcRenderer.invoke(IpcChannel.ReviewsGetPr, prNumber),
    listRecent: () => ipcRenderer.invoke(IpcChannel.ReviewsListRecent),
  },
  repos: {
    list: () => ipcRenderer.invoke(IpcChannel.ReposList),
    create: (input: CreateRepoInput) => ipcRenderer.invoke(IpcChannel.ReposCreate, input),
    update: (input: UpdateRepoInput) => ipcRenderer.invoke(IpcChannel.ReposUpdate, input),
    delete: (id: string) => ipcRenderer.invoke(IpcChannel.ReposDelete, id),
    disconnectedSlots: () => ipcRenderer.invoke(IpcChannel.ReposDisconnectedSlots),
    reconnectSlots: () => ipcRenderer.invoke(IpcChannel.ReposReconnectSlots),
    countChats: (id: string) => ipcRenderer.invoke(IpcChannel.ReposCountChats, id),
    detectScm: (folder: string) => ipcRenderer.invoke(IpcChannel.ReposDetectScm, folder),
    detectP4Workspace: (folder: string) => ipcRenderer.invoke(IpcChannel.ReposDetectP4Workspace, folder),
    listSlotOccupants: (id: string) => ipcRenderer.invoke(IpcChannel.ReposListSlotOccupants, id),
    initializeOneSlot: (repoId: string, slotId: number) =>
      ipcRenderer.invoke(IpcChannel.ReposInitializeOneSlot, repoId, slotId),
    prepareGrow: (repoId: string, toCount: number) =>
      ipcRenderer.invoke(IpcChannel.ReposPrepareGrow, repoId, toCount),
    deleteOneSlot: (repoId: string, slotId: number) =>
      ipcRenderer.invoke(IpcChannel.ReposDeleteOneSlot, repoId, slotId),
    setSlotCount: (id: string, n: number) => ipcRenderer.invoke(IpcChannel.ReposSetSlotCount, id, n),
    basePreflight: (repoPath: string) => ipcRenderer.invoke(IpcChannel.ReposBasePreflight, repoPath),
    buildBase: (input: BuildBaseInput) => ipcRenderer.invoke(IpcChannel.ReposBuildBase, input),
    onBaseProgress: (cb: (message: string) => void) => {
      const listener = (_e: IpcRendererEvent, message: string) => cb(message);
      ipcRenderer.on(IpcChannel.ReposBaseProgress, listener);
      return () => ipcRenderer.removeListener(IpcChannel.ReposBaseProgress, listener);
    },
    onP4OpenProgress: (cb: (message: string) => void) => {
      const listener = (_e: IpcRendererEvent, message: string) => cb(message);
      ipcRenderer.on(IpcChannel.P4OpenProgress, listener);
      return () => ipcRenderer.removeListener(IpcChannel.P4OpenProgress, listener);
    },
  },
  sentry: {
    test: (input: { token: string; orgSlug: string }) =>
      ipcRenderer.invoke(IpcChannel.SentryTest, input),
  },
  slack: {
    test: (token: string) => ipcRenderer.invoke(IpcChannel.SlackTest, token),
  },
  linear: {
    test: (apiKey: string) => ipcRenderer.invoke(IpcChannel.LinearTest, apiKey),
    listIssues: () => ipcRenderer.invoke(IpcChannel.LinearListIssues),
    listProjects: (opts?: { apiKey?: string; teamKey?: string }) =>
      ipcRenderer.invoke(IpcChannel.LinearListProjects, opts ?? {}),
    getIssue: (identifier: string) =>
      ipcRenderer.invoke(IpcChannel.LinearGetIssue, identifier),
    listRecent: () => ipcRenderer.invoke(IpcChannel.LinearListRecent),
    listStates: (teamId: string) =>
      ipcRenderer.invoke(IpcChannel.LinearListStates, teamId),
    setIssueState: (issueId: string, stateId: string) =>
      ipcRenderer.invoke(IpcChannel.LinearSetIssueState, issueId, stateId),
    promoteIssue: (identifier: string) =>
      ipcRenderer.invoke(IpcChannel.LinearPromoteIssue, identifier),
  },
  jira: {
    test: (settings) => ipcRenderer.invoke(IpcChannel.JiraTest, settings),
    listProjects: (settings) => ipcRenderer.invoke(IpcChannel.JiraListProjects, settings),
  },
  github: {
    test: () => ipcRenderer.invoke(IpcChannel.GithubTest),
  },
  git: {
    status: (chatId: string) => ipcRenderer.invoke(IpcChannel.GitStatus, chatId),
    diff: (input: GitDiffInput) => ipcRenderer.invoke(IpcChannel.GitDiff, input),
    commit: (input: GitCommitInput) => ipcRenderer.invoke(IpcChannel.GitCommit, input),
    revert: (input: GitRevertInput) => ipcRenderer.invoke(IpcChannel.GitRevert, input),
    p4Login: (input: { chatId: string; password: string }) =>
      ipcRenderer.invoke(IpcChannel.P4Login, input),
    shelve: (input: { chatId: string; paths: string[]; message?: string; keepWorking?: boolean }) =>
      ipcRenderer.invoke(IpcChannel.GitShelve, input),
    unshelve: (input: { chatId: string; changes: string[] }) =>
      ipcRenderer.invoke(IpcChannel.GitUnshelve, input),
    deleteShelf: (input: { chatId: string; changes: string[] }) =>
      ipcRenderer.invoke(IpcChannel.GitDeleteShelf, input),
    filesInCommit: (input: GitFilesInCommitInput) =>
      ipcRenderer.invoke(IpcChannel.GitFilesInCommit, input),
    listBaseBranches: (input: { chatId?: string | null; repoId?: string | null }) =>
      ipcRenderer.invoke(IpcChannel.GitListBaseBranches, input),
    detectPr: (chatId: string) => ipcRenderer.invoke(IpcChannel.GitDetectPr, chatId),
    username: () => ipcRenderer.invoke(IpcChannel.GitUsername),
  },
  term: {
    open: (chatId: string, cwd: string, cols?: number, rows?: number) =>
      ipcRenderer.invoke(IpcChannel.TermOpen, chatId, cwd, cols, rows),
    write: (chatId: string, data: string) =>
      ipcRenderer.invoke(IpcChannel.TermWrite, chatId, data),
    resize: (chatId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IpcChannel.TermResize, chatId, cols, rows),
    onData: (handler: (event: { chatId: string; data: string }) => void) => {
      const listener = (_e: IpcRendererEvent, event: { chatId: string; data: string }) => handler(event);
      ipcRenderer.on(IpcChannel.TermData, listener);
      return () => ipcRenderer.removeListener(IpcChannel.TermData, listener);
    },
  },
  agent: {
    send: (input: SendMessageInput) => ipcRenderer.invoke(IpcChannel.AgentSend, input),
    stop: (chatId: string) => ipcRenderer.invoke(IpcChannel.AgentStop, chatId),
    configure: (input: ConfigureAgentInput) =>
      ipcRenderer.invoke(IpcChannel.AgentConfigure, input),
    approve: (input: ApprovePermissionInput) =>
      ipcRenderer.invoke(IpcChannel.AgentApprove, input),
    recover: (chatId: string) => ipcRenderer.invoke(IpcChannel.AgentRecover, chatId),
    listSessions: (chatId: string) => ipcRenderer.invoke(IpcChannel.AgentListSessions, chatId),
    setSession: (chatId: string, sessionId: string) =>
      ipcRenderer.invoke(IpcChannel.AgentSetSession, chatId, sessionId),
    validateSession: (chatId: string) =>
      ipcRenderer.invoke(IpcChannel.AgentValidateSession, chatId),
    restartWithContext: (chatId: string) =>
      ipcRenderer.invoke(IpcChannel.AgentRestartWithContext, chatId),
    backendsStatus: () => ipcRenderer.invoke(IpcChannel.AgentBackendsStatus),
    onEvent: (handler: (event: AgentEvent) => void) => {
      const listener = (_e: IpcRendererEvent, event: AgentEvent) => handler(event);
      ipcRenderer.on(IpcChannel.AgentEvent, listener);
      return () => ipcRenderer.removeListener(IpcChannel.AgentEvent, listener);
    },
  },
  updates: {
    onAvailable: (handler: (info: UpdateInfo) => void) => {
      const listener = (_e: IpcRendererEvent, info: UpdateInfo) => handler(info);
      ipcRenderer.on(IpcChannel.UpdateAvailable, listener);
      return () => ipcRenderer.removeListener(IpcChannel.UpdateAvailable, listener);
    },
    onProgress: (handler: (progress: UpdateProgress) => void) => {
      const listener = (_e: IpcRendererEvent, progress: UpdateProgress) => handler(progress);
      ipcRenderer.on(IpcChannel.UpdateProgress, listener);
      return () => ipcRenderer.removeListener(IpcChannel.UpdateProgress, listener);
    },
    onDownloaded: (handler: (info: UpdateReady) => void) => {
      const listener = (_e: IpcRendererEvent, info: UpdateReady) => handler(info);
      ipcRenderer.on(IpcChannel.UpdateDownloaded, listener);
      return () => ipcRenderer.removeListener(IpcChannel.UpdateDownloaded, listener);
    },
    install: () => ipcRenderer.send(IpcChannel.UpdatesInstall),
    check: () => ipcRenderer.invoke(IpcChannel.UpdatesCheck),
    onShowAbout: (handler: () => void) => {
      const listener = (): void => handler();
      ipcRenderer.on(IpcChannel.ShowAbout, listener);
      return () => ipcRenderer.removeListener(IpcChannel.ShowAbout, listener);
    },
  },
  notifications: {
    list: (limit?: number) => ipcRenderer.invoke(IpcChannel.NotificationsList, limit),
    unreadCount: () => ipcRenderer.invoke(IpcChannel.NotificationsUnreadCount),
    markAllRead: () => ipcRenderer.invoke(IpcChannel.NotificationsMarkAllRead),
    clearAll: () => ipcRenderer.invoke(IpcChannel.NotificationsClearAll),
    markRead: (id: string) => ipcRenderer.invoke(IpcChannel.NotificationsMarkRead, id),
    dispatch: (input: NotifyInput) => ipcRenderer.invoke(IpcChannel.NotificationsDispatch, input),
    onAdded: (handler: (rec: NotificationRecord) => void) => {
      const listener = (_e: IpcRendererEvent, rec: NotificationRecord) => handler(rec);
      ipcRenderer.on(IpcChannel.NotificationAdded, listener);
      return () => ipcRenderer.removeListener(IpcChannel.NotificationAdded, listener);
    },
  },
};

contextBridge.exposeInMainWorld('popbot', api);
