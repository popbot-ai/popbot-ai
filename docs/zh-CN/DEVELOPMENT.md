*Languages: [English](../DEVELOPMENT.md) · [Español](../es/DEVELOPMENT.md) · [Français](../fr/DEVELOPMENT.md) · [Deutsch](../de/DEVELOPMENT.md) · [日本語](../ja/DEVELOPMENT.md) · [한국어](../ko/DEVELOPMENT.md) · **简体中文** · [Português (Brasil)](../pt-BR/DEVELOPMENT.md) · [Русский](../ru/DEVELOPMENT.md) · [Italiano](../it/DEVELOPMENT.md)*

# 开发

## 前置条件

- macOS（v1 唯一支持的平台）
- Node 20 LTS 或更新版本（脚手架落地后会用 `.nvmrc` 锁定版本）
- pnpm（首选）或 npm
- Xcode Command Line Tools（`xcode-select --install`）——原生 Swift 帮助程序以及任何 node-gyp 构建都需要它
- 在 `~/pop/autorpg` 处克隆一份 [`autorpg`](../../../autorpg)，用于端到端测试

## 首次搭建

> 等待 Electron 脚手架落地（第 2 阶段）。这一节会在 `package.json` 落地后补全。

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## 脚本（规划中）

| 命令 | 用途 |
|---|---|
| `pnpm dev` | Vite 开发服务器 + 带热重载的 Electron 主进程 |
| `pnpm build` | 生产环境的渲染进程 + 主进程构建产物 |
| `pnpm package` | electron-builder → `release/`（.dmg） |
| `pnpm typecheck` | 对 main、preload、renderer、shared 执行 tsc --noEmit |
| `pnpm lint` | ESLint + Prettier 检查 |
| `pnpm test` | Vitest 单元测试 |

## 仓库约定

- **全面使用 TypeScript。** 除配置文件外不允许出现 `.js`。开启严格模式。
- **组件中不允许出现原始 IPC。** 渲染进程通过 `src/preload/` 中定义的、带类型的 `window.popbot.*` 桥接与主进程通信。
- **渲染进程是纯视图层。** 不使用 fs，不使用 child_process，不使用带原生绑定的 node 模块。如果某个组件需要持久化或系统调用，要通过主进程 + IPC 来暴露这个能力。
- **每个 React 组件一个文件**，以 `PascalCase.tsx` 命名。Hook 若是私有的就放在组件旁边，若是共享的就放在 `renderer/hooks/` 中。
- **Tailwind 优先，局部作用域 CSS 其次。** 移植过来的 `design/prototype/styles.css` 会变成一个 Tailwind layer，外加一小组用于深色主题 token 的 CSS 自定义属性（`--bg-1`、`--fg-2` 等）。

## 使用设计原型

原始原型位于 [`../design/prototype/`](../../design/prototype/)，是**冻结的参考物**，而非构建目标。查看方式参见 [`design/README.md`](../../design/README.md)。

移植某个组件时：

1. 打开对应的 `*.jsx`，放在你的 `.tsx` 旁边作为视觉参考。
2. 剥离 `useStateA`/`useEffectA` 这类别名（这是原型为了避免全局命名冲突而使用的一个技巧）。
3. 把 `INITIAL_CHATS` 及其他模块级的固定数据替换为从 `renderer/fixtures/` 导入，或者最终替换为 IPC 调用。
4. 尽量贴近原型的视觉表现和交互行为——参见[记忆：贴近设计](../../)。

## 提交风格

- 遵循 Conventional Commits：`feat:`、`fix:`、`chore:`、`docs:`、`refactor:`、`test:`。
- 正文每行不超过 72 列。先说明**为什么**，而不是**做了什么**。
- 一次逻辑改动对应一个 PR。不要把脚手架和功能捆在一起。

## 与关联仓库协作

PopBot 驱动的是 AutoRPG 的 Unity 项目 + 边车服务器。第 0 阶段的若干前置工作会落在那个仓库里，而不是这个仓库：

- 在编辑器内 MCP 上新增 `POPBOT_MCP_PORT` 环境变量覆盖项
- `./run_local.sh --port` 和 `--data-dir` 参数
- `/health` 端点的扩展

当你在处理那部分工作时，`cd ~/pop/autorpg` 并遵循那个仓库的约定。
