# Дизайн PopBot

Мультиагентный оркестратор разработки для AutoRPG. Вдохновлён Conductor; добавляет инфраструктуру тестирования внутри игры, чтобы агенты могли запускать реальную игру, кликать по ней и проверять поведение.

> **Статус:** дизайн — зафиксирован 2026-05-01. Живой документ; обновляется по ходу дела по мере того, как мы что-то обнаруживаем во время реализации.
>
> **Сначала прочитайте это:** [USER_STORIES.md](USER_STORIES.md) определяет шесть результатов, ради которых существует этот дизайн. Если этот документ и пользовательские истории расходятся, пользовательские истории побеждают, а этот документ обновляется.

## Goals

1. Запускать несколько ИИ-агентов разработки параллельно, каждый в своём собственном git worktree.
2. Позволить агентам управлять реальной игрой (оконный Unity Editor) для сквозного тестирования.
3. Отображать очереди тикетов / PR / Slack, историю транскриптов, логи и терминалы в одном окне.
4. По умолчанию — автономная работа; пауза только на действительно блокирующих событиях.

## Non-goals (v1)

- Продакшн CI/CD (отдельная задача)
- Кроссплатформенность (только macOS; Linux/Windows позже при необходимости)
- Мультипользовательский режим / SSO (один разработчик на машину)

## App layout

```text
┌──────────────┬─────────────────────────────────────────────┐
│ Tickets │ PRs│  ┌──┐ ┌──┐ ┌──┐ ┌──┐  Thumbnails (zoom-out)│
│   ENG-...    │  └──┘ └──┘ └──┘ └──┘                       │
│   ENG-...    ├─────────────────────────────────────────────┤
│   ENG-...    │                                             │
├──────────────┤  ┌────────┐  ┌────────┐  ┌────────┐        │
│ Chats        │  │ chat-1 │  │ chat-2 │  │ chat-3 │  + new │
│   live...    │  │        │  │        │  │        │        │
│   ──────     │  │        │  │        │  │        │        │
│   inactive   │  │        │  │        │  │        │        │
│              │  └────────┘  └────────┘  └────────┘        │
├──────────────┴─────────────────────────────────────────────┤
│ Logs ▼  Terminal  ...                                      │
│ [Unity] [Server]   (active chat's streams, sync-scroll)    │
└────────────────────────────────────────────────────────────┘
```

Вкладки в левом верхнем углу: **Tickets** (задачи Linear, назначенные на меня) и **Reviews** (PR, запрашивающие мою проверку). Клик по строке → создаётся чат, засеянный этой работой.

## Slots — the durable unit

Слот = git worktree + его Library + (опционально) его запущенный Unity Editor + (опционально) его запущенный sidecar-сервер. **Слоты создаются редко, переиспользуются постоянно.**

### Per-slot directory

```text
~/Library/Application Support/PopBot/slots/
├── slot-1/
│   ├── worktree/                    git worktree (persistent)
│   │   ├── Library/                 ~8 GB, lives here, slot owns it
│   │   ├── Assets/                  ~5.5 GB
│   │   └── ...
│   ├── server-data/                 sidecar's DB (local mode only)
│   ├── ports.json                   { mcp: 17901, server: 5101 }
│   ├── unity.log
│   ├── server.log
│   └── slot.json                    { branch, leasedBy, lastLeaseAt, unityPid?, serverPid? }
└── slot-2/...
```

### Real cost numbers (measured 2026-05-01 on AutoRPG)

| Операция | Время |
|---|---|
| `git worktree add` (с нуля, 62 тыс. файлов, LFS smudge) | ~23 с |
| Library COW от master (APFS clonefile) | ~1 с |
| Первый запуск Unity в слоте (холодная Library) | 1-3 мин |
| Sticky hit (Unity уже запущен, простаивает) | ~50 мс |
| Холодный старт (Unity выключен, ветка совпадает) | 15-30 с |
| Переключение ветки в существующем слоте (дельта + перезагрузка Unity) | 5-15 с |
| Создание слота целиком (worktree add + COW + первый импорт) | ~1-3 мин, **редко** |

### Disk budget

~14 ГБ на слот (8 ГБ Library + 5.5 ГБ Assets + scratch). 4 слота = ~55 ГБ. Общий `.git` (~8 ГБ) считается один раз.

### Lease policy

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### Branch uniqueness

Git отказывается выводить одну и ту же ветку в двух worktree одновременно. Решается так:
- **Lite / review-чаты** используют detached HEAD (без конфликта).
- **Два тестовых чата на одной ветке** — второй использует временную ветку (`<branch>-slot-N`) или detached HEAD; планировщик PopBot выбирает автоматически.

### Pre-checkout safety

Перед любым переключением ветки в существующем слоте:

1. `git stash --include-untracked` (всегда; страховка).
2. Отказ, если есть незакоммиченные коммиты, принадлежащие агенту; сначала закоммитить или упасть с явной ошибкой.
3. Закрыть все открытые сцены Unity (избежать проблем разрешения GUID между ветками).
4. `git checkout <branch>`.
5. Восстановить stash, если применимо, либо восстановить из записи stash для конкретной ветки.

### Per-slot policy knobs (in prefs)

- `pinnedBranch?` — отказывать в аренде для других веток; основной рабочий слот.
- `cleanOnRelease: bool` — `git clean -fd && git checkout .` при освобождении; по умолчанию выключено.
- `autoStashOnSwitch: bool` — по умолчанию включено.

## Resource budgets (independent knobs)

Слоты и активные экземпляры Unity — это **отдельные бюджеты**. Слот может существовать с выключенным Unity — в этот момент это просто хранилище. Запущенный Unity ограничен по RAM и настраивается независимо.

| Бюджет | Стоимость за единицу | По умолчанию | Пользовательская настройка |
|---|---|---|---|
| **Количество слотов** (worktree на диске) | ~14 ГБ | 2-4 | Prefs: "Slots" |
| **Максимум активных Unity** (запущенных процессов) | ~3-4 ГБ RAM | 2 | Prefs: "Max active Unity" |
| **Жёсткий потолок Unity** (лимит авто-одобрения в автономном режиме) | — | вычисляется: `floor(systemRAM / 4 GB)` | Prefs: "Unity hard cap" |

### Lease policy (extended)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### Agent-initiated dial-up

Новый MCP-инструмент, доступный, когда агент заблокирован из-за ёмкости Unity:

| Инструмент | Режим | Возвращает |
|---|---|---|
| `request_unity_capacity` | sync | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

Поведение:

- **Интерактивный чат** → чат становится жёлтым, баннер просит пользователя одобрить.
- **Автономный чат** → авто-одобрение до `Unity hard cap`; пауза для человека выше этого предела.
- Пользователь также может увеличивать/уменьшать лимит заранее в prefs в любой момент. Уменьшение лимита вытесняет простаивающие по LRU экземпляры Unity (никогда занятые).

## Chat types

| Тип | Слот | Library | Unity | Sidecar | Запуск | RAM |
|---|---|---|---|---|---|---|
| **Lite** (обзор, план, триаж) | опционально | — | — | — | ~1-2 с | ~50-100 МБ |
| **Client Test** | обязателен | принадлежит слоту | GUI на экране 2 | локальный или удалённый | 50мс-30с | ~2-4 ГБ |
| **Server Test** | обязателен | принадлежит слоту | GUI на экране 2 | всегда локальный | 50мс-35с | ~2-5 ГБ |

По умолчанию для новых чатов: **Lite**. Повышение, когда тестирование игры действительно нужно.

## Server modes

Настройка на уровне чата; переключается на лету.

| Режим | Источник сервера | Использовать, когда |
|---|---|---|
| `local` (по умолчанию) | `./run_local.sh --port <P> --data-dir <D>` на слот | Повседневные прогоны агента; изменения бэкенда; детерминированное состояние |
| `remote-dev` | Общий удалённый dev-сервер | Чистая итерация клиента; вход защищён обнаружением рассинхронизации |

### Drift detection

Перед принятием аренды remote-dev: PopBot читает константу `Assets/Scripts/Simulation/GameDataHash.cs` + версию DTO локально; делает GET `/health` на удалённом сервере; сравнивает. Несовпадение → отклонить аренду со структурированной ошибкой.

### `/health` returns

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### Mid-session toggle

Пользователь переключает `Server Mode` в настройках чата; PopBot:

1. Проверка рассинхронизации (если переход в remote-dev). Отказ при несовпадении.
2. Остановка / запуск sidecar-процесса при необходимости.
3. `client_set_server_endpoint { url }` через MCP — перенаправление во время выполнения.
4. Принудительный сброс игровой сессии (logout/title) — старая аутентификация недействительна.
5. Отмена выполняющихся задач, баннер: "server changed, restart task."

## Per-chat settings panel

| Настройка | По умолчанию | Примечания |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = авто-одобрение безопасного, пауза при реальном застревании |
| Server mode | `local` | `remote-dev` (проверка рассинхронизации) |
| Window mode | `GUI on screen 2` | `Headless` (позже, opt-in) / `Visible` |
| Time scale | `1.0` | Ускоренная перемотка анимаций |
| Game view resolution | `1920×1080` | Зафиксировано для воспроизводимых скриншотов |
| Auto-screenshot every action | выкл | Для пакетов доказательств |
| Verbose logs | выкл | Переключать при отладке самого агента |
| Agent backend | `claude` | `codex` (Фаза 4) |
| Default fixture | нет | Загрузка с сохранённым слепком |
| Token budget | `1M` | Пауза при достижении (автономный режим) |
| Time budget | `60m` | Пауза при достижении (автономный режим) |
| Loop detection | вкл | Пауза при N идентичных вызовах инструментов / отсутствии прогресса K минут |

## Autonomous mode

### Policy engine — plugged into `canUseTool`

Не прячьте политику в промпте; модель может себя из неё уговорить. Используйте жёсткий хук-вето SDK.

**Авто-одобрение в автономном режиме (без уведомления):**

- Read / Edit / Write / Grep / Glob внутри worktree слота
- Bash внутри worktree (с deny-списком ниже)
- MCP-вызовы к собственному MCP-серверу слота
- Вызовы Skill / суб-агентов
- TodoWrite, внутренние операции SDK

**Всегда пауза для человека (даже в автономном режиме):**

- `git push`, `git reset --hard`, `git checkout --`, любое force-действие, удаление веток
- Что-либо вне пути worktree слота
- Сетевые вызовы к хостам не из allowlist
- `rm -rf` вне `tmp/` или директории слота
- `gh pr create` и любое действие публикации на GitHub
- Slack / email / внешний обмен сообщениями
- Изменение `~/.claude`, `.mcp.json`, системной конфигурации

### "Truly stuck" detection

**Агент сам сообщает** (через форму `message_done` SDK):

- Уточняющий вопрос
- Явный блокер
- Терминальное "я закончил"

**PopBot следит** (эшелонированная защита):

- Loop — N идентичных вызовов инструментов подряд
- Stall — нет событий прогресса в течение K минут
- Превышен бюджет токенов / времени
- Повторяющиеся сбои тестов (один и тот же сбой K раз)

### Status colors (chat thumbnail)

| Цвет | Состояние |
|---|---|
| Синий | Выполняется |
| Зелёный | Задача завершена |
| Жёлтый | Пауза — нужен пользователь |
| Красный | Ошибка |
| Серый | Простой / не запущен |

В автономном режиме вы сканируете миниатюры на предмет **жёлтого**. Всё остальное в порядке.

## MCP automation surface

### Rule: every tool returns within ~100 ms

Долгие операции немедленно возвращают `{ jobId }`; агент опрашивает статус. Никогда не блокируйте HTTP-слушатель MCP дольше 100 мс.

### Job infrastructure

| Инструмент | Режим | Возвращает |
|---|---|---|
| `job_status` | sync | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | sync | полный payload инструмента; уничтожает job |
| `job_cancel` | sync | устанавливает кооперативный флаг отмены |
| `job_list` | sync | активные + недавние (TTL ~60с) |

Корутины выполняются через `EditorCoroutineUtility.StartCoroutineOwnerless`, управляемые `EditorApplication.update`. `JobContext` предоставляет `SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)`.

### Tool catalog — Phase 1 minimum

**Жизненный цикл:**

- `play_status` (sync), `play_pause` / `play_resume` / `play_step` (sync), `time_scale_set` (sync)
- `play_enter` (job), `play_exit` (sync)
- `editor_quit` (sync)

**Наблюдение:**

- `screenshot` (sync) — пишет в `Library/MCP/Screenshots/{session}/{label}.png`, возвращает путь
- `game_state_summary` (sync) — верх стека экранов, валюты, уровень, глава, экипировка, разблокировки, последние 10 ошибок
- `screen_stack` (sync), `chapter_status` (sync)
- `ui_tree` (sync) — иерархия с разрешённым `text-loc`
- `ui_query` (sync) — CSS-подобные селекторы (`.btn`, `#Confirm`, `[text-loc=Friends.Title]`)

**Действие:**

- `ui_click` (sync), `ui_click_by_loc` (sync) — вызывает `PointerDown/Up/ClickEvent` через `panel.SendEvent`

**Синхронизация / ожидание:**

- `wait_until` (job) — предикаты: `screen`, `log`, `event`, `path`
- `wait_for_idle` (job)

**Логи (расширение существующих):**

- `console_get_logs` — добавить `sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack: "none"|"first"|"all"`
- `server_logs` (sync) — хвост `server.log` PopBot, та же форма, что и `console_get_logs`
- `server_health` (sync), `client_set_server_endpoint` (sync)

**Сессии:**

- `mcp_session_start` / `mcp_session_end` — предсказуемые директории артефактов в `tmp/mcp-sessions/{slug}/`

### Tool catalog — later phases

- `command_apply`, `command_list` — основная поверхность действий, минующая UI
- `save_blob_get` / `save_blob_load`, управление фикстурами
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`, `gameview_resolution_set`
- `game_state_path` — reflection-based читатель с разрешённым списком корней

## Window management

По умолчанию: GUI-редактор с окном, размещённым нативным помощником.

**Нативный помощник перемещения окон для macOS (~50 строк на Swift):**

1. Плотный опрос `AXUIElement` (50 мс), чтобы помощник захватывал окно в течение ~100 мс после появления.
2. `setFrame:` на настроенный прямоугольник на экране 2.
3. `kAXMinimizedAttribute = true` (свернуть в dock).
4. Не красть фокус.

**Заранее заданные `EditorPrefs` для позиции окна перед запуском.** Unity восстанавливает последнюю позицию окна при старте, поэтому *второй* запуск и далее открывается уже позиционированным. Первый запуск кратко мигает (~200 мс); последующие запуски — нет.

**Одноразовая настройка со стороны пользователя** (документирована в первом запуске PopBot): `Dock → правый клик по Unity → Options → Assign To: Desktop X`. macOS автоматически направляет будущие окна Unity в это пространство. При такой настройке даже мигание при первом запуске происходит на пространстве, на которое пользователь не смотрит.

Позиция настраивается для каждого слота отдельно, чтобы несколько экземпляров Unity попадали в предсказуемые места на экране 2.

**Headless `Window Mode`** — opt-in после прохождения валидации batchmode (примерно Фаза 4). Архитектура идентична; меняется только флаг запуска.

## Server / Unity pairing protocol

Порядок запуска и жизненный цикл должны быть чётко выстроены, иначе возникают тонкие сбои.

### Startup sequence (PopBot enforces)

1. Запустить `./run_local.sh --port S --data-dir D`. Направить stdio в `server.log`. Записать `server_pid`.
2. Опрашивать `/health` до получения 200 (с `commit/gameDataHash/dtoVersion`). Таймаут 30 с. Сбой → убить сервер, показать ошибку.
3. Записать `client-server.json` в worktree, указывающий на `localhost:S`.
4. Запустить Unity с `POPBOT_MCP_PORT=M`. Записать `unity_pid`.
5. Опрашивать `/mcp` до получения 200. Таймаут 60 с. Сбой → убить оба процесса, показать ошибку.
6. Запускается нативный помощник перемещения окон.
7. Слот активен; агент может брать его в аренду.

### Death cascade

- **Сервер умирает в середине сессии** → PopBot обнаруживает это через проверку живости PID + 5xx от `server_health` → помечает слот как деградировавший → пробует один перезапуск сервера → если не удалось, показывает в чате как красный.
- **Unity умирает** → сервер продолжает работать (сервер переживает перезапуски Unity; это дешевле). PopBot может запустить свежий Unity против того же сервера.
- **Освобождение слота** → SIGTERM серверу (5 с на грацию) → SIGKILL → MCP-вызов `editor_quit` для Unity → SIGTERM (5 с на грацию) → SIGKILL.

### Reconciliation on PopBot startup

Сканировать файлы slot.json; для каждого записанного pid выполнить `kill -0 <pid>`; если мёртв, очистить состояние и сбросить слот. Стандартная гигиена процессов-сирот.

## Agent integration

### Claude Agent SDK (v1)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = query({
  prompt,
  options: {
    cwd: slot.worktreePath,
    mcpServers: {
      'popbot-unity': { type: 'http', url: `http://localhost:${slot.mcpPort}/mcp` }
    },
    permissionMode: chat.autonomous ? 'acceptEdits' : 'default',
    canUseTool: (tool, args) => popbotPolicy.evaluate(tool, args, chat),
  }
});

for await (const event of session) {
  routeToChatUI(event);
  routeToLogBuffers(event);
  autonomyEngine.observe(event);
}
```

Что мы получаем бесплатно: skills, память, суб-агенты, хуки, MCP, запросы прав в виде структурированных событий. **Не парсите вывод CLI `claude` через сабпроцесс** — это борьба с SDK за каждую продвинутую функцию.

### AgentBackend interface (defined day-1; one impl in v1)

```ts
interface AgentBackend {
  spawn(opts: SpawnOpts): AgentSession;
  capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
}
interface AgentSession {
  sendUser(text: string): void;
  approve(permId: string, decision: 'allow' | 'deny'): void;
  pause(): void;
  stop(): void;
  events: AsyncIterable<AgentEvent>;
}
```

Бэкенд Codex (Фаза 4) адаптирует OpenAI Agents SDK под этот интерфейс. Skills/память недоступны; UI это явно отмечает.

### Per-chat MCP config

Каждый агент запускается с `mcpServers`, внедрёнными для портов **своего слота** — URL `popbot-unity` = `localhost:<slot.mcpPort>/mcp`. Остальные MCP (Linear, Sentry, Amplitude, BetterStack) наследуются из `~/.claude/settings.json` или `.mcp.json` автоматически через SDK.

## Tech stack

- **Electron** (Node + Chromium)
- **React + Tailwind** для UI
- **xterm.js + node-pty** для панели терминала
- **better-sqlite3** для персистентности транскриптов (одна строка на событие, индексировано по chat + timestamp)
- **keytar** для OAuth-токенов / API-ключей / учётных данных агента
- **Linear GraphQL API** для панели тикетов
- **`gh` GraphQL** для панели непроверенных PR
- **Нативный помощник на Swift** для размещения окон

## Phasing

### Phase 0 — Prereqs (~3 days)

| Пункт | Владелец | Размер |
|---|---|---|
| Переопределение env `POPBOT_MCP_PORT` для MCP | Unity MCP | 5 мин |
| Аргументы `./run_local.sh --port` + `--data-dir` | server | 30 мин |
| `/health` возвращает `commit`, `gameDataHash`, `dtoVersion` | server | 30 мин |
| Нативный помощник перемещения окон для macOS (Swift) | PopBot | ~½ дня |
| Прототип жизненного цикла слота (worktree add, Library COW, переключение веток, безопасность stash) | PopBot | ~1 день |

### Phase 1 — MCP automation surface (~3-5 days)

Инфраструктура задач + каталог инструментов Фазы 1 выше. Миграция существующих долгих инструментов (`rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`) на модель job.

### Phase 2 — PopBot Electron MVP (~1-2 weeks)

Одна колонка чата, только `ClaudeBackend`, один слот, один Unity. Скелет панели настроек. Движок политик `canUseTool`. Интегрирован нативный помощник. Сквозной цикл: открыть чат → агент правит код → агент запускает игру → агент проверяет через скриншоты и логи → готово.

### Phase 3 — Multi-chat + panels (~1 week)

Несколько колонок чата (добавление/удаление плавающими +/x). Полоса миниатюр с цветовыми статусами. Панели тикетов Linear + непроверенных PR. Нижняя панель логов с вкладками Unity/сервер бок о бок. Переключатели Mode/server-mode в настройках чата.

### Phase 4 — Polish + advanced

Адаптер бэкенда Codex. Headless `Window Mode` (после валидации batchmode). `crash_dump`, `events_pop`, `command_apply`, управление фикстурами. Корреляция логов по времени бок о бок. Уточнение бюджетов автономности и обнаружения циклов.

## Open questions

1. **Валидация batchmode** — действительно ли AutoRPG работает в режиме Play с `-batchmode`? Скрипт валидации примерно в Фазе 4; не блокирует v1.
2. **Периодичность обновления Master Library** — ручная кнопка vs авто vs TTL в N дней? По умолчанию: ручная кнопка в prefs.
3. **Количество слотов по умолчанию** — жёстко заданные 4, или масштабирование по RAM/ядрам? Вероятно, по умолчанию 2-3, настраивается.
4. **Репозиторий PopBot** — отдельно от `autorpg`, или жить в `tools/popbot/`? Отдельно, когда стабилизируется; внутри дерева на ранней разработке.

## Risks

| Риск | Смягчение |
|---|---|
| `git checkout` повреждает слот в середине stash | Всегда сначала stash; проверка чистоты после checkout; отказ, если грязно |
| Два экземпляра PopBot топчут один и тот же слот | Lock-файл на директорию слота; сверка сирот при запуске |
| Unity зависает, и аренда слота никогда не освобождается | Проверка живости PID + сборка мусора при запуске PopBot |
| Конфликты LFS-блокировок между worktree | Редко; явно показывать, когда происходит |
| Library слота сильно отклоняется от master | Ручной "сброс слота" пересобирает из master |
| Диск заполняется | Показывать размер каждого слота в prefs; "сброс" освобождает место |
| Рассинхронизация бэкенда на remote-dev в середине сессии | Повторная проверка `server_health` при ошибках; баннер + остановка |
| Автономный режим авто-одобряет что-то небезопасное | Жёстко закодированный deny-список в `canUseTool`; никогда не переопределяется конфигурацией чата |

## Proof artifacts (agent debug deliverable)

Когда агент завершает задачу по отладке, он пишет в `tmp/mcp-sessions/{slug}/`:

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` следует шаблону из 6 разделов (Repro / Before / Root Cause / Fix / After / Verification). Соглашение документировано в SKILL (`agent-debug`); MCP предоставляет только предсказуемые пути сессий.

## Quick reference — what changed from earlier proposals

Для тех, кто читает переписку, породившую этот документ:

- Пул Library / пул процессов / пул worktree **схлопнулись в одну концепцию: слот.** Слот владеет своим worktree, Library, опциональным Unity, опциональным sidecar. Никаких симлинков, никаких отдельных пулов.
- `git worktree add` занимает **~23с на AutoRPG** (LFS smudge на 62 тыс. файлов), а не 1-2с. Создание слота — редкость; переиспользование через checkout — повседневный горячий путь.
- **GUI-редактор на экране 2** — дефолт v1. Headless batchmode — opt-in Фазы 4 после валидации.
- Сервер работает внутри дерева через `./run_local.sh`; порт и data-dir на слот для изоляции.
- Интеграция агента: **сначала Claude Agent SDK**, интерфейс AgentBackend, Codex в Фазе 4.
