# Запуск PopBot на Windows

PopBot построен на Electron + Node и работает на Windows, но несколько шагов
настройки отличаются от macOS — в основном вокруг двух нативных модулей
(`better-sqlite3`, `node-pty`) и одной особенности Electron. Этот документ
фиксирует рабочую настройку.

## Предварительные требования

- **Node 20 LTS или новее.** Node 24 работает для *запуска* приложения, но он
  настолько новый, что у `better-sqlite3` нет соответствующего готового
  бинарника, так что обычный `npm install` пытается скомпилировать его из
  исходников под ABI Node и может завершиться неудачей (см. «Нативные модули»
  ниже). Node 20 / 22 позволяют избежать этой компиляции.
- **Git for Windows** (`git`) и **GitHub CLI** (`gh`) в `PATH`.
- CLI **`claude`** в `PATH` (`claude.exe` — PopBot обнаруживает его через
  `where.exe`). `codex` опционален.
- **Visual Studio Build Tools 2022** с нагрузкой *Desktop development with
  C++* — нужны, только если нативный модуль должен компилироваться из
  исходников (например, winpty от `node-pty`).

## Первоначальная настройка

Нативные модули должны быть собраны под ABI **Electron**, а не системного
Node. Надёжная последовательность:

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

Если вы использовали `--ignore-scripts`, шаг 2 обязателен — иначе
electron-vite завершится ошибкой `Error: Electron uninstall`.

## Два подводных камня, с которыми вы можете столкнуться

### Сборка `node-pty`: `'GetCommitHash.bat' is not recognized`

`node-pty` включает **winpty**, чья сборка запускает `cd shared &&
GetCommitHash.bat`. Если в вашем окружении установлен флаг
**`NoDefaultCurrentDirectoryInExePath=1`** (флаг усиления безопасности),
cmd.exe отказывается запускать `.bat` из текущего каталога, и сборка
завершается неудачей. Очистите его для сборки:

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### `Cannot read properties of undefined (reading 'setName')` при запуске

Это означает, что Electron запустился как **обычный Node**, а не как
Electron, так что `electron.app` — `undefined`. Это происходит, когда в
окружении присутствует `ELECTRON_RUN_AS_NODE` — а на Windows Electron
считает саму *наличие* этой переменной (даже пустой) сигналом «запускаться
как Node». Это проявляется, когда вы запускаете из терминала, встроенного в
другое приложение Electron (VS Code, Claude Code), которое экспортирует
`ELECTRON_RUN_AS_NODE=1`.

`npm run dev` / `npm run start` проходят через `scripts/electron-vite.mjs`,
который **удаляет** переменную перед запуском Electron, так что это уже
обработано. Если вы вызываете `electron-vite` напрямую, убедитесь, что
`ELECTRON_RUN_AS_NODE` не установлена (не просто пуста).

## Упаковка

```bash
npm run package:win    # NSIS installer + zip → release/
```

Сборки для Windows сейчас **неподписаны**, так что SmartScreen предупреждает
при первом запуске. Задайте `CSC_LINK` (путь к `.pfx`) и `CSC_KEY_PASSWORD`
для подписи.

## Заметки о паритете функций

- **Агенты, чаты, git worktrees, встроенный терминал и панель Git** — всё
  это работает на Windows.
- **Лаунчеры внешних приложений** (ряд иконок для каждого слота): "Open
  terminal" (Windows Terminal / cmd), "Open editor" (VS Code / Cursor) и
  "Open git client" (GitHub Desktop) подключены. Запуск/фокусировка **Unity**
  и обнаружение «запущенного приложения» для каждого слота пока доступны
  только на macOS (они полагаются на `ps`/`lsof`/AppleScript) и не выполняют
  ничего на Windows.
- Специфичные для macOS элементы — меню Dock, патчинг `PATH` login-shell,
  маршрутизация URL через профиль Chrome — защищены проверками и просто
  пропускаются на Windows.
