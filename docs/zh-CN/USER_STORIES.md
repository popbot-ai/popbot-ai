*Languages: [English](../USER_STORIES.md) · [Español](../es/USER_STORIES.md) · [Français](../fr/USER_STORIES.md) · [Deutsch](../de/USER_STORIES.md) · [日本語](../ja/USER_STORIES.md) · [한국어](../ko/USER_STORIES.md) · **简体中文** · [Português (Brasil)](../pt-BR/USER_STORIES.md) · [Русский](../ru/USER_STORIES.md) · [Italiano](../it/USER_STORIES.md)*

# 用户故事

PopBot"成功是什么样子"的参考文档。记录于 2026-05-01。每一个实现决策都应该能追溯到其中一条用户故事。

用户是一名在自己机器上运行 PopBot 的独立开发者（Ben）。下文中的"我"指的就是他。

> **状态（发布时新增的说明，2026-07）。** 下面这些用户故事是 2026-05 捕捉到的*最初*用户故事，作为设计意图的原始记录保留在这里。此后 PopBot 已经在那个最初的单用户、Unity/Linear/Slack/GitHub 范围之上进行了大幅泛化——它现在同时涵盖 Git 和 Perforce、Unity 和 Unreal、Linear/Jira/GitHub Issues、GitHub PR 和 Helix Swarm，并以 MIT 许可证发布，支持多语言本地化。本文档刻意*没有*被回溯性地修改以匹配现状；请把它当作历史记录来看待，当前的功能集参见 [GUIDE.md](GUIDE.md)。US-1 到 US-9 这些用户故事，以及 2026-05 的捕捉记录本身，都保持不变。

---

## US-1 · 关注队列的感知能力

> *"我应该能够察觉到需要我处理的高优先级问题、Slack 消息和其他 PR。"*

三个来源汇总呈现在窗口顶部：

- 分配给我的 **Linear 工单**，按优先级 + 截止日期排序。
- 发给我的 **Slack 消息**（私信、@提及、我拥有的频道）。_这是新增需求；不在原始设计范围内——参见[偏差说明](#偏差与新增内容)。_
- 请求我评审的 **GitHub PR**。

每一行都展示出足够的信息，让我无需点击就能完成分诊（标题、来源、时长、优先级指示）。高优先级项目在视觉上会与低优先级项目明显区分开来。

**对应到：** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout)（工单/评审面板——可扩展出一个 Slack 面板）。

---

## US-2 · 一键激活

> *"我应该能够轻松地针对其中任何一项发起工作，并打开一个聊天开始处理。"*

点击关注队列中的任意一行，都会生成一个为该项工作预置好上下文的新聊天：

- Linear 工单 → 以工单正文为初始信息、以工单键命名分支、智能体提示词预填好的聊天。
- Slack 消息 → 以对话上下文为初始信息的聊天，随时可以起草回复或启动实际工作。
- PR → 以 diff 和评审清单为初始信息的聊天。

从"我发现了一件需要处理的事"到"一个智能体正在处理它"之间没有任何设置上的摩擦。

**对应到：** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout)（"点击一行 → 生成一个以该工作为初始上下文的聊天"）。

---

## US-3 · 在聊天中进行真实的游戏测试

> *"聊天应该能够在需要时接入一个 Unity 实例并运行 unity/server，以便测试和调试工作成果。"*

当一个聊天需要在真实游戏中验证某个行为时，该聊天会获取一个卡槽，启动 Unity（放置在第二块屏幕上），并可选地启动边车服务器。智能体通过编辑器内的 MCP 来驱动游戏——进入 Play 模式、点击 UI、截图、读取日志、断言状态。

第一次获取卡槽是较慢的部分（冷启动约 15-30 秒）；后续活动是粘性的（约 50 毫秒）。

**对应到：** [POPBOT_DESIGN.md → Chat types](POPBOT_DESIGN.md#chat-types)（客户端测试 / 服务器测试）、[Slots](POPBOT_DESIGN.md#slots--the-durable-unit)、[MCP automation surface](POPBOT_DESIGN.md#mcp-automation-surface)。

---

## US-4 · 自主的端到端完成并附带证明

> *"智能体应该能够完全自主地工作，修复/调试并完成一整个工单，包括在一份可供检查的 markdown 文档中提供证明，证明修复/改动确实按要求生效。"*

在自主模式下，智能体会在无人干预的情况下运行一套完整的"阅读 → 复现 → 修复 → 验证"循环，并在最后写出一份 `proof.md` 产物。该证明文档包含：

- **复现步骤** — 演示该缺陷的确切步骤。
- **修复前** — 来自故障状态的截图 + 经过筛选的日志转储。
- **根本原因** — 智能体的诊断结论。
- **修复方案** — 改动的 diff 或摘要。
- **修复后** — 来自修复后状态的截图 + 干净的日志转储。
- **验证** — 重新运行一次复现步骤，此时应通过。

我可以打开 `proof.md`，自行判断这项工作是否合格，而无需亲自重新运行任何东西。只有对高风险操作（`git push`、`gh pr create` 等）才需要暂停等待我审核。

**对应到：** [POPBOT_DESIGN.md → Autonomous mode](POPBOT_DESIGN.md#autonomous-mode)、[Proof artifacts](POPBOT_DESIGN.md#proof-artifacts-agent-debug-deliverable)。

---

## US-5 · 通过缩略图轻松多任务处理

> *"我应该能够通过点击缩略图，轻松地在多个智能体之间切换处理。"*

缩略图条是并行工作的主要导航界面。一排紧凑的预览图——每个聊天一张——让我能立即在各个智能体之间跳转。点击一个缩略图会把该聊天带到前台；其他聊天则继续在后台运行。

缩略图本身传达的是状态，而不仅仅是身份标识。参见 US-6。

**对应到：** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout)（缩略图行）、[PHASING.md](PHASING.md) 中的第 3 阶段。

---

## US-6 · 一目了然的状态

> *"我应该能够一眼就大致了解一个智能体在做什么，以及它们是否需要我的协助或指示。"*

每个聊天的缩略图都会显示其当前状态，无需我点进去查看：

| 颜色 | 含义 |
|---|---|
| 蓝色 | 运行中 |
| 绿色 | 任务完成 |
| **黄色** | **已暂停——需要我处理** |
| 红色 | 出错 |
| 灰色 | 空闲/尚未开始 |

黄色是最需要关注的那一种。扫一眼缩略图行应该能在一秒之内回答"有没有谁卡住了？"这个问题。除了颜色之外，缩略图还会展示一条简短的进度提示（上一个动作、当前步骤），以便我判断是否要深入查看。

**对应到：** [POPBOT_DESIGN.md → Status colors](POPBOT_DESIGN.md#status-colors-chat-thumbnail)。

---

---

## US-7 · 随时随地恢复并继续

> *"我应该能够轻松地恢复并继续处理工单，即便是那些已经不再活跃的工单，从我离开的地方接着做。"*

一个聊天是持久化的。即使我关闭它、重启 PopBot，或者重启电脑，我都可以重新打开任何过去的聊天，并从我离开的确切位置继续：

- 完整记录会重新回放到聊天列中。
- 卡槽会被重新获取（或从冷启动重新生成），处于我之前所在的同一个分支。
- Unity + 边车状态会恢复到相关的测试夹具/存档数据（如果之前设置过的话）。
- 智能体会在回应我的下一条消息之前，重新阅读近期的记录——上下文不会因重启而丢失。

关闭一个聊天会释放它的卡槽；重新打开则会重新获取卡槽。聊天才是持久的记录；卡槽只是短暂的基础设施。

**对应到：** [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit)（卡槽与聊天的生命周期关系）、[Tech stack → better-sqlite3](POPBOT_DESIGN.md#tech-stack)（记录持久化）。每个聊天的记录模式（schema）位于 `src/main/persistence/`。

---

## US-8 · 逐工单检视：聊天 + Unity + 日志 + 证明

> *"我应该能够轻松地查看一个工单的进展情况，展示内容、正在运行的服务器/Unity 实例、相关日志、完成产物（markdown）。"*

对于任何聊天（无论是活跃的还是暂停的），一次点击就能调出我评估进度所需的一切：

- **聊天内容** — 正在进行的记录，包含智能体的推理过程、工具调用和输出结果。
- **服务器/Unity 状态** — 该卡槽是否在运行、处于哪个分支、屏幕堆栈是什么、Unity 是否处于 Play 模式。
- **相关日志** — Unity 控制台 + 边车服务器的日志，按该聊天的会话筛选，同步滚动。
- **完成产物** — 智能体产出的 `proof.md`（以及配套的 `before/`、`after/`、`diff.patch`），内联渲染。

这是一个"给我看看发生了什么"的视图。不是原始的信息洪流，而是经过筛选的横截面，回答"这件事做得好吗？"这个问题。

**对应到：** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout)（聊天列 + 底部日志面板）、[Proof artifacts](POPBOT_DESIGN.md#proof-artifacts-agent-debug-deliverable)。证明渲染器位于 `src/renderer/chat/ProofViewer.tsx`（规划中）。

---

## US-9 · 即时授予权限

> *"我应该能够轻松地授权智能体做一些它们本不应该完全自主执行的事情。"*

当一个智能体想要执行始终需要暂停确认的操作（`git push`、`gh pr create`、在卡槽之外执行 `rm`、对未列入白名单主机的网络调用等）时，PopBot 会暂停并询问我。授权流程是：

- 弹出一个对话框，展示智能体想做**什么**、**为什么**要这么做（智能体给出的理由），以及**命令/参数**。
- 我可以选择**允许一次**、**允许本次聊天/会话**、**始终允许**（针对该工具/目标的持久化规则），或**拒绝**。
- 允许规则会按聊天不断累积，并展示在聊天设置面板中，方便我撤销。
- 硬编码的拒绝清单永远无法通过 UI 覆盖——参见 [adr/0004](../adr/0004-canusetool-policy-boundary.md)。

关键在于：自主是默认状态，但我可以毫不费力地批准一个具体的高风险操作，而无需打开终端或全程盯着智能体。

**对应到：** [POPBOT_DESIGN.md → Autonomous mode](POPBOT_DESIGN.md#autonomous-mode)、[adr/0004 — canUseTool policy boundary](../adr/0004-canusetool-policy-boundary.md)。授权存储位于 `src/main/agents/policy/`。

---

## 偏差与新增内容

本节标记出用户故事与已锁定设计存在分歧的地方。在实现时，以用户故事作为权威依据，并更新设计文档。

### Slack 作为第三个关注来源（US-1）

原始设计只涵盖 Linear 工单和未评审的 PR。Slack 消息不在最初范围内。为了满足 US-1：

- 在左上方的标签组中，与工单和评审并列，新增一个 **Slack 面板**。
- 来源：Slack 私信、@提及，以及我拥有的频道中的消息。具体的过滤规则待定，需结合聊天生成工作流确定。
- 认证方式：Slack OAuth（令牌通过 `keytar` 存入密钥链）。
- 从一条 Slack 消息生成聊天时，会以该对话上下文作为智能体的初始信息。

这是一个**全新的子系统**——Slack API 客户端位于 `src/main/slack/`，面板位于 `src/renderer/panels/slack/`。把它安排进 [PHASING.md](PHASING.md) 的第 3 阶段，与其他面板并列，但要把它当作一等公民对待，而不是事后添加的东西。
