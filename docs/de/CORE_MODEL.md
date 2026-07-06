# Core Model

Der Objektgraph, um den herum die App von PopBot gebaut ist. Alles andere — IPC,
Persistenz, UI-Panels, der Agent-Loop — hängt an diesen. Wenn ihr Verhalten auf eine Weise
ändert, die eine Regel hier verletzt, **aktualisiert entweder zuerst das Modell
oder sagt dem Nutzer, dass sich das Modell ändert.**

Für "wo lebt der Code?" siehe [ARCHITECTURE.md](ARCHITECTURE.md).
Für "was sieht der Nutzer?" siehe [USER_STORIES.md](USER_STORIES.md).

---

## TL;DR — die vier Nomen, die zählen

| Nomen | Dauerhaft? | Owner | Lebensdauer |
|---|---|---|---|
| **Chat** | ja (SQLite) | main | vom Nutzer erstellt, lebt bis explizit gelöscht |
| **Message** | ja (SQLite, quasi-append-only) | main | Kind von Chat |
| **Slot** | ja (Dateisystem + SQLite-Zeile) | main / `SlotManager` | selten erstellt, wiederverwendet; nie pro Chat |
| **AgentSession** | **nein** (nur im Speicher) | main / `AgentHost` | erzeugt, wenn ein Chat "running" wird; verworfen, wenn der Chat schließt oder die App beendet |

Alles im Renderer ist eine **Ansicht** über diese. Der Renderer besitzt nie
kanonischen Zustand.

---

## Dauerhafte Nomen (überleben einen Neustart)

### Chat

Die Arbeitseinheit des Nutzers. Ein Ticket, ein PR-Review, ein Slack-Thread, eine
"im Code herumstöbern"-Session — jedes davon ist ein Chat.

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

**Status-Lifecycle** (US-6 — was das Thumbnail einfärbt):

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

**Status ist beschreibend, nicht präskriptiv** — abgeleitet von der AgentSession,
wenn eine angehängt ist, bei jedem Übergang in die DB persistiert. Ein Chat, der `idle`
ist, bedeutet "gerade arbeitet kein Agent." Es bedeutet nicht "der Chat ist
geschlossen."

**Offen vs. geschlossen:** ein Chat ist "offen" gdw. `closedAt IS NULL`. Offene Chats
werden beim Start in den Speicher geladen; geschlossene Chats sind nur-Query. **Das Schließen
eines Chats gibt seinen Slot-Lease frei + verwirft seine AgentSession, löscht aber niemals
Messages.**

### Message

Quasi-Append-only-Event-Log innerhalb eines Chats. Das Transcript ist eine Sequenz
typisierter Records:

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

**Warum JSON in `body`?** Jede Art hat eine andere Payload-Form (Text vs.
Tool-Aufruf vs. Berechtigungsanfrage), und der Renderer dispatcht nach `kind`.
Als typisierten JSON-Blob zu speichern hält die Tabelle flach und den Renderer-Code
ehrlich.

**"Größtenteils Append-only":** `tool`- und `permission`-Zeilen werden **einmal** mutiert:

- `tool`-Zeilen: geschrieben bei `tool-use` (Name + Args), aktualisiert bei `tool-result`
  (füllt `result` + `isError`).
- `permission`-Zeilen: geschrieben bei `permission-request` (Tool + Args + Grund),
  aktualisiert bei Nutzer-Entscheidung (setzt `decision`).
- `text`-Zeilen: geschrieben bei `message-start` mit leerem Text, **zusammengeführt** in
  einem kleinen In-Memory-Puffer, während `text-delta`-Events eintreffen, geflusht bei
  `message-end` (und alle ~250 ms, damit der Renderer live bleibt). Eine Zeile pro
  "Agent-Prosa-Zug," nicht eine Zeile pro Delta.

**Keine kaskadierenden Löschungen durch das Zurückrollen von Agent-Arbeit.** Wenn ein Agent einen
Fehler macht und ihr wollt, dass er "es erneut versucht," sendet ihr eine neue Nutzer-Nachricht. Das
alte Transcript bleibt. Das Modell schreibt Historie nie stillschweigend um.

### Slot

Ein warmer, isolierter, wegwerfbarer Workspace: ein isolierter Checkout über einen
Copy-on-Write-Ordner (ein Git-Worktree, oder ein Perforce-Client) + ein warmer
Build-Cache (z. B. der Asset-/Import-Cache einer Engine) + (optional) ein laufender
Editor für die App unter Test (Unity, Unreal, oder eine Custom-Engine) +
(optional) ein laufender Sidecar-Server. **Selten erstellt, kontinuierlich
wiederverwendet.** Slots gehören dem Nutzer / der App, nicht den Chats.

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

Die **Slot-↔-Chat-Bindung** ist **transient** — sie lebt in `slot.leasedByChatId`
und den Laufzeit-Metadaten des entsprechenden Chats. Beim Start gleichen wir das
ab, indem wir Slots durchgehen und gegen offene Chats abgleichen. Veraltete Leases (Chat
geschlossen, Lease nie freigegeben) werden eingesammelt.

Für den vollständigen Slot-Lifecycle siehe [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--die-dauerhafte-einheit).

### Permission-Grant

Eine dauerhafte Nutzerentscheidung, dass eine bestimmte Tool-/Ziel-Kombination genehmigt ist,
ohne erneut zu fragen. Zwei Scopes:

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

`tool` kann ein nachgestelltes `*`-Wildcard sein, sodass ein ganzer MCP-Server
mit einer Gewährung erlaubt werden kann (`allow-mcp-server` → `mcp__<server>__*`) — so wird
das Editor-MCP eines Slots einmal erlaubt statt einmal-pro-Tool. Deny-Regeln gewinnen immer
über Allow, und ein spezifischeres Muster gewinnt über ein allgemeineres
(siehe `resolvePermissionRules` in `src/shared/agent.ts`).

Gewährungen akkumulieren pro Chat (US-9: "erlaube git push für diesen Chat immer").
Hart codierte **Deny-Regeln** in [adr/0004](../adr/0004-canusetool-policy-boundary.md)
werden hier nicht gespeichert — sie leben im Code und können nicht überschrieben werden.

### Settings

Zwei Schichten:

- **Globale Prefs**: Theme, Standard-Chat-Typ, Slot-Anzahl, Master-Library-
  Refresh-Takt, usw. Eine-Zeile-Tabelle.
- **Pro-Chat-Overrides**: Server-Modus, Zeitskala, Fenster-Modus, Token-
  Budget, usw. Gespeichert in einer `chat_settings`-Tabelle, geschlüsselt nach `chatId`.

Beide können leer sein (Standardwerte gelten). Mutiert über Settings-Panels im
Renderer.

### Gecachte Attention-Items

Die Queues des Nutzers aus zugewiesenen Tickets (Linear / Jira / GitHub Issues) und
ausstehenden Reviews (GitHub-PRs / Helix-Swarm-Changelists). Lokal gecacht, damit
Panels sofort rendern; nach Zeitplan + on demand aktualisiert.

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

Ticket-Quellen sind austauschbar hinter einem gemeinsamen Provider (Linear, Jira,
GitHub Issues); Review-Quellen ebenso (GitHub-PRs, Swarm). Gecacht, nicht
autoritativ — die Wahrheitsquelle ist der Tracker / das Review-System selbst.

---

## Laufzeit-Nomen (im Speicher; überleben keinen Neustart)

### AgentSession

Das Ding, das mit dem LLM spricht. Eine AgentSession pro "laufendem" Chat.
Unterstützt durch ein `AgentBackend` (das Claude Agent SDK oder das Codex SDK; beide
werden heute ausgeliefert).

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**Besessen von `AgentHost`** (ein Singleton im Main-Prozess). AgentHost hält eine
`Map<chatId, AgentSession>`. Sessions werden lazy beim ersten
`agent.send` für einen Chat erstellt und beim Schließen des Chats verworfen.

**Sessions emittieren `AgentEvent`s** (siehe `src/shared/agent.ts`). AgentHost
fängt jedes Event ab und:

1. **Persistiert** es (Deltas verschmelzen in eine Text-Zeile; Tool-Use erzeugt eine
   Tool-Zeile; Permission-Request erzeugt eine Permission-Zeile).
2. **Broadcastet** es erneut an den Renderer via `webContents.send`. Der
   Renderer ist einer von N Abonnenten; main ist der autoritative Rekorder.
3. **Aktualisiert Chat-Metadaten** — `status`, `snippet`, `tokensUsed`,
   `lastActiveAt` werden vorangetrieben, während Events eintreffen.

**Sessions schreiben nie direkt in die DB.** Nur AgentHost tut das. Das
entkoppelt die Evolution des Persistenz-Schemas von Backend-Wechseln.

### Permission-Request (im Flug)

Wenn der `canUseTool`-Callback des SDK feuert:

1. PolicyEngine evaluiert: Hard-Allow (automatisch), Hard-Deny (automatisch), oder Nutzer fragen.
2. Falls "Nutzer fragen," emittiert AgentHost ein `permission-request`-Event an den
   Renderer **und parkt den SDK-Callback** — geschlüsselt nach `permissionId` — in einer
   Pending-Map.
3. Renderer zeigt das Modal; Nutzer klickt Entscheidung; IPC zurück zu main.
4. AgentHost schlägt den pendenten Callback nach und löst ihn auf. SDK fährt fort
   oder bricht ab.
5. Falls "immer erlauben" angekreuzt war, wird eine `PermissionGrant`-Zeile geschrieben.

Pendente Anfragen werden **nicht persistiert**. Falls die App mitten in der Entscheidung abstürzt,
wird der Tool-Aufruf des Agents beim Neustart abgebrochen.

### Prozess-Supervisor-Handles

Pro Slot: ein `child_process.ChildProcess` für den Editor der App-unter-Test
(Unity / Unreal / Custom-Engine — das Feld `unityPid` zeichnet dessen PID auf,
unabhängig von der Engine), ein weiteres für den Sidecar-Server. Besessen von
`SlotManager`. Health-gecheckt via PID-Liveness + HTTP-Probes. Beim
Slot-Release / App-Beenden gekillt. **Beim Start abgeglichen**, indem das `slot.json`
des Slot-Verzeichnisses durchgegangen und verifiziert wird, dass aufgezeichnete PIDs noch am Leben sind.

---

## Ownership-Regeln

Das sind **Invarianten**. Code, der sie verletzt, ist ein Bug.

1. **Der Renderer ist reine Ansicht.** Kein fs, kein child_process, kein DB-Zugriff. Spricht
   mit main ausschließlich über die typisierte `window.popbot.*`-Bridge.

2. **Main ist der einzige Schreiber der DB.** Der Renderer liest via IPC; berührt nie
   `popbot.db`.

3. **AgentHost ist das Einzige, das Chat-Status / -Snippet /
   -Tokens während einer Session mutiert.** Anderer Code kann diese Felder lesen, aber nicht
   schreiben, während eine Session für diesen Chat aktiv ist. (Nutzergetriebene
   Mutationen wie Umbenennen passieren, wenn keine Session aktiv ist, oder werden gequeued.)

4. **Backends schreiben nie in die DB.** Sie emittieren Events; AgentHost
   persistiert. Das hält ClaudeBackend / CodexBackend / StubBackend
   austauschbar, ohne DB-Schema-Verstrickung.

5. **PolicyEngine ist die einzige Wahrheitsquelle für "darf dieses Tool laufen?"**
   Kein Backend umgeht es. Permission-Grants fließen durch es hindurch.

6. **Die Slot-↔-Chat-Bindung ist transient.** Der Chat-Record benennt nie einen
   Slot. Der Slot-Record benennt den Chat, der den Lease hält (weicher
   Zeiger, beim Start abgeglichen).

7. **Das Transcript mutiert nie stillschweigend.** Neue Zeilen anfügen; die
   Einmal-Updates auf Tool-/Permission-Zeilen sind explizit und begrenzt.

---

## Zustandsfluss — eine einzelne Nutzernachricht, End-to-End

Ein durchgearbeitetes Beispiel des Modells in Bewegung.

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

Zwei Dinge, die auffallen:

- **Der Renderer entscheidet nie irgendetwas.** Er dispatcht Intents und
  re-rendert aus Events.
- **DB-Writes passieren an derselben Stelle wie Renderer-Benachrichtigungen.** Sie
  sind an denselben Handler in AgentHost gebunden. Das bedeutet, ein Renderer-Crash
  kann keine Persistenz-Drift verursachen.

---

## Recovery-Flow — Neustart aus dem Kalten

US-7 in Code-Form. Die App beendet unsauber. Stunden später öffnet der Nutzer sie wieder:

1. **DB-Init** — `initDb()` öffnet `popbot.db`, führt ausstehende Migrationen aus.
2. **Slot-Reconcile** — geht `~/Library/Application Support/PopBot/slots/` durch,
   liest für jeden Slot `slot.json`, verifiziert, dass `unityPid` / `serverPid`
   am Leben sind (`kill -0`); falls tot, markiert den Slot als frei und löscht die PIDs.
   Löst verwaiste Leases auf (Chat, der nicht existiert, oder Chat, dessen
   `closedAt` gesetzt ist).
3. **Offene Chats** — `listOpenChats()` gibt Chats mit `closedAt IS NULL` zurück,
   sortiert nach `lastActiveAt DESC`. Der Renderer fragt beim ersten Paint danach.
4. **Kein automatisches Agent-Spawn.** Sessions werden lazy beim ersten
   `agent.send` erzeugt. Ein Nutzer, der seinen alten Chat öffnet, sieht nur das Transcript;
   der Agent nimmt nicht wieder auf, wo er aufgehört hat, bis der Nutzer ihn anstößt.
5. **Slot-Lease on demand.** Ebenso — Leasing passiert, wenn der Chat-Typ
   es braucht (Client/Server Test) und ein Tool, das Unity benötigt, kurz davor ist zu feuern.

Das Ergebnis: die App zu öffnen ist schnell (DB-Read + Slot-Ping), und ihr könnt
die Historie jedes Chats inspizieren, ohne die Agent-Spawn-Kosten zu zahlen.

---

## Backend-Austauschbarkeit

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** umhüllt `@anthropic-ai/claude-agent-sdk`. Der Standard.
- **CodexBackend** umhüllt `@openai/codex-sdk` (das `codex exec` steuert).
  Ausgeliefert. Jedes Backend bewirbt seine `capabilities`, und die UI
  feature-detected sie pro Chat.
- **StubBackend** echot Nutzertext mit einem gefälschten Stream. Wird für Verdrahtungs-
  Validierung + UI-Tests verwendet.

Das `agent`-Feld des Chat-Records wählt, welches Backend AgentHost erzeugt.

---

## Was absichtlich NICHT im Modell ist

- **Workflows / DAGs / Genehmigungsketten.** Ein Chat ist eine Konversation. Wir
  modellieren keine Pipelines.
- **Multi-User.** Ein Entwickler pro Maschine; kein Auth, kein Teilen.
- **Notebooks / gespeicherte Queries / Templates.** Alle emergent aus dem
  Transcript; noch kein erstklassiger Typ.
- **Versionierte Chat-Snapshots / verzweigende Transcripts.** Das Transcript ist
  linear. Einen Chat zu forken = einen neuen Chat erstellen, geseedet mit der Historie
  des alten (ein zukünftiges Feature, heute nicht im Modell).

Falls wir eines davon brauchen, wird es zuerst hier hinzugefügt, dann in den Code.
