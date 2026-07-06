# Fasi

Roadmap per portare PopBot da "design + prototipo" a "strumento utile per l'uso quotidiano." Rispecchia le fasi descritte in [POPBOT_DESIGN.md](POPBOT_DESIGN.md#fasatura) ma traccia i progressi concreti con delle checkbox.

Aggiornare questo file man mano che gli elementi vengono completati. Un singolo commit può spuntare più caselle.

---

## Fase 0 — Prerequisiti (~3 giorni)

Elementi fondamentali nel repository AutoRPG + un helper nativo qui. La maggior parte di questi elementi blocca i test end-to-end effettivi ma non lo scaffold Electron.

### In `~/pop/autorpg`

- [ ] **Override della variabile d'ambiente `POPBOT_MCP_PORT`** sul server MCP in-Editor (`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`). Leggere la porta dalla variabile d'ambiente, con fallback a `17893`. ~5 min.
- [ ] **Flag `./run_local.sh --port` + `--data-dir`.** Il server accetta entrambi come argomenti; la data dir serve per l'isolamento del DB per slot. ~30 min.
- [ ] **Estensione dell'endpoint `/health`** — restituisce `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }`. PopBot li usa per il rilevamento del drift al momento del lease. ~30 min.

### In questo repository

- [ ] **Helper nativo macOS per lo spostamento delle finestre** — CLI Swift in `native/popbot-windowmover/`. Sottocomandi: `move`, `minimize`, `wait-for-window`. ~½ giornata.
- [ ] **Prototipo del ciclo di vita degli slot** — modulo TS standalone in `src/main/slots/`, eseguito da uno script in `scripts/`. Copre l'aggiunta del worktree, il COW della Library dal master, il cambio di branch con protezione dello stash, lease/release, e la riconciliazione degli orfani. ~1 giorno.

---

## Fase 1 — Superficie di automazione MCP (~3-5 giorni)

In `~/pop/autorpg`. Costruisce gli strumenti MCP in-Editor che gli agenti useranno effettivamente.

- [ ] **Infrastruttura dei job** — `job_status`, `job_get_result`, `job_cancel`, `job_list`. Tutti gli strumenti a esecuzione prolungata restituiscono immediatamente `{ jobId }`.
- [ ] **Strumenti per il ciclo di vita** — `play_status`, `play_enter` (job), `play_exit`, `play_pause/resume/step`, `time_scale_set`, `editor_quit`.
- [ ] **Strumenti di osservazione** — `screenshot`, `game_state_summary`, `screen_stack`, `chapter_status`, `ui_tree`, `ui_query`.
- [ ] **Strumenti di azione** — `ui_click`, `ui_click_by_loc`.
- [ ] **Strumenti di sincronizzazione** — `wait_until` (job), `wait_for_idle` (job).
- [ ] **Strumenti di log / server** — `console_get_logs` esteso (`sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack`), `server_logs`, `server_health`, `client_set_server_endpoint`.
- [ ] **Sessioni** — `mcp_session_start`, `mcp_session_end` per directory degli artefatti prevedibili.
- [ ] **Migrazione degli strumenti a esecuzione prolungata esistenti** al modello a job: `rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`.

---

## Fase 2 — MVP Electron di PopBot (~1-2 settimane)

Utilizzabile end-to-end per una singola chat. **In corso.**

- [ ] **Scaffold Electron** — `package.json`, Vite + React + TS + Tailwind, electron-builder, ESLint + Prettier, Vitest.
- [ ] **Suddivisione main / preload / renderer** con bridge IPC tipizzato.
- [ ] **Portare gli 8 JSX del prototipo** a `.tsx` in `src/renderer/`. La UI statica gira nella finestra Electron senza alcun supporto funzionale.
- [ ] **Schema better-sqlite3** — chat, messaggi, slot, preferenze.
- [ ] **Singola sessione ClaudeBackend** collegata a una colonna di chat. Invio del messaggio, ricezione dello stream di eventi.
- [ ] **Motore di policy `canUseTool`** — lista di blocco hard-coded + consenso in base alla modalità. Il renderer mostra le richieste di permesso come modali.
- [ ] **Slot manager collegato** — uno slot, worktree reale, avvio reale di Unity tramite l'helper della Fase 0.
- [ ] **Integrazione dell'helper nativo per lo spostamento delle finestre** — Unity si apre, l'helper lo posiziona sullo schermo 2.
- [ ] **Scheletro del pannello impostazioni** — modalità per chat, modalità server, scala temporale, backend dell'agente.
- [ ] **Demo del ciclo end-to-end** — apertura della chat → l'agente legge il codice → l'agente esegue il gioco → l'agente cattura screenshot → l'agente riporta i risultati.

---

## Fase 3 — Pannelli multi-chat + coda di attenzione (~1-2 settimane)

Attiva [US-1](USER_STORIES.md#us-1--consapevolezza-della-coda-di-attenzione), [US-2](USER_STORIES.md#us-2--attivazione-con-un-clic), [US-5](USER_STORIES.md#us-5--multitasking-facile-tramite-miniature), [US-6](USER_STORIES.md#us-6--stato-a-colpo-docchio).

- [ ] Colonne di chat multiple; aggiunta/rimozione fluttuante.
- [ ] Striscia di anteprime con colori di stato (US-5, US-6).
- [ ] **Pannello dei ticket Linear** (assegnati a me, classificati per priorità + data di scadenza).
- [ ] **Pannello delle PR non revisionate** (`gh` GraphQL).
- [ ] **Pannello Slack** — DM, @menzioni, canali posseduti. Sottosistema completamente nuovo (`src/main/slack/`); OAuth tramite `keytar`. Vedi [USER_STORIES.md → Deviazioni](USER_STORIES.md#slack-come-terza-fonte-di-attenzione-us-1).
- [ ] **Avvio di chat con un clic** da qualsiasi riga di pannello; la chat viene inizializzata con il contesto della fonte (US-2).
- [ ] Pannello dei log inferiore — schede Unity + server, scorrimento sincronizzato per la chat attiva.
- [ ] Interruttori di modalità e modalità server nelle impostazioni della chat, con ripuntamento a metà sessione.
- [ ] Rilevamento del drift sul lease di `remote-dev`.

---

## Fase 4 — Rifinitura + funzionalità avanzate

- [ ] **Adattatore backend Codex** — `CodexBackend implements AgentBackend`, capacità segnalate nella UI.
- [ ] **`Window Mode` headless** — opt-in dopo che lo script di validazione batchmode dimostra che funziona su AutoRPG.
- [ ] **Strumenti MCP `crash_dump`, `events_pop`, `command_apply`, gestione delle fixture**.
- [ ] **Correlazione temporale dei log affiancati** tra i pannelli Unity e server.
- [ ] **Rifinitura di budget di autonomia + rilevamento dei loop** (trigger di pausa per token / tempo / fallimento ripetuto).
- [ ] **Canale di aggiornamento** — auto-updater tramite electron-builder + build firmate.

---

## Domande aperte (riportate dal design)

1. AutoRPG funziona effettivamente in modalità Play con `-batchmode`? Script di validazione previsto verso la Fase 4; non bloccante per la v1.
2. Cadenza di aggiornamento della Master Library — pulsante manuale vs automatico vs TTL di N giorni? Predefinito: pulsante manuale nelle preferenze.
3. Numero predefinito di slot — 4 fisso, o scalato in base a RAM/core? Probabilmente predefinito 2-3, configurabile.
