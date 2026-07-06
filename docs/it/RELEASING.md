# Rilasciare PopBot

I rilasci vengono costruiti da GitHub Actions su **macOS, Windows e Linux**
e pubblicati come GitHub Release su questo repository. Ogni piattaforma
viene costruita sul proprio runner — i moduli nativi (`better-sqlite3`,
`node-pty`) devono essere compilati contro l'ABI di Electron per ciascun
sistema operativo, quindi la cross-compilazione non è un'opzione.

## Effettuare un rilascio

Da un working tree pulito su `main`:

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh` incrementa la versione, effettua il commit, crea un
tag annotato `vX.Y.Z` ed esegue il push di entrambi. Il tag pubblicato
attiva il workflow **Build**, che compila tutte e tre le piattaforme e
pubblica la GitHub Release con gli artefatti allegati. Monitorarlo con
`gh run watch` o dalla tab Actions.

La versione successiva viene calcolata a partire dall'ultimo tag `v*`,
incrementato secondo l'argomento indicato sopra. Prima che esista un tag
qualsiasi, si ricade sulla versione presente in `package.json` (quindi il
primo rilascio è il bump successivo a quella versione). Lo script rifiuta
di essere eseguito da un branch diverso da `main` (sovrascrivibile con
`RELEASE_BRANCH=<name>`).

## Cosa viene prodotto

| Piattaforma | Artefatti |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | Installer NSIS `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (nessun aggiornamento automatico — vedi la nota su Linux più sotto) |

I file `latest*.yml` + `.blockmap` sono metadati di electron-updater (generati
dalla configurazione `publish: github` in [`electron-builder.yml`](../../electron-builder.yml)).
L'auto-updater in-app li consuma per rilevare, scaricare e preparare gli
aggiornamenti — vedi la sezione Auto-aggiornamento più sotto.

Workflow: [`.github/workflows/build.yml`](../../.github/workflows/build.yml).

## Trigger della CI

- **Push di un tag `v*`** → compila tutte le piattaforme (firmate se i
  secret sono impostati) + pubblica una GitHub Release.
- **Pull request verso `main`** (non-docs) → solo build di validazione,
  **sempre non firmata**; gli artefatti vengono allegati alla run, nulla
  viene pubblicato, nessun secret viene usato.
- **Manuale** → "Run workflow" (workflow_dispatch), non firmata.

La firma viene eseguita solo su un push di tag `v*`, operazione che solo
il proprietario del repository può effettuare. GitHub non espone mai i
secret alle run di PR attivate da fork, quindi le PR dei contributor non
possono raggiungere i certificati di firma.

## Firma del codice

La firma è guidata dai **secret di GitHub Actions** (Settings → Secrets and
variables → Actions). Sono cifrati, mai presenti nell'albero git, e
mascherati nei log. Senza alcun secret impostato, le build da tag
producono binari non firmati (macOS Gatekeeper / Windows SmartScreen
avvisano al primo avvio) e la CI comunque passa.

### macOS (firma + notarizzazione)

| Secret | Valore |
|--------|-------|
| `MAC_CSC_LINK` | base64 del proprio certificato "Developer ID Application" `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | password per quel `.p12` |
| `APPLE_ID` | email dell'Apple ID usato per la notarizzazione |
| `APPLE_APP_SPECIFIC_PASSWORD` | password specifica per app da appleid.apple.com |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Una build da tag firma e notarizza solo quando è presente **l'intero
insieme** — `MAC_CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` **e**
`APPLE_TEAM_ID` (oltre a `MAC_CSC_KEY_PASSWORD` per il certificato). Se
manca qualcosa, la build viene prodotta non firmata invece di far fallire
la notarizzazione più avanti, così un insieme di secret configurato solo
parzialmente non spezza la CI.

### Windows (opzionale)

| Secret | Valore |
|--------|-------|
| `WIN_CSC_LINK` | base64 del proprio `.pfx` di firma del codice |
| `WIN_CSC_KEY_PASSWORD` | password per quel `.pfx` |

Una build da tag firma quando `WIN_CSC_LINK` è presente; altrimenti non
firmata.

## Auto-aggiornamento

L'auto-aggiornamento in-app è predisposto con **electron-updater**
([`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts)).
Nelle build pacchettizzate, effettua il polling dei rilasci di questo
repository, **scarica silenziosamente** una versione più recente in
background, e mostra un toast **"Restart to install"** quando è pronta —
cliccandolo si chiude e si rilancia nella nuova versione. Legge i metadati
`latest*.yml` + `.blockmap` allegati dal workflow di rilascio; la
configurazione `publish: github` in `electron-builder.yml` incorpora
l'`app-update.yml` di cui il client ha bisogno.

**La firma è obbligatoria per il passaggio di installazione.** macOS
rifiuta gli aggiornamenti non firmati, quindi l'installazione in-app
funziona solo una volta che i rilasci sono firmati e notarizzati (il
percorso di build da tag con i secret Apple impostati). Fino ad allora —
e ogni volta che l'updater incontra un errore (metadati assenti, errore di
rete) — **ricade** su un toast manuale "Download" che apre la pagina di
rilascio, gestito dal controllo leggero di GitHub in
[`src/main/updates/check.ts`](../../src/main/updates/check.ts). Lo stesso
controllo leggero alimenta anche il "Check for updates" su richiesta della
finestra di dialogo About e funziona ovunque, incluse le build di sviluppo
e non firmate.

Perché tutto questo possa far emergere un rilascio, il workflow deve
pubblicare Release **non-draft, non-prerelease** con gli installer per
piattaforma allegati — cosa che fa. L'auto-aggiornamento è disabilitato in
sviluppo.

### Verifica dell'auto-aggiornamento (primo test end-to-end)

Il percorso di auto-aggiornamento può essere verificato solo a fronte di
**due rilasci reali firmati** — non in sviluppo (è disabilitato) e non a
fronte di un singolo rilascio (non c'è nulla di più recente da scaricare).
Farlo una sola volta, dopo che la firma è stata configurata:

1. **Confermare che la firma sia attiva.** Aggiungere i secret macOS (e
   opzionalmente Windows) dalla tabella sopra. Il primo rilascio firmato
   deve avere successo — su macOS, le build non firmate/non notarizzate
   possono essere scaricate ma **non riescono a installarsi**, quindi
   l'intero test è privo di senso se non firmato.
2. **Effettuare il rilascio N**, ad es. `npm run release` → `v0.0.18`.
   Attendere che il workflow pubblichi la Release con gli asset +
   `latest*.yml`.
3. **Installare N dalla Release pubblicata** su ogni sistema operativo
   supportato (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Avviarlo —
   verificare che Help ▸ About mostri la versione corretta.
4. **Effettuare il rilascio N+1**, ad es. `npm run release` → `v0.0.19`.
5. **Lasciare in esecuzione l'installazione N.** Entro ~30s dall'avvio (e
   poi ogni 6h) effettua un controllo; su una build firmata scarica N+1
   silenziosamente, poi mostra il toast **"Restart to install"**.
   Cliccarlo.
6. **Confermare che sia stato rilanciato in N+1** — Help ▸ About ora
   mostra la nuova versione. Questo dimostra che il percorso download →
   staging → quitAndInstall → rilancio funziona su quel sistema operativo.

Note per piattaforma:
- **macOS:** Squirrel.Mac applica l'aggiornamento a partire dall'asset
  `.zip` (non il `.dmg`); entrambi devono essere presenti nella Release.
  Gatekeeper rifiuta un aggiornamento non firmato/non notarizzato — se
  "Restart to install" non fa nulla, ricontrollare la notarizzazione sulla
  build.
- **Linux:** il `.deb` **non** si auto-aggiorna — electron-updater
  auto-aggiorna solo AppImage su Linux. Aggiornare installando il nuovo
  `.deb` (`sudo dpkg -i …` / `sudo apt install ./…`). Quindi saltare i
  passaggi di auto-aggiornamento (4–6) per Linux; installare semplicemente
  N+1 sopra N e verificare About. Per ripristinare l'auto-aggiornamento
  in-app su Linux, aggiungere di nuovo `AppImage` a `linux.target` in
  `electron-builder.yml`.
- **Windows:** l'installer NSIS aggiorna sul posto; SmartScreen potrebbe
  avvisare finché la build non viene firmata con `WIN_CSC_LINK`.

Se il passaggio 5 mostra invece un toast **"Download"** (che apre la
pagina di rilascio), l'updater in-app ha incontrato un errore ed è
ricaduto sul fallback — controllare il log diagnostico (voci
`update.error` / `update.check.failed`) per capirne il motivo, il più
delle volte una build macOS non firmata.
