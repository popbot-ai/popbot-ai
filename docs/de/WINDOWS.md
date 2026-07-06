# PopBot unter Windows ausführen

PopBot ist auf Electron + Node aufgebaut und läuft unter Windows, aber ein paar Setup-
Schritte unterscheiden sich von macOS — hauptsächlich rund um die zwei nativen Module
(`better-sqlite3`, `node-pty`) und eine Electron-Eigenheit. Dieses Dokument erfasst das
funktionierende Setup.

## Voraussetzungen

- **Node 20 LTS oder neuer.** Node 24 funktioniert zum *Ausführen* der App, aber es ist
  so neu, dass `better-sqlite3` kein passendes vorgebautes Binary hat, sodass ein einfaches
  `npm install` versucht, es aus dem Quellcode gegen die ABI von Node zu kompilieren, was
  fehlschlagen kann (siehe "Native Module" unten). Node 20 / 22 vermeiden diesen Compile.
- **Git for Windows** (`git`) und **GitHub CLI** (`gh`) im `PATH`.
- Die **`claude`**-CLI im `PATH` (eine `claude.exe` — PopBot entdeckt sie via
  `where.exe`). `codex` ist optional.
- **Visual Studio Build Tools 2022** mit dem *Desktop development with
  C++*-Workload — nur nötig, falls ein natives Modul aus dem Quellcode kompilieren muss
  (z. B. das winpty von `node-pty`).

## Erstmaliges Setup

Die nativen Module müssen gegen die ABI von **Electron** gebaut werden, nicht die eures Systems-
Node. Die zuverlässige Sequenz:

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

Falls ihr `--ignore-scripts` verwendet habt, ist Schritt 2 erforderlich — sonst
schlägt electron-vite mit `Error: Electron uninstall` fehl.

## Zwei Fallstricke, auf die ihr stoßen könntet

### `node-pty`-Build: `'GetCommitHash.bat' is not recognized`

`node-pty` bündelt **winpty**, dessen Build `cd shared &&
GetCommitHash.bat` ausführt. Falls eure Umgebung
**`NoDefaultCurrentDirectoryInExePath=1`** setzt (ein Security-Hardening-Flag),
weigert sich cmd.exe, die `.bat` aus dem aktuellen Verzeichnis auszuführen, und der Build
schlägt fehl. Löscht es für den Build:

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### `Cannot read properties of undefined (reading 'setName')` beim Start

Das bedeutet, dass Electron als **reines Node** gestartet ist statt als Electron, sodass
`electron.app` `undefined` ist. Es passiert, wenn `ELECTRON_RUN_AS_NODE` in der
Umgebung vorhanden ist — und unter Windows behandelt Electron die *bloße Anwesenheit*
dieser Variable (selbst leer) als "als Node ausführen". Das beißt euch, wenn ihr
von einem in einer anderen Electron-App eingebetteten Terminal aus startet (VS Code,
Claude Code), das `ELECTRON_RUN_AS_NODE=1` exportiert.

`npm run dev` / `npm run start` gehen durch `scripts/electron-vite.mjs`,
das die Variable **löscht**, bevor Electron startet, also ist das
gehandhabt. Falls ihr `electron-vite` direkt aufruft, stellt sicher,
dass `ELECTRON_RUN_AS_NODE` nicht gesetzt ist (nicht nur leer).

## Packaging

```bash
npm run package:win    # NSIS installer + zip → release/
```

Windows-Builds sind derzeit **unsigniert**, also warnt SmartScreen beim ersten
Start. Setzt `CSC_LINK` (Pfad zu einer `.pfx`) und `CSC_KEY_PASSWORD`, um zu signieren.

## Feature-Parität-Anmerkungen

- **Agents, Chats, Git-Worktrees, das eingebettete Terminal und das Git-
  Panel** funktionieren alle unter Windows.
- **Externe App-Launcher** (die Icon-Zeile pro Slot): "Open terminal"
  (Windows Terminal / cmd), "Open editor" (VS Code / Cursor), und "Open
  git client" (GitHub Desktop) sind verdrahtet. **Unity**-Start/-Fokus und
  die Pro-Slot-"laufende App"-Erkennung sind vorerst macOS-only (sie verlassen sich
  auf `ps`/`lsof`/AppleScript) und tun unter Windows nichts.
- Die macOS-spezifischen Teile — Dock-Menü, Login-Shell-`PATH`-Patching,
  Chrome-Profil-URL-Routing — sind gegated und werden unter Windows einfach übersprungen.
