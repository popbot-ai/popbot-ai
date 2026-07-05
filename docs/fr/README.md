<div align="center">

![PopBot — a battle-tested multi-chat & multi-slot agentic coding tool](../../images/hero_banner_2.png)

*Languages: [English](../../README.md) · [Español](../es/README.md) · [Français](README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [简体中文](../zh-CN/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Русский](../ru/README.md) · [Italiano](../it/README.md)*

Un outil de bureau éprouvé pour exécuter en parallèle une équipe d'agents de codage IA — un par ticket, bug ou revue, chacun isolé dans son propre « slot » préchauffé, chacun capable de builder, exécuter et tester votre application de bout en bout.

[Pourquoi PopBot](#pourquoi-popbot) · [Fonctionnalités](#fonctionnalités-clés) · [Comment ça marche](#anatomie-de-lespace-de-travail) · [Une journée avec PopBot](#une-journée-avec-popbot) · [Installation](#installation) · [Faites-le vôtre](#faites-le-vôtre)

</div>

---

## Pourquoi PopBot

Exécuter un seul agent de codage IA est simple. En exécuter plusieurs à la fois introduit des problèmes qu'un agent unique n'a pas : garder leur travail isolé pour qu'ils ne s'écrasent pas mutuellement, réellement tester ce qu'ils construisent, le réviser, et verrouiller les actions irréversibles pour qu'aucun agent n'en prenne une sans supervision.

PopBot est une couche d'orchestration pour cela. Elle transforme tickets et demandes de revue en sessions d'agent en un clic, donne à chaque agent un espace de travail isolé (sa propre copie de travail — et, pour les projets de jeux vidéo, sa propre instance de l'application en cours de test), les exécute de manière autonome par défaut avec un point de contrôle humain sur les actions risquées, et rassemble chaque transcription, diff, terminal et log dans une seule fenêtre. L'opérateur parcourt les colonnes, approuve les actions verrouillées, et livre.

Elle a été construite par une petite équipe chez **Proof of Play** et utilisée quotidiennement sur un vrai projet de production riche en assets qui a été livré. C'est l'environnement dans lequel elle a fait ses preuves : plusieurs gigaoctets d'assets, un vrai contrôle de source, de vraies échéances. Le modèle de slots — des espaces de travail préchauffés, isolés, en copy-on-write — est ce qui a rendu possible l'exécution d'agents en parallèle dans cet environnement, et cela a augmenté ce que l'équipe pouvait accomplir à la fois. Nous publions et maintenons PopBot comme une implémentation de référence : non pas un produit fini à consommer tel quel, mais une forme à reprendre et à remodeler pour votre propre stack et votre propre workflow. Cela reflète une vision de la meilleure façon de construire des logiciels à l'ère de l'IA — que les équipes qui font tourner des flottes d'agents sont mieux servies en possédant et en modifiant l'outil qu'en adoptant un outil figé. Elle est sous licence MIT et organisée pour être forkée ; voir [Faites-le vôtre](#faites-le-vôtre).

![The PopBot workspace — the thumbnail strip, side-by-side chat columns, and a per-chat terminal](../../images/screenshot1.png)

<div align="center"><em>Une vraie session PopBot — plusieurs agents travaillant en parallèle, chacun dans son propre slot. Des miniatures en direct en haut, des chats en colonnes au centre, un terminal par chat en dessous, et le panneau de contrôle de source à droite.</em></div>

## Fonctionnalités clés

### Vue multi-chat avec miniatures en direct

Chaque chat ouvert reste à l'écran — une bande de **miniatures en direct** au-dessus de **colonnes** côte à côte. Chaque miniature est une vue réelle et actualisée de ce chat (pas seulement un point de statut), codée par couleur selon l'état : en cours, terminé, en attente de vous, erreur. En un coup d'œil, vous voyez *ce que chaque agent est en train de faire* et qui a besoin de vous — et vous pouvez **repérer un mauvais chemin tôt**, en redirigeant avant que cela ne consomme du temps et des tokens. Une seule personne supervise une flotte entière depuis une seule fenêtre.

### Slots préchauffés — des agents en parallèle sans la taxe de réimport

Chaque chat en cours loue un **slot** — une copie de travail persistante plus son propre état de build préchauffé, créé une fois et réutilisé. Pour un moteur de jeu, cela signifie que le slot conserve son propre cache d'assets chaud (le `Library` de Unity, le DDC d'Unreal) et peut garder l'éditeur ouvert, de sorte que faire revenir un agent dans son slot prend **des secondes, pas un réimport de plusieurs minutes**. Dix agents s'exécutent en isolation de branche réelle sans surcharger un seul cache d'import. [Comment fonctionnent les slots →](GUIDE.md#slots--des-espaces-de-travail-préchauffés-isolés-et-jetables)

### Copies illimitées sur le disque d'un seul repo

L'espace de travail d'un slot est un **dossier en copy-on-write** : chaque slot partage une seule image de base et ne stocke que ce qu'il modifie. Ainsi, une copie fraîche, réelle et complète d'un arbre de jeu **à l'échelle du téraoctet** est prête en **secondes** — de vrais fichiers modifiables, pas une vue superficielle — et des copies illimitées coûtent le disque d'un seul repo. Cela fonctionne sur **Windows, macOS et Linux**, et c'est ce qui permet à d'immenses arbres Perforce de rejoindre la flotte. [Pourquoi c'est important →](GUIDE.md#copy-on-write--des-copies-illimitées-sur-le-disque-dun-seul-repo)

### Git et Perforce, avec la revue intégrée

Le contrôle de source est un **fournisseur** derrière une seule interface : **Git** (worktrees, branches, PRs via `gh`) et **Perforce** (streams sur des espaces de travail fantômes, changelists, revues **Helix Swarm**) sont tous deux de première classe. Un panneau de contrôle de source cadré sur *l'espace de travail propre à chaque chat* affiche le statut, les commits et les diffs par fichier pour exactement cette branche. Des actions en un clic, basées sur des modèles (**Commit**, **Push PR**, **Rendre prêt**, **Traiter la CR**, **Rebaser sur la base**) envoient une instruction préremplie à l'agent de ce chat, avec `${branch}` / `${ticket}` / `${prnum}` renseignés.

### Une boîte de réception, plusieurs sources

Toute la boucle en un seul endroit : votre **boîte de réception** — tickets assignés depuis **Linear**, **Jira** et **GitHub Issues**, plus les revues qui vous attendent sous forme de **PRs GitHub** et de **changelists Swarm** → travail d'agent **en cours** dans des slots isolés → **push** et ouverture de la PR / revue → **archivage** d'un chat terminé → **réouverture et redémarrage** ultérieur avec l'historique complet. Cliquez sur un ticket et PopBot nomme la branche, loue un slot, déplace le ticket vers *En cours*, et amorce l'agent — puis le porte jusqu'à un changement fusionné et retour. [Parcours de workflow →](GUIDE.md#workflows-de-bout-en-bout)

## Fonctionnalités supplémentaires

- **Les vrais Claude Code et Codex — pas une réimplémentation.** Chaque chat pilote l'agent *réel* via son SDK officiel — les mêmes CLI `claude` et `codex` que vous exécutez dans un terminal, avec tous leurs outils, skills et serveurs MCP intacts. Choisissez le modèle (Opus / Fable / GPT) et l'effort de raisonnement par chat, changez en cours de session, ou redémarrez une session fraîche amorcée avec l'historique du chat.
- **Des agents qui testent leur propre travail.** Un slot peut lancer l'application réelle — pour Unity et Unreal, un éditeur en direct + un serveur sidecar sur un second écran, piloté par l'agent via un serveur MCP intégré à l'éditeur sur un **port par slot** — pour que l'agent clique dans l'interface, lise les logs et vérifie ses changements au lieu de deviner. Les moteurs personnalisés sont également pris en charge.
- **Chats persistants et archivables.** Chaque chat est une transcription durable ; fermez-le pour libérer son slot, et rouvrez-le plus tard avec l'historique complet intact.
- **Terminal par chat & code cliquable.** Un terminal intégré épinglé à l'espace de travail du chat, et des liens `fichier.ts:42` qui s'ouvrent dans VS Code ou Cursor.
- **Autonome, mais jamais imprudent.** Les agents exécutent automatiquement le travail sûr dans leur slot et se mettent en pause pour vous sur tout ce qui est risqué — `git push` / `p4 submit`, ouverture de PRs, tout ce qui sort de l'espace de travail, appels réseau. Les autorisations sont par chat, durables et révocables — serveurs MCP inclus.
- **Entièrement localisé.** L'interface entière est disponible en huit langues (anglais, espagnol, français, allemand, japonais, coréen, chinois simplifié, portugais brésilien), modifiable à tout moment depuis le menu des langues.
- **Multi-repo.** Pilotez plusieurs dépôts côte à côte, chacun avec son propre pool de slots, sa couleur, son fournisseur et ses conventions de branches.

## En quoi PopBot est différent

Les outils de codage agentique ont tendance à se répartir en quelques catégories. PopBot se situe ailleurs : un **cockpit local pour exécuter en parallèle de nombreux agents *réels*, avec un état de build préchauffé et une supervision humaine en direct.**

| Au lieu de… | …PopBot |
|---|---|
| **Un agent dans un terminal ou un IDE** — une seule tâche dans un seul arbre de travail à la fois | **De nombreux agents à la fois**, chacun isolé dans son propre slot préchauffé, tous visibles comme une flotte en direct que vous pilotez depuis une seule fenêtre |
| **Agents cloud asynchrones** — opaques et distants ; soumettez une tâche, attendez une PR | **Local et en direct** — regardez chaque agent travailler et repérez un mauvais chemin tôt, et il pilote *votre vraie application* (un éditeur de moteur sur un second écran) pour un véritable test de bout en bout |
| **Jonglage artisanal `tmux` + worktrees** — parallèle mais manuel, et chaque nouveau checkout paie la taxe de réimport de plusieurs minutes du moteur | **Slots préchauffés gérés** — des espaces de travail réutilisés, en copy-on-write, qui gardent le cache d'assets chaud, avec un cycle de vie de branche/espace de travail, le panneau SCM, et la revue de code pris en charge pour vous |
| **Frameworks d'orchestration d'agents** — des boîtes à outils pour *construire* des systèmes d'agents | **Une application finie et opinionated** connectée à votre boîte de réception et à votre boucle de revue — humain dans la boucle par conception, pas une bibliothèque à assembler |

Et surtout : PopBot ne remplace pas Claude Code ou Codex — il **les exécute**. Vous obtenez exactement les agents (et vos versions exactes de CLI) auxquels vous faites déjà confiance, simplement plusieurs à la fois, avec l'orchestration, l'isolation et la supervision qui les entourent.

## Anatomie de l'espace de travail

![PopBot UI anatomy](../../images/anatomy.png)

| Zone | Ce que c'est |
|---|---|
| **Boîte de réception — tickets & revues** | Tickets assignés (Linear / Jira / GitHub Issues) et revues qui vous attendent (PRs GitHub / changelists Swarm), classés. Un clic fait naître un chat. |
| **Slots** | Le pool d'espaces de travail préchauffés et isolés — une copie de travail en copy-on-write *plus* un état de build persistant (pour un moteur de jeu, son propre cache d'assets chaud). Un chat en loue un pendant qu'il travaille et le restitue à la fermeture. |
| **Archive des chats** | Chaque chat passé, consultable et réouvrable avec l'historique complet. |
| **Miniatures des chats** | Une bande en direct de tous les chats ouverts — codée par couleur selon le statut (en cours / terminé / a besoin de vous / erreur). |
| **Chats** | Les sessions d'agent au premier plan : prose, appels d'outils et diffs de code en ligne, diffusés en direct. |
| **Terminal par chat** | Un terminal intégré pointé sur l'espace de travail de ce chat, pour des commandes manuelles. |
| **Panneau SCM** | Statut de l'arbre de travail / changelist, commits, diffs de fichiers, et actions commit / push / PR / revue en un clic. |

## Une journée avec PopBot

**Un ticket de fonctionnalité.** Un ticket atterrit dans votre boîte de réception. Cliquez dessus → PopBot ouvre un chat sur `you/eng-123-…`, loue un slot, déplace le ticket vers *En cours*, et remet à l'agent la description complète. Il écrit le code, exécute l'application dans son slot pour vérifier, et se met en pause pour votre accord avant de pousser. Vous relisez le diff dans le panneau SCM et cliquez sur **Push PR**.

**Un bug, en parallèle.** Pendant que cela s'exécute, un rapport de bug arrive. Faites naître un second chat — son propre slot, sa propre branche — et les deux agents travaillent simultanément sans jamais toucher à l'arbre de l'autre. La bande de miniatures montre les deux : un en vert (terminé), un en bleu (en cours).

**Une demande de revue.** La PR d'un coéquipier (ou une changelist Swarm) apparaît dans votre onglet Revues. Cliquez dessus → un chat de revue instantané et **sans repo** s'ouvre, l'agent lit le diff *et* le code environnant, traque de vrais bugs, et poste une revue en ligne sur GitHub ou Swarm — pendant que vos deux chats de build continuent.

**Reprenez demain.** Fermez les chats terminés pour libérer leurs slots. Le lendemain matin, rouvrez le chat de fonctionnalité depuis l'archive pour traiter les retours de revue — l'agent reprend avec la conversation entière et son espace de travail intacts.

→ Des parcours complets (flux de fonctionnalité, de bug et de revue, plus comment fonctionnent en coulisses les slots, les espaces de travail en copy-on-write et la réouverture) se trouvent dans le **[Guide des fonctionnalités et workflows](GUIDE.md)**.

## Installation

Des installeurs signés et préconstruits sont disponibles sur **[popbot.app](https://popbot.app)** :

- **macOS** — `.dmg` signé et notarisé (Apple silicon)
- **Windows** — installeur `.exe` signé
- **Linux** — paquet `.deb`

L'application se met à jour automatiquement depuis son canal de release. Pour exécuter votre propre build à la place, voir [Build depuis les sources](#build-depuis-les-sources).

## Build depuis les sources

```bash
npm install
npm run dev        # run the app in development
npm run package    # build a signed installer for your platform
```

**Prérequis**

- **macOS, Windows ou Linux.** macOS est la plateforme la plus éprouvée (le workflow d'application-testée-sur-second-écran s'appuie sur les API d'Accessibilité macOS) ; Windows et Linux sont pris en charge et livrés — voir [WINDOWS.md](WINDOWS.md) pour les notes de configuration Windows/WSL.
- **Node 20+** (Node 20 / 22 évitent une recompilation de module natif ; voir les notes Windows).
- Les CLI **`claude`** et/ou **`codex`** (les backends d'agents), plus **`git`** et, pour les flux GitHub, **`gh`**. Pour Perforce, la CLI **`p4`**.
- Les identifiants (Linear, Jira, GitHub, Helix Swarm) sont stockés **localement sur votre machine**, dans la base de données propre à l'application — jamais dans ce dépôt.
- Optionnel : un éditeur Unity ou Unreal pour les projets de jeux ; VS Code / Cursor ; iTerm.

## Faites-le vôtre

PopBot est publié comme une implémentation de référence, destinée à être forkée et adaptée plutôt qu'adoptée telle quelle. Sa forme est générale — **agents + slots isolés, préchauffés, en copy-on-write + une boîte de réception en tant que file d'attente + une application testée** — et le code est organisé comme des *fournisseurs derrière de petites interfaces communes*, pour qu'une équipe puisse échanger une partie sans toucher au reste. Elle est **sous licence MIT**. L'approche générale consiste à conserver les idées centrales et à remplacer les instances spécifiques :

- **Échangez l'application testée.** Unity et Unreal sont deux implémentations de « laisser l'agent exécuter et vérifier l'application ». Le hook de moteur personnalisé fait déjà passer l'identité du slot jusqu'à votre commande de lancement — pointez-le vers votre application web, votre CLI ou votre harnais de test. *(`src/shared/gameEngine.ts`, `src/main/ipc/apps.ts`)*
- **Redirigez la boîte de réception ailleurs.** Linear, Jira et GitHub Issues sont des exemples concrets ; ajoutez un tracker en implémentant une interface et en l'enregistrant. *(`src/main/tickets/`)*
- **Ajoutez ou échangez le contrôle de source.** Étendez la classe de base du fournisseur aux côtés de Git et Perforce ; les appelants se branchent sur les *capacités*, jamais sur l'id du fournisseur. *(`src/main/scm/`)*
- **Recâblez les actions et les prompts.** Les conventions de branches, les flux PR/revue, et chaque prompt amorcé sont des modèles modifiables dans les Préférences — aucun code requis.
- **Conservez le noyau.** Les slots préchauffés, les espaces de travail en copy-on-write, les chats persistants, le plancher de permission codé en dur, et le cockpit multi-agents sont l'épine dorsale durable.

Le **[Guide des fonctionnalités et workflows](GUIDE.md)** explique le raisonnement derrière chaque point de rupture ; le document **[Architecture](ARCHITECTURE.md)** indique où le trouver dans le code.

## Documentation

| Doc | Ce qu'il contient |
|---|---|
| **[Guide des fonctionnalités et workflows](GUIDE.md)** | La visite complète — les idées, comment chaque pièce fonctionne, et les workflows de bout en bout. Commencez ici. |
| **[Guide de configuration](CONFIGURATION.md)** | Configurez chaque panneau des Préférences — intégrations, dépôts, slots, agents — avec captures d'écran. |
| [USER_STORIES.md](USER_STORIES.md) | Les user stories par rapport auxquelles PopBot a été mesuré. |
| [CORE_MODEL.md](CORE_MODEL.md) | Le modèle objet — Chat, Message, Slot, AgentSession — et leurs cycles de vie. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Frontières de processus, IPC, où vit chaque sous-système. |
| [WINDOWS.md](WINDOWS.md) | Notes de configuration Windows / WSL. |
| [POPBOT_DESIGN.md](POPBOT_DESIGN.md) | Le cahier des charges de conception original (historique). |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Configuration de développement local, scripts, conventions. |

## Licence

[MIT](../../LICENSE) © 2026 Proof of Play, Inc. Les composants et marques tiers sont listés dans [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) — notez que la dépendance runtime `@anthropic-ai/claude-agent-sdk` est propriétaire et utilisée selon les conditions d'Anthropic, pas sous la licence MIT.
