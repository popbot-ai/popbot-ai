# Core Model

Le graphe d'objets autour duquel l'application de PopBot est construite. Tout le
reste — IPC, persistance, panneaux d'interface, boucle d'agent — dépend de cela. Si vous changez un
comportement d'une manière qui viole une règle ici, **soit mettez à jour le modèle
d'abord, soit dites à l'utilisateur que le modèle change.**

Pour « où vit le code ? » voir [ARCHITECTURE.md](ARCHITECTURE.md).
Pour « que voit l'utilisateur ? » voir [USER_STORIES.md](USER_STORIES.md).

---

## TL;DR — les quatre noms qui comptent

| Nom | Durable ? | Propriétaire | Durée de vie |
|---|---|---|---|
| **Chat** | oui (SQLite) | main | créé par l'utilisateur, vit jusqu'à suppression explicite |
| **Message** | oui (SQLite, quasi-append-only) | main | enfant d'un Chat |
| **Slot** | oui (système de fichiers + ligne SQLite) | main / `SlotManager` | créé rarement, réutilisé ; jamais par chat |
| **AgentSession** | **non** (en mémoire uniquement) | main / `AgentHost` | lancé quand un Chat passe en « running » ; détruit à la fermeture du Chat ou à la sortie de l'application |

Tout dans le renderer est une **vue** sur ceux-ci. Le renderer ne possède jamais
d'état canonique.

---

## Noms durables (survivent au redémarrage)

### Chat

L'unité de travail de l'utilisateur. Un ticket, une revue de PR, un fil Slack, une
session « fouiller dans le code » — chacun est un Chat.

```ts
interface ChatRecord {
  id: string;                                // chat_<12hex>
  name: string;                              // "ENG-20512 · ability cooldown"
  ticket: string | null;                     // "ENG-20512"
  pr: number | null;                         // 7401
  branch: string | null;                     // git branch this work targets
  type: 'lite' | 'client_test' | 'server_test';
  mode: 'interactive' | 'autonomous';
  agent: 'claude' | 'codex';
  status: ChatStatus;                        // see lifecycle below
  snippet: string;                           // last agent prose (cached for thumbnail)
  tokensUsed: number;
  tokensBudget: number;
  createdAt: number;
  lastActiveAt: number;
  closedAt: number | null;                   // null = open
}
```

**Cycle de vie du statut** (US-6 — ce qui colore la miniature) :

```text
              ┌──────────────┐
              │   idle (○)   │ ← initial state, no agent attached
              └──────┬───────┘
        send/respawn │
              ┌──────▼───────┐
              │  running (▶) │ ── error ──→  errored (✗)
              └──┬───────┬───┘
   needs review │       │ message-end + no work pending
              ┌─▼─────┐ │
              │paused │ │
              │  (?)  │ │
              └──┬────┘ │
       resolve   │      │
              ┌──▼──────▼─────┐
              │ complete (✓)  │
              └───────────────┘
```

**Le statut est descriptif, pas prescriptif** — dérivé de l'AgentSession
quand une y est attachée, persisté en BD à la transition. Un chat étant `idle`
signifie « aucun agent ne travaille en ce moment ». Cela ne signifie pas « le chat est
fermé ».

**Ouvert vs fermé :** un chat est « ouvert » ssi `closedAt IS NULL`. Les chats ouverts
sont chargés en mémoire au démarrage ; les chats fermés sont uniquement interrogeables. **Fermer
un chat libère son bail de slot + détruit son AgentSession mais ne supprime jamais les Messages.**

### Message

Journal d'événements quasi-append-only à l'intérieur d'un Chat. La transcription est une séquence
d'enregistrements typés :

```ts
interface MessageRecord {
  id: string;                                   // msg_<12hex>
  chatId: string;
  role: 'user' | 'agent' | 'system';
  kind: 'text' | 'tool' | 'permission' | 'system';
  body: string;                                 // JSON-encoded payload (shape per kind)
  createdAt: number;
  updatedAt: number;
}
```

**Pourquoi du JSON dans `body` ?** Chaque type a une forme de payload différente (texte vs
appel d'outil vs demande de permission) et le renderer distribue selon `kind`.
Stocker comme un blob JSON typé garde la table plate et le code du renderer
honnête.

**« Quasi-append-only » :** les lignes `tool` et `permission` sont modifiées **une fois** :

- lignes `tool` : écrites sur `tool-use` (nom + args), mises à jour sur `tool-result`
  (remplit `result` + `isError`).
- lignes `permission` : écrites sur `permission-request` (outil + args + raison),
  mises à jour sur la décision de l'utilisateur (définit `decision`).
- lignes `text` : écrites sur `message-start` avec un texte vide, **fusionnées** dans
  un petit tampon en mémoire à mesure que les événements `text-delta` arrivent, vidées sur
  `message-end` (et environ toutes les 250 ms pour garder le renderer en direct). Une ligne par
  « tour de prose de l'agent », pas une ligne par delta.

**Pas de suppressions en cascade depuis un retour en arrière sur le travail de l'agent.** Si un agent fait une
erreur et que vous voulez qu'il « réessaie », vous envoyez un nouveau message utilisateur. L'ancienne
transcription reste. Le modèle ne réécrit jamais silencieusement l'historique.

### Slot

Un espace de travail préchauffé, isolé et jetable : un checkout isolé sur un
dossier en copy-on-write (un worktree Git, ou un client Perforce) + un cache de
build chaud (par ex. le cache d'assets/import d'un moteur) + (optionnellement) un
éditeur en cours d'exécution pour l'application testée (Unity, Unreal, ou un moteur
personnalisé) + (optionnellement) un serveur sidecar en cours d'exécution. **Créé rarement,
réutilisé continuellement.** Les slots sont possédés par l'utilisateur / l'application, pas
par les Chats.

```ts
interface SlotRecord {
  id: number;                                   // slot-1, slot-2, ...
  worktreePath: string;
  branch: string | null;                        // null if free / detached
  ports: { mcp: number; server: number };
  unityPid: number | null;                      // editor PID; refreshed via PID liveness
  serverPid: number | null;
  state: 'free' | 'leased' | 'degraded' | 'creating';
  pinnedBranch?: string;                        // refuse leases for other branches
  cleanOnRelease?: boolean;
  leasedByChatId?: string;                      // soft pointer; a Chat → Slot binding
  lastLeaseAt?: number;
}
```

Le **lien Slot ↔ Chat** est **transitoire** — il vit dans `slot.leasedByChatId`
et les métadonnées runtime du Chat correspondant. Au démarrage nous le réconcilions
en parcourant les slots et en les faisant correspondre aux chats ouverts. Les baux périmés
(chat fermé, bail jamais libéré) sont récupérés.

Pour le cycle de vie complet du slot voir [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--lunité-durable).

### Octroi de permission

Une décision utilisateur durable selon laquelle une combinaison outil / cible est approuvée
sans nouvelle invite. Deux portées :

```ts
interface PermissionGrant {
  id: string;                                   // grant_<12hex>
  scope: 'global' | 'chat';
  chatId: string | null;                        // non-null iff scope='chat'
  tool: string;                                 // exact tool, e.g. 'Bash', 'git_push', 'mcp__linear__save_issue',
                                                //   OR a trailing-`*` wildcard, e.g. 'mcp__unrealEditor__*'
  /** Optional refinement: 'Bash' tool restricted to commands matching this prefix. */
  argMatcher: string | null;                    // raw string OR /regex/ — TBD
  decision: 'allow' | 'deny';
  createdAt: number;
}
```

`tool` peut être un joker se terminant par `*`, de sorte qu'un serveur MCP entier
puisse être autorisé avec un seul octroi (`allow-mcp-server` → `mcp__<server>__*`) — c'est
ainsi que le MCP d'éditeur d'un slot est autorisé une fois plutôt qu'une fois par outil. Les règles
de refus l'emportent toujours sur l'autorisation, et un motif plus spécifique l'emporte sur un
plus large (voir `resolvePermissionRules` dans `src/shared/agent.ts`).

Les octrois s'accumulent par chat (US-9 : « toujours autoriser git push pour ce chat »).
Les **règles de refus** codées en dur dans [adr/0004](../adr/0004-canusetool-policy-boundary.md)
ne sont pas stockées ici — elles vivent dans le code et ne peuvent pas être surchargées.

### Settings (Paramètres)

Deux couches :

- **Préférences globales** : thème, type de chat par défaut, nombre de slots, cadence de
  rafraîchissement de la Library maîtresse, etc. Table à une ligne.
- **Surcharges par chat** : mode serveur, échelle de temps, mode fenêtre, budget de
  tokens, etc. Stockées dans une table `chat_settings` indexée par `chatId`.

L'une ou l'autre peut être vide (les défauts s'appliquent). Modifiées via les panneaux de Settings
dans le renderer.

### Éléments d'attention en cache

Les files d'attente de l'utilisateur de tickets assignés (Linear / Jira / GitHub Issues) et de
revues en attente (PRs GitHub / changelists Helix Swarm). Mises en cache localement pour que les
panneaux se rendent instantanément ; rafraîchies sur un calendrier + à la demande.

```ts
interface AttentionItem {
  id: string;                                   // source-prefixed: linear:ENG-20512, jira:ENG-123, gh:7401, swarm:1284
  source: 'linear' | 'jira' | 'github' | 'swarm';
  /** Source-specific raw payload, JSON. */
  payload: string;
  /** Local UI-state: have I dismissed this? Is there a chat already open for it? */
  dismissedAt: number | null;
  spawnedChatId: string | null;
  fetchedAt: number;
}
```

Les sources de tickets sont interchangeables derrière un fournisseur commun (Linear, Jira,
GitHub Issues) ; les sources de revue de même (PRs GitHub, Swarm). Mises en cache, pas
faisant autorité — la source de vérité est le tracker / système de revue lui-même.

---

## Noms runtime (en mémoire ; ne survivent pas au redémarrage)

### AgentSession

La chose qui parle au LLM. Une AgentSession par Chat « en cours d'exécution ».
Adossée à un `AgentBackend` (le Claude Agent SDK ou le Codex SDK ; les deux
sont livrés aujourd'hui).

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**Possédée par `AgentHost`** (un singleton dans le processus main). AgentHost détient une
`Map<chatId, AgentSession>`. Les sessions sont créées paresseusement au premier
`agent.send` pour un chat et détruites quand le chat se ferme.

**Les sessions émettent des `AgentEvent`s** (voir `src/shared/agent.ts`). AgentHost
intercepte chaque événement et :

1. **Le persiste** (les deltas fusionnent dans une ligne texte ; tool-use crée une
   ligne d'outil ; permission-request crée une ligne de permission).
2. **Le rediffuse** au renderer via `webContents.send`. Le
   renderer est l'un des N abonnés ; le main est l'enregistreur faisant autorité.
3. **Met à jour les métadonnées du Chat** — `status`, `snippet`, `tokensUsed`,
   `lastActiveAt` sont mis à jour à mesure que les événements arrivent.

**Les sessions n'écrivent jamais directement dans la BD.** Seul AgentHost le fait. Cela
garde l'évolution du schéma de persistance découplée des échanges de backend.

### Demande de permission (en vol)

Quand le callback `canUseTool` du SDK se déclenche :

1. PolicyEngine évalue : autorisation stricte (auto), refus strict (auto), ou demander à l'utilisateur.
2. Si « demander à l'utilisateur », AgentHost émet un événement `permission-request` au
   renderer **et met en attente le callback du SDK** — indexé par `permissionId` — dans une
   map en attente.
3. Le renderer affiche la modale ; l'utilisateur clique sur une décision ; IPC de retour vers le main.
4. AgentHost recherche le callback en attente et le résout. Le SDK continue
   ou abandonne.
5. Si « toujours autoriser ceci » était coché, écrire une ligne `PermissionGrant`.

Les demandes en attente ne sont **pas persistées**. Si l'application plante en cours de
décision, l'appel d'outil de l'agent est annulé au redémarrage.

### Poignées du superviseur de processus

Par slot : un `child_process.ChildProcess` pour l'éditeur de l'application testée
(Unity / Unreal / moteur personnalisé — le champ `unityPid` enregistre son PID
quel que soit le moteur), un autre pour le serveur sidecar. Possédés par
`SlotManager`. Vérifiés en santé via la vivacité du PID + des sondes HTTP. Tués à la
libération du slot / sortie de l'application. **Réconciliés au démarrage** en parcourant le
`slot.json` du répertoire du slot et en vérifiant que les PID enregistrés sont toujours vivants.

---

## Règles de propriété

Ce sont des **invariants**. Le code qui les viole est un bug.

1. **Le renderer est une vue pure.** Pas de fs, pas de child_process, pas d'accès BD. Parle
   au main exclusivement via le pont typé `window.popbot.*`.

2. **Le main est le seul écrivain de la BD.** Le renderer lit via IPC ; ne
   touche jamais `popbot.db`.

3. **AgentHost est la seule chose qui modifie le statut / snippet / tokens
   d'un Chat pendant une session.** Le reste du code peut lire ces champs mais ne peut pas les
   écrire pendant qu'une session est active pour ce chat. (Les modifications pilotées par
   l'utilisateur comme renommer se produisent quand aucune session n'est active, ou sont mises en file d'attente.)

4. **Les backends n'écrivent jamais dans la BD.** Ils émettent des événements ; AgentHost
   persiste. Cela garde ClaudeBackend / CodexBackend / StubBackend
   interchangeables sans enchevêtrement de schéma BD.

5. **PolicyEngine est la seule source de vérité pour « cet outil peut-il s'exécuter ? »**
   Aucun backend ne le contourne. Les octrois de permission passent par lui.

6. **Le lien Slot ↔ Chat est transitoire.** L'enregistrement du Chat ne nomme jamais un
   slot. L'enregistrement du Slot nomme le chat qui détient le bail (pointeur
   souple, réconcilié au démarrage).

7. **La transcription ne se modifie jamais silencieusement.** Ajoutez de nouvelles lignes ; les
   mises à jour ponctuelles sur les lignes tool/permission sont explicites et bornées.

---

## Flux d'état — un seul message utilisateur, de bout en bout

Un exemple concret du modèle en mouvement.

```text
User types "fix the cooldown flicker" in chat c1 and presses ⌘↵
  │
  ▼
Renderer: api.agent.send({ chatId: 'c1', text })
  │  IPC: pb:agent:send
  ▼
Main · AgentHost.send('c1', text)
  ├─→ DB: appendMessage({ chatId, role: 'user', kind: 'text', body: { text } })
  ├─→ DB: updateChatStatus('c1', 'running', snippet=text.slice(0,140))
  ├─→ webContents.send('pb:agent:event', { type: 'message-start', ..., role: 'user' })
  └─→ session.sendUser(text)            // AgentSession (Claude SDK)
        │
        │  SDK streams events back via the onEvent callback wired at spawn:
        │
        ├─→ { type: 'message-start', role: 'agent', messageId: 'msg_abc' }
        │     ├─→ DB: appendMessage({ id: 'msg_abc', kind: 'text', body: { text: '' } })
        │     └─→ webContents.send → renderer appends an empty agent message bubble
        │
        ├─→ { type: 'text-delta', messageId: 'msg_abc', delta: 'Looking at ' }
        │     ├─→ buffer.append('msg_abc', 'Looking at ')      // in-memory
        │     │     (flush every 250ms or on message-end → DB UPDATE)
        │     └─→ webContents.send → renderer concatenates into the bubble
        │
        ├─→ { type: 'tool-use', messageId: 'msg_abc', toolUseId: 't1',
        │     name: 'unity.run_fixture', args: {...} }
        │     ├─→ PolicyEngine.evaluate('unity.run_fixture', args)  → 'allow' (whitelisted)
        │     ├─→ DB: appendMessage({ id: 'tool_t1', kind: 'tool',
        │     │                        body: { toolUseId, name, args } })
        │     └─→ webContents.send → renderer renders tool row
        │
        ├─→ { type: 'tool-result', toolUseId: 't1',
        │     text: '3/3 ok · 14.2s', isError: false }
        │     ├─→ DB: updateMessageBody('tool_t1', { ...prev, result, isError })
        │     └─→ webContents.send → renderer updates tool row badge
        │
        ├─→ { type: 'permission-request', permissionId: 'p1',
        │     tool: 'git_push', args: { ref: '...' }, reason: 'back up progress' }
        │     ├─→ PolicyEngine.evaluate('git_push', args)   → 'ask'
        │     ├─→ AgentHost.pendingPermissions.set('p1', sdkCallback)
        │     ├─→ DB: appendMessage({ id: 'perm_p1', kind: 'permission',
        │     │                        body: { permissionId, tool, args, reason } })
        │     ├─→ DB: updateChatStatus('c1', 'paused', snippet='needs you: ...')
        │     └─→ webContents.send → renderer shows PermissionModal
        │
        │  ┌─── user clicks "Allow once" in the modal ───────────────────────┐
        │  ▼                                                                  │
        │  Renderer: api.agent.approve({ chatId: 'c1', permissionId: 'p1', │
        │                                 decision: 'allow' })                │
        │   │  IPC: pb:agent:approve                                          │
        │   ▼                                                                  │
        │  Main · AgentHost.approve('c1', 'p1', 'allow')                      │
        │     ├─→ DB: updateMessageBody('perm_p1', { ...prev, decision })     │
        │     ├─→ DB: updateChatStatus('c1', 'running')                       │
        │     ├─→ pendingPermissions.get('p1')(true)   // resolves SDK        │
        │     └─→ webContents.send → renderer dismisses modal                 │
        │
        ├─→ { type: 'message-end', messageId: 'msg_abc' }
        │     ├─→ buffer.flush('msg_abc')      → DB UPDATE final text
        │     └─→ webContents.send → renderer freezes the bubble
        │
        └─→ { type: 'session-status', status: 'idle' }
              ├─→ DB: updateChatStatus('c1', 'idle')
              └─→ webContents.send → renderer thumbnail goes from blue to gray
```

Deux choses à remarquer :

- **Le renderer ne décide jamais de rien.** Il distribue des intentions et
  se re-rend à partir des événements.
- **Les écritures BD se produisent au même endroit que les notifications du renderer.** Elles
  sont liées par le même handler dans AgentHost. Cela signifie qu'un crash du renderer
  ne peut pas causer de dérive de persistance.

---

## Flux de récupération — redémarrage à froid

US-7 sous forme de code. L'application quitte brutalement. Des heures plus tard, l'utilisateur l'ouvre à nouveau :

1. **Init BD** — `initDb()` ouvre `popbot.db`, exécute les migrations en attente.
2. **Réconciliation des slots** — parcourt `~/Library/Application Support/PopBot/slots/`,
   pour chaque slot lit `slot.json`, vérifie que `unityPid` / `serverPid` sont
   vivants (`kill -0`) ; si mort, marque le slot comme libre et efface les PID.
   Résout tout bail orphelin (chat qui n'existe pas, ou chat dont
   `closedAt` est défini).
3. **Chats ouverts** — `listOpenChats()` retourne les chats avec `closedAt IS NULL`,
   triés par `lastActiveAt DESC`. Le renderer les demande au premier rendu.
4. **Pas de lancement automatique d'agent.** Les sessions sont lancées paresseusement au premier
   `agent.send`. Un utilisateur ouvrant son ancien chat voit simplement la transcription ;
   l'agent ne reprend pas où il s'était arrêté avant que l'utilisateur n'invite.
5. **Bail de slot à la demande.** Pareil — la location se produit quand le type de chat
   en a besoin (Client/Server Test) et qu'un outil nécessitant Unity est sur le point de
   se déclencher.

Le résultat : ouvrir l'application est rapide (lecture BD + ping de slot), et vous pouvez
inspecter l'historique de n'importe quel chat sans payer le coût de lancement de l'agent.

---

## Interchangeabilité des backends

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** enveloppe `@anthropic-ai/claude-agent-sdk`. Le défaut.
- **CodexBackend** enveloppe `@openai/codex-sdk` (qui pilote `codex exec`).
  Livré. Chaque backend annonce ses `capabilities` et l'interface
  les détecte par chat.
- **StubBackend** répète le texte de l'utilisateur avec un faux flux. Utilisé pour la
  validation du câblage + les tests d'interface.

Le champ `agent` de l'enregistrement du chat sélectionne quel backend AgentHost lance.

---

## Ce qui n'est intentionnellement PAS dans le modèle

- **Workflows / DAG / chaînes d'approbation.** Un chat est une conversation. Nous ne
  modélisons pas de pipelines.
- **Multi-utilisateur.** Un développeur unique par machine ; pas d'auth, pas de partage.
- **Notebooks / requêtes sauvegardées / modèles.** Tout émerge de la
  transcription ; pas encore de type de première classe.
- **Instantanés de chat versionnés / transcriptions ramifiées.** La transcription est
  linéaire. Forker un chat = créer un nouveau chat amorcé depuis l'historique
  de l'ancien (une fonctionnalité future, pas dans le modèle aujourd'hui).

Si nous finissons par avoir besoin de l'un de ces éléments, il est ajouté ici d'abord, puis au code.
