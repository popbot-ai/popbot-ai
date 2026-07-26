# PopBot veröffentlichen

Releases werden von GitHub Actions über **macOS, Windows und Linux** gebaut
und auf einem GitHub Release dieses Repos veröffentlicht. Jede Plattform baut auf ihrem
eigenen Runner — die nativen Module (`better-sqlite3`, `node-pty`) müssen
gegen die ABI von Electron pro OS kompilieren, sodass Cross-Compiling keine Option ist.

## Vor dem Release: Release-Notes aktualisieren

Drei Stellen tragen den nutzersichtbaren „Was ist neu“-Text, und alle drei
werden **von Hand gepflegt** — nichts generiert sie. Aktualisiert sie im
selben PR wie das Feature, damit ein Release nie das vorherige beschreibt:

1. **What's-New-Popup in der App** — `whatsNew.f1.*` / `whatsNew.f2.*` in
   `src/shared/i18n/messages/*.ts`. **Alle 12 Sprachen.** Wird einmal pro
   Version beim ersten Start nach einem Update gezeigt.
2. **Hero-Band auf der Website** — die zwei `whatsnew.f*`-Zeilen in
   `site/index.html` **und** ihre Übersetzungen in `site/i18n.js`.
   **Alle 12 Sprachen.**
3. **Tabelle `## Recent releases` oben in `README.md`** — die neue Version
   ergänzen und die älteste entfernen, sodass drei bleiben. **Nur die
   englische README** — die übersetzten Kopien unter
   `docs/<locale>/README.md` tragen diese Tabelle bewusst nicht, damit sie
   nicht in 11 weiteren Sprachen veraltet.

Haltet 1 und 2 auf ein bis zwei Kernfeatures begrenzt. Weist auf alles hin,
was das Verhalten bestehender Chats ändert (z. B. ein eingestelltes Modell,
das automatisch weitergeführt wird) — das merken Nutzer ohnehin.

Betas laufen getrennt: Die Punkte des Beta-Bands kommen aus
`beta-highlights.json`, das `scripts/gen-manifest.mjs` in das
Download-Manifest einbackt.

## Ein Release schneiden

Releases laufen **vollständig über GitHub Actions** — es gibt keinen lokalen
Release-Schritt (`npm run release` ist nur noch ein Stub, der hierher verweist).

GitHub → **Actions** → **Release** → **Run workflow**:

- **bump**: `patch` | `minor` | `major`
- **channel**: `prerelease` (signierter Testbuild) | `release` (als „latest“ veröffentlichen)

Die nächste Version wird aus dem neuesten finalen `v*`-Tag berechnet (Tags mit
`-` werden ignoriert) und gemäß **bump** erhöht. Ein `prerelease` erhält
zusätzlich das Suffix `-rc.<run_number>` und landet in `beta/`; ein `release`
landet in `stable/`.

**Für die Version sind Git-Tags die maßgebliche Quelle, nicht `package.json`.**
Der Workflow liest `package.json` nie, um die nächste Version zu bestimmen, und
committet auch keine zurück: Er leitet die Version aus den Tags ab und setzt sie
zur Build-Zeit mit `npm version --no-git-tag-version`. Haltet die committete
Version in `package.json` trotzdem aktuell (im Release-PR erhöhen), damit Repo
und lokale Dev-Builds keine veraltete Nummer zeigen — der Build ignoriert sie
allerdings.

## Was produziert wird

| Plattform | Artefakte |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | NSIS-Installer `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (kein Auto-Update — siehe Linux-Hinweis unten) |

Die `latest*.yml` + `.blockmap`-Dateien sind electron-updater-Metadaten
([`electron-builder.yml`](../../electron-builder.yml) `publish: github`
erzeugt sie). Der In-App-Auto-Updater konsumiert sie, um Updates zu erkennen, herunterzuladen
und bereitzustellen — siehe den Abschnitt Auto-Update unten.

Workflow: [`.github/workflows/build.yml`](../../.github/workflows/build.yml).

## CI-Trigger

- **`v*`-Tag-Push** → baut alle Plattformen (signiert, falls Secrets gesetzt sind) +
  veröffentlicht ein GitHub Release.
- **Pull Request nach `main`** (nicht-docs) → nur Validierungs-Build, **immer
  unsigniert**; Artefakte werden an den Run angehängt, nichts wird veröffentlicht, keine Secrets verwendet.
- **Manuell** → "Run workflow" (workflow_dispatch), unsigniert.

Signieren läuft ausschließlich bei einem `v*`-Tag-Push, was nur der Repo-Owner tun
kann. GitHub gibt Secrets niemals an fork-ausgelöste PR-Runs weiter, sodass
Contributor-PRs die Signing-Zertifikate nicht erreichen können.

## Code-Signing

Signing wird durch **GitHub-Actions-Secrets** gesteuert (Settings → Secrets and
variables → Actions). Sie sind verschlüsselt, nie im Git-Tree, und in Logs maskiert.
Ohne gesetzte Secrets erzeugen Tag-Builds unsignierte Binaries (macOS
Gatekeeper / Windows SmartScreen warnen beim ersten Start), und CI besteht trotzdem.

### macOS (signieren + notarisieren)

| Secret | Wert |
|--------|-------|
| `MAC_CSC_LINK` | base64 eurer "Developer ID Application" `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | Passwort für diese `.p12` |
| `APPLE_ID` | Apple-ID-E-Mail, verwendet für die Notarisierung |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-spezifisches Passwort von appleid.apple.com |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Ein Tag-Build signiert + notarisiert nur, wenn das **vollständige Set** vorhanden ist —
`MAC_CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` **und**
`APPLE_TEAM_ID` (plus `MAC_CSC_KEY_PASSWORD` für das Zertifikat). Falls etwas
fehlt, baut es unsigniert, statt die Notarisierung erst spät fehlschlagen zu lassen, sodass ein
halb konfiguriertes Secret-Set CI nicht bricht.

### Windows (optional)

| Secret | Wert |
|--------|-------|
| `WIN_CSC_LINK` | base64 eurer Code-Signing-`.pfx` |
| `WIN_CSC_KEY_PASSWORD` | Passwort für diese `.pfx` |

Ein Tag-Build signiert, wenn `WIN_CSC_LINK` vorhanden ist; sonst unsigniert.

## Auto-Update

In-App-Auto-Update ist mit **electron-updater** verdrahtet
([`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts)).
In gepackten Builds pollt es die Releases dieses Repos, lädt eine
neuere Version **still** im Hintergrund herunter und zeigt einen **"Restart to install"**-Toast,
sobald sie bereitsteht — ein Klick darauf beendet die App und startet sie neu in der neuen Version. Es
liest die `latest*.yml` + `.blockmap`-Metadaten, die der Release-Workflow
anhängt; die `publish: github`-Konfiguration in `electron-builder.yml` bettet die
`app-update.yml` ein, die der Client braucht.

**Signieren ist für den Installationsschritt erforderlich.** macOS lehnt unsignierte
Updates ab, daher funktioniert die In-App-Installation erst, sobald Releases signiert + notarisiert sind
(der Tag-Build-Pfad mit gesetzten Apple-Secrets). Bis dahin — und immer wenn
der Updater auf einen Fehler stößt (keine Metadaten, Netzwerkfehler) — **fällt es zurück**
auf einen manuellen "Download"-Toast, der die Release-Seite öffnet, gesteuert vom
leichtgewichtigen GitHub-Check in
[`src/main/updates/check.ts`](../../src/main/updates/check.ts). Derselbe
leichtgewichtige Check unterstützt auch das On-Demand-"Check for
updates" des About-Dialogs und funktioniert überall, einschließlich in Dev- und unsignierten Builds.

Damit irgendetwas davon ein Release zutage fördert, muss der Workflow
**non-draft, non-prerelease**-Releases mit den angehängten Plattform-Installern
veröffentlichen — was er tut. Auto-Update ist in Dev deaktiviert.

### Auto-Update verifizieren (erster End-to-End-Test)

Der Auto-Update-Pfad kann nur gegen **zwei echte signierte
Releases** verifiziert werden — nicht in Dev (dort ist es deaktiviert) und nicht gegen ein einzelnes
Release (es gibt nichts Neueres zum Abrufen). Macht dies einmal, nachdem Signing eingerichtet ist:

1. **Bestätigt, dass Signing aktiv ist.** Fügt die macOS- (und optional Windows-)
   Secrets aus der Tabelle oben hinzu. Das erste signierte Release muss erfolgreich sein —
   auf macOS können unsignierte/nicht notarisierte Builds heruntergeladen werden, aber die
   Installation **schlägt fehl**, daher ist dieser gesamte Test ohne Signierung bedeutungslos.
2. **Schneidet Release N** — Actions → Release → bump `patch`, channel
   `release` (z. B. → `v0.1.2`). Wartet, bis der Workflow das Release mit
   Assets + `latest*.yml` veröffentlicht.
3. **Installiert N aus dem veröffentlichten Release** auf jedem unterstützten OS
   (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Startet es — verifiziert, dass
   Help ▸ About die richtige Version zeigt.
4. **Schneidet Release N+1** genauso (z. B. → `v0.1.3`).
5. **Lässt die N-Installation laufen.** Innerhalb von ~30s nach dem Start (und danach alle
   6h) prüft es; bei einem signierten Build lädt es N+1 still herunter und zeigt dann
   den **"Restart to install"**-Toast. Klickt ihn an.
6. **Bestätigt, dass es in N+1 neugestartet ist** — Help ▸ About zeigt jetzt die neue
   Version. Das beweist, dass Download → Bereitstellen → quitAndInstall → Neustart auf diesem OS funktioniert.

Hinweise pro Plattform:
- **macOS:** Squirrel.Mac wendet das Update aus dem `.zip`-Asset an (nicht dem
  `.dmg`); beide müssen im Release enthalten sein. Gatekeeper lehnt ein unsigniertes/
  nicht notarisiertes Update ab — falls "Restart to install" nichts bewirkt, prüft
  erneut die Notarisierung des Builds.
- **Linux:** das `.deb` **aktualisiert sich nicht selbst** — electron-updater
  aktualisiert unter Linux nur AppImage automatisch. Aktualisiert wird durch Installieren des neuen `.deb`
  (`sudo dpkg -i …` / `sudo apt install ./…`). Überspringt also die Auto-Update-
  Schritte (4–6) für Linux; installiert einfach N+1 über N und bestätigt About. Um
  In-App-Auto-Update unter Linux wiederherzustellen, fügt `AppImage` erneut zum `linux.target`
  in `electron-builder.yml` hinzu.
- **Windows:** die NSIS-Installation aktualisiert an Ort und Stelle; SmartScreen könnte warnen,
  bis der Build mit `WIN_CSC_LINK` signiert ist.

Falls Schritt 5 stattdessen einen **"Download"**-Toast zeigt (der die Release-Seite öffnet),
ist der In-App-Updater auf einen Fehler gestoßen und zurückgefallen — prüft das Diagnose-Log
(`update.error` / `update.check.failed`-Einträge), um herauszufinden warum, meist ein
unsignierter macOS-Build.
