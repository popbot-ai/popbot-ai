# Arquitectura

Un mapa práctico del modelo de procesos de Electron y dónde vive cada subsistema. Para el "por qué," consulta [POPBOT_DESIGN.md](POPBOT_DESIGN.md). Para el **grafo de objetos + ciclos de vida + reglas de propiedad** de los que depende todo en este documento, consulta [CORE_MODEL.md](CORE_MODEL.md) — léelo primero si algo abajo se siente sin motivación.

## Modelo de procesos

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                         │
│  ─ Slot / worktree lifecycle — git worktrees o shado VHDX slots,    │
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

**Regla:** el renderer nunca toca el sistema de archivos, nunca genera procesos hijos, nunca guarda estado canónico. Todo eso es del proceso main. El renderer se suscribe a eventos y despacha intenciones.

## Estructura del código fuente

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
    ├── domain.ts                # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## Contrato de IPC

Todo el IPC está tipado y centralizado en [`src/shared/ipc.ts`](../../src/shared/ipc.ts) — el mapa de cadenas `IpcChannel`, los tipos de payload de solicitud/respuesta, y la superficie `PopBotApi` que expone el puente de precarga (preload). Convenciones:

- **Prefijo `pb:`** en cada nombre de canal, con namespace por subsistema (`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). Consulta la constante `IpcChannel` para la lista completa.
- **Solicitud/respuesta** usa `ipcRenderer.invoke` + `ipcMain.handle`. Los retornos están tipados. Los handlers se registran por subsistema desde `main/ipc/*` y se conectan en `main/index.ts`.
- **Eventos push** (stream del agente, datos de PTY, notificaciones, progreso de actualización, maximizado de ventana) usan `webContents.send` + `ipcRenderer.on`. El renderer se suscribe; el main empuja.
- **Sin IPC crudo en los componentes.** El script de precarga (`src/preload/index.ts`) expone el puente tipado `window.popbot.*`; el código del renderer pasa por los hooks/buses en `renderer/src/lib/` (`useChats`, `useReviews`, `agentEventBus`, …) en lugar de llamar a `ipcRenderer` directamente.

## El slot, en términos de código

Un slot no es una sola estructura; es un **arriendo numerado** (`slot_id`) más el
worktree/clon en disco al que apunta ese arriendo. El estado del arriendo vive en la
fila del chat (`chats.slot_id`, `chats.worktree_path` en `persistence/`), y el cálculo
de slots libres es una consulta sobre los chats abiertos que mantienen un slot para
el repositorio — el tamaño del pool de un repositorio es `repos.slot_count`.
`shared/domain.ts` lleva el pequeño enum compartido más un registro `Slot` heredado:

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

El arriendo / liberación / reconciliación de slots está repartido entre `git/worktrees.ts`
(worktrees de git), `shado/slots.ts` + `scm/*Provider.ts` (slots de VHDX + configuración
de clon/cliente por SCM), y los handlers `ipc/repos.ts` + `ipc/chats.ts`. Consulta
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--la-unidad-duradera) para la política
de arriendo, y **Continuidad entre slots** abajo para cómo el trabajo de un chat lo
sigue a través de los slots.

## Almacenamiento de slots en caliente: copia en escritura de shado VHDX

Para árboles a escala AAA (depots de videojuegos en Perforce de 0.5–1 TB) un slot no
puede ser un `git worktree` ni un checkout completo — no puedes copiar el depot N
veces, y una sincronización + compilación en frío toma de minutos a horas.
**shado** (CLI de Go empaquetado, repositorio hermano
`github.com/popbot-ai/shado`, invocado vía `main/shado/`) provee el sustrato de
almacenamiento en Windows:

- **Saturar + congelar una base.** `shado create <repoPath>` sincroniza/copia la
  carpeta del repositorio en un VHDX expandible, luego lo congela como **solo
  lectura**. La base contiene el árbol completo *más* el estado derivado en caliente
  (cachés de compilación, `node_modules`, `Intermediate/`, `Saved/`,
  `DerivedDataCache/`, …).
- **Los hijos diferenciales = slots.** Cada slot es un hijo VHDX de copia en escritura
  desde la base congelada (`shado clone create --slot N`), montado vía `Mount-VHD` +
  `Add-PartitionAccessPath` en una **carpeta de punto de montaje** (no una letra de
  unidad, para poder escalar más allá de ~20 slots). Un slot fresco y listo para
  compilar cuesta segundos y unos pocos GB de delta en lugar de una resincronización
  de 1 TB + una compilación en frío. Reiniciar = destruir el hijo + recrear desde la
  base (limpieza instantánea).
- **Disposición.** Los slots viven en el **mismo disco que el repositorio** (el
  modelo de VHDX lo requiere): `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`;
  la base + los diffs + los metadatos de slot bajo `…/workspaces/<repoId>/shado`
  (`SHADO_HOME`). Las rutas se derivan en `main/shado/client.ts`
  (`popbotRootForRepo`, `shadoHomeForRepo`).
- **Elevación.** `shado create` / `clone create` / `remount` / `restore` necesitan
  permisos de administrador; PopBot se ejecuta sin elevación, así que se lanzan a
  través de un solo UAC (`.bat` temporal + `Start-Process -Verb RunAs`). Los clones
  creados con elevación terminan siendo propiedad del grupo de Administradores → git
  recibe `-c safe.directory=*` en cada invocación, y los clientes p4 quedan
  bloqueados al host.
- **Reinicio.** Los montajes VHDX no sobreviven un reinicio (clones desconectados +
  carpetas reparse de punto de montaje rotas). Al arrancar, detectamos los
  repositorios de slot desconectados y mostramos un **modal centrado** ("Reconectar")
  en el que el usuario hace clic — un solo UAC vuelve a montar todos
  (`remountReposElevated`). Consulta `main/shado/base.ts`.

La ruta de git-worktree (`repo.mode = 'slots'` en un repositorio no-shado) todavía
existe para repositorios ordinarios; shado se selecciona por repositorio para el
caso de VHDX/Perforce.

### Configuración de slot por SCM

Un slot es un **clon/cliente independiente**, no un checkout compartido — este es el
hecho clave detrás de la continuidad entre slots de abajo.

- **git** (`scm/gitProvider.ts`): el slot es un clon completo de la base congelada.
  `ensureSlotWorktree` lo aparca en `popbot/slot-N`; `checkoutBranch` crea la rama del
  chat desde la base **más reciente** (`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`), descartando la suciedad heredada de la base mientras
  conserva las cachés en caliente ignoradas por git.
- **perforce** (`p4/*`, `scm/perforceProvider.ts`): cada slot tiene su propio cliente
  p4 `popbot_<repoId>_slot<N>` con raíz en el punto de montaje. La configuración es
  `p4 flush @baseChangelist` (actualización de la have-table de 0 bytes contra la
  base congelada) + `p4 sync` de solo el delta base→cabeza. No hay **`p4
  reconcile`** (un recorrido de árbol de 20 minutos en un depot de videojuego): un
  `fs.watch` por slot registra las rutas cambiadas y el proveedor abre solo esas con
  `p4 edit/add/delete` dirigidos. Las propias escrituras de PopBot (sync/revert/unshelve)
  **pausan** el watcher para que no se vuelvan a abrir.

## Continuidad entre slots: el hogar de la rama / changelist de un chat

**Problema.** Como cada slot es un clon (git) / cliente (perforce) independiente, la
rama o el changelist pendiente de un chat vive **solo en el slot en el que se creó**.
Los chats toman prestados slots de un pool compartido y pueden reabrirse en un slot
*diferente* — donde ese trabajo no existiría. (El antiguo modelo de `git worktree`
no tenía este problema: todos los worktrees compartían un `.git`, así que las ramas
eran centrales.)

**Solución.** Consolidar el trabajo de un chat en un **hogar** independiente del slot
al cerrarse y restaurarlo al reabrirse. Conectado vía
`SourceControlProvider.persistChatOnClose` / `restoreChatOnReopen`, llamado desde los
handlers `ChatsClose` / `ChatsReopen` (`ipc/chats.ts`), reemplazando el antiguo stash
local del slot. Estado persistido en el chat: `chats.p4_shelf_cl` (perforce; git no
necesita ninguno).

- **git → el REPOSITORIO RAÍZ LOCAL.** El hogar es `repo.repoPath` — la carpeta del
  repositorio en disco de la que se clonó cada slot — añadida a cada slot como un
  remoto `root` (`origin` sigue siendo el remoto real de GitHub, para los PRs).
  - *Cierre:* lleva el trabajo sin confirmar como un commit desechable
    `[Soft committed unstaged files]` (a menos que el usuario lo haya descartado),
    luego `git push -f root <branch>`. El repositorio raíz local acumula la rama de
    cada chat (su lista de ramas = el antiguo comportamiento de worktree compartido).
  - *Reapertura:* después del checkout de la base, `git fetch root <branch>` →
    `checkout -f -B branch FETCH_HEAD` → deshacer suavemente el commit de trabajo en
    progreso para que las ediciones vuelvan a estar sin confirmar.
- **perforce → el CLIENTE RAÍZ como un shelf.** Un changelist pendiente es por slot,
  así que el hogar es un **shelf** del lado del servidor, propiedad de un cliente
  estable y nunca sincronizado por repositorio `popbot_<repoId>_root`
  (`ensureRootClient` — solo especificación, sin sync).
  - *Cierre:* `p4 shelve` del CL del slot, luego `p4 reshelve -f` hacia el CL del
    chat propiedad de la raíz. **`reshelve` mueve el contenido en shelf del lado del
    servidor** — verificado en Helix 2025.2: entre clientes, sin sincronización del
    espacio de trabajo, nada escrito al disco de la raíz ("mover shelves, no
    modificar archivos"). Luego elimina el shelf del slot + los archivos abiertos +
    el CL, para que el slot termine **vacío**; el cliente raíz posee un CL en shelf
    por chat.
  - *Reapertura:* `p4 unshelve -s <rootCl> -c <newSlotCl>` en el CL fresco del nuevo
    slot (watcher pausado), manteniendo el shelf raíz como el respaldo aparcado.

En resumen: los slots son espacio de trabajo intercambiable; el repositorio git raíz
local y el cliente p4 raíz son los hogares duraderos y visibles para el usuario del
trabajo en curso.

## Backend del agente

`AgentBackend` (`main/agents/types.ts`) es la interfaz entre `AgentHost` y un backend
concreto. **Dos backends reales se distribuyen hoy** — `ClaudeBackend` (envuelve
`@anthropic-ai/claude-agent-sdk`) y `CodexBackend` (envuelve `@openai/codex-sdk`) —
más un `StubBackend` para pruebas. Un chat elige su backend (`chats.agent`) y puede
cambiar; como los dos SDKs tienen diferentes manejadores nativos de reanudación,
modelo, y configuraciones de esfuerzo, se persisten **delimitados por proveedor**
(`session_id` + `claude_model`/`claude_reasoning_effort` de Claude; `codex_thread_id`
+ `codex_model`/`codex_reasoning_effort` de Codex). `AgentHost` selecciona el
backend, genera una sesión por chat, y retransmite los `AgentEvent`s de cada sesión
al renderer + la persistencia.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

El MCP del editor por slot se le entrega al backend al generarse: `SpawnOpts.mcpServers`
lleva el endpoint del editor de Unity/Unreal del chat (`{ type: 'http', url }`),
registrado en memoria en las opciones del SDK — nada escrito a disco. Solo el
backend con capacidad `mcpHttp` lo consume. Consulta **MCP del editor por slot**
abajo.

El callback `canUseTool` vive junto al backend, no en el prompt del agente — es
nuestro límite de seguridad de veto absoluto. La resolución de reglas (`resolveRule`)
consulta primero las reglas de permiso por chat y luego las globales antes de
preguntar. Consulta [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md).

## Persistencia

- **`better-sqlite3`** en `<userData>/popbot.db` (macOS: `~/Library/Application
  Support/PopBot/`; el equivalente por SO de `app.getPath('userData')` en Windows /
  Linux). El esquema es una lista de migraciones numeradas en `persistence/db.ts`
  (delimitado por `user_version`, cada paso atómico). Tablas actuales:
  - `chats` — una fila por chat: arriendo de slot (`slot_id`), `worktree_path`, `repo_id`,
    `agent` activo, modelo/esfuerzo por proveedor + manejadores de reanudación
    (`session_id`, `codex_thread_id`), `permission_rules`, y estado entre slots
    (`p4_shelf_cl`).
  - `messages` — una fila por evento de agente (la transcripción duradera).
  - `repos` — configuración por repositorio (ruta, color, prefijo de slot, base por
    defecto, conteo de slots, `mode` = `slots`/`ephemeral`, `scm`, JSON de
    `p4_config`).
  - `settings` — preferencias de la aplicación como par clave/valor JSON
    (referencias a credenciales de integración, preferencias de interfaz).
  - `notifications` — el feed de notificaciones dentro de la aplicación.
  - `sdk_session_entries` — tabla de respaldo del SessionStore del SDK de Claude
    (indexada por chat; PopBot posee la copia de recuperación para que la reanudación
    no dependa de los JSONLs de `~/.claude`).
  - `codex_thread_events` — caché duradera de eventos de stream de Codex crudos
    (Codex reanuda desde `~/.codex/sessions`; esta es la propia copia de
    recuperación/diagnóstico de PopBot).

  No hay **ninguna** *tabla* de caché de ticket/PR: las colas de Tickets y Revisiones
  se cachean en el renderer (ver los comentarios de IPC de `list-recent`), no en
  SQLite.
- **El scratch por slot** vive en el worktree/montaje del slot y en los directorios
  de runtime por chat (archivos de sesión del CLI del agente, PTY, adjuntos
  retenidos). Los slots de VHDX de shado viven en el disco del repositorio bajo
  `…/popbot/workspaces/<repoId>/…` (ver la sección de shado).
- **Los secretos** vía `keytar` (llavero del SO — Llavero de macOS / Bóveda de
  Credenciales de Windows / libsecret). Nunca en la base de datos SQLite, nunca en
  los logs.

## Fuentes de tickets, proveedores de SCM, revisiones, editores, actualizaciones

Cinco costuras de proveedor de las que dependen los subsistemas de alto nivel — todas
diseñadas para que añadir un backend sea algo local, y quien las llama se mantenga
genérico:

- **Fuentes de tickets** (`tickets/`). Un `TicketSource` activo alimenta la cola de
  Tickets, elegido por la configuración `ticketSource` vía `tickets/registry.ts`
  (Linear / Jira / GitHub; por defecto Linear). Cada fuente se normaliza a los DTOs
  compartidos de Linear, así que el renderer renderiza todos los rastreadores a
  través de una sola ruta y se ramifica solo según las capacidades en
  `shared/ticketProvider.ts`, nunca según el id del proveedor. Añadir un rastreador
  es una línea en el registro + un `*Source.ts` + un descriptor.
- **Proveedores de SCM** (`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`
  es la pequeña superficie común (ciclo de vida del espacio de trabajo, revisión del
  árbol de trabajo, detección de PR/revisión, continuidad entre slots).
  `GitProvider` y `PerforceProvider` son reales; `lore` está esbozado.
  `scm/index.ts` retorna una instancia por id. **Quien llama se ramifica según
  CAPACIDADES (`shared/sourceControl.ts`), nunca según el id del proveedor** —
  cualquier cosa que no se abstraiga limpiamente es una bandera de capacidad, y un
  proveedor demasiado divergente opta por su propia ventana de cliente vía
  `capabilities.nativeClientUi`.
- **Revisiones** (`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`). Un
  orquestador independiente del proveedor agrupa los repositorios configurados por
  SCM y despacha a los métodos de revisión de cada proveedor (condicionado por
  `capabilities.pullRequests`), fusionando los PRs de GitHub y las revisiones de
  Helix Swarm en un solo panel. Cada proveedor posee su **propia cadencia de
  consulta** (`reviewPollIntervalMs` — Swarm más lento que GitHub para proteger un
  p4d compartido), y el panel ejecuta un temporizador por proveedor
  (`pb:reviews:providers` / `pb:reviews:list-for`).
- **MCP del editor por slot** (`ipc/apps.ts`, `shared/gameEngine.ts`). Los motores
  (Unity / Unreal / personalizado) son habilitables de forma independiente. Cuando
  `useMcp` está activo, el editor de cada slot se lanza con un **puerto MCP por
  slot** (`mcpBasePort + (slotId-1)`) para que los editores en paralelo no colisionen,
  y `mcpEndpointForChat` le entrega al agente la URL HTTP del MCP del editor de ese
  slot al generarse. Los editores se lanzan **desconectados** (enfocar-o-lanzar), no
  como hijos supervisados de larga duración.
- **Actualizaciones** (`updates/`). Auto-actualización de electron-updater con un
  respaldo de descarga manual para compilaciones sin firmar, más una verificación
  bajo demanda para el diálogo Acerca de (`pb:updates:*`).

## Transversal

- **Registro (logging)** — el proceso main escribe logs de diagnóstico vía `diagLog`
  (`dlog`); el CLI del agente y el PTY llevan su propia salida de runtime por chat;
  los logs del renderer se enrutan a través del main vía IPC.
- **Recuperación al arrancar** — la recuperación está impulsada por la base de datos
  y la sesión, no por archivos PID (secuencia de arranque de `main/index.ts`):
  `initDb()` ejecuta las migraciones pendientes; `clearStaleRunningStatuses()`
  cambia cualquier chat que haya quedado en `run` de vuelta a `idle` (la sesión de
  agente de una ejecución anterior ya no existe); la importación del almacén de
  sesiones + la migración del directorio de proyecto del SDK + `sessionPinRepair` +
  `recoverChatSessions` reconcilian las sesiones fijadas de Claude/Codex contra lo
  que realmente está en disco; las verificaciones del CLI reportan qué backends
  están en línea. En Windows, los slots de VHDX de shado desconectados (un reinicio
  eliminó sus montajes) se detectan y se muestran para un solo remontaje con UAC
  (ver la nota **Reinicio** de shado arriba).
- **Actualizaciones** — auto-actualización de electron-updater; consulta el
  proveedor de **Actualizaciones** arriba.
