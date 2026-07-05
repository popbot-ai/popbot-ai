*Languages: [English](../DEVELOPMENT.md) · [Español](../es/DEVELOPMENT.md) · [Français](../fr/DEVELOPMENT.md) · [Deutsch](../de/DEVELOPMENT.md) · [日本語](../ja/DEVELOPMENT.md) · [한국어](../ko/DEVELOPMENT.md) · [简体中文](../zh-CN/DEVELOPMENT.md) · [Português (Brasil)](../pt-BR/DEVELOPMENT.md) · **Русский** · [Italiano](../it/DEVELOPMENT.md)*

# Разработка

## Предварительные требования

- macOS (единственная поддерживаемая платформа для v1)
- Node 20 LTS или новее (`.nvmrc` зафиксирует версию, как только появится каркас проекта)
- pnpm (предпочтительно) или npm
- Xcode Command Line Tools (`xcode-select --install`) — нужен для нативного помощника на Swift и любых сборок node-gyp
- Клон [`autorpg`](../../../autorpg) в `~/pop/autorpg` для сквозного тестирования

## Первоначальная настройка

> В ожидании каркаса Electron (Фаза 2). Этот раздел заполнится, как только появится `package.json`.

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## Скрипты (планируются)

| Команда | Назначение |
|---|---|
| `pnpm dev` | Dev-сервер Vite + Electron main с перезагрузкой |
| `pnpm build` | Продакшн-сборки renderer + main |
| `pnpm package` | electron-builder → `release/` (.dmg) |
| `pnpm typecheck` | tsc --noEmit по main, preload, renderer, shared |
| `pnpm lint` | Проверка ESLint + Prettier |
| `pnpm test` | Юнит-тесты Vitest |

## Соглашения репозитория

- **Везде TypeScript.** Никаких `.js` вне конфигурационных файлов. Включён strict mode.
- **Никакого сырого IPC в компонентах.** Renderer общается с main через типизированный мост `window.popbot.*`, определённый в `src/preload/`.
- **Renderer — это чистое представление.** Никакого fs, никакого child_process, никаких node-модулей с нативными биндингами. Если компоненту нужна персистентность или системный вызов, выставляйте это через main + IPC.
- **Один файл на React-компонент**, названный в `PascalCase.tsx`. Хуки находятся рядом с компонентом, если они приватные, или в `renderer/hooks/`, если они общие.
- **Сначала Tailwind, точечный CSS — во вторую очередь.** Перенесённый `design/prototype/styles.css` становится слоем Tailwind + небольшим набором пользовательских CSS-свойств для токенов тёмной темы (`--bg-1`, `--fg-2` и т. д.).

## Работа с дизайн-прототипом

Оригинальный прототип находится в [`../design/prototype/`](../../design/prototype/) и является **замороженным эталоном**, а не целью сборки. См. [`design/README.md`](../../design/README.md) о том, как его просматривать.

При переносе компонента:

1. Откройте соответствующий `*.jsx` рядом с вашим `.tsx` для визуального ориентира.
2. Уберите алиасы `useStateA`/`useEffectA` (хак, который использовался в прототипе, чтобы избежать глобальных коллизий).
3. Замените `INITIAL_CHATS` и другие фикстуры уровня модуля на импорты из `renderer/fixtures/` или, со временем, на вызовы IPC.
4. Держитесь как можно ближе к визуальному поведению и поведению взаимодействия прототипа — см. [memory: stick close to the design](../../).

## Стиль коммитов

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Тело сообщения ≤ 72 столбцов. Начинайте с **почему**, а не с **что**.
- Один PR на одно логическое изменение. Не смешивайте каркас и функциональность.

## Работа со связанными репозиториями

PopBot управляет Unity-проектом AutoRPG + sidecar-сервером. Несколько предпосылок Фазы 0 попадают в тот репозиторий, а не в этот:

- Переопределение env `POPBOT_MCP_PORT` для MCP внутри редактора
- Флаги `./run_local.sh --port` и `--data-dir`
- Расширения эндпоинта `/health`

Когда вы работаете над этим, перейдите (`cd ~/pop/autorpg`) и следуйте соглашениям того репозитория.
