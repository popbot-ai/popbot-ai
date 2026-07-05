*Languages: [English](../POPBOT_DESIGN.md) · [Español](../es/POPBOT_DESIGN.md) · [Français](../fr/POPBOT_DESIGN.md) · [Deutsch](../de/POPBOT_DESIGN.md) · [日本語](../ja/POPBOT_DESIGN.md) · [한국어](../ko/POPBOT_DESIGN.md) · **简体中文** · [Português (Brasil)](../pt-BR/POPBOT_DESIGN.md) · [Русский](../ru/POPBOT_DESIGN.md) · [Italiano](../it/POPBOT_DESIGN.md)*

# PopBot 设计

一个面向 AutoRPG 的多智能体开发编排器。灵感来自 Conductor；增加了游戏内测试基础设施，让智能体可以启动真实的游戏、点击浏览，并验证其行为。

> **状态：** 设计——锁定于 2026-05-01。这是一份活文档；在实现过程中如有发现，请就地更新。
>
> **请先读这一篇：** [USER_STORIES.md](USER_STORIES.md) 定义了这份设计所要交付的六项成果。当本文档与用户故事发生冲突时，以用户故事为准，本文档需据此更新。

## 目标

1. 并行运行多个 AI 开发智能体，每个都在自己的 git 工作树中。
2. 让智能体驱动真实的游戏（有窗口的 Unity 编辑器）进行端到端测试。
3. 在一个窗口中呈现工单/PR/Slack 队列、会话历史记录、日志和终端。
4. 默认自主运行；只在真正阻塞性的事件上暂停。

## 非目标（v1）

- 生产环境 CI/CD（属于独立的关注点）
- 跨平台支持（仅限 macOS；后续如有需要再支持 Linux/Windows）
- 多用户 / 单点登录（每台机器单一开发者）

## App layout

```text
┌──────────────┬─────────────────────────────────────────────┐
│ Tickets │ PRs│  ┌──┐ ┌──┐ ┌──┐ ┌──┐  Thumbnails (zoom-out)│
│   ENG-...    │  └──┘ └──┘ └──┘ └──┘                       │
│   ENG-...    ├─────────────────────────────────────────────┤
│   ENG-...    │                                             │
├──────────────┤  ┌────────┐  ┌────────┐  ┌────────┐        │
│ Chats        │  │ chat-1 │  │ chat-2 │  │ chat-3 │  + new │
│   live...    │  │        │  │        │  │        │        │
│   ──────     │  │        │  │        │  │        │        │
│   inactive   │  │        │  │        │  │        │        │
│              │  └────────┘  └────────┘  └────────┘        │
├──────────────┴─────────────────────────────────────────────┤
│ Logs ▼  Terminal  ...                                      │
│ [Unity] [Server]   (active chat's streams, sync-scroll)    │
└────────────────────────────────────────────────────────────┘
```

左上方标签页：**Tickets**（分配给我的 Linear 工单）和 **Reviews**（请求我评审的 PR）。点击一行 → 生成一个以该工作为初始上下文的聊天。

## Slots — the durable unit

一个卡槽 = 一个 git 工作树 + 它的 Library + （可选）它正在运行的 Unity 编辑器 + （可选）它正在运行的边车服务器。**卡槽很少被创建，会被持续复用。**

### 每卡槽的目录结构

```text
~/Library/Application Support/PopBot/slots/
├── slot-1/
│   ├── worktree/                    git worktree (persistent)
│   │   ├── Library/                 ~8 GB, lives here, slot owns it
│   │   ├── Assets/                  ~5.5 GB
│   │   └── ...
│   ├── server-data/                 sidecar's DB (local mode only)
│   ├── ports.json                   { mcp: 17901, server: 5101 }
│   ├── unity.log
│   ├── server.log
│   └── slot.json                    { branch, leasedBy, lastLeaseAt, unityPid?, serverPid? }
└── slot-2/...
```

### 实际耗时数据（于 2026-05-01 在 AutoRPG 上测得）

| 操作 | 耗时 |
|---|---|
| `git worktree add`（全新，6.2 万个文件，含 LFS smudge） | 约 23 秒 |
| Library 从 master 进行 COW 复制（APFS clonefile） | 约 1 秒 |
| 在某个卡槽上首次启动 Unity（冷 Library） | 1-3 分钟 |
| 粘性命中（Unity 已在运行，处于空闲） | 约 50 毫秒 |
| 冷启动（Unity 关闭，分支匹配） | 15-30 秒 |
| 在已有卡槽中切换分支（增量 + Unity 重新加载） | 5-15 秒 |
| 卡槽创建总耗时（添加工作树 + COW + 首次导入） | 约 1-3 分钟，**很少发生** |

### 磁盘预算

每个卡槽约 14 GB（8 GB Library + 5.5 GB Assets + 临时空间）。4 个卡槽 = 约 55 GB。共享的 `.git`（约 8 GB）只计算一次。

### 租约策略

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### 分支唯一性

Git 拒绝在两个工作树中检出同一个分支。解决方式如下：
- **精简（Lite）/评审聊天**使用分离 HEAD（不会产生冲突）。
- **两个测试聊天使用同一个分支**——第二个会使用临时分支（`<branch>-slot-N`）或分离 HEAD；PopBot 的调度器会自动选择。

### 检出前的安全检查

在某个已有卡槽中进行任何分支切换之前：

1. `git stash --include-untracked`（始终执行；作为安全网）。
2. 如果存在智能体拥有的未暂存提交，则拒绝执行；先提交，否则报错终止。
3. 关闭任何打开的 Unity 场景（避免跨分支的 GUID 解析问题）。
4. `git checkout <branch>`。
5. 如适用，弹出暂存内容，或从按分支记录的暂存中恢复。

### 每卡槽的策略开关（位于偏好设置中）

- `pinnedBranch?` — 拒绝其他分支的租用请求；主工作卡槽。
- `cleanOnRelease: bool` — 释放时执行 `git clean -fd && git checkout .`；默认关闭。
- `autoStashOnSwitch: bool` — 默认开启。

## 资源预算（相互独立的开关）

卡槽和活跃的 Unity 实例是**相互独立的预算**。一个卡槽即便其 Unity 已关闭也可以继续存在——那种情况下它只是占用存储空间而已。运行中的 Unity 受内存限制，且可以独立调节。

| 预算 | 单位成本 | 默认值 | 用户偏好设置 |
|---|---|---|---|
| **卡槽数量**（磁盘上的工作树） | 约 14 GB | 2-4 | 偏好设置："Slots" |
| **最大活跃 Unity 数**（正在运行的进程） | 约 3-4 GB 内存 | 2 | 偏好设置："Max active Unity" |
| **Unity 硬性上限**（自主模式自动批准的上限） | — | 计算得出：`floor(systemRAM / 4 GB)` | 偏好设置："Unity hard cap" |

### 租约策略（扩展版）

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### 智能体发起的容量上调

一个新的 MCP 工具，在智能体因 Unity 容量而受阻时可用：

| 工具 | 模式 | 返回值 |
|---|---|---|
| `request_unity_capacity` | 同步 | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

行为：

- **交互式聊天** → 聊天变为黄色，横幅提示用户批准。
- **自主聊天** → 自动批准，直到达到 `Unity hard cap`；超过该上限则暂停等待人工处理。
- 用户也可以随时在偏好设置中主动调高/调低。调低会驱逐 LRU 空闲的 Unity 实例（绝不会驱逐正忙碌的实例）。

## Chat types

| 类型 | 卡槽 | Library | Unity | 边车服务器 | 启动耗时 | 内存 |
|---|---|---|---|---|---|---|
| **精简（Lite）**（评审、规划、分诊） | 可选 | — | — | — | 约 1-2 秒 | 约 50-100 MB |
| **客户端测试** | 必需 | 由卡槽持有 | 第二屏幕上的 GUI | 本地或远程 | 50毫秒-30秒 | 约 2-4 GB |
| **服务器测试** | 必需 | 由卡槽持有 | 第二屏幕上的 GUI | 始终本地 | 50毫秒-35秒 | 约 2-5 GB |

新聊天的默认类型：**精简**。只有当确实需要进行游戏测试时才升级。

## 服务器模式

按聊天设置的选项；可随时切换。

| 模式 | 服务器来源 | 使用场景 |
|---|---|---|
| `local`（默认） | 每卡槽的 `./run_local.sh --port <P> --data-dir <D>` | 日常智能体运行；后端改动；确定性状态 |
| `remote-dev` | 共享的远程开发服务器 | 纯客户端迭代；漂移检测把关准入 |

### 漂移检测

在接受 remote-dev 租约之前：PopBot 会在本地读取 `Assets/Scripts/Simulation/GameDataHash.cs` 常量 + DTO 版本；对远程服务器的 `/health` 发起 GET 请求；进行比较。不匹配 → 以结构化错误拒绝该租约。

### `/health` 返回内容

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### 会话中途切换

用户在聊天设置中切换 `Server Mode`；PopBot 会：

1. 进行漂移检查（如果切换到 remote-dev）。不匹配则拒绝。
2. 按需停止/启动边车进程。
3. 通过 MCP 调用 `client_set_server_endpoint { url }`——运行时重新指向。
4. 强制在游戏内重置会话（登出/回到标题界面）——旧的身份验证已失效。
5. 取消进行中的任务，显示横幅："server changed, restart task."

## 每聊天设置面板

| 设置项 | 默认值 | 备注 |
|---|---|---|
| 模式 | `Interactive` | `Autonomous` = 自动批准安全操作，真正卡住时才暂停 |
| 服务器模式 | `local` | `remote-dev`（经过漂移检查） |
| 窗口模式 | `GUI on screen 2` | `Headless`（后续支持，选择性启用）/ `Visible` |
| 时间缩放 | `1.0` | 加速动画播放 |
| 游戏视图分辨率 | `1920×1080` | 固定分辨率，便于截图可复现 |
| 每个动作自动截图 | 关闭 | 用于生成证明产物 |
| 详细日志 | 关闭 | 在调试智能体本身时切换开启 |
| 智能体后端 | `claude` | `codex`（第 4 阶段） |
| 默认测试夹具 | 无 | 用一份存档数据启动 |
| Token 预算 | `1M` | 达到上限时暂停（自主模式） |
| 时间预算 | `60m` | 达到上限时暂停（自主模式） |
| 循环检测 | 开启 | 出现 N 次相同工具调用/K 分钟内无进展时暂停 |

## Autonomous mode

### 策略引擎——接入 `canUseTool`

不要把策略埋在提示词里；模型可以自我说服绕过它。使用 SDK 提供的硬性一票否决钩子。

**在自主模式下自动批准（静默执行）：**

- 卡槽工作树内的 Read / Edit / Write / Grep / Glob
- 工作树内的 Bash（受下方拒绝清单约束）
- 对卡槽自身 MCP 服务器的 MCP 调用
- 技能（Skill）/子智能体调用
- TodoWrite、内部 SDK 操作

**始终暂停等待人工处理（即使在自主模式下）：**

- `git push`、`git reset --hard`、`git checkout --`、任何强制操作、删除分支
- 卡槽工作树路径之外的任何操作
- 对未列入白名单主机的网络调用
- `tmp/` 或卡槽目录之外的 `rm -rf`
- `gh pr create` 以及任何 GitHub 发布类操作
- Slack / 邮件 / 外部消息发送
- 修改 `~/.claude`、`.mcp.json`、系统配置

### "真正卡住"检测

**智能体自我报告**（通过 SDK 的 `message_done` 结构）：

- 提出澄清性问题
- 明确表示遇到阻塞
- 表明"我完成了"

**PopBot 监控**（纵深防御）：

- 循环——连续 N 次相同的工具调用
- 停滞——K 分钟内没有进展事件
- Token/时间预算超支
- 重复的测试失败（同一失败出现 K 次）

### Status colors (chat thumbnail)

| 颜色 | 状态 |
|---|---|
| 蓝色 | 运行中 |
| 绿色 | 任务完成 |
| 黄色 | 已暂停——需要用户处理 |
| 红色 | 出错 |
| 灰色 | 空闲/尚未开始 |

在自主模式下，你只需扫视缩略图寻找**黄色**。其他一切都没问题。

## MCP automation surface

### 规则：每个工具都在约 100 毫秒内返回

耗时较长的操作会立即返回 `{ jobId }`；智能体轮询查询结果。永远不要让 MCP HTTP 监听器阻塞超过 100 毫秒。

### 任务基础设施

| 工具 | 模式 | 返回值 |
|---|---|---|
| `job_status` | 同步 | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | 同步 | 该工具的完整负载；同时销毁该任务 |
| `job_cancel` | 同步 | 设置协作式取消标志 |
| `job_list` | 同步 | 活跃 + 近期任务（TTL 约 60 秒） |

协程通过 `EditorCoroutineUtility.StartCoroutineOwnerless` 运行，由 `EditorApplication.update` 驱动。`JobContext` 暴露了 `SetProgress(float, msg)`、`Canceled`、`SetResult(JObject)`、`Fail(error)`。

### 工具目录——第 1 阶段最低要求

**生命周期：**

- `play_status`（同步）、`play_pause` / `play_resume` / `play_step`（同步）、`time_scale_set`（同步）
- `play_enter`（任务）、`play_exit`（同步）
- `editor_quit`（同步）

**观察：**

- `screenshot`（同步）——写入到 `Library/MCP/Screenshots/{session}/{label}.png`，返回路径
- `game_state_summary`（同步）——屏幕堆栈顶部、货币、等级、章节、已装备物品、已解锁内容、最近 10 条错误
- `screen_stack`（同步）、`chapter_status`（同步）
- `ui_tree`（同步）——带已解析 `text-loc` 的层级结构
- `ui_query`（同步）——类似 CSS 的选择器（`.btn`、`#Confirm`、`[text-loc=Friends.Title]`）

**操作：**

- `ui_click`（同步）、`ui_click_by_loc`（同步）——通过 `panel.SendEvent` 触发 `PointerDown/Up/ClickEvent`

**同步/等待：**

- `wait_until`（任务）——支持的判定条件：`screen`、`log`、`event`、`path`
- `wait_for_idle`（任务）

**日志（在现有基础上扩展）：**

- `console_get_logs` — 增加 `sinceTimestamp`、`dedupe`、`dumpTo`、`includeStack: "none"|"first"|"all"`
- `server_logs`（同步）——追踪 PopBot 的 `server.log`，结构与 `console_get_logs` 相同
- `server_health`（同步）、`client_set_server_endpoint`（同步）

**会话：**

- `mcp_session_start` / `mcp_session_end` — 在 `tmp/mcp-sessions/{slug}/` 生成可预测的产物目录

### 工具目录——后续阶段

- `command_apply`、`command_list` — 绕开 UI 的主要操作接口
- `save_blob_get` / `save_blob_load`，测试夹具管理
- `crash_dump`、`ui_dump_uxml`、`ui_drag`、`events_pop`、`gameview_resolution_set`
- `game_state_path` — 基于反射的读取器，带有白名单允许的根路径

## 窗口管理

默认：GUI 编辑器，窗口位置由一个原生辅助程序放置。

**原生 macOS 窗口移动器（约 50 行 Swift 代码）：**

1. 紧凑的 `AXUIElement` 轮询（50 毫秒一次），让辅助程序能在窗口出现后约 100 毫秒内抓取到它。
2. `setFrame:` 设置为第二块屏幕上一个配置好的矩形区域。
3. `kAXMinimizedAttribute = true`（缩小到 Dock 中）。
4. 不要抢夺焦点。

**在启动前预先设置好 `EditorPrefs` 中的窗口位置。** Unity 会在启动时恢复上一次的窗口位置，因此*从第二次*启动开始，窗口就已经处于正确位置了。第一次启动会有短暂闪烁（约 200 毫秒）；之后的启动不会。

**用户侧的一次性设置**（记录在 PopBot 首次运行说明中）："Dock → 右键点击 Unity → Options → Assign To: Desktop X"。macOS 会自动把未来的 Unity 窗口路由到那个虚拟桌面。设置好之后，即便是首次启动的闪烁，也会发生在用户没有在看的那个虚拟桌面上。

每卡槽可配置的位置，以便多个 Unity 实例落在第二块屏幕上可预测的位置。

**无头（Headless）`Window Mode`** 是在 batchmode 验证通过之后才选择性启用的（大致在第 4 阶段）。架构完全相同；只是启动标志不同。

## 服务器 / Unity 配对协议

启动顺序和生命周期管理必须严丝合缝，否则会遇到隐蔽的故障。

### 启动顺序（由 PopBot 强制执行）

1. 启动 `./run_local.sh --port S --data-dir D`。将标准输入输出通过 tee 写入 `server.log`。记录 `server_pid`。
2. 轮询 `/health` 直到返回 200（包含 `commit/gameDataHash/dtoVersion`）。超时 30 秒。失败 → 杀死服务器，报出错误。
3. 把 `client-server.json` 写入工作树，指向 `localhost:S`。
4. 以 `POPBOT_MCP_PORT=M` 启动 Unity。记录 `unity_pid`。
5. 轮询 `/mcp` 直到返回 200。超时 60 秒。失败 → 两者都杀死，报出错误。
6. 运行原生窗口移动器。
7. 卡槽已就绪；智能体可以租用。

### 死亡级联

- **服务器在会话中途死亡** → PopBot 通过 PID 存活检测 + `server_health` 返回 5xx 检测到 → 将卡槽标记为降级 → 尝试重启一次服务器 → 如果仍然失败，在聊天中显示为红色。
- **Unity 死亡** → 服务器继续运行（服务器的生命周期比 Unity 的重启更长；成本更低）。PopBot 可以针对同一个服务器重新启动一个全新的 Unity 实例。
- **卡槽释放** → 服务器 SIGTERM（5 秒宽限期）→ SIGKILL → 调用 Unity 的 `editor_quit` MCP 方法 → SIGTERM（5 秒宽限期）→ SIGKILL。

### PopBot 启动时的协调核对

扫描各个 `slot.json` 文件；对每一个记录下来的 pid，执行 `kill -0 <pid>`；如果已经死亡，清理状态并重置该卡槽。标准的孤儿进程清理惯例。

## 智能体集成

### Claude Agent SDK（v1）

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = query({
  prompt,
  options: {
    cwd: slot.worktreePath,
    mcpServers: {
      'popbot-unity': { type: 'http', url: `http://localhost:${slot.mcpPort}/mcp` }
    },
    permissionMode: chat.autonomous ? 'acceptEdits' : 'default',
    canUseTool: (tool, args) => popbotPolicy.evaluate(tool, args, chat),
  }
});

for await (const event of session) {
  routeToChatUI(event);
  routeToLogBuffers(event);
  autonomyEngine.observe(event);
}
```

我们免费获得的能力：技能（skill）、记忆（memory）、子智能体、钩子（hook）、MCP、以结构化事件形式呈现的权限请求。**不要通过子进程去抓取 `claude` CLI 的输出**——这会在每一个高级功能上都与 SDK 产生冲突。

### AgentBackend 接口（第一天就定义好；v1 只有一个实现）

```ts
interface AgentBackend {
  spawn(opts: SpawnOpts): AgentSession;
  capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
}
interface AgentSession {
  sendUser(text: string): void;
  approve(permId: string, decision: 'allow' | 'deny'): void;
  pause(): void;
  stop(): void;
  events: AsyncIterable<AgentEvent>;
}
```

Codex 后端（第 4 阶段）会把 OpenAI Agents SDK 适配到这个接口中。技能/记忆功能不可用；UI 会清楚地标示出这一点。

### 每聊天的 MCP 配置

每个智能体在派生时，都会注入指向**自己卡槽**端口的 `mcpServers`——`popbot-unity` 的 URL = `localhost:<slot.mcpPort>/mcp`。其他 MCP（Linear、Sentry、Amplitude、BetterStack）则由 SDK 自动从 `~/.claude/settings.json` 或 `.mcp.json` 中继承。

## Tech stack

- **Electron**（Node + Chromium）
- **React + Tailwind** 用于 UI
- **xterm.js + node-pty** 用于终端面板
- **better-sqlite3** 用于记录持久化（每个事件一行，按聊天 + 时间戳建立索引）
- **keytar** 用于 OAuth 令牌/API 密钥/智能体凭据
- **Linear GraphQL API** 用于工单面板
- **`gh` GraphQL** 用于未评审 PR 面板
- **原生 Swift 辅助程序** 用于窗口放置

## Phasing

### 第 0 阶段——前置条件（约 3 天）

| 项目 | 负责人 | 规模 |
|---|---|---|
| MCP `POPBOT_MCP_PORT` 环境变量覆盖 | Unity MCP | 5 分钟 |
| `./run_local.sh --port` + `--data-dir` 参数 | 服务器 | 30 分钟 |
| `/health` 返回 `commit`、`gameDataHash`、`dtoVersion` | 服务器 | 30 分钟 |
| 原生 macOS 窗口移动辅助程序（Swift） | PopBot | 约半天 |
| 卡槽生命周期原型（添加工作树、Library COW、分支切换、暂存安全机制） | PopBot | 约 1 天 |

### 第 1 阶段——MCP 自动化接口（约 3-5 天）

任务基础设施 + 上文的第 1 阶段工具目录。将现有的长耗时工具（`rebuild_gamedata`、`rebuild_dtos`、`addressables_build`、`addressables_clean`）迁移到任务模型上。

### 第 2 阶段——PopBot Electron MVP（约 1-2 周）

单个聊天列，仅 `ClaudeBackend`，单个卡槽，单个 Unity 实例。设置面板骨架。`canUseTool` 策略引擎。集成原生辅助程序。端到端循环：打开聊天 → 智能体编辑代码 → 智能体运行游戏 → 智能体通过截图和日志进行验证 → 完成。

### 第 3 阶段——多聊天 + 面板（约 1 周）

多个聊天列（通过悬浮的加号/叉号增删）。带状态颜色的缩略图条。Linear 工单 + 未评审 PR 面板。底部日志面板，包含并排的 Unity/服务器标签页。聊天设置中的模式/服务器模式切换开关。

### 第 4 阶段——打磨与进阶功能

Codex 后端适配器。无头 `Window Mode`（在 batchmode 验证通过之后）。`crash_dump`、`events_pop`、`command_apply`、测试夹具管理。并排日志的时间关联。自主性预算和循环检测的完善。

## 未决问题

1. **Batchmode 验证** — AutoRPG 实际上能否在 `-batchmode` 的 Play 模式下运行？验证脚本大致排在第 4 阶段；不会阻塞 v1。
2. **主 Library 刷新节奏** — 手动按钮 vs 自动 vs N 天 TTL？默认：偏好设置中的手动按钮。
3. **卡槽数量默认值** — 硬编码为 4，还是根据内存/核心数进行调整？大概默认 2-3 个，可配置。
4. **PopBot 仓库** — 与 `autorpg` 分离，还是放在 `tools/popbot/` 中？稳定之后独立出来；早期开发阶段放在同一个仓库中。

## 风险

| 风险 | 缓解措施 |
|---|---|
| `git checkout` 在暂存过程中损坏某个卡槽 | 始终先暂存；检出后验证工作区干净；如果不干净则拒绝执行 |
| 两个 PopBot 实例争抢同一个卡槽 | 每个卡槽目录一个锁文件；启动时协调核对孤儿状态 |
| Unity 挂起，卡槽租约永远无法释放 | PopBot 启动时进行 PID 存活检查 + 垃圾回收 |
| 跨工作树的 LFS 锁冲突 | 较为罕见；发生时清晰地报出提示 |
| 卡槽的 Library 与 master 差距过大 | 手动"重置卡槽"，从 master 重建 |
| 磁盘空间耗尽 | 在偏好设置中显示每卡槽的大小；"重置"可回收空间 |
| remote-dev 会话中途出现后端漂移 | 出错时重新检查 `server_health`；显示横幅并暂停 |
| 自主模式自动批准了不安全的操作 | `canUseTool` 中硬编码的拒绝清单；永远不可被聊天配置覆盖 |

## Proof artifacts (agent debug deliverable)

当一个智能体完成一项调试任务时，它会写入 `tmp/mcp-sessions/{slug}/`：

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` 遵循一份 6 段式模板（复现步骤 / 修复前 / 根本原因 / 修复方案 / 修复后 / 验证）。这一约定被记录在一个技能（SKILL）中（`agent-debug`）；MCP 只负责提供可预测的会话路径。

## 快速参考——相较于早期提案的变化

供任何阅读了产出这份文档的讨论过程的人参考：

- Library 池 / 进程池 / 工作树池**合并成了一个概念：卡槽（slot）。** 卡槽拥有自己的工作树、Library、可选的 Unity、可选的边车服务器。没有符号链接，没有独立的池子。
- `git worktree add` 在 AutoRPG 上**约需 23 秒**（6.2 万个文件上的 LFS smudge），而不是 1-2 秒。卡槽创建很少发生；通过检出来复用才是日常的高频路径。
- **第二块屏幕上的 GUI 编辑器**是 v1 的默认方式。无头 batchmode 是第 4 阶段的可选启用项。
- 服务器通过 `./run_local.sh` 在项目内运行；每卡槽独立的端口 + 数据目录以实现隔离。
- 智能体集成：**优先支持 Claude Agent SDK**，AgentBackend 接口，Codex 排在第 4 阶段。
