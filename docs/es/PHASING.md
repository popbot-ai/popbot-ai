*Languages: [English](../PHASING.md) · **Español** · [Français](../fr/PHASING.md) · [Deutsch](../de/PHASING.md) · [日本語](../ja/PHASING.md) · [한국어](../ko/PHASING.md) · [简体中文](../zh-CN/PHASING.md) · [Português (Brasil)](../pt-BR/PHASING.md) · [Русский](../ru/PHASING.md) · [Italiano](../it/PHASING.md)*

# Fases

Hoja de ruta para llevar a PopBot de "diseño + prototipo" a "herramienta
diaria útil." Refleja las fases en [POPBOT_DESIGN.md](POPBOT_DESIGN.md#fases)
pero rastrea el progreso concreto con casillas de verificación.

Actualiza este archivo a medida que aterricen los elementos. Un commit
puede marcar varias casillas.

---

## Fase 0 — Prerrequisitos (~3 días)

Piezas fundacionales en el repositorio de AutoRPG + un helper nativo aquí.
La mayoría de estos bloquean las pruebas reales de extremo a extremo pero no
el scaffold de Electron.

### En `~/pop/autorpg`

- [ ] **Anulación de la variable de entorno `POPBOT_MCP_PORT`** en el
  servidor MCP dentro del Editor (`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`).
  Lee el puerto desde el entorno, recae en `17893`. ~5 min.
- [ ] **Banderas `./run_local.sh --port` + `--data-dir`.** El servidor toma
  ambas como argumentos; el directorio de datos es para el aislamiento de
  base de datos por slot. ~30 min.
- [ ] **Extensión del endpoint `/health`** — retornar
  `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }`. PopBot usa esto
  para la detección de desviación al momento del arriendo. ~30 min.

### En este repositorio

- [ ] **Helper nativo de movedor de ventanas para macOS** — CLI de Swift en
  `native/popbot-windowmover/`. Subcomandos: `move`, `minimize`,
  `wait-for-window`. ~½ día.
- [ ] **Prototipo de ciclo de vida de slot** — módulo TS independiente bajo
  `src/main/slots/` ejercitado por un script bajo `scripts/`. Cubre
  worktree add, Library COW desde master, cambio de rama con seguridad de
  stash, arriendo/liberación, reconciliación de huérfanos. ~1 día.

---

## Fase 1 — Superficie de automatización MCP (~3-5 días)

En `~/pop/autorpg`. Construye las herramientas MCP dentro del Editor que
los agentes realmente usarán.

- [ ] **Infraestructura de jobs** — `job_status`, `job_get_result`,
  `job_cancel`, `job_list`. Todas las herramientas de larga duración
  retornan `{ jobId }` de inmediato.
- [ ] **Herramientas de ciclo de vida** — `play_status`, `play_enter`
  (job), `play_exit`, `play_pause/resume/step`, `time_scale_set`,
  `editor_quit`.
- [ ] **Herramientas de observación** — `screenshot`, `game_state_summary`,
  `screen_stack`, `chapter_status`, `ui_tree`, `ui_query`.
- [ ] **Herramientas de acción** — `ui_click`, `ui_click_by_loc`.
- [ ] **Herramientas de sincronización** — `wait_until` (job),
  `wait_for_idle` (job).
- [ ] **Herramientas de logs / servidor** — `console_get_logs` extendido
  (`sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack`), `server_logs`,
  `server_health`, `client_set_server_endpoint`.
- [ ] **Sesiones** — `mcp_session_start`, `mcp_session_end` para
  directorios de artefactos predecibles.
- [ ] **Migrar las herramientas largas existentes** al modelo de job:
  `rebuild_gamedata`, `rebuild_dtos`, `addressables_build`,
  `addressables_clean`.

---

## Fase 2 — MVP de PopBot Electron (~1-2 semanas)

Utilizable de extremo a extremo para un solo chat. **En progreso.**

- [ ] **Scaffold de Electron** — `package.json`, Vite + React + TS +
  Tailwind, electron-builder, ESLint + Prettier, Vitest.
- [ ] **División main / preload / renderer** con puente IPC tipado.
- [ ] **Portar los 8 JSXs del prototipo** a `.tsx` bajo `src/renderer/`. La
  interfaz estática corre en la ventana de Electron sin respaldo
  funcional.
- [ ] **Esquema de better-sqlite3** — chats, messages, slots, prefs.
- [ ] **Una sola sesión ClaudeBackend** conectada a una columna de chat.
  Enviar mensaje, recibir stream de eventos.
- [ ] **Motor de políticas `canUseTool`** — lista de denegación fija en el
  código + permiso por modo. El renderer muestra las solicitudes de
  permiso como modales.
- [ ] **Gestor de slots** conectado — un slot, un worktree real, un
  lanzamiento real de Unity vía el helper de la Fase 0.
- [ ] **Integración del movedor de ventanas nativo** — Unity se abre, el
  helper lo coloca en la pantalla 2.
- [ ] **Esqueleto del panel de configuración** — modo por chat, modo de
  servidor, escala de tiempo, backend de agente.
- [ ] **Demo de bucle de extremo a extremo** — abrir chat → el agente lee
  código → el agente ejecuta el videojuego → el agente toma capturas de
  pantalla → el agente reporta.

---

## Fase 3 — Multi-chat + paneles de cola de atención (~1-2 semanas)

Habilita [US-1](USER_STORIES.md#us-1--conciencia-de-la-cola-de-atención),
[US-2](USER_STORIES.md#us-2--activación-de-un-clic),
[US-5](USER_STORIES.md#us-5--multitarea-fácil-vía-miniaturas),
[US-6](USER_STORIES.md#us-6--estado-de-un-vistazo).

- [ ] Múltiples columnas de chat; añadir/quitar flotante.
- [ ] Franja de miniaturas con colores de estado (US-5, US-6).
- [ ] **Panel de tickets de Linear** (asignados a mí, clasificados por
  prioridad + fecha límite).
- [ ] **Panel de PRs sin revisar** (GraphQL de `gh`).
- [ ] **Panel de Slack** — DMs, @menciones, canales administrados.
  Subsistema completamente nuevo (`src/main/slack/`); OAuth vía `keytar`.
  Consulta [USER_STORIES.md → Desviaciones](USER_STORIES.md#desviaciones-y-adiciones).
- [ ] **Generación de chat de un clic** desde cualquier fila de panel; chat
  sembrado con el contexto de la fuente (US-2).
- [ ] Panel de logs inferior — pestañas de Unity + servidor,
  desplazamiento sincronizado para el chat activo.
- [ ] Alternancias de modo + modo-servidor en la configuración del chat,
  con redirección a mitad de sesión.
- [ ] Detección de desviación en el arriendo `remote-dev`.

---

## Fase 4 — Pulido + avanzado

- [ ] **Adaptador de backend de Codex** — `CodexBackend implements
  AgentBackend`, capacidades marcadas en la interfaz.
- [ ] **`Window Mode` sin cabeza (headless)** — opt-in después de que un
  script de validación de batchmode demuestre que funciona en AutoRPG.
- [ ] Herramientas MCP de **`crash_dump`, `events_pop`, `command_apply`,
  gestión de fixtures**.
- [ ] **Correlación de tiempo de logs uno junto al otro** entre los
  paneles de Unity y servidor.
- [ ] **Presupuestos de autonomía + detección de bucles** refinados
  (disparadores de pausa por token / tiempo / fallo repetido).
- [ ] **Canal de actualización** — auto-actualizador vía electron-builder +
  compilaciones firmadas.

---

## Preguntas abiertas (heredadas del diseño)

1. ¿AutoRPG realmente corre en modo Play con `-batchmode`? Script de
   validación más o menos en la Fase 4; no bloquea la v1.
2. Cadencia de actualización de Library maestra — ¿botón manual vs.
   automático vs. TTL de N días? Por defecto: botón manual en preferencias.
3. Conteo de slots por defecto — ¿4 fijo, o escala según RAM/núcleos?
   Probablemente por defecto 2-3, configurable.
