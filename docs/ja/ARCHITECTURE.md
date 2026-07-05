*Languages: [English](../ARCHITECTURE.md) · [Español](../es/ARCHITECTURE.md) · [Français](../fr/ARCHITECTURE.md) · [Deutsch](../de/ARCHITECTURE.md) · **[日本語](ARCHITECTURE.md)** · [한국어](../ko/ARCHITECTURE.md) · [简体中文](../zh-CN/ARCHITECTURE.md) · [Português (Brasil)](../pt-BR/ARCHITECTURE.md) · [Русский](../ru/ARCHITECTURE.md) · [Italiano](../it/ARCHITECTURE.md)*

# アーキテクチャ

Electron のプロセスモデルと各サブシステムの所在についての実用的な地図です。「なぜ」については [POPBOT_DESIGN.md](POPBOT_DESIGN.md) を参照してください。このドキュメントのすべてがぶら下がっている**オブジェクトグラフ + ライフサイクル + 所有権のルール**については [CORE_MODEL.md](CORE_MODEL.md) を参照してください — 以下の内容が動機不明に感じられたら、まずそちらを読んでください。

## プロセスモデル

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

**ルール:** レンダラーはファイルシステムに一切触れず、子プロセスを一切起動せず、正規の状態を一切保持しません。それらはすべて main の役割です。レンダラーはイベントを購読し、意図をディスパッチします。

## ソースレイアウト

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
    ├── domain.ts                # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## IPC コントラクト

すべての IPC は型付けされ、[`src/shared/ipc.ts`](../../src/shared/ipc.ts) に集約されています — `IpcChannel` 文字列マップ、リクエスト/レスポンスのペイロード型、そして preload ブリッジが公開する `PopBotApi` の表面です。規約:

- **`pb:` プレフィックス** をすべてのチャンネル名に付け、サブシステムごとに名前空間を分けます（`pb:chats:create`、`pb:agent:event`、`pb:reviews:list-for`）。完全な一覧は `IpcChannel` の const を参照してください。
- **リクエスト/レスポンス** は `ipcRenderer.invoke` + `ipcMain.handle` を使います。戻り値は型付けされています。ハンドラーは `main/ipc/*` からサブシステムごとに登録され、`main/index.ts` で配線されます。
- **プッシュイベント**（エージェントストリーム、PTY データ、通知、更新の進捗、ウィンドウの最大化）は `webContents.send` + `ipcRenderer.on` を使います。レンダラーは購読し、main はプッシュします。
- **コンポーネント内での生の IPC は禁止。** preload スクリプト（`src/preload/index.ts`）は型付けされた `window.popbot.*` ブリッジを公開し、レンダラーのコードは `ipcRenderer` を直接呼び出すのではなく、`renderer/src/lib/` のフック/バス（`useChats`、`useReviews`、`agentEventBus`、…）を経由します。

## スロット、コード上の話

スロットは 1 つの構造体ではありません。それは**番号付きのリース**（`slot_id`）と、そのリースが指すディスク上の
worktree/クローンです。リースの状態はチャットの行（`persistence/` の
`chats.slot_id`、`chats.worktree_path`）に存在し、空きスロットの
計算は、そのリポジトリについてスロットを保持している開いているチャットに対するクエリです。リポジトリの
プールサイズは `repos.slot_count` です。`shared/domain.ts` は小さな共有
enum とレガシーな `Slot` レコードを保持しています。

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

スロットの取得・解放・再照合は `git/worktrees.ts`（git
worktree）、`shado/slots.ts` + `scm/*Provider.ts`（VHDX スロット + SCM ごとの
クローン/クライアントのセットアップ）、そして `ipc/repos.ts` + `ipc/chats.ts` のハンドラーに
分散しています。リースの方針については [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit) を、
チャットの作業がスロットをまたいでどう追従するかについては下の**クロススロットの継続性**を参照してください。

## ウォームスロットのストレージ: shado VHDX copy-on-write

AAA 級のツリー（0.5〜1 TB の Perforce ゲームデポ）では、スロットは `git
worktree` やフルチェックアウトにはできません — デポを N 回コピーすることはできず、コールドな
sync+build には数分から数時間かかります。**shado**（同梱の Go 製 CLI、姉妹リポジトリ
`github.com/popbot-ai/shado`、`main/shado/` 経由で呼び出される）は
Windows 上でストレージの基盤を提供します。

- **ベースを飽和させて凍結する。** `shado create <repoPath>` はリポジトリ
  フォルダを拡張可能な VHDX に同期/コピーし、それを**読み取り専用**で凍結します。ベースは
  完全なツリー*に加えて*ウォームな派生状態（ビルドキャッシュ、`node_modules`、
  `Intermediate/`、`Saved/`、`DerivedDataCache/`、…）を保持します。
- **差分の子 = スロット。** 各スロットは、凍結されたベースからの copy-on-write な VHDX の子
  （`shado clone create --slot N`）で、`Mount-VHD` +
  `Add-PartitionAccessPath` によって**マウントポイントフォルダ**（ドライブレターではないため、
  約 20 スロットを超えてスケールできます）にマウントされます。新鮮でビルド可能なスロットは、1 TB の
  再同期 + コールドビルドではなく、数秒と数 GB の差分で済みます。リセット = 子を破棄して
  ベースから再作成（即座にクリーン）。
- **レイアウト。** スロットはリポジトリと**同じドライブ**に存在します（VHDX モデルが
  それを要求します）: `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`。
  ベース + 差分 + スロットのメタデータは `…/workspaces/<repoId>/shado`
  （`SHADO_HOME`）の下にあります。パスは `main/shado/client.ts`
  （`popbotRootForRepo`、`shadoHomeForRepo`）で導出されます。
- **昇格。** `shado create` / `clone create` / `remount` / `restore` には
  管理者権限が必要です。PopBot は非昇格で動作するため、これらは単一の UAC
  （一時的な `.bat` + `Start-Process -Verb RunAs`）を通じて起動されます。昇格して作成されたクローンは
  Administrators グループの所有になるため → git は呼び出しごとに `-c safe.directory=*` を
  受け取り、p4 のクライアントはホストロックされます。
- **再起動。** VHDX のマウントは再起動を生き延びません（デタッチされたクローンと壊れた
  マウントポイントの reparse フォルダ）。起動時に切断されたスロットリポジトリを検出し、
  ユーザーがクリックする**中央モーダル**（「Reconnect」）を表示します — 1 回の UAC ですべてを
  再マウントします（`remountReposElevated`）。`main/shado/base.ts` を参照してください。

git-worktree のパス（shado を使わないリポジトリでの `repo.mode = 'slots'`）は通常のリポジトリ向けに
今も存在しています。shado は VHDX/Perforce のケースでリポジトリごとに選択されます。

### SCM ごとのスロットセットアップ

スロットは共有されたチェックアウトではなく**独立したクローン/クライアント**です — これが
下のクロススロットの継続性の背後にある重要な事実です。

- **git**（`scm/gitProvider.ts`）: スロットは凍結されたベースのフルクローンです。
  `ensureSlotWorktree` はそれを `popbot/slot-N` に配置します。`checkoutBranch` は**最新の**
  ベースからチャットのブランチを作成します（`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`）。継承されたベースの汚れは破棄しつつ、gitignore された
  ウォームキャッシュは保持します。
- **perforce**（`p4/*`、`scm/perforceProvider.ts`）: 各スロットは、マウントを
  ルートとする独自の p4 クライアント `popbot_<repoId>_slot<N>` を持ちます。セットアップは `p4 flush
  @baseChangelist`（凍結されたベースに対する 0 バイトの have テーブル更新）+ ベース→ヘッドの
  差分だけの `p4 sync` です。`p4 reconcile`（ゲームデポでの 20 分のツリー
  走査）は**行いません**。スロットごとの `fs.watch` が変更されたパスを記録し、
  プロバイダーはそれらだけを対象にした `p4 edit/add/delete` で開きます。PopBot 自身の
  書き込み（sync/revert/unshelve）はウォッチャーを**一時停止**するので、再度開かれることはありません。

## クロススロットの継続性: チャットのブランチ/チェンジリストの本拠地

**問題。** 各スロットは独立したクローン（git）/クライアント（perforce）であるため、
チャットのブランチや保留中のチェンジリストは、それが**作成されたスロットにだけ**存在します。チャットは
共有プールからスロットを借り、*別の*スロットで再オープンすることがあります — そこにはその作業が
存在しません。（古い `git worktree` モデルにはこの問題はありませんでした。すべての worktree が
1 つの `.git` を共有しており、ブランチは中央集権的だったからです。）

**解決策。** チャットの作業を、閉じるときにスロットに依存しない**本拠地**に集約し、
再オープン時に復元します。`SourceControlProvider.persistChatOnClose`
/ `restoreChatOnReopen` にフックされ、`ChatsClose` / `ChatsReopen` ハンドラー
（`ipc/chats.ts`）から呼び出され、古いスロットローカルなスタッシュを置き換えます。チャットに
永続化される状態: `chats.p4_shelf_cl`（perforce。git は何も必要ありません）。

- **git → ローカルルートリポジトリ。** 本拠地は `repo.repoPath` です — すべてのスロットが
  クローンされた元であるディスク上のリポジトリフォルダで、各スロットに `root` リモートとして
  追加されます（`origin` は PR のために実際の GitHub リモートのままです）。
  - *閉じるとき:* 未コミットの作業を使い捨ての `[Soft committed unstaged
    files]` コミットとして運び（ユーザーが破棄しない限り）、その後 `git push -f root <branch>` します。
    ローカルルートは、すべてのチャットのブランチを蓄積します（そのブランチ一覧 = 古い
    共有 worktree の挙動）。
  - *再オープンするとき:* ベースのチェックアウト後、`git fetch root <branch>` → `checkout -f
    -B branch FETCH_HEAD` → WIP コミットをソフトアンドゥして編集を未コミットの状態に戻します。
- **perforce → シェルフとしてのルートクライアント。** 保留中のチェンジリストはスロットごとなので、
  本拠地は、安定した、決して同期されないリポジトリごとのクライアント
  `popbot_<repoId>_root`（`ensureRootClient` — スペックのみ、同期なし）が所有する、サーバー側の**シェルフ**です。
  - *閉じるとき:* スロットの CL を `p4 shelve` し、それをチャットのルート所有の CL に
    `p4 reshelve -f` します。**`reshelve` はシェルフの内容をサーバー側で移動します** — Helix
    2025.2 で検証済み: クライアントをまたぎ、ワークスペースの同期なし、ルートのディスクには何も書き込まれません
    （「ファイルを変更せず、シェルフを移動する」）。その後、スロットのシェルフ + 開かれたファイル + CL を
    削除するので、スロットは**空**の状態で終わります。ルートクライアントはチャットごとに 1 つの
    シェルフされた CL を所有します。
  - *再オープンするとき:* ウォッチャーを一時停止した状態で、`p4 unshelve -s <rootCl> -c <newSlotCl>` を
    新しいスロットの新しい CL に実行し、ルートのシェルフは駐機されたバックアップとして残します。

要するに、スロットは交換可能なスクラッチ領域であり、ローカルルートの git リポジトリと
ルートの p4 クライアントが、進行中の作業の永続的で、ユーザーから見える本拠地です。

## エージェントバックエンド

`AgentBackend`（`main/agents/types.ts`）は `AgentHost` と
具体的なバックエンドの間のインターフェースです。**今日、2 つの実バックエンドが出荷されています** — `ClaudeBackend`（
`@anthropic-ai/claude-agent-sdk` をラップ）と `CodexBackend`（`@openai/codex-sdk` をラップ）
— に加えてテスト用の `StubBackend` です。チャットは自身のバックエンド（`chats.agent`）を選び、
切り替えることができます。2 つの SDK は異なるネイティブの resume ハンドル、モデル、
effort の設定を持つため、それらは**プロバイダーごとにスコープされて**永続化されます
（Claude の `session_id` + `claude_model`/`claude_reasoning_effort`。Codex の `codex_thread_id` +
`codex_model`/`codex_reasoning_effort`）。`AgentHost` はバックエンドを選択し、
チャットごとに 1 つのセッションを起動し、各セッションの `AgentEvent` を
レンダラー + 永続化層に再配信します。

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

スロットごとのエディタ MCP は起動時にバックエンドに渡されます: `SpawnOpts.mcpServers` は
チャットの Unity/Unreal エディタのエンドポイント（`{ type: 'http', url }`）を運び、
SDK のオプション内にメモリ上で登録されます — ディスクには何も書き込まれません。`mcpHttp` 対応の
バックエンドだけがそれを消費します。下の**スロットごとのエディタ MCP** を参照してください。

`canUseTool` コールバックは、エージェントのプロンプトの中ではなく、バックエンドの隣に存在します — それが私たちのハードな拒否権を持つ安全境界です。ルール解決（`resolveRule`）は、プロンプトを出す前にチャットごと、次いでグローバルな権限ルールを参照します。[adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md) を参照してください。

## 永続化

- **`better-sqlite3`** を `<userData>/popbot.db` に配置（macOS: `~/Library/Application
  Support/PopBot/`。Windows / Linux でも `app.getPath('userData')` により OS ごとの同等のパス）。
  スキーマは `persistence/db.ts` 内の番号付きマイグレーションリストです
  （`user_version` によってゲートされ、各ステップはアトミックです）。現在のテーブル:
  - `chats` — チャットごとに 1 行: スロットのリース（`slot_id`）、`worktree_path`、`repo_id`、
    アクティブな `agent`、プロバイダーごとのモデル/effort + resume ハンドル（`session_id`、
    `codex_thread_id`）、`permission_rules`、そしてクロススロットの状態（`p4_shelf_cl`）。
  - `messages` — エージェントのイベントごとに 1 行（永続的なトランスクリプト）。
  - `repos` — リポジトリごとの設定（パス、色、スロットのプレフィックス、デフォルトのベース、スロット数、
    `mode` = `slots`/`ephemeral`、`scm`、`p4_config` の JSON）。
  - `settings` — JSON のキー/バリューによるアプリの設定（連携の認証情報の参照、UI 設定）。
  - `notifications` — アプリ内の通知フィード。
  - `sdk_session_entries` — Claude SDK の SessionStore の裏テーブル（チャットをキーとする。
    PopBot が復旧用のコピーを所有するため、resume は `~/.claude` の JSONL に依存しません）。
  - `codex_thread_events` — Codex のストリームイベントの生データの永続キャッシュ（Codex は
    `~/.codex/sessions` から resume します。これは PopBot 自身の復旧/診断用のコピーです）。

  チケット/PR のキャッシュ*テーブル*は**存在しません**。Tickets と Reviews のキューは
  SQLite ではなくレンダラーでキャッシュされます（`list-recent` の IPC コメントを参照）。
- **スロットごとのスクラッチ**は、スロットの worktree/マウントと、チャットごとの
  ランタイムディレクトリ（エージェント CLI のセッションファイル、PTY、保持された添付ファイル）に存在します。shado の VHDX スロットは
  リポジトリのドライブ上の `…/popbot/workspaces/<repoId>/…` に存在します（shado のセクションを参照）。
- **シークレット**は `keytar`（OS のキーチェーン — macOS Keychain / Windows Credential
  Vault / libsecret）経由です。SQLite の DB にも、ログにも決して残りません。

## チケットソース、SCM プロバイダー、レビュー、エディタ、更新

トップレベルのサブシステムがぶら下がる 5 つのプロバイダー接続点です。すべて、
バックエンドの追加をローカルに保ち、呼び出し側を汎用に保つよう設計されています。

- **チケットソース**（`tickets/`）。1 つのアクティブな `TicketSource` が Tickets
  キューに供給し、`tickets/registry.ts` を経由して `ticketSource` 設定で選ばれます（Linear /
  Jira / GitHub。デフォルトは Linear）。すべてのソースは共有の Linear
  DTO に正規化されるため、レンダラーはすべてのトラッカーを 1 つの経路でレンダリングし、`shared/ticketProvider.ts` の
  能力（capabilities）だけで分岐し、プロバイダー id では決して分岐しません。
  トラッカーの追加は、レジストリ内の 1 行 + `*Source.ts` + 記述子です。
- **SCM プロバイダー**（`scm/provider.ts`、`scm/index.ts`）。`SourceControlProvider`
  は小さな共通の表面です（ワークスペースのライフサイクル、作業ツリーのレビュー、PR/レビュー
  の検出、クロススロットの継続性）。`GitProvider` と `PerforceProvider` は実装済みです。
  `lore` は下書き段階です。`scm/index.ts` は id ごとに 1 つのインスタンスを返します。**呼び出し側は
  能力（`shared/sourceControl.ts`）で分岐し、プロバイダー id では決して分岐しません** — きれいに
  抽象化されないものはすべて能力フラグであり、あまりにも異質なプロバイダーは
  `capabilities.nativeClientUi` を通じて独自のクライアントウィンドウを選択できます。
- **レビュー**（`reviews/`、`git/reviews.ts`、`p4/swarmReviews.ts`）。
  プロバイダーに依存しないオーケストレーターが、設定されたリポジトリを SCM ごとにグループ化し、
  各プロバイダーのレビューメソッド（`capabilities.pullRequests` によってゲートされる）にディスパッチし、
  GitHub PR と Helix Swarm のレビューを 1 つのパネルにマージします。各プロバイダーは自身の**
  ポーリング周期**を持ちます（`reviewPollIntervalMs` — 共有された p4d を保護するため Swarm は GitHub より
  遅くなります）。パネルはプロバイダーごとに 1 つのタイマーを動かします（`pb:reviews:providers` /
  `pb:reviews:list-for`）。
- **スロットごとのエディタ MCP**（`ipc/apps.ts`、`shared/gameEngine.ts`）。エンジン
  （Unity / Unreal / カスタム）は独立して有効化できます。`useMcp` がオンのとき、各
  スロットのエディタは**スロットごとの MCP ポート**（`mcpBasePort + (slotId-1)`）で起動されるため、
  並列のエディタが衝突しません。`mcpEndpointForChat` は起動時にエージェントにそのスロットの
  エディタ MCP HTTP URL を渡します。エディタは**デタッチされた**状態で起動され（フォーカスするか
  起動するか）、監視される長命な子プロセスではありません。
- **更新**（`updates/`）。electron-updater による自動更新に加え、About ダイアログ用の
  オンデマンドチェック（`pb:updates:*`）。

## 横断的関心事

- **ロギング** — main は `diagLog`（`dlog`）経由で診断ログを書き込みます。エージェント CLI
  と PTY はそれぞれチャットごとのランタイム出力を持ち、レンダラーのログは IPC を経由して main を
  通ります。
- **起動時の復旧** — 復旧は PID ファイルベースではなく、DB とセッションに基づいて駆動されます
  （`main/index.ts` の起動シーケンス）: `initDb()` が保留中のマイグレーションを実行し、
  `clearStaleRunningStatuses()` が `run` のまま残っているチャットを `idle` に戻し（
  前回の実行のエージェントセッションはもう存在しません）、セッションストアのインポート + SDK のプロジェクトディレクトリ
  マイグレーション + `sessionPinRepair` + `recoverChatSessions` が、実際にディスク上にあるものに対して
  ピン留めされた Claude/Codex のセッションを整合させ、CLI のプローブがどのバックエンドが
  オンラインかを報告します。Windows では、切断された shado VHDX のスロット（再起動で
  マウントが外れたもの）が検出され、1 回の UAC での再マウントのために表示されます（上の
  shado の**再起動**の注記を参照してください）。
- **更新** — electron-updater による自動更新。上の**更新**プロバイダーの項を参照してください。
