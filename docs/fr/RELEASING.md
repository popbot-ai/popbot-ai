# Publier PopBot

Les releases sont construites par GitHub Actions sur **macOS, Windows et
Linux**, puis publiées sur **Cloudflare R2** (`download.popbot.app`) — *pas*
dans une GitHub Release. Chaque plateforme est construite sur son propre
runner — les modules natifs
(`better-sqlite3`, `node-pty`) doivent être compilés selon l'ABI d'Electron
propre à chaque OS, donc la compilation croisée n'est pas une option.

## Avant de publier : mettre à jour les notes de version

Trois endroits portent le texte « nouveautés » visible par l'utilisateur, et
tous les trois sont **rédigés à la main** — rien ne les génère. Mettez-les à
jour dans la même PR que la fonctionnalité, pour qu'une version ne sorte
jamais en décrivant la précédente :

1. **Popup What's New dans l'app** — `whatsNew.f1.*` / `whatsNew.f2.*` dans
   `src/shared/i18n/messages/*.ts`. **Les 12 langues.** Affichée une fois par
   version au premier lancement après une mise à jour.
2. **Bandeau hero du site** — les deux lignes `whatsnew.f*` de
   `site/index.html` **et** leurs traductions dans `site/i18n.js`.
   **Les 12 langues.**
3. **Tableau `## Recent releases` en haut de `README.md`** — ajoutez la
   nouvelle version et retirez la plus ancienne, en gardant trois lignes.
   **Uniquement le README anglais** : les copies traduites dans
   `docs/<locale>/README.md` ne portent délibérément pas ce tableau, pour
   qu'il ne devienne pas obsolète dans 11 autres langues.

Limitez 1 et 2 à une ou deux fonctionnalités phares. Signalez tout ce qui
change le comportement des conversations existantes (par ex. un modèle retiré
qui bascule automatiquement) : les utilisateurs le remarquent de toute façon.

Les bêtas sont à part : les puces du bandeau bêta viennent de
`beta-highlights.json`, que `scripts/gen-manifest.mjs` intègre au manifeste
de téléchargement.

## Faire une release

Les releases se font **entièrement depuis GitHub Actions** — il n'y a plus
d'étape locale (`npm run release` n'est qu'un stub qui renvoie ici).

GitHub → **Actions** → **Release** → **Run workflow** :

- **bump** : `patch` | `minor` | `major`
- **channel** : `prerelease` (build de test dans `beta/` ; signé uniquement si les
  secrets de signature sont configurés — une prerelease non signée est permise) |
  `release` (publier dans `stable/` comme « latest » ; macOS **doit** être signé +
  notarisé, sinon le job échoue)

La prochaine version est calculée à partir du dernier tag `v*` final (les tags
contenant `-` sont ignorés), incrémenté selon **bump**. Une `prerelease` reçoit
en plus le suffixe `-rc.<run_number>` et atterrit dans `beta/` ; une `release`
atterrit dans `stable/`.

**Les tags Git font foi pour la version.** Le workflow base la version suivante
sur le dernier tag final ; il ne se rabat sur `package.json` que si aucun tag
`v*` final n'existe encore (c.-à-d. la toute première release). Il ne commit
jamais de version : il applique celle calculée au moment du build avec
`npm version --no-git-tag-version`. Gardez tout de même la version de
`package.json` à jour (incrémentez-la dans la PR de release) pour que le dépôt
et les builds de dev locaux n'affichent pas un numéro obsolète.

## Ce qui est produit

| Plateforme | Artefacts |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | Installeur NSIS `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (pas de mise à jour automatique — voir la note Linux ci-dessous) |

Les fichiers `latest*.yml` + `.blockmap` sont des métadonnées
electron-updater (générées par la config
[`electron-builder.yml`](../../electron-builder.yml) `publish: generic`).
L'auto-updater intégré à l'application les consomme pour détecter,
télécharger et préparer les mises à jour — voir la section Auto-update
ci-dessous.

Workflow : [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Déclencheurs CI

- **Push de tag `v*`** → construit toutes les plateformes (signé si les
  secrets sont configurés) + téléverse vers `…/<channel>/<version>/` puis promeut le feed du canal.
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
Dans les builds packagés, elle interroge le feed R2 du canal
(`download.popbot.app/<channel>/`),
**télécharge silencieusement** une version plus récente en arrière-plan, et
affiche un toast **« Redémarrer pour installer »** une fois préparée — cliquer
dessus quitte et relance l'application dans la nouvelle version. Elle lit
les métadonnées `latest*.yml` + `.blockmap` que le workflow de release
joint ; la config `publish: generic` dans `electron-builder.yml` intègre le
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

Pour que tout ceci fasse surface une release, le workflow doit promouvoir le
feed du canal sur `download.popbot.app/<channel>/` — ce qu'il fait.
L'auto-update est désactivé en dev.

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
2. **Faites la release N** — Actions → Release → bump `patch`, channel
   `release` (par ex. → `v0.1.2`). Attendez que le workflow publie la
   que `download.popbot.app/stable/<version>/` contient les installeurs et que la
   racine du canal `download.popbot.app/stable/` a le `latest*.yml` promu.
3. **Installez N depuis la Release publiée** sur chaque OS que vous
   supportez (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Lancez-la —
   vérifiez que Help ▸ About affiche la bonne version.
4. **Faites la release N+1** de la même façon (par ex. → `v0.1.3`).
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
