*Languages: [English](../PHASING.md) · [Español](../es/PHASING.md) · [Français](../fr/PHASING.md) · [Deutsch](../de/PHASING.md) · **[日本語](PHASING.md)** · [한국어](../ko/PHASING.md) · [简体中文](../zh-CN/PHASING.md) · [Português (Brasil)](../pt-BR/PHASING.md) · [Русский](../ru/PHASING.md) · [Italiano](../it/PHASING.md)*

# Phasing

PopBot を「設計 + プロトタイプ」から「日々使える実用ツール」にするためのロードマップです。[POPBOT_DESIGN.md](POPBOT_DESIGN.md#phasing) のフェーズ分けを反映していますが、こちらはチェックボックスで具体的な進捗を追跡します。

項目が完了したらこのファイルを更新してください。1 つのコミットで複数のボックスにチェックを入れてもかまいません。

---

## Phase 0 — 前提条件（約 3 日）

AutoRPG リポジトリ内の基盤部分と、こちらのネイティブヘルパーです。ほとんどは実際のエンドツーエンドテストをブロックしますが、Electron スキャフォールドはブロックしません。

### `~/pop/autorpg` にて

- [ ] **`POPBOT_MCP_PORT` 環境変数によるオーバーライド** — エディタ内 MCP サーバー（`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`）向け。環境変数からポートを読み取り、なければ `17893` にフォールバックする。約 5 分。
- [ ] **`./run_local.sh --port` + `--data-dir` フラグ。** サーバーは両方を引数として受け取る。data dir はスロットごとの DB 分離のため。約 30 分。
- [ ] **`/health` エンドポイントの拡張** — `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }` を返す。PopBot はリース時のドリフト検出にこれらを使う。約 30 分。

### このリポジトリにて

- [ ] **ネイティブ macOS ウィンドウムーバーヘルパー** — `native/popbot-windowmover/` の Swift 製 CLI。サブコマンド: `move`、`minimize`、`wait-for-window`。約半日。
- [ ] **スロットライフサイクルのプロトタイプ** — `src/main/slots/` 配下のスタンドアロン TS モジュールで、`scripts/` 配下のスクリプトから実行される。worktree の追加、master からの Library の COW、スタッシュの安全機構を伴うブランチ切り替え、リース/解放、孤児の整理をカバーする。約 1 日。

---

## Phase 1 — MCP automation surface（約 3〜5 日）

`~/pop/autorpg` にて。エージェントが実際に使うことになるエディタ内 MCP ツールを構築します。

- [ ] **ジョブ基盤** — `job_status`、`job_get_result`、`job_cancel`、`job_list`。長時間実行されるすべてのツールは即座に `{ jobId }` を返す。
- [ ] **ライフサイクルツール** — `play_status`、`play_enter`（ジョブ）、`play_exit`、`play_pause/resume/step`、`time_scale_set`、`editor_quit`。
- [ ] **観測ツール** — `screenshot`、`game_state_summary`、`screen_stack`、`chapter_status`、`ui_tree`、`ui_query`。
- [ ] **操作ツール** — `ui_click`、`ui_click_by_loc`。
- [ ] **同期ツール** — `wait_until`（ジョブ）、`wait_for_idle`（ジョブ）。
- [ ] **ログ / サーバーツール** — `console_get_logs` を拡張（`sinceTimestamp`、`dedupe`、`dumpTo`、`includeStack`）、`server_logs`、`server_health`、`client_set_server_endpoint`。
- [ ] **セッション** — 予測可能なアーティファクトディレクトリのための `mcp_session_start`、`mcp_session_end`。
- [ ] **既存の長時間ツールをジョブモデルへ移行** — `rebuild_gamedata`、`rebuild_dtos`、`addressables_build`、`addressables_clean`。

---

## Phase 2 — PopBot Electron MVP（約 1〜2 週間）

単一チャットでエンドツーエンドに使える状態にします。**進行中。**

- [ ] **Electron スキャフォールド** — `package.json`、Vite + React + TS + Tailwind、electron-builder、ESLint + Prettier、Vitest。
- [ ] **型付き IPC ブリッジを伴う main / preload / renderer の分割**。
- [ ] **プロトタイプの 8 つの JSX を** `src/renderer/` 配下の `.tsx` に**移植**。静的な UI が、機能的な裏付けなしで Electron ウィンドウ上で動く。
- [ ] **better-sqlite3 のスキーマ** — chats、messages、slots、prefs。
- [ ] **単一の ClaudeBackend セッション**を 1 つのチャットカラムに配線。メッセージの送信、イベントストリームの受信。
- [ ] **`canUseTool` ポリシーエンジン** — ハードコードされた拒否リスト + モードによる許可。レンダラーは権限リクエストをモーダルとして表示する。
- [ ] **スロットマネージャーの配線** — 1 スロット、実際の worktree、Phase 0 のヘルパー経由での実際の Unity 起動。
- [ ] **ネイティブウィンドウムーバーの統合** — Unity が開くと、ヘルパーがそれを画面 2 に配置する。
- [ ] **設定パネルの骨格** — チャットごとのモード、サーバーモード、time scale、エージェントバックエンド。
- [ ] **エンドツーエンドループのデモ** — チャットを開く → エージェントがコードを読む → エージェントがゲームを実行する → エージェントがスクリーンショットを撮る → エージェントが報告する。

---

## Phase 3 — マルチチャット + アテンションキューパネル（約 1〜2 週間）

[US-1](USER_STORIES.md#us-1--アテンションキューの把握)、[US-2](USER_STORIES.md#us-2--ワンクリックでの着手)、[US-5](USER_STORIES.md#us-5--サムネイルによる容易なマルチタスク)、[US-6](USER_STORIES.md#us-6--一目で分かるステータス) を実現します。

- [ ] 複数のチャットカラム。フローティングでの追加/削除。
- [ ] ステータスカラー付きのサムネイルストリップ（US-5、US-6）。
- [ ] **Linear チケットパネル**（自分に割り当てられたもの、優先度 + 期日でランク付け）。
- [ ] **未レビューの PR パネル**（`gh` GraphQL）。
- [ ] **Slack パネル** — DM、@mention、オーナーのチャンネル。まったく新しいサブシステム（`src/main/slack/`）。`keytar` 経由の OAuth。[USER_STORIES.md → Deviations](USER_STORIES.md#第-3-のアテンションソースとしての-slackus-1) を参照。
- [ ] 任意のパネル行からの**ワンクリックチャット生成**。チャットはソースのコンテキストで種付けされる（US-2）。
- [ ] 下部ログパネル — Unity + サーバータブ、アクティブなチャットに対する同期スクロール。
- [ ] チャット設定内のモード + サーバーモードトグル。セッション途中での再接続対応。
- [ ] `remote-dev` リースでのドリフト検出。

---

## Phase 4 — 磨き込み + 高度な機能

- [ ] **Codex バックエンドアダプター** — `CodexBackend implements AgentBackend`、UI 上でケイパビリティをフラグ表示。
- [ ] **ヘッドレスな `Window Mode`** — batchmode の検証スクリプトが AutoRPG での動作を証明した後、オプトインで有効化。
- [ ] **`crash_dump`、`events_pop`、`command_apply`、フィクスチャ管理**の MCP ツール。
- [ ] Unity とサーバーパネル間の**ログの時刻相関の並列表示**。
- [ ] **自律性バジェット + ループ検出**の改良（トークン数 / 時間 / 繰り返し失敗による一時停止トリガー）。
- [ ] **更新チャネル** — electron-builder + 署名済みビルドによる自動アップデーター。

---

## 未解決の課題（設計からの持ち越し）

1. AutoRPG は実際に `-batchmode` の Play モードで動くのか? 検証スクリプトは Phase 4 あたりで対応。v1 のブロッカーではない。
2. Master Library のリフレッシュ頻度 — 手動ボタンか、自動か、N 日 TTL か? デフォルト: preferences 内の手動ボタン。
3. スロット数のデフォルト — 4 にハードコードするか、RAM/コア数に応じてスケールするか? おそらくデフォルト 2〜3、設定可能。
