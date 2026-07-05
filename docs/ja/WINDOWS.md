*Languages: [English](../WINDOWS.md) · [Español](../es/WINDOWS.md) · [Français](../fr/WINDOWS.md) · [Deutsch](../de/WINDOWS.md) · **[日本語](WINDOWS.md)** · [한국어](../ko/WINDOWS.md) · [简体中文](../zh-CN/WINDOWS.md) · [Português (Brasil)](../pt-BR/WINDOWS.md) · [Русский](../ru/WINDOWS.md) · [Italiano](../it/WINDOWS.md)*

# Windows で PopBot を実行する

PopBot は Electron + Node 上に構築されており Windows でも動作しますが、macOS とはいくつかセットアップ手順が異なります — 主に 2 つのネイティブモジュール
（`better-sqlite3`、`node-pty`）と、1 つの Electron の癖に関するものです。このドキュメントは、動作確認済みのセットアップをまとめたものです。

## 前提条件

- **Node 20 LTS 以降。** Node 24 でもアプリの*実行*自体はできますが、あまりに新しいため `better-sqlite3` にマッチするビルド済みバイナリが存在せず、素の
  `npm install` は Node の ABI に対してソースからのコンパイルを試みて失敗することがあります（下記「ネイティブモジュール」を参照）。Node 20 / 22 であればこのコンパイルを回避できます。
- **PATH** 上に **Git for Windows**（`git`）と **GitHub CLI**（`gh`）。
- **PATH** 上の **`claude`** CLI（`claude.exe` — PopBot は `where.exe` 経由でこれを検出します）。`codex` は任意です。
- **Visual Studio Build Tools 2022**（*Desktop development with C++* ワークロード付き） — ネイティブモジュールをソースからコンパイルする必要がある場合（例:
  `node-pty` の winpty）にのみ必要です。

## 初回セットアップ

ネイティブモジュールは、あなたのシステムの Node ではなく **Electron** の ABI 向けにビルドする必要があります。信頼できる手順は次のとおりです。

```bash
# 1. ネイティブビルドスクリプトを実行せずに JS の依存関係をインストールします
#    （インストールをロールバックさせる better-sqlite3 の Node-ABI ソースビルドを回避）。
npm install --ignore-scripts

# 2. 手順 1 でスキップされた Electron バイナリをダウンロードします。
node node_modules/electron/install.js

# 3. Electron の ABI に対してネイティブモジュールをビルドします。
npx electron-rebuild -f -w better-sqlite3,node-pty

# 4. 実行します。
npm run dev
```

`--ignore-scripts` を使った場合、手順 2 は必須です — さもないと electron-vite が
`Error: Electron uninstall` で失敗します。

## 遭遇しうる 2 つの落とし穴

### `node-pty` のビルド: `'GetCommitHash.bat' is not recognized`

`node-pty` は **winpty** をバンドルしており、そのビルドは `cd shared &&
GetCommitHash.bat` を実行します。あなたの環境に
**`NoDefaultCurrentDirectoryInExePath=1`**（セキュリティ強化フラグ）が設定されている場合、cmd.exe はカレントディレクトリからの `.bat` の実行を拒否し、ビルドが失敗します。ビルドのためにこれをクリアしてください。

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### 起動時の `Cannot read properties of undefined (reading 'setName')`

これは Electron が Electron としてではなく**素の Node** として起動してしまい、
`electron.app` が `undefined` になっていることを意味します。これは環境に
`ELECTRON_RUN_AS_NODE` が存在する場合に発生します — そして Windows 上では、Electron はその変数の*単なる存在*（空であっても）を「Node として実行する」と解釈します。これは、別の Electron アプリ（VS Code、Claude Code）に埋め込まれたターミナルから起動したときに発生します。これらは
`ELECTRON_RUN_AS_NODE=1` をエクスポートするためです。

`npm run dev` / `npm run start` は `scripts/electron-vite.mjs` を経由し、これが Electron を起動する前にその変数を**削除する**ため、これは対処済みです。`electron-vite` を直接呼び出す場合は、`ELECTRON_RUN_AS_NODE` が（単に空ではなく）未設定であることを確認してください。

## パッケージング

```bash
npm run package:win    # NSIS インストーラー + zip → release/
```

Windows ビルドは現在**未署名**であるため、初回起動時に SmartScreen が警告します。署名するには `CSC_LINK`（`.pfx` へのパス）と `CSC_KEY_PASSWORD` を設定してください。

## 機能パリティに関する注記

- **エージェント、チャット、git worktree、埋め込みターミナル、Git パネル**はすべて Windows 上で動作します。
- **外部アプリランチャー**（スロットごとのアイコン行）: 「Open terminal」（Windows Terminal / cmd）、「Open editor」（VS Code / Cursor）、「Open
  git client」（GitHub Desktop）は配線済みです。**Unity** の起動/フォーカスと、スロットごとの「実行中アプリ」検出は、現時点では macOS 専用です（`ps`/`lsof`/AppleScript に依存しているため）。Windows では no-op になります。
- macOS 固有の部分 — Dock メニュー、ログインシェルの `PATH` パッチ、Chrome プロファイルの URL ルーティング — はガードされており、Windows では単純にスキップされます。
