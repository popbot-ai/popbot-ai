# Rodando o PopBot no Windows

O PopBot é construído sobre Electron + Node e roda no Windows, mas algumas etapas
de configuração diferem do macOS — majoritariamente ao redor dos dois módulos
nativos (`better-sqlite3`, `node-pty`) e uma peculiaridade do Electron. Este documento
captura a configuração funcional.

## Pré-requisitos

- **Node 20 LTS ou mais recente.** Node 24 funciona para *rodar* o app, mas é
  tão novo que o `better-sqlite3` não tem um binário pré-compilado correspondente, então um simples
  `npm install` tenta compilá-lo a partir do código-fonte contra o ABI do Node e pode
  falhar (veja "Módulos nativos" abaixo). Node 20 / 22 evitam essa compilação.
- **Git for Windows** (`git`) e **GitHub CLI** (`gh`) no `PATH`.
- A CLI **`claude`** no `PATH` (um `claude.exe` — o PopBot o descobre via
  `where.exe`). `codex` é opcional.
- **Visual Studio Build Tools 2022** com a carga de trabalho *Desktop development with
  C++* — só é necessário se um módulo nativo tiver que compilar a partir do
  código-fonte (por exemplo, o winpty do `node-pty`).

## Configuração inicial

Os módulos nativos precisam ser compilados para o ABI do **Electron**, não do seu Node
de sistema. A sequência confiável:

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

Se você usou `--ignore-scripts`, a etapa 2 é necessária — caso contrário
electron-vite falha com `Error: Electron uninstall`.

## Duas pegadinhas que você pode encontrar

### Build do `node-pty`: `'GetCommitHash.bat' is not recognized`

O `node-pty` empacota o **winpty**, cujo build roda `cd shared &&
GetCommitHash.bat`. Se seu ambiente define
**`NoDefaultCurrentDirectoryInExePath=1`** (um flag de hardening de segurança),
o cmd.exe se recusa a rodar o `.bat` do diretório atual e o build
falha. Limpe-o para o build:

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### `Cannot read properties of undefined (reading 'setName')` ao lançar

Isso significa que o Electron iniciou como **Node puro** em vez de como Electron, então
`electron.app` é `undefined`. Acontece quando `ELECTRON_RUN_AS_NODE` está
presente no ambiente — e no Windows, o Electron trata a *mera presença*
dessa variável (mesmo vazia) como "rodar como Node". Isso morde quando
você lança a partir de um terminal embutido em outro app Electron (VS Code,
Claude Code), que exporta `ELECTRON_RUN_AS_NODE=1`.

`npm run dev` / `npm run start` passam por `scripts/electron-vite.mjs`,
que **deleta** a variável antes de iniciar o Electron, então isso é
tratado. Se você invocar `electron-vite` diretamente, certifique-se de que
`ELECTRON_RUN_AS_NODE` esteja unset (não apenas vazio).

## Empacotamento

```bash
npm run package:win    # NSIS installer + zip → release/
```

Builds do Windows são atualmente **não assinadas**, então o SmartScreen avisa no primeiro
lançamento. Defina `CSC_LINK` (caminho para um `.pfx`) e `CSC_KEY_PASSWORD` para assinar.

## Notas de paridade de recursos

- **Agentes, chats, worktrees git, o terminal embutido, e o painel
  Git** todos funcionam no Windows.
- **Lançadores de app externo** (a linha de ícones por slot): "Open terminal"
  (Windows Terminal / cmd), "Open editor" (VS Code / Cursor), e "Open
  git client" (GitHub Desktop) estão conectados. O lançamento/foco da **Unity** e
  a detecção de "app em execução" por slot são apenas macOS por enquanto (dependem
  de `ps`/`lsof`/AppleScript) e não fazem nada no Windows.
- As partes específicas do macOS — menu do Dock, correção de `PATH` do shell de login,
  roteamento de URL por perfil Chrome — são protegidas e simplesmente puladas no Windows.
