*Languages: [English](../CONFIGURATION.md) · [Español](../es/CONFIGURATION.md) · [Français](../fr/CONFIGURATION.md) · [Deutsch](../de/CONFIGURATION.md) · [日本語](../ja/CONFIGURATION.md) · [한국어](../ko/CONFIGURATION.md) · [简体中文](../zh-CN/CONFIGURATION.md) · [Português (Brasil)](../pt-BR/CONFIGURATION.md) · [Русский](../ru/CONFIGURATION.md) · [**Italiano**](CONFIGURATION.md)*

# Configurare PopBot

Tutto in PopBot viene configurato all'interno dell'app tramite **Preferenze** (l'icona a ingranaggio nella barra del titolo, o `⌘,`) — non ci sono file di configurazione da modificare manualmente. Questa guida percorre ogni pannello nell'ordine in cui compaiono nella nav, che corrisponde grosso modo all'ordine in cui li configureresti la prima volta.

> Le credenziali che inserisci (Linear, Jira, GitHub, Perforce, ecc.) sono memorizzate **localmente sulla tua macchina** nel database dell'app — mai in questo repository.

- [Integrazioni](#integrazioni) · [Agenti](#agenti) · [Runtime e slot](#runtime-e-slot) · [Repository](#repository) · [Controllo versione](#controllo-versione) · [App esterne](#app-esterne) · [Template dei prompt](#template-dei-prompt) · [Revisioni del codice](#revisioni-del-codice) · [Notifiche](#notifiche) · [Permessi](#permessi) · [Lingua](#lingua)

---

## Integrazioni

Qui convivono due gruppi indipendenti: la **fonte dei ticket** che alimenta la coda Ticket, e i **motori di gioco** che uno slot può avviare.

![Integrations — Linear](../../images/preferences_integrations1.png)

### Fonte dei ticket

Un unico issue tracker attivo alimenta la coda Ticket. Selezionalo dal menu in cima al pannello; il modulo di configurazione sottostante cambia di conseguenza. È attivo un solo tracker alla volta.

- **Linear** — incolla una API key (da *linear.app → Settings → API*). Facoltativamente imposta una **Team key** (es. `ENG`) per limitare il feed dei ticket a un team, e scegli un **Project** per restringerlo ulteriormente. Il salvataggio verifica la chiave e mostra con quale account si è connesso.
- **Jira** — inserisci l'URL del tuo sito (`https://your-domain.atlassian.net`), l'email dell'account e un token API (da *id.atlassian.com → Security → API tokens*). Facoltativamente limita a un **Project** e aggiungi un filtro **JQL** (es. `labels = backend`). Il salvataggio verifica le credenziali prima di renderle persistenti.
- **GitHub** — GitHub Issues non richiede credenziali qui: il provider si appoggia alla CLI `gh` che hai già autenticato per le review e le azioni git, e la coda copre gli stessi repository configurati in [Repository](#repository). Il modulo è un controllo di stato che conferma che `gh` sia installato e autenticato e riporta quanti repository copre.

Ogni tracker con credenziali le verifica al **Save** prima di renderle persistenti, e mostra un indicatore *Connected / Not connected*.

### Motori di gioco

A differenza della fonte dei ticket a selezione singola, i motori sono **indipendenti** — puoi abilitare Unity, Unreal e un motore Custom contemporaneamente. Ogni motore abilitato aggiunge un pulsante **Run** alla barra della chat che avvia il suo editor a partire dallo slot workspace della chat.

- **Enabled** — una checkbox per motore che mostra (o nasconde) il pulsante Run di quel motore sulla barra della chat.
- **Detected installs / Editor binary** *(Unity, Unreal)* — PopBot cerca gli editor installati (installazioni di Unity Hub / Epic), con un link **rescan**; scegli una versione rilevata, oppure inserisci un percorso assoluto **Editor binary** per sovrascrivere il menu a tendina.
- **Run command** *(Custom)* — un comando shell libero eseguito nella directory del progetto, con varianti separate per **macOS / Linux** e **Windows** così una singola configurazione funziona su più piattaforme. Un motore custom non ha auto-rilevamento; PopBot passa l'identità dello slot al tuo comando tramite una variabile d'ambiente `POPBOT_SLOT` così puoi collegare il tuo flusso "run and verify".
- **Project subpath** — il percorso del progetto del motore relativo alla radice del workspace (la cartella del progetto Unity; la cartella che contiene il `.uproject`; o la cwd in cui viene eseguito un comando custom). Lascia vuoto se la radice del workspace *è* il progetto.
- **Use MCP + Base MCP port** *(Unity, Unreal)* — quando la checkbox **Use MCP** è attiva, l'editor viene avviato puntando a un server MCP interno all'editor così un agente può pilotarlo. Ogni slot riceve la propria **porta dedicata** così gli slot paralleli non entrano mai in collisione: la porta è `basePort + (slotId − 1)` (slot 1 → base, slot 2 → base + 1, …). Il campo **Base MCP port** imposta la porta dello slot 1; per default è **8000 per Unreal** e **8080 per Unity** (in linea con il default del plugin MCP di ciascun motore) e viene ripristinato a quel default quando svuotato.
- **Show project path in title bar** *(Unity)* — un pulsante **Install title-bar script** che inserisce un piccolo script editor nel tuo progetto Unity così ogni Editor aperto mostra il proprio percorso completo del progetto nella barra del titolo, rendendo facile distinguere le finestre degli slot. Lo script è sicuro da commitare.

> **Slack** e **Sentry** restano stub di connessione anziché fonti di inbox effettivamente collegate, quindi oggi non sono mostrati come pannelli qui. Possono essere riabilitati senza cambiamenti strutturali; vedi la nota alla fine della [Guida alle funzionalità e ai flussi di lavoro](GUIDE.md).

## Agenti

**Sforzo di ragionamento** (reasoning effort) predefinito del modello per le chat di nuova creazione (le chat esistenti mantengono il proprio finché non lo cambi nel composer della chat).

![Agents](../../images/preferences_agents.png)

- Imposta lo sforzo indipendentemente per **Claude** e **Codex**, e separatamente per:
  - **New chats** — chat generiche e chat da ticket.
  - **Code reviews** — chat di revisione PR, chat di fallback per le re-review, e notifiche di revisione.

Uno sforzo maggiore significa ragionamento più approfondito e uso più accurato degli strumenti, a fronte di costo e latenza maggiori. Le revisioni spesso richiedono una profondità diversa rispetto allo sviluppo di funzionalità — da qui la separazione.

## Runtime e slot

Questo pannello controlla la **conservazione degli allegati**. (Il dimensionamento del pool di slot è ora per-repository e si trova in [Repository](#repository) — vedi la nota lì.)

![Runtime & slots](../../images/preferences_slots.png)

- **Keep attachments for** — per quanto tempo i file e le immagini che alleghi a una chat vengono conservati nello storage proprio di PopBot (default 60 giorni, intervallo 1–365). Gli allegati vengono copiati nello storage di PopBot così continuano ad aprirsi dalla cronologia della chat anche dopo che l'originale è stato spostato; una pulizia all'avvio elimina le copie più vecchie di questa finestra così la cartella non può crescere senza limiti.

> Lo screenshot sopra potrebbe precedere la separazione del dimensionamento del pool di slot nel flusso per-repository.

## Repository

Ogni chat vive in un **repository**. Questo pannello elenca i tuoi repository ed è dove si configurano il controllo versione, gli slot e i workspace copy-on-write per ciascun repository.

![Repositories](../../images/preferences_repositories.png)

- **Add Repository** apre una procedura guidata che parte dalla cartella: scegli una cartella, e PopBot **rileva il suo controllo versione** (Git o Perforce) e si ramifica di conseguenza. Poi imposti un id, un colore identificativo, un prefisso slot e un numero di slot.
  - I repository **Git** scelgono la modalità **slots** (un pool riutilizzato di workspace — il default, mostrato come `slots × N`) oppure **ephemeral** (un workspace nuovo per ogni chat). La modalità slots mantiene calde le cache di build tra una chat e l'altra.
  - I repository **Perforce** sono sempre in modalità slot. La procedura guidata cattura la connessione P4, esegue un **pre-flight del disco**, e costruisce una **base image** congelata dell'albero sincronizzato; gli slot vengono poi creati come figli copy-on-write di quella base (vedi sotto).
- **Workspace copy-on-write.** Il workspace di uno slot è una cartella copy-on-write che condivide un'unica **base image** del repository e memorizza solo i blocchi che modifica, tramite `shado` (il layer di shadow-workspace di PopBot): **VHDX differencing** su Windows, copy-on-write nativo (APFS / reflink) su macOS e Linux. Dieci slot su un albero dell'ordine del terabyte costano all'incirca il disco di un repository più il piccolo delta di ciascuno slot — è ciò che permette agli alberi Perforce di grandi dimensioni di partecipare affatto. La base image viene costruita una sola volta, come passo della procedura guidata Add-Repository.
- **La modalità è permanente.** La modalità slots-vs-ephemeral di un repository è fissata alla creazione; cambiarla renderebbe orfani i workspace delle chat in corso.
- **Edit** su un repository per cambiarne il colore identificativo, il branch base predefinito (Git), o la directory di lavoro dell'agente Perforce, e per **Resize slots** (ampliare o ridurre il pool uno workspace alla volta, subordinato alla chiusura di tutte le chat di quel repository).
- **Delete** un repository; la conferma avvisa se ci sono ancora chat che lo referenziano.

Più repository funzionano affiancati, ognuno con il proprio pool di slot e colore identificativo (il colore tinge le pillole di slot di quel repository così puoi distinguere le chat a colpo d'occhio). Ogni scheda repository mostra il proprio provider di controllo versione e la propria modalità.

## Controllo versione

Impostazioni globali del controllo versione e i template modificabili delle azioni. I pannelli Git e Perforce sono mostrati affiancati, perché il provider di un repository viene rilevato per cartella ed entrambi potrebbero essere in uso contemporaneamente.

![Source control](../../images/preferences_source_control.png)

- **Change-view file limit** *(condiviso)* — il numero massimo di file mostrati nella vista delle modifiche prima che l'elenco venga troncato. Si applica sia a Git che a Perforce.

**Git**

- **Branch username** — il prefisso per i nuovi branch: `<username>/<ticket>-<slug>`.
- **Action templates** — i prompt che il pannello SCM invia all'agente per **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR**, e **Rebase onto base**. Ognuno supporta macro `${name}` (`${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, `${prurl}`…).

**Perforce**

- **Connection defaults** — il percorso del binario `p4`, la porta server predefinita, e l'utente predefinito, che pre-compilano il passo Add-Repository → connessione Perforce.
- **Transfer / submit options** — numero di thread di sync paralleli, e se ripristinare i file invariati al submit.
- **Swarm review poll interval** — ogni quanto il pannello Reviews interroga Helix Swarm per le changelist in attesa della tua revisione. Questo è **indipendente dal polling di GitHub** e ha un **minimo di 30 secondi**; alzalo per alleggerire il carico su un server Perforce/Swarm condiviso su larga scala.
- **Perforce action templates** — i prompt che il pannello Perforce invia all'agente per **CR** (apre/aggiorna una review Helix Swarm), **Run tests**, e **Review & commit**, ognuno con macro `${name}`.

## App esterne

Le app desktop che PopBot avvia dalla riga di icone di una chat, tutte puntate sullo slot workspace di quella chat.

![External apps](../../images/preferences_external_apps.png)

- **Terminal** — quale terminale apre il launcher dell'icona terminale (es. iTerm2).
- **Terminal shell (Windows)** — la shell usata dal pannello terminale integrato: PowerShell, Command Prompt, o PowerShell 7. Si applica ai terminali aperti dopo la modifica.
- **Code editor** — VS Code o Cursor; usato anche per i link cliccabili `file.ts:42` nelle righe dello strumento Edit.
- **Git client** — il default è GitHub Desktop.
- **Chrome profile for URLs** — fissa l'apertura dei link a un profilo Chrome specifico (in base al nome della sua *directory* di profilo) così finiscono sempre nel tuo account di lavoro.

> I binari dei motori e le loro opzioni MCP si configurano in [Integrazioni → Motori di gioco](#integrazioni), non qui.

## Template dei prompt

Il primo messaggio che PopBot invia quando una chat viene generata. Ogni template è modificabile, con una scheda di riferimento delle macro `${name}` disponibili. (I template delle azioni del pannello SCM si trovano in [Controllo versione](#controllo-versione).)

![Prompt templates](../../images/preferences_prompt_templates.png)

- **Start ticket** — attivato quando generi una chat da un ticket, indipendentemente dalla fonte (Linear, Jira, o GitHub Issues). Le macro includono `${ticketid}`, `${tickettitle}`, `${markdown}`, `${branch}`, e `${slot}`.
- **Start code review** — attivato quando generi una chat da una review — una PR GitHub o una changelist Helix Swarm. Il default indirizza l'agente a usare la skill di review, leggere il codice circostante (non solo il diff), e trattare la chat come di sola lettura.
- **Re-review** — attivato quando riesamini una chat di review esistente; limita l'agente ai soli nuovi commit.

Regola questi template per codificare le convenzioni, le checklist e il tono del tuo team.

## Revisioni del codice

Controlli per l'inbox **Reviews**. La coda mostra le PR GitHub e le changelist Helix Swarm in attesa della tua revisione; le PR che hai già revisionato vengono rimosse automaticamente.

![Code reviews](../../images/preferences_code_reviews.png)

- **Search cache window** — quanti giorni indietro il selettore **+ Add** effettua il fuzzy-match dei ticket e delle PR recenti (più grande = più ricercabile, aggiornamento leggermente più lento e maggior consumo di budget API). I ticket assegnati a te sono sempre inclusi indipendentemente da questo limite.
- **Ignore by title** — sottostringhe (una per riga, case-insensitive) che escludono una PR dalla coda.
- **Ignore by GitHub author** — login di bot/autori (uno per riga, es. `renovate[bot]`) da silenziare.

> I **poll rate** delle review si configurano per provider, non qui: l'intervallo di polling di Helix Swarm si trova in [Controllo versione → Perforce](#controllo-versione), indipendente dal polling di GitHub, così un server Perforce/Swarm condiviso può essere protetto senza rallentare GitHub.

## Notifiche

Come emergono gli avvisi.

![Notifications](../../images/preferences_notifications.png)

- **VIP names** — persone i cui messaggi vengono sempre promossi a priorità urgente. Confrontati come sottostringhe case-insensitive del nome visualizzato, quindi mantieni i nomi specifici.
- **Toast placement** — *Top-center, fly to bell on dismiss* (default), oppure toast classici nell'angolo in alto a destra. Il toggle si applica immediatamente.
- **Test new-item flow** — contrassegna temporaneamente alcuni elementi reali della coda come NEW per anteprima del comportamento di chip/pip (nulla viene reso persistente). È un ausilio di sviluppo temporaneo.

## Permessi

Il default globale per ogni strumento dell'agente, e il limite minimo sotto la modalità autonoma.

![Permissions](../../images/preferences_permissions.png)

- Per ogni strumento (**Bash**, **Read**, **Write**, **Edit**, **Grep**, **Glob**, **WebFetch**, **WebSearch**, …): **Ask** (chiede conferma ogni volta — il default), **Allow** (approvazione automatica), o **Deny** (rifiuto automatico).
- **Autorizzazioni per server MCP.** Il server MCP dell'editor di uno slot (Unity, Unreal, o qualunque server MCP caricato da un agente) può essere autorizzato negli stessi tre modi. Concedere una volta l'accesso al server MCP dell'editor di uno slot viene ricordato, e la concessione è visibile e revocabile qui — mostrata come `unityEditor → all tools` / `unrealEditor → all tools` anziché il namespace grezzo. PopBot abilita in questo modo automaticamente gli MCP editor di Unity e Unreal; una regola per singolo strumento che differisce da un wildcard viene mantenuta come override.
- Le regole per singola chat (impostate dalla scheda dei permessi tramite *Allow this chat* / *Deny this chat*) sovrascrivono queste impostazioni globali, così una singola chat può bloccare uno strumento che hai altrimenti consentito ovunque.

> Un limite di hard-deny — `git push` / `p4 submit`, rete verso host non in allowlist, qualunque cosa fuori dal workspace — risiede nel codice e **non** è sovrascrivibile qui, così una regola configurata male non può permettere a un agente di arrivare al mainline per conto proprio.

## Lingua

L'interfaccia di PopBot è completamente localizzata.

- **Display language** — cambia la lingua dell'interfaccia dal menu della lingua, che elenca ogni lingua nel proprio nome nativo. Le lingue disponibili al momento sono inglese, spagnolo, francese, tedesco, cinese (semplificato), giapponese, coreano, e portoghese (brasiliano). La maggior parte dei testi e dei menu si aggiorna immediatamente; alcune stringhe di sistema completano l'aggiornamento dopo un riavvio. Anche le nuove finestre e il menu dell'app usano questa lingua.

---

Vedi la **[Guida alle funzionalità e ai flussi di lavoro](GUIDE.md)** per come queste impostazioni si traducono in flussi di lavoro reali.
