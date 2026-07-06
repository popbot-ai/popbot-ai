# Sviluppo

## Prerequisiti

- macOS (unica piattaforma supportata per la v1)
- Node 20 LTS o più recente (`.nvmrc` verrà fissato quando arriverà lo scaffold)
- pnpm (preferito) o npm
- Xcode Command Line Tools (`xcode-select --install`) — necessari per l'helper nativo Swift e per eventuali build di node-gyp
- Un clone di [`autorpg`](../../../autorpg) in `~/pop/autorpg` per i test end-to-end

## Configurazione iniziale

> In attesa dello scaffold Electron (Fase 2). Questa sezione verrà completata quando arriverà `package.json`.

```bash
# placeholder — in arrivo
pnpm install
pnpm dev
```

## Script (pianificati)

| Comando | Scopo |
|---|---|
| `pnpm dev` | Server di sviluppo Vite + Electron main con reload |
| `pnpm build` | Bundle di produzione per renderer + main |
| `pnpm package` | electron-builder → `release/` (.dmg) |
| `pnpm typecheck` | tsc --noEmit su main, preload, renderer, shared |
| `pnpm lint` | Controllo ESLint + Prettier |
| `pnpm test` | Test unitari Vitest |

## Convenzioni del repository

- **TypeScript ovunque.** Nessun `.js` al di fuori dei file di configurazione. Strict mode attivo.
- **Niente IPC grezzo nei componenti.** Il renderer comunica con il main tramite il bridge tipizzato `window.popbot.*` definito in `src/preload/`.
- **Il renderer è vista pura.** Nessun fs, nessun child_process, nessun modulo node con binding nativi. Se un componente ha bisogno di persistenza o di una chiamata di sistema, va esposta tramite main + IPC.
- **Un file per componente React**, nominato in `PascalCase.tsx`. Gli hook risiedono accanto al componente quando sono privati, oppure in `renderer/hooks/` quando sono condivisi.
- **Prima Tailwind, poi CSS con ambito limitato.** Il `design/prototype/styles.css` portato diventa un layer Tailwind + un piccolo insieme di custom property CSS per i token del tema scuro (`--bg-1`, `--fg-2`, ecc.).

## Lavorare con il prototipo di design

Il prototipo originale risiede in [`../design/prototype/`](../../design/prototype/) ed è **riferimento congelato**, non un target di build. Vedi [`design/README.md`](../../design/README.md) per come visualizzarlo.

Quando si porta un componente:

1. Aprire il `*.jsx` corrispondente accanto al proprio `.tsx` come riferimento visivo.
2. Rimuovere gli alias `useStateA`/`useEffectA` (un espediente usato dal prototipo per evitare collisioni globali).
3. Sostituire `INITIAL_CHATS` e altre fixture a livello di modulo con import da `renderer/fixtures/` o, in futuro, con chiamate IPC.
4. Rimanere fedeli al comportamento visivo e di interazione del prototipo — vedi [memoria: attenersi al design](../../../).

## Stile dei commit

- Commit convenzionali: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Corpo ≤ 72 colonne. Iniziare con il **perché**, non con il **cosa**.
- Una PR per ogni cambiamento logico. Non unire scaffold e funzionalità.

## Lavorare con i repository correlati

PopBot pilota il progetto Unity AutoRPG + il server sidecar. Diversi prerequisiti della Fase 0 arrivano in quel repository, non in questo:

- Override della variabile d'ambiente `POPBOT_MCP_PORT` sull'MCP in-Editor
- Flag `./run_local.sh --port` e `--data-dir`
- Estensioni dell'endpoint `/health`

Quando si lavora su questi elementi, eseguire `cd ~/pop/autorpg` e seguire le convenzioni di quel repository.
