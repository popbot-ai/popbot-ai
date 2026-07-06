# Eseguire PopBot su Windows

PopBot è costruito su Electron + Node e funziona su Windows, ma alcuni passaggi
di setup differiscono da macOS — principalmente per via dei due moduli nativi
(`better-sqlite3`, `node-pty`) e di una particolarità di Electron. Questo
documento descrive il setup funzionante.

## Prerequisiti

- **Node 20 LTS o più recente.** Node 24 funziona per *eseguire* l'app, ma è
  così recente che `better-sqlite3` non ha un binario precompilato
  corrispondente, quindi un semplice `npm install` prova a compilarlo da
  sorgente contro l'ABI di Node e può fallire (vedi "Moduli nativi" più sotto).
  Node 20 / 22 evitano questa compilazione.
- **Git for Windows** (`git`) e **GitHub CLI** (`gh`) nel `PATH`.
- La CLI **`claude`** nel `PATH` (un `claude.exe` — PopBot lo scopre tramite
  `where.exe`). `codex` è opzionale.
- **Visual Studio Build Tools 2022** con il workload *Desktop development with
  C++* — necessario solo se un modulo nativo deve essere compilato da
  sorgente (ad es. il winpty di `node-pty`).

## Setup iniziale

I moduli nativi devono essere compilati per l'ABI di **Electron**, non per
quella del Node di sistema. La sequenza affidabile:

```bash
# 1. Installa le dipendenze JS senza eseguire gli script di build nativi
#    (evita la build da sorgente contro l'ABI di Node di better-sqlite3
#    che fa fallire l'installazione).
npm install --ignore-scripts

# 2. Scarica il binario di Electron che il passaggio 1 ha saltato.
node node_modules/electron/install.js

# 3. Compila i moduli nativi contro l'ABI di Electron.
npx electron-rebuild -f -w better-sqlite3,node-pty

# 4. Eseguilo.
npm run dev
```

Se hai usato `--ignore-scripts`, il passaggio 2 è obbligatorio — altrimenti
electron-vite fallisce con `Error: Electron uninstall`.

## Due insidie che potresti incontrare

### Build di `node-pty`: `'GetCommitHash.bat' is not recognized`

`node-pty` include **winpty**, la cui build esegue `cd shared &&
GetCommitHash.bat`. Se il tuo ambiente imposta
**`NoDefaultCurrentDirectoryInExePath=1`** (un flag di hardening di
sicurezza), cmd.exe si rifiuta di eseguire il `.bat` dalla directory
corrente e la build fallisce. Rimuovilo per la build:

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### `Cannot read properties of undefined (reading 'setName')` all'avvio

Questo significa che Electron è partito come **semplice Node** invece che
come Electron, quindi `electron.app` è `undefined`. Succede quando
`ELECTRON_RUN_AS_NODE` è presente nell'ambiente — e su Windows, Electron
tratta la *semplice presenza* di quella variabile (anche vuota) come "esegui
come Node". Questo si presenta quando lanci l'app da un terminale integrato
in un'altra app Electron (VS Code, Claude Code), che esporta
`ELECTRON_RUN_AS_NODE=1`.

`npm run dev` / `npm run start` passano attraverso `scripts/electron-vite.mjs`,
che **elimina** la variabile prima di avviare Electron, quindi questo caso è
gestito. Se invochi `electron-vite` direttamente, assicurati che
`ELECTRON_RUN_AS_NODE` non sia impostata (non semplicemente vuota).

## Packaging

```bash
npm run package:win    # installer NSIS + zip → release/
```

Le build Windows sono attualmente **non firmate**, quindi SmartScreen avvisa
al primo avvio. Imposta `CSC_LINK` (percorso a un `.pfx`) e
`CSC_KEY_PASSWORD` per firmarle.

## Note sulla parità delle funzionalità

- **Agenti, chat, git worktree, il terminale integrato e il pannello Git**
  funzionano tutti su Windows.
- **I launcher di app esterne** (la riga di icone per slot): "Open terminal"
  (Windows Terminal / cmd), "Open editor" (VS Code / Cursor) e "Open git
  client" (GitHub Desktop) sono collegati. Il lancio/focus di **Unity** e il
  rilevamento della "running app" per slot sono per ora esclusivi di macOS
  (dipendono da `ps`/`lsof`/AppleScript) e non fanno nulla su Windows.
- Le parti specifiche di macOS — il menu Dock, il patching del `PATH` della
  login-shell, il routing degli URL del profilo Chrome — sono protette da
  guardie e vengono semplicemente saltate su Windows.
