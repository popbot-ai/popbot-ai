# 发布 PopBot

版本由 GitHub Actions 跨 **macOS、Windows 和 Linux** 三个平台构建，
并发布到本仓库的 GitHub Release 上。每个平台在各自的 runner 上构建——
原生模块（`better-sqlite3`、`node-pty`）必须针对 Electron 的 ABI 按各操作系统分别编译，
因此交叉编译不是一个可行选项。

## 切一个新版本

在 `main` 分支上、工作树干净的状态下：

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh` 会提升版本号、提交、创建一个带注释的
`vX.Y.Z` 标签，并将两者一并推送。推送的标签会触发 **Build**
工作流，该工作流会构建全部三个平台，并发布带有产物附件的 GitHub
Release。可以用 `gh run watch` 或 Actions 标签页来观察进度。

下一个版本号是根据最新的 `v*` 标签、按上述参数递增计算出来的。
在任何标签存在之前，会回退使用 `package.json` 中的版本号（因此第一个版本
就是在那个版本号之上的下一次递增）。该脚本拒绝在 `main` 以外的任何分支上运行
（可通过 `RELEASE_BRANCH=<name>` 覆盖）。

## 会产出什么

| 平台 | 产物 |
|----------|-----------|
| macOS    | `.dmg`、`.zip`、`latest-mac.yml`、`.blockmap` |
| Windows  | NSIS 安装程序 `.exe`、`.zip`、`latest.yml`、`.blockmap` |
| Linux    | `.deb`（无自动更新——参见下方的 Linux 说明） |

`latest*.yml` + `.blockmap` 文件是 electron-updater 的元数据
（由 [`electron-builder.yml`](../../electron-builder.yml) 中的 `publish: github`
生成）。应用内自动更新器会消费这些文件来检测、下载并暂存更新——
参见下方的自动更新一节。

工作流：[`.github/workflows/build.yml`](../../.github/workflows/build.yml)。

## CI 触发条件

- **推送 `v*` 标签** → 构建所有平台（如果设置了密钥则进行签名）+
  发布一个 GitHub Release。
- **针对 `main` 的 Pull Request**（非文档类）→ 仅做校验性构建，**始终
  不签名**；产物会附加到该次运行上，不发布任何东西，也不使用任何密钥。
- **手动触发** → "Run workflow"（workflow_dispatch），不签名。

签名只会在推送 `v*` 标签时运行，而只有仓库所有者才能这么做。GitHub 从不会向
fork 触发的 PR 运行暴露密钥，因此贡献者提交的 PR 无法触及签名证书。

## 代码签名

签名由 **GitHub Actions 密钥**驱动（Settings → Secrets and
variables → Actions）。它们是加密的，从不出现在 git 树中，在日志中也会被
遮蔽。如果一个都没设置，标签构建会产出未签名的二进制文件（macOS
Gatekeeper / Windows SmartScreen 会在首次启动时警告），但 CI 仍然会通过。

### macOS（签名 + 公证）

| 密钥 | 值 |
|--------|-------|
| `MAC_CSC_LINK` | 你的 "Developer ID Application" `.p12` 的 base64 编码（`base64 -i cert.p12 \| pbcopy`） |
| `MAC_CSC_KEY_PASSWORD` | 该 `.p12` 的密码 |
| `APPLE_ID` | 用于公证的 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 来自 appleid.apple.com 的应用专属密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

只有当**完整的一组**密钥都存在时——`MAC_CSC_LINK`、`APPLE_ID`、
`APPLE_APP_SPECIFIC_PASSWORD`，**以及** `APPLE_TEAM_ID`（外加证书所需的
`MAC_CSC_KEY_PASSWORD`）——标签构建才会签名 + 公证。如果缺少任何一项，
就会构建为未签名版本，而不是让公证在后期失败，这样一组配置不全的密钥就不会破坏 CI。

### Windows（可选）

| 密钥 | 值 |
|--------|-------|
| `WIN_CSC_LINK` | 你的代码签名 `.pfx` 的 base64 编码 |
| `WIN_CSC_KEY_PASSWORD` | 该 `.pfx` 的密码 |

当 `WIN_CSC_LINK` 存在时，标签构建就会签名；否则就是未签名的。

## 自动更新

应用内自动更新是用 **electron-updater** 接入的
（[`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts)）。
在打包好的构建版本中，它会轮询本仓库的 release，在后台**静默下载**
一个更新版本，并在准备就绪时展示一个**"重启以安装"**的提示条——
点击它会退出并重新启动进入新版本。它读取 release 工作流附加的
`latest*.yml` + `.blockmap` 元数据；`electron-builder.yml` 中的
`publish: github` 配置会生成客户端所需的 `app-update.yml`。

**安装这一步需要签名。** macOS 会拒绝未签名的更新，因此应用内安装
只有在 release 已签名 + 公证之后才能生效（即设置了 Apple 密钥的标签构建路径）。
在此之前——以及每当更新器遇到错误时（没有元数据、网络失败）——它会**回退**
到一个手动的"下载"提示条，打开 release 页面，这由
[`src/main/updates/check.ts`](../../src/main/updates/check.ts) 中那个轻量级的
GitHub 检查驱动。同一个轻量级检查也支撑着关于对话框中的按需"检查更新"，
并且在任何地方都能用，包括开发环境和未签名的构建版本。

要让任何东西呈现出一个 release，工作流必须发布**非草稿、非预发布**的
Release，并附上各平台的安装程序——它确实是这么做的。开发环境中自动更新是禁用的。

### 验证自动更新（首次端到端测试）

自动更新这条路径只能针对**两个真实的已签名 release**来验证——不能在
开发环境中验证（它是禁用的），也不能针对单个 release 验证（没有更新的版本可拉取）。
在设置好签名之后，做一次这个流程：

1. **确认签名已开启。** 添加上表中的 macOS（以及可选的 Windows）密钥。
   第一个已签名的 release 必须成功——在 macOS 上，未签名/未公证的构建
   可以下载但**无法安装**，所以如果不签名，整个测试就没有意义。
2. **切出版本 N**，例如 `npm run release` → `v0.0.18`。等待
   工作流发布带有附件 + `latest*.yml` 的 Release。
3. **在你支持的每个操作系统上安装版本 N**（macOS `.dmg`、Windows `.exe`、
   Linux `.deb`）来自已发布的 Release。启动它——确认
   Help ▸ About 显示的版本号正确。
4. **切出版本 N+1**，例如 `npm run release` → `v0.0.19`。
5. **让版本 N 的安装保持运行。** 启动后约 30 秒内（此后每 6 小时一次）
   它会检查一次；在已签名的构建上，它会静默下载 N+1，然后展示
   **"重启以安装"**的提示条。点击它。
6. **确认它已重新启动进入 N+1**——Help ▸ About 现在显示新
   版本号。这就证明了下载 → 暂存 → quitAndInstall → 重新启动
   在那个操作系统上是可行的。

各平台的说明：
- **macOS：** Squirrel.Mac 会从 `.zip` 附件（而不是
  `.dmg`）应用更新；两者都必须在 Release 中。Gatekeeper 会拒绝未签名/
  未公证的更新——如果"重启以安装"没有任何反应，重新检查构建版本的公证情况。
- **Linux：** `.deb` **不会**自我更新——electron-updater 只对 Linux 上的
  AppImage 做自动更新。要更新的话，安装新的 `.deb`
  （`sudo dpkg -i …` / `sudo apt install ./…`）。所以对于 Linux，跳过自动更新
  的步骤（4–6）；只需把 N+1 安装到 N 之上，然后确认 About 即可。要
  恢复应用内的 Linux 自动更新，把 `AppImage` 重新加回
  `electron-builder.yml` 中的 `linux.target`。
- **Windows：** NSIS 安装程序会就地更新；在构建用 `WIN_CSC_LINK` 签名之前，
  SmartScreen 可能会警告。

如果第 5 步展示的是一个**"下载"**提示条（打开 release 页面），
说明应用内更新器遇到了错误并回退了——查看诊断日志
（`update.error` / `update.check.failed` 条目）来了解原因，最常见的原因是
未签名的 macOS 构建。
