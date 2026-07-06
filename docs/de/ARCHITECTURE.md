# Architektur

Eine praktische Karte des Electron-Prozessmodells und wo jedes Subsystem lebt. Für das "Warum" siehe [POPBOT_DESIGN.md](POPBOT_DESIGN.md). Für den **Objektgraphen + Lifecycles + Ownership-Regeln**, an denen alles in diesem Dokument hängt, siehe [CORE_MODEL.md](CORE_MODEL.md) — lest das zuerst, falls sich unten etwas unmotiviert anfühlt.

## Prozessmodell

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

**Regel:** der Renderer fasst nie das Dateisystem an, erzeugt nie Child-Prozesse, hält nie kanonischen Zustand. All das ist main. Der Renderer abonniert Events und dispatcht Intents.

## Source-Layout

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

## IPC-Vertrag

Alles IPC ist typisiert und zentralisiert in [`src/shared/ipc.ts`](../../src/shared/ipc.ts) — die `IpcChannel`-String-Map, die Request-/Response-Payload-Typen, und die `PopBotApi`-Oberfläche, die die Preload-Bridge exponiert. Konventionen:

- **`pb:`-Präfix** auf jedem Channel-Namen, nach Subsystem namensgeräumt (`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). Siehe die `IpcChannel`-Konstante für die vollständige Liste.
- **Request/Response** verwendet `ipcRenderer.invoke` + `ipcMain.handle`. Rückgaben sind typisiert. Handler werden pro Subsystem aus `main/ipc/*` registriert und in `main/index.ts` verdrahtet.
- **Push-Events** (Agent-Stream, PTY-Daten, Benachrichtigungen, Update-Fortschritt, Fenster-Maximieren) verwenden `webContents.send` + `ipcRenderer.on`. Der Renderer abonniert; main pusht.
- **Kein rohes IPC in Components.** Das Preload-Skript (`src/preload/index.ts`) exponiert die typisierte `window.popbot.*`-Bridge; Renderer-Code geht durch die Hooks/Buses in `renderer/src/lib/` (`useChats`, `useReviews`, `agentEventBus`, …) statt `ipcRenderer` direkt aufzurufen.

## Slot, in Code-Begriffen

Ein Slot ist nicht ein einzelnes Struct; er ist ein **nummerierter Lease** (`slot_id`) plus der
Worktree/Clone auf der Disk, auf den dieser Lease zeigt. Der Lease-Zustand lebt auf der Chat-Zeile
(`chats.slot_id`, `chats.worktree_path` in `persistence/`), und die Berechnung freier Slots
ist eine Query über offene Chats, die einen Slot für das Repo halten — die Pool-Größe eines Repos
ist `repos.slot_count`. `shared/domain.ts` trägt das kleine gemeinsame Enum plus einen Legacy-`Slot`-Record:

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

Slot-Acquire/-Release/-Reconcile ist verteilt über `git/worktrees.ts` (Git-Worktrees),
`shado/slots.ts` + `scm/*Provider.ts` (VHDX-Slots + Pro-SCM-Clone-/Client-Setup), und die
`ipc/repos.ts`- + `ipc/chats.ts`-Handler. Siehe
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--die-dauerhafte-einheit) für die Lease-Policy,
und **Slot-übergreifende Kontinuität** unten dafür, wie die Arbeit eines Chats ihm über Slots hinweg folgt.

## Warm-Slot-Storage: shado VHDX Copy-on-Write

Für AAA-große Bäume (0,5–1 TB Perforce-Game-Depots) kann ein Slot kein `git
worktree` oder ein vollständiger Checkout sein — ihr könnt das Depot nicht N-mal kopieren, und
ein kalter Sync+Build dauert Minuten bis Stunden. **shado** (gebündelte Go-CLI, Sibling-Repo
`github.com/popbot-ai/shado`, aufgerufen via `main/shado/`) stellt das Storage-Substrat
auf Windows bereit:

- **Eine Base sättigen + einfrieren.** `shado create <repoPath>` synchronisiert/kopiert den Repo-
  Ordner in eine expandierbare VHDX und friert sie dann **schreibgeschützt** ein. Die Base hält
  den vollständigen Baum *plus* warmen abgeleiteten Zustand (Build-Caches, `node_modules`,
  `Intermediate/`, `Saved/`, `DerivedDataCache/`, …).
- **Differenzierende Kinder = Slots.** Jeder Slot ist ein Copy-on-Write-VHDX-Kind der eingefrorenen
  Base (`shado clone create --slot N`), gemountet via `Mount-VHD` +
  `Add-PartitionAccessPath` an einem **Mount-Point-Ordner** (kein Laufwerksbuchstabe, damit wir
  über ~20 Slots hinaus skalieren). Ein frischer, build-bereiter Slot kostet Sekunden und ein paar GB
  Delta statt eines 1-TB-Re-Sync + kaltem Build. Reset = Kind zerstören +
  von der Base neu erstellen (sofort sauber).
- **Layout.** Slots leben auf demselben **Laufwerk wie das Repo** (das VHDX-Modell
  verlangt das): `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`;
  die Base + Diffs + Slot-Metadaten unter `…/workspaces/<repoId>/shado`
  (`SHADO_HOME`). Pfade werden in `main/shado/client.ts` abgeleitet
  (`popbotRootForRepo`, `shadoHomeForRepo`).
- **Elevation.** `shado create` / `clone create` / `remount` / `restore` brauchen
  Admin; PopBot läuft nicht elevated, also werden sie über eine einzige UAC gestartet (temporäre
  `.bat` + `Start-Process -Verb RunAs`). Elevated erstellte Clones landen im Besitz der
  Administrators-Gruppe → git bekommt `-c safe.directory=*` pro
  Aufruf, und p4-Clients sind host-gebunden.
- **Reboot.** VHDX-Mounts überleben keinen Reboot (getrennte Clones + kaputte
  Mount-Point-Reparse-Ordner). Beim Start erkennen wir getrennte Slot-Repos und
  zeigen ein **zentriertes Modal** ("Reconnect"), das der Nutzer anklickt — eine UAC re-mountet
  alle davon (`remountReposElevated`). Siehe `main/shado/base.ts`.

Der Git-Worktree-Pfad (`repo.mode = 'slots'` auf einem Nicht-shado-Repo) existiert weiterhin
für gewöhnliche Repos; shado wird pro Repo für den VHDX-/Perforce-Fall ausgewählt.

### Pro-SCM-Slot-Setup

Ein Slot ist ein **unabhängiger Clone/Client**, kein gemeinsamer Checkout — das ist die
Schlüsseltatsache hinter der Slot-übergreifenden Kontinuität unten.

- **git** (`scm/gitProvider.ts`): der Slot ist ein vollständiger Clone der eingefrorenen Base.
  `ensureSlotWorktree` parkt ihn auf `popbot/slot-N`; `checkoutBranch` erstellt den
  Chat-Branch von der **neuesten** Base (`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`), verwirft geerbten Base-Dreck, während es
  gitignorierte warme Caches behält.
- **perforce** (`p4/*`, `scm/perforceProvider.ts`): jeder Slot hat seinen eigenen p4-
  Client `popbot_<repoId>_slot<N>`, verwurzelt am Mount-Punkt. Setup ist `p4 flush
  @baseChangelist` (0-Byte-Have-Table-Update gegen die eingefrorene Base) + `p4 sync`
  nur des Base→Head-Deltas. Es gibt **kein `p4 reconcile`** (ein 20-minütiger Baum-
  Durchlauf auf einem Game-Depot): ein `fs.watch` pro Slot zeichnet geänderte Pfade auf, und der
  Provider öffnet nur diese mit gezieltem `p4 edit/add/delete`. PopBots eigene
  Schreibvorgänge (Sync/Revert/Unshelve) **pausieren** den Watcher, damit sie nicht erneut geöffnet werden.

## Slot-übergreifende Kontinuität: die Branch-/Changelist-Heimat eines Chats

**Problem.** Weil jeder Slot ein unabhängiger Clone (Git) / Client
(Perforce) ist, lebt der Branch oder die ausstehende Changelist eines Chats **nur in dem Slot, in dem er
erstellt wurde**. Chats leihen sich Slots aus einem gemeinsamen Pool und können auf einem
*anderen* Slot wieder geöffnet werden — wo diese Arbeit nicht existieren würde. (Das alte `git worktree`-Modell
hatte das nicht: alle Worktrees teilten sich ein `.git`, also waren Branches zentral.)

**Lösung.** Die Arbeit eines Chats bei Schließen zu einer Slot-unabhängigen **Heimat** konsolidieren
und bei Wiedereröffnen wiederherstellen. Eingehängt über `SourceControlProvider.persistChatOnClose`
/ `restoreChatOnReopen`, aufgerufen aus den `ChatsClose`-/`ChatsReopen`-Handlern
(`ipc/chats.ts`), das den alten Slot-lokalen Stash ersetzt. Zustand, persistiert auf dem
Chat: `chats.p4_shelf_cl` (Perforce; Git braucht keinen).

- **git → das LOKALE ROOT-Repo.** Die Heimat ist `repo.repoPath` — der Repo-Ordner
  auf der Disk, von dem jeder Slot geklont wurde — hinzugefügt zu jedem Slot als `root`-Remote
  (`origin` bleibt der echte GitHub-Remote, für PRs).
  - *Schließen:* trägt unbestätigte Arbeit als einen Wegwerf-`[Soft committed unstaged
    files]`-Commit (außer der Nutzer hat verworfen), dann `git push -f root <branch>`.
    Das lokale Root akkumuliert den Branch jedes Chats (seine Branch-Liste = das alte
    Shared-Worktree-Verhalten).
  - *Wiedereröffnen:* nach dem Base-Checkout, `git fetch root <branch>` → `checkout -f
    -B branch FETCH_HEAD` → Soft-Undo des WIP-Commits, sodass Edits unbestätigt zurückkehren.
- **perforce → der ROOT-CLIENT als Shelf.** Eine ausstehende Changelist ist pro Slot,
  also ist die Heimat ein serverseitiges **Shelf**, das einem stabilen, nie synchronisierten Repo-Client
  gehört: `popbot_<repoId>_root` (`ensureRootClient` — nur Spec, kein Sync).
  - *Schließen:* `p4 shelve` die CL des Slots, dann `p4 reshelve -f` sie auf die Root-eigene CL
    des Chats. **`reshelve` verschiebt geshelvten Inhalt serverseitig** — verifiziert auf
    Helix 2025.2: client-übergreifend, kein Workspace-Sync, nichts auf die Disk des Roots
    geschrieben ("Shelves verschieben, keine Dateien modifizieren"). Löscht dann das Shelf des Slots +
    die geöffneten Dateien + CL, sodass der Slot **leer** endet; der Root-Client besitzt ein
    geshelvtes CL pro Chat.
  - *Wiedereröffnen:* `p4 unshelve -s <rootCl> -c <newSlotCl>` in die neue frische CL
    des Slots (Watcher pausiert), wobei das Root-Shelf als geparktes Backup erhalten bleibt.

Netto: Slots sind austauschbarer Scratch-Space; das lokale-Root-Git-Repo und der
Root-p4-Client sind die dauerhaften, nutzersichtbaren Heimaten für laufende Arbeit.

## Agent-Backend

`AgentBackend` (`main/agents/types.ts`) ist die Schnittstelle zwischen `AgentHost` und
einem konkreten Backend. **Zwei echte Backends werden heute ausgeliefert** — `ClaudeBackend` (umhüllt
`@anthropic-ai/claude-agent-sdk`) und `CodexBackend` (umhüllt `@openai/codex-sdk`)
— plus ein `StubBackend` für Tests. Ein Chat wählt sein Backend (`chats.agent`) und
kann wechseln; weil die beiden SDKs unterschiedliche native Resume-Handles, Modell- und
Effort-Einstellungen haben, werden diese **provider-gescoped** persistiert
(Claudes `session_id` + `claude_model`/`claude_reasoning_effort`; Codex' `codex_thread_id` +
`codex_model`/`codex_reasoning_effort`). `AgentHost` wählt das Backend, erzeugt
eine Session pro Chat und broadcastet die `AgentEvent`s jeder Session erneut an den
Renderer + die Persistenz.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

Der Editor-MCP pro Slot wird beim Spawn an das Backend übergeben: `SpawnOpts.mcpServers`
trägt den Unity-/Unreal-Editor-Endpunkt des Chats (`{ type: 'http', url }`),
im Speicher registriert in den SDK-Optionen — nichts auf die Disk geschrieben. Nur das
`mcpHttp`-fähige Backend konsumiert ihn. Siehe **Editor-MCP pro Slot** unten.

Der `canUseTool`-Callback lebt neben dem Backend, nicht im Agent-Prompt — es ist unsere harte Veto-Sicherheitsgrenze. Die Regel-Auflösung (`resolveRule`) konsultiert Pro-Chat- dann globale Berechtigungsregeln, bevor sie fragt. Siehe [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md).

## Persistenz

- **`better-sqlite3`** unter `<userData>/popbot.db` (macOS: `~/Library/Application
  Support/PopBot/`; äquivalentes Pro-OS-`app.getPath('userData')` unter Windows /
  Linux). Das Schema ist eine nummerierte Migrationsliste in `persistence/db.ts`
  (`user_version`-gegated, jeder Schritt atomar). Aktuelle Tabellen:
  - `chats` — eine Zeile pro Chat: Slot-Lease (`slot_id`), `worktree_path`, `repo_id`,
    aktiver `agent`, Pro-Provider-Modell/Effort + Resume-Handles (`session_id`,
    `codex_thread_id`), `permission_rules`, und Slot-übergreifender Zustand (`p4_shelf_cl`).
  - `messages` — eine Zeile pro Agent-Event (das dauerhafte Transcript).
  - `repos` — Pro-Repo-Config (Pfad, Farbe, Slot-Präfix, Standard-Base, Slot-Anzahl,
    `mode` = `slots`/`ephemeral`, `scm`, `p4_config`-JSON).
  - `settings` — JSON-Key/Value-App-Prefs (Integrations-Credential-Referenzen, UI-Prefs).
  - `notifications` — der In-App-Benachrichtigungs-Feed.
  - `sdk_session_entries` — Claude-SDK-SessionStore-Backing-Table (Chat-geschlüsselt;
    PopBot besitzt die Recovery-Kopie, damit Resume nicht von `~/.claude`-JSONLs abhängt).
  - `codex_thread_events` — dauerhafter Cache roher Codex-Stream-Events (Codex resumt
    von `~/.codex/sessions`; das ist PopBots eigene Recovery-/Diagnose-Kopie).

  Es gibt **keine** Ticket-/PR-Cache-*Tabelle*: die Tickets- und Reviews-Queues cachen im
  Renderer (siehe die `list-recent`-IPC-Kommentare), nicht in SQLite.
- **Pro-Slot-Scratch** lebt im Worktree/Mount des Slots und Pro-Chat-Laufzeit-
  Verzeichnissen (Agent-CLI-Session-Dateien, PTY, aufbewahrte Attachments). shado-VHDX-Slots leben
  auf dem Laufwerk des Repos unter `…/popbot/workspaces/<repoId>/…` (siehe den shado-Abschnitt).
- **Secrets** via `keytar` (OS-Keychain — macOS Keychain / Windows Credential
  Vault / libsecret). Nie in der SQLite-DB, nie in Logs.

## Ticket-Quellen, SCM-Provider, Reviews, Editoren, Updates

Fünf Provider-Nahtstellen, an denen die Top-Level-Subsysteme hängen — alle so gestaltet, dass
das Hinzufügen eines Backends lokal ist und Aufrufer generisch bleiben:

- **Ticket sources** (`tickets/`). Eine aktive `TicketSource` speist die Tickets-
  Queue, gewählt durch die Einstellung `ticketSource` via `tickets/registry.ts` (Linear /
  Jira / GitHub; Standard ist Linear). Jede Quelle normalisiert auf die gemeinsamen Linear-
  DTOs, sodass der Renderer alle Tracker über einen Pfad rendert und nur nach den
  Capabilities in `shared/ticketProvider.ts` verzweigt, nie nach der Provider-ID. Einen
  Tracker hinzuzufügen ist eine Zeile in der Registry + eine `*Source.ts` + ein Deskriptor.
- **SCM providers** (`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`
  ist die kleine gemeinsame Oberfläche (Workspace-Lifecycle, Arbeitsbaum-Review, PR-/Review-
  Erkennung, Slot-übergreifende Kontinuität). `GitProvider` und `PerforceProvider` sind echt;
  `lore` ist grob angelegt. `scm/index.ts` gibt eine Instanz pro ID zurück. **Aufrufer verzweigen
  nach CAPABILITIES (`shared/sourceControl.ts`), nie nach der Provider-ID** — alles,
  das sich nicht sauber abstrahiert, ist ein Capability-Flag, und ein zu abweichender Provider
  entscheidet sich über `capabilities.nativeClientUi` für sein eigenes Client-Fenster.
- **Reviews** (`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`). Ein
  provider-agnostischer Orchestrator gruppiert konfigurierte Repos nach SCM und dispatcht an
  die Review-Methoden jedes Providers (gegated durch `capabilities.pullRequests`), wobei
  GitHub-PRs und Helix-Swarm-Reviews in einem Panel gemergt werden. Jeder Provider besitzt seinen **eigenen
  Poll-Takt** (`reviewPollIntervalMs` — Swarm langsamer als GitHub, um einen
  gemeinsam genutzten p4d zu schützen), und das Panel führt einen Timer pro Provider aus (`pb:reviews:providers` /
  `pb:reviews:list-for`).
- **Editor-MCP pro Slot** (`ipc/apps.ts`, `shared/gameEngine.ts`). Engines
  (Unity / Unreal / Custom) sind unabhängig aktivierbar. Wenn `useMcp` an ist, wird der Editor jedes
  Slots mit einem **MCP-Port pro Slot** gestartet (`mcpBasePort + (slotId-1)`),
  sodass parallele Editoren nicht kollidieren, und `mcpEndpointForChat` übergibt dem Agent beim Spawn
  die Editor-MCP-HTTP-URL dieses Slots. Editoren werden **detached** gestartet (Fokussieren-oder-
  Starten), nicht als überwachte langlebige Kinder.
- **Updates** (`updates/`). electron-updater-Auto-Update mit einem manuellen-Download-
  Fallback für unsignierte Builds, plus ein On-Demand-Check für den About-Dialog
  (`pb:updates:*`).

## Cross-Cutting

- **Logging** — main schreibt Diagnose-Logs via `diagLog` (`dlog`); die Agent-CLI
  und PTY tragen ihre eigene Pro-Chat-Laufzeit-Ausgabe; Renderer-Logs routen durch main
  via IPC.
- **Startup-Recovery** — Recovery ist DB- und Session-getrieben, nicht PID-Datei-basiert
  (`main/index.ts`-Boot-Sequenz): `initDb()` führt ausstehende Migrationen aus;
  `clearStaleRunningStatuses()` klappt jeden Chat, der in `run` zurückgelassen wurde, zurück zu `idle` (die
  Agent-Session eines vorherigen Laufs ist weg); Session-Store-Import + SDK-Projektverzeichnis-
  Migration + `sessionPinRepair` + `recoverChatSessions` gleichen gepinnte
  Claude-/Codex-Sessions gegen das ab, was tatsächlich auf der Disk ist; die CLI-Probes berichten,
  welche Backends online sind. Unter Windows werden getrennte shado-VHDX-Slots (ein Reboot
  hat ihre Mounts fallen gelassen) erkannt und für eine Ein-UAC-Re-Mount angezeigt (siehe die
  shado-**Reboot**-Anmerkung oben).
- **Updates** — electron-updater-Auto-Update; siehe den **Updates**-Provider oben.
