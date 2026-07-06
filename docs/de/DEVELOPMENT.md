# Entwicklung

## Voraussetzungen

- macOS (einzige unterstützte Plattform für v1)
- Node 20 LTS oder neuer (`.nvmrc` wird dies pinnen, sobald das Scaffold landet)
- pnpm (bevorzugt) oder npm
- Xcode Command Line Tools (`xcode-select --install`) — benötigt für den nativen Swift-Helper und alle node-gyp-Builds
- Ein Clone von [`autorpg`](../../../autorpg) unter `~/pop/autorpg` für End-to-End-Tests


## Ersteinrichtung

> Wartet auf das Electron-Scaffold (Phase 2). Dieser Abschnitt wird ausgefüllt, sobald `package.json` landet.

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## Skripte (geplant)

| Befehl | Zweck |
|---|---|
| `pnpm dev` | Vite-Dev-Server + Electron-Main mit Reload |
| `pnpm build` | Produktions-Renderer- + Main-Bundles |
| `pnpm package` | electron-builder → `release/` (.dmg) |
| `pnpm typecheck` | tsc --noEmit über main, preload, renderer, shared |
| `pnpm lint` | ESLint + Prettier Check |
| `pnpm test` | Vitest-Unit-Tests |

## Repo-Konventionen

- **TypeScript überall.** Kein `.js` außerhalb von Konfigurationsdateien. Strict Mode aktiviert.
- **Kein rohes IPC in Komponenten.** Der Renderer kommuniziert mit main über die typisierte `window.popbot.*`-Bridge, definiert in `src/preload/`.
- **Der Renderer ist reine Ansicht.** Kein fs, kein child_process, keine Node-Module mit nativen Bindings. Wenn eine Komponente Persistenz oder einen Systemaufruf benötigt, wird das über main + IPC exponiert.
- **Eine Datei pro React-Komponente**, benannt in `PascalCase.tsx`. Hooks liegen neben der Komponente, wenn privat, oder in `renderer/hooks/`, wenn gemeinsam genutzt.
- **Zuerst Tailwind, gescoptes CSS zweitrangig.** Das portierte `design/prototype/styles.css` wird zu einer Tailwind-Schicht + einem kleinen Satz von CSS Custom Properties für die Dark-Theme-Tokens (`--bg-1`, `--fg-2`, usw.).

## Arbeiten mit dem Design-Prototyp

Der ursprüngliche Prototyp liegt unter [`../design/prototype/`](../../design/prototype/) und ist **eingefrorene Referenz**, kein Build-Target. Siehe [`design/README.md`](../../design/README.md) für Hinweise, wie man ihn betrachtet.

Beim Portieren einer Komponente:

1. Die passende `*.jsx` neben der eigenen `.tsx` als visuelle Referenz öffnen.
2. Die `useStateA`/`useEffectA`-Aliase entfernen (ein Hack, den der Prototyp verwendete, um globale Kollisionen zu vermeiden).
3. `INITIAL_CHATS` und andere modulweite Fixtures durch Importe aus `renderer/fixtures/` ersetzen oder, irgendwann, durch IPC-Aufrufe.
4. Nah am visuellen und interaktiven Verhalten des Prototyps bleiben — siehe [memory: stick close to the design](../../).

## Commit-Stil

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Body ≤ 72 Spalten. Führt mit dem **Warum**, nicht dem **Was**.
- Ein PR pro logischer Änderung. Scaffold und Features nicht bündeln.

## Arbeiten mit verwandten Repos

PopBot steuert das AutoRPG-Unity-Projekt + den Sidecar-Server. Mehrere Phase-0-Voraussetzungen landen in jenem Repo, nicht in diesem:

- `POPBOT_MCP_PORT`-Env-Override im In-Editor-MCP
- `./run_local.sh --port`- und `--data-dir`-Flags
- Erweiterungen des `/health`-Endpunkts

Wenn ihr an diesen arbeitet, wechselt mit `cd ~/pop/autorpg` und folgt den Konventionen jenes Repos.
