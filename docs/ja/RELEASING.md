*Languages: [English](../RELEASING.md) · [Español](../es/RELEASING.md) · [Français](../fr/RELEASING.md) · [Deutsch](../de/RELEASING.md) · **[日本語](RELEASING.md)** · [한국어](../ko/RELEASING.md) · [简体中文](../zh-CN/RELEASING.md) · [Português (Brasil)](../pt-BR/RELEASING.md) · [Русский](../ru/RELEASING.md) · [Italiano](../it/RELEASING.md)*

# PopBot をリリースする

リリースは **macOS、Windows、Linux** をまたいで GitHub Actions によってビルドされ、このリポジトリの GitHub Release に公開されます。各プラットフォームは自身のランナー上でビルドされます — ネイティブモジュール（`better-sqlite3`、`node-pty`）は OS ごとに Electron の ABI に対してコンパイルする必要があるため、クロスコンパイルは選択肢にありません。

## リリースを切る

`main` 上のクリーンな作業ツリーから。

```bash
npm run release            # パッチバンプ（デフォルト）
npm run release -- minor   # マイナーバンプ
npm run release -- major   # メジャーバンプ
```

`scripts/release.sh` はバージョンをバンプし、コミットし、注釈付きの
`vX.Y.Z` タグを作成し、両方をプッシュします。プッシュされたタグは **Build**
ワークフローをトリガーし、これが 3 プラットフォームすべてをビルドして、アーティファクトを添付した GitHub Release を公開します。`gh run watch` または Actions タブで進捗を確認できます。

次のバージョンは最新の `v*` タグから計算され、上記の引数に従ってバンプされます。タグがまだ存在しない場合は、`package.json` のバージョンにフォールバックします（そのため最初のリリースは、そのバージョンの次のバンプになります）。このスクリプトは `main` 以外のブランチからの実行を拒否します（`RELEASE_BRANCH=<name>` で上書き可能）。

## 生成されるもの

| プラットフォーム | アーティファクト |
|----------|-----------|
| macOS    | `.dmg`、`.zip`、`latest-mac.yml`、`.blockmap` |
| Windows  | NSIS インストーラー `.exe`、`.zip`、`latest.yml`、`.blockmap` |
| Linux    | `.deb`（自動更新なし — 下記の Linux に関する注記を参照） |

`latest*.yml` + `.blockmap` ファイルは electron-updater のメタデータです
（[`electron-builder.yml`](../../electron-builder.yml) の `publish: github`
がこれらを生成します）。アプリ内自動アップデーターはこれらを使って更新を検出し、ダウンロードし、ステージします — 下記の自動更新セクションを参照してください。

ワークフロー: [`.github/workflows/build.yml`](../../.github/workflows/build.yml)。

## CI トリガー

- **`v*` タグのプッシュ** → 全プラットフォームをビルド（シークレットが設定されていれば署名）+
  GitHub Release を公開。
- **`main` へのプルリクエスト**（ドキュメント以外） → 検証ビルドのみで、**常に未署名**。アーティファクトはその実行に添付されますが、何も公開されず、シークレットも使われません。
- **手動** → 「Run workflow」（workflow_dispatch）、未署名。

署名は `v*` タグのプッシュ時にのみ実行され、これができるのはリポジトリのオーナーだけです。GitHub はフォークからトリガーされた PR の実行にシークレットを決して公開しないため、コントリビューターの PR は署名用証明書に到達できません。

## コード署名

署名は **GitHub Actions のシークレット**（Settings → Secrets and
variables → Actions）によって駆動されます。これらは暗号化され、git のツリーには決して含まれず、ログではマスクされます。何も設定されていない場合、タグビルドは未署名のバイナリを生成し（macOS Gatekeeper / Windows SmartScreen が初回起動時に警告します）、CI はそれでもパスします。

### macOS（署名 + 公証）

| シークレット | 値 |
|--------|-------|
| `MAC_CSC_LINK` | あなたの「Developer ID Application」`.p12` の base64（`base64 -i cert.p12 \| pbcopy`） |
| `MAC_CSC_KEY_PASSWORD` | その `.p12` のパスワード |
| `APPLE_ID` | 公証に使う Apple ID のメールアドレス |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com で発行するアプリ専用パスワード |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

タグビルドは、**完全なセット**が揃っている場合にのみ署名 + 公証を行います —
`MAC_CSC_LINK`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、**および**
`APPLE_TEAM_ID`（証明書用の `MAC_CSC_KEY_PASSWORD` も加えて）。いずれかが欠けている場合、公証を後段で失敗させるのではなく未署名でビルドするため、中途半端に設定されたシークレットのセットが CI を壊すことはありません。

### Windows（任意）

| シークレット | 値 |
|--------|-------|
| `WIN_CSC_LINK` | あなたのコード署名用 `.pfx` の base64 |
| `WIN_CSC_KEY_PASSWORD` | その `.pfx` のパスワード |

タグビルドは `WIN_CSC_LINK` が存在する場合に署名します。それ以外は未署名です。

## 自動更新

アプリ内自動更新は **electron-updater**
（[`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts)）で配線されています。パッケージ済みビルドでは、このリポジトリのリリースをポーリングし、新しいバージョンをバックグラウンドで**サイレントにダウンロードし**、ステージが完了すると
**「Restart to install」**トーストを表示します — クリックすると終了し、新バージョンへ再起動します。これはリリースワークフローが添付する
`latest*.yml` + `.blockmap` のメタデータを読み取ります。`electron-builder.yml` の
`publish: github` 設定が、クライアントに必要な `app-update.yml` を埋め込みます。

**インストール手順には署名が必須です。** macOS は未署名の更新を拒否するため、アプリ内インストールはリリースが署名 + 公証されて初めて機能します（Apple のシークレットが設定されたタグビルドの経路）。それまでは — そしてアップデーターがエラー（メタデータなし、ネットワーク障害）に遭遇したときはいつでも —
手動の「Download」トーストに**フォールバック**し、リリースページを開きます。これは
[`src/main/updates/check.ts`](../../src/main/updates/check.ts) の軽量な GitHub チェックによって駆動されています。同じ軽量チェックは About ダイアログのオンデマンドな「Check for
updates」も支えており、開発ビルドや未署名ビルドを含め、どこでも機能します。

これのいずれかがリリースを表面化させるためには、ワークフローがプラットフォームのインストーラーを添付した**非ドラフト、非プレリリース**の Release を公開する必要があります — 実際にそうなっています。自動更新は開発時には無効です。

### 自動更新の検証（初回のエンドツーエンドテスト）

自動更新の経路は、**2 つの実際の署名済みリリース**に対してのみ検証できます —
開発時（無効化されている）でも、単一のリリース（それより新しいものが何もない）に対してでもありません。署名の設定が完了したら一度だけこれを実行してください。

1. **署名がオンになっていることを確認します。** 上の表の macOS（および任意で Windows）のシークレットを追加します。最初の署名済みリリースは成功する必要があります —
   macOS では、未署名/未公証のビルドはダウンロードはできても**インストールに失敗する**ため、署名されていなければこのテスト全体が無意味です。
2. **リリース N を切ります**（例: `npm run release` → `v0.0.18`）。ワークフローがアセット + `latest*.yml` を伴う Release を公開するのを待ちます。
3. サポートする各 OS 上で、**公開された Release から N をインストールします**（macOS `.dmg`、Windows `.exe`、Linux `.deb`）。起動し、Help ▸ About が正しいバージョンを示すことを確認します。
4. **リリース N+1 を切ります**（例: `npm run release` → `v0.0.19`）。
5. **N のインストールを実行したままにします。** 起動後約 30 秒以内に（その後は 6 時間ごとに）チェックが行われます。署名済みビルドでは N+1 をサイレントにダウンロードし、
   **「Restart to install」**トーストを表示します。それをクリックします。
6. **N+1 へ再起動したことを確認します** — Help ▸ About が新しいバージョンを示すはずです。これにより、そのOS上で download → stage → quitAndInstall → relaunch が機能することが証明されます。

プラットフォームごとの注記:
- **macOS:** Squirrel.Mac は（`.dmg` ではなく）`.zip` アセットから更新を適用します。両方が Release に含まれている必要があります。Gatekeeper は未署名/
  未公証の更新を拒否します — もし「Restart to install」が何もしない場合は、ビルドの公証を再確認してください。
- **Linux:** `.deb` は自己更新**しません** — electron-updater は Linux 上では AppImage のみを自動更新します。新しい `.deb` をインストールして更新してください
  （`sudo dpkg -i …` / `sudo apt install ./…`）。したがって Linux では自動更新の手順（4〜6）はスキップし、単に N+1 を N の上にインストールして About を確認してください。アプリ内 Linux 自動更新を復活させるには、`electron-builder.yml` の
  `linux.target` に `AppImage` を再追加してください。
- **Windows:** NSIS インストールはその場で更新します。ビルドが `WIN_CSC_LINK` で署名されるまで SmartScreen が警告することがあります。

もし手順 5 で代わりに**「Download」**トースト（リリースページを開くもの）が表示された場合、アプリ内アップデーターがエラーに遭遇してフォールバックしたということです — 診断ログ（`update.error` / `update.check.failed` のエントリ）でその理由を確認してください。最も多い原因は未署名の macOS ビルドです。
