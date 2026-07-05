*Languages: [English](../CORE_MODEL.md) · [Español](../es/CORE_MODEL.md) · [Français](../fr/CORE_MODEL.md) · [Deutsch](../de/CORE_MODEL.md) · [日本語](../ja/CORE_MODEL.md) · [한국어](../ko/CORE_MODEL.md) · [简体中文](../zh-CN/CORE_MODEL.md) · [Português (Brasil)](../pt-BR/CORE_MODEL.md) · [Русский](../ru/CORE_MODEL.md) · **Italiano***

# Modello di base

Il grafo di oggetti su cui è costruita l'app di PopBot. Tutto il resto — IPC,
persistenza, pannelli UI, il loop dell'agente — dipende da questi. Se cambi
un comportamento in un modo che viola una regola qui descritta, **aggiorna
prima il modello oppure comunica all'utente che il modello sta cambiando.**

Per "dove vive il codice?" vedi [ARCHITECTURE.md](ARCHITECTURE.md).
Per "cosa vede l'utente?" vedi [USER_STORIES.md](USER_STORIES.md).

---

## TL;DR — i quattro sostantivi che contano

| Sostantivo | Durevole? | Proprietario | Ciclo di vita |
|---|---|---|---|
| **Chat** | sì (SQLite) | main | creata dall'utente, vive finché non viene eliminata esplicitamente |
| **Message** | sì (SQLite, quasi solo in append) | main | figlio di Chat |
| **Slot** | sì (filesystem + riga SQLite) | main / `SlotManager` | creato raramente, riutilizzato; mai per-chat |
| **AgentSession** | **no** (solo in memoria) | main / `AgentHost` | generata quando una Chat passa a "running"; distrutta alla chiusura della Chat o all'uscita dell'app |

Tutto ciò che si trova nel renderer è una **vista** su questi elementi. Il
renderer non possiede mai lo stato canonico.

---

## Sostantivi durevoli (sopravvivono al riavvio)

### Chat

L'unità di lavoro dell'utente. Un ticket, una revisione di PR, un thread
Slack, una sessione di "esplorazione della codebase" — ognuno è una Chat.

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

**Ciclo di vita dello stato** (US-6 — cosa colora la miniatura):

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

**Lo stato è descrittivo, non prescrittivo** — deriva dall'AgentSession
quando ce n'è una collegata, e viene persistito nel DB a ogni transizione.
Una chat in stato `idle` significa "nessun agente sta lavorando in questo
momento." Non significa "la chat è chiusa."

**Aperta vs chiusa:** una chat è "aperta" se e solo se `closedAt IS NULL`.
Le chat aperte vengono caricate in memoria all'avvio; le chat chiuse sono
solo interrogabili. **Chiudere una chat rilascia il lease del suo slot e
distrugge la sua AgentSession, ma non elimina mai i Message.**

### Message

Log eventi quasi solo in append all'interno di una Chat. La trascrizione è
una sequenza di record tipizzati:

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

**Perché JSON in `body`?** Ogni `kind` ha una forma di payload diversa
(testo vs chiamata a tool vs richiesta di permesso) e il renderer smista in
base a `kind`. Memorizzarlo come blob JSON tipizzato mantiene la tabella
piatta e il codice del renderer onesto.

**"Quasi solo append":** le righe `tool` e `permission` vengono mutate **una
sola volta**:

- righe `tool`: scritte su `tool-use` (nome + argomenti), aggiornate su
  `tool-result` (compilano `result` + `isError`).
- righe `permission`: scritte su `permission-request` (tool + argomenti +
  motivo), aggiornate alla decisione dell'utente (imposta `decision`).
- righe `text`: scritte su `message-start` con testo vuoto, **coalescenti**
  in un piccolo buffer in memoria man mano che arrivano eventi `text-delta`,
  scaricate su `message-end` (e ogni ~250 ms per mantenere il renderer
  aggiornato). Una riga per "turno di prosa dell'agente," non una riga per
  delta.

**Nessuna cancellazione a cascata dal ripristino del lavoro dell'agente.**
Se un agente commette un errore e vuoi che "riprovi," invii un nuovo
messaggio utente. La vecchia trascrizione rimane. Il modello non riscrive
mai silenziosamente la cronologia.

### Slot

Uno spazio di lavoro caldo, isolato, usa e getta: un checkout isolato su una
cartella copy-on-write (un Git worktree, o un client Perforce) + una cache
di build calda (ad es. la cache asset/import di un motore) + (opzionalmente)
un editor in esecuzione per l'app sotto test (Unity, Unreal, o un motore
personalizzato) + (opzionalmente) un server sidecar in esecuzione. **Creato
raramente, riutilizzato continuamente.** Gli slot appartengono all'utente /
all'app, non alle Chat.

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

**Il binding Slot ↔ Chat** è **transitorio** — vive in `slot.leasedByChatId`
e nei metadati di runtime della Chat corrispondente. All'avvio lo si
riconcilia percorrendo gli slot e confrontandoli con le chat aperte. I lease
obsoleti (chat chiusa, lease mai rilasciato) vengono ripuliti.

Per il ciclo di vita completo dello slot vedi [POPBOT_DESIGN.md → Slot](POPBOT_DESIGN.md#slot--lunità-durevole).

### Permission grant

Una decisione durevole dell'utente secondo cui una determinata combinazione
tool / target è approvata senza richiedere nuovamente conferma. Due ambiti:

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

`tool` può essere un wildcard finale con `*`, così un intero server MCP può
essere autorizzato con un unico grant (`allow-mcp-server` → `mcp__<server>__*`)
— è così che l'MCP dell'editor di uno slot viene autorizzato una volta sola
invece che tool per tool. Le regole di **deny** vincono sempre sulle allow, e
un pattern più specifico vince su uno più generico (vedi `resolvePermissionRules`
in `src/shared/agent.ts`).

I grant si accumulano per chat (US-9: "consenti sempre il git push per
questa chat"). Le **regole di deny** hard-coded in
[adr/0004](../adr/0004-canusetool-policy-boundary.md) non sono memorizzate qui
— vivono nel codice e non possono essere sovrascritte.

### Settings

Due livelli:

- **Preferenze globali**: tema, tipo di chat predefinito, numero di slot,
  cadenza di refresh della Library principale, ecc. Tabella a una riga.
- **Override per-chat**: modalità server, scala temporale, modalità
  finestra, budget di token, ecc. Memorizzati in una tabella `chat_settings`
  indicizzata per `chatId`.

Entrambi possono essere vuoti (si applicano i default). Mutati tramite i
pannelli Settings nel renderer.

### Elementi di attenzione in cache

Le code dell'utente di ticket assegnati (Linear / Jira / GitHub Issues) e
revisioni in sospeso (PR GitHub / changelist Helix Swarm). Messi in cache
localmente così i pannelli si renderizzano istantaneamente; aggiornati a
scadenza + su richiesta.

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

Le fonti dei ticket sono intercambiabili dietro un provider comune (Linear,
Jira, GitHub Issues); lo stesso vale per le fonti di revisione (PR GitHub,
Swarm). In cache, non autoritative — la fonte di verità è il tracker /
sistema di revisione stesso.

---

## Sostantivi di runtime (in memoria; non sopravvivono al riavvio)

### AgentSession

L'elemento che comunica con l'LLM. Una AgentSession per ogni Chat
"running". Sostenuta da un `AgentBackend` (l'Claude Agent SDK o il Codex
SDK; entrambi disponibili oggi).

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**Posseduta da `AgentHost`** (un singleton nel processo main). AgentHost
mantiene una `Map<chatId, AgentSession>`. Le sessioni vengono create
pigramente al primo `agent.send` per una chat e distrutte alla chiusura
della chat.

**Le sessioni emettono `AgentEvent`** (vedi `src/shared/agent.ts`).
AgentHost intercetta ogni evento e:

1. Lo **persiste** (i delta confluiscono in una riga di testo; tool-use crea
   una riga tool; permission-request crea una riga permission).
2. Lo **ritrasmette** al renderer tramite `webContents.send`. Il renderer è
   uno degli N sottoscrittori; main è il registratore autoritativo.
3. **Aggiorna i metadati della Chat** — `status`, `snippet`, `tokensUsed`,
   `lastActiveAt` vengono aggiornati progressivamente man mano che arrivano
   gli eventi.

**Le sessioni non scrivono mai direttamente sul DB.** Solo AgentHost lo fa.
Questo mantiene disaccoppiata l'evoluzione dello schema di persistenza dagli
scambi di backend.

### Permission request (in corso)

Quando scatta il callback `canUseTool` dell'SDK:

1. PolicyEngine valuta: hard-allow (automatico), hard-deny (automatico),
   oppure chiedi all'utente.
2. Se "chiedi all'utente," AgentHost emette un evento `permission-request`
   al renderer **e mette in pausa il callback dell'SDK** — indicizzato per
   `permissionId` — in una mappa in sospeso.
3. Il renderer mostra la modale; l'utente clicca la decisione; IPC torna a
   main.
4. AgentHost cerca il callback in sospeso e lo risolve. L'SDK procede o
   abortisce.
5. Se è stato selezionato "consenti sempre," viene scritta una riga
   `PermissionGrant`.

Le richieste in sospeso **non vengono persistite**. Se l'app va in crash
durante la decisione, la chiamata a tool dell'agente viene annullata al
riavvio.

### Handle del supervisore dei processi

Per ogni slot: un `child_process.ChildProcess` per l'editor dell'app sotto
test (Unity / Unreal / motore personalizzato — il campo `unityPid` registra
il suo PID indipendentemente dal motore), un altro per il server sidecar.
Posseduti da `SlotManager`. Controllati in salute tramite liveness del PID +
probe HTTP. Terminati al rilascio dello slot / alla chiusura dell'app.
**Riconciliati all'avvio** percorrendo il file `slot.json` della directory
dello slot e verificando che i PID registrati siano ancora vivi.

---

## Regole di ownership

Queste sono **invarianti**. Il codice che le viola è un bug.

1. **Il renderer è pura vista.** Nessun fs, nessun child_process, nessun
   accesso al DB. Parla con main esclusivamente tramite il bridge tipizzato
   `window.popbot.*`.

2. **Main è l'unico writer del DB.** Il renderer legge tramite IPC; non
   tocca mai `popbot.db`.

3. **AgentHost è l'unica cosa che muta status / snippet / token della Chat
   durante una sessione.** Altro codice può leggere questi campi ma non può
   scriverli mentre una sessione è attiva per quella chat. (Le mutazioni
   guidate dall'utente come il rinomino avvengono quando nessuna sessione è
   attiva, oppure vengono accodate.)

4. **I backend non scrivono mai sul DB.** Emettono eventi; AgentHost li
   persiste. Questo mantiene ClaudeBackend / CodexBackend / StubBackend
   intercambiabili senza intreccio con lo schema del DB.

5. **PolicyEngine è l'unica fonte di verità per "questo tool può essere
   eseguito?"** Nessun backend lo bypassa. I permission grant passano
   attraverso di esso.

6. **Il binding Slot ↔ Chat è transitorio.** Il record Chat non nomina mai
   uno slot. Il record Slot nomina la chat che detiene il lease (puntatore
   debole, riconciliato all'avvio).

7. **La trascrizione non muta mai silenziosamente.** Si aggiungono nuove
   righe; gli aggiornamenti una tantum sulle righe tool/permission sono
   espliciti e limitati.

---

## Flusso di stato — un singolo messaggio utente, end-to-end

Un esempio pratico del modello in azione.

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

Due cose da notare:

- **Il renderer non decide mai nulla.** Smista gli intenti e si
  ri-renderizza a partire dagli eventi.
- **Le scritture sul DB avvengono nello stesso punto delle notifiche al
  renderer.** Sono vincolate dallo stesso handler in AgentHost. Questo
  significa che un crash del renderer non può causare disallineamento della
  persistenza.

---

## Flusso di recovery — riavvio a freddo

US-7 in forma di codice. L'app si chiude in modo non pulito. Ore dopo,
l'utente la riapre:

1. **Inizializzazione DB** — `initDb()` apre `popbot.db`, esegue le
   migrazioni in sospeso.
2. **Riconciliazione slot** — percorre
   `~/Library/Application Support/PopBot/slots/`, per ogni slot legge
   `slot.json`, verifica che `unityPid` / `serverPid` siano vivi (`kill -0`);
   se morti, marca lo slot come libero e azzera i PID. Risolve eventuali
   lease orfani (chat inesistente, o chat il cui `closedAt` è impostato).
3. **Chat aperte** — `listOpenChats()` restituisce le chat con
   `closedAt IS NULL`, ordinate per `lastActiveAt DESC`. Il renderer le
   richiede al primo rendering.
4. **Nessuna generazione automatica di agenti.** Le sessioni vengono
   generate pigramente al primo `agent.send`. Un utente che apre una vecchia
   chat vede semplicemente la trascrizione; l'agente non riprende da dove
   aveva lasciato finché l'utente non lo sollecita.
5. **Lease dello slot su richiesta.** Allo stesso modo — il leasing avviene
   quando il tipo di chat lo richiede (Client/Server Test) e un tool che
   richiede Unity sta per essere invocato.

Il risultato: l'apertura dell'app è veloce (lettura DB + ping slot), ed è
possibile ispezionare la cronologia di qualsiasi chat senza pagare il costo
di generazione dell'agente.

---

## Intercambiabilità dei backend

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** avvolge `@anthropic-ai/claude-agent-sdk`. Il default.
- **CodexBackend** avvolge `@openai/codex-sdk` (che guida `codex exec`).
  Disponibile. Ogni backend dichiara le proprie `capabilities` e la UI le
  rileva automaticamente per ogni chat.
- **StubBackend** fa eco al testo dell'utente con uno stream fittizio.
  Usato per la validazione del cablaggio + test UI.

Il campo `agent` del record della chat seleziona quale backend AgentHost
genera.

---

## Cosa NON è intenzionalmente nel modello

- **Workflow / DAG / catene di approvazione.** Una chat è una conversazione.
  Non stiamo modellando pipeline.
- **Multi-utente.** Un singolo sviluppatore per macchina; nessuna
  autenticazione, nessuna condivisione.
- **Notebook / query salvate / template.** Tutti emergenti dalla
  trascrizione; nessun tipo di prima classe per ora.
- **Snapshot di chat versionati / trascrizioni ramificate.** La
  trascrizione è lineare. Biforcare una chat = creare una nuova chat
  inizializzata a partire dalla cronologia della vecchia (una funzionalità
  futura, non presente nel modello oggi).

Se dovesse servire uno di questi elementi, va aggiunto prima qui, poi nel
codice.
