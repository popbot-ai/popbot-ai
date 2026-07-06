# Архитектура

Практическая карта модели процессов Electron и того, где живёт каждая подсистема. О «зачем» см. [POPBOT_DESIGN.md](POPBOT_DESIGN.md). О **графе объектов + жизненных циклах + правилах владения**, на которых держится всё в этом документе, см. [CORE_MODEL.md](CORE_MODEL.md) — прочитайте его первым, если что-то ниже покажется немотивированным.

## Модель процессов

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                         │
│  ─ Slot / worktree lifecycle — git worktrees or shado VHDX slots,    │
│    per-SCM clone/client setup, branch/changelist switching           │
│  ─ SCM provider registry — git + perforce behind one abstraction;    │
│    callers branch on CAPABILITIES, not provider id                   │
│  ─ Agent host — Claude AND Codex backends behind AgentBackend        │
│    (one session per chat); the canUseTool policy boundary            │
│  ─ Editor launcher + per-slot MCP glue — focus/launch Unity/Unreal/  │
│    custom editors; hand the agent its slot's editor MCP HTTP URL     │
│  ─ PTY manager — a persistent terminal per chat                      │
│  ─ Persistence — better-sqlite3 (transcripts, chat/slot/repo state,  │
│    prefs, SDK + Codex session caches)                                │
│  ─ External APIs — tickets (Linear / Jira / GitHub), reviews         │
│    (GitHub PRs / Helix Swarm), Slack, Sentry                         │
└────────┬─────────────────────────────────────────────────────────────┘
         │ contextBridge (typed IPC channels, `window.popbot.*`)
┌────────▼─────────────────────────────────────────────────────────────┐
│ Renderer (Chromium + React + Tailwind)                               │
│  ─ App shell, panels, chat columns, settings sheets, modals          │
│  ─ Subscribes to agent event streams over IPC                        │
│  ─ Sends user actions (approve permission, send message, ...) back   │
│  ─ Owns nothing the main process needs to recover after a renderer   │
│    crash; renderer is a view layer                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Правило:** рендерер никогда не трогает файловую систему, никогда не порождает дочерние процессы, никогда не хранит канонического состояния. Всё это — main. Рендерер подписывается на события и диспетчеризует намерения.

## Расположение исходников

```text
src/
├── main/                       # Electron main process — Node, no DOM
│   ├── index.ts                # entry; createWindow, app lifecycle, handler wiring
│   ├── ipc/                    # typed IPC handlers, one module per subsystem
│   │                           #   (agent, apps, chats, files, git, notifications,
│   │                           #    repos, reviews, sentry, settings, slack, term, tickets)
│   ├── agents/                 # AgentBackend interface + ClaudeBackend + CodexBackend
│   │                           #   + StubBackend; AgentHost, SDK/Codex session stores,
│   │                           #   CLI probes, recovery
│   ├── scm/                    # source-control provider registry + base class;
│   │                           #   gitProvider, perforceProvider, detect
│   ├── git/                    # git plumbing: worktrees, chat paths, reviews (gh PRs)
│   ├── p4/                     # Perforce: exec, client/workspace, file watcher,
│   │                           #   Swarm client + swarmReviews
│   ├── shado/                  # bundled shado VHDX CLI wrapper: base, slots, client
│   ├── tickets/                # ticket-source registry + linear/jira/github sources
│   ├── reviews/                # provider-agnostic Reviews orchestrator (groups by SCM)
│   ├── linear/                 # Linear API client
│   ├── jira/                   # Jira Cloud API client
│   ├── github/                 # GitHub (`gh` CLI) client
│   ├── slack/                  # Slack client + DM/@mention/channel poller
│   ├── sentry/                 # Sentry client + issue poller
│   ├── notifications/          # in-app notification classify + dispatch
│   ├── term/                   # per-chat PTY manager (node-pty)
│   ├── attachments/            # chat attachment (image/file) retention store
│   ├── persistence/            # better-sqlite3 schema (migrations) + typed queries
│   └── updates/                # electron-updater auto-update + on-demand check
├── preload/
│   └── index.ts                # contextBridge — exposes the typed `window.popbot` API
├── renderer/src/               # React UI
│   ├── main.tsx                # ReactDOM.createRoot mount
│   ├── App.tsx
│   ├── components/             # FLAT dir — panels (PanelA/B/D), chat column, dialogs,
│   │                           #   sheets, git/P4 panels, modals, primitives
│   ├── lib/                    # client-side hooks + buses (useChats, useReviews,
│   │                           #   agentEventBus, …); calls `window.popbot.*`, no Node
│   ├── styles/                 # Tailwind layer + ported styles
│   ├── assets/                 # engine / SCM / notification icons
│   └── fixtures/               # static sample data for dev
└── shared/                     # types/contracts shared across the bridge
    ├── ipc.ts                  # IPC channel names, payload types, the PopBotApi surface
    ├── domain.ts               # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## Контракт IPC

Весь IPC типизирован и централизован в [`src/shared/ipc.ts`](../../src/shared/ipc.ts) — константа `IpcChannel` с картой строк, типы полезной нагрузки запроса/ответа и поверхность `PopBotApi`, которую раскрывает мост preload. Соглашения:

- **Префикс `pb:`** на каждом имени канала, с пространством имён по подсистеме (`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). См. константу `IpcChannel` для полного списка.
- **Запрос/ответ** использует `ipcRenderer.invoke` + `ipcMain.handle`. Возвращаемые значения типизированы. Обработчики регистрируются для каждой подсистемы из `main/ipc/*` и подключаются в `main/index.ts`.
- **Push-события** (поток агента, данные PTY, уведомления, прогресс обновления, разворачивание окна) используют `webContents.send` + `ipcRenderer.on`. Рендерер подписывается; main отправляет.
- **Никакого сырого IPC в компонентах.** Скрипт preload (`src/preload/index.ts`) раскрывает типизированный мост `window.popbot.*`; код рендерера использует хуки/шины в `renderer/src/lib/` (`useChats`, `useReviews`, `agentEventBus`, …), а не вызывает `ipcRenderer` напрямую.

## Слот в терминах кода

Слот — это не одна структура; это **пронумерованная аренда** (`slot_id`) плюс дисковый worktree/клон, на который эта аренда указывает. Состояние аренды живёт в строке чата (`chats.slot_id`, `chats.worktree_path` в `persistence/`), а вычисление свободных слотов — это запрос по открытым чатам, удерживающим слот для репозитория — размер пула репозитория равен `repos.slot_count`. `shared/domain.ts` несёт небольшой общий enum плюс устаревшую запись `Slot`:

```ts
export type SlotState = 'free' | 'leased' | 'degraded' | 'creating';

// NOTE: this `Slot` interface is currently unused by the running code
// (only SlotState + ChatStatus are imported). It still names Unity
// specifically; the live model has generalized past that — the editor is
// engine-agnostic (Unity/Unreal/custom) and isn't a supervised child with a
// tracked pid, so treat this shape as legacy, not authoritative.
export interface Slot {
  id: number;
  worktreePath: string;
  branch: string | null;
  ports: { mcp: number; server: number };
  unityPid: number | null;
  serverPid: number | null;
  state: SlotState;
  pinnedBranch?: string;
  cleanOnRelease?: boolean;
}
```

Выделение / освобождение / сверка слота распределены по `git/worktrees.ts` (git
worktrees), `shado/slots.ts` + `scm/*Provider.ts` (VHDX-слоты + пореповая
настройка клона/клиента) и обработчикам `ipc/repos.ts` + `ipc/chats.ts`. См.
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit) о политике
аренды и раздел **Непрерывность между слотами** ниже о том, как работа чата
следует за ним между слотами.

## Тёплое хранилище слотов: copy-on-write через shado VHDX

Для деревьев масштаба AAA (депо Perforce объёмом 0,5–1 ТБ для игры) слот не
может быть `git worktree` или полным чекаутом — нельзя скопировать депо N раз,
а холодная синхронизация+сборка занимает от минут до часов. **shado**
(поставляемый Go CLI, соседний репозиторий `github.com/popbot-ai/shado`,
вызываемый через `main/shado/`) предоставляет субстрат хранения на Windows:

- **Насытить + заморозить базу.** `shado create <repoPath>` синхронизирует/копирует
  папку репозитория в расширяемый VHDX, затем замораживает его **только для чтения**.
  База содержит полное дерево *плюс* тёплое производное состояние (кеши сборки,
  `node_modules`, `Intermediate/`, `Saved/`, `DerivedDataCache/`, …).
- **Дифференцирующие дочерние диски = слоты.** Каждый слот — это дочерний VHDX с
  copy-on-write от замороженной базы (`shado clone create --slot N`), монтируемый
  через `Mount-VHD` + `Add-PartitionAccessPath` в **папку точки монтирования** (не
  буква диска, так что масштаб превышает ~20 слотов). Свежий, готовый к сборке слот
  стоит секунд и нескольких ГБ дельты вместо 1 ТБ повторной синхронизации + холодной
  сборки. Сброс = уничтожить дочерний диск + пересоздать из базы (мгновенно и чисто).
- **Раскладка.** Слоты живут на **том же диске, что и репозиторий** (этого требует
  модель VHDX): `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`; база +
  диффы + метаданные слотов под `…/workspaces/<repoId>/shado` (`SHADO_HOME`). Пути
  выводятся в `main/shado/client.ts` (`popbotRootForRepo`, `shadoHomeForRepo`).
- **Повышение прав.** `shado create` / `clone create` / `remount` / `restore`
  требуют прав администратора; PopBot работает без повышенных прав, поэтому они
  запускаются через одно окно UAC (временный `.bat` + `Start-Process -Verb RunAs`).
  Клоны, созданные с повышенными правами, оказываются во владении группы
  Administrators → git получает `-c safe.directory=*` при каждом вызове, а клиенты
  p4 привязаны к хосту.
- **Перезагрузка.** Монтирования VHDX не переживают перезагрузку (отсоединённые
  клоны + сломанные reparse-папки точек монтирования). При запуске мы обнаруживаем
  отключённые репозитории со слотами и показываем **центральное модальное окно**
  («Reconnect»), на которое нажимает пользователь — одно окно UAC перемонтирует их
  все (`remountReposElevated`). См. `main/shado/base.ts`.

Путь через git worktree (`repo.mode = 'slots'` для не-shado репозитория) всё ещё
существует для обычных репозиториев; shado выбирается для каждого репозитория в
случае VHDX/Perforce.

### Пореповая настройка слота

Слот — это **независимый клон/клиент**, а не общий чекаут — это ключевой факт,
лежащий в основе непрерывности между слотами ниже.

- **git** (`scm/gitProvider.ts`): слот — это полный клон замороженной базы.
  `ensureSlotWorktree` размещает его на `popbot/slot-N`; `checkoutBranch` создаёт
  ветку чата от **последней** базы (`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`), отбрасывая унаследованную грязь базы, сохраняя
  при этом тёплые кеши, находящиеся в gitignore.
- **perforce** (`p4/*`, `scm/perforceProvider.ts`): у каждого слота свой клиент p4
  `popbot_<repoId>_slot<N>`, укоренённый в точке монтирования. Настройка — это
  `p4 flush @baseChangelist` (обновление have-таблицы на 0 байт относительно
  замороженной базы) + `p4 sync` только дельты база→head. **Нет `p4 reconcile`**
  (20-минутный обход дерева на игровом депо): пореповый `fs.watch` записывает
  изменённые пути, и провайдер открывает только их через целевые `p4 edit/add/delete`.
  Собственные записи PopBot (sync/revert/unshelve) **приостанавливают** наблюдатель,
  чтобы они не переоткрывались.

## Непрерывность между слотами: дом ветки/чейнджлиста чата

**Проблема.** Поскольку каждый слот — это независимый клон (git) / клиент
(perforce), ветка чата или ожидающий чейнджлист живут **только в том слоте,
в котором были созданы**. Чаты заимствуют слоты из общего пула и могут снова
открыться в *другом* слоте — где эта работа не существовала бы. (У старой модели
`git worktree` этой проблемы не было: все worktree делили один `.git`, так что
ветки были централизованы.)

**Решение.** Консолидировать работу чата в независимый от слота **дом** при
закрытии и восстанавливать её при повторном открытии. Подключено через
`SourceControlProvider.persistChatOnClose` / `restoreChatOnReopen`, вызываемые из
обработчиков `ChatsClose` / `ChatsReopen` (`ipc/chats.ts`), заменяя старый
локальный для слота стеш. Состояние сохраняется в чате: `chats.p4_shelf_cl`
(perforce; git не требует ничего).

- **git → ЛОКАЛЬНЫЙ КОРНЕВОЙ репозиторий.** Дом — это `repo.repoPath` — папка
  репозитория на диске, из которой был клонирован каждый слот — добавленная в
  каждый слот как удалённый репозиторий `root` (`origin` остаётся настоящим
  удалённым репозиторием GitHub, для PR).
  - *Закрытие:* перенести незакоммиченную работу как одноразовый коммит
    `[Soft committed unstaged files]` (если пользователь не отклонил её), затем
    `git push -f root <branch>`. Локальный корень накапливает ветку каждого чата
    (его список веток = старое поведение общего worktree).
  - *Повторное открытие:* после чекаута базы, `git fetch root <branch>` →
    `checkout -f -B branch FETCH_HEAD` → мягкая отмена коммита WIP, чтобы правки
    вернулись незакоммиченными.
- **perforce → КОРНЕВОЙ КЛИЕНТ как шелф.** Ожидающий чейнджлист — пореповый,
  поэтому дом — это серверный **шелф**, принадлежащий стабильному, никогда не
  синхронизируемому пореповому клиенту `popbot_<repoId>_root` (`ensureRootClient`
  — только спецификация, без синхронизации).
  - *Закрытие:* `p4 shelve` CL слота, затем `p4 reshelve -f` его на CL чата,
    принадлежащий корню. **`reshelve` перемещает шелф-контент на стороне
    сервера** — подтверждено на Helix 2025.2: между клиентами, без синхронизации
    рабочего пространства, ничего не записывается на диск корня («переместить
    шелфы, не изменять файлы»). Затем удаляется шелф слота + открытые файлы + CL,
    так что слот остаётся **пустым**; корневой клиент владеет одним shelved CL на
    чат.
  - *Повторное открытие:* `p4 unshelve -s <rootCl> -c <newSlotCl>` в свежий CL
    нового слота (наблюдатель приостановлен), сохраняя корневой шелф как
    припаркованную резервную копию.

Итог: слоты — это взаимозаменяемое место для черновой работы; локальный корневой
git-репозиторий и корневой клиент p4 — устойчивые, видимые пользователю дома для
работы в процессе.

## Бэкенд агента

`AgentBackend` (`main/agents/types.ts`) — это интерфейс между `AgentHost` и
конкретным бэкендом. **Сегодня поставляются два реальных бэкенда** —
`ClaudeBackend` (оборачивает `@anthropic-ai/claude-agent-sdk`) и `CodexBackend`
(оборачивает `@openai/codex-sdk`) — плюс `StubBackend` для тестов. Чат выбирает
свой бэкенд (`chats.agent`) и может переключаться; поскольку у двух SDK разные
нативные хендлы возобновления, настройки модели и уровня усилий, они хранятся
**с привязкой к провайдеру** (`session_id` Claude + `claude_model`/
`claude_reasoning_effort`; `codex_thread_id` Codex +
`codex_model`/`codex_reasoning_effort`). `AgentHost` выбирает бэкенд, порождает
одну сессию на чат и ретранслирует `AgentEvent`-события каждой сессии рендереру
+ персистентности.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

Редакторский MCP для каждого слота передаётся бэкенду при порождении:
`SpawnOpts.mcpServers` несёт конечную точку редактора Unity/Unreal чата
(`{ type: 'http', url }`), зарегистрированную в памяти в опциях SDK — ничего не
записывается на диск. Использует её только бэкенд с возможностью `mcpHttp`. См.
раздел **Редакторский MCP для каждого слота** ниже.

Колбэк `canUseTool` живёт рядом с бэкендом, а не в промпте агента — это наш
жёсткий рубеж безопасности с правом вето. Разрешение правил (`resolveRule`)
сверяется сначала с пореповыми, затем с глобальными правилами разрешений перед
запросом к пользователю. См. [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md).

## Персистентность

- **`better-sqlite3`** в `<userData>/popbot.db` (macOS: `~/Library/Application
  Support/PopBot/`; эквивалентный для каждой ОС `app.getPath('userData')` на
  Windows / Linux). Схема — это пронумерованный список миграций в
  `persistence/db.ts` (управляемый `user_version`, каждый шаг атомарен). Текущие
  таблицы:
  - `chats` — одна строка на чат: аренда слота (`slot_id`), `worktree_path`,
    `repo_id`, активный `agent`, модель/уровень усилий для каждого провайдера +
    хендлы возобновления (`session_id`, `codex_thread_id`), `permission_rules` и
    состояние между слотами (`p4_shelf_cl`).
  - `messages` — одна строка на событие агента (устойчивая стенограмма).
  - `repos` — конфигурация для каждого репозитория (путь, цвет, префикс слота,
    база по умолчанию, количество слотов, `mode` = `slots`/`ephemeral`, `scm`,
    JSON `p4_config`).
  - `settings` — JSON-настройки приложения в виде ключ/значение (ссылки на
    учётные данные интеграций, настройки UI).
  - `notifications` — лента уведомлений внутри приложения.
  - `sdk_session_entries` — таблица SessionStore SDK Claude (с ключом по чату;
    PopBot владеет копией для восстановления, так что resume не зависит от
    JSONL-файлов `~/.claude`).
  - `codex_thread_events` — устойчивый кеш сырых событий потока Codex (Codex
    возобновляет из `~/.codex/sessions`; это собственная копия PopBot для
    восстановления/диагностики).

  Нет *таблицы* кеша тикетов/PR: очереди Tickets и Reviews кешируются в
  рендерере (см. комментарии IPC `list-recent`), не в SQLite.
- **Пореповый scratch** живёт в worktree/точке монтирования слота и в каталогах
  рантайма для каждого чата (файлы сессии CLI агента, PTY, сохранённые вложения).
  Слоты shado VHDX живут на диске репозитория под
  `…/popbot/workspaces/<repoId>/…` (см. раздел про shado).
- **Секреты** через `keytar` (связка ключей ОС — macOS Keychain / Windows
  Credential Vault / libsecret). Никогда в БД SQLite, никогда в логах.

## Источники тикетов, провайдеры SCM, ревью, редакторы, обновления

Пять швов провайдеров, на которых держатся подсистемы верхнего уровня — все
спроектированы так, чтобы добавление бэкенда было локальным, а вызывающий код
оставался универсальным:

- **Источники тикетов** (`tickets/`). Один активный `TicketSource` питает очередь
  Tickets, выбираемый настройкой `ticketSource` через `tickets/registry.ts`
  (Linear / Jira / GitHub; по умолчанию Linear). Каждый источник нормализуется к
  общим DTO Linear, так что рендерер отображает все трекеры через один путь и
  ветвится только по возможностям в `shared/ticketProvider.ts`, никогда по
  идентификатору провайдера. Добавление трекера — это одна строка в реестре +
  `*Source.ts` + дескриптор.
- **Провайдеры SCM** (`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`
  — небольшая общая поверхность (жизненный цикл рабочего пространства, ревью
  рабочего дерева, обнаружение PR/ревью, непрерывность между слотами).
  `GitProvider` и `PerforceProvider` реальны; `lore` намечен вчерне.
  `scm/index.ts` возвращает один экземпляр на идентификатор. **Вызывающий код
  ветвится по ВОЗМОЖНОСТЯМ (`shared/sourceControl.ts`), никогда по идентификатору
  провайдера** — всё, что плохо абстрагируется, — это флаг возможности, а
  слишком отличающийся провайдер подключает собственное клиентское окно через
  `capabilities.nativeClientUi`.
- **Ревью** (`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`).
  Не зависящий от провайдера оркестратор группирует настроенные репозитории по
  SCM и диспетчеризует к методам ревью каждого провайдера (при условии
  `capabilities.pullRequests`), объединяя GitHub PR и ревью Helix Swarm в одной
  панели. Каждый провайдер владеет собственной **частотой опроса**
  (`reviewPollIntervalMs` — Swarm медленнее GitHub, чтобы защитить общий p4d), а
  панель запускает один таймер на провайдера (`pb:reviews:providers` /
  `pb:reviews:list-for`).
- **Редакторский MCP для каждого слота** (`ipc/apps.ts`, `shared/gameEngine.ts`).
  Движки (Unity / Unreal / пользовательский) включаются независимо. Когда
  `useMcp` включён, редактор каждого слота запускается с **портом MCP для
  этого слота** (`mcpBasePort + (slotId-1)`), так что параллельные редакторы не
  конфликтуют, а `mcpEndpointForChat` передаёт агенту HTTP-URL редакторского MCP
  этого слота при порождении. Редакторы запускаются **отсоединённо**
  (сфокусировать-или-запустить), не как супервизируемые долгоживущие дочерние
  процессы.
- **Обновления** (`updates/`). Автообновление electron-updater с резервным
  вариантом ручной загрузки для неподписанных сборок, плюс проверка по запросу
  для диалога «О программе» (`pb:updates:*`).

## Сквозные аспекты

- **Логирование** — main записывает диагностические логи через `diagLog`
  (`dlog`); CLI агента и PTY несут собственный вывод рантайма для каждого чата;
  логи рендерера маршрутизируются через main по IPC.
- **Восстановление при запуске** — восстановление управляется БД и сессиями, а
  не файлами PID (последовательность загрузки `main/index.ts`): `initDb()`
  запускает ожидающие миграции; `clearStaleRunningStatuses()` переводит любой
  чат, оставшийся в статусе `run`, обратно в `idle` (сессия агента предыдущего
  запуска отсутствует); импорт хранилища сессий + миграция каталога проекта SDK
  + `sessionPinRepair` + `recoverChatSessions` сверяют закреплённые сессии
  Claude/Codex с тем, что реально есть на диске; проверки CLI сообщают, какие
  бэкенды в сети. На Windows отключённые слоты shado VHDX (перезагрузка сбросила
  их монтирования) обнаруживаются и показываются для повторного монтирования с
  одним UAC (см. заметку **Reboot** про shado выше).
- **Обновления** — автообновление electron-updater; см. провайдер
  **Обновления** выше.
