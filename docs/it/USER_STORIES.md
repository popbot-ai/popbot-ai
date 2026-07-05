*Languages: [English](../USER_STORIES.md) · [Español](../es/USER_STORIES.md) · [Français](../fr/USER_STORIES.md) · [Deutsch](../de/USER_STORIES.md) · [日本語](../ja/USER_STORIES.md) · [한국어](../ko/USER_STORIES.md) · [简体中文](../zh-CN/USER_STORIES.md) · [Português (Brasil)](../pt-BR/USER_STORIES.md) · [Русский](../ru/USER_STORIES.md) · **Italiano***

# User Stories

Il riferimento "come si presenta il successo" per PopBot. Registrato il
2026-05-01. Ogni scelta implementativa dovrebbe ricondursi a una di queste.

L'utente è uno sviluppatore singolo (Ben) che esegue PopBot sulla propria
macchina. "Io" qui sotto è lui.

> **Stato (annotazione aggiunta 2026-07, alla pubblicazione).** Le storie
> qui sotto sono le user story *fondative* registrate nel 2026-05, conservate
> qui come documentazione originale dell'intento di design. Da allora PopBot
> si è generalizzato ben oltre quell'ambito iniziale a singolo utente,
> Unity/Linear/Slack/GitHub — ora copre Git e Perforce, Unity e Unreal,
> Linear/Jira/GitHub Issues, PR GitHub e Helix Swarm, ed è distribuito
> localizzato in più lingue con licenza MIT. Questo documento
> intenzionalmente *non* viene aggiornato per rispecchiare tutto ciò;
> trattalo come storia, e vedi [GUIDE.md](GUIDE.md) per il set di
> funzionalità attuale. Le storie US-1..US-9 e la registrazione del 2026-05
> restano invariate.

---

## US-1 · Consapevolezza della coda di attenzione

> *"Dovrei essere consapevole dei problemi ad alta priorità, dei messaggi
> Slack e delle altre PR a cui devo prestare attenzione."*

Tre fonti mostrate insieme in cima alla finestra:

- **Ticket Linear** assegnati a me, ordinati per priorità + data di
  scadenza.
- **Messaggi Slack** indirizzati a me (DM, @menzioni, canali di cui sono
  proprietario). _Nuovo requisito; non presente nel design originale — vedi
  [Deviazioni](#deviazioni-e-aggiunte)._
- **PR GitHub** che richiedono la mia revisione.

Ogni riga mostra abbastanza a colpo d'occhio da poter fare triage senza
cliccare (titolo, fonte, età, indicatore di priorità). Gli elementi ad alta
priorità risaltano visivamente rispetto a quelli a bassa priorità.

**Corrisponde a:** [POPBOT_DESIGN.md → Layout dell'app](POPBOT_DESIGN.md#layout-dellapp) (pannelli Tickets / Reviews — estendere con un pannello Slack).

---

## US-2 · Attivazione con un clic

> *"Dovrei essere in grado di avviare facilmente un'attività su uno
> qualsiasi di questi elementi, e aprire una chat per iniziare a
> lavorare."*

Cliccare su qualsiasi riga nella coda di attenzione genera una nuova chat
inizializzata per quel lavoro:

- Ticket Linear → chat inizializzata con il corpo del ticket, branch
  nominato secondo la chiave del ticket, prompt dell'agente precompilato.
- Messaggio Slack → chat inizializzata con il contesto della conversazione,
  pronta per redigere una risposta o avviare il lavoro vero e proprio.
- PR → chat inizializzata con il diff e la checklist di revisione.

Nessun attrito di configurazione tra "vedo qualcosa da gestire" e "un
agente ci sta lavorando."

**Corrisponde a:** [POPBOT_DESIGN.md → Layout dell'app](POPBOT_DESIGN.md#layout-dellapp) ("Click a row → spawn a chat seeded for that work").

---

## US-3 · Test reale del gioco nella chat

> *"Le chat dovrebbero poter coinvolgere un'istanza Unity ed eseguire
> unity/server quando necessario, così da poter testare e debuggare il
> lavoro."*

Quando una chat ha bisogno di verificare un comportamento nel gioco reale,
la chat acquisisce uno slot, genera Unity (posizionato sullo schermo 2), e
opzionalmente genera il server sidecar. L'agente guida il gioco tramite
l'MCP integrato nell'Editor — entrando in modalità Play, cliccando sulla
UI, catturando screenshot, leggendo i log, verificando lo stato.

Acquisire uno slot è la parte lenta la prima volta (~15-30 s a freddo);
l'attività successiva è persistente (~50 ms).

**Corrisponde a:** [POPBOT_DESIGN.md → Tipi di chat](POPBOT_DESIGN.md#tipi-di-chat) (Client Test / Server Test), [Slot](POPBOT_DESIGN.md#slot--lunità-durevole), [Superficie di automazione MCP](POPBOT_DESIGN.md#superficie-di-automazione-mcp).

---

## US-4 · Completamento autonomo end-to-end con prova

> *"Gli agenti dovrebbero essere in grado di lavorare in modo completamente
> autonomo, e correggere/debuggare e completare un intero ticket, inclusa la
> consegna di una prova che la correzione/modifica abbia funzionato come
> richiesto, in un documento markdown ispezionabile."*

In modalità autonoma l'agente esegue un intero ciclo lettura → riproduzione
→ correzione → verifica senza intervento, e alla fine scrive un artefatto
`proof.md`. La prova contiene:

- **Riproduzione** — i passi esatti che hanno dimostrato il bug.
- **Prima** — screenshot + dump di log filtrati dallo stato guasto.
- **Causa radice** — la diagnosi dell'agente.
- **Correzione** — il diff o il riepilogo delle modifiche.
- **Dopo** — screenshot + dump di log puliti dallo stato corretto.
- **Verifica** — una nuova esecuzione della riproduzione, ora superata.

Posso aprire `proof.md` e decidere se il lavoro è valido senza dover
rieseguire nulla io stesso. La pausa per la revisione è necessaria solo per
operazioni rischiose (`git push`, `gh pr create`, ecc.).

**Corrisponde a:** [POPBOT_DESIGN.md → Modalità autonoma](POPBOT_DESIGN.md#modalità-autonoma), [Artefatti di prova](POPBOT_DESIGN.md#artefatti-di-prova-deliverable-di-debug-dellagente).

---

## US-5 · Multitasking facile tramite miniature

> *"Dovrei essere in grado di fare facilmente multitasking tra agenti,
> cliccando sulle miniature."*

La striscia di miniature è la superficie di navigazione primaria per il
lavoro parallelo. Una riga di anteprime compatte — una per chat — mi
permette di passare istantaneamente da un agente all'altro. Cliccare su una
miniatura porta quella chat in primo piano; le altre chat continuano a
funzionare in background.

La miniatura stessa comunica lo stato, non solo l'identità. Vedi US-6.

**Corrisponde a:** [POPBOT_DESIGN.md → Layout dell'app](POPBOT_DESIGN.md#layout-dellapp) (riga delle miniature), Fase 3 in [PHASING.md](PHASING.md).

---

## US-6 · Stato a colpo d'occhio

> *"Dovrei essere in grado di farmi facilmente un'idea di cosa sta facendo
> un agente, e se ha bisogno di assistenza o indicazioni da parte mia, a
> colpo d'occhio."*

Ogni miniatura di chat mostra il suo stato attuale senza che io debba
cliccarci sopra:

| Colore | Significato |
|---|---|
| Blu | In esecuzione |
| Verde | Task completato |
| **Giallo** | **In pausa — ha bisogno di me** |
| Rosso | In errore |
| Grigio | Inattiva / non avviata |

Il giallo è quello che richiede attenzione. Scorrere la riga delle
miniature dovrebbe rispondere a "qualcuno è bloccato?" in meno di un
secondo. Oltre al colore, la miniatura mostra un breve suggerimento di
avanzamento (ultima azione, passo corrente) così posso decidere se
approfondire.

**Corrisponde a:** [POPBOT_DESIGN.md → Colori di stato](POPBOT_DESIGN.md#colori-di-stato-thumbnail-della-chat).

---

---

## US-7 · Ripristinare e continuare da qualsiasi punto

> *"Dovrei essere in grado di ripristinare facilmente e continuare con i
> ticket, anche quelli non più attivi, da dove avevo lasciato."*

Una chat è durevole. Anche dopo averla chiusa, aver riavviato PopBot, o
riavviato il computer, posso riaprire qualsiasi chat passata e riprendere
esattamente da dove avevo lasciato:

- L'intera trascrizione viene riprodotta nella colonna della chat.
- Lo slot viene riacquisito (o avviato a freddo) sullo stesso branch su cui
  mi trovavo.
- Lo stato di Unity + sidecar viene ripristinato alla fixture / blob di
  salvataggio pertinente, se ne era stato impostato uno.
- L'agente rilegge la trascrizione recente prima di rispondere al mio
  messaggio successivo — il contesto non va perso attraverso il riavvio.

Chiudere una chat rilascia il suo slot; riaprirla lo riacquisisce. La chat
è il record durevole; lo slot è infrastruttura transitoria.

**Corrisponde a:** [POPBOT_DESIGN.md → Slot](POPBOT_DESIGN.md#slot--lunità-durevole) (ciclo di vita slot vs. chat), [Stack tecnologico → better-sqlite3](POPBOT_DESIGN.md#stack-tecnologico) (persistenza della trascrizione). Lo schema del record per-chat vive in `src/main/persistence/`.

---

## US-8 · Ispezione per-ticket: chat + Unity + log + prova

> *"Dovrei essere in grado di dare facilmente un'occhiata all'avanzamento
> di un ticket mostrando il contenuto, il server/l'istanza Unity in
> esecuzione, i log rilevanti, l'artefatto di completamento (markdown)."*

Per qualsiasi chat (attiva o in pausa), un clic mostra tutto ciò di cui ho
bisogno per valutare l'avanzamento:

- **Contenuto della chat** — la trascrizione in corso con il ragionamento
  dell'agente, le chiamate a tool e gli output.
- **Stato server / Unity** — se lo slot è attivo, su quale branch, qual è
  lo stack di schermate, se Unity è in modalità Play.
- **Log rilevanti** — console Unity + server sidecar, filtrati per la
  sessione della chat, con scorrimento sincronizzato.
- **Artefatto di completamento** — il `proof.md` (e i file di supporto
  `before/`, `after/`, `diff.patch`) prodotto dall'agente, renderizzato in
  linea.

Questa è la vista "mostrami cosa è successo." Non il flusso grezzo
completo, ma la sezione curata che risponde a "questo è stato fatto bene?"

**Corrisponde a:** [POPBOT_DESIGN.md → Layout dell'app](POPBOT_DESIGN.md#layout-dellapp) (colonna chat + pannello log inferiore), [Artefatti di prova](POPBOT_DESIGN.md#artefatti-di-prova-deliverable-di-debug-dellagente). Il proof-renderer vive in `src/renderer/chat/ProofViewer.tsx` (pianificato).

---

## US-9 · Concessioni di permessi just-in-time

> *"Dovrei essere in grado di dare facilmente il permesso agli agenti di
> fare varie cose che non dovrebbero poter fare in modo completamente
> autonomo."*

Quando un agente vuole fare qualcosa che si trova nella lista "metti sempre
in pausa" (`git push`, `gh pr create`, `rm` fuori dallo slot, chiamate di
rete verso host non nella allowlist, ecc.), PopBot si mette in pausa e me
lo chiede. Il flusso di concessione è:

- Compare una modale con **cosa** l'agente vuole fare, **perché** (la
  motivazione dichiarata dall'agente), e il **comando / gli argomenti**.
- Posso **consentire una volta**, **consentire per questa chat / sessione**,
  **consentire sempre** (regola durevole per-tool, per-target), oppure
  **negare**.
- Le regole di consenso si accumulano per chat, mostrate nel pannello delle
  impostazioni della chat così posso revocarle.
- La lista di negazione hard-coded non è mai sovrascrivibile dalla UI —
  vedi [adr/0004](../adr/0004-canusetool-policy-boundary.md).

Il punto è: l'autonomia è il comportamento predefinito, ma posso approvare
senza attrito un'azione rischiosa specifica senza aprire un terminale o
sorvegliare l'agente.

**Corrisponde a:** [POPBOT_DESIGN.md → Modalità autonoma](POPBOT_DESIGN.md#modalità-autonoma), [adr/0004 — canUseTool policy boundary](../adr/0004-canusetool-policy-boundary.md). L'archivio dei grant vive in `src/main/agents/policy/`.

---

## Deviazioni e aggiunte

Questa sezione segnala i punti in cui le user story divergono dal design
bloccato. In fase di implementazione, usa le user story come fonte di
verità e aggiorna il documento di design.

### Slack come terza fonte di attenzione (US-1)

Il design originale copre i ticket Linear e le PR non revisionate. I
messaggi Slack non erano nell'ambito. Per rispettare la US-1:

- Aggiungere un **pannello Slack** al gruppo di tab in alto a sinistra
  accanto a Tickets e Reviews.
- Fonte: DM Slack, @menzioni e messaggi nei canali di cui sono proprietario.
  Regole di filtro da definire in base al workflow di generazione della
  chat.
- Autenticazione: Slack OAuth (token nel keychain tramite `keytar`).
- Generare una chat da un messaggio Slack inizializza l'agente con il
  contesto della conversazione.

Questo è un **sottosistema interamente nuovo** — client API Slack in
`src/main/slack/`, pannello in `src/renderer/panels/slack/`. Pianificarlo
in [PHASING.md](PHASING.md) Fase 3 insieme agli altri pannelli, ma trattarlo
come un elemento di prima classe, non un ripensamento.
