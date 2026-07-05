*Languages: [English](../RELEASING.md) · [Español](../es/RELEASING.md) · [Français](RELEASING.md) · [Deutsch](../de/RELEASING.md) · [日本語](../ja/RELEASING.md) · [한국어](../ko/RELEASING.md) · [简体中文](../zh-CN/RELEASING.md) · [Português (Brasil)](../pt-BR/RELEASING.md) · [Русский](../ru/RELEASING.md) · [Italiano](../it/RELEASING.md)*

# Publier PopBot

Les releases sont construites par GitHub Actions sur **macOS, Windows et
Linux**, puis publiées dans une GitHub Release de ce repo. Chaque plateforme
est construite sur son propre runner — les modules natifs
(`better-sqlite3`, `node-pty`) doivent être compilés selon l'ABI d'Electron
propre à chaque OS, donc la compilation croisée n'est pas une option.

## Faire une release

Depuis un arbre de travail propre sur `main` :

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh` incrémente la version, commit, crée un tag annoté
`vX.Y.Z`, et pousse les deux. Le tag poussé déclenche le workflow **Build**,
qui construit les trois plateformes et publie la GitHub Release avec les
artefacts joints. Suivez-le avec `gh run watch` ou l'onglet Actions.

La prochaine version est calculée à partir du dernier tag `v*`, incrémenté
selon l'argument ci-dessus. Avant qu'un tag n'existe, elle se rabat sur la
version de `package.json` (donc la première release est le bump suivant
au-dessus de celle-ci). Le script refuse de s'exécuter depuis une branche
autre que `main` (à surcharger avec `RELEASE_BRANCH=<name>`).

## Ce qui est produit

| Plateforme | Artefacts |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | Installeur NSIS `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (pas de mise à jour automatique — voir la note Linux ci-dessous) |

Les fichiers `latest*.yml` + `.blockmap` sont des métadonnées
electron-updater (générées par la config
[`electron-builder.yml`](../../electron-builder.yml) `publish: github`).
L'auto-updater intégré à l'application les consomme pour détecter,
télécharger et préparer les mises à jour — voir la section Auto-update
ci-dessous.

Workflow : [`.github/workflows/build.yml`](../../.github/workflows/build.yml).

## Déclencheurs CI

- **Push de tag `v*`** → construit toutes les plateformes (signé si les
  secrets sont configurés) + publie une GitHub Release.
- **Pull request vers `main`** (non-docs) → build de validation uniquement,
  **toujours non signé** ; les artefacts sont joints au run, rien n'est
  publié, aucun secret n'est utilisé.
- **Manuel** → « Run workflow » (workflow_dispatch), non signé.

La signature ne s'exécute jamais que sur un push de tag `v*`, que seul le
propriétaire du repo peut faire. GitHub n'expose jamais les secrets aux runs
de PR déclenchés depuis un fork, donc les PR de contributeurs ne peuvent pas
accéder aux certificats de signature.

## Signature de code

La signature est pilotée par des **secrets GitHub Actions** (Settings →
Secrets and variables → Actions). Ils sont chiffrés, jamais dans l'arbre
git, et masqués dans les logs. Sans aucun secret configuré, les builds de
tag produisent des binaires non signés (macOS Gatekeeper / Windows
SmartScreen avertissent au premier lancement) et la CI passe quand même.

### macOS (signature + notarisation)

| Secret | Valeur |
|--------|-------|
| `MAC_CSC_LINK` | base64 de votre `.p12` « Developer ID Application » (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | mot de passe pour ce `.p12` |
| `APPLE_ID` | email Apple ID utilisé pour la notarisation |
| `APPLE_APP_SPECIFIC_PASSWORD` | mot de passe spécifique à l'application depuis appleid.apple.com |
| `APPLE_TEAM_ID` | ID d'équipe Apple Developer |

Un build de tag signe + notarise uniquement quand **l'ensemble complet**
est présent — `MAC_CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
**et** `APPLE_TEAM_ID` (plus `MAC_CSC_KEY_PASSWORD` pour le certificat). Si
l'un d'eux est manquant, il construit un binaire non signé plutôt que
d'échouer tardivement sur la notarisation, de sorte qu'un ensemble de
secrets partiellement configuré ne casse pas la CI.

### Windows (optionnel)

| Secret | Valeur |
|--------|-------|
| `WIN_CSC_LINK` | base64 de votre `.pfx` de signature de code |
| `WIN_CSC_KEY_PASSWORD` | mot de passe pour ce `.pfx` |

Un build de tag signe quand `WIN_CSC_LINK` est présent ; sinon non signé.

## Auto-update

La mise à jour automatique intégrée à l'application repose sur
**electron-updater**
([`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts)).
Dans les builds packagés, elle interroge les releases de ce repo,
**télécharge silencieusement** une version plus récente en arrière-plan, et
affiche un toast **« Redémarrer pour installer »** une fois préparée — cliquer
dessus quitte et relance l'application dans la nouvelle version. Elle lit
les métadonnées `latest*.yml` + `.blockmap` que le workflow de release
joint ; la config `publish: github` dans `electron-builder.yml` intègre le
`app-update.yml` dont le client a besoin.

**La signature est requise pour l'étape d'installation.** macOS rejette les
mises à jour non signées, donc l'installation intégrée à l'application ne
fonctionne qu'une fois les releases signées + notarisées (le chemin de
build de tag avec les secrets Apple configurés). Jusque-là — et chaque fois
que l'updater rencontre une erreur (pas de métadonnées, échec réseau) — il
**se rabat** sur un toast manuel « Télécharger » qui ouvre la page de release,
piloté par la vérification GitHub légère dans
[`src/main/updates/check.ts`](../../src/main/updates/check.ts). Cette même
vérification légère alimente aussi le « Vérifier les mises à jour » à la demande de
la boîte de dialogue À propos, et fonctionne partout, y compris en dev et
sur les builds non signés.

Pour que tout ceci fasse surface une release, le workflow doit publier des
Releases **non-draft, non-prerelease** avec les installateurs de plateforme
joints — ce qu'il fait. L'auto-update est désactivé en dev.

### Vérifier l'auto-update (premier test de bout en bout)

Le chemin d'auto-update ne peut être vérifié qu'avec **deux releases
signées réelles** — pas en dev (c'est désactivé) et pas avec une seule
release (il n'y a rien de plus récent à récupérer). Faites ceci une fois,
après la mise en place de la signature :

1. **Confirmez que la signature est active.** Ajoutez les secrets macOS (et
   éventuellement Windows) du tableau ci-dessus. La première release signée
   doit réussir — sur macOS, les builds non signés/non notarisés peuvent se
   télécharger mais **échouent à l'installation**, donc tout ce test est
   sans objet si non signé.
2. **Faites la release N**, par ex. `npm run release` → `v0.0.18`.
   Attendez que le workflow publie la Release avec les assets +
   `latest*.yml`.
3. **Installez N depuis la Release publiée** sur chaque OS que vous
   supportez (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Lancez-la —
   vérifiez que Help ▸ About affiche la bonne version.
4. **Faites la release N+1**, par ex. `npm run release` → `v0.0.19`.
5. **Laissez tourner l'installation N.** Dans les ~30s suivant le
   lancement (puis toutes les 6h), elle vérifie ; sur un build signé, elle
   télécharge N+1 silencieusement, puis affiche le toast **« Redémarrer
   pour installer »**. Cliquez dessus.
6. **Confirmez qu'elle a relancé en N+1** — Help ▸ About affiche maintenant
   la nouvelle version. Cela prouve que le chemin
   download → stage → quitAndInstall → relaunch fonctionne sur cet OS.

Notes par plateforme :
- **macOS :** Squirrel.Mac applique la mise à jour depuis l'asset `.zip`
  (pas le `.dmg`) ; les deux doivent être dans la Release. Gatekeeper
  rejette une mise à jour non signée/non notarisée — si « Redémarrer pour
  installer » ne fait rien, revérifiez la notarisation du build.
- **Linux :** le `.deb` ne se **met pas à jour** lui-même — electron-updater
  ne fait de l'auto-update que pour AppImage sur Linux. Mettez à jour en
  installant le nouveau `.deb` (`sudo dpkg -i …` / `sudo apt install ./…`).
  Sautez donc les étapes d'auto-update (4–6) pour Linux ; installez
  simplement N+1 par-dessus N et vérifiez About. Pour restaurer l'auto-update
  intégré sur Linux, rajoutez `AppImage` à `linux.target` dans
  `electron-builder.yml`.
- **Windows :** l'installation NSIS se met à jour sur place ; SmartScreen
  peut avertir tant que le build n'est pas signé avec `WIN_CSC_LINK`.

Si l'étape 5 affiche plutôt un toast **« Télécharger »** (ouvrant la page de
release), l'updater intégré a rencontré une erreur et s'est rabattu —
vérifiez le log de diagnostic (entrées `update.error` /
`update.check.failed`) pour comprendre pourquoi, le plus souvent un build
macOS non signé.
