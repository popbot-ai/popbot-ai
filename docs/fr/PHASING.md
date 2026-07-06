# Phasage

Feuille de route pour amener PopBot de « conception + prototype » à « outil quotidien utile ». Reflète le phasage dans [POPBOT_DESIGN.md](POPBOT_DESIGN.md#phasage) mais suit une progression concrète avec des cases à cocher.

Mettez à jour ce fichier au fur et à mesure que les éléments atterrissent. Un commit peut cocher plusieurs cases.

---

## Phase 0 — Prérequis (~3 jours)

Éléments fondamentaux dans le dépôt AutoRPG + un helper natif ici. La plupart de ces éléments bloquent les vrais tests de bout en bout mais pas l'échafaudage Electron.

### Dans `~/pop/autorpg`

- [ ] **Surcharge d'env `POPBOT_MCP_PORT`** sur le serveur MCP intégré à l'Editor (`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`). Lire le port depuis l'env, revenir à `17893` par défaut. ~5 min.
- [ ] **Indicateurs `./run_local.sh --port` + `--data-dir`.** Le serveur prend les deux comme arguments ; répertoire de données pour l'isolation de BD par slot. ~30 min.
- [ ] **Extension du endpoint `/health`** — retourne `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }`. PopBot les utilise pour la détection de dérive au moment du bail. ~30 min.

### Dans ce dépôt

- [ ] **Helper natif de déplacement de fenêtre macOS** — CLI Swift à `native/popbot-windowmover/`. Sous-commandes : `move`, `minimize`, `wait-for-window`. ~½ jour.
- [ ] **Prototype de cycle de vie de slot** — module TS autonome sous `src/main/slots/` exercé par un script sous `scripts/`. Couvre l'ajout de worktree, le COW de Library depuis master, le changement de branche avec sécurité de stash, bail/libération, réconciliation d'orphelins. ~1 jour.

---

## Phase 1 — Surface d'automatisation MCP (~3-5 jours)

Dans `~/pop/autorpg`. Construit les outils MCP intégrés à l'Editor que les agents utiliseront réellement.

- [ ] **Infrastructure de tâches** — `job_status`, `job_get_result`, `job_cancel`, `job_list`. Tous les outils de longue durée retournent `{ jobId }` immédiatement.
- [ ] **Outils de cycle de vie** — `play_status`, `play_enter` (job), `play_exit`, `play_pause/resume/step`, `time_scale_set`, `editor_quit`.
- [ ] **Outils d'observation** — `screenshot`, `game_state_summary`, `screen_stack`, `chapter_status`, `ui_tree`, `ui_query`.
- [ ] **Outils d'action** — `ui_click`, `ui_click_by_loc`.
- [ ] **Outils de synchronisation** — `wait_until` (job), `wait_for_idle` (job).
- [ ] **Outils de logs / serveur** — `console_get_logs` étendu (`sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack`), `server_logs`, `server_health`, `client_set_server_endpoint`.
- [ ] **Sessions** — `mcp_session_start`, `mcp_session_end` pour des répertoires d'artefacts prévisibles.
- [ ] **Migrer les outils longs existants** vers le modèle de tâches : `rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`.

---

## Phase 2 — MVP Electron de PopBot (~1-2 semaines)

Utilisable de bout en bout pour un seul chat. **En cours.**

- [ ] **Échafaudage Electron** — `package.json`, Vite + React + TS + Tailwind, electron-builder, ESLint + Prettier, Vitest.
- [ ] **Séparation main / preload / renderer** avec un pont IPC typé.
- [ ] **Porter les 8 JSX du prototype** vers `.tsx` sous `src/renderer/`. L'interface statique s'exécute dans la fenêtre Electron sans support fonctionnel.
- [ ] **Schéma better-sqlite3** — chats, messages, slots, préférences.
- [ ] **Une seule session ClaudeBackend** câblée dans une colonne de chat. Envoyer un message, recevoir le flux d'événements.
- [ ] **Moteur de politique `canUseTool`** — liste de refus codée en dur + autorisation par mode. Le renderer affiche les demandes de permission comme des modales.
- [ ] **Gestionnaire de slot** câblé — un seul slot, vrai worktree, vrai lancement d'Unity via le helper de la Phase 0.
- [ ] **Intégration du déplaceur de fenêtre natif** — Unity s'ouvre, le helper le place sur l'écran 2.
- [ ] **Squelette du panneau de paramètres** — mode par chat, mode serveur, échelle de temps, backend d'agent.
- [ ] **Démo de boucle de bout en bout** — ouvrir un chat → l'agent lit le code → l'agent exécute le jeu → l'agent prend des captures d'écran → l'agent rapporte.

---

## Phase 3 — Multi-chat + panneaux de file d'attention (~1-2 semaines)

Active [US-1](USER_STORIES.md#us-1--conscience-de-la-file-dattention), [US-2](USER_STORIES.md#us-2--activation-en-un-clic), [US-5](USER_STORIES.md#us-5--multitâche-facile-via-les-miniatures), [US-6](USER_STORIES.md#us-6--statut-en-un-coup-dœil).

- [ ] Plusieurs colonnes de chat ; ajout/suppression flottants.
- [ ] Bande de miniatures avec des couleurs de statut (US-5, US-6).
- [ ] **Panneau de tickets Linear** (assignés à moi, classés par priorité + date d'échéance).
- [ ] **Panneau des PRs non revues** (GraphQL `gh`).
- [ ] **Panneau Slack** — DM, @mentions, canaux possédés. Sous-système entièrement nouveau (`src/main/slack/`) ; OAuth via `keytar`. Voir [USER_STORIES.md → Déviations](USER_STORIES.md#slack-comme-troisième-source-dattention-us-1).
- [ ] **Naissance de chat en un clic** depuis n'importe quelle ligne de panneau ; chat amorcé avec le contexte de la source (US-2).
- [ ] Panneau de logs inférieur — onglets Unity + serveur, défilement synchronisé pour le chat actif.
- [ ] Bascules de mode + mode-serveur dans les paramètres du chat, avec repointage en cours de session.
- [ ] Détection de dérive sur le bail `remote-dev`.

---

## Phase 4 — Finition + avancé

- [ ] **Adaptateur de backend Codex** — `CodexBackend implements AgentBackend`, capacités signalées dans l'interface.
- [ ] **`Window Mode` headless** — opt-in après que le script de validation du batchmode prouve que cela fonctionne sur AutoRPG.
- [ ] Outils MCP **`crash_dump`, `events_pop`, `command_apply`, gestion de fixtures**.
- [ ] **Corrélation temporelle des logs côte à côte** entre les panneaux Unity et serveur.
- [ ] **Budgets d'autonomie + détection de boucle** raffinement (déclencheurs de pause token / temps / échec répété).
- [ ] **Canal de mise à jour** — auto-updater via electron-builder + builds signés.

---

## Questions ouvertes (reportées de la conception)

1. Est-ce qu'AutoRPG s'exécute réellement en mode Play `-batchmode` ? Script de validation vers la Phase 4 ; non bloquant pour la v1.
2. Cadence de rafraîchissement de la Library maîtresse — bouton manuel vs auto vs TTL de N jours ? Défaut : bouton manuel dans les préférences.
3. Nombre de slots par défaut — 4 codé en dur, ou mise à l'échelle par RAM/cœurs ? Probablement défaut 2-3, configurable.
