# PopBot 設計

AutoRPG 向けのマルチエージェント開発オーケストレーター。Conductor に着想を得ており、エージェントが実際のゲームを起動し、画面を操作し、動作を検証できるよう、ゲーム内テストのインフラを追加している。

> **ステータス:** 設計 — 2026-05-01 にロック。生きたドキュメントであり、実装中に判明した内容はその場で更新する。
>
> **まずこれを読むこと:** [USER_STORIES.md](USER_STORIES.md) には、この設計が実現すべき 6 つの成果が定義されている。本ドキュメントとユーザーストーリーが食い違う場合はユーザーストーリーを優先し、本ドキュメント側を更新する。

## ゴール

1. 複数の AI 開発エージェントを、それぞれ専用の git worktree の中で並列に実行する。
2. エージェントが実際のゲーム（ウィンドウ表示された Unity Editor）を操作し、エンドツーエンドのテストを行えるようにする。
3. チケット / PR / Slack のキュー、トランスクリプト履歴、ログ、ターミナルを 1 つのウィンドウにまとめて表示する。
4. デフォルトは自律動作とし、本当にブロッキングとなるイベントの時だけ一時停止する。

## 非ゴール（v1）

- 本番 CI/CD（別の関心事）
- クロスプラットフォーム対応（macOS のみ。必要になれば後で Linux/Windows）
- マルチユーザー / SSO（1 台のマシンにつき開発者は 1 人）

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

左上のタブ: **Tickets**（自分にアサインされた Linear のチケット）と **Reviews**（自分にレビューが依頼されている PR）。行をクリックすると、その作業内容で初期化されたチャットが起動する。

## Slots — the durable unit

スロット = git worktree + その Library + （任意で）実行中の Unity Editor + （任意で）実行中のサイドカーサーバー。**スロットの作成は稀にしか行わず、作成後は継続的に再利用する。**

### スロットごとのディレクトリ構成

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

### 実測コスト（2026-05-01、AutoRPG 上で計測）

| 操作 | 時間 |
|---|---|
| `git worktree add`（新規、6.2 万ファイル、LFS smudge） | 約 23 秒 |
| master からの Library COW（APFS clonefile） | 約 1 秒 |
| スロット上での初回 Unity 起動（Library がコールド） | 1〜3 分 |
| スティッキーヒット（Unity 起動済み・アイドル） | 約 50 ms |
| コールドスタート（Unity 停止中、ブランチは一致） | 15〜30 秒 |
| 既存スロット内でのブランチ切り替え（差分 + Unity リロード） | 5〜15 秒 |
| スロット作成の合計（worktree add + COW + 初回インポート） | 約 1〜3 分、**稀** |

### ディスク予算

スロットあたり約 14 GB（Library 8 GB + Assets 5.5 GB + スクラッチ領域）。4 スロットで約 55 GB。共有される `.git`（約 8 GB）は 1 回のみカウント。

### リース方針

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### ブランチの一意性

Git は同じブランチを 2 つの worktree で同時にチェックアウトすることを拒否する。これは以下で解決する。
- **Lite / レビュー用チャット** は detached HEAD を使う（競合なし）。
- **同一ブランチ上の 2 つのテストチャット** — 2 つ目は一時ブランチ（`<branch>-slot-N`）または detached HEAD を使う。PopBot のスケジューラーが自動で選択する。

### チェックアウト前の安全策

既存スロットでブランチを切り替える前に:

1. `git stash --include-untracked`（常に実行。安全網として）。
2. エージェントが所有する未ステージのコミットがある場合は拒否する。先にコミットするか、明示的に失敗させる。
3. 開いている Unity のシーンを閉じる（ブランチをまたいだ GUID 解決の問題を避けるため）。
4. `git checkout <branch>`。
5. 該当する場合は stash を pop するか、ブランチごとの stash 記録から復元する。

### スロットごとのポリシー設定（prefs 内）

- `pinnedBranch?` — 他ブランチへのリースを拒否する。主作業用スロットに使う。
- `cleanOnRelease: bool` — リリース時に `git clean -fd && git checkout .` を実行する。デフォルトは無効。
- `autoStashOnSwitch: bool` — デフォルトは有効。

## リソース予算（独立したノブ）

スロットと稼働中の Unity インスタンスは**別々の予算**である。スロットは Unity をオフにしたままでも存在でき、その場合は単なるストレージにすぎない。Unity の実行は RAM に律速され、独立してダイヤル調整できる。

| 予算 | ユニットあたりのコスト | デフォルト | ユーザー設定 |
|---|---|---|---|
| **スロット数**（ディスク上の worktree） | 約 14 GB | 2〜4 | Prefs: "Slots" |
| **アクティブ Unity の最大数**（実行中プロセス） | 約 3〜4 GB RAM | 2 | Prefs: "Max active Unity" |
| **Unity のハード上限**（自律モードでの自動承認上限） | — | 計算式: `floor(systemRAM / 4 GB)` | Prefs: "Unity hard cap" |

### リース方針（拡張版）

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### エージェント主導のダイヤルアップ

Unity のキャパシティ不足でエージェントがブロックされているときに使える、新しい MCP ツール。

| ツール | モード | 戻り値 |
|---|---|---|
| `request_unity_capacity` | 同期 | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

動作:

- **インタラクティブなチャット** → チャットが黄色になり、ユーザーに承認を求めるバナーが表示される。
- **自律チャット** → `Unity hard cap` までは自動承認し、それを超える場合は人間の判断のため一時停止する。
- ユーザーは prefs でいつでも事前にダイヤルの上げ下げが可能。ダイヤルダウンは（ビジー状態のものは除き）LRU のアイドル Unity を退去させる。

## Chat types

| 種類 | スロット | Library | Unity | サイドカー | 起動 | RAM |
|---|---|---|---|---|---|---|
| **Lite**（レビュー、プラン、トリアージ） | 任意 | — | — | — | 約 1〜2 秒 | 約 50〜100 MB |
| **Client Test** | 必須 | スロットが所有 | 画面 2 に GUI 表示 | ローカルまたはリモート | 50ms〜30秒 | 約 2〜4 GB |
| **Server Test** | 必須 | スロットが所有 | 画面 2 に GUI 表示 | 常にローカル | 50ms〜35秒 | 約 2〜5 GB |

新規チャットのデフォルトは **Lite**。実際にゲームテストが必要になった時点で昇格させる。

## サーバーモード

チャットごとの設定。実行中でも切り替え可能。

| モード | サーバーのソース | 使用場面 |
|---|---|---|
| `local`（デフォルト） | スロットごとの `./run_local.sh --port <P> --data-dir <D>` | 日常的なエージェント実行、バックエンドの変更、決定論的な状態が必要な場合 |
| `remote-dev` | 共有のリモート開発サーバー | 純粋なクライアント側の反復作業。ドリフト検出がエントリーをガードする |

### ドリフト検出

remote-dev のリースが受け入れられる前に: PopBot はローカルの `Assets/Scripts/Simulation/GameDataHash.cs` の定数と DTO バージョンを読み取り、リモートの `/health` に GET して比較する。不一致の場合は構造化されたエラーでリースを拒否する。

### `/health` の戻り値

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### セッション途中でのトグル

ユーザーがチャット設定で `Server Mode` を切り替えると、PopBot は次を行う。

1. ドリフトチェック（remote-dev に入る場合）。不一致であれば拒否。
2. 必要に応じてサイドカープロセスを停止 / 起動。
3. MCP 経由で `client_set_server_endpoint { url }` を呼び、実行時に接続先を付け替える。
4. ゲーム内セッションのリセット（ログアウト / タイトル画面）を強制する — 旧認証は無効になるため。
5. 実行中のジョブをキャンセルし、「サーバーが変更されました。タスクを再起動してください」とバナー表示する。

## チャットごとの設定パネル

| 設定 | デフォルト | 備考 |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = 安全な操作は自動承認し、本当に詰まったときだけ一時停止 |
| Server mode | `local` | `remote-dev`（ドリフトチェックあり） |
| Window mode | `GUI on screen 2` | `Headless`（後日、オプトイン） / `Visible` |
| Time scale | `1.0` | アニメーションを早送り |
| Game view resolution | `1920×1080` | スクリーンショットの再現性のため固定 |
| Auto-screenshot every action | off | 証跡バンドル用 |
| Verbose logs | off | エージェント自体をデバッグするときに切り替え |
| Agent backend | `claude` | `codex`（Phase 4） |
| Default fixture | none | セーブデータの blob から起動 |
| Token budget | `1M` | 到達時に一時停止（自律モード） |
| Time budget | `60m` | 到達時に一時停止（自律モード） |
| Loop detection | on | 同一ツール呼び出しが N 回連続、または K 分間進捗なしで一時停止 |

## Autonomous mode

### ポリシーエンジン — `canUseTool` にフックする

ポリシーをプロンプトに埋め込まないこと。モデルは自分でそれを覆すような発言をしてしまえるからだ。SDK のハード veto フックを使う。

**自律モードで自動承認する対象（サイレント）:**

- スロットの worktree 内での Read / Edit / Write / Grep / Glob
- worktree 内での Bash（下記の deny リストあり）
- スロット自身の MCP サーバーへの MCP 呼び出し
- Skill / サブエージェントの呼び出し
- TodoWrite、SDK 内部の操作

**（自律モードであっても）常に人間の確認を待つ対象:**

- `git push`、`git reset --hard`、`git checkout --`、あらゆる force 系操作、ブランチ削除
- スロットの worktree パス外へのあらゆる操作
- 許可リスト外のホストへのネットワーク呼び出し
- `tmp/` またはスロットディレクトリ外での `rm -rf`
- `gh pr create` および GitHub への公開を伴うあらゆる操作
- Slack / メール / 外部へのメッセージ送信
- `~/.claude`、`.mcp.json`、システム設定の変更

### 「本当に詰まっている」の検出

**エージェントの自己申告**（SDK の `message_done` の形状経由）:

- 確認質問
- 明示的なブロッカー
- 終端の「完了しました」

**PopBot 側の監視**（多層防御）:

- ループ — 同一のツール呼び出しが N 回連続
- 停滞 — K 分間、進捗イベントがない
- トークン / 時間の予算超過
- 同じテスト失敗の繰り返し（同じ失敗が K 回）

### Status colors (chat thumbnail)

| 色 | 状態 |
|---|---|
| 青 | 実行中 |
| 緑 | タスク完了 |
| 黄 | 一時停止 — ユーザー対応が必要 |
| 赤 | エラー |
| 灰 | アイドル / 未開始 |

自律モードでは、サムネイルの中から**黄色**を探す。それ以外は問題ない。

## MCP automation surface

### ルール: すべてのツールは約 100 ms 以内に応答を返す

時間のかかる操作は即座に `{ jobId }` を返し、エージェントはポーリングする。MCP の HTTP リスナーを 100 ms 以上ブロックしてはならない。

### ジョブ基盤

| ツール | モード | 戻り値 |
|---|---|---|
| `job_status` | 同期 | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | 同期 | ツールの完全なペイロード。ジョブを破棄する |
| `job_cancel` | 同期 | 協調的なキャンセルフラグを立てる |
| `job_list` | 同期 | アクティブなものと直近のもの（TTL 約 60 秒） |

コルーチンは `EditorCoroutineUtility.StartCoroutineOwnerless` 経由で動き、`EditorApplication.update` によって駆動される。`JobContext` は `SetProgress(float, msg)`、`Canceled`、`SetResult(JObject)`、`Fail(error)` を公開する。

### ツールカタログ — Phase 1 の最小構成

**ライフサイクル:**

- `play_status`（同期）、`play_pause` / `play_resume` / `play_step`（同期）、`time_scale_set`（同期）
- `play_enter`（ジョブ）、`play_exit`（同期）
- `editor_quit`（同期）

**観測:**

- `screenshot`（同期） — `Library/MCP/Screenshots/{session}/{label}.png` に書き出し、パスを返す
- `game_state_summary`（同期） — 画面スタックの最上位、通貨、レベル、チャプター、装備、アンロック状況、直近 10 件のエラー
- `screen_stack`（同期）、`chapter_status`（同期）
- `ui_tree`（同期） — 解決済みの `text-loc` を伴う階層構造
- `ui_query`（同期） — CSS ライクなセレクタ（`.btn`、`#Confirm`、`[text-loc=Friends.Title]`）

**操作:**

- `ui_click`（同期）、`ui_click_by_loc`（同期） — `panel.SendEvent` 経由で `PointerDown/Up/ClickEvent` を発火

**同期 / 待機:**

- `wait_until`（ジョブ） — 述語: `screen`、`log`、`event`、`path`
- `wait_for_idle`（ジョブ）

**ログ（既存の拡張）:**

- `console_get_logs` — `sinceTimestamp`、`dedupe`、`dumpTo`、`includeStack: "none"|"first"|"all"` を追加
- `server_logs`（同期） — PopBot の `server.log` を tail する。`console_get_logs` と同じ形状
- `server_health`（同期）、`client_set_server_endpoint`（同期）

**セッション:**

- `mcp_session_start` / `mcp_session_end` — `tmp/mcp-sessions/{slug}/` に予測可能な成果物ディレクトリを作る

### ツールカタログ — 以降のフェーズ

- `command_apply`、`command_list` — UI を経由しない主要なアクションサーフェス
- `save_blob_get` / `save_blob_load`、フィクスチャ管理
- `crash_dump`、`ui_dump_uxml`、`ui_drag`、`events_pop`、`gameview_resolution_set`
- `game_state_path` — 許可リスト化されたルートを使う、リフレクションベースのリーダー

## ウィンドウ管理

デフォルト: ネイティブヘルパーによってウィンドウ位置が配置される GUI Editor。

**ネイティブ macOS ウィンドウムーバー（約 50 行の Swift）:**

1. ヘルパーがウィンドウ出現から約 100 ms 以内に掴めるよう、タイトな `AXUIElement` ポーリング（50 ms 間隔）。
2. 画面 2 上の設定済みの矩形へ `setFrame:` を適用。
3. `kAXMinimizedAttribute = true`（Dock に格納）。
4. フォーカスを奪わない。

**起動前にウィンドウ位置の `EditorPrefs` を事前設定する。** Unity は起動時に直前のウィンドウ位置を復元するため、*2 回目以降*の起動はすでに配置済みの状態で開く。初回起動時は一瞬（約 200 ms）だけ表示がちらつくが、以降の起動ではちらつかない。

**ユーザー側で一度だけ行う設定**（PopBot の初回起動時ドキュメントに記載）: `Dock → Unity を右クリック → オプション → 割り当て先: デスクトップ X`。これにより macOS は以降の Unity ウィンドウをその Space に自動でルーティングする。これを設定しておけば、初回起動時のちらつきさえもユーザーが見ていない Space 上で起きる。

複数の Unity が画面 2 上の予測可能な位置に配置されるよう、スロットごとに位置を設定可能にする。

**ヘッドレスの `Window Mode`** は、batchmode の検証が通った後（Phase 4 あたり）のオプトインとする。アーキテクチャは同一で、起動フラグのみが変わる。

## サーバー / Unity ペアリングプロトコル

起動順序とライフサイクルを厳密に管理しないと、見えにくい障害にぶつかる。

### 起動シーケンス（PopBot が強制する）

1. `./run_local.sh --port S --data-dir D` を起動する。標準入出力を `server.log` に tee する。`server_pid` を記録する。
2. `/health` が 200 を返すまでポーリングする（`commit`/`gameDataHash`/`dtoVersion` を含む）。タイムアウト 30 秒。失敗した場合はサーバーを kill し、エラーを表示する。
3. worktree 内に `client-server.json` を書き込み、`localhost:S` を指す。
4. `POPBOT_MCP_PORT=M` を付けて Unity を起動する。`unity_pid` を記録する。
5. `/mcp` が 200 を返すまでポーリングする。タイムアウト 60 秒。失敗した場合は両方を kill し、エラーを表示する。
6. ネイティブウィンドウムーバーが実行される。
7. スロットが稼働状態になり、エージェントがリース可能になる。

### 障害の連鎖

- **セッション途中でサーバーが落ちた場合** → PopBot は PID の生存確認と `server_health` の 5xx で検知し → スロットを degraded にマークし → サーバーの再起動を 1 回試み → それも失敗すればチャット上に赤で表示する。
- **Unity が落ちた場合** → サーバーは動き続ける（サーバーは Unity の再起動をまたいで生き続けるほうが安上がりなため）。PopBot は同じサーバーに対して新しい Unity を起動できる。
- **スロットの解放** → サーバーへ SIGTERM（5 秒の猶予）→ SIGKILL → Unity へ `editor_quit` の MCP 呼び出し → SIGTERM（5 秒の猶予）→ SIGKILL。

### PopBot 起動時の整合性チェック

slot.json ファイルをスキャンし、記録された pid ごとに `kill -0 <pid>` を実行する。プロセスが死んでいれば状態をクリーンアップし、スロットをリセットする。標準的な孤立プロセスの後始末。

## エージェント統合

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

これによって無料で得られるもの: skills、memory、サブエージェント、hooks、MCP、構造化イベントとしての権限リクエスト。**`claude` CLI をサブプロセスとしてスクレイピングしないこと** — 高度な機能のたびに SDK と衝突することになる。

### AgentBackend インターフェース（初日から定義。v1 では実装は 1 つ）

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

Codex バックエンド（Phase 4）は OpenAI Agents SDK をこのインターフェースに適合させる。Skills/memory は利用できず、UI で明確にフラグ表示する。

### チャットごとの MCP 設定

各エージェントは**そのスロット**用のポートが注入された `mcpServers` を伴って起動する — `popbot-unity` の URL は `localhost:<slot.mcpPort>/mcp` となる。それ以外の MCP（Linear、Sentry、Amplitude、BetterStack）は `~/.claude/settings.json` または `.mcp.json` から SDK によって自動的に継承される。

## Tech stack

- **Electron**（Node + Chromium）
- UI 用の **React + Tailwind**
- ターミナルパネル用の **xterm.js + node-pty**
- トランスクリプト永続化用の **better-sqlite3**（1 イベント 1 行、チャット + タイムスタンプでインデックス）
- OAuth トークン / API キー / エージェント資格情報用の **keytar**
- チケットパネル用の **Linear GraphQL API**
- 未レビュー PR パネル用の **`gh` GraphQL**
- ウィンドウ配置用の **ネイティブ Swift ヘルパー**

## Phasing

### Phase 0 — 前提条件（約 3 日）

| 項目 | 担当 | 規模 |
|---|---|---|
| MCP の `POPBOT_MCP_PORT` 環境変数オーバーライド | Unity MCP | 5 分 |
| `./run_local.sh --port` + `--data-dir` 引数 | server | 30 分 |
| `/health` が `commit`、`gameDataHash`、`dtoVersion` を返す | server | 30 分 |
| ネイティブ macOS ウィンドウムーバーヘルパー（Swift） | PopBot | 約半日 |
| スロットライフサイクルのプロトタイプ（worktree add、Library COW、ブランチ切り替え、stash の安全策） | PopBot | 約 1 日 |

### Phase 1 — MCP 自動化サーフェス（約 3〜5 日）

ジョブ基盤 + 上記の Phase 1 ツールカタログ。既存の長時間ツール（`rebuild_gamedata`、`rebuild_dtos`、`addressables_build`、`addressables_clean`）をジョブモデルへ移行する。

### Phase 2 — PopBot Electron MVP（約 1〜2 週間）

単一のチャットカラム、`ClaudeBackend` のみ、単一スロット、単一 Unity。設定パネルの骨格。`canUseTool` ポリシーエンジン。ネイティブヘルパーの統合。エンドツーエンドのループ: チャットを開く → エージェントがコードを編集する → エージェントがゲームを実行する → エージェントがスクリーンショットとログで検証する → 完了。

### Phase 3 — マルチチャット + パネル（約 1 週間）

複数のチャットカラム（フローティングの +/x で追加/削除）。ステータスカラー付きのサムネイルストリップ。Linear チケット + 未レビュー PR パネル。Unity/server タブが並んだ下部ログパネル。チャット設定内のモード / サーバーモードのトグル。

### Phase 4 — 磨き込み + 高度な機能

Codex バックエンドアダプタ。ヘッドレスの `Window Mode`（batchmode 検証後）。`crash_dump`、`events_pop`、`command_apply`、フィクスチャ管理。ログの時刻相関表示（並列表示）。自律性の予算とループ検出の改善。

## オープンな課題

1. **Batchmode の検証** — AutoRPG は実際に `-batchmode` の Play モードで動作するか？ Phase 4 あたりで検証スクリプトを用意する。v1 のブロッカーではない。
2. **マスター Library のリフレッシュ頻度** — 手動ボタンか、自動か、N 日 TTL か？ デフォルトは prefs 内の手動ボタン。
3. **スロット数のデフォルト** — 4 に固定するか、RAM / コア数でスケールさせるか？ おそらくデフォルト 2〜3、設定可能とする。
4. **PopBot リポジトリ** — `autorpg` と分離するか、`tools/popbot/` に置くか？ 安定してきたら分離する。開発初期はイントリー（同一ツリー内）とする。

## リスク

| リスク | 緩和策 |
|---|---|
| stash 中に `git checkout` がスロットを壊す | 常に先に stash する。チェックアウト後にクリーンであることを検証する。dirty なら拒否する |
| 2 つの PopBot インスタンスが同じスロットを踏みつぶす | スロットディレクトリごとのロックファイル。起動時に孤立状態を整合させる |
| Unity がハングし、スロットのリースが解放されない | PID の生存確認 + PopBot 起動時の GC |
| worktree をまたいだ LFS ロックの競合 | 稀なケース。発生時には明確に表示する |
| スロットの Library が master から大きく乖離する | 手動の「スロットをリセット」で master から再構築する |
| ディスクが満杯になる | prefs にスロットごとのサイズを表示する。「reset」で回収する |
| remote-dev でのセッション途中のバックエンドドリフト | エラー時に `server_health` を再チェックする。バナー表示して停止する |
| 自律モードが安全でない操作を自動承認してしまう | `canUseTool` にハードコードされた deny リストを設ける。チャット設定では絶対に上書きできない |

## Proof artifacts (agent debug deliverable)

エージェントがデバッグタスクを完了すると、`tmp/mcp-sessions/{slug}/` に以下を書き出す。

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` は 6 セクションのテンプレート（Repro / Before / Root Cause / Fix / After / Verification）に従う。この規約は SKILL（`agent-debug`）内に文書化されており、MCP は予測可能なセッションパスを提供するのみである。

## クイックリファレンス — 以前の提案からの変更点

本ドキュメントを生んだ会話を読む人向けに:

- Library プール / プロセスプール / worktree プールは**単一の概念「スロット」に統合された。** スロットは自身の worktree、Library、任意の Unity、任意のサイドカーを所有する。シンボリックリンクも、別々のプールもない。
- `git worktree add` は**AutoRPG 上で約 23 秒**（6.2 万ファイルにわたる LFS smudge）であり、1〜2 秒ではない。スロット作成は稀であり、チェックアウトによる再利用こそが日常的なホットパスである。
- **画面 2 上の GUI Editor** が v1 のデフォルト。ヘッドレスの batchmode は検証後の Phase 4 でのオプトイン。
- サーバーはイントリー（同一ツリー内）で `./run_local.sh` 経由で動作する。分離のためスロットごとにポート + data-dir を割り当てる。
- エージェント統合: **Claude Agent SDK を最初に**、AgentBackend インターフェース、Codex は Phase 4。
