<div align="center">

![PopBot — a battle-tested multi-chat & multi-slot agentic coding tool](../../images/hero_banner_2.png)

Uno strumento desktop collaudato sul campo per eseguire in parallelo un team di agenti di coding IA — uno per ticket, bug o revisione, ciascuno isolato nel proprio "slot" caldo, ciascuno in grado di compilare, eseguire e testare la tua app end-to-end.

[Perché PopBot](#perché-popbot) · [Funzionalità](#funzionalità-principali) · [Come funziona](#anatomia-dello-spazio-di-lavoro) · [Una giornata con PopBot](#una-giornata-con-popbot) · [Installazione](#installazione) · [Rendilo tuo](#rendilo-tuo)

</div>

*Languages: [English](../../README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [简体中文](../zh-CN/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Русский](../ru/README.md) · **Italiano***

---

## Perché PopBot

Eseguire un singolo agente di coding IA è semplice. Eseguirne molti contemporaneamente introduce problemi che un singolo agente non ha: mantenere il loro lavoro isolato in modo che non si sovrascrivano a vicenda, testare effettivamente ciò che costruiscono, revisionarlo e sottoporre a gate le azioni irreversibili in modo che nessun agente ne compia una senza supervisione.

PopBot è un layer di orchestrazione per tutto questo. Trasforma ticket e richieste di revisione in sessioni agente a un clic, assegna a ogni agente uno spazio di lavoro isolato (una propria copia di lavoro — e, per i progetti di gioco, una propria istanza in esecuzione dell'app sotto test), li esegue in autonomia per impostazione predefinita con un gate umano sulle azioni rischiose, e raccoglie ogni transcript, diff, terminale e log in un'unica finestra. L'operatore scorre le colonne, approva le azioni sottoposte a gate e rilascia.

È stato costruito da un piccolo team di **Proof of Play** e usato quotidianamente su un progetto di produzione reale, ricco di asset, che è stato pubblicato. Questo è l'ambiente in cui è stato collaudato: molti gigabyte di asset, source control reale, scadenze reali. Il modello a slot — spazi di lavoro caldi, isolati, copy-on-write — è ciò che ha reso praticabile l'esecuzione di agenti in parallelo in quel contesto, e ha aumentato quanto il team riusciva a portare a termine contemporaneamente. Pubblichiamo e supportiamo PopBot come implementazione di riferimento: non un prodotto finito da consumare così com'è, ma una forma da prendere e rimodellare per il proprio stack e flusso di lavoro. Questo riflette una visione su come il software si costruisca al meglio nell'era dell'IA — che i team che gestiscono flotte di agenti sono meglio serviti possedendo e modificando lo strumento piuttosto che adottandone uno fisso. È concesso in licenza MIT ed è organizzato per essere forkato; vedi [Rendilo tuo](#make-it-yours).

![The PopBot workspace — the thumbnail strip, side-by-side chat columns, and a per-chat terminal](../../images/screenshot1.png)

<div align="center"><em>Una sessione PopBot reale — diversi agenti che lavorano in parallelo, ciascuno nel proprio slot. Miniature live in alto, chat in primo piano nelle colonne, un terminale per chat sotto, e il pannello del source control a destra.</em></div>

## Funzionalità principali

### Vista multi-chat con miniature live

Ogni chat aperta resta a schermo — una striscia di **miniature live** sopra **colonne** affiancate. Ogni miniatura è una vista reale, aggiornata, di quella chat (non solo un indicatore di stato), colorata in base allo stato: in esecuzione, completata, in attesa di te, errore. A colpo d'occhio vedi *cosa sta facendo ogni agente* e chi ha bisogno di te — e puoi **individuare presto un percorso sbagliato**, reindirizzando prima che bruci tempo e token. Una sola persona supervisiona un'intera flotta da un'unica finestra.

### Slot caldi — agenti in parallelo senza la tassa di re-importazione

Ogni chat di lavoro assegna in leasing uno **slot** — una copia di lavoro persistente più il proprio stato di build caldo, creato una volta e riutilizzato. Per un motore di gioco questo significa che lo slot mantiene la propria cache di asset calda (la `Library` di Unity, la DDC di Unreal) e può mantenere l'editor in esecuzione, così riportare un agente nel proprio slot richiede **secondi, non una re-importazione di più minuti**. Dieci agenti girano in vero isolamento di branch senza saturare un'unica cache di importazione. [Come funzionano gli slot →](GUIDE.md#slot-workspace-caldi-isolati-usa-e-getta)

### Copie illimitate sul disco di un solo repository

Lo spazio di lavoro di uno slot è una **cartella copy-on-write**: ogni slot condivide un'unica immagine base e memorizza solo ciò che cambia. Così una copia fresca, live e completa di un albero di gioco su **scala terabyte** è pronta in **secondi** — file reali e modificabili, non una vista superficiale — e copie illimitate costano il disco di un singolo repository. Funziona su **Windows, macOS e Linux**, ed è ciò che permette ad alberi Perforce enormi di unirsi alla flotta. [Perché è importante →](GUIDE.md#copy-on-write-copie-illimitate-sul-disco-di-un-solo-repo)

### Git e Perforce, con la revisione integrata

Il source control è un **provider** dietro un'unica interfaccia: **Git** (worktree, branch, PR tramite `gh`) e **Perforce** (stream su shadow workspace, changelist, revisioni **Helix Swarm**) sono entrambi di prima classe. Un pannello di source control ambito allo *spazio di lavoro proprio di ogni chat* mostra stato, commit e diff per file per esattamente quel branch. Azioni templated a un clic (**Commit**, **Push PR**, **Rendi pronta**, **Rispondi alla CR**, **Rebase sul base**) inviano un'istruzione precompilata all'agente di quella chat, con `${branch}` / `${ticket}` / `${prnum}` già valorizzati.

### Una inbox, molte fonti

L'intero ciclo in un unico posto: la tua **inbox** — ticket assegnati da **Linear**, **Jira** e **GitHub Issues**, più revisioni in attesa di te come **GitHub PR** e **changelist Swarm** → lavoro dell'agente **in corso** in slot isolati → **push** e apertura della PR / revisione → **archiviazione** di una chat completata → **riapertura e riavvio** più tardi con la cronologia completa. Clicchi un ticket e PopBot nomina il branch, assegna in leasing uno slot, sposta il ticket in *In Progress* e avvia l'agente — poi lo accompagna fino a una modifica mergiata e ritorno. [Percorsi di lavoro passo passo →](GUIDE.md#flussi-di-lavoro-end-to-end)

## Funzionalità aggiuntive

- **Il vero Claude Code e Codex — non una reimplementazione.** Ogni chat guida l'agente *reale* tramite il suo SDK ufficiale — le stesse CLI `claude` e `codex` che eseguiresti in un terminale, con tutti i loro tool, skill e server MCP intatti. Scegli il modello (Opus / Fable / GPT) e lo sforzo di ragionamento per chat, cambia a metà sessione, o riavvia una sessione nuova innescata con la cronologia della chat.
- **Agenti che testano il proprio lavoro.** Uno slot può avviare l'app reale — per Unity e Unreal, un editor live + un server sidecar su un secondo display, guidato dall'agente tramite un server MCP in-editor su una **porta per slot** — così l'agente naviga l'interfaccia, legge i log e verifica le proprie modifiche invece di indovinare. Sono supportati anche motori personalizzati.
- **Chat persistenti e archiviabili.** Ogni chat è un transcript durevole; chiudila per liberare il suo slot, e riaprila più tardi con la cronologia completa intatta.
- **Terminale per chat e codice cliccabile.** Un terminale integrato ancorato allo spazio di lavoro della chat, e link `file.ts:42` che si aprono in VS Code o Cursor.
- **Autonomi, ma mai avventati.** Gli agenti eseguono automaticamente il lavoro sicuro all'interno del proprio slot e si fermano per te su qualsiasi cosa rischiosa — `git push` / `p4 submit`, apertura di PR, qualsiasi cosa al di fuori dello spazio di lavoro, chiamate di rete. Le concessioni sono per chat, durevoli e revocabili — server MCP inclusi.
- **Completamente localizzato.** L'intera interfaccia è disponibile in otto lingue (inglese, spagnolo, francese, tedesco, giapponese, coreano, cinese semplificato, portoghese brasiliano), commutabile in qualsiasi momento dal menu delle lingue.
- **Multi-repository.** Gestisci più repository fianco a fianco, ciascuno con il proprio pool di slot, colore, provider e convenzioni di branch.

## In cosa PopBot è diverso

Gli strumenti di coding agentico tendono a rientrare in alcune categorie. PopBot si colloca in un punto diverso: una **cabina di comando locale per eseguire molti agenti *reali* in parallelo, con stato di build caldo e supervisione umana dal vivo.**

| Invece di… | …PopBot |
|---|---|
| **Un agente in un terminale o IDE** — un singolo task in un singolo working tree alla volta | **Molti agenti alla volta**, ciascuno isolato nel proprio slot caldo, tutti visibili come una flotta live che guidi da un'unica finestra |
| **Agenti cloud asincroni** — opachi e remoti; invii un task, aspetti una PR | **Locale e live** — osservi ogni agente lavorare e individui presto un percorso sbagliato, e guida *la tua app reale* (un editor del motore su un secondo schermo) per un test end-to-end genuino |
| **Giocoleria fai-da-te con `tmux` + worktree** — parallela ma manuale, e ogni checkout fresco paga la tassa di re-importazione di più minuti del motore | **Slot caldi gestiti** — spazi di lavoro riutilizzati, copy-on-write, che mantengono calda la cache degli asset, con ciclo di vita di branch/workspace, il pannello SCM e la revisione del codice gestiti per te |
| **Framework di orchestrazione di agenti** — toolkit per *costruire* sistemi di agenti | **Un'app finita e con un'opinione precisa** collegata alla tua inbox e al tuo ciclo di revisione — human-in-the-loop per design, non una libreria da assemblare |

E in modo critico: PopBot non sostituisce Claude Code o Codex — li **esegue**. Ottieni esattamente gli agenti (e le tue esatte versioni CLI) di cui ti fidi già, semplicemente in tanti alla volta, con l'orchestrazione, l'isolamento e la supervisione avvolti attorno a essi.

## Anatomia dello spazio di lavoro

![PopBot UI anatomy](../../images/anatomy.png)

| Regione | Cos'è |
|---|---|
| **Inbox — ticket e revisioni** | Ticket assegnati (Linear / Jira / GitHub Issues) e revisioni in attesa di te (GitHub PR / changelist Swarm), classificati. Un clic genera una chat. |
| **Slot** | Il pool di spazi di lavoro caldi e isolati — una copia di lavoro copy-on-write *più* stato di build persistente (per un motore di gioco, la propria cache di asset calda). Una chat ne assegna in leasing uno mentre lavora e lo restituisce alla chiusura. |
| **Archivio chat** | Ogni chat passata, ricercabile e riapribile con la cronologia completa. |
| **Miniature chat** | Una striscia live di tutte le chat aperte — colorata in base allo stato (in esecuzione / completata / serve a te / errore). |
| **Chat** | Le sessioni agente in primo piano: prosa, chiamate di tool e diff di codice inline, in streaming live. |
| **Terminale per chat** | Un terminale integrato puntato allo spazio di lavoro di quella chat, per comandi manuali. |
| **Pannello SCM** | Stato del working tree / changelist, commit, diff dei file e azioni a un clic di commit / push / PR / revisione. |

## Una giornata con PopBot

**Un ticket di funzionalità.** Un ticket arriva nella tua inbox. Clicchi su di esso → PopBot apre una chat su `you/eng-123-…`, assegna in leasing uno slot, sposta il ticket in *In Progress* e consegna all'agente la descrizione completa. Scrive il codice, esegue l'app nel proprio slot per verificare, e si ferma in attesa del tuo OK prima di fare il push. Rivedi il diff nel pannello SCM e premi **Push PR**.

**Un bug, in parallelo.** Mentre questo è in corso, arriva una segnalazione di bug. Generi una seconda chat — un proprio slot, un proprio branch — e i due agenti lavorano simultaneamente senza mai toccare l'albero l'uno dell'altro. La striscia di miniature mostra entrambi: uno verde (completato), uno blu (in esecuzione).

**Una richiesta di revisione.** La PR di un collega (o una changelist Swarm) compare nella tua scheda Revisioni. Clicchi su di essa → si apre istantaneamente una chat di revisione **senza repository**, l'agente legge il diff *e* il codice circostante, cerca bug reali e pubblica una revisione inline su GitHub o Swarm — mentre le tue due chat di build continuano a girare.

**La riprendi domani.** Chiudi le chat completate per liberare i loro slot. La mattina successiva, riapri la chat della funzionalità dall'archivio per rispondere al feedback della revisione — l'agente riprende con l'intera conversazione e il suo spazio di lavoro intatti.

→ Percorsi completi (flussi di funzionalità, bug e revisione, più come funzionano dietro le quinte slot, spazi di lavoro copy-on-write e riapertura) sono nella **[Guida a funzionalità e flussi di lavoro](GUIDE.md)**.

## Installazione

Installer prebuilt e firmati sono disponibili su **[popbot.app](https://popbot.app)**:

- **macOS** — `.dmg` firmato e notarizzato (Apple silicon)
- **Windows** — installer `.exe` firmato
- **Linux** — pacchetto `.deb`

L'app si aggiorna automaticamente dal proprio canale di rilascio. Per eseguire una build propria, vedi [Compilare dal codice sorgente](#compilare-dal-codice-sorgente).

## Compilare dal codice sorgente

```bash
npm install
npm run dev        # run the app in development
npm run package    # build a signed installer for your platform
```

**Requisiti**

- **macOS, Windows o Linux.** macOS è la piattaforma più collaudata (il flusso con l'app sotto test sul secondo display si appoggia alle API di Accessibilità di macOS); Windows e Linux sono supportati e distribuiti — vedi [WINDOWS.md](WINDOWS.md) per le note di configurazione Windows/WSL.
- **Node 20+** (Node 20 / 22 evitano una ricompilazione di moduli nativi; vedi le note su Windows).
- Le CLI **`claude`** e/o **`codex`** (i backend agente), più **`git`** e, per i flussi GitHub, **`gh`**. Per Perforce, la CLI **`p4`**.
- Le credenziali (Linear, Jira, GitHub, Helix Swarm) sono memorizzate **localmente sulla tua macchina**, nel database proprio dell'app — mai in questo repository.
- Opzionale: un editor Unity o Unreal per progetti di gioco; VS Code / Cursor; iTerm.

## Rendilo tuo

PopBot è pubblicato come implementazione di riferimento, pensato per essere forkato e adattato piuttosto che adottato così com'è. La sua forma è generale — **agenti + slot isolati, caldi, copy-on-write + una inbox-come-coda + un'app sotto test** — e il codice è organizzato come *provider dietro piccole interfacce comuni*, così un team può sostituire una parte senza toccare il resto. È **concesso in licenza MIT**. L'approccio generale è mantenere le idee centrali e sostituire le istanze specifiche:

- **Sostituisci l'app sotto test.** Unity e Unreal sono due implementazioni di "lascia che l'agente esegua e verifichi l'app". L'hook per motore personalizzato passa già l'identità dello slot al tuo comando di avvio — puntalo alla tua app web, CLI o test harness. *(`src/shared/gameEngine.ts`, `src/main/ipc/apps.ts`)*
- **Punta l'inbox altrove.** Linear, Jira e GitHub Issues sono esempi funzionanti; aggiungi un tracker implementando un'interfaccia e registrandolo. *(`src/main/tickets/`)*
- **Aggiungi o sostituisci il source control.** Estendi la classe base del provider accanto a Git e Perforce; i chiamanti si ramificano in base alle *capacità*, mai in base all'id del provider. *(`src/main/scm/`)*
- **Ricablega le azioni e i prompt.** Convenzioni di branch, flussi di PR/revisione e ogni prompt seminato sono template modificabili nelle Preferenze — nessun codice richiesto.
- **Mantieni il nucleo.** Slot caldi, spazi di lavoro copy-on-write, chat persistenti, il pavimento di permessi hard-coded e la cabina di comando per agenti paralleli sono la spina dorsale durevole.

La **[Guida a funzionalità e flussi di lavoro](GUIDE.md)** spiega il ragionamento dietro ogni giuntura; il documento **[Architettura](ARCHITECTURE.md)** mappa dove trovarla nel codice.

## Documentazione

| Documento | Cosa contiene |
|---|---|
| **[Guida a funzionalità e flussi di lavoro](GUIDE.md)** | Il tour completo — le idee, come funziona ogni parte, e i flussi di lavoro end-to-end. Inizia da qui. |
| **[Guida alla configurazione](CONFIGURATION.md)** | Configura ogni pannello delle Preferenze — integrazioni, repository, slot, agenti — con screenshot. |
| [USER_STORIES.md](USER_STORIES.md) | Le user story rispetto a cui PopBot è stato misurato. |
| [CORE_MODEL.md](CORE_MODEL.md) | Il modello a oggetti — Chat, Message, Slot, AgentSession — e i loro cicli di vita. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Confini di processo, IPC, dove risiede ogni sottosistema. |
| [WINDOWS.md](WINDOWS.md) | Note di configurazione Windows / WSL. |
| [POPBOT_DESIGN.md](POPBOT_DESIGN.md) | La specifica di design originale (storica). |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Configurazione dello sviluppo locale, script, convenzioni. |

## Licenza

[MIT](../../LICENSE) © 2026 Proof of Play, Inc. I componenti di terze parti e i marchi sono elencati in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) — nota che la dipendenza runtime `@anthropic-ai/claude-agent-sdk` è proprietaria e utilizzata secondo i termini di Anthropic, non la licenza MIT.
