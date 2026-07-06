# コアモデル

PopBot のアプリが組み立てられているオブジェクトグラフです。それ以外のすべて — IPC、
永続化、UI パネル、エージェントループ — はこれらにぶら下がっています。ここにあるルールに
違反する形で振る舞いを変更する場合は、**先にモデルを更新するか、モデルが
変わることをユーザーに伝えてください。**

「コードはどこにあるか」については [ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。
「ユーザーには何が見えるか」については [USER_STORIES.md](USER_STORIES.md) を参照してください。

---

## TL;DR — 重要な 4 つの名詞

| 名詞 | 永続的か? | 所有者 | 生存期間 |
|---|---|---|---|
| **Chat** | はい（SQLite） | main | ユーザーによって作成され、明示的に削除されるまで生存 |
| **Message** | はい（SQLite、ほぼ追記専用） | main | Chat の子 |
| **Slot** | はい（ファイルシステム + SQLite の行） | main / `SlotManager` | まれにしか作成されず、再利用される。チャットごとには決してない |
| **AgentSession** | **いいえ**（メモリ内のみ） | main / `AgentHost` | Chat が「running」になったときに生成され、Chat が閉じるかアプリが終了すると破棄される |

レンダラー内のすべては、これらに対する**ビュー**です。レンダラーは決して
正規の状態を所有しません。

---

## 永続的な名詞（再起動を生き延びる）

### Chat

ユーザーの作業単位です。1 つのチケット、1 つの PR レビュー、1 つの Slack スレッド、1 つの
「コードベースを見て回る」セッション — それぞれが 1 つの Chat です。

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

**ステータスのライフサイクル**（US-6 — 何がサムネイルに色を付けるか）:

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

**ステータスは記述的であり、規定的ではありません** — エージェントセッションが
紐づいているときはそこから導出され、遷移時に DB に永続化されます。チャットが `idle` であるとは
「今このチャットで何のエージェントも作業していない」ことを意味します。「チャットが
閉じられている」ことを意味するわけではありません。

**Open か closed か:** チャットは `closedAt IS NULL` のとき、かつそのときに限り「open」です。開いている
チャットは起動時にメモリにロードされます。閉じているチャットはクエリ専用です。**チャットを
閉じると、そのスロットのリースが解放され、AgentSession が破棄されますが、Message が
削除されることは決してありません。**

### Message

Chat 内の、ほぼ追記専用のイベントログです。トランスクリプトは型付けされたレコードの
連なりです。

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

**なぜ `body` は JSON なのか?** 各 kind は異なるペイロードの形状（テキストか
ツール呼び出しか許可要求か）を持ち、レンダラーは `kind` によってディスパッチします。
型付けされた JSON の塊として保存することで、テーブルはフラットに、レンダラーのコードは
正直なままに保たれます。

**「ほぼ追記専用」の意味:** `tool` と `permission` の行は**一度だけ**変更されます。

- `tool` の行: `tool-use`（名前 + 引数）で書き込まれ、`tool-result`（`result` +
  `isError` を埋める）で更新されます。
- `permission` の行: `permission-request`（ツール + 引数 + 理由）で書き込まれ、
  ユーザーの決定で更新されます（`decision` を設定）。
- `text` の行: `message-start` で空のテキストとして書き込まれ、`text-delta` イベントが
  到着するたびに小さなメモリ内バッファで**まとめられ**、`message-end` で
  フラッシュされます（そしてレンダラーをライブに保つため約 250ms ごとにも）。「エージェントの文章の
  1 ターン」につき 1 行であり、デルタ 1 つにつき 1 行ではありません。

**エージェントの作業をロールバックすることによるカスケード削除はありません。** エージェントが
間違いを犯し、「もう一度試して」ほしい場合は、新しいユーザーメッセージを送ります。
古いトランスクリプトはそのまま残ります。モデルが履歴をひそかに書き換えることは決してありません。

### Slot

ウォームで、隔離された、使い捨てのワークスペースです。copy-on-write な
フォルダの上に構築された隔離済みのチェックアウト（Git worktree、または Perforce クライアント）+ ウォームな
ビルドキャッシュ（例: エンジンのアセット/インポートキャッシュ）+（任意で）テスト対象アプリ
（Unity、Unreal、またはカスタムエンジン）の実行中のエディタ +（任意で）実行中の
サイドカーサーバーです。**まれにしか作成されず、継続的に再利用されます。** スロットは
Chat ではなく、ユーザー/アプリによって所有されます。

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

**Slot ↔ Chat の紐付け**は**一時的**です — それは `slot.leasedByChatId` と
対応する Chat のランタイムメタデータに存在します。起動時に、スロットを走査し
開いているチャットと照合することでこれを整合させます。古くなったリース（チャットが
閉じられ、リースが決して解放されなかった場合）は回収されます。

完全なスロットのライフサイクルについては [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit) を参照してください。

### Permission grant

再プロンプトなしにあるツール/対象の組み合わせが承認されているという、永続的なユーザーの
決定です。2 つのスコープがあります。

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

`tool` は末尾が `*` のワイルドカードでもよいため、1 つの許可で MCP サーバー全体を
許可できます（`allow-mcp-server` → `mcp__<server>__*`） — これが、スロットのエディタ MCP が
ツールごとではなく一度で許可される仕組みです。拒否ルールは常に許可に勝ち、より具体的な
パターンはより広いものに勝ちます（`src/shared/agent.ts` の `resolvePermissionRules` を参照）。

許可はチャットごとに蓄積されます（US-9: 「このチャットでは git push を常に許可する」）。
[adr/0004](../adr/0004-canusetool-policy-boundary.md) にあるハードコードされた**拒否ルール**は
ここには保存されません。それらはコードの中に存在し、上書きできません。

### Settings

2 つの層があります。

- **グローバル設定**: テーマ、デフォルトのチャットタイプ、スロット数、マスター Library の
  更新周期など。1 行のテーブル。
- **チャットごとのオーバーライド**: サーバーモード、タイムスケール、ウィンドウモード、トークン
  予算など。`chatId` をキーとする `chat_settings` テーブルに保存されます。

どちらも空である場合があります（その場合はデフォルトが適用されます）。レンダラーの Settings パネルを
通じて変更されます。

### キャッシュされた注意項目

割り当てられたチケット（Linear / Jira / GitHub Issues）と保留中の
レビュー（GitHub PR / Helix Swarm チェンジリスト）のユーザーのキューです。パネルが即座にレンダリングされるように
ローカルにキャッシュされ、スケジュールに従って、またオンデマンドで更新されます。

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

チケットソースは共通のプロバイダー（Linear、Jira、GitHub Issues）の背後で交換可能であり、
レビューソースも同様です（GitHub PR、Swarm）。キャッシュされているだけで正規ではありません —
真実の源泉は、トラッカー / レビューシステム自体です。

---

## ランタイムの名詞（メモリ内。再起動を生き延びない）

### AgentSession

LLM と話すものです。「running」な Chat につき 1 つの AgentSession があります。
`AgentBackend`（Claude Agent SDK または Codex SDK。どちらも今日出荷されています）に
裏打ちされています。

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**`AgentHost`**（main プロセス内のシングルトン）によって所有されます。AgentHost は
`Map<chatId, AgentSession>` を保持します。セッションは、チャットに対する最初の
`agent.send` で遅延生成され、チャットが閉じると破棄されます。

**セッションは `AgentEvent` を発行します**（`src/shared/agent.ts` を参照）。AgentHost は
すべてのイベントを傍受し、次のことを行います。

1. それを**永続化**します（デルタはテキストの行にまとめられ、tool-use はツールの
   行を作成し、permission-request は permission の行を作成します）。
2. それを `webContents.send` 経由でレンダラーに**再配信**します。レンダラーは
   N 個の購読者の 1 つであり、main が正規の記録者です。
3. **Chat のメタデータを更新します** — イベントが到着するにつれて `status`、`snippet`、`tokensUsed`、
   `lastActiveAt` が先送りされます。

**セッションは DB に直接書き込むことは決してありません。** それを行うのは AgentHost だけです。これにより
永続化スキーマの進化がバックエンドの入れ替えから切り離されたままになります。

### Permission request（進行中）

SDK の `canUseTool` コールバックが発火したとき:

1. PolicyEngine が評価します: hard-allow（自動）、hard-deny（自動）、または ask user。
2. 「ask user」の場合、AgentHost は `permission-request` イベントを
   レンダラーに発行し、`permissionId` をキーにして SDK のコールバックを保留マップに**格納します**。
3. レンダラーがモーダルを表示し、ユーザーが決定をクリックし、IPC で main に戻ります。
4. AgentHost は保留中のコールバックを探し出し、それを解決します。SDK は続行するか
   中止します。
5. 「常にこれを許可」がチェックされていた場合、`PermissionGrant` の行を書き込みます。

保留中のリクエストは**永続化されません**。決定の途中でアプリがクラッシュした場合、
エージェントのツール呼び出しは再起動時にキャンセルされます。

### プロセススーパーバイザーのハンドル

スロットごとに、テスト対象アプリのエディタ（Unity / Unreal / カスタムエンジン — `unityPid`
フィールドはエンジンに関わらずその PID を記録します）用の `child_process.ChildProcess` と、
サイドカーサーバー用にもう 1 つ。`SlotManager` によって所有されます。PID の生存確認 + HTTP
プローブによってヘルスチェックされます。スロットの解放 / アプリの終了時に強制終了されます。起動時に
スロットディレクトリの `slot.json` を走査し、記録された PID がまだ生きているか確認することで**整合されます**。

---

## 所有権のルール

これらは**不変条件**です。これに違反するコードはバグです。

1. **レンダラーは純粋なビューです。** fs も child_process も DB アクセスもありません。main とは
   型付けされた `window.popbot.*` ブリッジを通じてのみ話します。

2. **main だけが DB への書き込み者です。** レンダラーは IPC 経由で読み取ります。決して
   `popbot.db` には触れません。

3. **セッション中に Chat の status / snippet / tokens を変更できるのは AgentHost だけです。**
   他のコードはそれらのフィールドを読み取れますが、そのチャットにセッションがアクティブな間は
   書き込めません。（リネームのようなユーザー主導の変更は、セッションがアクティブでないときに
   行われるか、キューに入れられます。）

4. **バックエンドは DB に書き込むことは決してありません。** それらはイベントを発行し、AgentHost が
   永続化します。これにより、DB スキーマの絡み合いなしに ClaudeBackend / CodexBackend /
   StubBackend が交換可能なままになります。

5. **PolicyEngine が「このツールは実行してよいか」についての唯一の真実の源泉です。**
   これを迂回するバックエンドはありません。許可の許諾はこれを通じて流れます。

6. **Slot ↔ Chat の紐付けは一時的です。** Chat のレコードが決して
   スロットを名指すことはありません。Slot のレコードがリースを保持するチャットを名指します（ソフトな
   ポインタ、起動時に整合されます）。

7. **トランスクリプトはひそかに変化することは決してありません。** 新しい行を追記します。tool/permission の
   行に対する一回限りの更新は、明示的で範囲が限定されています。

---

## 状態の流れ — 1 つのユーザーメッセージの end-to-end

モデルが動いている様子を示す実例です。

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

注目すべき点が 2 つあります。

- **レンダラーは何も決定しません。** 意図をディスパッチし、イベントから
  再レンダリングします。
- **DB への書き込みは、レンダラーへの通知と同じ場所で起こります。** それらは AgentHost の
  同じハンドラーによって束ねられています。これは、レンダラーのクラッシュが
  永続化のドリフトを引き起こせないことを意味します。

---

## 復旧の流れ — コールドからの再起動

コードの形をした US-7 です。アプリが不整合に終了します。数時間後、ユーザーが再びそれを開きます。

1. **DB init** — `initDb()` が `popbot.db` を開き、保留中のマイグレーションを実行します。
2. **スロットの整合** — `~/Library/Application Support/PopBot/slots/` を走査し、
   各スロットについて `slot.json` を読み、`unityPid` / `serverPid` が
   生きているか確認します（`kill -0`）。死んでいれば、スロットを free にして PID をクリアします。
   孤立したリース（存在しないチャット、または `closedAt` が設定されているチャット）を
   解決します。
3. **Open chats** — `listOpenChats()` が `closedAt IS NULL` のチャットを、
   `lastActiveAt DESC` でソートして返します。レンダラーは最初の描画でそれらを要求します。
4. **エージェントの自動起動はありません。** セッションは最初の
   `agent.send` で遅延生成されます。ユーザーが古いチャットを開いても、単にトランスクリプトが見えるだけです。
   ユーザーがプロンプトを送るまで、エージェントは中断したところから再開しません。
5. **オンデマンドのスロットリース。** 同様に、リースは、チャットのタイプが
   それを必要とし（Client/Server Test）、Unity を必要とするツールが今にも発火しようとしているときに
   起こります。

結果: アプリを開くのは速く（DB の読み取り + スロットの ping）、エージェント生成のコストを
払うことなく、どのチャットの履歴も検査できます。

---

## バックエンドの交換可能性

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** は `@anthropic-ai/claude-agent-sdk` をラップします。デフォルトです。
- **CodexBackend** は `@openai/codex-sdk`（`codex exec` を駆動します）をラップします。
  出荷済みです。各バックエンドは自身の `capabilities` を公開し、UI はチャットごとに
  それらを機能検出します。
- **StubBackend** は偽のストリームでユーザーのテキストをエコーします。配線の
  検証 + UI テストに使われます。

チャットレコードの `agent` フィールドが、AgentHost がどのバックエンドを起動するかを選択します。

---

## モデルに意図的に含まれていないもの

- **ワークフロー / DAG / 承認チェーン。** チャットは会話です。私たちは
  パイプラインをモデル化していません。
- **マルチユーザー。** マシンごとに単一の開発者。認証も共有もありません。
- **ノートブック / 保存されたクエリ / テンプレート。** すべてトランスクリプトから
  創発するもので、まだファーストクラスの型はありません。
- **バージョン管理されたチャットのスナップショット / 分岐するトランスクリプト。** トランスクリプトは
  線形です。チャットをフォークする = 古いチャットの履歴を種にした新しいチャットを作成すること
  （将来の機能であり、今日のモデルにはありません）。

これらのいずれかが必要になった場合、まずここに追加し、それからコードに追加します。
