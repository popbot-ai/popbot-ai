*Languages: [English](../ARCHITECTURE.md) · [Español](../es/ARCHITECTURE.md) · [Français](../fr/ARCHITECTURE.md) · [Deutsch](../de/ARCHITECTURE.md) · [日本語](../ja/ARCHITECTURE.md) · [한국어](../ko/ARCHITECTURE.md) · **简体中文** · [Português (Brasil)](../pt-BR/ARCHITECTURE.md) · [Русский](../ru/ARCHITECTURE.md) · [Italiano](../it/ARCHITECTURE.md)*

# 架构

关于 Electron 进程模型以及各子系统所在位置的一份实用地图。关于"为什么"，参见 [POPBOT_DESIGN.md](POPBOT_DESIGN.md)。关于本文档中一切内容所依托的**对象图 + 生命周期 + 所有权规则**，参见 [CORE_MODEL.md](CORE_MODEL.md)——如果下文有任何地方让你感觉缺乏动机，请先读那一篇。

## 进程模型

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                         │
│  ─ Slot / worktree lifecycle — git worktrees or shado VHDX slots,    │
│    per-SCM clone/client setup, branch/changelist switching           │
│  ─ SCM provider registry — git + perforce behind one abstraction;    │
│    callers branch on CAPABILITIES, not provider id                   │
│  ─ Agent host — Claude AND Codex backends behind AgentBackend        │
│    (one session per chat); the canUseTool policy boundary            │
│  ─ Editor launcher + per-slot MCP glue — focus/launch Unity/Unreal/  │
│    custom editors; hand the agent its slot's editor MCP HTTP URL     │
│  ─ PTY manager — a persistent terminal per chat                      │
│  ─ Persistence — better-sqlite3 (transcripts, chat/slot/repo state,  │
│    prefs, SDK + Codex session caches)                                │
│  ─ External APIs — tickets (Linear / Jira / GitHub), reviews         │
│    (GitHub PRs / Helix Swarm), Slack, Sentry                         │
└────────┬─────────────────────────────────────────────────────────────┘
         │ contextBridge (typed IPC channels, `window.popbot.*`)
┌────────▼─────────────────────────────────────────────────────────────┐
│ Renderer (Chromium + React + Tailwind)                               │
│  ─ App shell, panels, chat columns, settings sheets, modals          │
│  ─ Subscribes to agent event streams over IPC                        │
│  ─ Sends user actions (approve permission, send message, ...) back   │
│  ─ Owns nothing the main process needs to recover after a renderer   │
│    crash; renderer is a view layer                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**规则：** 渲染进程永远不直接接触文件系统，永远不派生子进程，也永远不持有权威状态。这些都属于主进程的职责。渲染进程只负责订阅事件并派发意图。

## 源码目录结构

```text
src/
├── main/                       # Electron main process — Node, no DOM
│   ├── index.ts                # entry; createWindow, app lifecycle, handler wiring
│   ├── ipc/                    # typed IPC handlers, one module per subsystem
│   │                           #   (agent, apps, chats, files, git, notifications,
│   │                           #    repos, reviews, sentry, settings, slack, term, tickets)
│   ├── agents/                 # AgentBackend interface + ClaudeBackend + CodexBackend
│   │                           #   + StubBackend; AgentHost, SDK/Codex session stores,
│   │                           #   CLI probes, recovery
│   ├── scm/                    # source-control provider registry + base class;
│   │                           #   gitProvider, perforceProvider, detect
│   ├── git/                    # git plumbing: worktrees, chat paths, reviews (gh PRs)
│   ├── p4/                     # Perforce: exec, client/workspace, file watcher,
│   │                           #   Swarm client + swarmReviews
│   ├── shado/                  # bundled shado VHDX CLI wrapper: base, slots, client
│   ├── tickets/                # ticket-source registry + linear/jira/github sources
│   ├── reviews/                # provider-agnostic Reviews orchestrator (groups by SCM)
│   ├── linear/                 # Linear API client
│   ├── jira/                   # Jira Cloud API client
│   ├── github/                 # GitHub (`gh` CLI) client
│   ├── slack/                  # Slack client + DM/@mention/channel poller
│   ├── sentry/                 # Sentry client + issue poller
│   ├── notifications/          # in-app notification classify + dispatch
│   ├── term/                   # per-chat PTY manager (node-pty)
│   ├── attachments/            # chat attachment (image/file) retention store
│   ├── persistence/            # better-sqlite3 schema (migrations) + typed queries
│   └── updates/                # electron-updater auto-update + on-demand check
├── preload/
│   └── index.ts                # contextBridge — exposes the typed `window.popbot` API
├── renderer/src/               # React UI
│   ├── main.tsx                # ReactDOM.createRoot mount
│   ├── App.tsx
│   ├── components/             # FLAT dir — panels (PanelA/B/D), chat column, dialogs,
│   │                           #   sheets, git/P4 panels, modals, primitives
│   ├── lib/                    # client-side hooks + buses (useChats, useReviews,
│   │                           #   agentEventBus, …); calls `window.popbot.*`, no Node
│   ├── styles/                 # Tailwind layer + ported styles
│   ├── assets/                 # engine / SCM / notification icons
│   └── fixtures/               # static sample data for dev
└── shared/                     # types/contracts shared across the bridge
    ├── ipc.ts                  # IPC channel names, payload types, the PopBotApi surface
    ├── domain.ts               # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## IPC 契约

所有 IPC 都在 [`src/shared/ipc.ts`](../../src/shared/ipc.ts) 中集中定义类型——包括 `IpcChannel` 字符串映射表、请求/响应负载类型，以及预加载脚本桥接暴露的 `PopBotApi` 接口。约定如下：

- 每个通道名称都带有 **`pb:` 前缀**，并按子系统分命名空间（`pb:chats:create`、`pb:agent:event`、`pb:reviews:list-for`）。完整列表参见 `IpcChannel` 常量。
- **请求/响应**使用 `ipcRenderer.invoke` + `ipcMain.handle`。返回值均有类型。处理程序按子系统在 `main/ipc/*` 中注册，并在 `main/index.ts` 中完成接线。
- **推送事件**（智能体流、PTY 数据、通知、更新进度、窗口最大化）使用 `webContents.send` + `ipcRenderer.on`。渲染进程负责订阅，主进程负责推送。
- **组件中不允许出现原始 IPC 调用。** 预加载脚本（`src/preload/index.ts`）暴露了带类型的 `window.popbot.*` 桥接接口；渲染进程代码通过 `renderer/src/lib/` 中的钩子/事件总线（`useChats`、`useReviews`、`agentEventBus` 等）来访问，而不是直接调用 `ipcRenderer`。

## 用代码术语描述"卡槽"

卡槽（slot）并不是单一的一个结构体；它是一个**编号租约**（`slot_id`），加上该租约所指向的磁盘上的工作树/克隆副本。租约状态保存在聊天记录行上
（`persistence/` 中的 `chats.slot_id`、`chats.worktree_path`），空闲卡槽的计算方式是对某个仓库当前持有卡槽的已打开聊天进行查询——一个仓库的
卡槽池大小就是 `repos.slot_count`。`shared/domain.ts` 中携带着一个小型的共享枚举，以及一个遗留的 `Slot` 记录类型：

```ts
export type SlotState = 'free' | 'leased' | 'degraded' | 'creating';

// NOTE: this `Slot` interface is currently unused by the running code
// (only SlotState + ChatStatus are imported). It still names Unity
// specifically; the live model has generalized past that — the editor is
// engine-agnostic (Unity/Unreal/custom) and isn't a supervised child with a
// tracked pid, so treat this shape as legacy, not authoritative.
export interface Slot {
  id: number;
  worktreePath: string;
  branch: string | null;
  ports: { mcp: number; server: number };
  unityPid: number | null;
  serverPid: number | null;
  state: SlotState;
  pinnedBranch?: string;
  cleanOnRelease?: boolean;
}
```

卡槽的租用/释放/协调逻辑分散在 `git/worktrees.ts`（git 工作树）、
`shado/slots.ts` + `scm/*Provider.ts`（VHDX 卡槽 + 各 SCM 的克隆/客户端设置），
以及 `ipc/repos.ts` + `ipc/chats.ts` 的处理程序中。关于租约策略，参见
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit)；关于一个聊天的工作
如何跨卡槽保持连续性，参见下文的**跨卡槽连续性**一节。

## 热备卡槽存储：shado VHDX 写时复制

对于 3A 级规模的项目树（0.5–1 TB 的 Perforce 游戏项目仓库），一个卡槽不可能是一个
`git worktree` 或一份完整检出——你无法把项目仓库拷贝 N 份，而一次冷同步加构建又要耗时数分钟到数小时。**shado**（一个内置的 Go 语言 CLI 工具，位于配套仓库
`github.com/popbot-ai/shado`，通过 `main/shado/` 调用）在 Windows 上提供了这套存储底层：

- **灌满并冻结一个基础镜像。** `shado create <repoPath>` 会把仓库文件夹同步/复制到一个可扩展的 VHDX 中，然后将其冻结为**只读**状态。该基础镜像不仅包含完整的项目树，还包含热备的派生状态（构建缓存、`node_modules`、`Intermediate/`、`Saved/`、`DerivedDataCache/` 等）。
- **差异化子镜像即卡槽。** 每个卡槽都是从冻结的基础镜像派生出的一个写时复制 VHDX 子镜像（`shado clone create --slot N`），通过 `Mount-VHD` + `Add-PartitionAccessPath` 挂载到一个**挂载点文件夹**（而不是盘符，这样才能扩展到约 20 个卡槽以上）。一个全新的、可直接构建的卡槽只需几秒钟和几 GB 的增量数据，而不是一次 1 TB 的重新同步加冷构建。重置操作 = 销毁子镜像 + 从基础镜像重新创建（瞬间恢复干净状态）。
- **布局。** 卡槽存放在**与仓库相同的驱动器**上（VHDX 模型要求如此）：`<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`；基础镜像 + 差异数据 + 卡槽元数据则位于
  `…/workspaces/<repoId>/shado` 之下（`SHADO_HOME`）。路径的推导逻辑位于 `main/shado/client.ts`
  （`popbotRootForRepo`、`shadoHomeForRepo`）。
- **提权。** `shado create` / `clone create` / `remount` / `restore` 需要管理员权限；PopBot 本身以非提权方式运行，因此这些操作会通过一次 UAC 弹窗统一发起（临时 `.bat` 文件 + `Start-Process -Verb RunAs`）。以提权方式创建出的克隆副本最终归属于 Administrators 组 → 因此每次调用 git 都要带上 `-c safe.directory=*`，p4 客户端也被锁定到特定主机。
- **重启。** VHDX 挂载在重启后无法保留（会出现分离的克隆副本 + 损坏的挂载点重解析文件夹）。应用启动时我们会检测断开连接的卡槽仓库，并显示一个**居中弹窗**（"重新连接"），用户点击后，一次 UAC 就能重新挂载全部卡槽（`remountReposElevated`）。参见 `main/shado/base.ts`。

git 工作树这条路径（在非 shado 仓库上 `repo.mode = 'slots'`）仍然存在，
供普通仓库使用；shado 是针对 VHDX/Perforce 场景按仓库单独选用的。

### 按 SCM 类型划分的卡槽设置

一个卡槽是一个**独立的克隆/客户端**，而不是一份共享的检出——这正是下文
跨卡槽连续性问题背后的关键事实。

- **git**（`scm/gitProvider.ts`）：卡槽是冻结基础镜像的一份完整克隆。
  `ensureSlotWorktree` 会将其停放在 `popbot/slot-N` 上；`checkoutBranch` 会基于**最新**的基线
  （`fetch origin` → `checkout -f -B branch origin/<base>` → `clean -fd`）创建该聊天的分支，
  丢弃从基础镜像继承来的脏数据，同时保留被 gitignore 忽略的热备缓存。
- **perforce**（`p4/*`、`scm/perforceProvider.ts`）：每个卡槽都有自己的 p4
  客户端 `popbot_<repoId>_slot<N>`，根目录挂载在该挂载点上。设置流程是 `p4 flush
  @baseChangelist`（针对冻结基线的 0 字节 have 表更新）+ 只 `p4 sync` 基线到最新版本之间的增量。
  这里**没有 `p4 reconcile`**（在游戏项目仓库上要花 20 分钟遍历整棵树）：每个卡槽都有一个
  `fs.watch` 记录发生变化的路径，提供方只针对这些路径执行有针对性的
  `p4 edit/add/delete`。PopBot 自身的写操作（sync/revert/unshelve）会**暂停**这个监听器，
  以免这些操作被重复记录。

## 跨卡槽连续性：聊天的分支/变更列表归宿

**问题。** 因为每个卡槽都是一个独立的克隆（git）/客户端（perforce），
一个聊天的分支或待处理变更列表**只存在于创建它的那个卡槽中**。聊天从共享池中借用卡槽，
并可能在*另一个*卡槽上重新打开——而那个卡槽上并不存在这份工作。（旧的 `git worktree` 模型
没有这个问题：所有工作树共享同一个 `.git`，所以分支是集中管理的。）

**解决方案。** 在关闭时，把一个聊天的工作汇总到一个与卡槽无关的**归宿位置**，
并在重新打开时恢复它。这通过 `SourceControlProvider.persistChatOnClose`
/ `restoreChatOnReopen` 挂钩实现，由 `ChatsClose` / `ChatsReopen` 处理程序
（`ipc/chats.ts`）调用，取代了旧的卡槽本地暂存方式。持久化在聊天记录上的状态：
`chats.p4_shelf_cl`（perforce 专用；git 不需要）。

- **git → 本地根仓库（LOCAL ROOT repo）。** 归宿位置是 `repo.repoPath`——所有卡槽克隆自的那个
  磁盘上的仓库文件夹——它被作为一个 `root` 远程仓库添加到每个卡槽中
  （`origin` 仍然指向真实的 GitHub 远程仓库，用于 PR）。
  - *关闭时：* 把未提交的工作打包成一个一次性的 `[Soft committed unstaged
    files]` 提交（除非用户选择丢弃），然后 `git push -f root <branch>`。
    本地根仓库会积累每个聊天的分支（其分支列表 = 旧的共享工作树行为）。
  - *重新打开时：* 在基线检出之后，执行 `git fetch root <branch>` → `checkout -f
    -B branch FETCH_HEAD` → 软撤销那个 WIP 提交，让编辑内容恢复为未提交状态。
- **perforce → 作为搁置区（shelf）的根客户端（ROOT CLIENT）。** 一个待处理的变更列表是按卡槽存在的，
  因此归宿位置是一个由稳定、从不同步的按仓库根客户端 `popbot_<repoId>_root` 所拥有的服务器端**搁置区**
  （`ensureRootClient`——只有规格定义，不做同步）。
  - *关闭时：* 对卡槽的变更列表执行 `p4 shelve`，然后用 `p4 reshelve -f` 把它转移到该聊天
    根客户端所拥有的变更列表上。**`reshelve` 是在服务器端转移搁置内容**——已在 Helix 2025.2 上验证：
    可跨客户端操作，无需工作区同步，也不会向根客户端的磁盘写入任何内容（"转移搁置内容，而不修改文件"）。
    然后删除卡槽的搁置内容 + 已打开的文件 + 变更列表，让该卡槽变得**空空如也**；根客户端拥有每个聊天对应的
    一个已搁置的变更列表。
  - *重新打开时：* 执行 `p4 unshelve -s <rootCl> -c <newSlotCl>`，将内容取消搁置到新卡槽的全新
    变更列表中（监听器暂停），同时保留根搁置区作为已停放的备份。

净效果：卡槽是可互换的临时空间；本地根 git 仓库和根 p4 客户端才是进行中工作
持久、用户可见的归宿。

## 智能体后端

`AgentBackend`（`main/agents/types.ts`）是 `AgentHost` 和一个具体后端之间的接口。**目前有两个真实的后端**——`ClaudeBackend`（封装
`@anthropic-ai/claude-agent-sdk`）和 `CodexBackend`（封装 `@openai/codex-sdk`）
——外加一个用于测试的 `StubBackend`。一个聊天会选择自己的后端（`chats.agent`），并且
可以切换；因为这两个 SDK 有着不同的原生恢复句柄、模型和推理强度设置，这些数据是按
**提供方分别存储**的（Claude 的 `session_id` +
`claude_model`/`claude_reasoning_effort`；Codex 的 `codex_thread_id` +
`codex_model`/`codex_reasoning_effort`）。`AgentHost` 负责选择后端、为每个聊天派生
一个会话，并把每个会话的 `AgentEvent` 重新广播给渲染进程和持久化层。

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

每个卡槽的编辑器 MCP 会在派生时交给后端：`SpawnOpts.mcpServers`
携带该聊天的 Unity/Unreal 编辑器端点（`{ type: 'http', url }`），
在 SDK 选项中以内存方式注册——不会写入磁盘任何内容。只有具备
`mcpHttp` 能力的后端才会使用它。参见下文的**每卡槽编辑器 MCP**一节。

`canUseTool` 回调紧邻后端而存在，而不是写在智能体提示词里——它是我们硬性一票否决的安全边界。规则解析（`resolveRule`）会先查询按聊天设置的规则，再查询全局权限规则，然后才会提示用户。参见 [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md)。

## 持久化

- **`better-sqlite3`**，位于 `<userData>/popbot.db`（macOS：`~/Library/Application
  Support/PopBot/`；Windows / Linux 上通过 `app.getPath('userData')` 得到的对应各操作系统路径）。数据库模式（schema）是 `persistence/db.ts` 中一份编号的迁移列表
  （以 `user_version` 为门控，每一步都是原子操作）。当前的表包括：
  - `chats` — 每个聊天一行：卡槽租约（`slot_id`）、`worktree_path`、`repo_id`、
    当前使用的 `agent`、按提供方区分的模型/推理强度以及恢复句柄（`session_id`、
    `codex_thread_id`）、`permission_rules`，以及跨卡槽状态（`p4_shelf_cl`）。
  - `messages` — 每个智能体事件一行（持久化的记录本体）。
  - `repos` — 按仓库的配置（路径、颜色、卡槽前缀、默认基线、卡槽数量、
    `mode` = `slots`/`ephemeral`、`scm`、`p4_config` JSON）。
  - `settings` — JSON 键值形式的应用偏好设置（集成凭据引用、UI 偏好）。
  - `notifications` — 应用内通知信息流。
  - `sdk_session_entries` — Claude SDK 会话存储（SessionStore）的底层表（以聊天为键；
    PopBot 拥有这份恢复副本，因此恢复会话不依赖于 `~/.claude` 的 JSONL 文件）。
  - `codex_thread_events` — Codex 原始流事件的持久化缓存（Codex 本身从
    `~/.codex/sessions` 恢复；这是 PopBot 自己的恢复/诊断副本）。

  这里**没有**工单/PR 缓存*表*：工单和评审队列是缓存在渲染进程中的
  （参见 `list-recent` IPC 的相关注释），而不是在 SQLite 中。
- **每卡槽的临时数据**存放在该卡槽的工作树/挂载点，以及每个聊天的运行时
  目录中（智能体 CLI 的会话文件、PTY、保留的附件）。shado VHDX 卡槽存放
  在该仓库所在驱动器上的 `…/popbot/workspaces/<repoId>/…` 之下（参见 shado 一节）。
- **敏感信息**通过 `keytar` 存储（操作系统密钥链——macOS Keychain / Windows Credential
  Vault / libsecret）。绝不会存入 SQLite 数据库，也绝不会出现在日志中。

## 工单来源、SCM 提供方、评审、编辑器、更新

五个提供方接缝，是各顶层子系统所依托的基础——全部设计成让新增一个后端只需局部改动，
而调用方始终保持通用：

- **工单来源**（`tickets/`）。一个活跃的 `TicketSource` 为工单队列提供数据，
  通过 `tickets/registry.ts` 由 `ticketSource` 设置项选定（Linear /
  Jira / GitHub；默认为 Linear）。每个来源都会规范化为共享的 Linear
  DTO，因此渲染进程通过同一条路径渲染所有任务跟踪系统，只根据
  `shared/ticketProvider.ts` 中定义的能力（capabilities）做分支判断，从不根据提供方 id。新增
  一个任务跟踪系统，只需在注册表中加一行，外加一个 `*Source.ts` 文件和一个描述符。
- **SCM 提供方**（`scm/provider.ts`、`scm/index.ts`）。`SourceControlProvider`
  是这个小型的通用接口（工作区生命周期、工作树评审、PR/评审检测、
  跨卡槽连续性）。`GitProvider` 和 `PerforceProvider` 是真实实现；
  `lore` 只是初步搭建。`scm/index.ts` 会按 id 返回对应的一个实例。**调用方永远根据
  能力（`shared/sourceControl.ts`）做分支判断，绝不根据提供方 id**——任何
  无法干净抽象的行为都会变成一个能力标志位，而一个差异过大的提供方
  可以通过 `capabilities.nativeClientUi` 选择接入自己的客户端窗口。
- **评审**（`reviews/`、`git/reviews.ts`、`p4/swarmReviews.ts`）。一个
  不依赖具体提供方的编排器会按 SCM 对已配置的仓库分组，并派发给
  各提供方自己的评审方法（受 `capabilities.pullRequests` 门控），把
  GitHub PR 和 Helix Swarm 评审合并到同一个面板中。每个提供方都拥有自己的**轮询节奏**
  （`reviewPollIntervalMs`——Swarm 比 GitHub 慢，以保护共享的 p4d 服务器），
  该面板为每个提供方运行一个独立的定时器（`pb:reviews:providers` /
  `pb:reviews:list-for`）。
- **每卡槽编辑器 MCP**（`ipc/apps.ts`、`shared/gameEngine.ts`）。各引擎
  （Unity / Unreal / 自定义）可以独立启用。当 `useMcp` 开启时，每个
  卡槽的编辑器都会以一个**专属 MCP 端口**（`mcpBasePort + (slotId-1)`）启动，
  确保并行的编辑器不会冲突，`mcpEndpointForChat` 会在派生会话时把该卡槽编辑器的 MCP
  HTTP URL 交给智能体。编辑器以**分离（detached）**方式启动（聚焦或
  启动），而不是作为受监管的长期存活子进程。
- **更新**（`updates/`）。electron-updater 自动更新，并为未签名构建提供手动下载
  兜底方案，此外还为"关于"对话框提供一个按需检查功能
  （`pb:updates:*`）。

## 横切关注点

- **日志记录** — 主进程通过 `diagLog`（`dlog`）写入诊断日志；智能体 CLI
  和 PTY 各自携带自己每个聊天的运行时输出；渲染进程的日志通过 IPC
  经由主进程路由。
- **启动时恢复** — 恢复过程由数据库和会话状态驱动，而不是基于 PID 文件
  （`main/index.ts` 的启动流程）：`initDb()` 运行待执行的迁移；
  `clearStaleRunningStatuses()` 会把任何仍处于 `run` 状态的聊天翻转回 `idle`
  （上一次运行的智能体会话已经不存在了）；会话存储导入 + SDK 项目目录
  迁移 + `sessionPinRepair` + `recoverChatSessions` 会将固定的
  Claude/Codex 会话与磁盘上的实际情况进行核对；CLI 探测程序会报告
  哪些后端在线。在 Windows 上，断开连接的 shado VHDX 卡槽（因重启而
  丢失挂载）会被检测出来，并提示用户进行一次 UAC 重新挂载（参见上文
  shado 一节的**重启**说明）。
- **更新** — electron-updater 自动更新；参见上文的**更新**提供方一节。
