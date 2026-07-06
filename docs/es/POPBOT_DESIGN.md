# Diseño de PopBot

Un orquestador de desarrollo multi-agente para AutoRPG. Inspirado en
Conductor; añade infraestructura de pruebas dentro del videojuego para que
los agentes puedan lanzar el videojuego real, recorrerlo con clics, y
verificar el comportamiento.

> **Estado:** diseño — fijado el 2026-05-01. Documento vivo; actualízalo en
> el lugar a medida que descubramos cosas durante la implementación.
>
> **Lee esto primero:** [USER_STORIES.md](USER_STORIES.md) define los seis
> resultados que este diseño existe para entregar. Cuando este documento y
> las historias de usuario no coincidan, las historias de usuario ganan y
> este documento se actualiza.

## Objetivos

1. Ejecutar múltiples agentes de desarrollo con IA en paralelo, cada uno en
   su propio worktree de git.
2. Dejar que los agentes manejen el videojuego real (Unity Editor en
   ventana) para pruebas de extremo a extremo.
3. Mostrar las colas de tickets / PRs / Slack, el historial de
   transcripciones, los logs, y las terminales en una sola ventana.
4. Por defecto, operación autónoma; pausar solo en eventos verdaderamente
   bloqueantes.

## No-objetivos (v1)

- CI/CD de producción (preocupación separada)
- Multiplataforma (solo macOS; Linux/Windows más adelante si es necesario)
- Multi-usuario / SSO (un desarrollador por máquina)

## Disposición de la app

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

Pestañas superior-izquierda: **Tickets** (Linear asignados a mí) y
**Reviews** (PRs solicitando mi revisión). Haz clic en una fila → genera un
chat sembrado para ese trabajo.

## Slots — la unidad duradera

Un slot = un worktree de git + su Library + (opcionalmente) su Unity Editor
en ejecución + (opcionalmente) su servidor sidecar en ejecución. **Los
slots se crean rara vez, se reutilizan continuamente.**

### Directorio por slot

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

### Números de costo reales (medidos el 2026-05-01 en AutoRPG)

| Operación | Tiempo |
|---|---|
| `git worktree add` (fresco, 62k archivos, smudge de LFS) | ~23 s |
| Library COW desde master (APFS clonefile) | ~1 s |
| Primer lanzamiento de Unity en un slot (Library en frío) | 1-3 min |
| Acierto pegajoso (Unity ya en ejecución, inactivo) | ~50 ms |
| Arranque en frío (Unity apagado, la rama coincide) | 15-30 s |
| Cambio de rama en un slot existente (delta + recarga de Unity) | 5-15 s |
| Creación total de slot (worktree add + COW + primera importación) | ~1-3 min, **poco frecuente** |

### Presupuesto de disco

~14 GB por slot (8 GB Library + 5.5 GB Assets + scratch). 4 slots = ~55 GB.
El `.git` compartido (~8 GB) se cuenta una sola vez.

### Política de arriendo

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### Unicidad de rama

Git se niega a hacer checkout de la misma rama en dos worktrees. Resuelto
por:
- Los **chats Lite / de revisión** usan HEAD desconectado (sin conflicto).
- **Dos chats de prueba en la misma rama** — el segundo usa una rama
  temporal (`<branch>-slot-N`) o HEAD desconectado; el programador de PopBot
  elige automáticamente.

### Seguridad previa al checkout

Antes de cualquier cambio de rama en un slot existente:

1. `git stash --include-untracked` (siempre; red de seguridad).
2. Se niega si hay commits sin subir que el agente posee; confirma primero
   o falla en voz alta.
3. Cierra cualquier escena abierta de Unity (evita problemas de resolución
   de GUID entre ramas).
4. `git checkout <branch>`.
5. Restaura el stash si aplica, o restaura desde un registro de stash por
   rama.

### Ajustes de política por slot (en preferencias)

- `pinnedBranch?` — se niega a arrendar para otras ramas; slot de trabajo
  primario.
- `cleanOnRelease: bool` — `git clean -fd && git checkout .` al liberarse;
  por defecto apagado.
- `autoStashOnSwitch: bool` — por defecto encendido.

## Presupuestos de recursos (ajustes independientes)

Los slots y las instancias activas de Unity son **presupuestos separados**.
Un slot puede existir con su Unity apagado — en ese punto es solo
almacenamiento. Unity en ejecución está limitado por RAM y es ajustable de
forma independiente.

| Presupuesto | Costo por unidad | Por defecto | Preferencia de usuario |
|---|---|---|---|
| **Conteo de slots** (worktrees en disco) | ~14 GB | 2-4 | Preferencias: "Slots" |
| **Máximo de Unity activos** (procesos en ejecución) | ~3-4 GB RAM | 2 | Preferencias: "Max active Unity" |
| **Techo duro de Unity** (límite de auto-aprobación en modo autónomo) | — | calculado: `floor(systemRAM / 4 GB)` | Preferencias: "Unity hard cap" |

### Política de arriendo (extendida)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### Ajuste iniciado por el agente

Nueva herramienta MCP, disponible cuando el agente está bloqueado por
capacidad de Unity:

| Herramienta | Modo | Retorna |
|---|---|---|
| `request_unity_capacity` | sync | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

Comportamiento:

- **Chat interactivo** → el chat se pone amarillo, un banner le pide al
  usuario que apruebe.
- **Chat autónomo** → auto-aprueba hasta el `Unity hard cap`; se pausa para
  un humano por encima de eso.
- El usuario también puede ajustar hacia arriba/abajo preventivamente en
  preferencias en cualquier momento. Ajustar hacia abajo expulsa las
  instancias de Unity inactivas por LRU (nunca las ocupadas).

## Tipos de chat

| Tipo | Slot | Library | Unity | Sidecar | Arranque | RAM |
|---|---|---|---|---|---|---|
| **Lite** (revisión, planificación, clasificación) | opcional | — | — | — | ~1-2 s | ~50-100 MB |
| **Client Test** | requerido | propiedad del slot | GUI en pantalla 2 | local o remoto | 50ms-30s | ~2-4 GB |
| **Server Test** | requerido | propiedad del slot | GUI en pantalla 2 | siempre local | 50ms-35s | ~2-5 GB |

Por defecto para chats nuevos: **Lite**. Se promueve cuando realmente se
necesitan pruebas del videojuego.

## Modos de servidor

Configuración por chat; alternable sobre la marcha.

| Modo | Fuente del servidor | Usar cuando |
|---|---|---|
| `local` (por defecto) | `./run_local.sh --port <P> --data-dir <D>` por slot | Ejecuciones de agente cotidianas; cambios de backend; estado determinista |
| `remote-dev` | Servidor de desarrollo remoto compartido | Iteración pura del cliente; la detección de desviación protege la entrada |

### Detección de desviación

Antes de aceptar un arriendo remote-dev: PopBot lee localmente la constante
`Assets/Scripts/Simulation/GameDataHash.cs` + la versión de DTO; hace un GET
a `/health` en remoto; compara. Discrepancia → rechaza el arriendo con un
error estructurado.

### `/health` retorna

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### Alternancia a mitad de sesión

El usuario cambia `Server Mode` en la configuración del chat; PopBot:

1. Verificación de desviación (si entra a remote-dev). Rechaza en caso de
   discrepancia.
2. Detiene / inicia el proceso sidecar según sea necesario.
3. `client_set_server_endpoint { url }` vía MCP — redirección en tiempo de
   ejecución.
4. Fuerza un reinicio de sesión dentro del videojuego (logout/título) — la
   autenticación anterior queda inválida.
5. Cancela los trabajos en curso, banner: "el servidor cambió, reinicia la
   tarea."

## Panel de configuración por chat

| Ajuste | Por defecto | Notas |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = auto-aprueba lo seguro, se pausa cuando está realmente atascado |
| Server mode | `local` | `remote-dev` (verificado por desviación) |
| Window mode | `GUI on screen 2` | `Headless` (más adelante, opt-in) / `Visible` |
| Time scale | `1.0` | Animaciones en avance rápido |
| Game view resolution | `1920×1080` | Fijada para capturas de pantalla reproducibles |
| Auto-screenshot every action | apagado | Para paquetes de prueba |
| Verbose logs | apagado | Alternar al depurar al propio agente |
| Agent backend | `claude` | `codex` (Fase 4) |
| Default fixture | ninguno | Arrancar con un blob de guardado |
| Token budget | `1M` | Se pausa al alcanzarlo (modo autónomo) |
| Time budget | `60m` | Se pausa al alcanzarlo (modo autónomo) |
| Loop detection | encendido | Se pausa en N llamadas idénticas a herramienta / sin progreso por K min |

## Modo autónomo

### Motor de políticas — conectado a `canUseTool`

No entierres la política en el prompt; el modelo puede convencerse de
saltársela. Usa el hook de veto absoluto del SDK.

**Auto-aprobar en modo autónomo (silencioso):**

- Read / Edit / Write / Grep / Glob dentro del worktree del slot
- Bash dentro del worktree (con la lista de denegación de abajo)
- Llamadas MCP al propio servidor MCP del slot
- Invocaciones de Skill / sub-agente
- TodoWrite, operaciones internas del SDK

**Siempre pausar para un humano (incluso autónomo):**

- `git push`, `git reset --hard`, `git checkout --`, cualquier cosa forzada,
  eliminación de rama
- Cualquier cosa fuera de la ruta del worktree del slot
- Llamadas de red a hosts no autorizados
- `rm -rf` fuera de `tmp/` o el directorio del slot
- `gh pr create` y cualquier acción de publicación en GitHub
- Mensajería externa por Slack / correo
- Modificar `~/.claude`, `.mcp.json`, configuración del sistema

### Detección de "realmente atascado"

**Auto-reporte del agente** (vía la forma `message_done` del SDK):

- Pregunta aclaratoria
- Bloqueador explícito
- "Terminé" terminal

**PopBot vigila** (defensa en profundidad):

- Bucle — N llamadas idénticas a herramienta seguidas
- Estancamiento — sin evento de progreso por K minutos
- Presupuesto de tokens / tiempo excedido
- Fallos de prueba repetidos (mismo fallo K veces)

### Colores de estado (miniatura de chat)

| Color | Estado |
|---|---|
| Azul | En ejecución |
| Verde | Tarea completa |
| Amarillo | Pausado — necesita al usuario |
| Rojo | Con error |
| Gris | Inactivo / no iniciado |

En modo autónomo, escaneas las miniaturas en busca de **amarillo**. Todo lo
demás está bien.

## Superficie de automatización MCP

### Regla: cada herramienta retorna en ~100 ms

Las operaciones largas retornan `{ jobId }` de inmediato; el agente
consulta. Nunca bloquear el listener HTTP de MCP por más de 100 ms.

### Infraestructura de trabajos (jobs)

| Herramienta | Modo | Retorna |
|---|---|---|
| `job_status` | sync | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | sync | payload completo de la herramienta; descarta el job |
| `job_cancel` | sync | establece la bandera de cancelación cooperativa |
| `job_list` | sync | activos + recientes (TTL ~60s) |

Las corrutinas se ejecutan vía `EditorCoroutineUtility.StartCoroutineOwnerless`,
impulsadas por `EditorApplication.update`. `JobContext` expone
`SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)`.

### Catálogo de herramientas — mínimo de Fase 1

**Ciclo de vida:**

- `play_status` (sync), `play_pause` / `play_resume` / `play_step` (sync),
  `time_scale_set` (sync)
- `play_enter` (job), `play_exit` (sync)
- `editor_quit` (sync)

**Observar:**

- `screenshot` (sync) — escribe en
  `Library/MCP/Screenshots/{session}/{label}.png`, retorna la ruta
- `game_state_summary` (sync) — tope de la pila de pantallas, monedas,
  nivel, capítulo, equipado, desbloqueos, últimos 10 errores
- `screen_stack` (sync), `chapter_status` (sync)
- `ui_tree` (sync) — jerarquía con `text-loc` resuelto
- `ui_query` (sync) — selectores tipo CSS (`.btn`, `#Confirm`,
  `[text-loc=Friends.Title]`)

**Actuar:**

- `ui_click` (sync), `ui_click_by_loc` (sync) — dispara
  `PointerDown/Up/ClickEvent` vía `panel.SendEvent`

**Sincronización / espera:**

- `wait_until` (job) — predicados: `screen`, `log`, `event`, `path`
- `wait_for_idle` (job)

**Logs (extender los existentes):**

- `console_get_logs` — añadir `sinceTimestamp`, `dedupe`, `dumpTo`,
  `includeStack: "none"|"first"|"all"`
- `server_logs` (sync) — sigue el `server.log` de PopBot, misma forma que
  `console_get_logs`
- `server_health` (sync), `client_set_server_endpoint` (sync)

**Sesiones:**

- `mcp_session_start` / `mcp_session_end` — directorios de artefactos
  predecibles en `tmp/mcp-sessions/{slug}/`

### Catálogo de herramientas — fases posteriores

- `command_apply`, `command_list` — superficie de acción primaria que evade
  la interfaz
- `save_blob_get` / `save_blob_load`, gestión de fixtures
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`,
  `gameview_resolution_set`
- `game_state_path` — lector basado en reflexión con raíces en lista blanca

## Gestión de ventanas

Por defecto: Editor GUI con la ventana colocada por un helper nativo.

**Movedor de ventanas nativo de macOS (~50 LOC en Swift):**

1. Sondeo ajustado de `AXUIElement` (50 ms) para que el helper agarre la
   ventana dentro de ~100 ms de su aparición.
2. `setFrame:` a un rectángulo configurado en la pantalla 2.
3. `kAXMinimizedAttribute = true` (baja al dock).
4. No robar el foco.

**Pre-establecer `EditorPrefs` para la posición de ventana antes de
lanzar.** Unity restaura la última posición de ventana al arrancar, así que
desde el *segundo* lanzamiento en adelante se abre ya posicionado. El
primer lanzamiento parpadea brevemente (~200 ms); los lanzamientos
subsiguientes no.

**Configuración única del usuario** (documentada en el primer arranque de
PopBot): `Dock → clic derecho en Unity → Options → Assign To: Desktop X`.
macOS enruta automáticamente las futuras ventanas de Unity a ese Espacio.
Con esto establecido, incluso el parpadeo del primer lanzamiento ocurre en
un Espacio que el usuario no está mirando.

Posición configurable por slot para que múltiples Unitys aterricen en
lugares predecibles en la pantalla 2.

**`Window Mode` sin cabeza (headless)** es opt-in después de que la
validación de batchmode pase (más o menos Fase 4). Arquitectura idéntica;
solo cambia la bandera de lanzamiento.

## Protocolo de emparejamiento Servidor / Unity

El orden de arranque y el ciclo de vida tienen que ser precisos o te
encuentras con fallos sutiles.

### Secuencia de arranque (impuesta por PopBot)

1. Genera `./run_local.sh --port S --data-dir D`. Redirige stdio a
   `server.log`. Registra `server_pid`.
2. Consulta `/health` hasta obtener 200 (con
   `commit/gameDataHash/dtoVersion`). Tiempo de espera 30 s. Fallo → mata el
   servidor, muestra el error.
3. Escribe `client-server.json` en el worktree apuntando a `localhost:S`.
4. Genera Unity con `POPBOT_MCP_PORT=M`. Registra `unity_pid`.
5. Consulta `/mcp` hasta obtener 200. Tiempo de espera 60 s. Fallo → mata a
   ambos, muestra el error.
6. Se ejecuta el movedor de ventanas nativo.
7. El slot está activo; el agente puede arrendarlo.

### Cascada de fallo

- **El servidor muere a mitad de sesión** → PopBot lo detecta vía liveness
  de PID + 5xx de `server_health` → marca el slot como degradado → intenta
  un reinicio del servidor → si eso falla, lo muestra en el chat como rojo.
- **Unity muere** → el servidor sigue corriendo (el servidor sobrevive a los
  reinicios de Unity; más barato). PopBot puede generar un Unity fresco
  contra el mismo servidor.
- **Liberación del slot** → SIGTERM al servidor (5 s de gracia) → SIGKILL →
  llamada MCP `editor_quit` a Unity → SIGTERM (5 s de gracia) → SIGKILL.

### Reconciliación al arrancar PopBot

Escanea los archivos slot.json; para cada pid registrado, `kill -0 <pid>`;
si está muerto, limpia el estado y reinicia el slot. Higiene estándar de
procesos huérfanos.

## Integración de agentes

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

Lo que obtenemos gratis: skills, memoria, sub-agentes, hooks, MCP,
solicitudes de permiso como eventos estructurados. **No hagas
subprocess-scraping del CLI `claude`** — pelea con el SDK por cada
funcionalidad avanzada.

### Interfaz AgentBackend (definida desde el día uno; una implementación en v1)

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

El backend de Codex (Fase 4) adapta el OpenAI Agents SDK a esta interfaz.
Skills/memoria no disponibles; la interfaz lo marca claramente.

### Configuración MCP por chat

Cada agente se genera con `mcpServers` inyectado para los puertos **de su
propio slot** — la URL de `popbot-unity` = `localhost:<slot.mcpPort>/mcp`.
Otros MCPs (Linear, Sentry, Amplitude, BetterStack) se heredan de
`~/.claude/settings.json` o `.mcp.json` automáticamente por el SDK.

## Stack tecnológico

- **Electron** (Node + Chromium)
- **React + Tailwind** para la interfaz
- **xterm.js + node-pty** para el panel de terminal
- **better-sqlite3** para la persistencia de transcripciones (una fila por
  evento, indexada por chat + timestamp)
- **keytar** para tokens de OAuth / claves de API / credenciales de agente
- **API GraphQL de Linear** para el panel de tickets
- **GraphQL de `gh`** para el panel de PRs sin revisar
- **Helper nativo de Swift** para la colocación de ventanas

## Fases

### Fase 0 — Prerrequisitos (~3 días)

| Elemento | Dueño | Tamaño |
|---|---|---|
| Anulación de variable de entorno `POPBOT_MCP_PORT` en MCP | Unity MCP | 5 min |
| Argumentos `./run_local.sh --port` + `--data-dir` | server | 30 min |
| `/health` retorna `commit`, `gameDataHash`, `dtoVersion` | server | 30 min |
| Helper nativo de movedor de ventanas para macOS (Swift) | PopBot | ~½ día |
| Prototipo de ciclo de vida de slot (worktree add, Library COW, cambio de rama, seguridad de stash) | PopBot | ~1 día |

### Fase 1 — Superficie de automatización MCP (~3-5 días)

Infraestructura de jobs + el catálogo de herramientas de la Fase 1 de
arriba. Migrar las herramientas largas existentes (`rebuild_gamedata`,
`rebuild_dtos`, `addressables_build`, `addressables_clean`) al modelo de
job.

### Fase 2 — MVP de PopBot Electron (~1-2 semanas)

Una sola columna de chat, solo `ClaudeBackend`, un solo slot, un solo Unity.
Esqueleto del panel de configuración. Motor de políticas `canUseTool`.
Helper nativo integrado. Bucle de extremo a extremo: abrir chat → el agente
edita código → el agente ejecuta el videojuego → el agente verifica vía
capturas de pantalla + logs → terminado.

### Fase 3 — Multi-chat + paneles (~1 semana)

Múltiples columnas de chat (añadir/quitar con +/x flotantes). Franja de
miniaturas con colores de estado. Paneles de tickets de Linear + PRs sin
revisar. Panel de logs inferior con pestañas de Unity/servidor una junto a
otra. Alternancias de modo/modo-servidor en la configuración del chat.

### Fase 4 — Pulido + avanzado

Adaptador de backend de Codex. `Window Mode` sin cabeza (después de la
validación de batchmode). `crash_dump`, `events_pop`, `command_apply`,
gestión de fixtures. Correlación de tiempo de logs uno junto al otro.
Refinamiento de presupuestos de autonomía y detección de bucles.

## Preguntas abiertas

1. **Validación de batchmode** — ¿AutoRPG realmente corre en modo Play con
   `-batchmode`? Script de validación más o menos en la Fase 4; no bloquea
   la v1.
2. **Cadencia de actualización de Library maestra** — ¿botón manual vs.
   automático vs. TTL de N días? Por defecto: botón manual en preferencias.
3. **Conteo de slots por defecto** — ¿4 fijo, o escala según RAM/núcleos?
   Probablemente por defecto 2-3, configurable.
4. **Repositorio de PopBot** — ¿separado de `autorpg`, o vive en
   `tools/popbot/`? Separado cuando se estabilice; en el mismo árbol
   durante el desarrollo temprano.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| `git checkout` corrompe un slot a mitad de stash | Siempre stash primero; verificar limpio después del checkout; negarse si está sucio |
| Dos instancias de PopBot pisan el mismo slot | Archivo de bloqueo por directorio de slot; reconciliar huérfanos al arrancar |
| Unity se cuelga y el arriendo del slot nunca se libera | Verificación de liveness de PID + recolección de basura al arrancar PopBot |
| Conflictos de bloqueo de LFS entre worktrees | Raro; mostrar claramente cuando suceda |
| La Library del slot se desvía mucho de master | "Reset slot" manual la reconstruye desde master |
| El disco se llena | Mostrar el tamaño por slot en preferencias; "reset" recupera espacio |
| Desviación de backend en remote-dev a mitad de sesión | Reverificación de `server_health` en errores; banner + detención |
| El modo autónomo auto-aprueba algo inseguro | Lista de denegación fija en el código en `canUseTool`; nunca anulable por la configuración del chat |

## Artefactos de prueba (entregable de depuración del agente)

Cuando un agente completa una tarea de depuración, escribe en
`tmp/mcp-sessions/{slug}/`:

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` sigue una plantilla de 6 secciones (Repro / Before / Root Cause /
Fix / After / Verification). La convención está documentada en una SKILL
(`agent-debug`); el MCP solo provee rutas de sesión predecibles.

## Referencia rápida — qué cambió respecto a propuestas anteriores

Para cualquiera que lea la conversación que produjo este documento:

- El pool de Library / pool de procesos / pool de worktrees **colapsaron en
  un solo concepto: el slot.** El slot posee su worktree, su Library, su
  Unity opcional, su sidecar opcional. Sin symlinks, sin pools separados.
- `git worktree add` toma **~23s en AutoRPG** (smudge de LFS sobre 62k
  archivos), no 1-2s. La creación de slot es poco frecuente; la reutilización
  vía checkout es la ruta caliente cotidiana.
- **GUI Editor en la pantalla 2** es el por defecto de v1. El batchmode sin
  cabeza es opt-in en la Fase 4.
- El servidor corre en el mismo árbol vía `./run_local.sh`; puerto + data-dir
  por slot para aislamiento.
- Integración de agente: **Claude Agent SDK primero**, interfaz
  AgentBackend, Codex en la Fase 4.
