# Architecture

Une carte pratique du modèle de processus Electron et de l'endroit où vit chaque sous-système. Pour le « pourquoi », voir [POPBOT_DESIGN.md](POPBOT_DESIGN.md). Pour le **graphe d'objets + cycles de vie + règles de propriété** dont dépend tout ce qui est dans ce document, voir [CORE_MODEL.md](CORE_MODEL.md) — lisez-le d'abord si quoi que ce soit ci-dessous semble non motivé.

## Modèle de processus

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                         │
│  ─ Slot / worktree lifecycle — git worktrees or shado VHDX slots,    │
│    per-SCM clone/client setup, branch/changelist switching           │
│  ─ SCM provider registry — git + perforce behind one abstraction;    │
│    callers branch on CAPABILITIES, not provider id                   │
│  ─ Agent host — Claude AND Codex backends behind AgentBackend        │
│    (one session per chat); the canUseTool policy boundary            │
│  ─ Editor launcher + per-slot MCP glue — focus/launch Unity/Unreal/  │
│    custom editors; hand the agent its slot's editor MCP HTTP URL     │
│  ─ PTY manager — a persistent terminal per chat                      │
│  ─ Persistence — better-sqlite3 (transcripts, chat/slot/repo state,  │
│    prefs, SDK + Codex session caches)                                │
│  ─ External APIs — tickets (Linear / Jira / GitHub), reviews         │
│    (GitHub PRs / Helix Swarm), Slack, Sentry                         │
└────────┬─────────────────────────────────────────────────────────────┘
         │ contextBridge (typed IPC channels, `window.popbot.*`)
┌────────▼─────────────────────────────────────────────────────────────┐
│ Renderer (Chromium + React + Tailwind)                               │
│  ─ App shell, panels, chat columns, settings sheets, modals          │
│  ─ Subscribes to agent event streams over IPC                        │
│  ─ Sends user actions (approve permission, send message, ...) back   │
│  ─ Owns nothing the main process needs to recover after a renderer   │
│    crash; renderer is a view layer                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Règle :** le renderer ne touche jamais au système de fichiers, ne lance jamais de processus enfants, ne détient jamais d'état canonique. Tout cela est le rôle du main. Le renderer s'abonne à des événements et distribue des intentions.

## Disposition des sources

```text
src/
├── main/                       # Electron main process — Node, no DOM
│   ├── index.ts                # entry; createWindow, app lifecycle, handler wiring
│   ├── ipc/                    # typed IPC handlers, one module per subsystem
│   │                           #   (agent, apps, chats, files, git, notifications,
│   │                           #    repos, reviews, sentry, settings, slack, term, tickets)
│   ├── agents/                 # AgentBackend interface + ClaudeBackend + CodexBackend
│   │                           #   + StubBackend; AgentHost, SDK/Codex session stores,
│   │                           #   CLI probes, recovery
│   ├── scm/                    # source-control provider registry + base class;
│   │                           #   gitProvider, perforceProvider, detect
│   ├── git/                    # git plumbing: worktrees, chat paths, reviews (gh PRs)
│   ├── p4/                     # Perforce: exec, client/workspace, file watcher,
│   │                           #   Swarm client + swarmReviews
│   ├── shado/                  # bundled shado VHDX CLI wrapper: base, slots, client
│   ├── tickets/                # ticket-source registry + linear/jira/github sources
│   ├── reviews/                # provider-agnostic Reviews orchestrator (groups by SCM)
│   ├── linear/                 # Linear API client
│   ├── jira/                   # Jira Cloud API client
│   ├── github/                 # GitHub (`gh` CLI) client
│   ├── slack/                  # Slack client + DM/@mention/channel poller
│   ├── sentry/                 # Sentry client + issue poller
│   ├── notifications/          # in-app notification classify + dispatch
│   ├── term/                   # per-chat PTY manager (node-pty)
│   ├── attachments/            # chat attachment (image/file) retention store
│   ├── persistence/            # better-sqlite3 schema (migrations) + typed queries
│   └── updates/                # electron-updater auto-update + on-demand check
├── preload/
│   └── index.ts                # contextBridge — exposes the typed `window.popbot` API
├── renderer/src/               # React UI
│   ├── main.tsx                # ReactDOM.createRoot mount
│   ├── App.tsx
│   ├── components/             # FLAT dir — panels (PanelA/B/D), chat column, dialogs,
│   │                           #   sheets, git/P4 panels, modals, primitives
│   ├── lib/                    # client-side hooks + buses (useChats, useReviews,
│   │                           #   agentEventBus, …); calls `window.popbot.*`, no Node
│   ├── styles/                 # Tailwind layer + ported styles
│   ├── assets/                 # engine / SCM / notification icons
│   └── fixtures/               # static sample data for dev
└── shared/                     # types/contracts shared across the bridge
    ├── ipc.ts                  # IPC channel names, payload types, the PopBotApi surface
    ├── domain.ts               # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## Contrat IPC

Tout l'IPC est typé et centralisé dans [`src/shared/ipc.ts`](../../src/shared/ipc.ts) — la table `IpcChannel`, les types de payload requête/réponse, et la surface `PopBotApi` que le pont preload expose. Conventions :

- **Préfixe `pb:`** sur chaque nom de canal, cadré par sous-système (`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). Voir la constante `IpcChannel` pour la liste complète.
- **Requête/réponse** utilise `ipcRenderer.invoke` + `ipcMain.handle`. Les retours sont typés. Les handlers sont enregistrés par sous-système depuis `main/ipc/*` et câblés dans `main/index.ts`.
- **Événements poussés** (flux d'agent, données PTY, notifications, progression de mise à jour, maximisation de fenêtre) utilisent `webContents.send` + `ipcRenderer.on`. Le renderer s'abonne ; le main pousse.
- **Pas d'IPC brut dans les composants.** Le script preload (`src/preload/index.ts`) expose le pont typé `window.popbot.*` ; le code du renderer passe par les hooks/buses dans `renderer/src/lib/` (`useChats`, `useReviews`, `agentEventBus`, …) plutôt que d'appeler `ipcRenderer` directement.

## Le slot, en termes de code

Un slot n'est pas une seule struct ; c'est un **bail numéroté** (`slot_id`) plus le
worktree/clone sur disque vers lequel ce bail pointe. L'état du bail vit sur la ligne
du chat (`chats.slot_id`, `chats.worktree_path` dans `persistence/`), et le calcul des
slots libres est une requête sur les chats ouverts détenant un slot pour le dépôt — la
taille du pool d'un dépôt est `repos.slot_count`. `shared/domain.ts` porte le petit enum
partagé plus un enregistrement `Slot` hérité :

```ts
export type SlotState = 'free' | 'leased' | 'degraded' | 'creating';

// NOTE: this `Slot` interface is currently unused by the running code
// (only SlotState + ChatStatus are imported). It still names Unity
// specifically; the live model has generalized past that — the editor is
// engine-agnostic (Unity/Unreal/custom) and isn't a supervised child with a
// tracked pid, so treat this shape as legacy, not authoritative.
export interface Slot {
  id: number;
  worktreePath: string;
  branch: string | null;
  ports: { mcp: number; server: number };
  unityPid: number | null;
  serverPid: number | null;
  state: SlotState;
  pinnedBranch?: string;
  cleanOnRelease?: boolean;
}
```

L'acquisition / la libération / la réconciliation de slot est répartie entre `git/worktrees.ts` (worktrees
git), `shado/slots.ts` + `scm/*Provider.ts` (slots VHDX + configuration clone/client par SCM),
et les handlers `ipc/repos.ts` + `ipc/chats.ts`. Voir
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--lunité-durable) pour la politique de
bail, et **Continuité inter-slots** ci-dessous pour la façon dont le travail d'un chat le
suit à travers les slots.

## Stockage de slots préchauffés : shado VHDX copy-on-write

Pour des arbres à l'échelle AAA (dépôts de jeu Perforce de 0,5–1 To), un slot ne peut pas être un
`git worktree` ou un checkout complet — vous ne pouvez pas copier le dépôt N fois, et une
synchro+build à froid prend des minutes à des heures. **shado** (CLI Go embarquée, dépôt frère
`github.com/popbot-ai/shado`, invoquée via `main/shado/`) fournit le substrat de stockage
sur Windows :

- **Saturer + figer une base.** `shado create <repoPath>` synchronise/copie le dossier
  du dépôt dans un VHDX extensible, puis le fige en **lecture seule**. La base contient
  l'arbre complet *plus* l'état dérivé chaud (caches de build, `node_modules`,
  `Intermediate/`, `Saved/`, `DerivedDataCache/`, …).
- **Les enfants différenciés = les slots.** Chaque slot est un enfant VHDX en copy-on-write
  hors de la base figée (`shado clone create --slot N`), monté via `Mount-VHD` +
  `Add-PartitionAccessPath` sur un **dossier point de montage** (pas une lettre de lecteur, pour que
  nous passions à l'échelle au-delà d'environ 20 slots). Un slot frais et prêt pour le build coûte des secondes et
  quelques Go de delta au lieu d'une resynchro de 1 To + un build à froid. Réinitialiser = détruire l'enfant +
  recréer depuis la base (propre instantané).
- **Disposition.** Les slots vivent sur le **même lecteur que le dépôt** (le modèle VHDX
  l'exige) : `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N` ;
  la base + les diffs + les métadonnées de slot sous `…/workspaces/<repoId>/shado`
  (`SHADO_HOME`). Les chemins sont dérivés dans `main/shado/client.ts`
  (`popbotRootForRepo`, `shadoHomeForRepo`).
- **Élévation.** `shado create` / `clone create` / `remount` / `restore` nécessitent des
  droits admin ; PopBot s'exécute sans élévation, donc ils sont lancés à travers un seul UAC
  (`.bat` temporaire + `Start-Process -Verb RunAs`). Les clones créés en élévation finissent
  possédés par le groupe Administrateurs → git obtient `-c safe.directory=*` par
  invocation, et les clients p4 sont verrouillés à l'hôte.
- **Redémarrage.** Les montages VHDX ne survivent pas à un redémarrage (clones détachés + dossiers
  reparse de point de montage cassés). Au lancement, nous détectons les dépôts de slot déconnectés et
  affichons une **modale centrale** (« Reconnecter ») sur laquelle l'utilisateur clique — un seul UAC remonte
  tous ces slots (`remountReposElevated`). Voir `main/shado/base.ts`.

Le chemin git-worktree (`repo.mode = 'slots'` sur un dépôt non-shado) existe toujours
pour les dépôts ordinaires ; shado est sélectionné par dépôt pour le cas VHDX/Perforce.

### Configuration de slot par SCM

Un slot est un **clone/client indépendant**, pas un checkout partagé — c'est le
fait clé derrière la continuité inter-slots ci-dessous.

- **git** (`scm/gitProvider.ts`) : le slot est un clone complet de la base figée.
  `ensureSlotWorktree` le gare sur `popbot/slot-N` ; `checkoutBranch` crée la
  branche du chat depuis la base **la plus récente** (`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`), en écartant la saleté de base héritée tout en gardant
  les caches chauds ignorés par git.
- **perforce** (`p4/*`, `scm/perforceProvider.ts`) : chaque slot a son propre client p4
  `popbot_<repoId>_slot<N>` enraciné sur le point de montage. La configuration est `p4 flush
  @baseChangelist` (mise à jour de have-table à 0 octet contre la base figée) + `p4 sync`
  uniquement du delta base→head. Il n'y a **pas de `p4 reconcile`** (une marche d'arbre de 20 minutes
  sur un dépôt de jeu) : un `fs.watch` par slot enregistre les chemins modifiés et le
  fournisseur ouvre seulement ceux-ci avec des `p4 edit/add/delete` ciblés. Les propres
  écritures de PopBot (sync/revert/unshelve) **mettent en pause** le watcher afin qu'elles ne soient pas rouvertes.

## Continuité inter-slots : le foyer de branche / changelist d'un chat

**Problème.** Parce que chaque slot est un clone (git) / client (perforce) indépendant,
la branche ou la changelist en attente d'un chat vit **uniquement dans le slot où elle
a été créée**. Les chats empruntent des slots à un pool partagé et peuvent rouvrir sur un
slot *différent* — où ce travail n'existerait pas. (L'ancien modèle `git worktree`
n'avait pas ce problème : tous les worktrees partageaient un seul `.git`, donc les branches étaient centrales.)

**Solution.** Consolider le travail d'un chat vers un **foyer** indépendant du slot à la
fermeture et le restaurer à la réouverture. Accroché via `SourceControlProvider.persistChatOnClose`
/ `restoreChatOnReopen`, appelé depuis les handlers `ChatsClose` / `ChatsReopen`
(`ipc/chats.ts`), remplaçant l'ancien stash local au slot. État persisté sur le
chat : `chats.p4_shelf_cl` (perforce ; git n'a besoin d'aucun).

- **git → le DÉPÔT RACINE LOCAL.** Le foyer est `repo.repoPath` — le dossier de dépôt
  sur disque duquel chaque slot a été cloné — ajouté à chaque slot en tant que remote
  `root` (`origin` reste le vrai remote GitHub, pour les PRs).
  - *Fermeture :* portez le travail non commité comme un commit jetable
    `[Soft committed unstaged files]` (sauf si l'utilisateur l'a écarté), puis `git push -f root <branch>`.
    La racine locale accumule la branche de chaque chat (sa liste de branches = l'ancien
    comportement de worktree partagé).
  - *Réouverture :* après le checkout de base, `git fetch root <branch>` → `checkout -f
    -B branch FETCH_HEAD` → annulation douce du commit WIP pour que les modifications reviennent non commitées.
- **perforce → le CLIENT RACINE comme une étagère.** Une changelist en attente est par slot,
  donc le foyer est une **étagère (shelf)** côté serveur détenue par un client stable, jamais
  synchronisé, par dépôt `popbot_<repoId>_root` (`ensureRootClient` — spec uniquement, pas de sync).
  - *Fermeture :* `p4 shelve` la CL du slot, puis `p4 reshelve -f` la vers la CL détenue par
    la racine du chat. **`reshelve` déplace le contenu mis en étagère côté serveur** — vérifié sur
    Helix 2025.2 : cross-client, aucune synchro d'espace de travail, rien écrit sur le disque
    de la racine (« déplacer les étagères, ne pas modifier les fichiers »). Puis supprimez l'étagère
    du slot + les fichiers ouverts + la CL, de sorte que le slot se retrouve **vide** ; le client racine
    détient une CL en étagère par chat.
  - *Réouverture :* `p4 unshelve -s <rootCl> -c <newSlotCl>` dans la CL fraîche du nouveau slot
    (watcher en pause), en gardant l'étagère racine comme sauvegarde garée.

Net : les slots sont un espace de travail interchangeable ; le dépôt git racine local et le
client p4 racine sont les foyers durables et visibles par l'utilisateur pour le travail en cours.

## Backend d'agent

`AgentBackend` (`main/agents/types.ts`) est l'interface entre `AgentHost` et
un backend concret. **Deux backends réels sont livrés aujourd'hui** — `ClaudeBackend` (enveloppe
`@anthropic-ai/claude-agent-sdk`) et `CodexBackend` (enveloppe `@openai/codex-sdk`)
— plus un `StubBackend` pour les tests. Un chat choisit son backend (`chats.agent`) et
peut changer ; parce que les deux SDK ont des poignées de reprise natives, des réglages de modèle et
d'effort différents, ceux-ci sont persistés **au niveau du fournisseur** (le `session_id` de Claude +
`claude_model`/`claude_reasoning_effort` ; le `codex_thread_id` de Codex +
`codex_model`/`codex_reasoning_effort`). `AgentHost` sélectionne le backend, lance
une session par chat, et rediffuse les `AgentEvent`s de chaque session
au renderer + à la persistance.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

Le MCP d'éditeur par slot est remis au backend au lancement : `SpawnOpts.mcpServers`
porte le point de terminaison de l'éditeur Unity/Unreal du chat (`{ type: 'http', url }`),
enregistré en mémoire dans les options du SDK — rien écrit sur disque. Seul le
backend compatible `mcpHttp` le consomme. Voir **MCP d'éditeur par slot** ci-dessous.

Le callback `canUseTool` vit à côté du backend, pas dans le prompt de l'agent — c'est notre frontière de sécurité de veto strict. La résolution de règle (`resolveRule`) consulte les règles de permission par chat puis globales avant d'inviter. Voir [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md).

## Persistance

- **`better-sqlite3`** à `<userData>/popbot.db` (macOS : `~/Library/Application
  Support/PopBot/` ; équivalent par OS via `app.getPath('userData')` sur Windows /
  Linux). Le schéma est une liste de migrations numérotée dans `persistence/db.ts`
  (cadenassée par `user_version`, chaque étape atomique). Tables actuelles :
  - `chats` — une ligne par chat : bail de slot (`slot_id`), `worktree_path`, `repo_id`,
    `agent` actif, modèle/effort par fournisseur + poignées de reprise (`session_id`,
    `codex_thread_id`), `permission_rules`, et état inter-slots (`p4_shelf_cl`).
  - `messages` — une ligne par événement d'agent (la transcription durable).
  - `repos` — configuration par dépôt (chemin, couleur, préfixe de slot, base par défaut,
    nombre de slots, `mode` = `slots`/`ephemeral`, `scm`, `p4_config` JSON).
  - `settings` — préférences d'application en clé/valeur JSON (références d'identifiants
    d'intégration, préférences d'interface).
  - `notifications` — le flux de notification intégré à l'application.
  - `sdk_session_entries` — table de sauvegarde du SessionStore du SDK Claude (indexée par
    chat ; PopBot possède la copie de récupération pour que la reprise ne dépende pas des
    JSONL de `~/.claude`).
  - `codex_thread_events` — cache durable des événements de flux Codex bruts (Codex reprend
    depuis `~/.codex/sessions` ; ceci est la propre copie de récupération/diagnostic de PopBot).

  Il n'y a **pas** de *table* de cache ticket/PR : les files d'attente Tickets et Revues
  mettent en cache dans le renderer (voir les commentaires IPC `list-recent`), pas dans SQLite.
- **La zone de travail par slot** vit dans le worktree/point de montage du slot et les
  répertoires runtime par chat (fichiers de session CLI d'agent, PTY, pièces jointes conservées).
  Les slots VHDX shado vivent sur le lecteur du dépôt sous
  `…/popbot/workspaces/<repoId>/…` (voir la section shado).
- **Secrets** via `keytar` (trousseau OS — macOS Keychain / Windows Credential
  Vault / libsecret). Jamais dans la base SQLite, jamais dans les logs.

## Sources de tickets, fournisseurs SCM, revues, éditeurs, mises à jour

Cinq points de rupture de fournisseur dont dépendent les sous-systèmes de haut niveau — tous
conçus pour qu'ajouter un backend soit local, et que les appelants restent génériques :

- **Sources de tickets** (`tickets/`). Une seule `TicketSource` active alimente la file
  d'attente Tickets, choisie par le paramètre `ticketSource` via `tickets/registry.ts` (Linear /
  Jira / GitHub ; par défaut Linear). Chaque source normalise vers les DTO Linear partagés, de
  sorte que le renderer rende tous les trackers via un seul chemin et se branche uniquement sur
  les capacités dans `shared/ticketProvider.ts`, jamais sur l'id du fournisseur. Ajouter un
  tracker, c'est une ligne dans le registre + un `*Source.ts` + un descripteur.
- **Fournisseurs SCM** (`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`
  est la petite surface commune (cycle de vie de l'espace de travail, revue de l'arbre de travail,
  détection de PR/revue, continuité inter-slots). `GitProvider` et `PerforceProvider` sont réels ;
  `lore` est ébauché. `scm/index.ts` retourne une instance par id. **Les appelants se branchent
  sur les CAPACITÉS (`shared/sourceControl.ts`), jamais sur l'id du fournisseur** — tout
  ce qui ne s'abstrait pas proprement est un indicateur de capacité, et un fournisseur trop
  divergent opte pour sa propre fenêtre client via `capabilities.nativeClientUi`.
- **Revues** (`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`). Un
  orchestrateur agnostique au fournisseur regroupe les dépôts configurés par SCM et distribue à
  chaque méthode de revue du fournisseur (conditionné par `capabilities.pullRequests`), fusionnant
  les PRs GitHub et les revues Helix Swarm dans un seul panneau. Chaque fournisseur possède sa
  propre **cadence d'interrogation** (`reviewPollIntervalMs` — Swarm plus lent que GitHub pour protéger
  un p4d partagé), et le panneau exécute un minuteur par fournisseur (`pb:reviews:providers` /
  `pb:reviews:list-for`).
- **MCP d'éditeur par slot** (`ipc/apps.ts`, `shared/gameEngine.ts`). Les moteurs
  (Unity / Unreal / personnalisé) sont activables indépendamment. Quand `useMcp` est activé, l'éditeur de
  chaque slot est lancé avec un **port MCP par slot** (`mcpBasePort + (slotId-1)`)
  de sorte que les éditeurs parallèles n'entrent pas en collision, et `mcpEndpointForChat` remet à
  l'agent l'URL HTTP du MCP d'éditeur de ce slot au lancement. Les éditeurs sont lancés **détachés**
  (focus-ou-lancement), pas des enfants supervisés de longue durée.
- **Mises à jour** (`updates/`). electron-updater avec mise à jour automatique et un repli
  de téléchargement manuel pour les builds non signés, plus une vérification à la demande pour la
  boîte de dialogue À propos (`pb:updates:*`).

## Transversal

- **Journalisation** — le main écrit des logs de diagnostic via `diagLog` (`dlog`) ; la CLI d'agent
  et le PTY portent leur propre sortie runtime par chat ; les logs du renderer passent par le main
  via IPC.
- **Récupération au démarrage** — la récupération est pilotée par la BD et la session, pas par un
  fichier PID (séquence de démarrage de `main/index.ts`) : `initDb()` exécute les migrations en
  attente ; `clearStaleRunningStatuses()` fait basculer tout chat resté en `run` vers `idle` (la
  session d'agent d'une exécution précédente a disparu) ; l'import du magasin de sessions + la
  migration du répertoire de projet SDK + `sessionPinRepair` + `recoverChatSessions` réconcilient
  les sessions Claude/Codex épinglées avec ce qui est réellement sur disque ; les sondes CLI
  rapportent quels backends sont en ligne. Sur Windows, les slots VHDX shado déconnectés (un
  redémarrage a fait tomber leurs montages) sont détectés et signalés pour un remontage à un seul
  UAC (voir la note **Redémarrage** de shado ci-dessus).
- **Mises à jour** — mise à jour automatique via electron-updater ; voir le fournisseur
  **Mises à jour** ci-dessus.
