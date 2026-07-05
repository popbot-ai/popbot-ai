*Languages: [English](../PHASING.md) · [Español](../es/PHASING.md) · [Français](../fr/PHASING.md) · [Deutsch](../de/PHASING.md) · [日本語](../ja/PHASING.md) · [한국어](../ko/PHASING.md) · **简体中文** · [Português (Brasil)](../pt-BR/PHASING.md) · [Русский](../ru/PHASING.md) · [Italiano](../it/PHASING.md)*

# 阶段划分

把 PopBot 从"设计 + 原型"推进到"日常好用的工具"的路线图。与
[POPBOT_DESIGN.md](POPBOT_DESIGN.md#phasing) 中的阶段划分相对应，但用复选框跟踪具体进度。

随着条目落地更新本文件。一次提交可以勾选多个复选框。

---

## 第 0 阶段——前置工作（约 3 天）

在 AutoRPG 仓库中的基础性工作，加上本仓库中的一个原生帮助程序。这些大多会阻塞实际的端到端测试，但不会阻塞 Electron 脚手架。

### 在 `~/pop/autorpg` 中

- [ ] **`POPBOT_MCP_PORT` 环境变量覆盖项**，作用于编辑器内 MCP 服务器（`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`）。从环境变量读取端口，回退到 `17893`。约 5 分钟。
- [ ] **`./run_local.sh --port` + `--data-dir` 参数。** 服务器接受这两个参数；data dir 用于按卡槽隔离数据库。约 30 分钟。
- [ ] **`/health` 端点扩展**——返回 `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }`。PopBot 在租用时使用这些字段进行漂移检测。约 30 分钟。

### 在本仓库中

- [ ] **原生 macOS 窗口移动帮助程序**——位于 `native/popbot-windowmover/` 的 Swift CLI。子命令：`move`、`minimize`、`wait-for-window`。约半天。
- [ ] **卡槽生命周期原型**——位于 `src/main/slots/` 下的独立 TS 模块，由 `scripts/` 下的一个脚本驱动执行。覆盖工作树添加、从主库进行 Library 写时复制、带 stash 安全保护的分支切换、租用/释放、孤儿协调。约 1 天。

---

## 第 1 阶段——MCP 自动化接口（约 3-5 天）

在 `~/pop/autorpg` 中。构建出智能体实际会用到的编辑器内 MCP 工具。

- [ ] **任务基础设施**——`job_status`、`job_get_result`、`job_cancel`、`job_list`。所有长时间运行的工具都立即返回 `{ jobId }`。
- [ ] **生命周期工具**——`play_status`、`play_enter`（任务型）、`play_exit`、`play_pause/resume/step`、`time_scale_set`、`editor_quit`。
- [ ] **观测工具**——`screenshot`、`game_state_summary`、`screen_stack`、`chapter_status`、`ui_tree`、`ui_query`。
- [ ] **动作工具**——`ui_click`、`ui_click_by_loc`。
- [ ] **同步工具**——`wait_until`（任务型）、`wait_for_idle`（任务型）。
- [ ] **日志/服务器工具**——扩展 `console_get_logs`（`sinceTimestamp`、`dedupe`、`dumpTo`、`includeStack`）、`server_logs`、`server_health`、`client_set_server_endpoint`。
- [ ] **会话**——`mcp_session_start`、`mcp_session_end`，用于生成可预测的产物目录。
- [ ] **把现有的长任务工具迁移**到任务模型上：`rebuild_gamedata`、`rebuild_dtos`、`addressables_build`、`addressables_clean`。

---

## 第 2 阶段——PopBot Electron MVP（约 1-2 周）

对单个聊天而言端到端可用。**进行中。**

- [ ] **Electron 脚手架**——`package.json`、Vite + React + TS + Tailwind、electron-builder、ESLint + Prettier、Vitest。
- [ ] 带类型 IPC 桥接的**主进程/preload/渲染进程拆分**。
- [ ] 把 8 个原型 JSX **移植**到 `src/renderer/` 下的 `.tsx`。静态 UI 在 Electron 窗口中运行，没有功能性支撑。
- [ ] **better-sqlite3 模式**——chats、messages、slots、prefs。
- [ ] 接入单个 **ClaudeBackend 会话**到一个聊天列。发送消息，接收事件流。
- [ ] **`canUseTool` 策略引擎**——硬编码拒绝清单 + 按模式允许。渲染进程把权限请求呈现为模态框。
- [ ] 接入**卡槽管理器**——一个卡槽，真实的工作树，通过第 0 阶段的帮助程序真实启动 Unity。
- [ ] **原生窗口移动集成**——Unity 打开后，帮助程序把它放到第二块屏幕上。
- [ ] **设置面板骨架**——按聊天的模式、服务器模式、时间缩放、智能体后端。
- [ ] **端到端流程演示**——打开聊天 → 智能体读取代码 → 智能体运行游戏 → 智能体截图 → 智能体汇报。

---

## 第 3 阶段——多聊天 + 关注队列面板（约 1-2 周）

点亮 [US-1](USER_STORIES.md#us-1--关注队列的感知能力)、[US-2](USER_STORIES.md#us-2--一键激活)、[US-5](USER_STORIES.md#us-5--通过缩略图轻松多任务处理)、[US-6](USER_STORIES.md#us-6--一目了然的状态)。

- [ ] 多个聊天列；浮动式添加/移除。
- [ ] 带状态颜色的缩略图条（US-5、US-6）。
- [ ] **Linear 工单面板**（分配给我的，按优先级 + 截止日期排序）。
- [ ] **未评审 PR 面板**（`gh` GraphQL）。
- [ ] **Slack 面板**——私信、@提及、我拥有的频道。全新子系统（`src/main/slack/`）；通过 `keytar` 实现 OAuth。参见 [USER_STORIES.md → 偏差说明](USER_STORIES.md#slack-作为第三个关注来源us-1)。
- [ ] **从任意面板行一键生成聊天**；聊天以来源的上下文为初始信息（US-2）。
- [ ] 底部日志面板——Unity + 服务器标签页，为当前活跃聊天同步滚动。
- [ ] 聊天设置中的模式 + 服务器模式切换开关，支持会话中途重新定向。
- [ ] 在 `remote-dev` 租用时进行漂移检测。

---

## 第 4 阶段——打磨 + 进阶功能

- [ ] **Codex 后端适配器**——`CodexBackend implements AgentBackend`，在 UI 中标记其能力。
- [ ] **无头 `Window Mode`**——在 batchmode 验证脚本证明其在 AutoRPG 上可行之后，作为可选启用项。
- [ ] **`crash_dump`、`events_pop`、`command_apply`、fixture 管理** MCP 工具。
- [ ] Unity 与服务器面板之间的**并排日志时间关联**。
- [ ] **自主性预算 + 循环检测**改进（token / 时间 / 重复失败的暂停触发条件）。
- [ ] **更新渠道**——通过 electron-builder 实现自动更新器 + 签名构建。

---

## 未决问题（沿用自设计文档）

1. AutoRPG 是否真的能在 `-batchmode` 下运行 Play 模式？验证脚本大致安排在第 4 阶段；不会阻塞 v1。
2. 主 Library 刷新周期——手动按钮 vs 自动 vs N 天 TTL？默认：偏好设置里的手动按钮。
3. 默认卡槽数量——硬编码为 4，还是按内存/核心数动态调整？大概率默认 2-3 个，可配置。
