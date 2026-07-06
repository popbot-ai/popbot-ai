# User Stories

Die "wie sieht Erfolg aus"-Referenz für PopBot. Erfasst am 2026-05-01. Jede Implementierungsentscheidung sollte auf eine davon zurückführbar sein.

Der Nutzer ist ein einzelner Entwickler (Ben), der PopBot auf seiner eigenen Maschine betreibt. "Ich" unten ist er.

> **Status (Anmerkung hinzugefügt 2026-07, bei Veröffentlichung).** Die Stories unten sind die *gründenden* User Stories, erfasst 2026-05, hier als das ursprüngliche Protokoll der Design-Absicht erhalten. PopBot wurde seitdem weit über diesen ersten Single-User-, Unity-/Linear-/Slack-/GitHub-Scope hinaus generalisiert — es umspannt jetzt Git und Perforce, Unity und Unreal, Linear/Jira/GitHub Issues, GitHub PRs und Helix Swarm, und wird lokalisiert in mehreren Sprachen unter einer MIT-Lizenz ausgeliefert. Dieses Dokument ist absichtlich *nicht* nachträglich angepasst, um dazu zu passen; behandelt es als Geschichte, und seht [GUIDE.md](GUIDE.md) für den aktuellen Funktionsumfang. Die Stories US-1..US-9 und die Erfassung von 2026-05 sind unverändert.

---

## US-1 · Bewusstsein der Attention-Queue

> *"Ich sollte mir hochprioritärer Issues, Slack-Nachrichten und anderer PRs bewusst sein, um die ich mich kümmern muss."*

Drei Quellen, gemeinsam oben im Fenster dargestellt:

- **Linear-Tickets**, die mir zugewiesen sind, gerankt nach Priorität + Fälligkeitsdatum.
- **Slack-Nachrichten**, die an mich adressiert sind (DMs, @mentions, Kanäle, die ich besitze). _Neue Anforderung; nicht im ursprünglichen Design — siehe [Abweichungen](#abweichungen-und-ergänzungen)._
- **GitHub-PRs**, die mein Review anfordern.

Jede Zeile zeigt genug auf einen Blick, um ohne Klicken zu triagieren (Titel, Quelle, Alter, Prioritätsindikator). Hochprioritäre Items heben sich visuell von niedrigprioritären ab.

**Ordnet sich zu:** [POPBOT_DESIGN.md → App-Layout](POPBOT_DESIGN.md#app-layout) (Tickets-/Reviews-Panels — erweitert um ein Slack-Panel).

---

## US-2 · Ein-Klick-Aktivierung

> *"Ich sollte in der Lage sein, Aktivität für jedes davon leicht zu initiieren und einen Chat zu öffnen, um mit der Arbeit zu beginnen."*

Das Klicken jeder Zeile in der Attention-Queue erzeugt einen neuen Chat, geseedet für diese Arbeit:

- Linear-Ticket → Chat geseedet mit dem Ticket-Body, Branch benannt nach dem Ticket-Key, Agent-Prompt vorausgefüllt.
- Slack-Nachricht → Chat geseedet mit dem Konversationskontext, bereit, eine Antwort zu entwerfen oder echte Arbeit zu starten.
- PR → Chat geseedet mit dem Diff und der Review-Checkliste.

Keine Setup-Reibung zwischen "ich sehe etwas, das ich handhaben muss" und "ein Agent arbeitet daran."

**Ordnet sich zu:** [POPBOT_DESIGN.md → App-Layout](POPBOT_DESIGN.md#app-layout) ("Klicke eine Zeile → erzeuge einen Chat, geseedet für diese Arbeit").

---

## US-3 · Echtes Spieletesten im Chat

> *"Chats sollten in der Lage sein, eine Unity-Instanz einzubinden und unity/server bei Bedarf auszuführen, damit sie Arbeit testen und debuggen können."*

Wenn ein Chat Verhalten im echten Spiel verifizieren muss, erwirbt der Chat einen Slot, startet Unity (platziert auf Bildschirm 2), und startet optional den Sidecar-Server. Der Agent steuert das Spiel über das In-Editor-MCP — tritt in den Play-Modus ein, klickt UI an, macht Screenshots, liest Logs, prüft Zustand.

Einen Slot zu erwerben ist beim ersten Mal der langsame Teil (~15-30 s kalt); nachfolgende Aktivität ist klebrig (~50 ms).

**Ordnet sich zu:** [POPBOT_DESIGN.md → Chat-Typen](POPBOT_DESIGN.md#chat-typen) (Client Test / Server Test), [Slots](POPBOT_DESIGN.md#slots--die-dauerhafte-einheit), [MCP-Automatisierungsoberfläche](POPBOT_DESIGN.md#mcp-automatisierungsoberfläche).

---

## US-4 · Autonomer End-to-End-Abschluss mit Beweis

> *"Agents sollten in der Lage sein, vollständig autonom zu arbeiten, und ein ganzes Ticket zu fixen/debuggen und abzuschließen, einschließlich der Lieferung eines Beweises, dass der Fix/Change wie gefordert funktioniert hat, in einem inspizierbaren Markdown-Dokument."*

Im autonomen Modus durchläuft der Agent einen vollständigen Lesen → Reproduzieren → Fixen → Verifizieren-Zyklus ohne Eingriff und schreibt am Ende ein `proof.md`-Artefakt. Der Beweis enthält:

- **Repro** — die exakten Schritte, die den Bug demonstriert haben.
- **Before** — Screenshots + gefilterte Log-Dumps vom kaputten Zustand.
- **Root cause** — die Diagnose des Agents.
- **Fix** — der Diff oder die Zusammenfassung der Änderungen.
- **After** — Screenshots + saubere Log-Dumps vom gefixten Zustand.
- **Verification** — ein erneuter Durchlauf der Repro, jetzt bestehend.

Ich kann `proof.md` öffnen und entscheiden, ob die Arbeit gut ist, ohne selbst irgendetwas erneut auszuführen. Pause-zum-Review wird nur für riskante Operationen gebraucht (`git push`, `gh pr create`, usw.).

**Ordnet sich zu:** [POPBOT_DESIGN.md → Autonomer Modus](POPBOT_DESIGN.md#autonomer-modus), [Proof-Artefakte](POPBOT_DESIGN.md#proof-artefakte-debug-deliverable-des-agents).

---

## US-5 · Leichtes Multitasking via Thumbnails

> *"Ich sollte in der Lage sein, leicht zwischen Agents zu multitasken, indem ich auf Thumbnails klicke."*

Die Thumbnail-Leiste ist die primäre Navigationsoberfläche für parallele Arbeit. Eine Reihe kompakter Vorschauen — eine pro Chat — lässt mich sofort zwischen Agents springen. Das Klicken eines Thumbnails bringt diesen Chat in den Vordergrund; die anderen Chats laufen im Hintergrund weiter.

Das Thumbnail selbst kommuniziert Zustand, nicht nur Identität. Siehe US-6.

**Ordnet sich zu:** [POPBOT_DESIGN.md → App-Layout](POPBOT_DESIGN.md#app-layout) (Thumbnail-Reihe), Phase 3 in [PHASING.md](PHASING.md).

---

## US-6 · Status auf einen Blick

> *"Ich sollte leicht eine Idee bekommen können, was ein Agent tut, und ob er Unterstützung oder Anleitung von mir braucht, auf einen Blick."*

Jedes Chat-Thumbnail zeigt seinen aktuellen Zustand, ohne dass ich hineinklicken muss:

| Farbe | Bedeutung |
|---|---|
| Blau | Läuft |
| Grün | Aufgabe abgeschlossen |
| **Gelb** | **Pausiert — braucht mich** |
| Rot | Fehler |
| Grau | Untätig / nicht gestartet |

Gelb ist die Farbe, die Aufmerksamkeit verlangt. Das Überfliegen der Thumbnail-Reihe sollte "steckt jemand fest?" in unter einer Sekunde beantworten. Über die Farbe hinaus zeigt das Thumbnail einen kurzen Fortschrittshinweis (letzte Aktion, aktueller Schritt), damit ich entscheiden kann, ob ich eintauchen soll.

**Ordnet sich zu:** [POPBOT_DESIGN.md → Status-Farben](POPBOT_DESIGN.md#statusfarben-chat-thumbnail).

---

---

## US-7 · Von überall wiederherstellen und fortsetzen

> *"Ich sollte leicht in der Lage sein, Tickets wiederherzustellen und fortzusetzen, sogar solche, die nicht mehr aktiv sind, von dort, wo ich aufgehört habe."*

Ein Chat ist dauerhaft. Selbst nachdem ich ihn schließe, PopBot neustarte, oder rebooten, kann ich jeden vergangenen Chat wieder öffnen und genau dort weitermachen, wo ich aufgehört habe:

- Das vollständige Transcript spielt in die Chat-Spalte ab.
- Der Slot wird neu erworben (oder kalt hochgefahren) auf demselben Branch, auf dem ich war.
- Unity + Sidecar-Zustand stellt sich auf die relevante Fixture / den Save-Blob wieder her, falls einer gesetzt war.
- Der Agent liest das jüngste Transcript erneut, bevor er auf meine nächste Nachricht antwortet — Kontext geht über den Neustart hinweg nicht verloren.

Das Schließen eines Chats gibt seinen Slot frei; das Wiedereröffnen erwirbt ihn erneut. Der Chat ist das dauerhafte Protokoll; der Slot ist transiente Infrastruktur.

**Ordnet sich zu:** [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--die-dauerhafte-einheit) (Slot- vs. Chat-Lifecycle), [Tech stack → better-sqlite3](POPBOT_DESIGN.md#tech-stack) (Transcript-Persistenz). Das Schema des Pro-Chat-Records lebt in `src/main/persistence/`.

---

## US-8 · Pro-Ticket-Inspektion: Chat + Unity + Logs + Beweis

> *"Ich sollte leicht in der Lage sein, mir den Fortschritt eines Tickets anzuschauen, indem der Inhalt, die laufende Server-/Unity-Instanz, relevante Logs, das Abschluss-Artefakt (Markdown) gezeigt werden."*

Für jeden Chat (aktiv oder pausiert) bringt ein Klick alles hervor, was ich brauche, um Fortschritt zu bewerten:

- **Chat-Inhalt** — das laufende Transcript mit der Argumentation, den Tool-Aufrufen und Ausgaben des Agents.
- **Server-/Unity-Status** — ist der Slot oben, welcher Branch, wie ist der Screen-Stack, ist Unity im Play-Modus.
- **Relevante Logs** — Unity-Konsole + Sidecar-Server, gefiltert auf die Session des Chats, sync-gescrollt.
- **Abschluss-Artefakt** — das `proof.md` (und unterstützende `before/`, `after/`, `diff.patch`), das der Agent produziert hat, inline gerendert.

Das ist die "zeig mir, was passiert ist"-Ansicht. Nicht die rohe Feuerwehrschlauch-Ansicht — der kuratierte Querschnitt, der beantwortet "ist das gut gemacht?"

**Ordnet sich zu:** [POPBOT_DESIGN.md → App-Layout](POPBOT_DESIGN.md#app-layout) (Chat-Spalte + unteres Log-Panel), [Proof-Artefakte](POPBOT_DESIGN.md#proof-artefakte-debug-deliverable-des-agents). Der Proof-Renderer lebt in `src/renderer/chat/ProofViewer.tsx` (geplant).

---

## US-9 · Just-in-Time-Berechtigungsgewährungen

> *"Ich sollte leicht in der Lage sein, Agents Berechtigung zu geben, verschiedene Dinge zu tun, die ihnen nicht vollständig autonom erlaubt sein sollten."*

Wenn ein Agent etwas auf der Immer-Pausieren-Liste tun will (`git push`, `gh pr create`, `rm` außerhalb des Slots, Netzwerkaufrufe an nicht auf der Allowlist stehende Hosts, usw.), pausiert PopBot und fragt mich. Der Gewährungs-Flow ist:

- Ein Modal poppt auf mit **was** der Agent tun will, **warum** (der angegebene Grund des Agents), und dem **Befehl / den Argumenten**.
- Ich kann **einmal erlauben**, **für diesen Chat / diese Session erlauben**, **immer erlauben** (dauerhafte Pro-Tool-, Pro-Ziel-Regel), oder **verweigern**.
- Allow-Regeln akkumulieren pro Chat, im Chat-Settings-Panel dargestellt, damit ich sie widerrufen kann.
- Die hart codierte Deny-Liste ist nie über die UI überschreibbar — siehe [adr/0004](../adr/0004-canusetool-policy-boundary.md).

Der Punkt: Autonomie ist der Standard, aber ich kann eine spezifische riskante Aktion reibungslos genehmigen, ohne ein Terminal zu öffnen oder den Agent zu beaufsichtigen.

**Ordnet sich zu:** [POPBOT_DESIGN.md → Autonomer Modus](POPBOT_DESIGN.md#autonomer-modus), [adr/0004 — canUseTool policy boundary](../adr/0004-canusetool-policy-boundary.md). Der Grant-Store lebt in `src/main/agents/policy/`.

---

## Abweichungen und Ergänzungen

Dieser Abschnitt markiert Stellen, an denen die User Stories vom festgelegten Design abweichen. Verwendet bei der Implementierung die User Stories als Wahrheitsquelle und aktualisiert das Design-Dokument.

### Slack als dritte Attention-Quelle (US-1)

Das ursprüngliche Design deckt Linear-Tickets und ungereviewte PRs ab. Slack-Nachrichten waren nicht im Scope. Um US-1 zu honorieren:

- Fügt ein **Slack-Panel** zur oberen linken Tab-Gruppe neben Tickets und Reviews hinzu.
- Quelle: Slack-DMs, @mentions, und Nachrichten in Kanälen, die ich besitze. Filterregeln TBD pro Chat-Spawn-Workflow.
- Auth: Slack-OAuth (Token im Keychain via `keytar`).
- Das Erzeugen eines Chats aus einer Slack-Nachricht seedet den Agent mit dem Konversationskontext.

Das ist ein **komplett neues Subsystem** — Slack-API-Client in `src/main/slack/`, Panel in `src/renderer/panels/slack/`. Phasiert es in [PHASING.md](PHASING.md) Phase 3 neben den anderen Panels ein, aber behandelt es als erstklassigen Peer, nicht als nachträglichen Gedanken.
