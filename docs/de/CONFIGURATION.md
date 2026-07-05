*Languages: [English](../CONFIGURATION.md) · [Español](../es/CONFIGURATION.md) · [Français](../fr/CONFIGURATION.md) · **Deutsch** · [日本語](../ja/CONFIGURATION.md) · [한국어](../ko/CONFIGURATION.md) · [简体中文](../zh-CN/CONFIGURATION.md) · [Português (Brasil)](../pt-BR/CONFIGURATION.md) · [Русский](../ru/CONFIGURATION.md) · [Italiano](../it/CONFIGURATION.md)*

# PopBot konfigurieren

Alles in PopBot wird in-app über **Preferences** konfiguriert (das Zahnrad in der Titelleiste, oder `⌘,`) — es gibt keine Config-Dateien zum Hand-Editieren. Dieser Guide führt durch jedes Panel in der Reihenfolge, in der die Navigation sie auflistet, was ungefähr der Reihenfolge entspricht, in der ihr sie beim ersten Mal einrichten würdet.

> Credentials, die ihr eingebt (Linear, Jira, GitHub, Perforce usw.), werden **lokal auf eurer Maschine** in der eigenen Datenbank der App gespeichert — niemals in diesem Repository.

- [Integrationen](#integrationen) · [Agents](#agents) · [Runtime & Slots](#runtime--slots) · [Repositories](#repositories) · [Versionskontrolle](#versionskontrolle) · [Externe Apps](#externe-apps) · [Prompt-Templates](#prompt-templates) · [Code-Reviews](#code-reviews) · [Benachrichtigungen](#benachrichtigungen) · [Berechtigungen](#berechtigungen) · [Sprache](#sprache)

---

## Integrationen

Zwei unabhängige Gruppen leben hier: die **Ticket-Quelle**, die die Tickets-Queue speist, und die **Game-Engines**, die ein Slot starten kann.

![Integrations — Linear](../../images/preferences_integrations1.png)

### Ticket-Quelle

Ein einzelner aktiver Issue-Tracker speist die Tickets-Queue. Wählt ihn aus dem Selektor oben im Panel; das Config-Formular darunter wechselt entsprechend. Immer nur ein Tracker ist aktiv.

- **Linear** — fügt einen API-Key ein (von *linear.app → Settings → API*). Optional setzt einen **Team-Key** (z. B. `ENG`), um den Ticket-Feed auf ein Team zu begrenzen, und wählt ein **Project**, um es weiter einzugrenzen. Speichern verifiziert den Key und zeigt, mit wem er sich verbunden hat.
- **Jira** — gebt eure Site-URL ein (`https://your-domain.atlassian.net`), die Account-E-Mail und ein API-Token (von *id.atlassian.com → Security → API tokens*). Optional auf ein **Project** begrenzen und einen **JQL**-Filter hinzufügen (z. B. `labels = backend`). Speichern verifiziert die Credentials, bevor sie persistiert werden.
- **GitHub** — GitHub Issues brauchen hier keine Credentials: der Provider ruft die bereits für Reviews und Git-Aktionen authentifizierte `gh`-CLI auf, und die Queue umspannt dieselben Repositories, die unter [Repositories](#repositories) konfiguriert sind. Das Formular ist ein Status-Check, der bestätigt, dass `gh` installiert und authentifiziert ist, und berichtet, wie viele Repos es abdeckt.

Jeder Tracker mit Credentials verifiziert sie bei **Save**, bevor sie persistiert werden, und zeigt eine *Connected / Not connected*-Status-Pille.

### Game-Engines

Anders als die Single-Select-Ticket-Quelle sind Engines **unabhängig** — ihr könnt Unity, Unreal und eine Custom-Engine gleichzeitig aktivieren. Jede aktivierte Engine fügt der Chat-Leiste einen **Run**-Button hinzu, der ihren Editor aus dem Slot-Workspace des Chats startet.

- **Enabled** — eine Checkbox pro Engine, die den Run-Button dieser Engine auf der Chat-Leiste zeigt (oder verbirgt).
- **Detected installs / Editor binary** *(Unity, Unreal)* — PopBot scannt nach installierten Editoren (Unity-Hub-/Epic-Installationen), mit einem **Rescan**-Link; wählt eine erkannte Version, oder gebt einen absoluten **Editor binary**-Pfad ein, um das Dropdown zu überschreiben.
- **Run command** *(Custom)* — ein freiformiger Shell-Befehl, ausgeführt im Projektverzeichnis, mit separaten **macOS-/Linux-** und **Windows**-Varianten, sodass eine Config plattformübergreifend funktioniert. Eine Custom-Engine hat keine automatische Erkennung; PopBot reicht die Slot-Identität über eine Umgebungsvariable `POPBOT_SLOT` an euren Befehl durch, sodass ihr euren eigenen "Ausführen-und-Verifizieren"-Flow verdrahten könnt.
- **Project subpath** — der Pfad des Engine-Projekts relativ zum Workspace-Root (der Unity-Projektordner; der Ordner mit der `.uproject`; oder das cwd, in dem ein Custom-Befehl läuft). Leer lassen, wenn der Workspace-Root *das* Projekt *ist*.
- **Use MCP + Base MCP port** *(Unity, Unreal)* — wenn die **Use MCP**-Checkbox an ist, wird der Editor gestartet, ausgerichtet auf einen In-Editor-MCP-Server, sodass ein Agent ihn steuern kann. Jeder Slot bekommt seinen **eigenen Port**, sodass parallele Slots nie kollidieren: der Port ist `basePort + (slotId − 1)` (Slot 1 → Base, Slot 2 → Base + 1, …). Das Feld **Base MCP port** setzt den Port von Slot 1; es ist standardmäßig **8000 für Unreal** und **8080 für Unity** (passend zum Standard des MCP-Plugins jeder Engine) und wird bei Löschen auf diesen Standard zurückgesetzt.
- **Show project path in title bar** *(Unity)* — ein **Install title-bar script**-Button, der ein kleines Editor-Skript in euer Unity-Projekt fallen lässt, sodass jeder offene Editor seinen vollständigen Projektpfad in seiner Titelleiste zeigt, wodurch Slot-Fenster leicht auseinanderzuhalten sind. Das Skript ist sicher zu committen.

> **Slack** und **Sentry** bleiben Verbindungs-Stubs statt verdrahteter Postfach-Quellen, also werden sie hier heute nicht als Panels gezeigt. Sie können ohne strukturelle Änderungen wieder aktiviert werden; siehe die Anmerkung am Ende des [Feature- & Workflow-Guide](GUIDE.md).

## Agents

Standardmodell-**Reasoning-Effort** für neu erstellte Chats (bestehende Chats behalten ihren eigenen, bis ihr ihn im Chat-Composer ändert).

![Agents](../../images/preferences_agents.png)

- Setzt Effort unabhängig für **Claude** und **Codex**, und separat für:
  - **New chats** — generische und Ticket-Chats.
  - **Code reviews** — PR-Review-Chats, Re-Review-Fallback-Chats und Review-Benachrichtigungen.

Höherer Effort bedeutet tieferes Reasoning und gründlicheren Tool-Einsatz, bei höheren Kosten und Latenz. Reviews wollen oft eine andere Tiefe als Feature-Builds — daher die Trennung.

## Runtime & Slots

Dieses Panel steuert die **Attachment-Aufbewahrung**. (Slot-Pool-Größe ist jetzt pro Repository und lebt unter [Repositories](#repositories) — siehe die Anmerkung dort.)

![Runtime & slots](../../images/preferences_slots.png)

- **Keep attachments for** — wie lange Dateien und Bilder, die ihr an einen Chat anhängt, im eigenen Storage von PopBot aufbewahrt werden (Standard 60 Tage, Bereich 1–365). Attachments werden in PopBots Storage kopiert, damit sie sich weiterhin aus der Chat-Historie öffnen lassen, selbst nachdem sich das Original bewegt hat; ein Startup-Sweep löscht Kopien, die älter als dieses Fenster sind, damit der Ordner nicht unbegrenzt wachsen kann.

> Der obige Screenshot könnte von vor der Aufteilung der Slot-Pool-Größe in den Pro-Repo-Flow stammen.

## Repositories

Jeder Chat lebt in einem **Repository**. Dieses Panel listet eure Repos auf und ist dort, wo Versionskontrolle, Slots und Copy-on-Write-Workspaces pro Repo konfiguriert werden.

![Repositories](../../images/preferences_repositories.png)

- **Add Repository** öffnet einen ordner-ersten Wizard: wählt einen Ordner, und PopBot **erkennt seine Versionskontrolle** (Git oder Perforce) und verzweigt entsprechend. Ihr setzt dann eine ID, Akzentfarbe, Slot-Präfix und Slot-Anzahl.
  - **Git**-Repos wählen den **Slots**-Modus (ein wiederverwendeter Pool von Workspaces — der Standard, angezeigt als `slots × N`) oder **ephemeral** (ein frischer Workspace pro Chat). Der Slots-Modus hält Build-Caches über Chats hinweg warm.
  - **Perforce**-Repos sind immer im Slot-Modus. Der Wizard erfasst die P4-Verbindung, führt einen **Disk-Preflight** durch und baut ein eingefrorenes **Basis-Image** des synchronisierten Baums; Slots werden dann als Copy-on-Write-Kinder dieser Base erstellt (siehe unten).
- **Copy-on-Write-Workspaces.** Der Workspace eines Slots ist ein Copy-on-Write-Ordner, der sich ein **Basis-Image** des Repos teilt und nur die Blöcke speichert, die er ändert, via `shado` (PopBots Shadow-Workspace-Schicht): **differenzierendes VHDX** auf Windows, natives Copy-on-Write (APFS/Reflink) auf macOS und Linux. Zehn Slots auf einem terabyte-großen Baum kosten ungefähr die Disk eines Repos plus das kleine Delta jedes Slots — was riesigen Perforce-Bäumen überhaupt erst erlaubt teilzunehmen. Das Basis-Image wird einmal gebaut, als Schritt des Add-Repository-Wizards.
- **Der Modus ist permanent.** Der Slots-vs-Ephemeral-Modus eines Repos ist bei der Erstellung fixiert; ein Wechsel würde die Workspaces laufender Chats verwaisen lassen.
- **Edit** an einem Repo, um seine Akzentfarbe, den Standard-Base-Branch (Git) oder das Perforce-Agent-Arbeitsverzeichnis zu ändern, und um **Slots zu resizen** (den Pool workspace-weise vergrößern oder verkleinern, gegated darauf, dass alle Chats in diesem Repo geschlossen sind).
- **Delete** ein Repo; die Bestätigung warnt euch, wenn noch Chats darauf verweisen.

Mehrere Repos laufen nebeneinander, jedes mit seinem eigenen Slot-Pool und seiner Akzentfarbe (die Farbe tönt die Slot-Pillen dieses Repos, damit ihr Chats auf einen Blick auseinanderhalten könnt). Jede Repo-Karte zeigt ihren Versionskontroll-Provider und Modus.

## Versionskontrolle

Globale Versionskontroll-Einstellungen und die editierbaren Aktions-Templates. Git- und Perforce-Panels werden nebeneinander gezeigt, weil der Provider eines Repos pro Ordner erkannt wird und beide gleichzeitig im Einsatz sein können.

![Source control](../../images/preferences_source_control.png)

- **Change-view file limit** *(gemeinsam)* — die meisten Dateien, die in der Change-Ansicht gezeigt werden, bevor die Liste gedeckelt wird. Gilt für Git und Perforce gleichermaßen.

**Git**

- **Branch username** — das Präfix für neue Branches: `<username>/<ticket>-<slug>`.
- **Action templates** — die Prompts, die das SCM-Panel an den Agent sendet für **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR** und **Rebase onto base**. Jedes unterstützt `${name}`-Makros (`${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, `${prurl}`…).

**Perforce**

- **Connection defaults** — der `p4`-Binary-Pfad, Standard-Server-Port und Standard-Nutzer, die den Add-Repository → Perforce-Connect-Schritt vorausfüllen.
- **Transfer / submit options** — Anzahl paralleler Sync-Threads, und ob unveränderte Dateien bei Submit zurückgesetzt werden.
- **Swarm review poll interval** — wie oft das Reviews-Panel Helix Swarm nach Changelists abfragt, die auf euer Review warten. Dies ist **unabhängig vom Polling von GitHub** und hat eine **30-Sekunden-Untergrenze**; erhöht es, um die Last auf einem gemeinsam genutzten Perforce-/Swarm-Server im großen Maßstab zu senken.
- **Perforce action templates** — die Prompts, die das Perforce-Panel an den Agent sendet für **CR** (ein Helix-Swarm-Review öffnen/aktualisieren), **Run tests** und **Review & commit**, jeweils mit `${name}`-Makros.

## Externe Apps

Die Desktop-Apps, die PopBot aus der Icon-Zeile eines Chats startet, alle auf den Slot-Workspace dieses Chats gerichtet.

![External apps](../../images/preferences_external_apps.png)

- **Terminal** — welches Terminal der Terminal-Icon-Launcher öffnet (z. B. iTerm2).
- **Terminal shell (Windows)** — die vom In-App-Terminal-Panel verwendete Shell: PowerShell, Command Prompt oder PowerShell 7. Gilt für Terminals, die nach der Änderung geöffnet werden.
- **Code editor** — VS Code oder Cursor; wird auch für die klickbaren `file.ts:42`-Links in Edit-Tool-Zeilen verwendet.
- **Git client** — Standard ist GitHub Desktop.
- **Chrome profile for URLs** — pinnt Link-Öffnungen an ein bestimmtes Chrome-Profil (nach dessen Profil-*Verzeichnisnamen*), sodass sie immer in eurem Arbeitskonto landen.

> Engine-Binaries und ihre MCP-Optionen werden unter [Integrationen → Game engines](#integrationen) konfiguriert, nicht hier.

## Prompt-Templates

Die erste Nachricht, die PopBot sendet, wenn ein Chat entsteht. Jedes Template ist editierbar, mit einer Referenzkarte der `${name}`-Makros, die ihm zur Verfügung stehen. (SCM-Panel-Aktions-Templates leben unter [Versionskontrolle](#versionskontrolle).)

![Prompt templates](../../images/preferences_prompt_templates.png)

- **Start ticket** — feuert, wenn ihr einen Chat aus einem Ticket erzeugt, unabhängig von der Quelle (Linear, Jira oder GitHub Issues). Makros umfassen `${ticketid}`, `${tickettitle}`, `${markdown}`, `${branch}` und `${slot}`.
- **Start code review** — feuert, wenn ihr einen Chat aus einem Review erzeugt — einer GitHub-PR oder einer Helix-Swarm-Changelist. Der Standard weist den Agent an, den Review-Skill zu nutzen, den umgebenden Code zu lesen (nicht nur den Diff), und den Chat als nur-lesend zu behandeln.
- **Re-review** — feuert, wenn ihr einen bestehenden Review-Chat erneut reviewt; es begrenzt den Agent auf nur die neuen Commits.

Passt diese an, um die Konventionen, Checklisten und den Ton eures Teams zu kodieren.

## Code-Reviews

Steuerelemente für das **Reviews**-Postfach. Die Queue zeigt GitHub-PRs und Helix-Swarm-Changelists, die auf euer Review warten; PRs, die ihr bereits reviewt habt, werden automatisch entfernt.

![Code reviews](../../images/preferences_code_reviews.png)

- **Search cache window** — wie viele Tage zurück der **+ Add**-Picker jüngste Tickets und PRs fuzzy matcht (größer = durchsuchbarer, etwas langsamerer Refresh und mehr API-Budget). Euch zugewiesene Tickets sind unabhängig von diesem Cutoff immer eingeschlossen.
- **Ignore by title** — Teilstrings (einer pro Zeile, Groß-/Kleinschreibung wird ignoriert), die eine PR aus der Queue entfernen.
- **Ignore by GitHub author** — Bot-/Autor-Logins (einer pro Zeile, z. B. `renovate[bot]`) zum Stummschalten.

> Review-**Poll-Raten** werden pro Provider konfiguriert, nicht hier: das Helix-Swarm-Poll-Intervall lebt unter [Versionskontrolle → Perforce](#versionskontrolle), unabhängig vom Polling von GitHub, sodass ein gemeinsam genutzter Perforce-/Swarm-Server geschützt werden kann, ohne GitHub zu verlangsamen.

## Benachrichtigungen

Wie Alerts erscheinen.

![Notifications](../../images/preferences_notifications.png)

- **VIP names** — Leute, deren Nachrichten immer auf dringende Priorität hochgestuft werden. Als Groß-/Kleinschreibung-unabhängige Teilstrings des Anzeigenamens abgeglichen, also haltet Namen spezifisch.
- **Toast placement** — *Top-center, fly to bell on dismiss* (Standard), oder klassische Top-right-Corner-Toasts. Der Umschalter wirkt sofort.
- **Test new-item flow** — markiert vorübergehend ein paar echte Queue-Items als NEW, um das Chip-/Pip-Verhalten zu vorschauen (nichts wird persistiert). Das ist eine temporäre Entwicklungshilfe.

## Berechtigungen

Der globale Standard für jedes Agent-Tool, und die Untergrenze unter dem autonomen Modus.

![Permissions](../../images/preferences_permissions.png)

- Für jedes Tool (**Bash**, **Read**, **Write**, **Edit**, **Grep**, **Glob**, **WebFetch**, **WebSearch**, …): **Ask** (jedes Mal fragen — der Standard), **Allow** (automatisch genehmigen) oder **Deny** (automatisch ablehnen).
- **Erlaubnisse pro MCP-Server.** Der Editor-MCP-Server eines Slots (Unity, Unreal, oder jeder MCP-Server, den ein Agent lädt) kann auf dieselben drei Arten genehmigt werden. Das einmalige Genehmigen des Editor-MCP eines Slots wird gemerkt, und die Gewährung ist hier sichtbar und widerrufbar — gezeigt als `unityEditor → all tools` / `unrealEditor → all tools` statt des rohen Namespace. PopBot aktiviert die Unity- und Unreal-Editor-MCPs auf diese Weise automatisch; eine Pro-Tool-Regel, die von einem Wildcard abweicht, wird als Override behalten.
- Pro-Chat-Regeln (gesetzt über die Berechtigungskarte via *Allow this chat* / *Deny this chat*) überschreiben diese globalen Einstellungen, sodass ein einzelner Chat ein Tool sperren kann, das ihr sonst überall erlaubt habt.

> Eine harte Verweigerungs-Untergrenze — `git push` / `p4 submit`, Netzwerk zu nicht auf der Allowlist stehenden Hosts, alles außerhalb des Workspace — lebt im Code und ist hier **nicht** überschreibbar, sodass eine fehlkonfigurierte Regel einen Agent nicht von sich aus zum Mainline landen lassen kann.

## Sprache

Die Oberfläche von PopBot ist vollständig lokalisiert.

- **Display language** — wechselt die Interface-Locale über das Sprachmenü, das jede Sprache in ihrem eigenen Namen auflistet. Die ausgelieferten Locales sind Englisch, Spanisch, Französisch, Deutsch, Chinesisch (vereinfacht), Japanisch, Koreanisch und Portugiesisch (brasilianisch). Die meisten Texte und die Menüs aktualisieren sich sofort; ein paar Systemstrings beenden die Aktualisierung nach einem Neustart. Neue Fenster und das App-Menü verwenden diese Sprache ebenfalls.

---

Siehe den **[Feature- & Workflow-Guide](GUIDE.md)** dafür, wie sich diese Einstellungen in echten Workflows auswirken.
