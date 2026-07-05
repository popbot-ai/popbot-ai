*Languages: [English](../POPBOT_DESIGN.md) · [Español](../es/POPBOT_DESIGN.md) · [Français](../fr/POPBOT_DESIGN.md) · [Deutsch](../de/POPBOT_DESIGN.md) · [日本語](../ja/POPBOT_DESIGN.md) · [한국어](../ko/POPBOT_DESIGN.md) · [简体中文](../zh-CN/POPBOT_DESIGN.md) · [Português (Brasil)](../pt-BR/POPBOT_DESIGN.md) · [Русский](../ru/POPBOT_DESIGN.md) · **Italiano***

# PopBot Design

Un orchestratore di sviluppo multi-agente per AutoRPG. Ispirato a Conductor; aggiunge un'infrastruttura di test in-game in modo che gli agenti possano lanciare il gioco vero e proprio, navigarlo con dei click e verificarne il comportamento.

> **Stato:** design — bloccato il 2026-05-01. Documento vivo; aggiornato sul posto man mano che scopriamo cose durante l'implementazione.
>
> **Leggi prima questo:** [USER_STORIES.md](USER_STORIES.md) definisce i sei risultati che questo design esiste per realizzare. Quando questo documento e le user story sono in disaccordo, vincono le user story e questo documento viene aggiornato.

## Obiettivi

1. Eseguire più agenti di sviluppo IA in parallelo, ciascuno nel proprio git worktree.
2. Permettere agli agenti di guidare il gioco vero e proprio (Unity Editor in finestra) per test end-to-end.
3. Mostrare in un'unica finestra le code di ticket / PR / Slack, la cronologia delle trascrizioni, i log e i terminali.
4. Predefinire il funzionamento autonomo; mettere in pausa solo per eventi realmente bloccanti.

## Non-obiettivi (v1)

- CI/CD di produzione (aspetti separati)
- Cross-platform (solo macOS; Linux/Windows in seguito se necessario)
- Multi-utente / SSO (un singolo sviluppatore per macchina)

## Layout dell'app

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

Schede in alto a sinistra: **Tickets** (Linear assegnati a me) e **Reviews** (PR che richiedono la mia review). Clicca su una riga → genera una chat pre-caricata per quel lavoro.

## Slot — l'unità durevole

Uno slot = un git worktree + la sua Library + (opzionalmente) il suo Unity Editor in esecuzione + (opzionalmente) il suo sidecar server in esecuzione. **Gli slot vengono creati raramente, riutilizzati continuamente.**

### Directory per slot

```text
~/Library/Application Support/PopBot/slots/
├── slot-1/
│   ├── worktree/                    git worktree (persistente)
│   │   ├── Library/                 ~8 GB, vive qui, lo slot la possiede
│   │   ├── Assets/                  ~5,5 GB
│   │   └── ...
│   ├── server-data/                 DB del sidecar (solo modalità local)
│   ├── ports.json                   { mcp: 17901, server: 5101 }
│   ├── unity.log
│   ├── server.log
│   └── slot.json                    { branch, leasedBy, lastLeaseAt, unityPid?, serverPid? }
└── slot-2/...
```

### Numeri di costo reali (misurati il 2026-05-01 su AutoRPG)

| Operazione | Tempo |
|---|---|
| `git worktree add` (nuovo, 62k file, LFS smudge) | ~23 s |
| Library COW da master (APFS clonefile) | ~1 s |
| Primo lancio di Unity su uno slot (Library a freddo) | 1-3 min |
| Sticky hit (Unity già in esecuzione, inattivo) | ~50 ms |
| Cold start (Unity spento, branch corrispondente) | 15-30 s |
| Cambio branch in uno slot esistente (delta + reload di Unity) | 5-15 s |
| Creazione slot totale (worktree add + COW + primo import) | ~1-3 min, **raro** |

### Budget disco

~14 GB per slot (8 GB Library + 5,5 GB Assets + scratch). 4 slot = ~55 GB. `.git` condiviso (~8 GB) contato una sola volta.

### Policy di lease

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### Unicità del branch

Git rifiuta di fare il checkout dello stesso branch in due worktree. Risolto così:
- Le **chat Lite / review** usano detached HEAD (nessun conflitto).
- **Due chat di test sullo stesso branch** — la seconda usa un branch temporaneo (`<branch>-slot-N`) o detached HEAD; lo scheduler di PopBot sceglie automaticamente.

### Sicurezza pre-checkout

Prima di qualsiasi cambio di branch in uno slot esistente:

1. `git stash --include-untracked` (sempre; rete di sicurezza).
2. Rifiuta se ci sono commit non salvati (unstaged) di proprietà dell'agente; fai commit prima oppure fallisci in modo esplicito.
3. Chiudi eventuali scene Unity aperte (evita problemi di risoluzione dei GUID tra branch diversi).
4. `git checkout <branch>`.
5. Ripristina lo stash se applicabile, oppure recupera da un record di stash per-branch.

### Impostazioni di policy per slot (nelle preferenze)

- `pinnedBranch?` — rifiuta i lease per altri branch; slot di lavoro primario.
- `cleanOnRelease: bool` — `git clean -fd && git checkout .` al rilascio; disattivato per default.
- `autoStashOnSwitch: bool` — attivato per default.

## Budget delle risorse (knob indipendenti)

Gli slot e le istanze Unity attive sono **budget separati**. Uno slot può esistere con il suo Unity spento — a quel punto è solo storage. Unity in esecuzione è vincolato dalla RAM ed è regolabile indipendentemente.

| Budget | Costo per unità | Predefinito | Preferenza utente |
|---|---|---|---|
| **Numero di slot** (worktree su disco) | ~14 GB | 2-4 | Preferenze: "Slots" |
| **Max Unity attivi** (processi in esecuzione) | ~3-4 GB RAM | 2 | Preferenze: "Max active Unity" |
| **Tetto massimo Unity** (cap di auto-approvazione in modalità autonoma) | — | calcolato: `floor(systemRAM / 4 GB)` | Preferenze: "Unity hard cap" |

### Policy di lease (estesa)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### Aumento di capacità avviato dall'agente

Nuovo strumento MCP, disponibile quando l'agente è bloccato dalla capacità Unity:

| Strumento | Modalità | Restituisce |
|---|---|---|
| `request_unity_capacity` | sincrona | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

Comportamento:

- **Chat interattiva** → la chat diventa gialla, un banner chiede all'utente di approvare.
- **Chat autonoma** → auto-approva fino al `Unity hard cap`; mette in pausa per l'intervento umano oltre quel limite.
- L'utente può anche aumentare/diminuire la capacità preventivamente nelle preferenze in qualsiasi momento. La diminuzione elimina gli Unity inattivi meno recentemente usati (mai quelli occupati).

## Tipi di chat

| Tipo | Slot | Library | Unity | Sidecar | Avvio | RAM |
|---|---|---|---|---|---|---|
| **Lite** (review, plan, triage) | opzionale | — | — | — | ~1-2 s | ~50-100 MB |
| **Client Test** | obbligatorio | posseduta dallo slot | GUI sullo schermo 2 | locale o remoto | 50ms-30s | ~2-4 GB |
| **Server Test** | obbligatorio | posseduta dallo slot | GUI sullo schermo 2 | sempre locale | 50ms-35s | ~2-5 GB |

Predefinito per le nuove chat: **Lite**. Promuovi quando il test del gioco è effettivamente necessario.

## Modalità server

Impostazione per chat; commutabile al volo.

| Modalità | Sorgente server | Usare quando |
|---|---|---|
| `local` (predefinita) | `./run_local.sh --port <P> --data-dir <D>` per slot | Esecuzioni quotidiane dell'agente; modifiche al backend; stato deterministico |
| `remote-dev` | Server di sviluppo remoto condiviso | Iterazione lato client pura; il rilevamento del drift protegge l'ingresso |

### Rilevamento del drift

Prima che un lease remote-dev venga accettato: PopBot legge localmente la costante `Assets/Scripts/Simulation/GameDataHash.cs` + la versione dei DTO; esegue una GET su `/health` sul server remoto; confronta. In caso di mismatch → rifiuta il lease con un errore strutturato.

### `/health` restituisce

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### Toggle a metà sessione

L'utente commuta `Server Mode` nelle impostazioni della chat; PopBot:

1. Controllo del drift (se si entra in remote-dev). Rifiuta in caso di mismatch.
2. Ferma / avvia il processo sidecar secondo necessità.
3. `client_set_server_endpoint { url }` via MCP — ripuntamento a runtime.
4. Forza il reset della sessione in-game (logout/schermata titolo) — la vecchia autenticazione non è più valida.
5. Annulla i job in corso, banner: "server changed, restart task."

## Pannello impostazioni per chat

| Impostazione | Predefinita | Note |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = auto-approva ciò che è sicuro, si mette in pausa quando è realmente bloccata |
| Server mode | `local` | `remote-dev` (con controllo del drift) |
| Window mode | `GUI on screen 2` | `Headless` (in seguito, opt-in) / `Visible` |
| Time scale | `1.0` | Accelera le animazioni |
| Game view resolution | `1920×1080` | Fissata per screenshot riproducibili |
| Auto-screenshot every action | disattivato | Per i bundle di prova |
| Verbose logs | disattivato | Attiva quando stai facendo debug dell'agente stesso |
| Agent backend | `claude` | `codex` (Fase 4) |
| Default fixture | nessuna | Avvio con un blob di salvataggio |
| Token budget | `1M` | Pausa al raggiungimento (modalità autonoma) |
| Time budget | `60m` | Pausa al raggiungimento (modalità autonoma) |
| Loop detection | attivo | Pausa dopo N chiamate identiche allo stesso strumento / nessun progresso per K minuti |

## Modalità autonoma

### Motore di policy — agganciato a `canUseTool`

Non nascondere la policy nel prompt; il modello può convincersi a ignorarla. Usa l'hook con veto forzato dell'SDK.

**Auto-approvazione in modalità autonoma (silenziosa):**

- Read / Edit / Write / Grep / Glob all'interno del worktree dello slot
- Bash all'interno del worktree (con la deny-list sotto)
- Chiamate MCP verso il server MCP proprio dello slot
- Invocazioni di Skill / sub-agent
- TodoWrite, operazioni interne dell'SDK

**Sempre in pausa per l'intervento umano (anche in autonomia):**

- `git push`, `git reset --hard`, `git checkout --`, qualsiasi forzatura, cancellazione di branch
- Qualsiasi cosa al di fuori del percorso del worktree dello slot
- Chiamate di rete verso host non presenti nella allowlist
- `rm -rf` al di fuori di `tmp/` o della directory dello slot
- `gh pr create` e qualsiasi azione di pubblicazione su GitHub
- Messaggistica Slack / email / esterna
- Modifica di `~/.claude`, `.mcp.json`, configurazione di sistema

### Rilevamento del "realmente bloccato"

**Auto-segnalazione dell'agente** (tramite la forma `message_done` dell'SDK):

- Domanda di chiarimento
- Blocco esplicito
- "Ho finito" terminale

**PopBot osserva** (difesa in profondità):

- Loop — N chiamate identiche allo stesso strumento di fila
- Stallo — nessun evento di progresso per K minuti
- Budget di token / tempo superato
- Fallimenti di test ripetuti (stesso fallimento K volte)

### Colori di stato (thumbnail della chat)

| Colore | Stato |
|---|---|
| Blu | In esecuzione |
| Verde | Task completato |
| Giallo | In pausa — richiede l'utente |
| Rosso | In errore |
| Grigio | Inattivo / non avviato |

In modalità autonoma scansioni le thumbnail cercando il **giallo**. Tutto il resto va bene.

## Superficie di automazione MCP

### Regola: ogni strumento risponde entro ~100 ms

Le operazioni lunghe restituiscono immediatamente `{ jobId }`; l'agente esegue polling. Non bloccare mai il listener HTTP MCP per più di 100 ms.

### Infrastruttura dei job

| Strumento | Modalità | Restituisce |
|---|---|---|
| `job_status` | sincrona | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | sincrona | payload completo dello strumento; smaltisce il job |
| `job_cancel` | sincrona | imposta un flag di cancellazione cooperativo |
| `job_list` | sincrona | attivi + recenti (TTL ~60s) |

Le coroutine vengono eseguite tramite `EditorCoroutineUtility.StartCoroutineOwnerless`, guidate da `EditorApplication.update`. `JobContext` espone `SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)`.

### Catalogo strumenti — minimo Fase 1

**Ciclo di vita:**

- `play_status` (sincrona), `play_pause` / `play_resume` / `play_step` (sincrona), `time_scale_set` (sincrona)
- `play_enter` (job), `play_exit` (sincrona)
- `editor_quit` (sincrona)

**Osservazione:**

- `screenshot` (sincrona) — scrive in `Library/MCP/Screenshots/{session}/{label}.png`, restituisce il percorso
- `game_state_summary` (sincrona) — cima dello stack di schermate, valute, livello, capitolo, equipaggiamento, sblocchi, ultimi 10 errori
- `screen_stack` (sincrona), `chapter_status` (sincrona)
- `ui_tree` (sincrona) — gerarchia con `text-loc` risolto
- `ui_query` (sincrona) — selettori simil-CSS (`.btn`, `#Confirm`, `[text-loc=Friends.Title]`)

**Azione:**

- `ui_click` (sincrona), `ui_click_by_loc` (sincrona) — genera `PointerDown/Up/ClickEvent` tramite `panel.SendEvent`

**Sincronizzazione / attesa:**

- `wait_until` (job) — predicati: `screen`, `log`, `event`, `path`
- `wait_for_idle` (job)

**Log (estende quelli esistenti):**

- `console_get_logs` — aggiunge `sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack: "none"|"first"|"all"`
- `server_logs` (sincrona) — mostra la coda di `server.log` di PopBot, stessa forma di `console_get_logs`
- `server_health` (sincrona), `client_set_server_endpoint` (sincrona)

**Sessioni:**

- `mcp_session_start` / `mcp_session_end` — directory degli artefatti prevedibili in `tmp/mcp-sessions/{slug}/`

### Catalogo strumenti — fasi successive

- `command_apply`, `command_list` — superficie di azione primaria che bypassa la UI
- `save_blob_get` / `save_blob_load`, gestione delle fixture
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`, `gameview_resolution_set`
- `game_state_path` — lettore basato su reflection con radici in allowlist

## Gestione delle finestre

Predefinito: Editor GUI con la finestra posizionata da un helper nativo.

**Window-mover nativo per macOS (~50 righe di codice Swift):**

1. Polling stretto di `AXUIElement` (50 ms) in modo che l'helper catturi la finestra entro ~100 ms dalla sua comparsa.
2. `setFrame:` verso un rettangolo configurato sullo schermo 2.
3. `kAXMinimizedAttribute = true` (minimizza nel dock).
4. Non rubare il focus.

**Pre-impostazione degli `EditorPrefs` per la posizione della finestra prima del lancio.** Unity ripristina l'ultima posizione della finestra all'avvio, quindi dal *secondo* lancio in poi si apre già posizionata. Il primo lancio lampeggia brevemente (~200 ms); i lanci successivi no.

**Setup una tantum lato utente** (documentato nel first-run di PopBot): `Dock → tasto destro su Unity → Options → Assign To: Desktop X`. macOS instrada automaticamente le future finestre di Unity verso quello Space. Con questa impostazione, anche il lampeggio del primo lancio avviene su uno Space che l'utente non sta guardando.

Posizione configurabile per slot, così più istanze di Unity finiscono in posizioni prevedibili sullo schermo 2.

**`Window Mode` headless** è opt-in dopo che la validazione in batchmode passa (Fase 4 circa). Architettura identica; cambia solo il flag di lancio.

## Protocollo di accoppiamento Server / Unity

L'ordine di avvio e il ciclo di vita devono essere rigorosi, altrimenti si incontrano fallimenti sottili.

### Sequenza di avvio (imposta da PopBot)

1. Genera `./run_local.sh --port S --data-dir D`. Fai il tee dello stdio verso `server.log`. Registra `server_pid`.
2. Esegui polling su `/health` finché non risponde 200 (con `commit/gameDataHash/dtoVersion`). Timeout 30 s. In caso di fallimento → termina il server, mostra l'errore.
3. Scrivi `client-server.json` nel worktree puntando a `localhost:S`.
4. Genera Unity con `POPBOT_MCP_PORT=M`. Registra `unity_pid`.
5. Esegui polling su `/mcp` finché non risponde 200. Timeout 60 s. In caso di fallimento → termina entrambi, mostra l'errore.
6. Il window-mover nativo entra in azione.
7. Lo slot è attivo; l'agente può prenderlo in lease.

### Cascata di morte

- **Il server muore a metà sessione** → PopBot lo rileva tramite liveness del PID + `server_health` 5xx → contrassegna lo slot come degradato → prova un riavvio del server → se fallisce, lo mostra nella chat in rosso.
- **Unity muore** → il server continua a girare (il server sopravvive ai riavvii di Unity; più economico). PopBot può generare un nuovo Unity contro lo stesso server.
- **Rilascio dello slot** → SIGTERM al server (5 s di grazia) → SIGKILL → chiamata MCP `editor_quit` a Unity → SIGTERM (5 s di grazia) → SIGKILL.

### Riconciliazione all'avvio di PopBot

Scansiona i file slot.json; per ogni pid registrato, esegui `kill -0 <pid>`; se morto, ripulisci lo stato e resetta lo slot. Igiene standard dei processi orfani.

## Integrazione dell'agente

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

Cosa otteniamo gratuitamente: skill, memoria, sub-agent, hook, MCP, richieste di permesso come eventi strutturati. **Non fare scraping del subprocess della CLI `claude`** — significa combattere contro l'SDK per ogni funzionalità avanzata.

### Interfaccia AgentBackend (definita dal giorno 1; una sola implementazione in v1)

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

Il backend Codex (Fase 4) adatta l'OpenAI Agents SDK a questa interfaccia. Skill/memoria non disponibili; la UI lo segnala chiaramente.

### Configurazione MCP per chat

Ogni agente viene generato con `mcpServers` iniettato per le porte **del proprio slot** — l'URL di `popbot-unity` = `localhost:<slot.mcpPort>/mcp`. Gli altri MCP (Linear, Sentry, Amplitude, BetterStack) sono ereditati da `~/.claude/settings.json` o `.mcp.json` automaticamente dall'SDK.

## Stack tecnologico

- **Electron** (Node + Chromium)
- **React + Tailwind** per la UI
- **xterm.js + node-pty** per il pannello del terminale
- **better-sqlite3** per la persistenza delle trascrizioni (una riga per evento, indicizzata per chat + timestamp)
- **keytar** per token OAuth / chiavi API / credenziali degli agenti
- **API GraphQL di Linear** per il pannello dei ticket
- **GraphQL di `gh`** per il pannello delle PR non revisionate
- **Helper nativo Swift** per il posizionamento delle finestre

## Fasatura

### Fase 0 — Prerequisiti (~3 giorni)

| Voce | Responsabile | Dimensione |
|---|---|---|
| Override della variabile d'ambiente MCP `POPBOT_MCP_PORT` | Unity MCP | 5 min |
| Argomenti `./run_local.sh --port` + `--data-dir` | server | 30 min |
| `/health` restituisce `commit`, `gameDataHash`, `dtoVersion` | server | 30 min |
| Helper nativo per macOS per il posizionamento delle finestre (Swift) | PopBot | ~½ giorno |
| Prototipo del ciclo di vita dello slot (worktree add, Library COW, cambio branch, sicurezza dello stash) | PopBot | ~1 giorno |

### Fase 1 — Superficie di automazione MCP (~3-5 giorni)

Infrastruttura dei job + il catalogo strumenti di Fase 1 sopra descritto. Migra gli strumenti lunghi esistenti (`rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`) verso il modello a job.

### Fase 2 — MVP Electron di PopBot (~1-2 settimane)

Singola colonna di chat, solo `ClaudeBackend`, singolo slot, singolo Unity. Scheletro del pannello impostazioni. Motore di policy `canUseTool`. Helper nativo integrato. Ciclo end-to-end: apri la chat → l'agente modifica il codice → l'agente esegue il gioco → l'agente verifica tramite screenshot e log → fatto.

### Fase 3 — Multi-chat + pannelli (~1 settimana)

Più colonne di chat (aggiungi/rimuovi con +/x fluttuanti). Striscia di thumbnail con colori di stato. Pannelli ticket Linear + PR non revisionate. Pannello log inferiore con schede Unity/server affiancate. Toggle di modalità/server-mode nelle impostazioni della chat.

### Fase 4 — Rifinitura + funzionalità avanzate

Adattatore backend Codex. `Window Mode` headless (dopo la validazione in batchmode). `crash_dump`, `events_pop`, `command_apply`, gestione delle fixture. Correlazione temporale dei log affiancati. Raffinamento dei budget di autonomia e del rilevamento dei loop.

## Domande aperte

1. **Validazione in batchmode** — AutoRPG funziona davvero in modalità Play con `-batchmode`? Script di validazione nella Fase 4 circa; non bloccante per la v1.
2. **Cadenza di refresh della Master Library** — pulsante manuale vs automatico vs TTL di N giorni? Predefinito: pulsante manuale nelle preferenze.
3. **Numero predefinito di slot** — 4 fisso, oppure scala in base a RAM/core? Probabilmente predefinito 2-3, configurabile.
4. **Repository di PopBot** — separato da `autorpg`, oppure vive in `tools/popbot/`? Separato quando si stabilizza; in-tree durante lo sviluppo iniziale.

## Rischi

| Rischio | Mitigazione |
|---|---|
| `git checkout` corrompe uno slot a metà di uno stash | Fai sempre prima lo stash; verifica che sia pulito dopo il checkout; rifiuta se sporco |
| Due istanze di PopBot calpestano lo stesso slot | File di lock per directory dello slot; riconcilia gli orfani all'avvio |
| Unity si blocca e il lease dello slot non viene mai rilasciato | Controllo di liveness del PID + GC all'avvio di PopBot |
| Conflitti di lock LFS tra worktree diversi | Raro; segnala chiaramente quando accade |
| La Library dello slot diverge molto da master | Il "reset slot" manuale ricostruisce da master |
| Il disco si riempie | Mostra la dimensione per slot nelle preferenze; "reset" recupera spazio |
| Drift del backend su remote-dev a metà sessione | Ricontrollo di `server_health` sugli errori; banner + arresto |
| La modalità autonoma auto-approva qualcosa di non sicuro | Deny-list hard-coded in `canUseTool`; mai sovrascrivibile dalla configurazione della chat |

## Artefatti di prova (deliverable di debug dell'agente)

Quando un agente completa un task di debug, scrive in `tmp/mcp-sessions/{slug}/`:

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshot + dump di log filtrati
after/               ← screenshot + dump di log puliti
diff.patch           ← l'agente esegue git diff e salva
```

`proof.md` segue un template a 6 sezioni (Repro / Before / Root Cause / Fix / After / Verification). La convenzione è documentata in una SKILL (`agent-debug`); l'MCP fornisce solo percorsi di sessione prevedibili.

## Riferimento rapido — cosa è cambiato rispetto alle proposte precedenti

Per chiunque legga la conversazione che ha prodotto questo documento:

- Library pool / process pool / worktree pool **collassati in un unico concetto: lo slot.** Lo slot possiede il proprio worktree, la Library, opzionalmente Unity, opzionalmente il sidecar. Nessun symlink, nessun pool separato.
- `git worktree add` richiede **~23s su AutoRPG** (LFS smudge su 62k file), non 1-2s. La creazione dello slot è rara; il riutilizzo tramite checkout è il percorso quotidiano più frequente.
- **Editor GUI sullo schermo 2** è il predefinito della v1. Il batchmode headless è opt-in di Fase 4.
- Il server gira in-tree tramite `./run_local.sh`; porta + data-dir per slot per l'isolamento.
- Integrazione dell'agente: **Claude Agent SDK per primo**, interfaccia AgentBackend, Codex in Fase 4.
