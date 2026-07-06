# Phasing

Roadmap, um PopBot von "Design + Prototyp" zu "nützlichem täglichen Werkzeug" zu bringen. Spiegelt das Phasing in [POPBOT_DESIGN.md](POPBOT_DESIGN.md#phasing), verfolgt aber konkreten Fortschritt mit Checkboxen.

Diese Datei aktualisieren, sobald Punkte landen. Ein Commit kann mehrere Boxen abhaken.

---

## Phase 0 — Voraussetzungen (~3 Tage)

Grundlegende Bausteine im AutoRPG-Repo + ein nativer Helper hier. Die meisten davon blockieren das eigentliche End-to-End-Testing, aber nicht das Electron-Scaffold.

### In `~/pop/autorpg`

- [ ] **`POPBOT_MCP_PORT`-Env-Override** auf dem In-Editor-MCP-Server (`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`). Port aus der Umgebung lesen, zurückfallen auf `17893`. ~5 Min.
- [ ] **`./run_local.sh --port` + `--data-dir`-Flags.** Der Server nimmt beide als Argumente entgegen; Data-Dir für die DB-Isolation pro Slot. ~30 Min.
- [ ] **Erweiterung des `/health`-Endpunkts** — gibt `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }` zurück. PopBot verwendet dies zur Drift-Erkennung zum Lease-Zeitpunkt. ~30 Min.

### In diesem Repo

- [ ] **Nativer macOS-Fenster-Mover-Helper** — Swift-CLI unter `native/popbot-windowmover/`. Subcommands: `move`, `minimize`, `wait-for-window`. ~½ Tag.
- [ ] **Slot-Lifecycle-Prototyp** — eigenständiges TS-Modul unter `src/main/slots/`, angesteuert von einem Skript unter `scripts/`. Deckt worktree add, Library COW von master, Branch-Wechsel mit Stash-Sicherheit, Lease/Release, Orphan-Abgleich ab. ~1 Tag.

---

## Phase 1 — MCP-Automatisierungsoberfläche (~3-5 Tage)

In `~/pop/autorpg`. Baut die In-Editor-MCP-Tools aus, die die Agents tatsächlich verwenden werden.

- [ ] **Job-Infrastruktur** — `job_status`, `job_get_result`, `job_cancel`, `job_list`. Alle lang laufenden Tools geben sofort `{ jobId }` zurück.
- [ ] **Lifecycle-Tools** — `play_status`, `play_enter` (job), `play_exit`, `play_pause/resume/step`, `time_scale_set`, `editor_quit`.
- [ ] **Observe-Tools** — `screenshot`, `game_state_summary`, `screen_stack`, `chapter_status`, `ui_tree`, `ui_query`.
- [ ] **Act-Tools** — `ui_click`, `ui_click_by_loc`.
- [ ] **Sync-Tools** — `wait_until` (job), `wait_for_idle` (job).
- [ ] **Logs-/Server-Tools** — `console_get_logs` erweitert (`sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack`), `server_logs`, `server_health`, `client_set_server_endpoint`.
- [ ] **Sessions** — `mcp_session_start`, `mcp_session_end` für vorhersehbare Artefaktverzeichnisse.
- [ ] **Bestehende lange Tools migrieren** auf das Job-Modell: `rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`.

---

## Phase 2 — PopBot Electron MVP (~1-2 Wochen)

End-to-End nutzbar für einen einzelnen Chat. **In Arbeit.**

- [ ] **Electron-Scaffold** — `package.json`, Vite + React + TS + Tailwind, electron-builder, ESLint + Prettier, Vitest.
- [ ] **Main-/Preload-/Renderer-Aufteilung** mit typisierter IPC-Bridge.
- [ ] **Die 8 Prototyp-JSXs portieren** nach `.tsx` unter `src/renderer/`. Statische UI läuft im Electron-Fenster ohne funktionale Anbindung.
- [ ] **better-sqlite3-Schema** — Chats, Messages, Slots, Prefs.
- [ ] **Einzelne ClaudeBackend-Session** in eine Chat-Spalte eingebunden. Nachricht senden, Event-Stream empfangen.
- [ ] **`canUseTool`-Policy-Engine** — fest codierte Deny-Liste + Allow-by-Mode. Der Renderer stellt Permission-Requests als Modals dar.
- [ ] **Slot-Manager** eingebunden — ein Slot, echter Worktree, echter Unity-Start über den Phase-0-Helper.
- [ ] **Integration des nativen Fenster-Movers** — Unity öffnet sich, der Helper platziert es auf Bildschirm 2.
- [ ] **Skelett des Einstellungspanels** — Mode pro Chat, Server-Mode, Zeitskala, Agent-Backend.
- [ ] **End-to-End-Loop-Demo** — Chat öffnen → Agent liest Code → Agent führt Spiel aus → Agent macht Screenshots → Agent berichtet.

---

## Phase 3 — Multi-Chat + Attention-Queue-Panels (~1-2 Wochen)

Aktiviert [US-1](USER_STORIES.md#us-1--bewusstsein-der-attention-queue), [US-2](USER_STORIES.md#us-2--ein-klick-aktivierung), [US-5](USER_STORIES.md#us-5--leichtes-multitasking-via-thumbnails), [US-6](USER_STORIES.md#us-6--status-auf-einen-blick).

- [ ] Mehrere Chat-Spalten; schwebendes Hinzufügen/Entfernen.
- [ ] Thumbnail-Leiste mit Statusfarben (US-5, US-6).
- [ ] **Linear-Tickets-Panel** (mir zugewiesen, gerankt nach Priorität + Fälligkeitsdatum).
- [ ] **Panel ungeprüfter PRs** (`gh`-GraphQL).
- [ ] **Slack-Panel** — DMs, @mentions, eigene Kanäle. Komplett neues Subsystem (`src/main/slack/`); OAuth über `keytar`. Siehe [USER_STORIES.md → Abweichungen](USER_STORIES.md#slack-als-dritte-attention-quelle-us-1).
- [ ] **Ein-Klick-Chat-Erzeugung** aus jeder Panel-Zeile; Chat vorbelegt mit dem Kontext der Quelle (US-2).
- [ ] Unteres Log-Panel — Unity- und Server-Tabs, Sync-Scroll für den aktiven Chat.
- [ ] Mode-/Server-Mode-Umschalter in den Chat-Einstellungen, mit Neuausrichtung mitten in der Session.
- [ ] Drift-Erkennung bei `remote-dev`-Lease.

---

## Phase 4 — Politur + Erweitertes

- [ ] **Codex-Backend-Adapter** — `CodexBackend implements AgentBackend`, Capabilities in der UI gekennzeichnet.
- [ ] **Headless `Window Mode`** — opt-in, nachdem das Batchmode-Validierungsskript beweist, dass es bei AutoRPG funktioniert.
- [ ] **`crash_dump`, `events_pop`, `command_apply`, Fixture-Verwaltung** MCP-Tools.
- [ ] **Nebeneinander liegende Log-Zeitkorrelation** zwischen Unity- und Server-Panels.
- [ ] Verfeinerung von **Autonomie-Budgets + Loop-Erkennung** (Token-/Zeit-/wiederholter-Fehlschlag-Pause-Trigger).
- [ ] **Update-Kanal** — Auto-Updater über electron-builder + signierte Builds.

---

## Offene Fragen (Übertrag aus dem Design)

1. Läuft AutoRPG tatsächlich im `-batchmode` Play-Modus? Validierungsskript ca. in Phase 4; nicht blockierend für v1.
2. Aktualisierungsintervall der Master-Library — manueller Button vs. automatisch vs. N-Tage-TTL? Standard: manueller Button in den Prefs.
3. Standard-Slot-Anzahl — 4 fest codiert, oder Skalierung nach RAM/Cores? Wahrscheinlich Standard 2-3, konfigurierbar.
