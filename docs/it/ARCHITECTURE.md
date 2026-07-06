# Architettura

Una mappa pratica del modello di processo Electron e di dove risiede ciascun sottosistema. Per il "perché", vedi [POPBOT_DESIGN.md](POPBOT_DESIGN.md). Per il **grafo degli oggetti + i lifecycle + le regole di ownership** su cui si basa tutto ciò che segue in questo documento, vedi [CORE_MODEL.md](CORE_MODEL.md) — leggilo per primo se qualcosa più sotto sembra immotivato.

## Modello di processo

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Processo main di Electron (Node)                                     │
│  ─ Lifecycle di slot / worktree — worktree git o slot VHDX shado,    │
│    setup clone/client per-SCM, cambio di branch/changelist           │
│  ─ Registro dei provider SCM — git + perforce dietro un'unica        │
│    astrazione; i chiamanti si ramificano su CAPABILITIES, non su     │
│    provider id                                                       │
│  ─ Agent host — backend Claude E Codex dietro AgentBackend           │
│    (una sessione per chat); il confine di policy canUseTool          │
│  ─ Launcher editor + glue MCP per-slot — focus/avvio di editor       │
│    Unity/Unreal/custom; passa all'agente l'URL HTTP MCP              │
│    dell'editor del proprio slot                                      │
│  ─ PTY manager — un terminale persistente per chat                   │
│  ─ Persistenza — better-sqlite3 (trascrizioni, stato chat/slot/repo, │
│    preferenze, cache di sessione SDK + Codex)                        │
│  ─ API esterne — ticket (Linear / Jira / GitHub), review             │
│    (PR GitHub / Helix Swarm), Slack, Sentry                          │
└────────┬─────────────────────────────────────────────────────────────┘
         │ contextBridge (canali IPC tipizzati, `window.popbot.*`)
┌────────▼─────────────────────────────────────────────────────────────┐
│ Renderer (Chromium + React + Tailwind)                               │
│  ─ Shell dell'app, pannelli, colonne di chat, sheet delle            │
│    impostazioni, modali                                              │
│  ─ Si iscrive agli stream di eventi dell'agente via IPC              │
│  ─ Invia azioni utente (approva permesso, invia messaggio, ...)      │
│    indietro                                                          │
│  ─ Non possiede nulla che il processo main debba recuperare dopo     │
│    un crash del renderer; il renderer è un layer di sola vista       │
└──────────────────────────────────────────────────────────────────────┘
```

**Regola:** il renderer non tocca mai il file system, non genera mai child process, non detiene mai lo stato canonico. Tutto ciò è compito del main. Il renderer si iscrive agli eventi e dispatcha gli intent.

## Struttura dei sorgenti

```text
src/
├── main/                       # Processo main di Electron — Node, nessun DOM
│   ├── index.ts                # entry point; createWindow, lifecycle dell'app, wiring degli handler
│   ├── ipc/                    # handler IPC tipizzati, un modulo per sottosistema
│   │                           #   (agent, apps, chats, files, git, notifications,
│   │                           #    repos, reviews, sentry, settings, slack, term, tickets)
│   ├── agents/                 # interfaccia AgentBackend + ClaudeBackend + CodexBackend
│   │                           #   + StubBackend; AgentHost, store di sessione SDK/Codex,
│   │                           #   probe CLI, recovery
│   ├── scm/                    # registro dei provider di controllo versione + classe base;
│   │                           #   gitProvider, perforceProvider, detect
│   ├── git/                    # plumbing git: worktree, percorsi chat, review (PR gh)
│   ├── p4/                     # Perforce: exec, client/workspace, file watcher,
│   │                           #   client Swarm + swarmReviews
│   ├── shado/                  # wrapper CLI VHDX shado incluso: base, slot, client
│   ├── tickets/                # registro delle fonti ticket + fonti linear/jira/github
│   ├── reviews/                # orchestratore Reviews agnostico rispetto al provider (raggruppa per SCM)
│   ├── linear/                 # client API Linear
│   ├── jira/                   # client API Jira Cloud
│   ├── github/                 # client GitHub (CLI `gh`)
│   ├── slack/                  # client Slack + poller DM/@mention/canale
│   ├── sentry/                 # client Sentry + poller di issue
│   ├── notifications/          # classificazione + dispatch delle notifiche in-app
│   ├── term/                   # PTY manager per-chat (node-pty)
│   ├── attachments/            # store di conservazione allegati chat (immagine/file)
│   ├── persistence/            # schema better-sqlite3 (migrazioni) + query tipizzate
│   └── updates/                # auto-update electron-updater + controllo on-demand
├── preload/
│   └── index.ts                # contextBridge — espone la API tipizzata `window.popbot`
├── renderer/src/               # UI React
│   ├── main.tsx                # mount ReactDOM.createRoot
│   ├── App.tsx
│   ├── components/             # dir PIATTA — pannelli (PanelA/B/D), colonna chat, dialog,
│   │                           #   sheet, pannelli git/P4, modali, primitive
│   ├── lib/                    # hook + bus lato client (useChats, useReviews,
│   │                           #   agentEventBus, …); chiama `window.popbot.*`, niente Node
│   ├── styles/                 # layer Tailwind + stili portati
│   ├── assets/                 # icone engine / SCM / notifiche
│   └── fixtures/               # dati di esempio statici per lo sviluppo
└── shared/                     # tipi/contratti condivisi tra i due lati del bridge
    ├── ipc.ts                  # nomi dei canali IPC, tipi dei payload, la superficie PopBotApi
    ├── domain.ts               # enum Chat/Slot/status (dati puri)
    ├── agent.ts                # AgentEvent + tipi di permesso
    ├── persistence.ts          # ChatRecord/RepoRecord + id di modello/effort
    ├── sourceControl.ts        # id dei provider SCM + flag di capability
    ├── ticketProvider.ts       # id dei provider ticket + capability
    ├── reviews.ts              # DTO delle review (PR / Swarm)
    ├── gameEngine.ts           # id dei motori + helper per porte MCP per-slot
    ├── git.ts / perforce.ts    # DTO specifici per SCM
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## Contratto IPC

Tutto l'IPC è tipizzato e centralizzato in [`src/shared/ipc.ts`](../../src/shared/ipc.ts) — la mappa di stringhe `IpcChannel`, i tipi dei payload di richiesta/risposta, e la superficie `PopBotApi` che il bridge preload espone. Convenzioni:

- **Prefisso `pb:`** su ogni nome di canale, namespaced per sottosistema (`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). Vedi la costante `IpcChannel` per l'elenco completo.
- **Request/response** usa `ipcRenderer.invoke` + `ipcMain.handle`. I valori di ritorno sono tipizzati. Gli handler sono registrati per sottosistema da `main/ipc/*` e collegati in `main/index.ts`.
- **Eventi push** (stream dell'agente, dati PTY, notifiche, avanzamento aggiornamenti, massimizzazione finestra) usano `webContents.send` + `ipcRenderer.on`. Il renderer si iscrive; il main invia.
- **Nessun IPC grezzo nei componenti.** Lo script preload (`src/preload/index.ts`) espone il bridge tipizzato `window.popbot.*`; il codice del renderer passa attraverso gli hook/bus in `renderer/src/lib/` (`useChats`, `useReviews`, `agentEventBus`, …) invece di chiamare direttamente `ipcRenderer`.

## Lo slot, in termini di codice

Uno slot non è una singola struttura; è un **lease numerato** (`slot_id`) più il
worktree/clone su disco a cui quel lease punta. Lo stato del lease vive sulla riga della chat
(`chats.slot_id`, `chats.worktree_path` in `persistence/`), e il calcolo degli slot liberi
è una query sulle chat aperte che detengono uno slot per il repository — la dimensione del
pool di un repository è `repos.slot_count`. `shared/domain.ts` porta il piccolo enum condiviso
più un record `Slot` legacy:

```ts
export type SlotState = 'free' | 'leased' | 'degraded' | 'creating';

// NOTA: questa interfaccia `Slot` non è attualmente usata dal codice in esecuzione
// (vengono importati solo SlotState + ChatStatus). Nomina ancora Unity
// specificamente; il modello live si è generalizzato oltre questo — l'editor è
// agnostico rispetto al motore (Unity/Unreal/custom) e non è un child supervisionato con un
// pid tracciato, quindi tratta questa forma come legacy, non come autoritativa.
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

L'acquisizione / il rilascio / la riconciliazione degli slot sono distribuiti tra `git/worktrees.ts` (worktree
git), `shado/slots.ts` + `scm/*Provider.ts` (slot VHDX + setup clone/client per-SCM), e gli
handler `ipc/repos.ts` + `ipc/chats.ts`. Vedi
[POPBOT_DESIGN.md → Slot](POPBOT_DESIGN.md#slot--lunità-durevole) per la policy dei
lease, e **Continuità cross-slot** più sotto per come il lavoro di una chat la segue
attraverso gli slot.

## Storage warm-slot: copy-on-write VHDX di shado

Per alberi su scala AAA (depot Perforce di gioco da 0,5–1 TB) uno slot non può essere un `git
worktree` o un checkout completo — non puoi copiare il depot N volte, e una sync+build a freddo
richiede da minuti a ore. **shado** (CLI Go inclusa, repository gemello
`github.com/popbot-ai/shado`, invocata via `main/shado/`) fornisce il substrato di storage
su Windows:

- **Saturare + congelare una base.** `shado create <repoPath>` sincronizza/copia la cartella
  del repository in un VHDX espandibile, poi la congela in **sola lettura**. La base contiene
  l'intero albero *più* lo stato derivato caldo (cache di build, `node_modules`,
  `Intermediate/`, `Saved/`, `DerivedDataCache/`, …).
- **I figli differencing = gli slot.** Ogni slot è un figlio VHDX copy-on-write della base
  congelata (`shado clone create --slot N`), montato tramite `Mount-VHD` +
  `Add-PartitionAccessPath` su una **cartella mount-point** (non una lettera di unità, così
  si scala oltre i ~20 slot). Uno slot nuovo e pronto per la build costa secondi e pochi GB
  di delta invece di una re-sync da 1 TB + build a freddo. Reset = distruggi il figlio +
  ricrea dalla base (pulizia istantanea).
- **Layout.** Gli slot vivono sullo **stesso drive del repository** (il modello VHDX lo
  richiede): `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`;
  la base + i diff + i metadati degli slot sotto `…/workspaces/<repoId>/shado`
  (`SHADO_HOME`). I percorsi sono derivati in `main/shado/client.ts`
  (`popbotRootForRepo`, `shadoHomeForRepo`).
- **Elevazione.** `shado create` / `clone create` / `remount` / `restore` richiedono i
  privilegi di amministratore; PopBot gira senza elevazione, quindi vengono lanciati tramite
  un unico UAC (`.bat` temporaneo + `Start-Process -Verb RunAs`). I clone creati con elevazione
  finiscono di proprietà del gruppo Administrators → git riceve `-c safe.directory=*` per
  ogni invocazione, e i client p4 sono vincolati all'host.
- **Riavvio.** I mount VHDX non sopravvivono a un riavvio (clone disconnessi + cartelle
  reparse dei mount-point interrotte). All'avvio rileviamo i repository con slot disconnessi e
  mostriamo un **modale centrale** ("Reconnect") su cui l'utente clicca — un solo UAC rimonta
  tutti quanti (`remountReposElevated`). Vedi `main/shado/base.ts`.

Il percorso git-worktree (`repo.mode = 'slots'` su un repository non-shado) esiste ancora
per i repository ordinari; shado viene selezionato per-repository per il caso VHDX/Perforce.

### Setup slot per-SCM

Uno slot è un **clone/client indipendente**, non un checkout condiviso — questo è il
fatto chiave dietro la continuità cross-slot più sotto.

- **git** (`scm/gitProvider.ts`): lo slot è un clone completo della base congelata.
  `ensureSlotWorktree` lo posiziona su `popbot/slot-N`; `checkoutBranch` crea il
  branch della chat a partire dalla base **più recente** (`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`), scartando lo sporco ereditato dalla base pur mantenendo
  le cache calde ignorate da git.
- **perforce** (`p4/*`, `scm/perforceProvider.ts`): ogni slot ha il proprio client p4
  `popbot_<repoId>_slot<N>` radicato nel mount. Il setup è `p4 flush
  @baseChangelist` (aggiornamento a costo zero della have-table rispetto alla base congelata) + `p4 sync`
  del solo delta base→head. Non c'è **nessun `p4 reconcile`** (una scansione dell'albero di 20 minuti
  su un depot di gioco): un `fs.watch` per-slot registra i percorsi modificati e il
  provider apre solo quelli con `p4 edit/add/delete` mirati. Le scritture proprie di PopBot
  (sync/revert/unshelve) **mettono in pausa** il watcher così non vengono riaperte.

## Continuità cross-slot: la home del branch / della changelist di una chat

**Problema.** Poiché ogni slot è un clone (git) / client (perforce) indipendente, il branch o
la changelist pendente di una chat vive **solo nello slot in cui è stata creata**. Le chat
prendono in prestito gli slot da un pool condiviso e possono riaprirsi su uno slot
*diverso* — dove quel lavoro non esisterebbe. (Il vecchio modello `git worktree`
non aveva questo problema: tutti i worktree condividevano un unico `.git`, quindi i branch erano centrali.)

**Soluzione.** Consolidare il lavoro di una chat in una **home** indipendente dallo slot alla
chiusura e ripristinarlo alla riapertura. Agganciato tramite `SourceControlProvider.persistChatOnClose`
/ `restoreChatOnReopen`, chiamato dagli handler `ChatsClose` / `ChatsReopen`
(`ipc/chats.ts`), sostituendo il vecchio stash locale allo slot. Stato reso persistente sulla
chat: `chats.p4_shelf_cl` (perforce; git non ne ha bisogno).

- **git → il REPOSITORY ROOT LOCALE.** La home è `repo.repoPath` — la cartella del
  repository su disco da cui è stato clonato ogni slot — aggiunta a ogni slot come remote
  `root` (`origin` resta il vero remote GitHub, per le PR).
  - *Chiusura:* porta il lavoro non committato come commit usa-e-getta `[Soft committed unstaged
    files]` (a meno che l'utente non l'abbia scartato), poi `git push -f root <branch>`.
    Il root locale accumula il branch di ogni chat (il suo elenco di branch = il vecchio
    comportamento a worktree condiviso).
  - *Riapertura:* dopo il checkout della base, `git fetch root <branch>` → `checkout -f
    -B branch FETCH_HEAD` → soft-undo del commit WIP così le modifiche tornano non committate.
- **perforce → il CLIENT ROOT come shelf.** Una changelist pendente è per-slot,
  quindi la home è uno **shelf** lato server posseduto da un client per-repository stabile e
  mai sincronizzato `popbot_<repoId>_root` (`ensureRootClient` — solo spec, nessuna sync).
  - *Chiusura:* `p4 shelve` della CL dello slot, poi `p4 reshelve -f` sulla CL posseduta dal
    root della chat. **`reshelve` sposta il contenuto shelved lato server** — verificato su
    Helix 2025.2: cross-client, nessuna sync del workspace, nulla scritto sul disco del root
    ("sposta gli shelve, non modifica i file"). Poi elimina lo shelf dello slot + i file
    aperti + la CL, così lo slot finisce **vuoto**; il client root possiede una CL shelved
    per chat.
  - *Riapertura:* `p4 unshelve -s <rootCl> -c <newSlotCl>` nella nuova CL dello slot (fresca,
    watcher in pausa), mantenendo lo shelf root come backup parcheggiato.

Netto: gli slot sono spazio scratch intercambiabile; il repository git root locale e il
client p4 root sono le home durevoli e visibili all'utente per il lavoro in corso.

## Backend dell'agente

`AgentBackend` (`main/agents/types.ts`) è l'interfaccia tra `AgentHost` e un
backend concreto. **Oggi vengono spediti due backend reali** — `ClaudeBackend` (avvolge
`@anthropic-ai/claude-agent-sdk`) e `CodexBackend` (avvolge `@openai/codex-sdk`)
— più uno `StubBackend` per i test. Una chat sceglie il proprio backend (`chats.agent`) e
può cambiarlo; poiché i due SDK hanno handle di resume nativi, modello, e
impostazioni di effort diverse, questi vengono resi persistenti **con scope per provider**
(`session_id` di Claude + `claude_model`/`claude_reasoning_effort`; `codex_thread_id` di
Codex + `codex_model`/`codex_reasoning_effort`). `AgentHost` seleziona il backend, genera
una sessione per chat, e ritrasmette gli `AgentEvent` di ciascuna sessione al
renderer + alla persistenza.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

L'MCP dell'editor per-slot viene passato al backend allo spawn: `SpawnOpts.mcpServers`
trasporta l'endpoint dell'editor Unity/Unreal della chat (`{ type: 'http', url }`),
registrato in memoria nelle opzioni dell'SDK — nulla scritto su disco. Solo il
backend con capability `mcpHttp` lo consuma. Vedi **MCP dell'editor per-slot** più sotto.

Il callback `canUseTool` vive accanto al backend, non nel prompt dell'agente — è il nostro confine di sicurezza a veto assoluto. La risoluzione delle regole (`resolveRule`) consulta le regole di permesso per-chat e poi quelle globali prima di chiedere conferma. Vedi [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md).

## Persistenza

- **`better-sqlite3`** in `<userData>/popbot.db` (macOS: `~/Library/Application
  Support/PopBot/`; equivalente per-OS `app.getPath('userData')` su Windows /
  Linux). Lo schema è un elenco di migrazioni numerate in `persistence/db.ts`
  (gated da `user_version`, ogni step atomico). Tabelle attuali:
  - `chats` — una riga per chat: lease dello slot (`slot_id`), `worktree_path`, `repo_id`,
    `agent` attivo, modello/effort per provider + handle di resume (`session_id`,
    `codex_thread_id`), `permission_rules`, e stato cross-slot (`p4_shelf_cl`).
  - `messages` — una riga per evento dell'agente (la trascrizione durevole).
  - `repos` — configurazione per repository (percorso, colore, prefisso slot, base predefinita, numero di slot,
    `mode` = `slots`/`ephemeral`, `scm`, JSON `p4_config`).
  - `settings` — preferenze dell'app come coppie chiave/valore JSON (riferimenti alle credenziali di integrazione, preferenze UI).
  - `notifications` — il feed delle notifiche in-app.
  - `sdk_session_entries` — tabella di backing del SessionStore dell'SDK Claude (con chiave chat;
    PopBot possiede la copia di recovery così il resume non dipende dai JSONL in `~/.claude`).
  - `codex_thread_events` — cache durevole degli eventi grezzi dello stream Codex (Codex riprende
    da `~/.codex/sessions`; questa è la copia di recovery/diagnostica propria di PopBot).

  Non c'è **nessuna** *tabella* di cache ticket/PR: le code Tickets e Reviews fanno caching
  nel renderer (vedi i commenti IPC di `list-recent`), non in SQLite.
- **Lo scratch per-slot** vive nel worktree/mount dello slot e nelle directory di runtime
  per-chat (file di sessione della CLI dell'agente, PTY, allegati conservati). Gli slot VHDX di shado vivono
  sul drive del repository sotto `…/popbot/workspaces/<repoId>/…` (vedi la sezione shado).
- **I segreti** tramite `keytar` (keychain del SO — macOS Keychain / Windows Credential
  Vault / libsecret). Mai nel database SQLite, mai nei log.

## Fonti dei ticket, provider SCM, review, editor, aggiornamenti

Cinque punti di estensione (seam) dei provider a cui si agganciano i sottosistemi di primo livello — tutti
progettati così che aggiungere un backend sia locale, e i chiamanti restino generici:

- **Fonti dei ticket** (`tickets/`). Un `TicketSource` attivo alimenta la coda Tickets,
  scelto dall'impostazione `ticketSource` tramite `tickets/registry.ts` (Linear /
  Jira / GitHub; default Linear). Ogni fonte normalizza verso i DTO Linear condivisi,
  così il renderer visualizza tutti i tracker attraverso un unico percorso e si ramifica solo sulle
  capability in `shared/ticketProvider.ts`, mai sul provider id. Aggiungere un
  tracker è una riga nel registry + un `*Source.ts` + un descrittore.
- **Provider SCM** (`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`
  è la piccola superficie comune (lifecycle del workspace, review del working-tree, rilevamento
  PR/review, continuità cross-slot). `GitProvider` e `PerforceProvider` sono reali;
  `lore` è abbozzato. `scm/index.ts` restituisce un'istanza per id. **I chiamanti si ramificano
  sulle CAPABILITIES (`shared/sourceControl.ts`), mai sul provider id** — qualunque cosa
  non si astragga in modo pulito è un flag di capability, e un provider troppo divergente
  aderisce a una propria finestra client tramite `capabilities.nativeClientUi`.
- **Review** (`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`). Un
  orchestratore agnostico rispetto al provider raggruppa i repository configurati per SCM e li
  smista ai metodi di review di ciascun provider (gated da `capabilities.pullRequests`), unendo
  le PR GitHub e le review Helix Swarm in un unico pannello. Ogni provider possiede la propria
  **cadenza di polling** (`reviewPollIntervalMs` — Swarm più lento di GitHub per proteggere un
  p4d condiviso), e il pannello esegue un timer per provider (`pb:reviews:providers` /
  `pb:reviews:list-for`).
- **MCP dell'editor per-slot** (`ipc/apps.ts`, `shared/gameEngine.ts`). I motori
  (Unity / Unreal / custom) sono abilitabili in modo indipendente. Quando `useMcp` è attivo, l'editor
  di ogni slot viene avviato con una **porta MCP per-slot** (`mcpBasePort + (slotId-1)`)
  così gli editor paralleli non entrano in collisione, e `mcpEndpointForChat` passa all'agente
  l'URL HTTP MCP dell'editor di quello slot allo spawn. Gli editor vengono avviati **detached**
  (focus-o-avvio), non come child a lunga vita supervisionati.
- **Aggiornamenti** (`updates/`). Auto-update electron-updater con un fallback di
  download manuale per le build non firmate, più un controllo on-demand per la finestra
  About (`pb:updates:*`).

## Trasversale

- **Logging** — il main scrive log diagnostici tramite `diagLog` (`dlog`); la CLI dell'agente
  e il PTY trasportano il proprio output di runtime per-chat; i log del renderer instradano attraverso il main
  via IPC.
- **Recovery all'avvio** — la recovery è guidata da DB e sessione, non basata su file PID
  (sequenza di boot in `main/index.ts`): `initDb()` esegue le migrazioni pendenti;
  `clearStaleRunningStatuses()` riporta a `idle` ogni chat rimasta in `run` (la
  sessione dell'agente di un'esecuzione precedente non esiste più); l'import del session-store + la
  migrazione della project-dir SDK + `sessionPinRepair` + `recoverChatSessions` riconciliano le sessioni
  Claude/Codex fissate (pinned) con ciò che è effettivamente su disco; i probe della CLI riportano
  quali backend sono online. Su Windows, gli slot VHDX di shado disconnessi (un riavvio
  ha fatto cadere i loro mount) vengono rilevati e mostrati per un re-mount a un solo UAC (vedi la
  nota **Riavvio** di shado più sopra).
- **Aggiornamenti** — auto-update electron-updater; vedi il provider **Aggiornamenti** più sopra.
