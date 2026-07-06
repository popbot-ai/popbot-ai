# Основная модель

Граф объектов, вокруг которого построено приложение PopBot. Всё остальное —
IPC, персистентность, панели UI, цикл агента — держится на них. Если вы
меняете поведение так, что это нарушает правило отсюда, **либо сначала
обновите модель, либо сообщите пользователю, что модель меняется.**

О том, «где живёт код», см. [ARCHITECTURE.md](ARCHITECTURE.md).
О том, «что видит пользователь», см. [USER_STORIES.md](USER_STORIES.md).

---

## TL;DR — четыре существительных, которые важны

| Существительное | Устойчиво? | Владелец | Время жизни |
|---|---|---|---|
| **Chat** | да (SQLite) | main | создаётся пользователем, живёт до явного удаления |
| **Message** | да (SQLite, почти только-добавление) | main | дочерний объект Chat |
| **Slot** | да (файловая система + строка SQLite) | main / `SlotManager` | создаётся редко, переиспользуется; никогда на чат |
| **AgentSession** | **нет** (только в памяти) | main / `AgentHost` | порождается, когда Chat переходит в «running»; уничтожается при закрытии Chat или выходе из приложения |

Всё в рендерере — это **представление** над этими объектами. Рендерер никогда
не владеет каноническим состоянием.

---

## Устойчивые существительные (переживают перезапуск)

### Chat

Единица работы пользователя. Один тикет, одно ревью PR, один тред Slack, одна
сессия «покопаться в кодовой базе» — каждая из них — один Chat.

```ts
interface ChatRecord {
  id: string;                                // chat_<12hex>
  name: string;                              // "ENG-20512 · ability cooldown"
  ticket: string | null;                     // "ENG-20512"
  pr: number | null;                         // 7401
  branch: string | null;                     // git branch this work targets
  type: 'lite' | 'client_test' | 'server_test';
  mode: 'interactive' | 'autonomous';
  agent: 'claude' | 'codex';
  status: ChatStatus;                        // see lifecycle below
  snippet: string;                           // last agent prose (cached for thumbnail)
  tokensUsed: number;
  tokensBudget: number;
  createdAt: number;
  lastActiveAt: number;
  closedAt: number | null;                   // null = open
}
```

**Жизненный цикл статуса** (US-6 — что окрашивает превью):

```text
              ┌──────────────┐
              │   idle (○)   │ ← initial state, no agent attached
              └──────┬───────┘
        send/respawn │
              ┌──────▼───────┐
              │  running (▶) │ ── error ──→  errored (✗)
              └──┬───────┬───┘
   needs review │       │ message-end + no work pending
              ┌─▼─────┐ │
              │paused │ │
              │  (?)  │ │
              └──┬────┘ │
       resolve   │      │
              ┌──▼──────▼─────┐
              │ complete (✓)  │
              └───────────────┘
```

**Статус описателен, а не предписателен** — выводится из AgentSession, когда
она подключена, сохраняется в БД при переходе. Чат в статусе `idle` означает
«сейчас никакой агент не выполняет работу». Это не означает «чат закрыт».

**Открыт vs закрыт:** чат «открыт» тогда и только тогда, когда `closedAt IS
NULL`. Открытые чаты загружаются в память при запуске; закрытые доступны
только для запросов. **Закрытие чата освобождает его аренду слота +
уничтожает его AgentSession, но никогда не удаляет Messages.**

### Message

Почти только-добавляемый журнал событий внутри Chat. Стенограмма — это
последовательность типизированных записей:

```ts
interface MessageRecord {
  id: string;                                   // msg_<12hex>
  chatId: string;
  role: 'user' | 'agent' | 'system';
  kind: 'text' | 'tool' | 'permission' | 'system';
  body: string;                                 // JSON-encoded payload (shape per kind)
  createdAt: number;
  updatedAt: number;
}
```

**Почему JSON в `body`?** У каждого вида своя форма полезной нагрузки (текст
против вызова инструмента против запроса разрешения), и рендерер
диспетчеризует по `kind`. Хранение как типизированного JSON-блоба сохраняет
таблицу плоской, а код рендерера — честным.

**«Почти только-добавление»:** строки `tool` и `permission` изменяются
**один раз**:

- строки `tool`: записываются при `tool-use` (имя + аргументы), обновляются
  при `tool-result` (заполняют `result` + `isError`).
- строки `permission`: записываются при `permission-request` (инструмент +
  аргументы + причина), обновляются при решении пользователя (устанавливают
  `decision`).
- строки `text`: записываются при `message-start` с пустым текстом,
  **объединяются** в небольшом буфере в памяти по мере поступления событий
  `text-delta`, сбрасываются при `message-end` (и каждые ~250 мс, чтобы
  рендерер оставался живым). Одна строка на «реплику текста агента», а не
  одна строка на дельту.

**Никаких каскадных удалений от отката работы агента.** Если агент совершает
ошибку и вы хотите, чтобы он «попробовал снова», вы отправляете новое
сообщение пользователя. Старая стенограмма остаётся. Модель никогда тихо не
переписывает историю.

### Slot

Тёплое, изолированное, одноразовое рабочее пространство: изолированный
чекаут поверх папки с copy-on-write (git worktree или клиент Perforce) + тёплый
кеш сборки (например, кеш ассетов/импорта движка) + (опционально) запущенный
редактор для тестируемого приложения (Unity, Unreal или пользовательский
движок) + (опционально) запущенный вспомогательный сервер. **Создаётся редко,
переиспользуется постоянно.** Слоты принадлежат пользователю/приложению, не
чатам.

```ts
interface SlotRecord {
  id: number;                                   // slot-1, slot-2, ...
  worktreePath: string;
  branch: string | null;                        // null if free / detached
  ports: { mcp: number; server: number };
  unityPid: number | null;                      // editor PID; refreshed via PID liveness
  serverPid: number | null;
  state: 'free' | 'leased' | 'degraded' | 'creating';
  pinnedBranch?: string;                        // refuse leases for other branches
  cleanOnRelease?: boolean;
  leasedByChatId?: string;                      // soft pointer; a Chat → Slot binding
  lastLeaseAt?: number;
}
```

**Привязка Slot ↔ Chat** — **временная** — она живёт в `slot.leasedByChatId`
и соответствующих рантайм-метаданных Chat. При запуске мы сверяем это,
проходя по слотам и сопоставляя их с открытыми чатами. Устаревшие аренды
(чат закрыт, аренда никогда не была освобождена) собираются как мусор.

О полном жизненном цикле слота см.
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit).

### Permission grant

Устойчивое решение пользователя о том, что определённая комбинация
инструмент/цель одобрена без повторного запроса. Две области действия:

```ts
interface PermissionGrant {
  id: string;                                   // grant_<12hex>
  scope: 'global' | 'chat';
  chatId: string | null;                        // non-null iff scope='chat'
  tool: string;                                 // exact tool, e.g. 'Bash', 'git_push', 'mcp__linear__save_issue',
                                                //   OR a trailing-`*` wildcard, e.g. 'mcp__unrealEditor__*'
  /** Optional refinement: 'Bash' tool restricted to commands matching this prefix. */
  argMatcher: string | null;                    // raw string OR /regex/ — TBD
  decision: 'allow' | 'deny';
  createdAt: number;
}
```

`tool` может быть wildcard с завершающей `*`, так что весь MCP-сервер можно
разрешить одним разрешением (`allow-mcp-server` → `mcp__<server>__*`) — именно
так редакторский MCP слота разрешается один раз вместо разрешения для каждого
инструмента. Правила запрета всегда побеждают над разрешением, а более
конкретный паттерн побеждает над более широким (см. `resolvePermissionRules` в
`src/shared/agent.ts`).

Разрешения накапливаются для каждого чата (US-9: «всегда разрешать git push
для этого чата»). Жёстко закодированные **правила запрета** в
[adr/0004](../adr/0004-canusetool-policy-boundary.md) здесь не хранятся — они
живут в коде и не могут быть переопределены.

### Settings

Два слоя:

- **Глобальные настройки**: тема, тип чата по умолчанию, количество слотов,
  частота обновления главной Library и т. д. Таблица из одной строки.
- **Переопределения для каждого чата**: режим сервера, масштаб времени,
  режим окна, бюджет токенов и т. д. Хранятся в таблице `chat_settings` с
  ключом по `chatId`.

Любое из них может быть пустым (применяются значения по умолчанию).
Изменяется через панели настроек в рендерере.

### Кешированные элементы внимания

Очереди пользователя из назначенных тикетов (Linear / Jira / GitHub Issues) и
ожидающих ревью (GitHub PR / чейнджлисты Helix Swarm). Кешируются локально,
чтобы панели отображались мгновенно; обновляются по расписанию + по запросу.

```ts
interface AttentionItem {
  id: string;                                   // source-prefixed: linear:ENG-20512, jira:ENG-123, gh:7401, swarm:1284
  source: 'linear' | 'jira' | 'github' | 'swarm';
  /** Source-specific raw payload, JSON. */
  payload: string;
  /** Local UI-state: have I dismissed this? Is there a chat already open for it? */
  dismissedAt: number | null;
  spawnedChatId: string | null;
  fetchedAt: number;
}
```

Источники тикетов взаимозаменяемы за общим провайдером (Linear, Jira, GitHub
Issues); источники ревью аналогично (GitHub PR, Swarm). Кешируются, но не
являются источником истины — источник истины — сам трекер / система ревью.

---

## Рантайм-существительные (только в памяти; не переживают перезапуск)

### AgentSession

То, что разговаривает с LLM. Одна AgentSession на «выполняющийся» Chat.
Опирается на `AgentBackend` (Claude Agent SDK или Codex SDK; оба поставляются
сегодня).

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**Принадлежит `AgentHost`** (синглтон в главном процессе). AgentHost хранит
`Map<chatId, AgentSession>`. Сессии создаются лениво при первом `agent.send`
для чата и уничтожаются при закрытии чата.

**Сессии испускают события `AgentEvent`** (см. `src/shared/agent.ts`).
AgentHost перехватывает каждое событие и:

1. **Сохраняет** его (дельты объединяются в строку текста; tool-use создаёт
   строку инструмента; permission-request создаёт строку разрешения).
2. **Ретранслирует** его рендереру через `webContents.send`. Рендерер — один
   из N подписчиков; main — авторитетный регистратор.
3. **Обновляет метаданные Chat** — `status`, `snippet`, `tokensUsed`,
   `lastActiveAt` продвигаются вперёд по мере поступления событий.

**Сессии никогда не пишут напрямую в БД.** Это делает только AgentHost. Это
сохраняет эволюцию схемы персистентности отделённой от замены бэкендов.

### Permission request (в процессе)

Когда срабатывает колбэк `canUseTool` SDK:

1. PolicyEngine оценивает: жёсткое разрешение (авто), жёсткий запрет (авто)
   или спросить пользователя.
2. Если «спросить пользователя», AgentHost испускает событие
   `permission-request` рендереру **и «паркует» колбэк SDK** — с ключом по
   `permissionId` — в карте ожидающих.
3. Рендерер показывает модальное окно; пользователь кликает решение; IPC
   обратно в main.
4. AgentHost находит ожидающий колбэк и разрешает его. SDK продолжает или
   прерывает.
5. Если было отмечено «всегда разрешать это», записывается строка
   `PermissionGrant`.

Ожидающие запросы **не сохраняются**. Если приложение падает посреди
решения, вызов инструмента агента отменяется при перезапуске.

### Хендлы супервизора процессов

На слот: `child_process.ChildProcess` для тестируемого приложения-редактора
(Unity / Unreal / пользовательский движок — поле `unityPid` записывает его
PID независимо от движка), ещё один для вспомогательного сервера.
Принадлежат `SlotManager`. Проверяются на здоровье через живучесть PID + HTTP
пробы. Уничтожаются при освобождении слота / выходе из приложения.
**Сверяются при запуске** проходом по `slot.json` каталога слота и проверкой,
что записанные PID всё ещё живы.

---

## Правила владения

Это **инварианты**. Код, который их нарушает, — это баг.

1. **Рендерер — чистое представление.** Никакой fs, никакого child_process,
   никакого доступа к БД. Общается с main исключительно через типизированный
   мост `window.popbot.*`.

2. **Main — единственный, кто пишет в БД.** Рендерер читает через IPC;
   никогда не трогает `popbot.db`.

3. **AgentHost — единственное, что изменяет status / snippet / tokens Chat
   во время сессии.** Другой код может читать эти поля, но не может писать в
   них, пока для этого чата активна сессия. (Изменения, инициированные
   пользователем, вроде переименования, происходят, когда сессия не активна,
   или ставятся в очередь.)

4. **Бэкенды никогда не пишут в БД.** Они испускают события; AgentHost
   сохраняет. Это сохраняет ClaudeBackend / CodexBackend / StubBackend
   взаимозаменяемыми без переплетения со схемой БД.

5. **PolicyEngine — единственный источник истины для «может ли этот
   инструмент выполниться?»** Ни один бэкенд не обходит его. Разрешения
   проходят через него.

6. **Привязка Slot ↔ Chat временна.** Запись Chat никогда не называет слот.
   Запись Slot называет чат, удерживающий аренду (мягкий указатель, сверяемый
   при запуске).

7. **Стенограмма никогда тихо не изменяется.** Добавляются новые строки;
   одноразовые обновления строк tool/permission явны и ограничены.

---

## Поток состояния — одно сообщение пользователя от начала до конца

Разобранный пример модели в действии.

```text
User types "fix the cooldown flicker" in chat c1 and presses ⌘↵
  │
  ▼
Renderer: api.agent.send({ chatId: 'c1', text })
  │  IPC: pb:agent:send
  ▼
Main · AgentHost.send('c1', text)
  ├─→ DB: appendMessage({ chatId, role: 'user', kind: 'text', body: { text } })
  ├─→ DB: updateChatStatus('c1', 'running', snippet=text.slice(0,140))
  ├─→ webContents.send('pb:agent:event', { type: 'message-start', ..., role: 'user' })
  └─→ session.sendUser(text)            // AgentSession (Claude SDK)
        │
        │  SDK streams events back via the onEvent callback wired at spawn:
        │
        ├─→ { type: 'message-start', role: 'agent', messageId: 'msg_abc' }
        │     ├─→ DB: appendMessage({ id: 'msg_abc', kind: 'text', body: { text: '' } })
        │     └─→ webContents.send → renderer appends an empty agent message bubble
        │
        ├─→ { type: 'text-delta', messageId: 'msg_abc', delta: 'Looking at ' }
        │     ├─→ buffer.append('msg_abc', 'Looking at ')      // in-memory
        │     │     (flush every 250ms or on message-end → DB UPDATE)
        │     └─→ webContents.send → renderer concatenates into the bubble
        │
        ├─→ { type: 'tool-use', messageId: 'msg_abc', toolUseId: 't1',
        │     name: 'unity.run_fixture', args: {...} }
        │     ├─→ PolicyEngine.evaluate('unity.run_fixture', args)  → 'allow' (whitelisted)
        │     ├─→ DB: appendMessage({ id: 'tool_t1', kind: 'tool',
        │     │                        body: { toolUseId, name, args } })
        │     └─→ webContents.send → renderer renders tool row
        │
        ├─→ { type: 'tool-result', toolUseId: 't1',
        │     text: '3/3 ok · 14.2s', isError: false }
        │     ├─→ DB: updateMessageBody('tool_t1', { ...prev, result, isError })
        │     └─→ webContents.send → renderer updates tool row badge
        │
        ├─→ { type: 'permission-request', permissionId: 'p1',
        │     tool: 'git_push', args: { ref: '...' }, reason: 'back up progress' }
        │     ├─→ PolicyEngine.evaluate('git_push', args)   → 'ask'
        │     ├─→ AgentHost.pendingPermissions.set('p1', sdkCallback)
        │     ├─→ DB: appendMessage({ id: 'perm_p1', kind: 'permission',
        │     │                        body: { permissionId, tool, args, reason } })
        │     ├─→ DB: updateChatStatus('c1', 'paused', snippet='needs you: ...')
        │     └─→ webContents.send → renderer shows PermissionModal
        │
        │  ┌─── user clicks "Allow once" in the modal ───────────────────────┐
        │  ▼                                                                  │
        │  Renderer: api.agent.approve({ chatId: 'c1', permissionId: 'p1', │
        │                                 decision: 'allow' })                │
        │   │  IPC: pb:agent:approve                                          │
        │   ▼                                                                  │
        │  Main · AgentHost.approve('c1', 'p1', 'allow')                      │
        │     ├─→ DB: updateMessageBody('perm_p1', { ...prev, decision })     │
        │     ├─→ DB: updateChatStatus('c1', 'running')                       │
        │     ├─→ pendingPermissions.get('p1')(true)   // resolves SDK        │
        │     └─→ webContents.send → renderer dismisses modal                 │
        │
        ├─→ { type: 'message-end', messageId: 'msg_abc' }
        │     ├─→ buffer.flush('msg_abc')      → DB UPDATE final text
        │     └─→ webContents.send → renderer freezes the bubble
        │
        └─→ { type: 'session-status', status: 'idle' }
              ├─→ DB: updateChatStatus('c1', 'idle')
              └─→ webContents.send → renderer thumbnail goes from blue to gray
```

Стоит заметить две вещи:

- **Рендерер никогда ничего не решает.** Он диспетчеризует намерения и
  перерисовывается на основе событий.
- **Записи в БД происходят в том же месте, что и уведомления рендерера.**
  Они связаны одним и тем же обработчиком в AgentHost. Это значит, что
  крах рендерера не может вызвать расхождение персистентности.

---

## Поток восстановления — перезапуск с холодного старта

US-7 в виде кода. Приложение завершается некорректно. Часы спустя пользователь
снова его открывает:

1. **Инициализация БД** — `initDb()` открывает `popbot.db`, запускает
   ожидающие миграции.
2. **Сверка слотов** — обход `~/Library/Application Support/PopBot/slots/`,
   для каждого слота чтение `slot.json`, проверка, что `unityPid` /
   `serverPid` живы (`kill -0`); если мертвы — пометить слот свободным и
   очистить PID. Разрешение любых осиротевших аренд (чат, который не
   существует, или чат, у которого установлен `closedAt`).
3. **Открытые чаты** — `listOpenChats()` возвращает чаты с `closedAt IS
   NULL`, отсортированные по `lastActiveAt DESC`. Рендерер запрашивает их
   при первой отрисовке.
4. **Никакого автоматического порождения агента.** Сессии порождаются лениво
   при первом `agent.send`. Пользователь, открывающий свой старый чат, просто
   видит стенограмму; агент не продолжает с того места, где остановился, пока
   пользователь не подскажет.
5. **Аренда слота по требованию.** Так же — аренда происходит, когда тип чата
   в ней нуждается (Client/Server Test), и вот-вот сработает инструмент,
   требующий Unity.

Результат: открытие приложения быстро (чтение БД + пинг слота), и вы можете
осмотреть историю любого чата, не платя стоимость порождения агента.

---

## Взаимозаменяемость бэкендов

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** оборачивает `@anthropic-ai/claude-agent-sdk`. По умолчанию.
- **CodexBackend** оборачивает `@openai/codex-sdk` (который управляет `codex
  exec`). Поставляется. Каждый бэкенд объявляет свои `capabilities`, и UI
  определяет их по возможностям для каждого чата.
- **StubBackend** отражает текст пользователя фейковым потоком. Используется
  для проверки подключения + UI-тестов.

Поле `agent` записи чата выбирает, какой бэкенд порождает AgentHost.

---

## Что намеренно НЕ входит в модель

- **Workflow / DAG / цепочки одобрения.** Chat — это разговор. Мы не
  моделируем конвейеры.
- **Мультипользовательность.** Один разработчик на машину; без
  аутентификации, без общего доступа.
- **Блокноты / сохранённые запросы / шаблоны.** Всё возникает из стенограммы;
  пока нет полноценного типа первого класса.
- **Версионированные снимки чата / ветвящиеся стенограммы.** Стенограмма
  линейна. Форк чата = создание нового чата, засеянного историей старого
  (будущая функция, пока не в модели).

Если нам понадобится что-то из этого, оно сначала добавляется сюда, потом в
код.
