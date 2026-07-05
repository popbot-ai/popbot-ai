*Languages: [English](../POPBOT_DESIGN.md) · [Español](../es/POPBOT_DESIGN.md) · [Français](POPBOT_DESIGN.md) · [Deutsch](../de/POPBOT_DESIGN.md) · [日本語](../ja/POPBOT_DESIGN.md) · [한국어](../ko/POPBOT_DESIGN.md) · [简体中文](../zh-CN/POPBOT_DESIGN.md) · [Português (Brasil)](../pt-BR/POPBOT_DESIGN.md) · [Русский](../ru/POPBOT_DESIGN.md) · [Italiano](../it/POPBOT_DESIGN.md)*

# Conception de PopBot

Un orchestrateur de développement multi-agent pour AutoRPG. Inspiré de Conductor ; ajoute une infrastructure de test en jeu pour que les agents puissent lancer le vrai jeu, cliquer dedans, et vérifier le comportement.

> **Statut :** conception — verrouillée le 2026-05-01. Document vivant ; mettre à jour sur place au fur et à mesure des découvertes pendant l'implémentation.
>
> **Lisez ceci en premier :** [USER_STORIES.md](USER_STORIES.md) définit les six résultats que cette conception existe pour livrer. Quand ce document et les user stories sont en désaccord, les user stories gagnent et ce document est mis à jour.

## Objectifs

1. Exécuter plusieurs agents de développement IA en parallèle, chacun dans son propre worktree git.
2. Laisser les agents piloter le vrai jeu (Unity Editor en fenêtre) pour des tests de bout en bout.
3. Afficher les files d'attente de tickets / PR / Slack, l'historique des transcriptions, les logs, et les terminaux dans une seule fenêtre.
4. Par défaut sur le fonctionnement autonome ; ne mettre en pause que sur des événements véritablement bloquants.

## Non-objectifs (v1)

- CI/CD de production (préoccupations séparées)
- Multi-plateforme (macOS uniquement ; Linux/Windows plus tard si nécessaire)
- Multi-utilisateur / SSO (un développeur unique par machine)

## Disposition de l'application

```text
┌──────────────┬─────────────────────────────────────────────┐
│ Tickets │ PRs│  ┌──┐ ┌──┐ ┌──┐ ┌──┐  Thumbnails (zoom-out)│
│   ENG-...    │  └──┘ └──┘ └──┘ └──┘                       │
│   ENG-...    ├─────────────────────────────────────────────┤
│   ENG-...    │                                             │
├──────────────┤  ┌────────┐  ┌────────┐  ┌────────┐        │
│ Chats        │  │ chat-1 │  │ chat-2 │  │ chat-3 │  + new │
│   live...    │  │        │  │        │  │        │        │
│   ──────     │  │        │  │        │  │        │        │
│   inactive   │  │        │  │        │  │        │        │
│              │  └────────┘  └────────┘  └────────┘        │
├──────────────┴─────────────────────────────────────────────┤
│ Logs ▼  Terminal  ...                                      │
│ [Unity] [Server]   (active chat's streams, sync-scroll)    │
└────────────────────────────────────────────────────────────┘
```

Onglets en haut à gauche : **Tickets** (Linear qui me sont assignés) et **Reviews** (PRs demandant ma revue). Cliquez sur une ligne → faites naître un chat amorcé pour ce travail.

## Slots — l'unité durable

Un slot = un worktree git + sa Library + (optionnellement) son Unity Editor en cours d'exécution + (optionnellement) son serveur sidecar en cours d'exécution. **Les slots sont créés rarement, réutilisés continuellement.**

### Répertoire par slot

```text
~/Library/Application Support/PopBot/slots/
├── slot-1/
│   ├── worktree/                    git worktree (persistent)
│   │   ├── Library/                 ~8 GB, lives here, slot owns it
│   │   ├── Assets/                  ~5.5 GB
│   │   └── ...
│   ├── server-data/                 sidecar's DB (local mode only)
│   ├── ports.json                   { mcp: 17901, server: 5101 }
│   ├── unity.log
│   ├── server.log
│   └── slot.json                    { branch, leasedBy, lastLeaseAt, unityPid?, serverPid? }
└── slot-2/...
```

### Vrais chiffres de coût (mesurés le 2026-05-01 sur AutoRPG)

| Opération | Temps |
|---|---|
| `git worktree add` (frais, 62k fichiers, smudge LFS) | ~23 s |
| COW de la Library depuis master (APFS clonefile) | ~1 s |
| Premier lancement d'Unity sur un slot (Library à froid) | 1-3 min |
| Coup collant (Unity déjà en cours, inactif) | ~50 ms |
| Démarrage à froid (Unity éteint, branche correspondante) | 15-30 s |
| Changement de branche dans un slot existant (delta + rechargement Unity) | 5-15 s |
| Total création de slot (worktree add + COW + premier import) | ~1-3 min, **rare** |

### Budget disque

~14 Go par slot (8 Go Library + 5,5 Go Assets + scratch). 4 slots = ~55 Go. `.git` partagé (~8 Go) compté une seule fois.

### Politique de bail

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### Unicité de branche

Git refuse de faire un checkout de la même branche dans deux worktrees. Résolu par :
- Les **chats Lite / revue** utilisent une HEAD détachée (aucun conflit).
- **Deux chats de test sur la même branche** — le second utilise une branche temporaire (`<branch>-slot-N`) ou une HEAD détachée ; le planificateur de PopBot choisit automatiquement.

### Sécurité avant checkout

Avant tout changement de branche dans un slot existant :

1. `git stash --include-untracked` (toujours ; filet de sécurité).
2. Refuser s'il y a des commits non poussés que l'agent possède ; commiter d'abord ou échouer bruyamment.
3. Fermer toutes les scènes Unity ouvertes (éviter les problèmes de résolution de GUID à travers les branches).
4. `git checkout <branch>`.
5. Dépiler le stash le cas échéant, ou restaurer depuis un enregistrement de stash par branche.

### Boutons de politique par slot (dans les préférences)

- `pinnedBranch?` — refuser les baux pour d'autres branches ; slot de travail principal.
- `cleanOnRelease: bool` — `git clean -fd && git checkout .` à la libération ; désactivé par défaut.
- `autoStashOnSwitch: bool` — activé par défaut.

## Budgets de ressources (boutons indépendants)

Les slots et les instances Unity actives sont des **budgets séparés**. Un slot peut exister avec son Unity éteint — c'est juste du stockage à ce stade. Unity en cours d'exécution est lié à la RAM et ajustable indépendamment.

| Budget | Coût par unité | Défaut | Préférence utilisateur |
|---|---|---|---|
| **Nombre de slots** (worktrees sur disque) | ~14 Go | 2-4 | Préfs : « Slots » |
| **Max Unity actifs** (processus en cours d'exécution) | ~3-4 Go RAM | 2 | Préfs : « Max active Unity » |
| **Plafond Unity strict** (limite d'auto-approbation en mode autonome) | — | calculé : `floor(systemRAM / 4 GB)` | Préfs : « Unity hard cap » |

### Politique de bail (étendue)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### Montée en puissance initiée par l'agent

Nouvel outil MCP, disponible quand l'agent est bloqué sur la capacité Unity :

| Outil | Mode | Retourne |
|---|---|---|
| `request_unity_capacity` | sync | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

Comportement :

- **Chat interactif** → le chat passe au jaune, une bannière demande à l'utilisateur d'approuver.
- **Chat autonome** → auto-approuve jusqu'au `Unity hard cap` ; se met en pause pour un humain au-delà.
- L'utilisateur peut aussi monter/descendre préventivement dans les préférences à tout moment. Descendre expulse les Unity inactifs LRU (jamais ceux occupés).

## Types de chat

| Type | Slot | Library | Unity | Sidecar | Démarrage | RAM |
|---|---|---|---|---|---|---|
| **Lite** (revue, plan, triage) | optionnel | — | — | — | ~1-2 s | ~50-100 Mo |
| **Client Test** | requis | possédée par le slot | GUI sur l'écran 2 | local ou distant | 50ms-30s | ~2-4 Go |
| **Server Test** | requis | possédée par le slot | GUI sur l'écran 2 | local toujours | 50ms-35s | ~2-5 Go |

Défaut pour les nouveaux chats : **Lite**. Promouvoir quand le test de jeu est réellement nécessaire.

## Modes serveur

Paramètre par chat ; basculable à la volée.

| Mode | Source du serveur | Utiliser quand |
|---|---|---|
| `local` (défaut) | `./run_local.sh --port <P> --data-dir <D>` par slot | Exécutions d'agent quotidiennes ; changements de backend ; état déterministe |
| `remote-dev` | Serveur de dev distant partagé | Itération client pure ; la détection de dérive protège l'entrée |

### Détection de dérive

Avant qu'un bail remote-dev soit accepté : PopBot lit la constante locale `Assets/Scripts/Simulation/GameDataHash.cs` + la version des DTO ; fait un GET sur `/health` distant ; compare. Discordance → refuse le bail avec une erreur structurée.

### `/health` retourne

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### Bascule en cours de session

L'utilisateur bascule `Server Mode` dans les paramètres du chat ; PopBot :

1. Vérification de dérive (si entrée en remote-dev). Refuse en cas de discordance.
2. Arrête / démarre le processus sidecar selon les besoins.
3. `client_set_server_endpoint { url }` via MCP — repointage runtime.
4. Force une réinitialisation de session en jeu (déconnexion/titre) — l'ancienne auth est invalide.
5. Annule les tâches en vol, bannière : « le serveur a changé, redémarrez la tâche ».

## Panneau de paramètres par chat

| Paramètre | Défaut | Notes |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = auto-approuve ce qui est sûr, pause sur un vrai blocage |
| Mode serveur | `local` | `remote-dev` (vérifié par détection de dérive) |
| Mode fenêtre | `GUI on screen 2` | `Headless` (plus tard, opt-in) / `Visible` |
| Échelle de temps | `1.0` | Avance rapide des animations |
| Résolution de la vue de jeu | `1920×1080` | Épinglée pour des captures d'écran reproductibles |
| Capture d'écran automatique à chaque action | désactivé | Pour les bundles de preuve |
| Logs verbeux | désactivé | Basculer lors du débogage de l'agent lui-même |
| Backend d'agent | `claude` | `codex` (Phase 4) |
| Fixture par défaut | aucune | Démarrer avec un blob de sauvegarde |
| Budget de tokens | `1M` | Pause à l'atteinte (mode autonome) |
| Budget de temps | `60m` | Pause à l'atteinte (mode autonome) |
| Détection de boucle | activé | Pause sur N appels d'outil identiques / pas de progression pendant K min |

## Mode autonome

### Moteur de politique — branché sur `canUseTool`

N'enterrez pas la politique dans le prompt ; le modèle peut s'en convaincre de ne pas la suivre. Utilisez le hook de veto strict du SDK.

**Auto-approuvé en mode autonome (silencieux) :**

- Read / Edit / Write / Grep / Glob à l'intérieur du worktree du slot
- Bash à l'intérieur du worktree (avec la liste de refus ci-dessous)
- Appels MCP vers le propre serveur MCP du slot
- Invocations de Skill / sous-agent
- TodoWrite, opérations SDK internes

**Toujours en pause pour un humain (même autonome) :**

- `git push`, `git reset --hard`, `git checkout --`, tout ce qui est en force, suppression de branche
- Tout ce qui est en dehors du chemin de worktree du slot
- Appels réseau vers des hôtes non autorisés
- `rm -rf` en dehors de `tmp/` ou du répertoire du slot
- `gh pr create` et toute action de publication GitHub
- Slack / email / messagerie externe
- Modification de `~/.claude`, `.mcp.json`, config système

### Détection « vraiment bloqué »

**Auto-signalement de l'agent** (via la forme `message_done` du SDK) :

- Question de clarification
- Blocage explicite
- « J'ai terminé » terminal

**PopBot surveille** (défense en profondeur) :

- Boucle — N appels d'outil identiques d'affilée
- Blocage — aucun événement de progression pendant K minutes
- Budget de tokens / temps dépassé
- Échecs de test répétés (même échec K fois)

### Couleurs de statut (miniature de chat)

| Couleur | État |
|---|---|
| Bleu | En cours |
| Vert | Tâche terminée |
| Jaune | En pause — a besoin de l'utilisateur |
| Rouge | En erreur |
| Gris | Inactif / non démarré |

En mode autonome vous parcourez les miniatures à la recherche du **jaune**. Tout le reste va bien.

## Surface d'automatisation MCP

### Règle : chaque outil retourne en environ 100 ms

Les opérations longues retournent `{ jobId }` immédiatement ; l'agent interroge. Ne jamais bloquer le listener HTTP MCP pendant plus de 100 ms.

### Infrastructure de tâches

| Outil | Mode | Retourne |
|---|---|---|
| `job_status` | sync | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | sync | payload complet de l'outil ; dispose la tâche |
| `job_cancel` | sync | définit l'indicateur d'annulation coopératif |
| `job_list` | sync | actives + récentes (TTL ~60s) |

Les coroutines s'exécutent via `EditorCoroutineUtility.StartCoroutineOwnerless`, pilotées par `EditorApplication.update`. `JobContext` expose `SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)`.

### Catalogue d'outils — minimum Phase 1

**Cycle de vie :**

- `play_status` (sync), `play_pause` / `play_resume` / `play_step` (sync), `time_scale_set` (sync)
- `play_enter` (job), `play_exit` (sync)
- `editor_quit` (sync)

**Observer :**

- `screenshot` (sync) — écrit dans `Library/MCP/Screenshots/{session}/{label}.png`, retourne le chemin
- `game_state_summary` (sync) — sommet de la pile d'écrans, monnaies, niveau, chapitre, équipé, déblocages, 10 dernières erreurs
- `screen_stack` (sync), `chapter_status` (sync)
- `ui_tree` (sync) — hiérarchie avec `text-loc` résolu
- `ui_query` (sync) — sélecteurs de type CSS (`.btn`, `#Confirm`, `[text-loc=Friends.Title]`)

**Agir :**

- `ui_click` (sync), `ui_click_by_loc` (sync) — déclenche `PointerDown/Up/ClickEvent` via `panel.SendEvent`

**Synchronisation / attente :**

- `wait_until` (job) — prédicats : `screen`, `log`, `event`, `path`
- `wait_for_idle` (job)

**Logs (étendre l'existant) :**

- `console_get_logs` — ajouter `sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack: "none"|"first"|"all"`
- `server_logs` (sync) — suit le `server.log` de PopBot, même forme que `console_get_logs`
- `server_health` (sync), `client_set_server_endpoint` (sync)

**Sessions :**

- `mcp_session_start` / `mcp_session_end` — répertoires d'artefacts prévisibles à `tmp/mcp-sessions/{slug}/`

### Catalogue d'outils — phases ultérieures

- `command_apply`, `command_list` — surface d'action principale contournant l'interface
- `save_blob_get` / `save_blob_load`, gestion de fixtures
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`, `gameview_resolution_set`
- `game_state_path` — lecteur basé sur la réflexion avec racines sur liste blanche

## Gestion des fenêtres

Défaut : Editor GUI avec la fenêtre placée par un helper natif.

**Déplaceur de fenêtre natif macOS (~50 lignes Swift) :**

1. Sondage `AXUIElement` serré (50 ms) pour que le helper saisisse la fenêtre dans les ~100 ms suivant son apparition.
2. `setFrame:` vers un rectangle configuré sur l'écran 2.
3. `kAXMinimizedAttribute = true` (réduire dans le dock).
4. Ne pas voler le focus.

**Pré-définir les `EditorPrefs` pour la position de fenêtre avant le lancement.** Unity restaure la dernière position de fenêtre au démarrage, donc à partir du *second* lancement, la fenêtre s'ouvre déjà positionnée. Le premier lancement clignote brièvement (~200 ms) ; les suivants non.

**Configuration ponctuelle côté utilisateur** (documentée dans le premier lancement de PopBot) : `Dock → clic droit sur Unity → Options → Assign To: Desktop X`. macOS route automatiquement les futures fenêtres Unity vers cet Espace. Avec ceci défini, même le clignotement du premier lancement se produit sur un Espace que l'utilisateur ne regarde pas.

Position configurable par slot pour que plusieurs Unity atterrissent à des emplacements prévisibles sur l'écran 2.

**Le `Window Mode` headless** est opt-in après validation du batchmode (vers la Phase 4). Architecture identique ; seul l'indicateur de lancement change.

## Protocole de couplage Serveur / Unity

L'ordonnancement du démarrage et le cycle de vie doivent être stricts sinon vous rencontrez des échecs subtils.

### Séquence de démarrage (PopBot l'impose)

1. Lance `./run_local.sh --port S --data-dir D`. Redirige stdio vers `server.log`. Enregistre `server_pid`.
2. Interroge `/health` jusqu'à 200 (avec `commit/gameDataHash/dtoVersion`). Timeout 30 s. Échec → tue le serveur, affiche l'erreur.
3. Écrit `client-server.json` dans le worktree pointant vers `localhost:S`.
4. Lance Unity avec `POPBOT_MCP_PORT=M`. Enregistre `unity_pid`.
5. Interroge `/mcp` jusqu'à 200. Timeout 60 s. Échec → tue les deux, affiche l'erreur.
6. Le déplaceur de fenêtre natif s'exécute.
7. Le slot est en vie ; l'agent peut louer.

### Cascade de mort

- **Le serveur meurt en cours de session** → PopBot le détecte via la vivacité du PID + un 5xx de `server_health` → marque le slot comme dégradé → tente un redémarrage du serveur → si cela échoue, affiche en rouge dans le chat.
- **Unity meurt** → le serveur continue de tourner (le serveur survit aux redémarrages d'Unity ; moins coûteux). PopBot peut lancer un Unity frais contre le même serveur.
- **Libération du slot** → serveur SIGTERM (délai de grâce 5 s) → SIGKILL → appel MCP `editor_quit` d'Unity → SIGTERM (délai de grâce 5 s) → SIGKILL.

### Réconciliation au démarrage de PopBot

Scanne les fichiers slot.json ; pour tout pid enregistré, `kill -0 <pid>` ; si mort, nettoie l'état et réinitialise le slot. Hygiène standard des processus orphelins.

## Intégration d'agent

### Claude Agent SDK (v1)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = query({
  prompt,
  options: {
    cwd: slot.worktreePath,
    mcpServers: {
      'popbot-unity': { type: 'http', url: `http://localhost:${slot.mcpPort}/mcp` }
    },
    permissionMode: chat.autonomous ? 'acceptEdits' : 'default',
    canUseTool: (tool, args) => popbotPolicy.evaluate(tool, args, chat),
  }
});

for await (const event of session) {
  routeToChatUI(event);
  routeToLogBuffers(event);
  autonomyEngine.observe(event);
}
```

Ce que nous obtenons gratuitement : skills, mémoire, sous-agents, hooks, MCP, demandes de permission comme événements structurés. **Ne faites pas de scraping de sous-processus sur la CLI `claude`** — cela combat le SDK pour chaque fonctionnalité avancée.

### Interface AgentBackend (définie dès le jour 1 ; une seule implémentation en v1)

```ts
interface AgentBackend {
  spawn(opts: SpawnOpts): AgentSession;
  capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
}
interface AgentSession {
  sendUser(text: string): void;
  approve(permId: string, decision: 'allow' | 'deny'): void;
  pause(): void;
  stop(): void;
  events: AsyncIterable<AgentEvent>;
}
```

Le backend Codex (Phase 4) adapte le OpenAI Agents SDK à cette interface. Skills/mémoire non disponibles ; l'interface le signale clairement.

### Configuration MCP par chat

Chaque agent naît avec `mcpServers` injecté pour les ports de **son propre slot** — URL `popbot-unity` = `localhost:<slot.mcpPort>/mcp`. Les autres MCP (Linear, Sentry, Amplitude, BetterStack) sont hérités de `~/.claude/settings.json` ou `.mcp.json` automatiquement par le SDK.

## Stack technique

- **Electron** (Node + Chromium)
- **React + Tailwind** pour l'interface
- **xterm.js + node-pty** pour le panneau de terminal
- **better-sqlite3** pour la persistance de transcription (une ligne par événement, indexée par chat + horodatage)
- **keytar** pour les jetons OAuth / clés API / identifiants d'agent
- **API GraphQL Linear** pour le panneau de tickets
- **GraphQL `gh`** pour le panneau des PRs non revues
- **Helper Swift natif** pour le placement de fenêtre

## Phasage

### Phase 0 — Prérequis (~3 jours)

| Élément | Propriétaire | Taille |
|---|---|---|
| Surcharge d'env `POPBOT_MCP_PORT` MCP | Unity MCP | 5 min |
| Arguments `./run_local.sh --port` + `--data-dir` | serveur | 30 min |
| `/health` retourne `commit`, `gameDataHash`, `dtoVersion` | serveur | 30 min |
| Helper natif de déplacement de fenêtre macOS (Swift) | PopBot | ~½ jour |
| Prototype de cycle de vie de slot (ajout worktree, COW Library, changement de branche, sécurité du stash) | PopBot | ~1 jour |

### Phase 1 — Surface d'automatisation MCP (~3-5 jours)

Infrastructure de tâches + le catalogue d'outils Phase 1 ci-dessus. Migrer les outils longs existants (`rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`) vers le modèle de tâches.

### Phase 2 — MVP Electron de PopBot (~1-2 semaines)

Colonne de chat unique, `ClaudeBackend` uniquement, slot unique, Unity unique. Squelette du panneau de paramètres. Moteur de politique `canUseTool`. Helper natif intégré. Boucle de bout en bout : ouvrir un chat → l'agent modifie le code → l'agent exécute le jeu → l'agent vérifie via captures d'écran + logs → terminé.

### Phase 3 — Multi-chat + panneaux (~1 semaine)

Plusieurs colonnes de chat (ajout/suppression avec des +/x flottants). Bande de miniatures avec des couleurs de statut. Panneaux de tickets Linear + PRs non revues. Panneau de logs inférieur avec onglets Unity/serveur côte à côte. Bascules de mode/mode-serveur dans les paramètres du chat.

### Phase 4 — Finition + avancé

Adaptateur de backend Codex. `Window Mode` headless (après validation du batchmode). `crash_dump`, `events_pop`, `command_apply`, gestion de fixtures. Corrélation temporelle des logs côte à côte. Raffinement des budgets d'autonomie et de la détection de boucle.

## Questions ouvertes

1. **Validation du batchmode** — est-ce qu'AutoRPG s'exécute réellement en mode Play `-batchmode` ? Script de validation vers la Phase 4 ; non bloquant pour la v1.
2. **Cadence de rafraîchissement de la Library maîtresse** — bouton manuel vs auto vs TTL de N jours ? Défaut : bouton manuel dans les préférences.
3. **Nombre de slots par défaut** — 4 codé en dur, ou mise à l'échelle par RAM/cœurs ? Probablement défaut 2-3, configurable.
4. **Dépôt PopBot** — séparé de `autorpg`, ou vit dans `tools/popbot/` ? Séparé quand il se stabilise ; dans l'arbre pendant le développement précoce.

## Risques

| Risque | Mitigation |
|---|---|
| `git checkout` corrompt un slot en plein stash | Toujours stash d'abord ; vérifier propre après checkout ; refuser si sale |
| Deux instances de PopBot piétinent le même slot | Fichier de verrou par répertoire de slot ; réconciliation des orphelins au démarrage |
| Unity se bloque et le bail de slot n'est jamais libéré | Vérification de vivacité du PID + GC au démarrage de PopBot |
| Conflits de verrou LFS à travers les worktrees | Rare ; afficher clairement quand cela arrive |
| La Library du slot dérive loin de master | « Réinitialiser le slot » manuel reconstruit depuis master |
| Le disque se remplit | Afficher la taille par slot dans les préférences ; « réinitialiser » récupère l'espace |
| Dérive du backend sur remote-dev en cours de session | Revérification de `server_health` sur erreurs ; bannière + arrêt |
| Le mode autonome auto-approuve quelque chose de dangereux | Liste de refus codée en dur dans `canUseTool` ; jamais surchageable par la config du chat |

## Artefacts de preuve (livrable de débogage de l'agent)

Quand un agent termine une tâche de débogage, il écrit dans `tmp/mcp-sessions/{slug}/` :

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` suit un modèle à 6 sections (Repro / Before / Root Cause / Fix / After / Verification). La convention est documentée dans un SKILL (`agent-debug`) ; le MCP fournit seulement des chemins de session prévisibles.

## Référence rapide — ce qui a changé par rapport aux propositions antérieures

Pour quiconque lit la conversation qui a produit ce document :

- Le pool de Library / le pool de processus / le pool de worktree **se sont effondrés en un seul concept : le slot.** Le slot possède son worktree, sa Library, un Unity optionnel, un sidecar optionnel. Pas de symlinks, pas de pools séparés.
- `git worktree add` prend **~23s sur AutoRPG** (smudge LFS sur 62k fichiers), pas 1-2s. La création de slot est rare ; la réutilisation via checkout est le chemin chaud quotidien.
- **L'Editor GUI sur l'écran 2** est le défaut v1. Le batchmode headless est un opt-in Phase 4.
- Le serveur s'exécute dans l'arbre via `./run_local.sh` ; port + répertoire de données par slot pour l'isolation.
- Intégration d'agent : **Claude Agent SDK d'abord**, interface AgentBackend, Codex en Phase 4.
