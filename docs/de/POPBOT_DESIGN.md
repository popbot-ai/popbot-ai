# PopBot Design

Ein Multi-Agent-Dev-Orchestrator für AutoRPG. Inspiriert von Conductor; ergänzt In-Game-Testinfrastruktur, damit Agents das eigentliche Spiel starten, sich durchklicken und das Verhalten verifizieren können.

> **Status:** Design — festgelegt am 2026-05-01. Lebendiges Dokument; wird während der Implementierung laufend aktualisiert, sobald neue Erkenntnisse anfallen.
>
> **Zuerst lesen:** [USER_STORIES.md](USER_STORIES.md) definiert die sechs Ergebnisse, für die dieses Design existiert. Wenn dieses Dokument und die User Stories widersprüchlich sind, gewinnen die User Stories und dieses Dokument wird aktualisiert.

## Ziele

1. Mehrere KI-Dev-Agents parallel ausführen, jeder in seinem eigenen Git-Worktree.
2. Agents das eigentliche Spiel (Unity Editor im Fenstermodus) für End-to-End-Tests steuern lassen.
3. Ticket-/PR-/Slack-Warteschlangen, Transcript-Verlauf, Logs und Terminals in einem Fenster darstellen.
4. Standardmäßig autonomer Betrieb; nur bei wirklich blockierenden Ereignissen pausieren.

## Nicht-Ziele (v1)

- Produktions-CI/CD (getrennte Belange)
- Cross-Platform (nur macOS; Linux/Windows später bei Bedarf)
- Mehrbenutzer / SSO (ein Entwickler pro Maschine)

## App-Layout

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

Tabs oben links: **Tickets** (mir in Linear zugewiesen) und **Reviews** (PRs, die meine Review anfordern). Klick auf eine Zeile → erzeugt einen Chat, der für diese Arbeit vorbelegt ist.

## Slots — die dauerhafte Einheit

Ein Slot = ein Git-Worktree + seine Library + (optional) sein laufender Unity Editor + (optional) sein laufender Sidecar-Server. **Slots werden selten erstellt, aber kontinuierlich wiederverwendet.**

### Verzeichnis pro Slot

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

### Reale Kostenzahlen (gemessen am 2026-05-01 auf AutoRPG)

| Vorgang | Zeit |
|---|---|
| `git worktree add` (frisch, 62k Dateien, LFS-Smudge) | ~23 s |
| Library COW von master (APFS clonefile) | ~1 s |
| Erster Unity-Start in einem Slot (kalte Library) | 1-3 Min |
| Sticky Hit (Unity läuft bereits, idle) | ~50 ms |
| Kaltstart (Unity aus, Branch stimmt überein) | 15-30 s |
| Branch-Wechsel in bestehendem Slot (Delta + Unity-Reload) | 5-15 s |
| Slot-Erstellung gesamt (worktree add + COW + erster Import) | ~1-3 Min, **selten** |

### Speicherplatz-Budget

~14 GB pro Slot (8 GB Library + 5,5 GB Assets + Scratch). 4 Slots = ~55 GB. Gemeinsames `.git` (~8 GB) wird nur einmal gezählt.

### Lease-Policy

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### Branch-Eindeutigkeit

Git verweigert das Auschecken desselben Branches in zwei Worktrees. Gelöst durch:
- **Lite-/Review-Chats** verwenden einen detached HEAD (kein Konflikt).
- **Zwei Test-Chats auf demselben Branch** — der zweite verwendet einen temporären Branch (`<branch>-slot-N`) oder detached HEAD; PopBots Scheduler entscheidet automatisch.

### Sicherheit vor dem Checkout

Vor jedem Branch-Wechsel in einem bestehenden Slot:

1. `git stash --include-untracked` (immer; Sicherheitsnetz).
2. Ablehnen, wenn es ungespeicherte Commits gibt, die dem Agent gehören; erst committen oder laut fehlschlagen.
3. Offene Unity-Szenen schließen (GUID-Auflösungsprobleme über Branches hinweg vermeiden).
4. `git checkout <branch>`.
5. Stash zurückholen, falls zutreffend, oder aus einem Branch-spezifischen Stash-Record wiederherstellen.

### Policy-Einstellungen pro Slot (in den Prefs)

- `pinnedBranch?` — verweigert Leases für andere Branches; primärer Arbeits-Slot.
- `cleanOnRelease: bool` — `git clean -fd && git checkout .` bei Freigabe; standardmäßig aus.
- `autoStashOnSwitch: bool` — standardmäßig an.

## Ressourcen-Budgets (unabhängige Regler)

Slots und aktive Unity-Instanzen sind **getrennte Budgets**. Ein Slot kann existieren, während sein Unity aus ist — dann ist er nur Speicher. Laufendes Unity ist RAM-gebunden und unabhängig regelbar.

| Budget | Kosten pro Einheit | Standard | Nutzer-Einstellung |
|---|---|---|---|
| **Slot-Anzahl** (Worktrees auf der Festplatte) | ~14 GB | 2-4 | Prefs: "Slots" |
| **Max. aktive Unity-Instanzen** (laufende Prozesse) | ~3-4 GB RAM | 2 | Prefs: "Max active Unity" |
| **Harte Unity-Obergrenze** (Auto-Approve-Grenze im autonomen Modus) | — | berechnet: `floor(systemRAM / 4 GB)` | Prefs: "Unity hard cap" |

### Lease-Policy (erweitert)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### Vom Agent initiierte Kapazitätserhöhung

Neues MCP-Tool, verfügbar, wenn der Agent durch Unity-Kapazität blockiert ist:

| Tool | Modus | Rückgabe |
|---|---|---|
| `request_unity_capacity` | sync | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

Verhalten:

- **Interaktiver Chat** → Chat wird gelb, Banner bittet den Nutzer um Freigabe.
- **Autonomer Chat** → automatische Freigabe bis zur `Unity hard cap`; darüber Pause für den Menschen.
- Nutzer können auch jederzeit präventiv in den Prefs hoch- oder herunterregeln. Herunterregeln entfernt LRU-Idle-Unitys (nie beschäftigte).

## Chat-Typen

| Typ | Slot | Library | Unity | Sidecar | Startzeit | RAM |
|---|---|---|---|---|---|---|
| **Lite** (Review, Plan, Triage) | optional | — | — | — | ~1-2 s | ~50-100 MB |
| **Client Test** | erforderlich | vom Slot besessen | GUI auf Bildschirm 2 | lokal oder remote | 50ms-30s | ~2-4 GB |
| **Server Test** | erforderlich | vom Slot besessen | GUI auf Bildschirm 2 | immer lokal | 50ms-35s | ~2-5 GB |

Standard für neue Chats: **Lite**. Wird hochgestuft, sobald Spieltests wirklich benötigt werden.

## Server-Modi

Pro-Chat-Einstellung; jederzeit umschaltbar.

| Modus | Server-Quelle | Verwendung wenn |
|---|---|---|
| `local` (Standard) | `./run_local.sh --port <P> --data-dir <D>` pro Slot | Alltägliche Agent-Läufe; Backend-Änderungen; deterministischer Zustand |
| `remote-dev` | Gemeinsam genutzter Remote-Dev-Server | Reine Client-Iteration; Drift-Erkennung schützt den Zugang |

### Drift-Erkennung

Bevor eine remote-dev-Lease akzeptiert wird: PopBot liest lokal die Konstante `Assets/Scripts/Simulation/GameDataHash.cs` + DTO-Version; ruft `/health` auf dem Remote per GET ab; vergleicht. Bei Abweichung → Lease mit strukturiertem Fehler abgelehnt.

### `/health` liefert zurück

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### Umschalten mitten in der Session

Nutzer schaltet `Server Mode` in den Chat-Einstellungen um; PopBot:

1. Drift-Check (falls remote-dev betreten wird). Bei Abweichung ablehnen.
2. Sidecar-Prozess je nach Bedarf stoppen / starten.
3. `client_set_server_endpoint { url }` via MCP — Laufzeit-Umleitung.
4. Erzwungenes In-Game-Session-Reset (Logout/Titelbildschirm) — alte Auth ungültig.
5. Laufende Jobs abbrechen, Banner: "server changed, restart task."

## Einstellungspanel pro Chat

| Einstellung | Standard | Hinweise |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = automatische Freigabe bei Sicherheit, Pause bei echtem Stillstand |
| Server mode | `local` | `remote-dev` (Drift-geprüft) |
| Window mode | `GUI on screen 2` | `Headless` (später, opt-in) / `Visible` |
| Time scale | `1.0` | Animationen im Zeitraffer |
| Game view resolution | `1920×1080` | Fixiert für reproduzierbare Screenshots |
| Auto-screenshot every action | aus | Für Proof-Bundles |
| Verbose logs | aus | Umschalten beim Debuggen des Agents selbst |
| Agent backend | `claude` | `codex` (Phase 4) |
| Default fixture | keine | Start mit einem Save-Blob |
| Token budget | `1M` | Pause bei Erreichen (autonomer Modus) |
| Time budget | `60m` | Pause bei Erreichen (autonomer Modus) |
| Loop detection | an | Pause bei N identischen Tool-Aufrufen / keinem Fortschritt für K Min |

## Autonomer Modus

### Policy-Engine — eingehängt in `canUseTool`

Policy nicht im Prompt vergraben; das Modell kann sich davon selbst überreden. Der harte Veto-Hook des SDK wird verwendet.

**Automatische Freigabe im autonomen Modus (still):**

- Read / Edit / Write / Grep / Glob innerhalb des Worktrees des Slots
- Bash innerhalb des Worktrees (mit Deny-Liste unten)
- MCP-Aufrufe an den eigenen MCP-Server des Slots
- Skill-/Sub-Agent-Aufrufe
- TodoWrite, interne SDK-Operationen

**Immer Pause für den Menschen (auch autonom):**

- `git push`, `git reset --hard`, `git checkout --`, Force-Alles, Branch-Löschung
- Alles außerhalb des Worktree-Pfads des Slots
- Netzwerkaufrufe an nicht zugelassene Hosts
- `rm -rf` außerhalb von `tmp/` oder dem Slot-Verzeichnis
- `gh pr create` und jede GitHub-Publish-Aktion
- Slack / E-Mail / externes Messaging
- Änderungen an `~/.claude`, `.mcp.json`, Systemkonfiguration

### Erkennung von "wirklich feststeckend"

**Agent meldet selbst** (über die `message_done`-Form des SDK):

- Klärende Frage
- Expliziter Blocker
- Abschließendes "Ich bin fertig"

**PopBot beobachtet** (Verteidigung in der Tiefe):

- Loop — N identische Tool-Aufrufe hintereinander
- Stillstand — kein Fortschrittsereignis für K Minuten
- Token-/Zeitbudget überschritten
- Wiederholte Testfehlschläge (derselbe Fehler K-mal)

### Statusfarben (Chat-Thumbnail)

| Farbe | Zustand |
|---|---|
| Blau | Läuft |
| Grün | Aufgabe abgeschlossen |
| Gelb | Pausiert — Nutzer benötigt |
| Rot | Fehlgeschlagen |
| Grau | Idle / nicht gestartet |

Im autonomen Modus scannt man die Thumbnails nach **Gelb**. Alles andere ist in Ordnung.

## MCP-Automatisierungsoberfläche

### Regel: jedes Tool antwortet innerhalb von ~100 ms

Lange Operationen liefern sofort `{ jobId }` zurück; der Agent pollt. Den MCP-HTTP-Listener niemals länger als 100 ms blockieren.

### Job-Infrastruktur

| Tool | Modus | Rückgabe |
|---|---|---|
| `job_status` | sync | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | sync | vollständige Payload des Tools; entsorgt den Job |
| `job_cancel` | sync | setzt kooperatives Cancel-Flag |
| `job_list` | sync | aktive + kürzliche (TTL ~60s) |

Coroutines laufen über `EditorCoroutineUtility.StartCoroutineOwnerless`, angetrieben von `EditorApplication.update`. `JobContext` stellt `SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)` bereit.

### Tool-Katalog — Phase-1-Minimum

**Lifecycle:**

- `play_status` (sync), `play_pause` / `play_resume` / `play_step` (sync), `time_scale_set` (sync)
- `play_enter` (job), `play_exit` (sync)
- `editor_quit` (sync)

**Beobachten:**

- `screenshot` (sync) — schreibt nach `Library/MCP/Screenshots/{session}/{label}.png`, gibt Pfad zurück
- `game_state_summary` (sync) — oberster Screen-Stack, Währungen, Level, Kapitel, ausgerüstet, Freischaltungen, letzte 10 Fehler
- `screen_stack` (sync), `chapter_status` (sync)
- `ui_tree` (sync) — Hierarchie mit aufgelöstem `text-loc`
- `ui_query` (sync) — CSS-ähnliche Selektoren (`.btn`, `#Confirm`, `[text-loc=Friends.Title]`)

**Handeln:**

- `ui_click` (sync), `ui_click_by_loc` (sync) — löst `PointerDown/Up/ClickEvent` über `panel.SendEvent` aus

**Sync / Warten:**

- `wait_until` (job) — Prädikate: `screen`, `log`, `event`, `path`
- `wait_for_idle` (job)

**Logs (bestehende erweitern):**

- `console_get_logs` — ergänzt um `sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack: "none"|"first"|"all"`
- `server_logs` (sync) — folgt PopBots `server.log`, gleiche Form wie `console_get_logs`
- `server_health` (sync), `client_set_server_endpoint` (sync)

**Sessions:**

- `mcp_session_start` / `mcp_session_end` — vorhersehbare Artefaktverzeichnisse unter `tmp/mcp-sessions/{slug}/`

### Tool-Katalog — spätere Phasen

- `command_apply`, `command_list` — primäre Aktionsoberfläche, die die UI umgeht
- `save_blob_get` / `save_blob_load`, Fixture-Verwaltung
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`, `gameview_resolution_set`
- `game_state_path` — Reflection-basierter Reader mit zugelassenen Wurzeln

## Fensterverwaltung

Standard: GUI-Editor, dessen Fenster von einem nativen Helper platziert wird.

**Nativer macOS-Fenster-Mover (~50 LOC Swift):**

1. Enges `AXUIElement`-Polling (50 ms), damit der Helper das Fenster innerhalb von ~100 ms nach Erscheinen greift.
2. `setFrame:` auf ein konfiguriertes Rechteck auf Bildschirm 2.
3. `kAXMinimizedAttribute = true` (ins Dock ablegen).
4. Fokus nicht stehlen.

**`EditorPrefs` für die Fensterposition vor dem Start voreinstellen.** Unity stellt beim Start die letzte Fensterposition wieder her, sodass der *zweite* Start an bereits positionierter Stelle öffnet. Der erste Start blitzt kurz auf (~200 ms); spätere Starts nicht.

**Einmalige Einrichtung durch den Nutzer** (dokumentiert im PopBot First-Run): `Dock → Rechtsklick auf Unity → Optionen → Zuweisen zu: Desktop X`. macOS leitet künftige Unity-Fenster automatisch zu diesem Space. Damit passiert selbst das erste Aufblitzen auf einem Space, den der Nutzer nicht ansieht.

Pro Slot konfigurierbare Position, sodass mehrere Unitys an vorhersehbaren Stellen auf Bildschirm 2 landen.

**Headless `Window Mode`** ist opt-in, nachdem die Batchmode-Validierung besteht (ca. Phase 4). Architektur identisch; nur das Start-Flag ändert sich.

## Server-/Unity-Pairing-Protokoll

Start-Reihenfolge und Lebenszyklus müssen eng abgestimmt sein, sonst treten subtile Fehler auf.

### Startsequenz (von PopBot erzwungen)

1. `./run_local.sh --port S --data-dir D` starten. Stdio nach `server.log` teen. `server_pid` aufzeichnen.
2. `/health` pollen, bis 200 (mit `commit/gameDataHash/dtoVersion`). Timeout 30 s. Fehlschlag → Server killen, Fehler anzeigen.
3. `client-server.json` in den Worktree schreiben, zeigt auf `localhost:S`.
4. Unity mit `POPBOT_MCP_PORT=M` starten. `unity_pid` aufzeichnen.
5. `/mcp` pollen, bis 200. Timeout 60 s. Fehlschlag → beide killen, Fehler anzeigen.
6. Nativer Fenster-Mover läuft.
7. Slot ist live; Agent kann leasen.

### Ausfallkaskade

- **Server stirbt mitten in der Session** → PopBot erkennt via PID-Liveness + `server_health` 5xx → markiert Slot als degradiert → versucht einen Server-Neustart → falls das fehlschlägt, im Chat rot anzeigen.
- **Unity stirbt** → Server läuft weiter (Server überlebt Unity-Neustarts; billiger). PopBot kann ein frisches Unity gegen denselben Server starten.
- **Slot-Freigabe** → Server SIGTERM (5 s Gnadenfrist) → SIGKILL → Unity `editor_quit` MCP-Aufruf → SIGTERM (5 s Gnadenfrist) → SIGKILL.

### Abgleich beim PopBot-Start

Slot.json-Dateien scannen; für jede aufgezeichnete PID `kill -0 <pid>`; falls tot, Zustand bereinigen und Slot zurücksetzen. Übliche Orphan-Prozess-Hygiene.

## Agent-Integration

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

Was wir kostenlos bekommen: Skills, Memory, Sub-Agents, Hooks, MCP, Permission-Requests als strukturierte Events. **Nicht das `claude`-CLI per Subprozess abgreifen** — das kämpft bei jedem fortgeschrittenen Feature gegen das SDK.

### AgentBackend-Interface (ab Tag 1 definiert; eine Implementierung in v1)

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

Das Codex-Backend (Phase 4) adaptiert das OpenAI Agents SDK auf dieses Interface. Skills/Memory nicht verfügbar; die UI markiert das deutlich.

### MCP-Konfiguration pro Chat

Jeder Agent startet mit `mcpServers`, die für **seine Slot-Ports** injiziert werden — `popbot-unity`-URL = `localhost:<slot.mcpPort>/mcp`. Andere MCPs (Linear, Sentry, Amplitude, BetterStack) werden vom SDK automatisch aus `~/.claude/settings.json` oder `.mcp.json` übernommen.

## Tech-Stack

- **Electron** (Node + Chromium)
- **React + Tailwind** für die UI
- **xterm.js + node-pty** für das Terminal-Panel
- **better-sqlite3** für die Transcript-Persistenz (eine Zeile pro Event, indiziert nach Chat + Zeitstempel)
- **keytar** für OAuth-Tokens / API-Keys / Agent-Creds
- **Linear GraphQL API** für das Ticket-Panel
- **`gh` GraphQL** für das Panel der ungeprüften PRs
- **Nativer Swift-Helper** für die Fensterplatzierung

## Phasing

### Phase 0 — Voraussetzungen (~3 Tage)

| Element | Owner | Größe |
|---|---|---|
| MCP `POPBOT_MCP_PORT`-Env-Override | Unity MCP | 5 Min |
| `./run_local.sh --port` + `--data-dir`-Argumente | server | 30 Min |
| `/health` liefert `commit`, `gameDataHash`, `dtoVersion` | server | 30 Min |
| Nativer macOS-Fenster-Mover-Helper (Swift) | PopBot | ~½ Tag |
| Slot-Lifecycle-Prototyp (worktree add, Library COW, Branch-Wechsel, Stash-Sicherheit) | PopBot | ~1 Tag |

### Phase 1 — MCP-Automatisierungsoberfläche (~3-5 Tage)

Job-Infrastruktur + der oben genannte Phase-1-Tool-Katalog. Bestehende lange Tools (`rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`) auf das Job-Modell migrieren.

### Phase 2 — PopBot Electron MVP (~1-2 Wochen)

Einzelne Chat-Spalte, nur `ClaudeBackend`, ein einzelner Slot, ein einzelnes Unity. Skelett des Einstellungspanels. `canUseTool`-Policy-Engine. Nativer Helper integriert. End-to-End-Ablauf: Chat öffnen → Agent bearbeitet Code → Agent führt das Spiel aus → Agent verifiziert über Screenshots + Logs → fertig.

### Phase 3 — Multi-Chat + Panels (~1 Woche)

Mehrere Chat-Spalten (Hinzufügen/Entfernen mit schwebenden +/x). Thumbnail-Leiste mit Statusfarben. Panels für Linear-Tickets + ungeprüfte PRs. Unteres Log-Panel mit nebeneinander liegenden Unity-/Server-Tabs. Mode-/Server-Mode-Umschalter in den Chat-Einstellungen.

### Phase 4 — Politur + Erweitertes

Codex-Backend-Adapter. Headless `Window Mode` (nach Batchmode-Validierung). `crash_dump`, `events_pop`, `command_apply`, Fixture-Verwaltung. Nebeneinander liegende Log-Zeitkorrelation. Verfeinerung von Autonomie-Budgets und Loop-Erkennung.

## Offene Fragen

1. **Batchmode-Validierung** — läuft AutoRPG tatsächlich im `-batchmode` Play-Modus? Validierungsskript ca. in Phase 4; nicht blockierend für v1.
2. **Aktualisierungsintervall der Master-Library** — manueller Button vs. automatisch vs. N-Tage-TTL? Standard: manueller Button in den Prefs.
3. **Standard-Slot-Anzahl** — 4 fest codiert, oder Skalierung nach RAM/Cores? Wahrscheinlich Standard 2-3, konfigurierbar.
4. **PopBot-Repo** — getrennt von `autorpg`, oder in `tools/popbot/` liegend? Getrennt, sobald es sich stabilisiert; während der frühen Entwicklung im selben Repo.

## Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| `git checkout` beschädigt einen Slot mitten im Stash | Immer zuerst stashen; nach Checkout auf Sauberkeit prüfen; bei Unsauberkeit ablehnen |
| Zwei PopBot-Instanzen kollidieren im selben Slot | Lock-Datei pro Slot-Verzeichnis; Orphans beim Start abgleichen |
| Unity hängt und die Slot-Lease wird nie freigegeben | PID-Liveness-Check + GC beim PopBot-Start |
| LFS-Lock-Konflikte über Worktrees hinweg | Selten; bei Auftreten klar anzeigen |
| Slot-Library driftet weit von master ab | Manuelles "Slot zurücksetzen" baut aus master neu auf |
| Festplatte läuft voll | Größe pro Slot in den Prefs anzeigen; "Zurücksetzen" gibt Platz frei |
| Backend-Drift bei remote-dev mitten in der Session | `server_health`-Re-Check bei Fehlern; Banner + Anhalten |
| Autonomer Modus genehmigt automatisch etwas Unsicheres | Fest codierte Deny-Liste in `canUseTool`; nie durch Chat-Konfiguration überschreibbar |

## Proof-Artefakte (Debug-Deliverable des Agents)

Wenn ein Agent eine Debug-Aufgabe abschließt, schreibt er nach `tmp/mcp-sessions/{slug}/`:

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` folgt einer 6-Abschnitts-Vorlage (Repro / Before / Root Cause / Fix / After / Verification). Die Konvention ist in einem SKILL (`agent-debug`) dokumentiert; das MCP stellt nur vorhersehbare Session-Pfade bereit.

## Kurzreferenz — was sich gegenüber früheren Vorschlägen geändert hat

Für alle, die das Gespräch lesen, aus dem dieses Dokument entstanden ist:

- Library-Pool / Prozess-Pool / Worktree-Pool **zu einem Konzept zusammengeführt: dem Slot.** Der Slot besitzt seinen Worktree, seine Library, optional Unity, optional den Sidecar. Keine Symlinks, keine getrennten Pools.
- `git worktree add` dauert **~23s bei AutoRPG** (LFS-Smudge über 62k Dateien), nicht 1-2s. Slot-Erstellung ist selten; Wiederverwendung per Checkout ist der alltägliche Hot Path.
- **GUI-Editor auf Bildschirm 2** ist der v1-Standard. Headless-Batchmode ist Phase-4-opt-in nach Validierung.
- Server läuft im selben Repo über `./run_local.sh`; Port + Data-Dir pro Slot zur Isolation.
- Agent-Integration: **zuerst Claude Agent SDK**, AgentBackend-Interface, Codex in Phase 4.
