*Languages: [English](../CORE_MODEL.md) · [Español](../es/CORE_MODEL.md) · [Français](../fr/CORE_MODEL.md) · [Deutsch](../de/CORE_MODEL.md) · [日本語](../ja/CORE_MODEL.md) · [한국어](../ko/CORE_MODEL.md) · **简体中文** · [Português (Brasil)](../pt-BR/CORE_MODEL.md) · [Русский](../ru/CORE_MODEL.md) · [Italiano](../it/CORE_MODEL.md)*

# 核心模型

PopBot 这款应用所围绕构建的对象图。其他一切——IPC、
持久化、UI 面板、智能体循环——都挂靠在这些对象之上。如果你要做的行为改动
违反了这里的某条规则，**要么先更新这份模型，要么告知用户模型正在发生变化。**

关于"代码位于何处？"，参见 [ARCHITECTURE.md](ARCHITECTURE.md)。
关于"用户看到的是什么？"，参见 [USER_STORIES.md](USER_STORIES.md)。

---

## 太长不看版——四个关键名词

| 名词 | 是否持久化？ | 所有者 | 生命周期 |
|---|---|---|---|
| **Chat（聊天）** | 是（SQLite） | 主进程 | 由用户创建，一直存在，直到被显式删除 |
| **Message（消息）** | 是（SQLite，近似只追加） | 主进程 | Chat 的子对象 |
| **Slot（卡槽）** | 是（文件系统 + SQLite 行） | 主进程 / `SlotManager` | 很少被创建，会被复用；从不按聊天单独创建 |
| **AgentSession（智能体会话）** | **否**（仅存在于内存中） | 主进程 / `AgentHost` | 当一个 Chat 进入"运行中"状态时被创建；当 Chat 关闭或应用退出时被销毁 |

渲染进程中的一切都是这些对象的一种**视图**。渲染进程从不持有
权威状态。

---

## 持久化名词（重启后依然存在）

### Chat（聊天）

用户的工作单元。一个工单、一次 PR 评审、一个 Slack 线程、一次
"随便看看代码库"的会话——每一个都是一个 Chat。

```ts
interface ChatRecord {
  id: string;                                // chat_<12hex>
  name: string;                              // "ENG-20512 · ability cooldown"
  ticket: string | null;                     // "ENG-20512"
  pr: number | null;                         // 7401
  branch: string | null;                     // git branch this work targets
  type: 'lite' | 'client_test' | 'server_test';
  mode: 'interactive' | 'autonomous';
  agent: 'claude' | 'codex';
  status: ChatStatus;                        // see lifecycle below
  snippet: string;                           // last agent prose (cached for thumbnail)
  tokensUsed: number;
  tokensBudget: number;
  createdAt: number;
  lastActiveAt: number;
  closedAt: number | null;                   // null = open
}
```

**状态生命周期**（US-6——决定缩略图颜色的机制）：

```text
              ┌──────────────┐
              │   idle (○)   │ ← initial state, no agent attached
              └──────┬───────┘
        send/respawn │
              ┌──────▼───────┐
              │  running (▶) │ ── error ──→  errored (✗)
              └──┬───────┬───┘
   needs review │       │ message-end + no work pending
              ┌─▼─────┐ │
              │paused │ │
              │  (?)  │ │
              └──┬────┘ │
       resolve   │      │
              ┌──▼──────▼─────┐
              │ complete (✓)  │
              └───────────────┘
```

**状态是描述性的，而非规定性的**——当有一个 AgentSession 关联时，状态是从它派生出来的，
并在状态转换时持久化到数据库。一个聊天处于 `idle` 状态
意味着"当前没有智能体在做任何工作"。它并**不**意味着"该聊天已经关闭"。

**打开 vs 关闭：** 当且仅当 `closedAt IS NULL` 时，一个聊天才是"打开"的。打开的聊天
会在启动时被加载到内存中；已关闭的聊天则只能通过查询获取。**关闭
一个聊天会释放它的卡槽租约、销毁它的 AgentSession，但绝不会删除 Message。**

### Message（消息）

Chat 内部一份近似只追加的事件日志。这份记录本体是一系列
带类型的记录：

```ts
interface MessageRecord {
  id: string;                                   // msg_<12hex>
  chatId: string;
  role: 'user' | 'agent' | 'system';
  kind: 'text' | 'tool' | 'permission' | 'system';
  body: string;                                 // JSON-encoded payload (shape per kind)
  createdAt: number;
  updatedAt: number;
}
```

**为什么 `body` 是 JSON？** 每种 `kind` 都有不同的负载结构（文本 vs
工具调用 vs 权限请求），渲染进程根据 `kind` 进行分发处理。
以带类型的 JSON 二进制块存储，能让这张表保持扁平，也让渲染进程的代码
保持诚实（不投机取巧）。

**"近似只追加"的含义：** `tool` 和 `permission` 这两类行只会被修改**一次**：

- `tool` 行：在 `tool-use` 事件时写入（名称 + 参数），在 `tool-result`
  事件时更新（填入 `result` + `isError`）。
- `permission` 行：在 `permission-request` 事件时写入（工具 + 参数 + 原因），
  在用户做出决定时更新（设置 `decision`）。
- `text` 行：在 `message-start` 事件时以空文本写入，随着 `text-delta` 事件
  陆续到达，在一个小型内存缓冲区中**合并**，在 `message-end` 事件时
  刷新落盘（并且每约 250 毫秒也会刷新一次，以保持渲染进程的实时性）。是"每一轮智能体
  文字发言"对应一行，而不是每一个增量对应一行。

**回滚智能体的工作不会引发级联删除。** 如果智能体犯了错，你想让它"重新
试一次"，你会发送一条新的用户消息。旧的记录会继续保留。这个模型
从不悄悄地改写历史。

### Slot（卡槽）

一个热备、隔离、一次性的工作区：一份基于写时复制文件夹的隔离检出
（一个 Git 工作树，或一个 Perforce 客户端）+ 一份热备构建缓存
（例如某个引擎的资产/导入缓存）+（可选）一个运行中的被测应用编辑器
（Unity、Unreal 或自定义引擎）+（可选）一个运行中的边车服务器。**很少被
创建，持续被复用。** 卡槽归用户/应用所有，而不归 Chat 所有。

```ts
interface SlotRecord {
  id: number;                                   // slot-1, slot-2, ...
  worktreePath: string;
  branch: string | null;                        // null if free / detached
  ports: { mcp: number; server: number };
  unityPid: number | null;                      // editor PID; refreshed via PID liveness
  serverPid: number | null;
  state: 'free' | 'leased' | 'degraded' | 'creating';
  pinnedBranch?: string;                        // refuse leases for other branches
  cleanOnRelease?: boolean;
  leasedByChatId?: string;                      // soft pointer; a Chat → Slot binding
  lastLeaseAt?: number;
}
```

**Slot ↔ Chat 的绑定关系**是**瞬时的**——它存在于 `slot.leasedByChatId`
以及对应 Chat 的运行时元数据中。在启动时，我们会通过遍历各个卡槽并将其
与打开的聊天进行匹配来核对这份绑定关系。过期的租约（聊天已
关闭、租约却从未被释放）会被回收清理。

关于完整的卡槽生命周期，参见 [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit)。

### Permission grant（权限授权）

一项持久化的用户决定：某个工具/目标组合已被批准，无需再次提示。有两种作用域：

```ts
interface PermissionGrant {
  id: string;                                   // grant_<12hex>
  scope: 'global' | 'chat';
  chatId: string | null;                        // non-null iff scope='chat'
  tool: string;                                 // exact tool, e.g. 'Bash', 'git_push', 'mcp__linear__save_issue',
                                                //   OR a trailing-`*` wildcard, e.g. 'mcp__unrealEditor__*'
  /** Optional refinement: 'Bash' tool restricted to commands matching this prefix. */
  argMatcher: string | null;                    // raw string OR /regex/ — TBD
  decision: 'allow' | 'deny';
  createdAt: number;
}
```

`tool` 可以是一个末尾带 `*` 的通配符，因此一整个 MCP 服务器可以
通过一条授权规则被整体允许（`allow-mcp-server` → `mcp__<server>__*`）——这正是
一个卡槽的编辑器 MCP 能够被一次性授权、而不必逐个工具授权的原理。拒绝
规则永远优先于允许规则，且更具体的模式优先于更宽泛的模式（参见
`src/shared/agent.ts` 中的 `resolvePermissionRules`）。

授权会按聊天不断累积（US-9："对这个聊天始终允许 git push"）。
[adr/0004](../adr/0004-canusetool-policy-boundary.md) 中硬编码的**拒绝规则**
不会存储在这里——它们写在代码里，且不可被覆盖。

### Settings（设置）

分为两层：

- **全局偏好设置**：主题、默认聊天类型、卡槽数量、主 Library
  刷新节奏等。单行表。
- **按聊天的覆盖设置**：服务器模式、时间缩放、窗口模式、token
  预算等。存储在一张以 `chatId` 为键的 `chat_settings` 表中。

两者都可以为空（此时使用默认值）。通过渲染进程中的设置面板进行修改。

### Cached attention items（缓存的待办关注项）

用户的已分配工单队列（Linear / Jira / GitHub Issues）以及
待处理评审队列（GitHub PR / Helix Swarm 变更列表）。这些数据在本地缓存，
以便面板能瞬间渲染；按计划定期刷新，也支持按需刷新。

```ts
interface AttentionItem {
  id: string;                                   // source-prefixed: linear:ENG-20512, jira:ENG-123, gh:7401, swarm:1284
  source: 'linear' | 'jira' | 'github' | 'swarm';
  /** Source-specific raw payload, JSON. */
  payload: string;
  /** Local UI-state: have I dismissed this? Is there a chat already open for it? */
  dismissedAt: number | null;
  spawnedChatId: string | null;
  fetchedAt: number;
}
```

工单来源在一个通用提供方接口背后是可互换的（Linear、Jira、
GitHub Issues）；评审来源同理（GitHub PR、Swarm）。这些数据是缓存，而非权威来源——
真正的权威来源是任务跟踪系统/评审系统本身。

---

## 运行时名词（仅存在于内存中；不会在重启后存活）

### AgentSession（智能体会话）

真正与大语言模型对话的东西。每个"运行中"的 Chat 对应一个 AgentSession。
由一个 `AgentBackend`（Claude Agent SDK 或 Codex SDK；两者目前都已支持）支撑。

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**由 `AgentHost`（主进程中的单例）拥有。** AgentHost 持有一个
`Map<chatId, AgentSession>`。会话是在某个聊天首次调用 `agent.send` 时
惰性创建的，并在该聊天关闭时被销毁。

**会话会发出 `AgentEvent`**（参见 `src/shared/agent.ts`）。AgentHost
会拦截每一个事件并：

1. **持久化**它（增量会合并进一行文本记录；工具调用会创建
   一行工具记录；权限请求会创建一行权限记录）。
2. 通过 `webContents.send` 将其**重新广播**给渲染进程。渲染进程是
   N 个订阅者之一；主进程才是权威的记录者。
3. **更新 Chat 的元数据**——随着事件到达，`status`、`snippet`、`tokensUsed`、
   `lastActiveAt` 会被滚动更新。

**会话从不直接写数据库。** 只有 AgentHost 会写。这样能让
持久化模式（schema）的演进与后端的替换解耦。

### Permission request（进行中的权限请求）

当 SDK 的 `canUseTool` 回调触发时：

1. PolicyEngine（策略引擎）进行评估：硬性允许（自动通过）、硬性拒绝（自动驳回），或询问用户。
2. 如果是"询问用户"，AgentHost 会向渲染进程发出一个 `permission-request`
   事件，**并把 SDK 的回调挂起**——以 `permissionId` 为键——存入一个
   待处理映射表中。
3. 渲染进程显示弹窗；用户点击做出决定；通过 IPC 传回主进程。
4. AgentHost 查找这个待处理的回调并将其解析（resolve）。SDK 随即继续
   执行，或中止。
5. 如果用户勾选了"始终允许此项"，则写入一行 `PermissionGrant` 记录。

待处理的请求**不会被持久化**。如果应用在决策过程中崩溃，
智能体的工具调用会在重启后被取消。

### Process supervisor handles（进程监管句柄）

每个卡槽：一个用于被测应用编辑器的 `child_process.ChildProcess`
（Unity / Unreal / 自定义引擎——`unityPid` 字段会记录其 PID，
无论使用的是哪个引擎），另一个用于边车服务器。由
`SlotManager` 拥有。通过 PID 存活检测 + HTTP 探测进行健康检查。在
卡槽释放/应用退出时被杀死。**在启动时通过遍历**卡槽目录下的
`slot.json` 并验证记录的 PID 是否仍然存活来进行协调。

---

## 所有权规则

以下是**不变量**。违反这些规则的代码就是一个 bug。

1. **渲染进程是纯视图层。** 不接触文件系统，不使用 child_process，不访问
   数据库。只通过带类型的 `window.popbot.*` 桥接与主进程通信。

2. **主进程是数据库唯一的写入者。** 渲染进程通过 IPC 读取；从不
   直接接触 `popbot.db`。

3. **在一个会话进行期间，只有 AgentHost 能修改 Chat 的 status / snippet /
   tokens。** 其他代码可以读取这些字段，但在该聊天有活跃会话期间
   不能写入它们。（诸如重命名之类的用户驱动的修改，只会发生在
   没有活跃会话时，或者会被排队等待。）

4. **后端从不直接写数据库。** 它们只发出事件；由 AgentHost
   负责持久化。这让 ClaudeBackend / CodexBackend / StubBackend
   可以互换，而不必与数据库模式纠缠在一起。

5. **PolicyEngine 是"这个工具能否运行？"这一问题的唯一权威来源。**
   没有任何后端会绕过它。权限授权都要经过它。

6. **Slot ↔ Chat 的绑定关系是瞬时的。** Chat 记录从不记录某个
   卡槽的名字。Slot 记录会记录持有该租约的聊天（软指针，
   在启动时进行核对协调）。

7. **记录本体从不悄悄地发生变化。** 只追加新行；tool/permission 行上的
   一次性更新是明确且有边界的。

---

## 状态流转——一条用户消息的端到端过程

一个具体的示例，展示这个模型的运转过程。

```text
User types "fix the cooldown flicker" in chat c1 and presses ⌘↵
  │
  ▼
Renderer: api.agent.send({ chatId: 'c1', text })
  │  IPC: pb:agent:send
  ▼
Main · AgentHost.send('c1', text)
  ├─→ DB: appendMessage({ chatId, role: 'user', kind: 'text', body: { text } })
  ├─→ DB: updateChatStatus('c1', 'running', snippet=text.slice(0,140))
  ├─→ webContents.send('pb:agent:event', { type: 'message-start', ..., role: 'user' })
  └─→ session.sendUser(text)            // AgentSession (Claude SDK)
        │
        │  SDK streams events back via the onEvent callback wired at spawn:
        │
        ├─→ { type: 'message-start', role: 'agent', messageId: 'msg_abc' }
        │     ├─→ DB: appendMessage({ id: 'msg_abc', kind: 'text', body: { text: '' } })
        │     └─→ webContents.send → renderer appends an empty agent message bubble
        │
        ├─→ { type: 'text-delta', messageId: 'msg_abc', delta: 'Looking at ' }
        │     ├─→ buffer.append('msg_abc', 'Looking at ')      // in-memory
        │     │     (flush every 250ms or on message-end → DB UPDATE)
        │     └─→ webContents.send → renderer concatenates into the bubble
        │
        ├─→ { type: 'tool-use', messageId: 'msg_abc', toolUseId: 't1',
        │     name: 'unity.run_fixture', args: {...} }
        │     ├─→ PolicyEngine.evaluate('unity.run_fixture', args)  → 'allow' (whitelisted)
        │     ├─→ DB: appendMessage({ id: 'tool_t1', kind: 'tool',
        │     │                        body: { toolUseId, name, args } })
        │     └─→ webContents.send → renderer renders tool row
        │
        ├─→ { type: 'tool-result', toolUseId: 't1',
        │     text: '3/3 ok · 14.2s', isError: false }
        │     ├─→ DB: updateMessageBody('tool_t1', { ...prev, result, isError })
        │     └─→ webContents.send → renderer updates tool row badge
        │
        ├─→ { type: 'permission-request', permissionId: 'p1',
        │     tool: 'git_push', args: { ref: '...' }, reason: 'back up progress' }
        │     ├─→ PolicyEngine.evaluate('git_push', args)   → 'ask'
        │     ├─→ AgentHost.pendingPermissions.set('p1', sdkCallback)
        │     ├─→ DB: appendMessage({ id: 'perm_p1', kind: 'permission',
        │     │                        body: { permissionId, tool, args, reason } })
        │     ├─→ DB: updateChatStatus('c1', 'paused', snippet='needs you: ...')
        │     └─→ webContents.send → renderer shows PermissionModal
        │
        │  ┌─── user clicks "Allow once" in the modal ───────────────────────┐
        │  ▼                                                                  │
        │  Renderer: api.agent.approve({ chatId: 'c1', permissionId: 'p1', │
        │                                 decision: 'allow' })                │
        │   │  IPC: pb:agent:approve                                          │
        │   ▼                                                                  │
        │  Main · AgentHost.approve('c1', 'p1', 'allow')                      │
        │     ├─→ DB: updateMessageBody('perm_p1', { ...prev, decision })     │
        │     ├─→ DB: updateChatStatus('c1', 'running')                       │
        │     ├─→ pendingPermissions.get('p1')(true)   // resolves SDK        │
        │     └─→ webContents.send → renderer dismisses modal                 │
        │
        ├─→ { type: 'message-end', messageId: 'msg_abc' }
        │     ├─→ buffer.flush('msg_abc')      → DB UPDATE final text
        │     └─→ webContents.send → renderer freezes the bubble
        │
        └─→ { type: 'session-status', status: 'idle' }
              ├─→ DB: updateChatStatus('c1', 'idle')
              └─→ webContents.send → renderer thumbnail goes from blue to gray
```

有两点值得注意：

- **渲染进程从不自行做决定。** 它只负责派发意图，并根据事件
  重新渲染。
- **数据库写入与渲染进程通知发生在同一个位置。** 它们由
  AgentHost 中同一个处理程序统一驱动。这意味着渲染进程崩溃
  不会导致持久化数据出现漂移。

---

## 恢复流程——从冷启动重新开始

以代码形式呈现的 US-7。应用非正常退出。数小时后，用户再次打开它：

1. **数据库初始化** — `initDb()` 打开 `popbot.db`，运行待执行的迁移。
2. **卡槽核对** — 遍历 `~/Library/Application Support/PopBot/slots/`，
   为每个卡槽读取 `slot.json`，验证 `unityPid` / `serverPid` 是否
   存活（`kill -0`）；如果已经死亡，则将该卡槽标记为空闲并清除这些 PID。
   解决任何孤立的租约（对应的聊天不存在，或该聊天的
   `closedAt` 已被设置）。
3. **打开的聊天** — `listOpenChats()` 返回 `closedAt IS NULL` 的聊天，
   按 `lastActiveAt DESC` 排序。渲染进程在首次绘制时会请求这些数据。
4. **不会自动派生智能体。** 会话是在首次调用 `agent.send` 时才惰性
   派生的。用户打开自己旧的聊天时，只会看到记录内容；
   智能体不会自动从上次中断的地方继续，直到用户发出提示。
5. **按需租用卡槽。** 同理——租用只会发生在该聊天类型
   确实需要卡槽时（客户端测试/服务器测试），且某个需要 Unity 的工具即将
   被调用时。

结果是：打开这款应用非常快（只需读数据库 + 卡槽状态探测），你可以
在不承担智能体派生开销的情况下查看任何聊天的历史记录。

---

## 后端可互换性

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** 封装 `@anthropic-ai/claude-agent-sdk`。默认后端。
- **CodexBackend** 封装 `@openai/codex-sdk`（其内部驱动 `codex exec`）。
  已支持。每个后端都会声明自己的 `capabilities`，UI 会针对每个聊天
  进行特性检测。
- **StubBackend** 用一个伪造的事件流回显用户输入的文字。用于接线
  验证和 UI 测试。

聊天记录中的 `agent` 字段决定了 AgentHost 会派生哪个后端。

---

## 刻意未纳入该模型的内容

- **工作流 / DAG / 审批链。** 一个聊天就是一段对话。我们
  不对流水线进行建模。
- **多用户。** 每台机器单一开发者；没有身份认证，没有共享。
- **笔记本 / 已保存的查询 / 模板。** 这些全部是从记录中涌现出来的，
  目前还没有作为一等公民类型存在。
- **带版本的聊天快照 / 分支记录。** 记录是线性的。分叉一个聊天 =
  基于旧聊天的历史记录创建一个新聊天并以其为初始上下文（这是一个
  未来的功能，目前尚未纳入这个模型）。

如果我们最终确实需要以上任何一项，会先把它加到这里，再加入代码。
