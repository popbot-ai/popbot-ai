# Développement

## Prérequis

- macOS (seule plateforme prise en charge pour la v1)
- Node 20 LTS ou plus récent (`.nvmrc` l'épinglera une fois l'échafaudage en place)
- pnpm (préféré) ou npm
- Xcode Command Line Tools (`xcode-select --install`) — nécessaire pour le helper Swift natif et tout build node-gyp
- Un clone de [`autorpg`](../../../autorpg) à `~/pop/autorpg` pour les tests de bout en bout

## Configuration initiale

> En attente de l'échafaudage Electron (Phase 2). Cette section se remplira une fois que `package.json` sera en place.

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## Scripts (prévus)

| Commande | Objectif |
|---|---|
| `pnpm dev` | Serveur de dev Vite + Electron main avec rechargement |
| `pnpm build` | Bundles de production renderer + main |
| `pnpm package` | electron-builder → `release/` (.dmg) |
| `pnpm typecheck` | tsc --noEmit à travers main, preload, renderer, shared |
| `pnpm lint` | Vérification ESLint + Prettier |
| `pnpm test` | Tests unitaires Vitest |

## Conventions du dépôt

- **TypeScript partout.** Pas de `.js` en dehors des fichiers de configuration. Mode strict activé.
- **Pas d'IPC brut dans les composants.** Le renderer parle au main via le pont typé `window.popbot.*` défini dans `src/preload/`.
- **Le renderer est une vue pure.** Pas de fs, pas de child_process, pas de modules node avec des liaisons natives. Si un composant a besoin de persistance ou d'un appel système, exposez-le via main + IPC.
- **Un fichier par composant React**, nommé en `PascalCase.tsx`. Les hooks vivent aux côtés du composant quand ils sont privés, ou dans `renderer/hooks/` quand ils sont partagés.
- **Tailwind d'abord, CSS cadré ensuite.** Le `design/prototype/styles.css` porté devient une couche Tailwind + un petit ensemble de propriétés personnalisées CSS pour les tokens du thème sombre (`--bg-1`, `--fg-2`, etc.).

## Travailler avec le prototype de conception

Le prototype original vit à [`../design/prototype/`](../../design/prototype/) et est une **référence figée**, pas une cible de build. Voir [`design/README.md`](../../design/README.md) pour comment le visualiser.

Lors du portage d'un composant :

1. Ouvrez le `*.jsx` correspondant à côté de votre `.tsx` pour référence visuelle.
2. Retirez les alias `useStateA`/`useEffectA` (un hack que le prototype utilisait pour éviter les collisions globales).
3. Remplacez `INITIAL_CHATS` et les autres fixtures au niveau du module par des imports depuis `renderer/fixtures/` ou, éventuellement, des appels IPC.
4. Restez proche du comportement visuel + interactif du prototype — voir [memory: stick close to the design](../../).

## Style de commit

- Commits conventionnels : `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Corps ≤ 72 colonnes. Commencez par le **pourquoi**, pas le **quoi**.
- Une PR par changement logique. Ne combinez pas échafaudage + fonctionnalités.

## Travailler avec des dépôts liés

PopBot pilote le projet Unity AutoRPG + le serveur sidecar. Plusieurs prérequis de la Phase 0 atterrissent dans ce dépôt-là, pas celui-ci :

- Surcharge d'env `POPBOT_MCP_PORT` sur le MCP intégré à l'Editor
- Indicateurs `./run_local.sh --port` et `--data-dir`
- Extensions du endpoint `/health`

Quand vous travaillez sur ces éléments, `cd ~/pop/autorpg` et suivez les conventions de ce dépôt.
