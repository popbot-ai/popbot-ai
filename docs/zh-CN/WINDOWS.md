*Languages: [English](../WINDOWS.md) · [Español](../es/WINDOWS.md) · [Français](../fr/WINDOWS.md) · [Deutsch](../de/WINDOWS.md) · [日本語](../ja/WINDOWS.md) · [한국어](../ko/WINDOWS.md) · **简体中文** · [Português (Brasil)](../pt-BR/WINDOWS.md) · [Русский](../ru/WINDOWS.md) · [Italiano](../it/WINDOWS.md)*

# 在 Windows 上运行 PopBot

PopBot 构建于 Electron + Node 之上，可以在 Windows 上运行，但有几个搭建
步骤与 macOS 不同——主要围绕两个原生模块
（`better-sqlite3`、`node-pty`）和一个 Electron 的怪癖。本文档记录的是
经过验证可行的搭建方式。

## 前置条件

- **Node 20 LTS 或更新版本。** Node 24 可以用来*运行*这款应用，但它太新了，
  以至于 `better-sqlite3` 没有匹配的预构建二进制文件，因此单纯执行
  `npm install` 会尝试针对 Node 的 ABI 从源码编译，可能会
  失败（参见下文"原生模块"一节）。Node 20 / 22 可以避免这次编译。
- **PATH** 中需要有 **Git for Windows**（`git`）和 **GitHub CLI**（`gh`）。
- **PATH** 中需要有 **`claude`** CLI（一个 `claude.exe`——PopBot 通过
  `where.exe` 来发现它）。`codex` 是可选的。
- **Visual Studio Build Tools 2022**，需带上 *Desktop development with
  C++* 工作负载——只有当某个原生模块需要从源码编译时才需要（例如
  `node-pty` 的 winpty）。

## 首次搭建

这些原生模块必须针对 **Electron** 的 ABI 进行构建，而不是你系统上的
Node。可靠的操作顺序如下：

```bash
# 1. Install JS deps without running native build scripts (avoids the
#    Node-ABI source build of better-sqlite3 that rolls back the install).
npm install --ignore-scripts

# 2. Download the Electron binary that step 1 skipped.
node node_modules/electron/install.js

# 3. Build the native modules against Electron's ABI.
npx electron-rebuild -f -w better-sqlite3,node-pty

# 4. Run it.
npm run dev
```

如果你使用了 `--ignore-scripts`，第 2 步是必需的——否则
electron-vite 会报错 `Error: Electron uninstall`。

## 你可能会遇到的两个坑

### `node-pty` 构建时报错：`'GetCommitHash.bat' is not recognized`

`node-pty` 内置了 **winpty**，其构建过程会运行 `cd shared &&
GetCommitHash.bat`。如果你的环境设置了
**`NoDefaultCurrentDirectoryInExePath=1`**（一个安全加固标志），
cmd.exe 会拒绝从当前目录运行这个 `.bat` 文件，导致构建
失败。为构建过程清除这个变量：

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### 启动时报错：`Cannot read properties of undefined (reading 'setName')`

这意味着 Electron 是以**纯 Node**方式启动的，而不是以 Electron 方式启动，因此
`electron.app` 是 `undefined`。当环境变量中存在
`ELECTRON_RUN_AS_NODE` 时就会发生这种情况——而且在 Windows 上，Electron 会把
该变量的*单纯存在*（哪怕是空值）当作"以 Node 方式运行"的信号。当你从
另一个 Electron 应用（VS Code、Claude Code）内嵌的终端启动时，就会碰到这个问题，
因为那类终端会导出 `ELECTRON_RUN_AS_NODE=1`。

`npm run dev` / `npm run start` 都会经过 `scripts/electron-vite.mjs`，
该脚本会在启动 Electron 之前**删除**这个变量，因此这种情况已经处理好了。如果你直接调用
`electron-vite`，请确保 `ELECTRON_RUN_AS_NODE` 是未设置状态（而不只是空值）。

## 打包

```bash
npm run package:win    # NSIS installer + zip → release/
```

Windows 构建目前是**未签名的**，因此 SmartScreen 会在首次
启动时发出警告。设置 `CSC_LINK`（指向一个 `.pfx` 文件的路径）和 `CSC_KEY_PASSWORD` 即可进行签名。

## 功能对等性说明

- **智能体、聊天、git 工作树、内嵌终端，以及 Git
  面板**在 Windows 上均可正常工作。
- **外部应用启动器**（每卡槽的图标行）："打开终端"
  （Windows Terminal / cmd）、"打开编辑器"（VS Code / Cursor），以及"打开
  git 客户端"（GitHub Desktop）均已接入。**Unity** 的启动/聚焦，以及
  每卡槽的"正在运行的应用"检测功能，目前仅支持 macOS（因为它们依赖
  `ps`/`lsof`/AppleScript），在 Windows 上会直接跳过、不执行任何操作。
- macOS 专属的部分——Dock 菜单、登录 shell 的 `PATH` 修补、
  Chrome 配置文件 URL 路由——都有相应的保护判断，在 Windows 上会被直接跳过。
