# Development

## Prerequisites

- macOS（v1 でサポートされる唯一のプラットフォーム）
- Node 20 LTS 以降（scaffold が着地したら `.nvmrc` で固定される）
- pnpm（推奨）または npm
- Xcode Command Line Tools（`xcode-select --install`） — ネイティブの Swift ヘルパーと node-gyp のビルドに必要
- エンドツーエンドテスト用に、`~/pop/autorpg` に置いた [`autorpg`](../../../autorpg) のクローン

## First-time setup

> Electron scaffold（Phase 2）待ち。このセクションは `package.json` が着地次第、記入される。

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## Scripts (planned)

| Command | Purpose |
|---|---|
| `pnpm dev` | Vite dev server + Electron main（リロード付き） |
| `pnpm build` | 本番用の renderer + main バンドル |
| `pnpm package` | electron-builder → `release/`（.dmg） |
| `pnpm typecheck` | main、preload、renderer、shared 全体での tsc --noEmit |
| `pnpm lint` | ESLint + Prettier のチェック |
| `pnpm test` | Vitest ユニットテスト |

## Repo conventions

- **どこでも TypeScript。** 設定ファイル以外に `.js` は置かない。Strict モードを有効にする。
- **コンポーネント内で生の IPC を使わない。** Renderer は `src/preload/` に定義された、型付きの `window.popbot.*` ブリッジ経由で main と話す。
- **Renderer は純粋なビューである。** fs も child_process も、ネイティブバインディングを持つ node モジュールも使わない。コンポーネントが永続化やシステムコールを必要とする場合は、main 経由 + IPC で公開する。
- **React コンポーネントは 1 ファイル 1 コンポーネント**とし、`PascalCase.tsx` で命名する。Hooks は、private ならコンポーネントに併置し、共有するなら `renderer/hooks/` に置く。
- **まず Tailwind、次にスコープ付き CSS。** 移植された `design/prototype/styles.css` は、Tailwind レイヤー + ダークテーマトークン（`--bg-1`、`--fg-2` など）用の小さな CSS カスタムプロパティ群になる。

## Working with the design prototype

オリジナルのプロトタイプは [`../design/prototype/`](../../design/prototype/) にあり、**凍結されたリファレンス**であって、ビルド対象ではない。閲覧方法については [`design/README.md`](../../design/README.md) を参照。

コンポーネントを移植する際は:

1. 視覚的なリファレンスとして、対応する `*.jsx` を自分の `.tsx` の隣に開く。
2. `useStateA`/`useEffectA` のエイリアス（プロトタイプがグローバルな衝突を避けるために使っていたハック）を取り除く。
3. `INITIAL_CHATS` やその他のモジュールレベルのフィクスチャを、`renderer/fixtures/` からのインポート、あるいは最終的には IPC 呼び出しに置き換える。
4. プロトタイプの視覚的・操作的な振る舞いに忠実であり続ける — [memory: stick close to the design](../../) を参照。

## Commit style

- Conventional commits: `feat:`、`fix:`、`chore:`、`docs:`、`refactor:`、`test:`。
- 本文は 72 桁以内。**何を**したかではなく、**なぜ**したかを先頭に書く。
- 論理的な変更ごとに 1 PR。scaffold と機能追加を一緒くたにしない。

## Working with related repos

PopBot は AutoRPG の Unity プロジェクト + サイドカーサーバーを駆動する。Phase 0 の前提条件のいくつかは、このリポジトリではなくそちらのリポジトリに着地する。

- in-Editor MCP 上の `POPBOT_MCP_PORT` 環境変数によるオーバーライド
- `./run_local.sh --port` と `--data-dir` フラグ
- `/health` エンドポイントの拡張

これらに取り組むときは、`cd ~/pop/autorpg` して、そちらのリポジトリの規約に従うこと。
