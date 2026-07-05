<div align="center">

![PopBot — a battle-tested multi-chat & multi-slot agentic coding tool](../../images/hero_banner_2.png)

*Languages: [English](../../README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · **Deutsch** · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [简体中文](../zh-CN/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Русский](../ru/README.md) · [Italiano](../it/README.md)*

Ein bewährtes Desktop-Tool, um ein Team von KI-Coding-Agents parallel laufen zu lassen — einen pro Ticket, Bug oder Review, jeder isoliert in seinem eigenen warmen "Slot", jeder in der Lage, eure App End-to-End zu bauen, auszuführen und zu testen.

[Warum PopBot](#warum-popbot) · [Features](#zentrale-features) · [Wie es funktioniert](#anatomie-des-workspace) · [Ein Tag mit PopBot](#ein-tag-mit-popbot) · [Installation](#installation) · [Macht es zu eurem eigenen](#macht-es-zu-eurem-eigenen)

</div>

---

## Warum PopBot

Einen einzelnen KI-Coding-Agent laufen zu lassen ist unkompliziert. Viele gleichzeitig laufen zu lassen bringt Probleme mit sich, die ein einzelner Agent nicht hat: ihre Arbeit isoliert zu halten, damit sie sich nicht gegenseitig überschreiben, tatsächlich zu testen, was sie bauen, es zu reviewen und die irreversiblen Aktionen zu gaten, damit kein Agent eine davon unbeaufsichtigt ausführt.

PopBot ist eine Orchestrierungsschicht dafür. Es verwandelt Tickets und Review-Anfragen in Agent-Sessions per Klick, gibt jedem Agent einen isolierten Workspace (seine eigene Arbeitskopie — und bei Spieleprojekten seine eigene laufende App unter Test), lässt sie standardmäßig autonom laufen mit einem menschlichen Gate bei riskanten Aktionen, und sammelt jedes Transcript, jeden Diff, jedes Terminal und jedes Log in einem einzigen Fenster. Der Operator überfliegt die Spalten, genehmigt die gegateten Aktionen und shippt.

Es wurde von einem kleinen Team bei **Proof of Play** gebaut und täglich auf einem echten, asset-lastigen Produktionsprojekt eingesetzt, das released wurde. Das ist die Umgebung, in der es sich bewährt hat: viele Gigabyte an Assets, echte Versionskontrolle, echte Deadlines. Das Slot-Modell — warme, isolierte Copy-on-Write-Workspaces — ist das, was paralleles Agent-Arbeiten dort praktikabel gemacht hat, und es hat gesteigert, wie viel das Team gleichzeitig erledigen konnte. Wir veröffentlichen und supporten PopBot als Referenzimplementierung: kein fertiges Produkt zum Konsumieren wie es ist, sondern eine Form, die man nimmt und für den eigenen Stack und Workflow umformt. Das spiegelt eine Sichtweise darüber wider, wie Software im Zeitalter von KI am besten gebaut wird — dass Teams, die Flotten von Agents betreiben, besser bedient sind, wenn sie das Tool besitzen und modifizieren, statt eines mit fixen Entscheidungen zu übernehmen. Es ist MIT-lizenziert und so organisiert, dass es geforkt werden kann; siehe [Macht es zu eurem eigenen](#macht-es-zu-eurem-eigenen).

![The PopBot workspace — the thumbnail strip, side-by-side chat columns, and a per-chat terminal](../../images/screenshot1.png)

<div align="center"><em>Eine echte PopBot-Session — mehrere Agents arbeiten parallel, jeder in seinem eigenen Slot. Live-Thumbnails oben, fokussierte Chats in Spalten, ein Terminal pro Chat darunter und das Versionskontroll-Panel rechts.</em></div>

## Zentrale Features

### Multi-Chat-Ansicht mit Live-Thumbnails

Jeder offene Chat bleibt sichtbar — eine Leiste aus **Live-Thumbnails** über nebeneinanderliegenden **Spalten**. Jedes Thumbnail ist eine echte, sich aktualisierende Ansicht dieses Chats (nicht nur ein Status-Punkt), farbcodiert nach Zustand: läuft, fertig, wartet-auf-dich, Fehler. Auf einen Blick siehst du, *was jeder Agent gerade tut* und wer dich braucht — und du kannst **einen falschen Weg frühzeitig erkennen** und umlenken, bevor er Zeit und Tokens verbrennt. Eine Person überwacht eine ganze Flotte von einem Fenster aus.

### Warme Slots — parallele Agents ohne die Reimport-Steuer

Jeder aktive Chat least einen **Slot** — eine dauerhafte Arbeitskopie plus seinen eigenen warmen Build-Zustand, einmal erstellt und wiederverwendet. Für eine Game-Engine bedeutet das, dass der Slot seinen eigenen heißen Asset-Cache behält (Unitys `Library`, Unreals DDC) und den Editor am Laufen halten kann, sodass das Zurückwechseln eines Agents in seinen Slot **Sekunden dauert, nicht einen mehrminütigen Reimport**. Zehn Agents laufen in echter Branch-Isolation, ohne einen einzigen Import-Cache zu strapazieren. [Wie Slots funktionieren →](GUIDE.md#slots-warme-isolierte-wegwerfbare-workspaces)

### Unbegrenzte Kopien auf der Disk eines Repos

Der Workspace eines Slots ist ein **Copy-on-Write-Ordner**: Jeder Slot teilt sich ein Basis-Image und speichert nur, was er ändert. So ist eine frische, lebendige, vollständige Kopie eines **terabyte-großen** Game-Trees in **Sekunden** bereit — echte editierbare Dateien, keine flache Ansicht — und unbegrenzte Kopien kosten die Disk eines einzigen Repos. Es funktioniert auf **Windows, macOS und Linux**, und es ist das, was riesigen Perforce-Trees überhaupt erst erlaubt, der Flotte beizutreten. [Warum das wichtig ist →](GUIDE.md#copy-on-write-unbegrenzte-kopien-auf-der-disk-eines-repos)

### Git und Perforce, mit eingebautem Review

Versionskontrolle ist ein **Provider** hinter einer Schnittstelle: **Git** (Worktrees, Branches, PRs via `gh`) und **Perforce** (Streams über Shadow-Workspaces, Changelists, **Helix Swarm**-Reviews) sind beide erstklassig unterstützt. Ein Versionskontroll-Panel, das auf *den eigenen Workspace jedes Chats* begrenzt ist, zeigt Status, Commits und Diffs pro Datei für genau diesen Branch. Ein-Klick-Templated-Aktionen (**Commit**, **Push PR**, **Make ready**, **Address CR**, **Rebase onto base**) senden eine vorausgefüllte Anweisung an den Agent dieses Chats, mit ausgefüllten `${branch}` / `${ticket}` / `${prnum}`.

### Ein Postfach, viele Quellen

Der gesamte Loop an einem Ort: dein **Postfach** — zugewiesene Tickets von **Linear**, **Jira** und **GitHub Issues**, plus Reviews, die auf dich warten, als **GitHub PRs** und **Swarm-Changelists** → **laufende** Agent-Arbeit in isolierten Slots → **pushen** und die PR / das Review öffnen → einen fertigen Chat **archivieren** → ihn später **wieder öffnen und neustarten** mit vollständiger Historie. Klicke ein Ticket an, und PopBot benennt den Branch, least einen Slot, verschiebt das Ticket zu *In Progress* und seedet den Agent — und begleitet es dann bis zu einem gemergten Change und zurück. [Workflow-Durchgänge →](GUIDE.md#end-to-end-workflows)

## Weitere Features

- **Der echte Claude Code und Codex — keine Neuimplementierung.** Jeder Chat steuert den *tatsächlichen* Agent über sein offizielles SDK — dieselben `claude`- und `codex`-CLIs, die du im Terminal ausführst, mit all ihren Tools, Skills und MCP-Servern intakt. Wähle das Modell (Opus / Fable / GPT) und den Reasoning-Effort pro Chat, wechsle mitten in der Session, oder starte eine frische Session, die mit der Historie des Chats geprimt ist.
- **Agents, die ihre eigene Arbeit testen.** Ein Slot kann die echte App starten — für Unity und Unreal ein lebender Editor + Sidecar-Server auf einem zweiten Display, vom Agent über einen In-Editor-MCP-Server auf einem **Port pro Slot** gesteuert — sodass der Agent sich durch die UI klickt, Logs liest und seine Änderungen verifiziert, statt zu raten. Custom-Engines werden ebenfalls unterstützt.
- **Persistente, archivierbare Chats.** Jeder Chat ist ein dauerhaftes Transcript; schließe ihn, um seinen Slot freizugeben, und öffne ihn später mit vollständig intakter Historie wieder.
- **Terminal pro Chat & klickbarer Code.** Ein eingebettetes Terminal, das am Workspace des Chats verankert ist, und `file.ts:42`-Links, die sich in VS Code oder Cursor öffnen.
- **Autonom, aber nie leichtsinnig.** Agents führen sichere Arbeit innerhalb ihres Slots automatisch aus und pausieren bei allem Riskanten für dich — `git push` / `p4 submit`, das Öffnen von PRs, alles außerhalb des Workspace, Netzwerkaufrufe. Berechtigungen sind pro Chat, dauerhaft und widerrufbar — MCP-Server eingeschlossen.
- **Vollständig lokalisiert.** Die gesamte Oberfläche wird in acht Sprachen ausgeliefert (Englisch, Spanisch, Französisch, Deutsch, Japanisch, Koreanisch, vereinfachtes Chinesisch, brasilianisches Portugiesisch), jederzeit über das Sprachmenü umschaltbar.
- **Multi-Repo.** Steuere mehrere Repositories nebeneinander, jedes mit seinem eigenen Slot-Pool, seiner Farbe, seinem Provider und seinen Branch-Konventionen.

## Wie PopBot sich unterscheidet

Agentische Coding-Tools tendieren dazu, in ein paar Kategorien zu fallen. PopBot sitzt an einer anderen Stelle: ein **lokales Cockpit, um viele *echte* Agents parallel laufen zu lassen, mit warmem Build-Zustand und lebendiger menschlicher Aufsicht.**

| Statt… | …PopBot |
|---|---|
| **Ein Agent in einem Terminal oder einer IDE** — eine Aufgabe in einem Arbeitsbaum zur Zeit | **Viele Agents gleichzeitig**, jeder isoliert in seinem eigenen warmen Slot, alle sichtbar als lebendige Flotte, die du von einem Fenster aus steuerst |
| **Asynchrone Cloud-Agents** — undurchsichtig und entfernt; reiche eine Aufgabe ein, warte auf eine PR | **Lokal und live** — sieh jedem Agent bei der Arbeit zu und erkenne einen falschen Weg frühzeitig, und er steuert *eure echte App* (einen Engine-Editor auf einem zweiten Bildschirm) für echtes End-to-End-Testing |
| **DIY-`tmux`- + Worktree-Jonglieren** — parallel, aber manuell, und jeder frische Checkout zahlt die mehrminütige Reimport-Steuer der Engine | **Verwaltete warme Slots** — wiederverwendete Copy-on-Write-Workspaces, die den Asset-Cache heiß halten, mit Branch-/Workspace-Lifecycle, dem SCM-Panel und Code-Review für dich erledigt |
| **Agent-Orchestrierungs-Frameworks** — Toolkits zum *Bauen* von Agent-Systemen | **Eine fertige, meinungsstarke App**, die an dein Postfach und deinen Review-Loop angeschlossen ist — human-in-the-loop by design, keine Bibliothek zum Zusammenbauen |

Und entscheidend: PopBot ersetzt Claude Code oder Codex nicht — es **führt sie aus**. Du bekommst genau die Agents (und deine genauen CLI-Versionen), denen du bereits vertraust, nur viele gleichzeitig, mit der Orchestrierung, Isolation und Aufsicht darum herum.

## Anatomie des Workspace

![PopBot UI anatomy](../../images/anatomy.png)

| Bereich | Was es ist |
|---|---|
| **Postfach — Tickets & Reviews** | Zugewiesene Tickets (Linear / Jira / GitHub Issues) und Reviews, die auf dich warten (GitHub PRs / Swarm-Changelists), gerankt. Ein Klick erzeugt einen Chat. |
| **Slots** | Der Pool warmer, isolierter Workspaces — eine Copy-on-Write-Arbeitskopie *plus* dauerhafter Build-Zustand (bei einer Game-Engine ihr eigener heißer Asset-Cache). Ein Chat least einen davon während der Arbeit und gibt ihn beim Schließen zurück. |
| **Chat-Archiv** | Jeder vergangene Chat, durchsuchbar und mit vollständiger Historie wieder öffenbar. |
| **Chat-Thumbnails** | Eine lebendige Leiste aller offenen Chats — farbcodiert nach Status (läuft / fertig / braucht-dich / Fehler). |
| **Chats** | Die fokussierten Agent-Sessions: Prosa, Tool-Aufrufe und Inline-Code-Diffs, live gestreamt. |
| **Terminal pro Chat** | Ein eingebettetes Terminal, das auf den Workspace dieses Chats zeigt, für manuelle Befehle. |
| **SCM-Panel** | Arbeitsbaum-/Changelist-Status, Commits, Datei-Diffs und Ein-Klick-Commit-/Push-/PR-/Review-Aktionen. |

## Ein Tag mit PopBot

**Ein Feature-Ticket.** Ein Ticket landet in deinem Postfach. Klicke es an → PopBot öffnet einen Chat auf `you/eng-123-…`, least einen Slot, verschiebt das Ticket zu *In Progress* und übergibt dem Agent die vollständige Beschreibung. Er schreibt den Code, führt die App in seinem Slot aus, um zu verifizieren, und pausiert für dein OK, bevor er pusht. Du reviewst den Diff im SCM-Panel und drückst **Push PR**.

**Ein Bug, parallel.** Während das läuft, kommt ein Bug-Report herein. Erzeuge einen zweiten Chat — seinen eigenen Slot, seinen eigenen Branch — und die beiden Agents arbeiten gleichzeitig, ohne jemals den Baum des jeweils anderen zu berühren. Die Thumbnail-Leiste zeigt beide: einer grün (fertig), einer blau (läuft).

**Eine Review-Anfrage.** Die PR (oder Swarm-Changelist) eines Teammitglieds erscheint in deinem Reviews-Tab. Klicke sie an → ein sofortiger **repoloser** Review-Chat öffnet sich, der Agent liest den Diff *und* den umgebenden Code, jagt nach echten Bugs und postet ein Inline-Review auf GitHub oder Swarm — während deine zwei Build-Chats weiterlaufen.

**Morgen wieder aufnehmen.** Schließe die fertigen Chats, um ihre Slots freizugeben. Am nächsten Morgen öffnest du den Feature-Chat aus dem Archiv wieder, um Review-Feedback zu adressieren — der Agent nimmt die Arbeit mit der gesamten Konversation und intaktem Workspace wieder auf.

→ Vollständige Durchgänge (Feature-, Bug- und Review-Flows, plus wie Slots, Copy-on-Write-Workspaces und das Wiedereröffnen unter der Haube funktionieren) findest du im **[Feature- & Workflow-Guide](GUIDE.md)**.

## Installation

Signierte, vorgebaute Installer sind verfügbar auf **[popbot.app](https://popbot.app)**:

- **macOS** — signiertes & notarisiertes `.dmg` (Apple Silicon)
- **Windows** — signierter `.exe`-Installer
- **Linux** — `.deb`-Paket

Die App aktualisiert sich automatisch aus ihrem Release-Channel. Um stattdessen einen eigenen Build auszuführen, siehe [Aus dem Quellcode bauen](#aus-dem-quellcode-bauen).

## Aus dem Quellcode bauen

```bash
npm install
npm run dev        # App im Entwicklungsmodus ausführen
npm run package    # signierten Installer für deine Plattform bauen
```

**Anforderungen**

- **macOS, Windows oder Linux.** macOS ist die am meisten erprobte Plattform (der Workflow für die App-unter-Test auf dem zweiten Display stützt sich auf macOS-Accessibility-APIs); Windows und Linux werden unterstützt und ausgeliefert — siehe [WINDOWS.md](WINDOWS.md) für die Windows/WSL-Setup-Hinweise.
- **Node 20+** (Node 20 / 22 vermeiden ein Neukompilieren nativer Module; siehe die Windows-Hinweise).
- Die **`claude`**- und/oder **`codex`**-CLIs (die Agent-Backends), plus **`git`** und, für GitHub-Flows, **`gh`**. Für Perforce die **`p4`**-CLI.
- Credentials (Linear, Jira, GitHub, Helix Swarm) werden **lokal auf deiner Maschine** gespeichert, in der eigenen Datenbank der App — niemals in diesem Repository.
- Optional: ein Unity- oder Unreal-Editor für Spieleprojekte; VS Code / Cursor; iTerm.

## Macht es zu eurem eigenen

PopBot wird als Referenzimplementierung veröffentlicht, gedacht zum Forken und Anpassen statt zur Übernahme wie es ist. Seine Form ist generisch — **Agents + isolierte, warme, Copy-on-Write-Slots + ein Postfach-als-Queue + eine App-unter-Test** — und der Code ist organisiert als *Provider hinter kleinen gemeinsamen Schnittstellen*, sodass ein Team einen Teil austauschen kann, ohne den Rest anzufassen. Es ist **MIT-lizenziert**. Der generelle Ansatz: die Kernideen behalten, die spezifischen Instanzen ersetzen:

- **Tauscht die App-unter-Test aus.** Unity und Unreal sind zwei Implementierungen von "lass den Agent die App ausführen und verifizieren." Der Custom-Engine-Hook reicht die Slot-Identität bereits an euren Launch-Befehl durch — richtet ihn auf eure Web-App, CLI oder euren Test-Harness. *(`src/shared/gameEngine.ts`, `src/main/ipc/apps.ts`)*
- **Verweist das Postfach woanders hin.** Linear, Jira und GitHub Issues sind ausgearbeitete Beispiele; fügt einen Tracker hinzu, indem ihr eine Schnittstelle implementiert und registriert. *(`src/main/tickets/`)*
- **Fügt Versionskontrolle hinzu oder tauscht sie aus.** Erweitert die Provider-Basisklasse neben Git und Perforce; Aufrufer verzweigen nach *Capabilities*, nie nach Provider-ID. *(`src/main/scm/`)*
- **Verdrahtet die Aktionen und Prompts neu.** Branch-Konventionen, PR-/Review-Flows und jeder geseedete Prompt sind editierbare Templates in den Preferences — kein Code nötig.
- **Behaltet den Kern.** Warme Slots, Copy-on-Write-Workspaces, persistente Chats, die hart codierte Berechtigungsgrenze und das Parallel-Agent-Cockpit sind das dauerhafte Rückgrat.

Der **[Feature- & Workflow-Guide](GUIDE.md)** erklärt die Begründung hinter jeder Nahtstelle; das **[Architecture](ARCHITECTURE.md)**-Dokument zeigt, wo man sie im Code findet.

## Dokumentation

| Dokument | Was drinsteckt |
|---|---|
| **[Feature- & Workflow-Guide](GUIDE.md)** | Die vollständige Tour — die Ideen, wie jedes Teil funktioniert, und End-to-End-Workflows. Hier anfangen. |
| **[Konfigurationsleitfaden](CONFIGURATION.md)** | Jedes Preferences-Panel einrichten — Integrationen, Repos, Slots, Agents — mit Screenshots. |
| [USER_STORIES.md](USER_STORIES.md) | Die User Stories, an denen PopBot gemessen wurde. |
| [CORE_MODEL.md](CORE_MODEL.md) | Das Objektmodell — Chat, Message, Slot, AgentSession — und ihre Lifecycles. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Prozessgrenzen, IPC, wo jedes Subsystem lebt. |
| [WINDOWS.md](WINDOWS.md) | Windows-/WSL-Setup-Hinweise. |
| [POPBOT_DESIGN.md](POPBOT_DESIGN.md) | Die ursprüngliche Design-Spezifikation (historisch). |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Lokales Dev-Setup, Skripte, Konventionen. |

## Lizenz

[MIT](../../LICENSE) © 2026 Proof of Play, Inc. Drittanbieter-Komponenten und Marken sind in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) aufgeführt — beachtet, dass die Laufzeitabhängigkeit `@anthropic-ai/claude-agent-sdk` proprietär ist und unter Anthropics Bedingungen genutzt wird, nicht unter der MIT-Gewährung.
