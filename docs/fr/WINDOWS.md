# Exécuter PopBot sur Windows

PopBot est construit sur Electron + Node et s'exécute sur Windows, mais quelques
étapes de configuration diffèrent de macOS — principalement autour des deux modules
natifs (`better-sqlite3`, `node-pty`) et d'une particularité d'Electron. Ce document
capture la configuration fonctionnelle.

## Prérequis

- **Node 20 LTS ou plus récent.** Node 24 fonctionne pour *exécuter* l'application, mais il est
  si récent que `better-sqlite3` n'a pas de binaire précompilé correspondant, donc un simple
  `npm install` tente de le compiler depuis les sources contre l'ABI de Node et peut
  échouer (voir « Modules natifs » ci-dessous). Node 20 / 22 évitent cette compilation.
- **Git for Windows** (`git`) et **GitHub CLI** (`gh`) dans le `PATH`.
- La CLI **`claude`** dans le `PATH` (un `claude.exe` — PopBot le découvre via
  `where.exe`). `codex` est optionnel.
- **Visual Studio Build Tools 2022** avec la charge de travail *Desktop development with
  C++* — nécessaire uniquement si un module natif doit compiler depuis les
  sources (par ex. le winpty de `node-pty`).

## Configuration initiale

Les modules natifs doivent être construits pour l'ABI d'**Electron**, pas celle de votre
Node système. La séquence fiable :

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

Si vous avez utilisé `--ignore-scripts`, l'étape 2 est requise — sinon
electron-vite échoue avec `Error: Electron uninstall`.

## Deux pièges que vous pourriez rencontrer

### Build de `node-pty` : `'GetCommitHash.bat' is not recognized`

`node-pty` embarque **winpty**, dont le build exécute `cd shared &&
GetCommitHash.bat`. Si votre environnement définit
**`NoDefaultCurrentDirectoryInExePath=1`** (un indicateur de durcissement de sécurité),
cmd.exe refuse d'exécuter le `.bat` depuis le répertoire courant et le build
échoue. Effacez-le pour le build :

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### `Cannot read properties of undefined (reading 'setName')` au lancement

Cela signifie qu'Electron a démarré en tant que **Node simple** au lieu d'Electron, donc
`electron.app` est `undefined`. Cela arrive quand `ELECTRON_RUN_AS_NODE` est
présent dans l'environnement — et sur Windows, Electron traite la *simple présence*
de cette variable (même vide) comme « s'exécuter en tant que Node ». Cela survient quand
vous lancez depuis un terminal intégré dans une autre application Electron (VS Code,
Claude Code), qui exporte `ELECTRON_RUN_AS_NODE=1`.

`npm run dev` / `npm run start` passent par `scripts/electron-vite.mjs`,
qui **supprime** la variable avant de démarrer Electron, donc c'est
géré. Si vous invoquez `electron-vite` directement, assurez-vous que
`ELECTRON_RUN_AS_NODE` n'est pas définie (pas seulement vide).

## Packaging

```bash
npm run package:win    # NSIS installer + zip → release/
```

Les builds Windows sont actuellement **non signés**, donc SmartScreen avertit au premier
lancement. Définissez `CSC_LINK` (chemin vers un `.pfx`) et `CSC_KEY_PASSWORD` pour signer.

## Notes de parité des fonctionnalités

- **Les agents, chats, worktrees git, le terminal intégré, et le panneau
  Git** fonctionnent tous sur Windows.
- **Les lanceurs d'applications externes** (la rangée d'icônes par slot) : « Ouvrir le terminal »
  (Windows Terminal / cmd), « Ouvrir l'éditeur » (VS Code / Cursor), et « Ouvrir le
  client git » (GitHub Desktop) sont câblés. Le lancement/focus de **Unity** et
  la détection de « l'application en cours d'exécution » par slot sont réservés à macOS pour l'instant (ils
  s'appuient sur `ps`/`lsof`/AppleScript) et n'ont aucun effet sur Windows.
- Les éléments spécifiques à macOS — le menu Dock, le correctif de `PATH` du shell de connexion, le
  routage d'URL par profil Chrome — sont protégés et simplement ignorés sur Windows.
