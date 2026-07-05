*Languages: [English](../GUIDE.md) · [Español](../es/GUIDE.md) · [Français](../fr/GUIDE.md) · **Deutsch** · [日本語](../ja/GUIDE.md) · [한국어](../ko/GUIDE.md) · [简体中文](../zh-CN/GUIDE.md) · [Português (Brasil)](../pt-BR/GUIDE.md) · [Русский](../ru/GUIDE.md) · [Italiano](../it/GUIDE.md)*

# PopBot — Feature- & Workflow-Guide

PopBot ist ein Desktop-Cockpit, um **viele KI-Coding-Agents parallel** laufen zu lassen. Dieser Guide behandelt die Ideen, auf denen es aufbaut — warum es existiert, wie die Teile funktionieren, was das Design geprägt hat, und wie ein Team bei Proof of Play es auf einem echten, asset-lastigen Projekt eingesetzt hat, das released wurde. Er ist für Engineers geschrieben, die die UI selbst finden können; der Punkt hier ist die Begründung, damit ihr das Tool an euren eigenen Workflow anpassen könnt, statt einem Skript zu folgen.

Es an euren Workflow anzupassen ist eine beabsichtigte Nutzung, kein nachträglicher Gedanke. PopBot wird als Referenzimplementierung veröffentlicht — eine Form, die für euer Team modifiziert wird, statt ein fixes Produkt — was eine Sichtweise darüber widerspiegelt, wie Software im Zeitalter von KI am besten gebaut wird: Teams, die Flotten von Agents betreiben, sind generell besser bedient, wenn sie das Tool besitzen und umformen, statt eines zu übernehmen, dessen Entscheidungen für sie fixiert sind. Lest das "Warum" hinter jedem Teil unten als Karte, wo ihr ansetzen würdet, um es zu ändern. [Macht es zu eurem eigenen](#macht-es-zu-eurem-eigenen) behandelt das Wie, Wo und Warum im Detail.

- [Warum wir PopBot gebaut haben](#warum-wir-popbot-gebaut-haben)
- [Kernkonzepte](#kernkonzepte)
  - [Agents & Modelle](#agents--modelle)
  - [Slots: warme, isolierte, wegwerfbare Workspaces](#slots-warme-isolierte-wegwerfbare-workspaces)
  - [Copy-on-Write: unbegrenzte Kopien auf der Disk eines Repos](#copy-on-write-unbegrenzte-kopien-auf-der-disk-eines-repos)
  - [Versionskontrolle: Git und Perforce](#versionskontrolle-git-und-perforce)
  - [Das Postfach: eine Queue, viele Quellen](#das-postfach-eine-queue-viele-quellen)
  - [Repolose Chats (für Code-Review)](#repolose-chats-für-code-review)
  - [Base-Branch](#base-branch)
  - [Persistente, archivierbare Chats](#persistente-archivierbare-chats)
- [Anatomie des Workspace](#anatomie-des-workspace)
- [Wie es bei Proof of Play genutzt wurde](#wie-es-bei-proof-of-play-genutzt-wurde)
- [End-to-End-Workflows](#end-to-end-workflows)
  - [Ein Feature-Ticket](#ein-feature-ticket)
  - [Ein Bug-Ticket](#ein-bug-ticket)
  - [Ein Code-Review](#ein-code-review)
  - [Einen archivierten Chat wieder öffnen](#einen-archivierten-chat-wieder-öffnen)
- [Integrierte Versionskontrolle & Review](#integrierte-versionskontrolle--review)
- [Testen in einem Slot: die App unter Test](#testen-in-einem-slot-die-app-unter-test)
- [Berechtigungen & Sicherheit](#berechtigungen--sicherheit)
- [Lokalisierung](#lokalisierung)
- [Preferences](#preferences)
- [Macht es zu eurem eigenen](#macht-es-zu-eurem-eigenen)

---

## Warum wir PopBot gebaut haben

Ein einzelner KI-Coding-Agent ist leicht auszuführen. In dem Moment, in dem ihr **mehr als einen gleichzeitig** wollt, tauchen drei Probleme auf:

1. **Isolation.** Zwei Agents, die denselben Checkout bearbeiten, korrumpieren gegenseitig ihre Arbeit. Ihr könnt nicht drei Agents und einen Arbeitsbaum haben — und bei einem großen Spieleprojekt könnt ihr euch auch drei vollständige Checkouts nicht leisten.
2. **Aufsicht.** Agents sind schnell und meistens richtig, aber "meistens" reicht nicht für `git push`, `p4 submit` oder das Öffnen einer PR. Ihr braucht ein menschliches Gate bei den irreversiblen Aktionen — ohne jede Dateibearbeitung zu beaufsichtigen.
3. **Verifikation.** Code, der kompiliert, ist nicht Code, der funktioniert. Besonders bei einem Spiel ist der einzige echte Test, es *auszuführen* und sich durchzuklicken. Ein Agent, der die App nicht sehen kann, rät.

PopBot wurde gebaut, um alle drei für ein kleines Team zu lösen, das ein Live-Spiel released hat. Die Erkenntnis: jede Arbeitseinheit — ein Ticket, ein Bug, ein Review — als **Chat** behandeln, jedem Chat seinen eigenen isolierten **Workspace** geben plus (bei Bedarf) seine eigene laufende Kopie der App, sie **autonom, aber gegated** laufen lassen und die gesamte Flotte in einem Fenster darstellen, damit eine Person ein Dutzend Agents gleichzeitig leiten kann.

Das Design wurde von einem konkreten Satz von [User Stories](USER_STORIES.md) getrieben: *"Als Engineer klicke ich ein Ticket an, und ein Agent beginnt, es auf einem korrekten Branch zu bearbeiten."* *"Als Reviewer öffne ich eine Changelist und bekomme ein echtes Review, ohne irgendetwas auszuchecken."* *"Als Lead werfe ich einen Blick auf die Wand und weiß, welche Agents mich brauchen."* Alles unten existiert, um diesen zu dienen. Wenn ihr versteht, *warum* jedes Teil so geformt ist, wie es ist, wisst ihr, welche Teile ihr behalten und welche ihr ersetzen solltet, wenn ihr es für euren eigenen Stack forkt.

---

## Kernkonzepte

### Agents & Modelle

Jeder Chat wird von einem **Agent-Backend** gesteuert:

- **Claude Code** — via das Claude Agent SDK. Modelle: **Claude Opus** (Standard) und **Claude Fable**.
- **Codex** — via das OpenAI Codex SDK. Modell: **GPT / Codex**.

PopBot reimplementiert diese Agents nicht — es **steuert die echten**, über ihre offiziellen SDKs, die dieselben Kommandozeilen-Tools **`claude`** und **`codex`** umhüllen, die ihr im Terminal ausführen würdet. Die volle Kraft jedes Agents — seine Tools, Skills, MCP-Server und Subagents — ist in jedem Chat verfügbar, und PopBot bleibt im Gleichschritt mit jeder Version dieser CLIs, die ihr installiert habt. Wenn es im Terminal-Claude-Code funktioniert, funktioniert es hier. Das ist eine bewusste Wette: Agents verbessern sich schnell, und alles, was sie umhüllt oder geforkt hätte, würde veralten. Indem es die CLIs direkt steuert, erbt PopBot jedes Upgrade kostenlos.

Pro Chat wählt ihr das Backend, das **Modell** und den **Reasoning-Effort** (`low` → `xhigh` / `max` — mehr Effort bedeutet tieferes Denken und gründlicheren Tool-Einsatz, bei höheren Kosten/Latenz). Ihr setzt sinnvolle **Standardwerte** — separat für *neue Chats* und für *Code-Reviews*, da ein Review eine andere Tiefe will als ein Feature-Build — und überschreibt sie pro Chat, wenn eine Aufgabe es rechtfertigt.

Zwei Session-Steuerelemente sind für lang laufende Arbeit wichtig:

- **Mitten in der Session wechseln.** Modell oder Effort bei einem laufenden Chat ändern; PopBot rekonfiguriert den Agent, ohne den Faden zu verlieren.
- **Mit Kontext neustarten.** Eine *frische* Agent-Session starten, geprimt mit dem Transcript dieses Chats (seinen Eröffnungszügen plus den jüngsten), nützlich, wenn eine Session lang oder verkeilt wird. Die Konversationshistorie bleibt erhalten, der Agent bekommt lediglich eine saubere Laufzeitumgebung.

Credentials für die Integrationen werden **lokal auf eurer Maschine** gespeichert, in der eigenen Datenbank der App — niemals in diesem Repository.

### Slots: warme, isolierte, wegwerfbare Workspaces

Ein **Slot** ist die Einheit der Parallelität, und es ist die zentrale Idee in PopBot. Die naive Art, N Agents laufen zu lassen, ist N Checkouts des Repos — was auf gemeinsamen Bäumen kollidiert oder N × (Checkout-Zeit + Build-Cache) kostet. Ein Slot ist die Antwort auf "wie gebt ihr einem Agent einen *echten, unabhängigen* Ort zum Arbeiten, der auch schon *warm* und *billig zurückzugeben* ist."

Ein Slot hat drei Eigenschaften, und jede davon ist tragend:

- **Isoliert.** Jeder Slot ist sein eigenes Arbeitsverzeichnis auf seinem eigenen Branch (oder Perforce-Stream), sodass N Agents N Branches ohne jede Interferenz bearbeiten. Der `git reset` eines Agents kann die Arbeit eines anderen nicht berühren.
- **Warm.** Ein Slot behält zustandsbehaftete Build-Artefakte, die über Nutzungen hinweg bestehen bleiben — bei einer Game-Engine ihren eigenen Import-/Asset-Cache; einen dedizierten **Sidecar-Server** mit eigenem Datenverzeichnis; zugewiesene **Ports**; Logs pro Slot; und, während ein Chat aktiv ist, einen lebenden **Editor-Prozess**. Ein bloßes Arbeitsverzeichnis gibt euch isolierte *Quellen*; ein Slot gibt euch einen isolierten, bereits *aufgewärmten* Ort zum Bauen, Ausführen und Testen.
- **Wegwerfbar.** Slots werden gepoolt. Ein Chat **leased** einen freien Slot für seine Lebensdauer und **gibt ihn zurück** beim Schließen. Einen warmen Workspace zu erstellen ist teuer; einen wiederzuverwenden ist nahezu kostenlos, also hält PopBot einen Pool von ihnen warm und zirkuliert Arbeit durch ihn hindurch.

**Warum "warm" das ganze Spiel für Engine-Arbeit ist.** Eine Game-Engine hält einen massiven verarbeiteten Asset-Cache — Unitys `Library/`, Unreals `DerivedDataCache` — oft mehrere Gigabyte, teuer zu erzeugen. Ein frischer Checkout, oder ein Branch-Wechsel, der ihn invalidiert, zwingt die Engine zum **Reimport des Projekts**, was viele Minuten dauern kann. Zahlt das bei jeder Aufgabe und jedem Branch-Wechsel, und eure Agents verbringen mehr Zeit damit, auf die Engine zu warten, als Code zu schreiben. Slots eliminieren diese Steuer, indem jeder seinen **eigenen persistenten Cache** bekommt:

- **Einen Agent zurück in seinen Slot zu wechseln dauert Sekunden, nicht Minuten** — der Cache ist bereits warm, sodass nur wirklich geänderte Assets neu verarbeitet werden.
- **Ein Slot kann den Editor am *Laufen* halten.** Eine "klebrige" Wiederverwendung (derselbe Slot, derselbe Branch) übergibt dem Agent fast sofort einen lebenden Editor statt eines kalten Starts.
- **Zehn Agents strapazieren nicht einen einzigen Import-Cache.** Jeder Slot hat seinen eigenen warmen Cache, sodass parallele Spielarbeit nie hinter einem einzigen Reimport serialisiert.

Vor jedem Branch-Wechsel führt PopBot eine **Sicherheitssequenz** aus — sie stasht unbestätigte Arbeit, weigert sich, Commits zu überschreiben, die dem Agent gehören, wechselt und stellt den Zustand wieder her — sodass eine Slot-Übergabe niemals stillschweigend Arbeit verliert. Slots können im **Slot-Pool**-Modus (wiederverwendet, Standard) oder im **ephemeren** Modus (ein frischer Workspace pro Chat) laufen, wenn ihr lieber Wärme gegen einen sauberen Zustand eintauscht.

> **Warum das wichtig ist:** Isolation ist es, was "zehn Agents gleichzeitig" sicher statt katastrophal macht. Wärme ist es, was es *schnell* macht. Wegwerfbarkeit ist es, was es *billig* macht. Nehmt eine davon weg, und parallele Agents hören auf, sich zu lohnen.

### Copy-on-Write: unbegrenzte Kopien auf der Disk eines Repos

Isolation und Wärme sind nur erschwinglich, wenn die *Dateien* eines Slots billig sind. Bei einem kleinen Repo sind N Git-Worktrees in Ordnung. Bei einem terabyte-großen Spieleprojekt — mit einer riesigen Asset-Bibliothek und, bei vielen Teams, **Perforce** statt Git — wären N echte Kopien Hunderte Gigabyte und Minuten pro Materialisierung. Das killt das ganze Modell.

Also ist der Workspace eines Slots ein **Copy-on-Write-Ordner**. Jeder Slot teilt sich ein **Basis-Image** des Repos und speichert nur die Blöcke, die er tatsächlich ändert. Das praktische Ergebnis:

- **Eine frische, lebendige, vollständige Kopie eines terabyte-großen Baums ist in Sekunden bereit** — keine flache Ansicht, echte editierbare Dateien — und wird genauso schnell freigegeben.
- **Unbegrenzte Kopien kosten die Disk eines einzigen Repos.** Zehn Agents auf einem 1-TB-Projekt brauchen keine 10 TB; sie brauchen ~1 TB plus das kleine Delta jedes Slots.
- **Es funktioniert gleich auf Windows, macOS und Linux** (via `shado`, PopBots Shadow-Workspace-Schicht — differenzierendes VHDX auf Windows, native CoW-Dateisysteme anderswo), und es ist das, was Perforce-Bäumen überhaupt erst erlaubt teilzunehmen.

Das ist das Teil, das die Slot-Idee von "ein Web-Repo mit ein paar Worktrees" auf "ein AAA-großer Game-Tree mit einer Flotte von Agents" skalieren lässt. Es ist auch das am wenigsten sichtbare Feature und wohl das wichtigste: ohne billige Kopien sind warme isolierte Slots ein Luxus; mit ihnen sind sie der Standard.

### Versionskontrolle: Git und Perforce

PopBot behandelt Versionskontrolle als einen **Provider** hinter einer gemeinsamen Schnittstelle, weil "einen Agent auf einem isolierten Branch laufen lassen, dann den Change reviewen und landen" dieselbe Form hat, egal ob das Backend Git oder Perforce ist. Beide sind erstklassig:

- **Git** — Worktrees für Isolation, Branches pro Chat, PRs via die `gh`-CLI, GitHub als Review-Oberfläche.
- **Perforce** — Streams/Branches pro Chat über Copy-on-Write-Shadow-Workspaces, Changelists als Arbeitseinheit, und **Helix Swarm** als Review-Oberfläche. Swarm-Reviews docken in dasselbe Reviews-Postfach an wie GitHub-PRs, jede öffnet ihren eigenen Review-Chat.

Die Konzepte, die ihr unten seht — Base-Branch, das Git-/SCM-Panel, Templated Actions, das Review-Postfach — sind gegen diese gemeinsame Schnittstelle geschrieben. Wo der Wortlaut "Branch" oder "PR" sagt, lest "Changelist" oder "Swarm-Review", wenn ihr auf Perforce seid; der Workflow ist bewusst identisch.

### Das Postfach: eine Queue, viele Quellen

Das Postfach ist eine *Idee*, keine Integration: **eure zugewiesene Arbeit und eure ausstehenden Reviews, gerankt, jeweils einen Klick von einem Agent-Chat entfernt.** Was es speist, ist steckbar:

- **Tickets** — **Linear**-Issues, **Jira**-Issues und **GitHub Issues**, die euch zugewiesen sind (GitHub-Issues-Support ist neuer und noch etwas experimentell). Klickt eines an, und PopBot benennt einen Branch, least einen Slot, verschiebt das Ticket zu *In Progress* und seedet den Agent mit seiner Beschreibung.
- **Reviews** — **GitHub**-Pull-Requests und **Helix-Swarm**-Changelists, die auf euer Review warten. Klickt eines an, und ein repoloser Review-Chat öffnet sich sofort.

Eine Quelle hinzuzufügen ändert den Workflow nicht — es fügt lediglich Zeilen zur selben Queue hinzu. Das ist der Punkt: das Postfach-als-Queue-Modell ist generisch, und die spezifischen Tracker sind austauschbare Standardwerte.

### Repolose Chats (für Code-Review)

Nicht jeder Chat braucht einen Workspace. **Reviewen** eines Changes ist nur-lesend — ihr editiert nicht, ihr lest den Diff und den umgebenden Code und postet Kommentare. Also sind Review-Chats **repolos**: sie entstehen sofort, leasen keinen Slot und verbrauchen keinen Workspace.

Das ist eine bewusste, wichtige Trennung:

- Ein **Build-Chat** (Feature/Bug) least einen Slot, braucht vielleicht einen Moment zum Aufwärmen, und hält einen Workspace für seine Lebensdauer.
- Ein **Review-Chat** ist **sofort und kostenlos** — ihr könnt fünf davon öffnen, um eure Review-Queue zu triagieren, während eure Build-Chats ungestört weiterlaufen.

Es bedeutet auch, dass euer Slot-Pool für Arbeit reserviert ist, die tatsächlich Isolation braucht. Reviews entziehen Builds nie Slots — eine Eigenschaft, die stark ins Gewicht fällt, wenn der Pool durch RAM und Disk begrenzt ist.

### Base-Branch

Wenn ein Chat *tatsächlich* Code schreibt, forkt er von einer **Base** — typischerweise `develop`/`main` bei Git, oder dem Mainline-Stream bei Perforce. PopBot setzt die Base standardmäßig pro Repository, merkt sich eure letzte Wahl, sodass der übliche Fall ein Klick ist, und lässt euch von einer Feature-Linie oder einem Release-Branch abzweigen, wenn eine Aufgabe es braucht. Es leitet den neuen Branch-Namen aus eurer Konvention ab — z. B. `<username>/<ticket>-<slug>` — sodass Branches konsistent und bis zu ihrem Ticket zurückverfolgbar sind. Die Base treibt auch spätere Aktionen an: "Rebase onto base", "PR/Review gegen Base öffnen" und Drift-Checks hängen alle daran.

### Persistente, archivierbare Chats

Jeder Chat ist ein **dauerhaftes Transcript**, lokal gespeichert — Prosa, Tool-Aufrufe, Diffs, Berechtigungsentscheidungen, alles. Nichts ist flüchtig.

- **Schließen** eines Chats gibt seinen Slot frei (gibt einen Workspace für andere Agents frei), **behält aber alles**. Der Chat wandert ins **Archiv**.
- **Wiedereröffnen** eines Chats aus dem Archiv least neu einen Slot, stellt seinen Branch wieder her, und der Agent nimmt mit seiner **vollständigen Historie** die Arbeit wieder auf — ihr könnt ein Feature Tage später wieder aufgreifen, um Review-Feedback zu adressieren, ohne irgendetwas neu zu erklären. Wenn es in einem *anderen* Slot landet, sagt PopBot dem Agent das vorab, sodass er sich sauber am neuen Arbeitsverzeichnis orientiert.
- Das Archiv ist durchsuchbar nach Name, Ticket, Branch und Inhalt.

Weil Rollback nur "eine weitere Nachricht senden" ist (es gibt keine destruktiven Historien-Edits), sammelt ein Chat die vollständige, auditierbare Geschichte an, wie ein Change entstanden ist.

---

## Anatomie des Workspace

![PopBot UI anatomy](../../images/anatomy.png)

| Bereich | Was es ist |
|---|---|
| **Postfach — Tickets & Reviews** | Zugewiesene Tickets (Linear / Jira / GitHub Issues) und Reviews, die auf euch warten (GitHub PRs / Swarm-Changelists), gerankt. Klickt eine Zeile an, um einen Chat zu erzeugen, geseedet mit ihrem Kontext. |
| **Slots** | Der Pool warmer Workspaces. Jede Pille zeigt, ob ein Slot frei ist oder von einem Chat geleast wird. |
| **Chat-Archiv** | Jeder vergangene Chat, durchsuchbar und mit vollständiger Historie wieder öffenbar. |
| **Chat-Thumbnails** | Eine lebendige, scrollende Vorschau jedes offenen Chats — eine echte Ansicht dessen, was jeder Agent gerade tut, farbcodiert nach Status: blau = läuft, grün = fertig, gelb = braucht euch, rot = Fehler, grau = untätig. |
| **Chats** | Die fokussierten Agent-Sessions — gestreamte Prosa, Tool-Aufrufe und Inline-Code-Diffs. |
| **Terminal pro Chat** | Ein eingebettetes Terminal, das an diesem Chat-Workspace verankert ist. |
| **SCM-Panel** | Arbeitsbaum-/Changelist-Status, jüngste Commits, Datei-Diffs und Ein-Klick-Commit-/Push-/PR-/Review-Aktionen. |

Weil jeder Chat auf der **Thumbnail-Leiste** bleibt und die **Spalten nebeneinander sitzen**, jagt ihr nie einem Status hinterher. Die Farbe ist das Signal — blau = läuft, grün = fertig, gelb = braucht euch, rot = Fehler — sodass ein Blick euch sagt, welche Agents arbeiten, welche fertig sind und welche **auf euch warten**.

Aber jedes Thumbnail ist auch eine **lebendige Vorschau der Konversation**, nicht nur eine Statusleuchte — sodass ihr auf einen Blick sehen könnt, *was* jeder Agent tatsächlich gerade bearbeitet. Das ist es, was euch erlaubt, **nutzlose Arbeit frühzeitig zu erkennen**: erspäht einen Agent, der den falschen Weg geht, und lenkt ihn um, bevor er Zeit und Tokens verbrennt, statt die Sackgasse zu entdecken, nachdem er "fertig" ist. Das ist der Unterschied zwischen dem Beaufsichtigen einer Flotte und dem Überrascht-Werden von ihr.

### Warum Thumbnails, und warum eine Ansicht

Dieses Layout ist eine bewusste Antwort auf ein spezifisches Problem, und es lohnt sich, die Begründung darzulegen, weil es der Teil ist, den die meisten Tools falsch machen.

Einen Agent laufen zu lassen ist eine Fokus-Aufgabe: ihr beobachtet eine einzelne Konversation und antwortet. *Viele* laufen zu lassen ist eine **Monitoring**-Aufgabe, und Monitoring hat einen anderen Fehlermodus — der Engpass ist nicht eure Tippgeschwindigkeit, es ist eure Aufmerksamkeit. Ein Agent, der still abschweift, produziert Arbeit, die ihr bemerken, verstehen und wegwerfen müsst. Mit N Agents skaliert die Kosten des *Nicht-Bemerkens* mit N, und die natürlichen Schnittstellen machen das Bemerken schwer: Tabs verbergen jeden Agent bis auf einen, und ein Start-und-Warten-Modell verbirgt sie alle, bis sie ein Ergebnis zeigen.

Also verpflichtet sich das Design zu zwei Dingen:

- **Jeder Agent ist immer sichtbar.** Die Thumbnail-Leiste zeigt die gesamte Flotte auf einmal, und jedes Thumbnail ist eine lebendige Ansicht der tatsächlichen Konversation, kein Spinner. Ihr sollt in der Lage sein, zurückzutreten und den Zustand eines Dutzend Agents in einem Blick zu erfassen — welche Agents sich bewegen, welche feststecken, welche kurz davor sind, etwas zu tun, das ihr stoppen wollen würdet.
- **Status ist eine Farbe, Inhalt ist einen Blick entfernt.** Farbe beantwortet "wer braucht mich?" in unter einer Sekunde; die lebendige Vorschau beantwortet "was macht dieser gerade?" ohne einen Klick; und die nebeneinanderliegenden Spalten lassen euch in jeden von ihnen eintauchen, ohne die anderen zu verlieren. Die Oberfläche ist für *billiges Nachprüfen* optimiert, weil ihr mit vielen Agents ständig nachprüft.

Der Gewinn ist die Fähigkeit, **frühzeitig einzugreifen**. Der teure Fehler bei autonomen Agents ist kein Crash — es ist ein Agent, der selbstbewusst eine Stunde damit verbringt, das Falsche zu bauen. Eine Ansicht, die Intention kontinuierlich zutage fördert, verwandelt das von einer nachträglichen Entdeckung in eine Kurskorrektur mittendrin. Das ist der gesamte Grund, warum die Flotte jederzeit auf dem Bildschirm ist statt hinter Tabs oder einer Benachrichtigung.

---

## Wie es bei Proof of Play genutzt wurde

PopBot war kein Laborexperiment. Es wurde vom Team bei **Proof of Play** gebaut und täglich auf einem echten, asset-lastigen Projekt genutzt, das released wurde. Dieser Ursprung erklärt die meisten Design-Entscheidungen, und es ist die klarste Art zu verstehen, wofür das Tool gedacht ist.

Das praktische Ergebnis war unkompliziert: das Slot-Modell — warme, isolierte, Copy-on-Write-Workspaces — machte paralleles Agent-Arbeiten auf einem großen Asset-Baum machbar, und das Team schaffte dadurch mehr. Mehrere Agents konnten gleichzeitig laufen, ohne zu kollidieren oder bei jedem Wechsel die Reimport-Steuer der Engine zu zahlen, sodass der Durchsatz stieg, statt dass die Parallelität sich in Overhead verwandelte.

Die Form eines typischen Tages: ein Lead mit der Wand von Thumbnails geöffnet, vier oder fünf Agents im Flug — ein paar mahlen sich durch Feature-Tickets, einer jagt einen Bug, ein oder zwei machen Code-Reviews. Der Lead schreibt nicht Minute für Minute Code; er **beobachtet die Flotte**, greift nur an den Gates ein (ein Push, eine PR, eine riskante Aktion) und wenn ein Thumbnail gelb wird oder ein Agent sichtbar abschweift. Die Tickets kommen vom echten Tracker des Teams; die Reviews sind echte PRs und Changelists, die der Rest des Teams landen sieht.

Die harten Zwänge, die dieses Spieleprojekt auferlegte, sind genau die Features, die sich als am wichtigsten erwiesen haben:

- **Der Asset-Baum war enorm**, also waren warme Slots und Copy-on-Write-Workspaces keine Annehmlichkeit — ohne sie war eine Flotte von Agents auf diesem Baum schlicht unerschwinglich. Deshalb sind diese beiden Ideen das Rückgrat des Tools.
- **Die Engine war die Wahrheitsquelle für "funktioniert es,"** also war ein Agent, der das laufende Spiel nicht starten und steuern konnte, für die meiste Gameplay-Arbeit nutzlos. Daher die App-unter-Test-Integration.
- **Versionskontrolle war Perforce für das Spiel und Git für Tooling**, also war Provider-agnostisches SCM nicht optional.
- **Eine Person musste viele Agents leiten**, also ist das gesamte Cockpit für *Aufsicht auf einen Blick* optimiert, statt für tiefen Einzel-Session-Fokus.

Wenn eure Situation mit irgendetwas davon reimt — ein großer Baum, eine echte App zum Testen, mehr Arbeit als ein Agent bewältigen kann — wird das Design eng auf eure Bedürfnisse passen, weil es genau dafür gebaut wurde. Wenn nicht, geht es im Abschnitt [Macht es zu eurem eigenen](#macht-es-zu-eurem-eigenen) darum, die Ideen zu behalten und die Spezifika auszutauschen.

Eine Anmerkung zum Umfang: dieses Projekt hat letztlich keine kommerzielle Traktion gefunden, und wir behaupten nichts anderes. Aber das Engineering-Problem, das es aufwarf, war real — ein großer Asset-Baum, eine Flotte von Agents, ein Team — und die Teile von PopBot, die es gelöst haben, sind die Teile, die hier dokumentiert sind. Der Wert des Tools hängt nicht vom Ausgang des Spiels ab, und wir sagen das lieber offen, als mehr zu suggerieren.

---

## End-to-End-Workflows

### Ein Feature-Ticket

1. **Benachrichtigung → Postfach.** Ein euch zugewiesenes Ticket erscheint im **Tickets**-Postfach (PopBot pollt Linear / Jira / GitHub Issues, gerankt nach Priorität und Fälligkeitsdatum). Die Benachrichtigungsglocke markiert es.
2. **Ein Klick zum Start.** Klickt die Ticket-Zeile an. PopBot öffnet einen **Neuer-Chat**-Dialog, standardmäßig auf euer Repo und eure Base gesetzt (vom letzten Mal gemerkt) — bestätigt, oder passt Agent/Modell/Effort an.
3. **Slot-Zuweisung.** Weil dieser Chat Code schreiben wird, **least PopBot einen Slot**: es wählt einen freien Workspace, leitet den Branch-Namen `you/eng-123-<slug>` aus dem Ticket ab und wechselt den Workspace dorthin (führt zuerst die Stash-Sicherheitssequenz aus).
4. **Ticket automatisch befördert.** Das Ticket wird automatisch zu **In Progress** verschoben (idempotent, fire-and-forget), sodass euer Board die Realität widerspiegelt, ohne einen Kontextwechsel.
5. **Agent startet.** Der Agent erhält eine geseedete erste Nachricht (euer anpassbares *start-ticket*-Template, gefüllt mit Ticket-Titel, -Beschreibung und Branch) und beginnt: den Code zu erkunden, Edits zu machen, Befehle auszuführen — alles innerhalb des Workspace seines Slots.
6. **Verifikation im Slot.** Bei einem Spiel-Change **startet der Agent die App in seinem Slot** (ein Engine-Editor + Sidecar-Server auf einem zweiten Display) und übt das Feature aus — klickt sich durch die UI, liest Logs, macht Screenshots — statt zu raten, dass es funktioniert.
7. **Gegateter Abschluss.** Wenn er bereit ist zu pushen, **pausiert** der Agent (Pushen ist eine gegatete Aktion). Das Thumbnail wird gelb ("braucht dich").
8. **Ihr reviewt & shippt.** Öffnet das **SCM-Panel**, lest den Diff und drückt **Push PR** (oder **Push draft**). Die Aktion sendet eine vorausgefüllte Anweisung an den Agent, der den Branch pusht und die PR / das Swarm-Review gegen eure Base öffnet.

Die ganze Zeit habt ihr nicht zugeschaut — ihr habt dasselbe für zwei andere Tickets getan. Ihr seid nur am Gate eingesprungen.

### Ein Bug-Ticket

Der Bug-Flow ist der Feature-Flow mit einer engeren Schleife, und er zeigt **Parallelität**:

1. Ein Bug-Report kommt an (ein Ticket, oder ihr startet manuell einen Chat mit der Bug-Beschreibung).
2. Erzeugt einen Chat → er least **seinen eigenen** Slot und Branch. Euer laufender Feature-Chat bleibt völlig unberührt — anderer Workspace, anderer Branch.
3. Der Agent reproduziert den Bug, **indem er die App in seinem Slot ausführt**, findet die Ursache, behebt sie und führt erneut aus, um zu bestätigen, dass die Reproduktion verschwunden ist.
4. Ihr werft einen Blick auf die **Thumbnail-Leiste**: Feature-Chat grün (fertig, wartet auf euren Push), Bug-Chat blau (läuft). Zwei Agents, zwei isolierte Bäume, null Kollisionen.
5. Pusht den Fix, wenn er zur Genehmigung pausiert.

### Ein Code-Review

1. **Benachrichtigung → Reviews.** Ein Teammitglied fordert euer Review an. Die PR (GitHub) oder Changelist (Swarm) erscheint im **Reviews**-Postfach.
2. **Sofortiger, repoloser Chat.** Klickt sie an → ein **Review-Chat** öffnet sich sofort — kein Slot, kein Checkout, kein Warten. Er ist mit dem *start-code-review*-Template geseedet (liest den umgebenden Code, nicht nur den Diff; verfolgt die Systeme; jagt nach echten Bugs, Race Conditions, Edge Cases, Sicherheits- und Performance-Problemen).
3. **Echtes Review.** Der Agent liest den Diff **und** den Code drumherum, denkt über Korrektheit nach und postet **Inline-Kommentare** plus ein Urteil (approve / request changes) auf GitHub oder Swarm — und fasst dann die Warnsignale für euch im Chat zusammen.
4. **Später erneut reviewen.** Wenn der Autor Fixes pusht, drückt **Re-Review**: PopBot fokussiert den bestehenden Review-Chat und weist den Agent an, **nur die neuen Commits** anzuschauen, zu verifizieren, dass jeder vorherige Thread tatsächlich adressiert wurde, und sein Review zu aktualisieren.

All das passiert, während eure Build-Chats weiterlaufen — Reviews nehmen nie einen Slot.

### Einen archivierten Chat wieder öffnen

Arbeit ist selten in einem Rutsch erledigt. Der Wiedereröffnen-Flow ist erstklassig:

1. Ein Feature-Chat hat seine PR released; ihr habt ihn **geschlossen**, um den Slot freizugeben. Er ist jetzt im **Archiv** (Transcript vollständig erhalten).
2. Zwei Tage später bekommt der Change Review-Kommentare. Findet den Chat im Archiv (Suche nach Ticket, Branch oder Text) und **öffnet ihn wieder**.
3. PopBot **least erneut einen Slot**, stellt den Branch des Chats im Workspace wieder her, und der Agent nimmt mit seiner **gesamten Historie** die Arbeit wieder auf — er weiß bereits, was er gebaut hat und warum. Wenn er in einem anderen Slot als zuvor landet, orientiert PopBot ihn am neuen Arbeitsverzeichnis.
4. Fügt das Review-Feedback ein oder fasst es zusammen. Der Agent adressiert es, testet erneut im Slot und pusht das Update — kein erneutes Onboarding, kein verlorener Kontext.

Weil der Branch, das Transcript und die Argumentation alle bestehen bleiben, kostet das Wiederaufgreifen einer Aufgabe Sekunden, keine Neu-Erklärung.

---

## Integrierte Versionskontrolle & Review

Versionskontrolle ist tief verdrahtet, über die native CLI jedes Providers — **`gh`/`git`** für GitHub, **`p4`** und die Swarm-API für Perforce — sodass alles, was ein Agent tut, echte Aktivität ist, die euer Team an den normalen Orten sieht.

- **Reviews-Postfach.** GitHub-PRs und Swarm-Changelists, die auf euer Review warten (und eure eigenen jüngsten Einreichungen), erscheinen als Ein-Klick-Chat-Quellen.
- **PR-/Review-Status-Chips.** Jeder Chat, der mit einem Change verknüpft ist, zeigt einen lebendigen Status-Chip — Open / Merged / Closed / Draft —, den ihr anklicken könnt, um ihn auf GitHub oder in Swarm zu öffnen.
- **Das SCM-Panel.** Für jeden Build-Chat seht ihr Arbeitsbaum-/Changelist-Status, jüngste Commits und Diffs pro Datei. Klickt eine Datei für ein vollständiges Unified-Diff-Overlay an.
- **Ein-Klick-Aktionen.** Templated, editierbare Aktionen senden eine vorausgefüllte Anweisung an den Agent: **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR** (Review-Kommentare adressieren), **Rebase onto base**. Jede expandiert Variablen wie `${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}` und `${prurl}`, sodass der Agent genau das hat, was er braucht.
- **Erstellung gegen eure Base.** Pushen öffnet die PR (oder das Swarm-Review) gegen die konfigurierte Base des Chats, benannt nach eurer Branch-Konvention.

Review ist ein eigener, optimierter Pfad (siehe [Ein Code-Review](#ein-code-review)):

- **Repolos und sofort** — kein Slot, kein Checkout. Triagiert eine Queue von Reviews in Sekunden.
- **Liest Kontext, nicht nur den Diff** — das Review-Template weist den Agent an, umgebenden Code zu lesen, Systeme zu verfolgen und nach Bugs/Race-Conditions/Edge-Cases/Sicherheit/Performance zu suchen, nicht den Patch durchzuwinken.
- **Postet, wo euer Team arbeitet** — Inline-Kommentare und ein eingereichtes Review auf GitHub oder Swarm.
- **Re-Review ist begrenzt** — bei einem zweiten Durchgang untersucht der Agent nur neue Commits und bestätigt, dass jeder frühere Thread wirklich aufgelöst ist, bevor er sein Review aktualisiert.
- **Vollständig anpassbar** — die *start-code-review*- und *re-review*-Prompts sind editierbare Templates, sodass ihr die Strenge, die Checkliste und den Ton an die Messlatte eures Teams anpassen könnt. Die Review-*Prozedur selbst* (wie euer Shop ein GitHub- oder Perforce-Review gemacht haben will) liefert ihr selbst — PopBot empfiehlt und kann eine Beispielimplementierung liefern, aber der Standard liegt bei eurem Team.

## Testen in einem Slot: die App unter Test

Der Slot eines Build-Chats ist nicht nur ein Ordner — es ist ein Ort, um die Arbeit **auszuführen und zu inspizieren**:

- **Terminal pro Chat.** Ein eingebettetes Terminal (xterm + eine echte PTY), das am Workspace des Chats verankert ist. Führt Tests aus, inspiziert Logs oder feuert Befehle von Hand ab, während der Agent arbeitet. Es bleibt bestehen, wenn ihr zwischen Chats wechselt.
- **Editor-Integration.** Jede `path/to/file.ts:42`-Referenz im Transcript ist ein klickbarer Link, der sich in **VS Code** oder **Cursor** öffnet, aufgelöst gegen den Workspace des Chats.
- **Die App unter Test.** Ein Slot kann die **echte Anwendung** starten, sodass der Agent sie steuern kann, statt zu raten. Bei einer Web-App, einer CLI oder einem Service ist das größtenteils die eigene Leistung des Agents — er führt eure Build- und Testbefehle im Terminal des Slots aus, greift auf den laufenden Server zu, liest die Ausgabe. PopBot muss nichts Besonderes über diese wissen; der Agent handhabt sie so, wie ihr es tun würdet. Game-**Engines** sind der Fall, der zusätzliche Behandlung braucht, weil der Editor ein langlebiger GUI-Prozess mit eigenem Asset-Cache ist und keine natürliche Kommandozeilen-"Ausführen-und-prüfen"-Schleife hat. Also startet PopBot für **Unity** und **Unreal** einen lebenden Editor + Sidecar-Server, platziert ihn auf einem zweiten Display und exponiert ihn dem Agent über einen **In-Editor-MCP-Server**. Jeder laufende Editor bekommt seinen **eigenen, von seinem Slot abgeleiteten MCP-Port** — sodass ein Agent nur mit *seinem* Editor spricht, nie mit dem eines anderen Slots — und PopBot verbindet den Agent jedes Chats automatisch mit diesem Endpunkt (im Speicher, sodass nichts in der Versionskontrolle landet). Eine **Custom**-Engine fügt sich in dieselbe Maschinerie ein: PopBot reicht die Slot-Identität an euren Launch-Befehl durch, und ihr verdrahtet, wie der Agent sie steuert. In jedem Fall kann der Agent die App ausüben — UI klicken, Logs lesen, Screenshots machen, Verhalten prüfen — und PopBot verwaltet den Editor-Lebenszyklus (den Server starten, seinen Health-Check durchführen, den Editor starten, sein Fenster platzieren, ihn bei Freigabe abbauen), wobei gleichzeitige Instanzen gegen verfügbaren RAM budgetiert werden.

Das ist der Unterschied zwischen einem Agent, der *denkt*, dass sein Change funktioniert, und einem, der *gesehen* hat, dass er funktioniert. Nichts daran ist spielspezifisch — Web und andere Entwicklung sind gleichberechtigte erstklassige Anwendungsfälle. Game-Engines tragen einfach den zusätzlichen Zustand (einen warmen Asset-Cache, einen Editor-als-App-unter-Test), dessen sich das System bewusst sein muss, und genau dieser zusätzliche Zustand macht sie zur schärfsten Demonstration der neuartigen Teile des Tools: warme Slots, Copy-on-Write-Workspaces und eine laufende App, die der Agent steuern kann.

## Berechtigungen & Sicherheit

Autonomie mit einer harten Untergrenze:

- **Automatisch erlaubt (still):** Lesen, Editieren und Shell-Befehle **innerhalb des Workspace des Slots**, Aufrufe an die eigenen Services des Slots (einschließlich seines Editor-MCP) und interne Agent-Operationen. Der Agent arbeitet einfach.
- **Immer gegated (pausiert für euch):** `git push` / `p4 submit` / Reset / Force, alles **außerhalb** des Workspace, das Öffnen von PRs oder Reviews, Löschen außerhalb eines Scratch-Verzeichnisses, das Senden von Nachrichten (Slack/E-Mail), das Anfassen von System- oder Agent-Konfiguration, und Netzwerkaufrufe an nicht auf der Allowlist stehende Hosts.
- **Alles andere:** fragt euch nach einer Entscheidung.

Wenn ihr etwas genehmigt, könnt ihr es **einmalig**, **für die Session** oder **dauerhaft** gewähren (dieses Tool/Ziel immer erlauben). MCP-Server können auf dieselbe Weise genehmigt werden — erlaubt einmal das Editor-MCP eines Slots, und es wird gemerkt, wobei die Gewährung sichtbar und widerrufbar in Preferences → Permissions ist (PopBot aktiviert die Unity-/Unreal-Editor-MCPs auf diese Weise automatisch). Gewährungen sind pro Chat oder global und alle **widerrufbar**. Die harte Verweigerungs-Untergrenze (Push/Submit, Netzwerk, außerhalb des Baums) lebt im Code und ist durch UI-Regeln nicht überschreibbar — sodass eine fehlkonfigurierte Gewährung einen Agent nicht von sich aus zum Mainline landen lassen kann.

## Lokalisierung

Die gesamte Oberfläche von PopBot — Menüs, Einstellungen, Dialoge, alles — ist vollständig lokalisiert. Die App wird in **acht Sprachen** ausgeliefert: Englisch, Spanisch, Französisch, Deutsch, Japanisch, Koreanisch, vereinfachtes Chinesisch und brasilianisches Portugiesisch — jederzeit ohne Neustart über das Sprachmenü umschaltbar. (Die Marketing-Website bietet zusätzlich Russisch und Italienisch.) Wenn ihr PopBot forkt, ist jede Locale ein einzelner Message-Katalog, sodass das Hinzufügen oder Anpassen einer Sprache eine begrenzte Änderung ist, statt einer Schnitzeljagd durch die UI.

## Preferences

Alles wird in-app konfiguriert (kein Editieren von Config-Dateien):

- **Agents** — Standardmodell & Reasoning-Effort, separat für neue Chats vs. Code-Reviews.
- **Repositories** — Repos hinzufügen/editieren via einen ordner-ersten, SCM-bewussten Wizard: Pfad, Provider (Git/Perforce), Base-Branch oder -Stream, Farbe, Slot-Präfix, Workspaces-Verzeichnis, Slot-Pool- vs. ephemerer Modus.
- **Runtime & Slots** — Pool-Größe (wie viele Agents gleichzeitig laufen), Slots vorab erstellen/löschen, Attachment-Aufbewahrung, Base-Image-Refresh für Copy-on-Write-Workspaces.
- **Integrationen** — Linear, Jira, GitHub und Helix Swarm verbinden (Credentials lokal gespeichert); konfigurierbare Review-Poll-Raten pro Provider; vor dem Speichern testen.
- **Versionskontrolle** — Branch-Namenskonvention, Standard-Base, und die editierbaren Aktions-Templates.
- **Externe Apps** — Terminal (iTerm), Editor (VS Code / Cursor), Engine-Binaries und Engine-spezifische Optionen (einschließlich des Editor-MCP-Basisports), optionales Chrome-Profil für URL-Routing.
- **Prompt-Templates** — jeder geseedete Prompt (Start-Ticket, Start/Re-Review und jede Aktion) ist editierbar, mit einer Variablen-Referenzkarte.
- **Berechtigungen** — dauerhafte Gewährungen überprüfen und widerrufen, einschließlich Erlaubnissen pro MCP-Server.
- **Benachrichtigungen** — Toast-Platzierung und Alarmierungsverhalten.
- **Sprache** — die Interface-Locale wechseln.

> Für eine Panel-für-Panel-Referenz mit Screenshots siehe den **[Konfigurationsleitfaden](CONFIGURATION.md)**.

## Macht es zu eurem eigenen

PopBot anzupassen ist eine primäre beabsichtigte Nutzung. Es wird als Referenzimplementierung veröffentlicht, und sein Design spiegelt eine Sichtweise darüber wider, wie Software im Zeitalter von KI am besten gebaut wird: ein Team nimmt eine funktionierende Form, versteht *warum* sie so geformt ist, und formt sie um seinen eigenen Stack, seine Tools und Konventionen um, statt ein Tool zu übernehmen, dessen Entscheidungen für es fixiert sind.

Seine Form ist generisch: **Agents + isolierte, warme, Copy-on-Write-Slots + ein Postfach-als-Queue + eine App-unter-Test.** Dieses Muster gilt für die meisten Teams, die mehr als einen Coding-Agent gleichzeitig betreiben. Es ist **MIT-lizenziert** und so strukturiert, dass es geforkt werden kann — der Code ist organisiert als *Provider hinter kleinen gemeinsamen Schnittstellen*, sodass ein Teil hinzugefügt oder ausgetauscht werden kann, ohne den Rest anzufassen. Der generelle Ansatz: die Kernideen behalten, die spezifischen Instanzen ersetzen.

Die Nahtstellen sind unten aufgelistet mit *Wie, Wo und Warum* für jede. Jede ist eine Schnittstelle mit steckbaren Implementierungen; der praktische Weg ist, eine bestehende Implementierung als Vorbild zu nehmen und eure eigene hinzuzufügen.

- **Tauscht die App-unter-Test aus.** *Warum:* der gesamte Punkt ist ein Agent, der eure App *ausführt und verifiziert*, und "eure App" ist für jeden anders. *Wo:* `src/shared/gameEngine.ts` (Engine-Deskriptoren, MCP-Verdrahtung) und `src/main/ipc/apps.ts` (Start + Lebenszyklus). Unity und Unreal sind zwei Implementierungen; der **Custom-Engine**-Hook reicht die Slot-Identität (`POPBOT_SLOT`, abgeleitete Ports) bereits an euren Launch-Befehl durch, sodass das Verdrahten eurer Web-App, CLI oder eures Test-Harness ist "füllt den Launch-Befehl aus und wie der Agent mit ihm spricht."
- **Verweist das Postfach woanders hin.** *Warum:* das Postfach-als-Queue ist die dauerhafte Idee; der spezifische Tracker ist ein Detail. *Wo:* `src/main/tickets/` — implementiert die `TicketSource`-Schnittstelle in `provider.ts`, normalisiert die Daten eures Trackers in die gemeinsamen DTOs und registriert es in `registry.ts` (der Datei-Header vermerkt buchstäblich: *"das Hinzufügen eines Trackers ist eine Zeile hier plus sein `*Source.ts`-Modul"*). Linear, Jira und GitHub Issues sind die ausgearbeiteten Beispiele. Der Renderer verzweigt nie nach Provider-ID, also fasst ihr die UI nicht an.
- **Fügt Versionskontrolle hinzu oder tauscht sie aus.** *Warum:* "einen Change isolieren, reviewen, landen" ist Provider-agnostisch; Git und Perforce sind nur zwei Backends. *Wo:* `src/main/scm/` — erweitert die `SourceControlProvider`-Basisklasse (`provider.ts`), nach dem Vorbild von `gitProvider.ts` / `perforceProvider.ts`. Verhalten, das sich nicht sauber abstrahieren lässt, wird **per Capability erkannt**, nicht `if (provider === …)`, sodass ein sehr unterschiedliches VCS sich sogar für eine eigene Client-UI entscheiden kann, ohne dass Aufrufer es speziell behandeln müssen.
- **Tauscht die Review-Oberfläche aus.** *Warum:* Reviews sollten dort landen, wo euer Team bereits hinschaut. *Wo:* die Review-Provider hinter `src/main/reviews/` (GitHub-PRs via `git/reviews.ts`, Swarm-Changelists via `p4/swarmReviews.ts`). Die *Review-Prozedur selbst* — wie euer Shop ein Review gemacht haben will — wird bewusst **nicht** mit dem Tool ausgeliefert; es ist ein Skill pro Shop, den ihr bereitstellt, sodass PopBot empfiehlt und Beispiele liefert, aber nie euren Standard vorschreibt.
- **Verdrahtet die Aktionen und Prompts neu.** *Warum:* Branch-Konventionen, PR-/Review-Flows und wie ihr einen Agent briefet, sind teamspezifisch. *Wo:* kein Code nötig — die Git-Aktions-Templates und jeder geseedete Prompt (Start-Ticket, Start/Re-Review) sind **in Preferences editierbar**, mit einer Variablen-Referenzkarte. Ändert die Strenge, die Checkliste, den Ton.
- **Behaltet den Kern.** *Warum:* das sind die Ideen, die das Ganze zum Funktionieren bringen, und es sind die Teile, bei denen ihr am langsamsten sein solltet, sie zu ändern. Warme Slots, Copy-on-Write-Workspaces (`src/main/shado/`), persistente Chats, die hart codierte Berechtigungsgrenze und das Parallel-Agent-Cockpit sind das dauerhafte Rückgrat. Alles andere ist dazu gedacht, sich zu bewegen.

Für die Prozessgrenzen, IPC und wo jedes Subsystem lebt, lest das **[Architecture](ARCHITECTURE.md)**-Dokument — die Karte, um die Nahtstelle zu finden, die ihr ändern wollt. Für das Objektmodell (Chat, Slot, AgentSession und ihre Lifecycles) siehe **[Core Model](CORE_MODEL.md)**.

Für Teams, die mehr als einen Agent gleichzeitig betreiben, ist das ein funktionierender Ausgangspunkt, der dazu gedacht ist, auseinandergenommen und um einen anderen Workflow herum neu gebaut zu werden.

---

*Manche in der ursprünglichen [Design-Spezifikation](POPBOT_DESIGN.md) erwähnten Integrationen (Slack, Sentry und andere) existieren als Verbindungs-Stubs statt vollständiger Flows; Linear, Jira, GitHub und Helix Swarm sind die vollständig verdrahteten Postfach-Quellen. Dieser Guide beschreibt, wie sich die App heute tatsächlich verhält.*
