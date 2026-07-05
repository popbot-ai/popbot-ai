*Languages: [English](../CORE_MODEL.md) · **Español** · [Français](../fr/CORE_MODEL.md) · [Deutsch](../de/CORE_MODEL.md) · [日本語](../ja/CORE_MODEL.md) · [한국어](../ko/CORE_MODEL.md) · [简体中文](../zh-CN/CORE_MODEL.md) · [Português (Brasil)](../pt-BR/CORE_MODEL.md) · [Русский](../ru/CORE_MODEL.md) · [Italiano](../it/CORE_MODEL.md)*

# Modelo Central

El grafo de objetos alrededor del cual se construye la aplicación de PopBot.
Todo lo demás — IPC, persistencia, paneles de la interfaz, el bucle del agente —
depende de esto. Si cambias el comportamiento de una forma que viola una regla
de aquí, **o actualiza el modelo primero, o dile al usuario que el modelo está
cambiando.**

Para "¿dónde vive el código?" consulta [ARCHITECTURE.md](ARCHITECTURE.md).
Para "¿qué ve el usuario?" consulta [USER_STORIES.md](USER_STORIES.md).

---

## Resumen — los cuatro sustantivos que importan

| Sustantivo | ¿Duradero? | Dueño | Vida útil |
|---|---|---|---|
| **Chat** | sí (SQLite) | main | creado por el usuario, vive hasta que se elimina explícitamente |
| **Message** | sí (SQLite, casi de solo-anexar) | main | hijo de Chat |
| **Slot** | sí (sistema de archivos + fila SQLite) | main / `SlotManager` | se crea rara vez, se reutiliza; nunca por chat |
| **AgentSession** | **no** (solo en memoria) | main / `AgentHost` | se genera cuando un Chat pasa a "en ejecución"; se destruye cuando el Chat se cierra o la aplicación termina |

Todo en el renderer es una **vista** sobre estos. El renderer nunca posee
estado canónico.

---

## Sustantivos duraderos (sobreviven al reinicio)

### Chat

La unidad de trabajo del usuario. Un ticket, una revisión de PR, un hilo de
Slack, una sesión de "explorar el código base" — cada uno es un Chat.

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

**Ciclo de vida del estado** (US-6 — lo que colorea la miniatura):

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

**El estado es descriptivo, no prescriptivo** — se deriva del AgentSession
cuando hay uno conectado, y se persiste en la base de datos en cada
transición. Que un chat esté `idle` significa "ningún agente haciendo trabajo
ahora mismo." No significa "el chat está cerrado."

**Abierto vs. cerrado:** un chat está "abierto" si y solo si `closedAt IS
NULL`. Los chats abiertos se cargan en memoria al arrancar; los chats
cerrados son de solo consulta. **Cerrar un chat libera su arriendo de slot +
destruye su AgentSession pero nunca elimina los Messages.**

### Message

Un registro de eventos casi de solo-anexar dentro de un Chat. La
transcripción es una secuencia de registros tipados:

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

**¿Por qué JSON en `body`?** Cada tipo (`kind`) tiene una forma de payload
diferente (texto vs. llamada a herramienta vs. solicitud de permiso) y el
renderer despacha según `kind`. Almacenarlo como un blob JSON tipado mantiene
la tabla plana y el código del renderer honesto.

**"Casi de solo-anexar":** las filas `tool` y `permission` se mutan **una
vez**:

- Filas `tool`: se escriben en `tool-use` (nombre + args), se actualizan en
  `tool-result` (rellena `result` + `isError`).
- Filas `permission`: se escriben en `permission-request` (herramienta + args
  + razón), se actualizan en la decisión del usuario (establece `decision`).
- Filas `text`: se escriben en `message-start` con texto vacío, se
  **coalescen** en un pequeño buffer en memoria a medida que llegan eventos
  `text-delta`, y se vuelcan en `message-end` (y cada ~250 ms para mantener
  al renderer en vivo). Una fila por "turno de prosa del agente," no una fila
  por delta.

**Sin eliminaciones en cascada al revertir el trabajo del agente.** Si un
agente comete un error y quieres que "lo intente de nuevo," envías un nuevo
mensaje de usuario. La transcripción anterior permanece. El modelo nunca
reescribe el historial silenciosamente.

### Slot

Un espacio de trabajo en caliente, aislado y desechable: un checkout aislado
sobre una carpeta de copia en escritura (un worktree de Git, o un cliente de
Perforce) + una caché de compilación en caliente (por ejemplo, la caché de
assets/importación de un motor) + (opcionalmente) un editor en ejecución para
la aplicación bajo prueba (Unity, Unreal, o un motor personalizado) +
(opcionalmente) un servidor sidecar en ejecución. **Se crea rara vez, se
reutiliza continuamente.** Los slots son propiedad del usuario / de la
aplicación, no de los Chats.

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

**El vínculo Slot ↔ Chat** es **transitorio** — vive en `slot.leasedByChatId`
y en los metadatos de runtime del Chat correspondiente. Al arrancar,
reconciliamos esto recorriendo los slots y comparándolos con los chats
abiertos. Los arriendos obsoletos (chat cerrado, arriendo nunca liberado) se
recolectan.

Para el ciclo de vida completo del slot, consulta [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--la-unidad-duradera).

### Concesión de permiso

Una decisión duradera del usuario de que cierta combinación de
herramienta/objetivo está aprobada sin volver a preguntar. Dos ámbitos:

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

`tool` puede ser un comodín final con `*`, así que un servidor MCP completo se
puede permitir con una sola concesión (`allow-mcp-server` →
`mcp__<server>__*`) — así es como el MCP del editor de un slot se permite una
sola vez en lugar de una vez por herramienta. Las reglas de denegación
siempre ganan sobre las de permiso, y un patrón más específico gana sobre uno
más general (consulta `resolvePermissionRules` en `src/shared/agent.ts`).

Las concesiones se acumulan por chat (US-9: "permitir siempre git push para
este chat"). Las **reglas de denegación** fijas en el código en
[adr/0004](../adr/0004-canusetool-policy-boundary.md) no se almacenan aquí — viven
en el código y no se pueden anular.

### Settings (Configuración)

Dos capas:

- **Preferencias globales**: tema, tipo de chat por defecto, conteo de slots,
  cadencia de actualización maestra de Library, etc. Tabla de una sola fila.
- **Sobrescrituras por chat**: modo de servidor, escala de tiempo, modo de
  ventana, presupuesto de tokens, etc. Almacenadas en una tabla
  `chat_settings` indexada por `chatId`.

Cualquiera puede estar vacía (se aplican los valores por defecto). Se mutan
vía los paneles de Configuración en el renderer.

### Elementos de atención en caché

Las colas del usuario de tickets asignados (Linear / Jira / GitHub Issues) y
revisiones pendientes (PRs de GitHub / changelists de Helix Swarm). Se
cachean localmente para que los paneles se rendericen al instante; se
refrescan según un programa + bajo demanda.

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

Las fuentes de tickets son intercambiables detrás de un proveedor común
(Linear, Jira, GitHub Issues); las fuentes de revisión de igual manera
(PRs de GitHub, Swarm). En caché, no autoritativas — la fuente de verdad es
el propio rastreador / sistema de revisión.

---

## Sustantivos de runtime (en memoria; no sobreviven al reinicio)

### AgentSession

La cosa que habla con el LLM. Un AgentSession por Chat "en ejecución."
Respaldado por un `AgentBackend` (el Claude Agent SDK o el Codex SDK; ambos
se distribuyen hoy).

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**Propiedad de `AgentHost`** (un singleton en el proceso main). AgentHost
mantiene un `Map<chatId, AgentSession>`. Las sesiones se crean de forma
diferida en el primer `agent.send` para un chat y se destruyen cuando el chat
se cierra.

**Las sesiones emiten `AgentEvent`s** (consulta `src/shared/agent.ts`).
AgentHost intercepta cada evento y:

1. Lo **persiste** (los deltas se coalescen en una fila de texto; el uso de
   herramienta crea una fila de herramienta; la solicitud de permiso crea una
   fila de permiso).
2. Lo **retransmite** al renderer vía `webContents.send`. El renderer es uno
   de N suscriptores; el main es el registrador autoritativo.
3. **Actualiza los metadatos del Chat** — `status`, `snippet`, `tokensUsed`,
   `lastActiveAt` se hacen avanzar a medida que llegan los eventos.

**Las sesiones nunca escriben directamente a la base de datos.** Solo
AgentHost lo hace. Esto mantiene la evolución del esquema de persistencia
desacoplada de los cambios de backend.

### Solicitud de permiso (en curso)

Cuando se dispara el callback `canUseTool` del SDK:

1. PolicyEngine evalúa: permiso automático fijo (auto), denegación automática
   fija (auto), o preguntar al usuario.
2. Si es "preguntar al usuario," AgentHost emite un evento
   `permission-request` al renderer **y aparca el callback del SDK** —
   indexado por `permissionId` — en un mapa pendiente.
3. El renderer muestra el modal; el usuario hace clic en una decisión; IPC de
   vuelta al main.
4. AgentHost busca el callback pendiente y lo resuelve. El SDK procede o
   aborta.
5. Si se marcó "permitir siempre esto," escribe una fila `PermissionGrant`.

Las solicitudes pendientes **no se persisten**. Si la aplicación se cierra
abruptamente a mitad de la decisión, la llamada a herramienta del agente se
cancela al reiniciar.

### Manejadores del supervisor de procesos

Por slot: un `child_process.ChildProcess` para el editor de la aplicación
bajo prueba (Unity / Unreal / motor personalizado — el campo `unityPid`
registra su PID sin importar el motor), otro para el servidor sidecar.
Propiedad de `SlotManager`. Verificados de salud vía liveness de PID +
sondeos HTTP. Terminados al liberar el slot / salir de la aplicación.
**Reconciliados al arrancar** recorriendo el `slot.json` del directorio del
slot y verificando que los PIDs registrados sigan vivos.

---

## Reglas de propiedad

Estas son **invariantes**. El código que las viola es un bug.

1. **El renderer es vista pura.** Sin fs, sin child_process, sin acceso a la
   base de datos. Habla con el main exclusivamente vía el puente tipado
   `window.popbot.*`.

2. **El main es el único escritor de la base de datos.** El renderer lee vía
   IPC; nunca toca `popbot.db`.

3. **AgentHost es lo único que muta el status / snippet / tokens de un Chat
   durante una sesión.** Otro código puede leer esos campos pero no puede
   escribirlos mientras haya una sesión activa para ese chat. (Las
   mutaciones impulsadas por el usuario como renombrar ocurren cuando no hay
   sesión activa, o quedan en cola.)

4. **Los backends nunca escriben a la base de datos.** Emiten eventos;
   AgentHost persiste. Esto mantiene a ClaudeBackend / CodexBackend /
   StubBackend intercambiables sin enredo con el esquema de la base de datos.

5. **PolicyEngine es la única fuente de verdad para "¿puede ejecutarse esta
   herramienta?"** Ningún backend lo evade. Las concesiones de permiso fluyen
   a través de él.

6. **El vínculo Slot ↔ Chat es transitorio.** El registro de Chat nunca
   nombra un slot. El registro de Slot nombra el chat que tiene el arriendo
   (puntero suave, reconciliado al arrancar).

7. **La transcripción nunca muta silenciosamente.** Se anexan filas nuevas;
   las actualizaciones de una sola vez en las filas de tool/permission son
   explícitas y acotadas.

---

## Flujo de estado — un solo mensaje de usuario, de extremo a extremo

Un ejemplo trabajado del modelo en movimiento.

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

Dos cosas que notar:

- **El renderer nunca decide nada.** Despacha intenciones y vuelve a
  renderizar a partir de eventos.
- **Las escrituras a la base de datos ocurren en el mismo lugar que las
  notificaciones al renderer.** Están ligadas al mismo handler en AgentHost.
  Esto significa que un fallo del renderer no puede causar una desviación en
  la persistencia.

---

## Flujo de recuperación — reinicio en frío

US-7 en forma de código. La aplicación termina abruptamente. Horas después,
el usuario la abre de nuevo:

1. **Inicialización de la base de datos** — `initDb()` abre `popbot.db`,
   ejecuta las migraciones pendientes.
2. **Reconciliación de slots** — recorre `~/Library/Application Support/PopBot/slots/`,
   para cada slot lee `slot.json`, verifica que `unityPid` / `serverPid`
   estén vivos (`kill -0`); si están muertos, marca el slot como libre y
   limpia los PIDs. Resuelve cualquier arriendo huérfano (chat que ya no
   existe, o chat cuyo `closedAt` está establecido).
3. **Chats abiertos** — `listOpenChats()` retorna los chats con `closedAt IS
   NULL`, ordenados por `lastActiveAt DESC`. El renderer los solicita en el
   primer pintado.
4. **Sin generación automática de agente.** Las sesiones se generan de forma
   diferida en el primer `agent.send`. Un usuario que abre su chat antiguo
   simplemente ve la transcripción; el agente no retoma donde lo dejó hasta
   que el usuario lo solicita.
5. **Arriendo de slot bajo demanda.** Igual — el arriendo ocurre cuando el
   tipo de chat lo necesita (Client/Server Test) y una herramienta que
   requiere Unity está a punto de dispararse.

El resultado: abrir la aplicación es rápido (lectura de la base de datos +
ping de slot), y puedes inspeccionar el historial de cualquier chat sin pagar
el costo de generar el agente.

---

## Intercambiabilidad de backends

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** envuelve `@anthropic-ai/claude-agent-sdk`. El por
  defecto.
- **CodexBackend** envuelve `@openai/codex-sdk` (que impulsa `codex exec`).
  Distribuido. Cada backend anuncia sus `capabilities` y la interfaz las
  detecta por chat.
- **StubBackend** repite el texto del usuario con un stream falso. Se usa
  para validación de conexiones + pruebas de interfaz.

El campo `agent` del registro de chat selecciona qué backend genera
AgentHost.

---

## Qué está intencionalmente FUERA del modelo

- **Flujos de trabajo / DAGs / cadenas de aprobación.** Un chat es una
  conversación. No estamos modelando pipelines.
- **Multi-usuario.** Un desarrollador por máquina; sin autenticación, sin
  compartir.
- **Notebooks / consultas guardadas / plantillas.** Todo emergente de la
  transcripción; todavía sin tipo de primera clase.
- **Instantáneas de chat versionadas / transcripciones ramificadas.** La
  transcripción es lineal. Bifurcar un chat = crear un chat nuevo sembrado
  con el historial del anterior (una funcionalidad futura, no en el modelo
  hoy).

Si terminamos necesitando alguna de estas, se añade aquí primero, luego al
código.
