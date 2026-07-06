# Ejecutar PopBot en Windows

PopBot está construido sobre Electron + Node y se ejecuta en Windows, pero
algunos pasos de configuración difieren de macOS — mayormente en torno a los
dos módulos nativos (`better-sqlite3`, `node-pty`) y una peculiaridad de
Electron. Este documento captura la configuración que funciona.

## Prerrequisitos

- **Node 20 LTS o más reciente.** Node 24 funciona para *ejecutar* la
  aplicación, pero es tan nuevo que `better-sqlite3` no tiene un binario
  precompilado que coincida, así que un simple `npm install` intenta
  compilarlo desde el código fuente contra el ABI de Node y puede fallar
  (consulta "Módulos nativos" abajo). Node 20 / 22 evitan esa compilación.
- **Git for Windows** (`git`) y **GitHub CLI** (`gh`) en el `PATH`.
- El CLI **`claude`** en el `PATH` (un `claude.exe` — PopBot lo descubre vía
  `where.exe`). `codex` es opcional.
- **Visual Studio Build Tools 2022** con la carga de trabajo *Desktop
  development with C++* — solo se necesita si un módulo nativo tiene que
  compilarse desde el código fuente (por ejemplo, el winpty de `node-pty`).

## Configuración inicial

Los módulos nativos deben compilarse para el ABI de **Electron**, no el de
tu Node del sistema. La secuencia confiable:

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

Si usaste `--ignore-scripts`, el paso 2 es obligatorio — de lo contrario
electron-vite falla con `Error: Electron uninstall`.

## Dos problemas con los que puedes encontrarte

### Compilación de `node-pty`: `'GetCommitHash.bat' is not recognized`

`node-pty` empaqueta **winpty**, cuya compilación ejecuta `cd shared &&
GetCommitHash.bat`. Si tu entorno establece
**`NoDefaultCurrentDirectoryInExePath=1`** (una bandera de endurecimiento de
seguridad), cmd.exe se niega a ejecutar el `.bat` desde el directorio
actual y la compilación falla. Límpiala para la compilación:

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### `Cannot read properties of undefined (reading 'setName')` al lanzar

Esto significa que Electron arrancó como **Node puro** en lugar de como
Electron, así que `electron.app` es `undefined`. Sucede cuando
`ELECTRON_RUN_AS_NODE` está presente en el entorno — y en Windows, Electron
trata la *mera presencia* de esa variable (incluso vacía) como "ejecutar
como Node". Esto afecta cuando lanzas desde una terminal incrustada en otra
aplicación de Electron (VS Code, Claude Code), que exporta
`ELECTRON_RUN_AS_NODE=1`.

`npm run dev` / `npm run start` pasan por `scripts/electron-vite.mjs`, que
**elimina** la variable antes de iniciar Electron, así que esto está
manejado. Si invocas `electron-vite` directamente, asegúrate de que
`ELECTRON_RUN_AS_NODE` esté sin establecer (no solo vacía).

## Empaquetado

```bash
npm run package:win    # NSIS installer + zip → release/
```

Las compilaciones de Windows actualmente **no están firmadas**, así que
SmartScreen advierte en el primer lanzamiento. Establece `CSC_LINK` (ruta a
un `.pfx`) y `CSC_KEY_PASSWORD` para firmar.

## Notas de paridad de funcionalidades

- **Agentes, chats, worktrees de git, la terminal integrada, y el panel de
  Git** funcionan todos en Windows.
- **Los lanzadores de aplicaciones externas** (la fila de íconos por slot):
  "Abrir terminal" (Windows Terminal / cmd), "Abrir editor" (VS Code /
  Cursor), y "Abrir cliente git" (GitHub Desktop) están conectados. El
  lanzamiento/enfoque de **Unity** y la detección de la "aplicación en
  ejecución" por slot son solo para macOS por ahora (dependen de
  `ps`/`lsof`/AppleScript) y no hacen nada en Windows.
- Las partes específicas de macOS — menú del Dock, parcheo de `PATH` del
  shell de inicio de sesión, enrutamiento de URLs por perfil de Chrome —
  están protegidas y simplemente se omiten en Windows.
