# PopBot — Guida alle funzionalità e ai flussi di lavoro

PopBot è un cockpit desktop per eseguire **molti agenti AI di coding in parallelo**. Questa guida copre le idee su cui è costruito — perché esiste, come funzionano i pezzi, cosa ha plasmato il design, e come un team di Proof of Play lo ha usato su un progetto reale, ricco di asset, che è stato rilasciato. È scritta per ingegneri capaci di trovare l'UI da soli; il punto qui è il ragionamento, così puoi adattare lo strumento al tuo flusso di lavoro invece di seguire un copione.

Adattarlo al tuo flusso di lavoro è un uso previsto, non un ripiego. PopBot è pubblicato come implementazione di riferimento — una forma da modificare per il tuo team piuttosto che un prodotto fisso — e riflette una visione su come il software si costruisca meglio nell'era dell'AI: i team che gestiscono flotte di agenti sono generalmente serviti meglio possedendo e rimodellando lo strumento piuttosto che adottandone uno le cui decisioni sono fissate per loro. Leggi il "perché" dietro ogni pezzo qui sotto come una mappa di dove intervenire per cambiarlo. [Rendilo tuo](#rendilo-tuo) copre il come, il dove e il perché in dettaglio.

- [Perché abbiamo costruito PopBot](#perché-abbiamo-costruito-popbot)
- [Concetti fondamentali](#concetti-fondamentali)
  - [Agenti e modelli](#agenti-e-modelli)
  - [Slot: workspace caldi, isolati, usa e getta](#slot-workspace-caldi-isolati-usa-e-getta)
  - [Copy-on-write: copie illimitate sul disco di un solo repo](#copy-on-write-copie-illimitate-sul-disco-di-un-solo-repo)
  - [Controllo versione: Git e Perforce](#controllo-versione-git-e-perforce)
  - [L'inbox: una coda, molte fonti](#linbox-una-coda-molte-fonti)
  - [Chat senza repo (per la code review)](#chat-senza-repo-per-la-code-review)
  - [Branch di base](#branch-di-base)
  - [Chat persistenti e archiviabili](#chat-persistenti-e-archiviabili)
- [Anatomia del workspace](#anatomia-del-workspace)
- [Come è stato usato in Proof of Play](#come-è-stato-usato-in-proof-of-play)
- [Flussi di lavoro end-to-end](#flussi-di-lavoro-end-to-end)
  - [Un ticket di feature](#un-ticket-di-feature)
  - [Un ticket di bug](#un-ticket-di-bug)
  - [Una code review](#una-code-review)
  - [Riaprire una chat archiviata](#riaprire-una-chat-archiviata)
- [Controllo versione e review integrati](#controllo-versione-e-review-integrati)
- [Testare in uno slot: l'app sotto test](#testare-in-uno-slot-lapp-sotto-test)
- [Permessi e sicurezza](#permessi-e-sicurezza)
- [Localizzazione](#localizzazione)
- [Preferenze](#preferenze)
- [Rendilo tuo](#rendilo-tuo)

---

## Perché abbiamo costruito PopBot

Un singolo agente AI di coding è facile da eseguire. Nel momento in cui vuoi **più di uno che lavori contemporaneamente**, emergono tre problemi:

1. **Isolamento.** Due agenti che modificano lo stesso checkout corrompono il lavoro l'uno dell'altro. Non puoi avere tre agenti e un solo working tree — e su un grande progetto di gioco, non puoi nemmeno permetterti tre checkout completi.
2. **Supervisione.** Gli agenti sono veloci e per lo più corretti, ma "per lo più" non basta per `git push`, `p4 submit`, o aprire una PR. Serve un controllo umano sulle azioni irreversibili — senza dover sorvegliare ogni singola modifica.
3. **Verifica.** Codice che compila non è codice che funziona. Per un gioco in particolare, l'unico vero test è *eseguirlo* e cliccarci dentro. Un agente che non può vedere l'app sta indovinando.

PopBot è stato costruito per risolvere tutti e tre i problemi per un piccolo team che rilasciava un gioco live. L'intuizione: trattare ogni unità di lavoro — un ticket, un bug, una review — come una **chat**, dare a ogni chat il proprio **workspace** isolato più (quando serve) la propria copia in esecuzione dell'app, eseguirle **in autonomia ma con controlli**, e mostrare l'intera flotta in un'unica finestra così una persona può guidare una dozzina di agenti alla volta.

Il design è stato guidato da un insieme concreto di [user stories](USER_STORIES.md): *"Come ingegnere, clicco su un ticket e un agente inizia a lavorarci su un branch corretto."* *"Come reviewer, apro una changelist e ottengo una review reale senza dover fare il checkout di nulla."* *"Come lead, do un'occhiata al muro e so quali agenti hanno bisogno di me."* Tutto ciò che segue esiste per servire questi obiettivi. Se capisci *perché* ogni pezzo è fatto in quel modo, saprai quali parti tenere e quali sostituire quando lo farai il fork per il tuo stack.

---

## Concetti fondamentali

### Agenti e modelli

Ogni chat è guidata da un **backend agente**:

- **Claude Code** — tramite il Claude Agent SDK. Modelli: **Claude Opus** (default) e **Claude Fable**.
- **Codex** — tramite l'OpenAI Codex SDK. Modello: **GPT / Codex**.

PopBot non reimplementa questi agenti — **guida quelli veri** attraverso i loro SDK ufficiali, che incapsulano gli stessi strumenti da riga di comando **`claude`** e **`codex`** che eseguiresti in un terminale. La piena potenza di ogni agente — i suoi strumenti, skill, server MCP e sub-agenti — è disponibile dentro ogni chat, e PopBot resta allineato a qualunque versione di quelle CLI tu abbia installato. Se funziona in Claude Code da terminale, funziona qui. È una scommessa deliberata: gli agenti migliorano rapidamente, e qualsiasi cosa li avesse incapsulati o forkati sarebbe marcita. Guidando direttamente le CLI, PopBot eredita ogni upgrade gratuitamente.

Per ogni chat, scegli il backend, il **modello**, e lo **sforzo di ragionamento** (`low` → `xhigh` / `max` — più sforzo significa un pensiero più profondo e un uso più approfondito degli strumenti, a un costo/latenza maggiore). Imposti dei **default** sensati — separatamente per le *nuove chat* e per le *code review*, dato che una review vuole una profondità diversa rispetto alla costruzione di una feature — e li sovrascrivi per singola chat quando un task lo richiede.

Due controlli di sessione contano per il lavoro di lunga durata:

- **Cambio a metà sessione.** Cambia modello o sforzo su una chat in corso; PopBot riconfigura l'agente senza perdere il filo.
- **Riavvio con contesto.** Avvia una *nuova* sessione dell'agente innescata con il transcript di questa chat (i suoi turni iniziali più quelli più recenti), utile quando una sessione diventa lunga o si inceppa. La cronologia della conversazione è preservata; l'agente riceve semplicemente un runtime pulito.

Le credenziali per le integrazioni sono memorizzate **localmente sulla tua macchina**, nel database dell'app — mai in questo repository.

### Slot: workspace caldi, isolati, usa e getta

Uno **slot** è l'unità di parallelismo, ed è l'idea centrale in PopBot. Il modo naive di eseguire N agenti è N checkout del repo — che collidono su alberi condivisi, o costano N × (tempo di checkout + cache di build). Uno slot è la risposta a "come dai a un agente un posto *reale, indipendente* in cui lavorare che sia anche *già caldo* e *economico da restituire*."

Uno slot ha tre proprietà, e ognuna è portante:

- **Isolato.** Ogni slot è la propria directory di lavoro sul proprio branch (o stream Perforce), quindi N agenti modificano N branch con interferenza zero. Un `git reset` di un agente non può toccare il lavoro di un altro.
- **Caldo.** Uno slot mantiene artefatti di build stateful che persistono tra un uso e l'altro — per un motore di gioco, la propria cache import/asset; un **sidecar server** dedicato con la propria directory dati; **porte** assegnate; log per slot; e, mentre una chat è attiva, un **processo editor** vivo. Una directory di lavoro nuda ti dà una *sorgente* isolata; uno slot ti dà un posto isolato, già *caldo*, per costruire, eseguire e testare.
- **Usa e getta.** Gli slot sono raggruppati in un pool. Una chat **prende in leasing** uno slot libero per la sua durata e lo **restituisce** alla chiusura. Creare un workspace caldo è costoso; riutilizzarne uno è quasi gratis, quindi PopBot mantiene un pool di essi caldo e vi fa ciclare il lavoro.

**Perché "caldo" è tutta la partita per il lavoro sui motori di gioco.** Un motore di gioco mantiene un'enorme cache di asset processati — la `Library/` di Unity, la `DerivedDataCache` di Unreal — spesso diversi gigabyte, costosa da produrre. Un checkout nuovo, o un cambio di branch che la invalida, costringe il motore a **reimportare il progetto**, cosa che può richiedere molti minuti. Pagare questo prezzo a ogni task e a ogni cambio di branch fa sì che i tuoi agenti passino più tempo ad aspettare il motore che a scrivere codice. Gli slot eliminano questa tassa dando a ciascuno la propria **cache persistente**:

- **Riportare un agente nel suo slot richiede secondi, non minuti** — la cache è già calda, quindi solo gli asset effettivamente cambiati vengono riprocessati.
- **Uno slot può mantenere l'editor *in esecuzione*.** Un riutilizzo "sticky" (stesso slot, stesso branch) consegna all'agente un editor vivo quasi istantaneamente invece di un avvio a freddo.
- **Dieci agenti non intasano un'unica cache di import.** Ogni slot ha la propria cache calda, quindi il lavoro parallelo sul gioco non si serializza mai dietro un singolo reimport.

Prima di qualsiasi cambio di branch, PopBot esegue una **sequenza di sicurezza** — mette in stash il lavoro non committato, rifiuta di sovrascrivere commit posseduti dall'agente, effettua il cambio e ripristina lo stato — così un passaggio di slot non perde mai silenziosamente lavoro. Gli slot possono funzionare in modalità **slot-pool** (riutilizzati, il default) o in modalità **effimera** (un workspace nuovo per ogni chat) quando preferisci scambiare il calore con una tabula rasa.

> **Perché conta:** l'isolamento è ciò che rende "dieci agenti alla volta" sicuro invece che catastrofico. Il calore è ciò che lo rende *veloce*. L'usa e getta è ciò che lo rende *economico*. Togline uno qualsiasi e gli agenti paralleli smettono di valerne la pena.

### Copy-on-write: copie illimitate sul disco di un solo repo

Isolamento e calore sono sostenibili solo se i *file* di uno slot sono economici. Su un repo piccolo, N worktree git vanno benissimo. Su un progetto di gioco su scala terabyte — con un'enorme libreria di asset e, in molti team, **Perforce** invece di Git — N copie reali sarebbero centinaia di gigabyte e minuti ciascuna da materializzare. Questo uccide l'intero modello.

Quindi il workspace di uno slot è una **cartella copy-on-write**. Ogni slot condivide un'unica **immagine base** del repo e memorizza solo i blocchi che effettivamente cambia. Il risultato pratico:

- **Una copia fresca, viva e completa di un albero da un terabyte è pronta in secondi** — non una vista superficiale, file veri e modificabili — ed è rilasciata altrettanto velocemente.
- **Copie illimitate costano il disco di un singolo repo.** Dieci agenti su un progetto da 1 TB non necessitano di 10 TB; ne servono ~1 TB più il piccolo delta di ogni slot.
- **Funziona allo stesso modo su Windows, macOS e Linux** (tramite `shado`, il layer di shadow-workspace di PopBot — VHDX differenziante su Windows, filesystem CoW nativi altrove), ed è ciò che permette agli alberi Perforce di partecipare del tutto.

Questo è il pezzo che fa scalare l'idea di slot da "un repo web con qualche worktree" a "un albero di gioco di dimensioni AAA con una flotta di agenti." È anche la funzionalità meno visibile e probabilmente la più importante: senza copie economiche, gli slot caldi e isolati sono un lusso; con esse, sono il default.

### Controllo versione: Git e Perforce

PopBot tratta il controllo versione come un **provider** dietro un'interfaccia comune, perché "esegui un agente su un branch isolato, poi rivedi e fai atterrare la modifica" ha la stessa forma sia che il backend sia Git o Perforce. Entrambi sono di prima classe:

- **Git** — worktree per l'isolamento, branch per chat, PR tramite la CLI `gh`, GitHub come superficie di review.
- **Perforce** — stream/branch per chat su workspace shadow copy-on-write, changelist come unità di lavoro, e **Helix Swarm** come superficie di review. Le review Swarm si appuntano nella stessa inbox Reviews delle PR GitHub, ciascuna aprendo la propria chat di review.

I concetti che vedrai qui sotto — branch di base, il pannello git/SCM, le azioni con template, l'inbox delle review — sono scritti contro questa interfaccia comune. Dove il testo dice "branch" o "PR," leggi "changelist" o "Swarm review" se sei su Perforce; il flusso di lavoro è deliberatamente identico.

### L'inbox: una coda, molte fonti

L'inbox è un'*idea*, non un'integrazione: **il tuo lavoro assegnato e le tue review pendenti, classificate, ciascuna a un clic dal diventare una chat con un agente.** Ciò che la alimenta è collegabile (pluggable):

- **Ticket** — issue **Linear**, issue **Jira**, e **GitHub Issues** assegnate a te (il supporto per GitHub Issues è più recente ed è ancora in parte sperimentale). Clicca uno e PopBot nomina un branch, prende in leasing uno slot, sposta il ticket in *In Progress*, e innesca l'agente con la sua descrizione.
- **Review** — pull request **GitHub** e changelist **Helix Swarm** in attesa della tua review. Clicca una e si apre istantaneamente una chat di review senza repo.

Aggiungere una fonte non cambia il flusso di lavoro — aggiunge semplicemente righe alla stessa coda. Questo è il punto: il modello inbox-come-coda è generico, e i tracker specifici sono default intercambiabili.

### Chat senza repo (per la code review)

Non ogni chat necessita di un workspace. **Rivedere** una modifica è di sola lettura — non modifichi, leggi il diff e il codice circostante e posti commenti. Quindi le chat di review sono **senza repo (repoless)**: nascono istantaneamente, non prendono in leasing alcuno slot, e non consumano alcun workspace.

Questa è una separazione deliberata e importante:

- Una **chat di costruzione** (feature/bug) prende in leasing uno slot, può richiedere un momento per scaldarsi, e mantiene un workspace per tutta la sua durata.
- Una **chat di review** è **istantanea e gratuita** — puoi aprirne cinque per fare il triage della tua coda di review mentre le tue chat di costruzione continuano a funzionare indisturbate.

Significa anche che il tuo pool di slot è riservato al lavoro che ha realmente bisogno di isolamento. Le review non affamano mai le costruzioni di slot — una proprietà che conta molto quando il pool è limitato da RAM e disco.

### Branch di base

Quando una chat *scrive* effettivamente codice, esegue un fork da una **base** — tipicamente `develop`/`main` su Git, o lo stream principale su Perforce. PopBot imposta il default della base per repository, ricorda la tua ultima scelta così il caso comune è un solo clic, e ti permette di fare branch da una linea di feature o da un branch di release quando un task lo richiede. Deriva il nome del nuovo branch dalla tua convenzione — es. `<username>/<ticket>-<slug>` — così i branch sono coerenti e tracciabili fino al loro ticket. La base alimenta anche azioni successive: "rebase sulla base," "apri PR / review contro la base," e i controlli di scostamento (drift) fanno tutti riferimento a essa.

### Chat persistenti e archiviabili

Ogni chat è un **transcript durevole** memorizzato localmente — prosa, chiamate agli strumenti, diff, decisioni sui permessi, tutto quanto. Niente è effimero.

- **Chiudere** una chat rilascia il suo slot (liberando un workspace per altri agenti) ma **mantiene tutto**. La chat si sposta nell'**archivio**.
- **Riaprire** una chat dall'archivio prende nuovamente in leasing uno slot, ripristina il suo branch, e l'agente riprende con la sua **cronologia completa** — puoi riprendere una feature giorni dopo per affrontare i commenti della review senza dover rispiegare nulla. Se si riapre in uno slot *diverso*, PopBot lo comunica subito all'agente, così si riorienta pulitamente alla nuova directory di lavoro.
- L'archivio è ricercabile per nome, ticket, branch e contenuto.

Poiché il rollback è solo "invia un altro messaggio" (non ci sono modifiche distruttive alla cronologia), una chat accumula la storia completa e verificabile di come è stata realizzata una modifica.

---

## Anatomia del workspace

![Anatomia dell'interfaccia PopBot](../../images/anatomy.png)

| Regione | Cos'è |
|---|---|
| **Inbox — ticket e review** | Ticket assegnati (Linear / Jira / GitHub Issues) e review in attesa (PR GitHub / changelist Swarm), classificati. Clicca una riga per generare una chat innescata con il suo contesto. |
| **Slot** | Il pool di workspace caldi. Ogni pillola mostra se uno slot è libero o preso in leasing da una chat. |
| **Archivio chat** | Ogni chat passata, ricercabile e riapribile con la cronologia completa. |
| **Miniature delle chat** | Un'anteprima live e scorrevole di ogni chat aperta — una vista reale di cosa sta facendo ogni agente in questo momento, colorata per stato: blu = in esecuzione, verde = completata, giallo = ha bisogno di te, rosso = errore, grigio = inattiva. |
| **Chat** | Le sessioni agente in primo piano — prosa in streaming, chiamate agli strumenti, e diff di codice inline. |
| **Terminale per chat** | Un terminale incorporato ancorato al workspace di quella chat. |
| **Pannello SCM** | Stato del working tree/changelist, commit recenti, diff dei file, e azioni a un clic per commit / push / PR / review. |

Poiché ogni chat resta nella **striscia di miniature** e le **colonne stanno una accanto all'altra**, non stai mai a caccia dello stato. Il colore è il segnale — blu = in esecuzione, verde = completata, giallo = ha bisogno di te, rosso = errore — così un'occhiata ti dice quali agenti stanno lavorando, quali hanno finito, e quali stanno **aspettando te**.

Ma ogni miniatura è anche un'**anteprima live della conversazione**, non solo una spia di stato — così a colpo d'occhio puoi vedere *cosa* sta effettivamente facendo ogni agente. Questo è ciò che ti permette di **individuare presto il lavoro inutile**: notare un agente che va nella direzione sbagliata e reindirizzarlo prima che bruci tempo e token, invece di scoprire il vicolo cieco dopo che è "finito." È la differenza tra supervisionare una flotta ed esserne sorpresi.

### Perché le miniature, e perché un'unica vista

Questo layout è una risposta deliberata a un problema specifico, ed è utile enunciarne il ragionamento perché è la parte che la maggior parte degli strumenti sbaglia.

Eseguire un agente è un compito di focus: osservi una singola conversazione e rispondi. Eseguirne *molti* è un compito di **monitoraggio**, e il monitoraggio ha una diversa modalità di fallimento — il collo di bottiglia non è la tua velocità di battitura, è la tua attenzione. Un agente che silenziosamente si allontana produce lavoro che devi notare, capire e buttare via. Con N agenti, il costo del *non notare* scala con N, e le interfacce naturali rendono difficile notare: le tab nascondono ogni agente tranne uno, e un modello lancia-e-aspetta li nasconde tutti finché non emerge un risultato.

Quindi il design si impegna su due cose:

- **Ogni agente è sempre visibile.** La striscia di miniature mostra l'intera flotta contemporaneamente, e ogni miniatura è una vista live della conversazione reale, non uno spinner. Devi poter fare un passo indietro e cogliere lo stato di una dozzina di agenti in un solo colpo d'occhio — quali agenti si stanno muovendo, quali sono bloccati, quali stanno per fare qualcosa che vorresti fermare.
- **Lo stato è un colore, il contenuto è a un'occhiata di distanza.** Il colore risponde a "chi ha bisogno di me?" in meno di un secondo; l'anteprima live risponde a "cosa sta facendo questo?" senza un clic; e le colonne affiancate ti permettono di immergerti in una qualsiasi senza perdere le altre. L'interfaccia è ottimizzata per il *ri-controllo economico*, perché con molti agenti ricontrolli costantemente.

Il vantaggio è la capacità di **intervenire presto**. L'errore costoso con agenti autonomi non è un crash — è un agente che spende con sicurezza un'ora a costruire la cosa sbagliata. Una vista che mostra continuamente l'intento trasforma questo da una scoperta a posteriori in una correzione in corso d'opera. Questo è l'intero motivo per cui la flotta è sullo schermo in ogni momento invece che dietro delle tab o una notifica.

---

## Come è stato usato in Proof of Play

PopBot non era un esperimento da laboratorio. È stato costruito e usato quotidianamente dal team di **Proof of Play** su un progetto reale, ricco di asset, che è stato rilasciato. Questa origine spiega la maggior parte delle scelte di design, ed è il modo più chiaro per capire a cosa serve lo strumento.

Il risultato pratico è stato semplice: il modello a slot — workspace caldi, isolati, copy-on-write — ha reso fattibile il lavoro parallelo degli agenti su un grande albero di asset, e il team ha realizzato di più grazie a questo. Più agenti potevano funzionare contemporaneamente senza collidere o pagare la tassa di reimport del motore a ogni cambio, quindi il throughput è salito invece che il parallelismo si trasformasse in overhead.

La forma di una giornata tipica: un lead con il muro di miniature aperto, quattro o cinque agenti in volo — un paio a macinare ticket di feature, uno a inseguire un bug, uno o due a fare code review. Il lead non scrive codice minuto per minuto; sta **osservando la flotta**, intervenendo solo ai controlli (un push, una PR, un'azione rischiosa) e quando una miniatura diventa gialla o un agente vagabonda visibilmente. I ticket vengono dal tracker reale del team; le review sono PR e changelist reali che il resto del team vede atterrare.

I vincoli rigidi imposti da quel progetto di gioco sono esattamente le funzionalità che alla fine sono risultate più importanti:

- **L'albero di asset era enorme**, quindi gli slot caldi e i workspace copy-on-write non erano un vezzo — senza di essi, una flotta di agenti su quell'albero era semplicemente insostenibile. Ecco perché queste due idee sono la spina dorsale dello strumento.
- **Il motore era la fonte di verità per "funziona,"** quindi un agente che non poteva lanciare e guidare il gioco in esecuzione era inutile per la maggior parte del lavoro di gameplay. Da qui l'integrazione con l'app sotto test.
- **Il controllo versione era Perforce per il gioco e Git per gli strumenti**, quindi un SCM indipendente dal provider non era opzionale.
- **Una persona doveva guidare molti agenti**, quindi l'intero cockpit è ottimizzato per la *supervisione a colpo d'occhio* piuttosto che per il focus profondo su una singola sessione.

Se la tua situazione fa eco a qualcosa di tutto ciò — un albero grande, un'app reale da testare, più lavoro di quanto un singolo agente possa gestire — il design si adatterà da vicino alle tue esigenze, perché è stato costruito esattamente per questo. Se non è così, la sezione [Rendilo tuo](#rendilo-tuo) riguarda il mantenere le idee e sostituire gli specifici.

Una nota sull'ambito: quel progetto alla fine non ha trovato trazione commerciale, e non stiamo affermando il contrario. Ma il problema ingegneristico che poneva era reale — un grande albero di asset, una flotta di agenti, un team — e le parti di PopBot che lo hanno risolto sono le parti documentate qui. Il valore dello strumento non dipende dall'esito del gioco, e preferiamo dirlo chiaramente piuttosto che lasciare intendere di più.

---

## Flussi di lavoro end-to-end

### Un ticket di feature

1. **Notifica → inbox.** Un ticket assegnato a te appare nell'inbox **Tickets** (PopBot interroga Linear / Jira / GitHub Issues, classificati per priorità e data di scadenza). La campanella di notifica lo segnala.
2. **Un clic per iniziare.** Clicca la riga del ticket. PopBot apre una finestra di dialogo **nuova chat** predefinita sul tuo repo e sulla base (ricordata dall'ultima volta) — conferma, o modifica agente/modello/sforzo.
3. **Assegnazione dello slot.** Poiché questa chat scriverà codice, PopBot **prende in leasing uno slot**: sceglie un workspace libero, deriva il nome del branch `you/eng-123-<slug>` dal ticket, e commuta il workspace su di esso (eseguendo prima la sequenza di sicurezza dello stash).
4. **Ticket promosso automaticamente.** Il ticket viene spostato in **In Progress** automaticamente (idempotente, fire-and-forget) così la tua board riflette la realtà senza un cambio di contesto.
5. **L'agente inizia.** L'agente riceve un primo messaggio innescato (il tuo template personalizzabile *start-ticket*, riempito con il titolo del ticket, la descrizione, e il branch) e inizia: esplorando il codice, facendo modifiche, eseguendo comandi — tutto dentro il workspace del suo slot.
6. **Verifica nello slot.** Per una modifica di gioco, l'agente **lancia l'app nel suo slot** (un editor del motore + sidecar server su un secondo monitor) ed esercita la feature — cliccando attraverso l'UI, leggendo i log, catturando screenshot — invece di indovinare che funzioni.
7. **Fine con controllo.** Quando è pronto per il push, l'agente **si mette in pausa** (il push è un'azione controllata). La miniatura diventa gialla ("ha bisogno di te").
8. **Rivedi e rilasci.** Apri il **pannello SCM**, leggi il diff, e premi **Push PR** (o **Push draft**). L'azione invia un'istruzione precompilata all'agente, che fa il push del branch e apre la PR / Swarm review contro la tua base.

Per tutto il tempo, non stavi osservando — stavi facendo lo stesso per altri due ticket. Sei intervenuto solo al controllo.

### Un ticket di bug

Il flusso del bug è il flusso della feature con un ciclo più stretto, e mostra bene il **parallelismo**:

1. Arriva una segnalazione di bug (un ticket, o inizi una chat manualmente con la descrizione del bug).
2. Genera una chat → prende in leasing **il proprio** slot e branch. La tua chat di feature in corso resta completamente intatta — workspace diverso, branch diverso.
3. L'agente riproduce il bug **eseguendo l'app nel suo slot**, trova la causa, la corregge, e riesegue per confermare che la riproduzione sia sparita.
4. Dai un'occhiata alla **striscia di miniature**: chat feature verde (completata, in attesa del tuo push), chat bug blu (in esecuzione). Due agenti, due alberi isolati, zero collisioni.
5. Fai il push della correzione quando si mette in pausa per l'approvazione.

### Una code review

1. **Notifica → Reviews.** Un collega richiede la tua review. La PR (GitHub) o la changelist (Swarm) appare nell'inbox **Reviews**.
2. **Chat istantanea, senza repo.** Cliccala → si apre immediatamente una **chat di review** — nessuno slot, nessun checkout, nessuna attesa. È innescata con il template *start code review* (leggi il codice circostante, non solo il diff; traccia i sistemi; cerca bug reali, race condition, casi limite, problemi di sicurezza e performance).
3. **Review reale.** L'agente legge il diff **e** il codice attorno, ragiona sulla correttezza, e posta **commenti inline** più un verdetto (approva / richiedi modifiche) su GitHub o Swarm — poi ti riassume in chat le bandiere rosse.
4. **Ri-review più tardi.** Se l'autore fa il push delle correzioni, premi **re-review**: PopBot mette a fuoco la chat di review esistente e dice all'agente di guardare **solo i nuovi commit**, verificare che ogni thread precedente sia effettivamente risolto, e aggiornare la sua review.

Tutto questo avviene mentre le tue chat di costruzione continuano a funzionare — le review non prendono mai uno slot.

### Riaprire una chat archiviata

Il lavoro raramente si conclude in un colpo solo. Il flusso di riapertura è di prima classe:

1. Una chat di feature ha rilasciato la sua PR; l'hai **chiusa** per liberare lo slot. Ora è nell'**archivio** (transcript pienamente preservato).
2. Due giorni dopo, la modifica riceve commenti di review. Trova la chat nell'archivio (cerca per ticket, branch, o testo) e **riaprila**.
3. PopBot **prende nuovamente in leasing uno slot**, ripristina il branch della chat nel workspace, e l'agente riprende con la sua **intera cronologia** — sa già cosa ha costruito e perché. Se atterra in uno slot diverso da prima, PopBot lo orienta alla nuova directory di lavoro.
4. Incolla o riassumi il feedback della review. L'agente lo affronta, riesegue i test nello slot, e fa il push dell'aggiornamento — nessun re-onboarding, nessun contesto perso.

Poiché il branch, il transcript, e il ragionamento persistono tutti, riprendere un task costa secondi, non una nuova spiegazione.

---

## Controllo versione e review integrati

Il controllo versione è collegato in profondità, attraverso la CLI nativa di ogni provider — **`gh`/`git`** per GitHub, **`p4`** e l'API Swarm per Perforce — così tutto ciò che un agente fa è attività reale che il tuo team vede nei posti normali.

- **Inbox delle review.** PR GitHub e changelist Swarm in attesa della tua review (e le tue recenti sottomissioni) emergono come fonti di chat a un clic.
- **Chip di stato PR / review.** Ogni chat collegata a una modifica mostra un chip di stato live — Open / Merged / Closed / Draft — su cui puoi cliccare per aprirla su GitHub o in Swarm.
- **Il pannello SCM.** Per qualsiasi chat di costruzione, vedi lo stato del working tree/changelist, i commit recenti, e i diff per file. Clicca un file per un overlay completo con diff unificato.
- **Azioni a un clic.** Azioni con template, modificabili, inviano un'istruzione precompilata all'agente: **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR** (affronta i commenti di review), **Rebase onto base**. Ognuna espande variabili come `${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, e `${prurl}` così l'agente ha esattamente ciò di cui ha bisogno.
- **Creazione contro la tua base.** Il push apre la PR (o la Swarm review) contro la base configurata della chat, nominata secondo la tua convenzione di branch.

La review è un percorso distinto e ottimizzato (vedi [Una code review](#una-code-review)):

- **Senza repo e istantanea** — nessuno slot, nessun checkout. Fai il triage di una coda di review in secondi.
- **Legge il contesto, non solo il diff** — il template di review dirige l'agente a leggere il codice circostante, tracciare i sistemi, e cercare bug/race/casi limite/sicurezza/performance, non a timbrare la patch senza controllarla.
- **Posta dove il tuo team lavora** — commenti inline e una review sottomessa su GitHub o Swarm.
- **La ri-review è delimitata** — su un secondo passaggio, l'agente esamina solo i nuovi commit e conferma che ogni thread precedente sia genuinamente risolto prima di aggiornare la sua review.
- **Completamente personalizzabile** — i prompt *start code review* e *re-review* sono template modificabili, così puoi calibrare il rigore, la checklist, e il tono sullo standard del tuo team. La *procedura di review stessa* (come il tuo shop vuole che venga fatta una review GitHub o Perforce) è tua da fornire — PopBot la raccomanda e può fornirne un esempio, ma lo standard vive con il tuo team.

## Testare in uno slot: l'app sotto test

Lo slot di una chat di costruzione non è solo una cartella — è un posto per **eseguire e ispezionare** il lavoro:

- **Terminale per chat.** Un terminale incorporato (xterm + un vero PTY) ancorato al workspace della chat. Esegui test, ispeziona i log, o lancia comandi a mano mentre l'agente lavora. Persiste mentre passi tra le chat.
- **Integrazione con l'editor.** Ogni riferimento `path/to/file.ts:42` nel transcript è un link cliccabile che si apre in **VS Code** o **Cursor**, risolto contro il workspace della chat.
- **L'app sotto test.** Uno slot può lanciare l'**applicazione reale** così l'agente può guidarla invece di indovinare. Per un'app web, una CLI, o un servizio, questo è per lo più opera dell'agente stesso — esegue i tuoi comandi di build e test nel terminale dello slot, colpisce il server in esecuzione, legge l'output. PopBot non ha bisogno di sapere nulla di speciale su di essi; l'agente li gestisce allo stesso modo in cui lo faresti tu. I **motori** di gioco sono il caso che necessita di gestione extra, perché l'editor è un processo GUI di lunga durata con la propria cache di asset e nessun ciclo naturale a riga di comando di "esegui e controlla." Quindi per **Unity** e **Unreal**, PopBot lancia un editor live + sidecar server, lo colloca su un secondo monitor, e lo espone all'agente tramite un **server MCP interno all'editor**. Ogni editor in esecuzione ottiene la propria **porta MCP derivata dal proprio slot** — così un agente parla solo con *il proprio* editor, mai con quello di un altro slot — e PopBot collega automaticamente l'agente di ogni chat a quell'endpoint (in memoria, così nulla finisce nel controllo versione). Un motore **custom** si inserisce nello stesso meccanismo: PopBot passa l'identità dello slot al tuo comando di lancio e tu colleghi il modo in cui l'agente lo guida. In ogni caso l'agente può esercitare l'app — cliccare l'UI, leggere i log, fare screenshot, verificare il comportamento — e PopBot gestisce il ciclo di vita dell'editor (avvia il server, ne verifica lo stato di salute, avvia l'editor, colloca la sua finestra, lo smonta al rilascio), calibrando le istanze concorrenti in base alla RAM disponibile.

Questa è la differenza tra un agente che *pensa* che la sua modifica funzioni e uno che l'ha *vista* funzionare. Niente in questo è specifico per i giochi — lo sviluppo web e altro sono usi altrettanto di prima classe. I motori di gioco semplicemente portano lo stato extra (una cache di asset calda, un editor come app-sotto-test) di cui il sistema deve essere consapevole, e quello stesso stato extra è ciò che li rende la dimostrazione più netta delle parti innovative dello strumento: slot caldi, workspace copy-on-write, e un'app in esecuzione che l'agente può guidare.

## Permessi e sicurezza

Autonomia con un pavimento rigido:

- **Auto-consentito (silenzioso):** letture, modifiche, e comandi shell **dentro il workspace dello slot**, chiamate ai servizi dello slot stesso (incluso il suo editor MCP), e operazioni interne dell'agente. L'agente lavora e basta.
- **Sempre controllato (si mette in pausa per te):** `git push` / `p4 submit` / reset / force, qualsiasi cosa **fuori** dal workspace, aprire PR o review, cancellare fuori da una directory scratch, inviare messaggi (Slack/email), toccare la configurazione di sistema o dell'agente, e chiamate di rete verso host non nella allowlist.
- **Tutto il resto:** ti chiede di decidere.

Quando approvi qualcosa, puoi concederlo **una volta**, **per la sessione**, o **durevolmente** (consenti sempre questo strumento/target). I server MCP possono essere autorizzati allo stesso modo — consenti una volta l'editor MCP di uno slot e viene ricordato, con la concessione visibile e revocabile in Preferenze → Permessi (PopBot abilita in questo modo automaticamente gli editor MCP di Unity/Unreal). Le concessioni sono per chat o globali e tutte **revocabili**. Il pavimento di diniego rigido (push/submit, rete, fuori dall'albero) vive nel codice e non è sovrascrivibile dall'UI — così una concessione mal configurata non può permettere a un agente di atterrare sulla mainline da solo.

## Localizzazione

L'intera interfaccia di PopBot — menu, impostazioni, dialoghi, tutto — è completamente localizzata. L'app viene distribuita in **dodici lingue**: inglese, spagnolo, francese, tedesco, giapponese, coreano, cinese semplificato, portoghese brasiliano, russo, italiano, polacco e ucraino — commutabili in qualsiasi momento dal menu della lingua senza riavvio. Se fai il fork di PopBot, ogni locale è un unico catalogo di messaggi, così aggiungere o modificare una lingua è una modifica contenuta piuttosto che una caccia al tesoro nell'UI.

## Preferenze

Tutto è configurato nell'app (nessun file di configurazione da modificare):

- **Agenti** — modello e sforzo di ragionamento predefiniti, separatamente per nuove chat vs. code review.
- **Repository** — aggiungi/modifica repo tramite una procedura guidata folder-first, consapevole dell'SCM: percorso, provider (Git/Perforce), branch o stream di base, colore, prefisso slot, directory dei workspace, modalità slot-pool vs. effimera.
- **Runtime e slot** — dimensione del pool (quanti agenti funzionano contemporaneamente), pre-creazione/eliminazione degli slot, conservazione degli allegati, aggiornamento dell'immagine base per i workspace copy-on-write.
- **Integrazioni** — collega Linear, Jira, GitHub, e Helix Swarm (credenziali memorizzate localmente); frequenze di polling delle review configurabili per provider; test prima di salvare.
- **Controllo versione** — convenzione dei nomi di branch, base predefinita, e i template di azione modificabili.
- **App esterne** — terminale (iTerm), editor (VS Code / Cursor), binari dei motori e opzioni per motore (inclusa la porta base dell'editor-MCP), profilo Chrome opzionale per il routing degli URL.
- **Template dei prompt** — ogni prompt innescato (start ticket, start/Re-review, e ogni azione) è modificabile, con una scheda di riferimento per le variabili.
- **Permessi** — rivedi e revoca le concessioni durevoli, incluse le autorizzazioni per server MCP.
- **Notifiche** — posizionamento dei toast e comportamento degli avvisi.
- **Lingua** — cambia la lingua dell'interfaccia.

> Per un riferimento pannello per pannello con screenshot, vedi la **[Guida alla configurazione](CONFIGURATION.md)**.

## Rendilo tuo

Adattare PopBot è un uso previsto primario. È pubblicato come implementazione di riferimento, e il suo design riflette una visione su come il software si costruisca meglio nell'era dell'AI: un team prende una forma funzionante, capisce *perché* è fatta in quel modo, e la rimodella attorno al proprio stack, strumenti, e convenzioni piuttosto che adottare uno strumento le cui decisioni sono fissate per loro.

La sua forma è generale: **agenti + slot isolati, caldi, copy-on-write + un'inbox-come-coda + un'app-sotto-test.** Quel pattern si applica alla maggior parte dei team che eseguono più di un agente di coding alla volta. È **concesso in licenza MIT** e strutturato per essere forkato — il codice è organizzato come *provider dietro piccole interfacce comuni*, così una parte può essere aggiunta o sostituita senza toccare il resto. L'approccio generale: mantieni le idee fondamentali, sostituisci le istanze specifiche.

Le giunture sono elencate qui sotto con *come, dove, e perché* per ciascuna. Ognuna è un'interfaccia con implementazioni collegabili; il percorso pratico è fare pattern-matching su un'implementazione esistente e aggiungere la tua.

- **Sostituisci l'app-sotto-test.** *Perché:* l'intero punto è un agente che *esegue e verifica* la tua app, e "la tua app" è diversa per tutti. *Dove:* `src/shared/gameEngine.ts` (descrittori del motore, collegamento MCP) e `src/main/ipc/apps.ts` (lancio + ciclo di vita). Unity e Unreal sono due implementazioni; l'hook del **motore custom** già passa l'identità dello slot (`POPBOT_SLOT`, porte derivate) al tuo comando di lancio, quindi collegare la tua app web, CLI, o test harness è "riempi il comando di lancio e come l'agente ci parla."
- **Punta l'inbox altrove.** *Perché:* l'inbox-come-coda è l'idea durevole; il tracker specifico è un dettaglio. *Dove:* `src/main/tickets/` — implementa l'interfaccia `TicketSource` in `provider.ts`, normalizza i dati del tuo tracker nei DTO condivisi, e registralo in `registry.ts` (l'intestazione del file nota letteralmente: *"aggiungere un tracker è una singola riga qui più il suo modulo `*Source.ts`"*). Linear, Jira, e GitHub Issues sono gli esempi lavorati. Il renderer non fa mai branch sull'id del provider, quindi non tocchi l'UI.
- **Aggiungi o sostituisci il controllo versione.** *Perché:* "isola una modifica, rivedila, falla atterrare" è indipendente dal provider; Git e Perforce sono solo due backend. *Dove:* `src/main/scm/` — estendi la classe base `SourceControlProvider` (`provider.ts`), seguendo `gitProvider.ts` / `perforceProvider.ts`. Il comportamento che non si astrae in modo pulito viene **rilevato tramite capability**, non `if (provider === …)`, così un VCS molto diverso può persino optare per la propria UI client senza che i chiamanti facciano casi speciali.
- **Sostituisci la superficie di review.** *Perché:* le review dovrebbero atterrare dove il tuo team già guarda. *Dove:* i provider di review dietro `src/main/reviews/` (PR GitHub tramite `git/reviews.ts`, changelist Swarm tramite `p4/swarmReviews.ts`). La *procedura di review stessa* — come il tuo shop vuole che venga fatta una review — è intenzionalmente **non** distribuita nello strumento; è una skill per-shop che tu fornisci, così PopBot raccomanda e fornisce esempi ma non impone mai il tuo standard.
- **Ricablare le azioni e i prompt.** *Perché:* le convenzioni di branch, i flussi PR/review, e come si informa un agente sono specifici del team. *Dove:* nessun codice necessario — i template delle azioni git e ogni prompt innescato (start-ticket, start/re-review) sono **modificabili in Preferenze**, con una scheda di riferimento per le variabili. Cambia il rigore, la checklist, il tono.
- **Mantieni il nucleo.** *Perché:* queste sono le idee che fanno funzionare l'intero sistema, e sono le parti che dovresti cambiare più lentamente. Slot caldi, workspace copy-on-write (`src/main/shado/`), chat persistenti, il pavimento di permessi hard-coded, e il cockpit multi-agente parallelo sono la spina dorsale durevole. Tutto il resto è pensato per muoversi.

Per i confini dei processi, l'IPC, e dove vive ogni sottosistema, leggi il documento **[Architettura](ARCHITECTURE.md)** — la mappa per trovare la giuntura che vuoi cambiare. Per il modello a oggetti (Chat, Slot, AgentSession e i loro cicli di vita), vedi **[Modello di base](CORE_MODEL.md)**.

Per i team che eseguono più di un agente alla volta, questo è un punto di partenza funzionante pensato per essere smontato e ricostruito attorno a un flusso di lavoro diverso.

---

*Alcune integrazioni menzionate nella [specifica di design](POPBOT_DESIGN.md) originale (Slack, Sentry, e altre) esistono come stub di connessione piuttosto che flussi completi; Linear, Jira, GitHub, e Helix Swarm sono le fonti dell'inbox pienamente collegate. Questa guida descrive come l'app si comporta effettivamente oggi.*
