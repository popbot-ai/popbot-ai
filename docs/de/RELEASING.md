*Languages: [English](../RELEASING.md) · [Español](../es/RELEASING.md) · [Français](../fr/RELEASING.md) · **Deutsch** · [日本語](../ja/RELEASING.md) · [한국어](../ko/RELEASING.md) · [简体中文](../zh-CN/RELEASING.md) · [Português (Brasil)](../pt-BR/RELEASING.md) · [Русский](../ru/RELEASING.md) · [Italiano](../it/RELEASING.md)*

# PopBot veröffentlichen

Releases werden von GitHub Actions über **macOS, Windows und Linux** gebaut
und auf einem GitHub Release dieses Repos veröffentlicht. Jede Plattform baut auf ihrem
eigenen Runner — die nativen Module (`better-sqlite3`, `node-pty`) müssen
gegen die ABI von Electron pro OS kompilieren, sodass Cross-Compiling keine Option ist.

## Ein Release schneiden

Von einem sauberen Arbeitsbaum auf `main`:

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh` erhöht die Version, committet, erstellt einen annotierten
`vX.Y.Z`-Tag und pusht beides. Der gepushte Tag löst den **Build**-
Workflow aus, der alle drei Plattformen baut und das GitHub-
Release mit den angehängten Artefakten veröffentlicht. Verfolgt es mit `gh run watch` oder dem
Actions-Tab.

Die nächste Version wird aus dem neuesten `v*`-Tag berechnet, erhöht gemäß dem
oben genannten Argument. Bevor irgendein Tag existiert, fällt es auf die Version in
`package.json` zurück (sodass das erste Release der nächste Bump darüber ist). Das
Skript weigert sich, von einem anderen Branch als `main` aus zu laufen (überschreibbar mit
`RELEASE_BRANCH=<name>`).

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
2. **Schneidet Release N**, z. B. `npm run release` → `v0.0.18`. Wartet, bis der
   Workflow das Release mit Assets + `latest*.yml` veröffentlicht.
3. **Installiert N aus dem veröffentlichten Release** auf jedem unterstützten OS
   (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Startet es — verifiziert, dass
   Help ▸ About die richtige Version zeigt.
4. **Schneidet Release N+1**, z. B. `npm run release` → `v0.0.19`.
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
