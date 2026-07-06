# PopBot — Guide des fonctionnalités et workflows

PopBot est un cockpit de bureau pour exécuter **de nombreux agents de codage IA en parallèle**. Ce guide couvre les idées sur lesquelles il est construit — pourquoi il existe, comment fonctionnent les pièces, ce qui a façonné la conception, et comment une équipe chez Proof of Play l'a utilisé sur un vrai projet riche en assets qui a été livré. Il est écrit pour des ingénieurs qui peuvent trouver l'interface par eux-mêmes ; l'objectif ici est le raisonnement, afin que vous puissiez adapter l'outil à votre propre workflow plutôt que de suivre un script.

Adapter PopBot à votre workflow est un usage prévu, pas une réflexion après coup. PopBot est publié comme une implémentation de référence — une forme à modifier pour votre équipe plutôt qu'un produit figé — reflétant une vision de la meilleure façon de construire des logiciels à l'ère de l'IA : les équipes qui font tourner des flottes d'agents sont généralement mieux servies en possédant et en remodelant l'outil qu'en adoptant un outil dont les décisions sont figées pour elles. Lisez le « pourquoi » derrière chaque pièce ci-dessous comme une carte indiquant où couper pour la changer. [Faites-le vôtre](#faites-le-vôtre) couvre en détail le comment, le où et le pourquoi.

- [Pourquoi nous avons construit PopBot](#pourquoi-nous-avons-construit-popbot)
- [Concepts clés](#concepts-clés)
  - [Agents & modèles](#agents--modèles)
  - [Slots : des espaces de travail préchauffés, isolés et jetables](#slots--des-espaces-de-travail-préchauffés-isolés-et-jetables)
  - [Copy-on-write : des copies illimitées sur le disque d'un seul repo](#copy-on-write--des-copies-illimitées-sur-le-disque-dun-seul-repo)
  - [Contrôle de source : Git et Perforce](#contrôle-de-source--git-et-perforce)
  - [La boîte de réception : une file d'attente, plusieurs sources](#la-boîte-de-réception--une-file-dattente-plusieurs-sources)
  - [Chats sans repo (pour la revue de code)](#chats-sans-repo-pour-la-revue-de-code)
  - [Branche de base](#branche-de-base)
  - [Chats persistants et archivables](#chats-persistants-et-archivables)
- [Anatomie de l'espace de travail](#anatomie-de-lespace-de-travail)
- [Comment il a été utilisé chez Proof of Play](#comment-il-a-été-utilisé-chez-proof-of-play)
- [Workflows de bout en bout](#workflows-de-bout-en-bout)
  - [Un ticket de fonctionnalité](#un-ticket-de-fonctionnalité)
  - [Un ticket de bug](#un-ticket-de-bug)
  - [Une revue de code](#une-revue-de-code)
  - [Rouvrir un chat archivé](#rouvrir-un-chat-archivé)
- [Contrôle de source & revue intégrés](#contrôle-de-source--revue-intégrés)
- [Tester dans un slot : l'application testée](#tester-dans-un-slot--lapplication-testée)
- [Permissions & sécurité](#permissions--sécurité)
- [Localisation](#localisation)
- [Préférences](#préférences)
- [Faites-le vôtre](#faites-le-vôtre)

---

## Pourquoi nous avons construit PopBot

Un seul agent de codage IA est facile à exécuter. Dès que vous voulez **en faire fonctionner plus d'un à la fois**, trois problèmes apparaissent :

1. **Isolation.** Deux agents modifiant le même checkout corrompent le travail de l'autre. Vous ne pouvez pas avoir trois agents et un seul arbre de travail — et sur un gros projet de jeu, vous ne pouvez pas non plus vous permettre trois checkouts complets.
2. **Supervision.** Les agents sont rapides et globalement corrects, mais « globalement » ne suffit pas pour `git push`, `p4 submit`, ou l'ouverture d'une PR. Vous avez besoin d'un point de contrôle humain sur les actions irréversibles — sans avoir à surveiller chaque modification de fichier.
3. **Vérification.** Un code qui compile n'est pas un code qui fonctionne. Pour un jeu en particulier, le seul vrai test est de *l'exécuter* et de cliquer dedans. Un agent qui ne peut pas voir l'application devine.

PopBot a été construit pour résoudre ces trois problèmes pour une petite équipe qui livre un jeu en exploitation. L'idée centrale : traiter chaque unité de travail — un ticket, un bug, une revue — comme un **chat**, donner à chaque chat son propre **espace de travail** isolé plus (au besoin) sa propre copie en cours d'exécution de l'application, les exécuter **de manière autonome mais contrôlée**, et afficher toute la flotte dans une seule fenêtre pour qu'une personne puisse diriger une dizaine d'agents à la fois.

La conception a été guidée par un ensemble concret de [user stories](USER_STORIES.md) : *« En tant qu'ingénieur, je clique sur un ticket et un agent commence à y travailler sur une branche correcte. »* *« En tant que relecteur, j'ouvre une changelist et j'obtiens une vraie revue sans rien extraire. »* *« En tant que lead, je regarde le mur et je sais quels agents ont besoin de moi. »* Tout ce qui suit existe pour servir ces objectifs. Si vous comprenez *pourquoi* chaque pièce est façonnée de cette manière, vous saurez quelles parties conserver et lesquelles remplacer lorsque vous le forkerez pour votre propre stack.

---

## Concepts clés

### Agents & modèles

Chaque chat est piloté par un **backend d'agent** :

- **Claude Code** — via le Claude Agent SDK. Modèles : **Claude Opus** (par défaut) et **Claude Fable**.
- **Codex** — via le OpenAI Codex SDK. Modèle : **GPT / Codex**.

PopBot ne réimplémente pas ces agents — il **pilote les vrais** via leurs SDK officiels, qui enveloppent les mêmes outils en ligne de commande **`claude`** et **`codex`** que vous exécuteriez dans un terminal. Toute la puissance de chaque agent — ses outils, skills, serveurs MCP et sous-agents — est disponible dans chaque chat, et PopBot reste synchronisé avec quelle que soit la version de ces CLI que vous avez installée. Si cela fonctionne dans Claude Code en terminal, cela fonctionne ici. C'est un pari délibéré : les agents s'améliorent rapidement, et tout ce qui les enveloppait ou les forkait finirait par pourrir. En pilotant directement les CLI, PopBot hérite gratuitement de chaque amélioration.

Par chat, vous choisissez le backend, le **modèle**, et l'**effort de raisonnement** (`low` → `xhigh` / `max` — plus d'effort signifie une réflexion plus profonde et un usage d'outils plus approfondi, à un coût/latence plus élevés). Vous définissez des **valeurs par défaut** sensées — séparément pour les *nouveaux chats* et pour les *revues de code*, puisqu'une revue veut une profondeur différente d'une construction de fonctionnalité — et vous les surchargez par chat quand une tâche le justifie.

Deux contrôles de session comptent pour le travail de longue durée :

- **Changer en cours de session.** Modifiez le modèle ou l'effort sur un chat en cours ; PopBot reconfigure l'agent sans perdre le fil.
- **Redémarrer avec le contexte.** Lancez une session d'agent *fraîche* amorcée avec la transcription de ce chat (ses premiers tours plus les plus récents), utile quand une session devient longue ou coincée. L'historique de conversation est préservé ; l'agent obtient simplement un runtime propre.

Les identifiants des intégrations sont stockés **localement sur votre machine**, dans la base de données propre à l'application — jamais dans ce dépôt.

### Slots : des espaces de travail préchauffés, isolés et jetables

Un **slot** est l'unité de parallélisme, et c'est l'idée centrale de PopBot. La façon naïve d'exécuter N agents est N checkouts du dépôt — ce qui entre en collision sur des arbres partagés, ou coûte N × (temps de checkout + cache de build). Un slot est la réponse à « comment donner à un agent un endroit *réel et indépendant* pour travailler qui soit aussi *déjà préchauffé* et *bon marché à restituer* ».

Un slot a trois propriétés, et chacune est structurante :

- **Isolé.** Chaque slot est son propre répertoire de travail sur sa propre branche (ou stream Perforce), de sorte que N agents modifient N branches sans aucune interférence. Le `git reset` d'un agent ne peut pas toucher le travail d'un autre.
- **Préchauffé.** Un slot conserve des artefacts de build à état persistant à travers les usages — pour un moteur de jeu, son propre cache d'import/assets ; un **serveur sidecar** dédié avec son propre répertoire de données ; des **ports** assignés ; des logs par slot ; et, tant qu'un chat est actif, un processus d'**éditeur** en direct. Un répertoire de travail nu vous donne une *source* isolée ; un slot vous donne un endroit isolé et déjà *préchauffé* pour builder, exécuter et tester.
- **Jetable.** Les slots sont mutualisés en pool. Un chat **loue** un slot libre pour sa durée de vie et le **restitue** à la fermeture. Créer un espace de travail préchauffé est coûteux ; en réutiliser un est presque gratuit, donc PopBot garde un pool de slots préchauffés et fait circuler le travail à travers.

**Pourquoi « préchauffé » est tout l'enjeu pour le travail sur moteur.** Un moteur de jeu conserve un cache massif d'assets traités — le `Library/` de Unity, le `DerivedDataCache` d'Unreal — souvent plusieurs gigaoctets, coûteux à produire. Un checkout frais, ou un changement de branche qui l'invalide, force le moteur à **réimporter le projet**, ce qui peut prendre de nombreuses minutes. Payez cela à chaque tâche et à chaque changement de branche, et vos agents passent plus de temps à attendre le moteur qu'à écrire du code. Les slots éliminent cette taxe en donnant à chacun son **propre cache persistant** :

- **Faire revenir un agent dans son slot prend des secondes, pas des minutes** — le cache est déjà chaud, donc seuls les assets réellement modifiés sont retraités.
- **Un slot peut garder l'éditeur *en cours d'exécution*.** Une réutilisation « collante » (même slot, même branche) remet à l'agent un éditeur en direct presque instantanément au lieu d'un lancement à froid.
- **Dix agents ne surchargent pas un seul cache d'import.** Chaque slot a son propre cache chaud, donc le travail de jeu parallèle ne se sérialise jamais derrière un seul réimport.

Avant tout changement de branche, PopBot exécute une **séquence de sécurité** — elle met de côté le travail non commité, refuse d'écraser les commits que l'agent possède, change, et restaure l'état — de sorte qu'un transfert de slot ne perde jamais silencieusement de travail. Les slots peuvent fonctionner en mode **pool de slots** (réutilisé, par défaut) ou en mode **éphémère** (un espace de travail frais par chat) quand vous préférez échanger la chaleur contre une ardoise propre.

> **Pourquoi c'est important :** l'isolation est ce qui rend « dix agents à la fois » sûr plutôt que catastrophique. La chaleur est ce qui le rend *rapide*. La jetabilité est ce qui le rend *bon marché*. Retirez l'un des trois et les agents parallèles cessent d'en valoir la peine.

### Copy-on-write : des copies illimitées sur le disque d'un seul repo

L'isolation et la chaleur ne sont abordables que si les *fichiers* d'un slot sont bon marché. Sur un petit repo, N worktrees git conviennent. Sur un projet de jeu à l'échelle du téraoctet — avec une immense bibliothèque d'assets et, sur de nombreuses équipes, **Perforce** plutôt que Git — N copies réelles représenteraient des centaines de gigaoctets et des minutes chacune à matérialiser. Cela tue tout le modèle.

Donc l'espace de travail d'un slot est un **dossier en copy-on-write**. Chaque slot partage une seule **image de base** du repo et ne stocke que les blocs qu'il modifie réellement. Le résultat pratique :

- **Une copie fraîche, réelle et complète d'un arbre d'un téraoctet est prête en secondes** — pas une vue superficielle, de vrais fichiers modifiables — et est libérée tout aussi vite.
- **Des copies illimitées coûtent le disque d'un seul repo.** Dix agents sur un projet de 1 To n'ont pas besoin de 10 To ; ils ont besoin d'environ 1 To plus le petit delta de chaque slot.
- **Cela fonctionne de la même manière sur Windows, macOS et Linux** (via `shado`, la couche d'espace de travail fantôme de PopBot — VHDX différencié sur Windows, systèmes de fichiers CoW natifs ailleurs), et c'est ce qui permet aux arbres Perforce de participer.

C'est la pièce qui permet à l'idée de slot de passer à l'échelle, de « un repo web avec quelques worktrees » à « un arbre de jeu de taille AAA avec une flotte d'agents ». C'est aussi la fonctionnalité la moins visible et sans doute la plus importante : sans copies bon marché, les slots isolés préchauffés sont un luxe ; avec elles, ils sont le défaut.

### Contrôle de source : Git et Perforce

PopBot traite le contrôle de source comme un **fournisseur** derrière une interface commune, parce que « exécuter un agent sur une branche isolée, puis réviser et intégrer le changement » a la même forme que le backend soit Git ou Perforce. Les deux sont de première classe :

- **Git** — worktrees pour l'isolation, branches par chat, PRs via la CLI `gh`, GitHub comme surface de revue.
- **Perforce** — streams/branches par chat sur des espaces de travail fantômes en copy-on-write, changelists comme unité de travail, et **Helix Swarm** comme surface de revue. Les revues Swarm s'épinglent dans la même boîte de réception Revues que les PRs GitHub, chacune ouvrant son propre chat de revue.

Les concepts que vous verrez ci-dessous — branche de base, le panneau git/SCM, les actions basées sur des modèles, la boîte de réception de revue — sont écrits par rapport à cette interface commune. Là où le texte dit « branche » ou « PR », lisez « changelist » ou « revue Swarm » si vous êtes sur Perforce ; le workflow est délibérément identique.

### La boîte de réception : une file d'attente, plusieurs sources

La boîte de réception est une *idée*, pas une intégration : **votre travail assigné et vos revues en attente, classés, chacun à un clic de devenir un chat d'agent.** Ce qui l'alimente est modulaire :

- **Tickets** — issues **Linear**, issues **Jira**, et **GitHub Issues** qui vous sont assignées (le support de GitHub Issues est plus récent et encore quelque peu expérimental). Cliquez sur l'un d'eux et PopBot nomme une branche, loue un slot, déplace le ticket vers *En cours*, et amorce l'agent avec sa description.
- **Revues** — pull requests **GitHub** et changelists **Helix Swarm** qui attendent votre revue. Cliquez sur l'une d'elles et un chat de revue sans repo s'ouvre instantanément.

Ajouter une source ne change pas le workflow — cela ajoute simplement des lignes à la même file d'attente. C'est tout l'intérêt : le modèle de boîte-de-réception-en-tant-que-file-d'attente est générique, et les trackers spécifiques sont des valeurs par défaut interchangeables.

### Chats sans repo (pour la revue de code)

Tous les chats n'ont pas besoin d'un espace de travail. **Réviser** un changement est une opération en lecture seule — vous ne modifiez pas, vous lisez le diff et le code environnant et vous postez des commentaires. Donc les chats de revue sont **sans repo** : ils naissent instantanément, ne louent aucun slot, et ne consomment aucun espace de travail.

C'est une séparation délibérée et importante :

- Un **chat de build** (fonctionnalité/bug) loue un slot, peut prendre un moment pour se préchauffer, et occupe un espace de travail pour sa durée de vie.
- Un **chat de revue** est **instantané et gratuit** — vous pouvez en ouvrir cinq pour trier votre file de revue pendant que vos chats de build continuent de tourner sans être perturbés.

Cela signifie aussi que votre pool de slots est réservé au travail qui a réellement besoin d'isolation. Les revues n'affament jamais les builds en slots — une propriété qui compte beaucoup quand le pool est borné par la RAM et le disque.

### Branche de base

Quand un chat *écrit* effectivement du code, il se fork depuis une **base** — typiquement `develop`/`main` sur Git, ou le stream principal sur Perforce. PopBot définit la base par défaut par dépôt, se souvient de votre dernier choix pour que le cas courant soit un seul clic, et vous laisse forker depuis une ligne de fonctionnalité ou une branche de release quand une tâche le nécessite. Il dérive le nom de la nouvelle branche depuis votre convention — par ex. `<username>/<ticket>-<slug>` — de sorte que les branches soient cohérentes et traçables jusqu'à leur ticket. La base alimente aussi les actions ultérieures : « rebaser sur la base », « ouvrir une PR / revue contre la base », et les vérifications de dérive s'appuient toutes dessus.

### Chats persistants et archivables

Chaque chat est une **transcription durable** stockée localement — prose, appels d'outils, diffs, décisions de permission, tout. Rien n'est éphémère.

- **Fermer** un chat libère son slot (libérant un espace de travail pour d'autres agents) mais **conserve tout**. Le chat passe dans l'**archive**.
- **Rouvrir** un chat depuis l'archive relance la location d'un slot, restaure sa branche, et l'agent reprend avec son **historique complet** — vous pouvez reprendre une fonctionnalité des jours plus tard pour traiter des retours de revue sans avoir à tout réexpliquer. S'il rouvre dans un slot *différent*, PopBot en informe l'agent d'emblée, pour qu'il se réoriente proprement vers le nouveau répertoire de travail.
- L'archive est consultable par nom, ticket, branche et contenu.

Parce que le retour en arrière consiste simplement à « envoyer un autre message » (il n'y a pas de modifications destructrices de l'historique), un chat accumule l'histoire complète et vérifiable de la façon dont un changement a été fait.

---

## Anatomie de l'espace de travail

![PopBot UI anatomy](../../images/anatomy.png)

| Zone | Ce que c'est |
|---|---|
| **Boîte de réception — tickets & revues** | Tickets assignés (Linear / Jira / GitHub Issues) et revues qui vous attendent (PRs GitHub / changelists Swarm), classés. Cliquez sur une ligne pour faire naître un chat amorcé avec son contexte. |
| **Slots** | Le pool d'espaces de travail préchauffés. Chaque pastille montre si un slot est libre ou loué par un chat. |
| **Archive des chats** | Chaque chat passé, consultable et réouvrable avec l'historique complet. |
| **Miniatures des chats** | Un aperçu en direct et défilant de chaque chat ouvert — une vue réelle de ce que chaque agent est en train de faire, codée par couleur selon le statut : bleu = en cours, vert = terminé, jaune = a besoin de vous, rouge = erreur, gris = inactif. |
| **Chats** | Les sessions d'agent au premier plan — prose en flux, appels d'outils, et diffs de code en ligne. |
| **Terminal par chat** | Un terminal intégré épinglé à l'espace de travail de ce chat. |
| **Panneau SCM** | Statut de l'arbre de travail/changelist, commits récents, diffs de fichiers, et actions commit / push / PR / revue en un clic. |

Parce que chaque chat reste sur la **bande de miniatures** et que les **colonnes sont côte à côte**, vous ne cherchez jamais un statut. La couleur est le signal — bleu = en cours, vert = terminé, jaune = a besoin de vous, rouge = erreur — de sorte qu'un coup d'œil vous dit quels agents travaillent, lesquels ont terminé, et lesquels **attendent après vous**.

Mais chaque miniature est aussi un **aperçu en direct de la conversation**, pas seulement un voyant de statut — de sorte qu'en un coup d'œil vous pouvez voir *sur quoi* chaque agent travaille réellement. C'est ce qui vous permet de **repérer un travail inutile tôt** : repérer un agent qui part dans la mauvaise direction et le rediriger avant qu'il ne consomme du temps et des tokens, au lieu de découvrir l'impasse une fois qu'il est « terminé ». C'est la différence entre superviser une flotte et être surpris par elle.

### Pourquoi des miniatures, et pourquoi une seule vue

Cette disposition est une réponse délibérée à un problème spécifique, et il vaut la peine d'énoncer le raisonnement parce que c'est la partie que la plupart des outils réussissent le moins bien.

Exécuter un agent est une tâche de concentration : vous surveillez une seule conversation et vous répondez. En exécuter *plusieurs* est une tâche de **surveillance**, et la surveillance a un mode d'échec différent — le goulot d'étranglement n'est pas votre vitesse de frappe, c'est votre attention. Un agent qui s'égare silencieusement produit un travail que vous devez remarquer, comprendre, et jeter. Avec N agents, le coût de *ne pas remarquer* croît avec N, et les interfaces naturelles rendent le fait de remarquer difficile : les onglets cachent tous les agents sauf un, et un modèle de lancer-et-attendre les cache tous jusqu'à ce qu'ils affichent un résultat.

Donc la conception s'engage sur deux points :

- **Chaque agent est toujours visible.** La bande de miniatures affiche toute la flotte à la fois, et chaque miniature est une vue en direct de la conversation réelle, pas un indicateur de chargement. Vous êtes censé pouvoir prendre du recul et saisir l'état d'une douzaine d'agents en un seul balayage du regard — quels agents bougent, lesquels sont bloqués, lesquels sont sur le point de faire quelque chose que vous voudriez arrêter.
- **Le statut est une couleur, le contenu est à un coup d'œil.** La couleur répond à « qui a besoin de moi ? » en moins d'une seconde ; l'aperçu en direct répond à « que fait celui-ci ? » sans clic ; et les colonnes côte à côte vous permettent de plonger dans n'importe lequel d'entre eux sans perdre les autres. L'interface est optimisée pour une **revérification bon marché**, parce qu'avec de nombreux agents vous revérifiez constamment.

Le gain, c'est la capacité d'**intervenir tôt**. L'erreur coûteuse avec des agents autonomes n'est pas un crash — c'est un agent qui passe une heure avec assurance à construire la mauvaise chose. Une vue qui affiche continuellement l'intention transforme cela d'une découverte a posteriori en une correction de trajectoire à mi-parcours. C'est toute la raison pour laquelle la flotte est à l'écran en permanence plutôt que derrière des onglets ou une notification.

---

## Comment il a été utilisé chez Proof of Play

PopBot n'était pas une expérience de laboratoire. Il a été construit et utilisé quotidiennement par l'équipe de **Proof of Play** sur un vrai projet riche en assets qui a été livré. Cette origine explique la plupart des choix de conception, et c'est la façon la plus claire de comprendre à quoi sert l'outil.

Le résultat pratique était simple : le modèle de slots — des espaces de travail préchauffés, isolés, en copy-on-write — a rendu le travail d'agent parallèle faisable sur un large arbre d'assets, et l'équipe en a accompli davantage grâce à cela. Plusieurs agents pouvaient s'exécuter à la fois sans entrer en collision ni payer la taxe de réimport du moteur à chaque changement, de sorte que le débit a augmenté au lieu que la parallélisation se transforme en surcharge.

La forme d'une journée type : un lead avec le mur de miniatures ouvert, quatre ou cinq agents en vol — deux ou trois qui avancent sur des tickets de fonctionnalité, un qui traque un bug, un ou deux qui font des revues de code. Le lead n'écrit pas de code minute par minute ; il **surveille la flotte**, n'intervenant qu'aux points de contrôle (un push, une PR, une action risquée) et quand une miniature passe au jaune ou qu'un agent s'égare visiblement. Les tickets viennent du vrai tracker de l'équipe ; les revues sont de vraies PRs et changelists que le reste de l'équipe voit atterrir.

Les contraintes fortes que ce projet de jeu imposait sont exactement les fonctionnalités qui ont fini par le plus compter :

- **L'arbre d'assets était énorme**, donc les slots préchauffés et les espaces de travail en copy-on-write n'étaient pas un agrément — sans eux, une flotte d'agents sur cet arbre était tout simplement inabordable. C'est pourquoi ces deux idées sont l'épine dorsale de l'outil.
- **Le moteur était la source de vérité pour « est-ce que ça marche »**, donc un agent qui ne pouvait pas lancer et piloter le jeu en cours d'exécution était inutile pour la plupart du travail de gameplay. D'où l'intégration de l'application testée.
- **Le contrôle de source était Perforce pour le jeu et Git pour l'outillage**, donc un SCM agnostique au fournisseur n'était pas optionnel.
- **Une personne devait diriger de nombreux agents**, donc tout le cockpit est optimisé pour une **supervision en un coup d'œil** plutôt qu'une concentration profonde sur une seule session.

Si votre situation résonne avec l'un de ces points — un large arbre, une vraie application à tester, plus de travail qu'un seul agent ne peut gérer — la conception s'alignera étroitement sur vos besoins, parce qu'elle a été construite exactement pour cela. Si ce n'est pas le cas, la section [Faites-le vôtre](#faites-le-vôtre) traite du fait de conserver les idées et d'échanger les spécificités.

Une note sur le périmètre : ce projet n'a finalement pas trouvé de traction commerciale, et nous ne prétendons pas le contraire. Mais le problème d'ingénierie qu'il posait était réel — un large arbre d'assets, une flotte d'agents, une équipe — et les parties de PopBot qui l'ont résolu sont les parties documentées ici. La valeur de l'outil ne dépend pas du sort du jeu, et nous préférons l'affirmer clairement plutôt que de suggérer davantage.

---

## Workflows de bout en bout

### Un ticket de fonctionnalité

1. **Notification → boîte de réception.** Un ticket qui vous est assigné apparaît dans la boîte de réception **Tickets** (PopBot interroge Linear / Jira / GitHub Issues, classés par priorité et date d'échéance). La cloche de notification le signale.
2. **Un clic pour démarrer.** Cliquez sur la ligne du ticket. PopBot ouvre une boîte de dialogue **nouveau chat** avec par défaut votre repo et votre base (mémorisés depuis la dernière fois) — confirmez, ou ajustez l'agent/modèle/effort.
3. **Allocation de slot.** Parce que ce chat va écrire du code, PopBot **loue un slot** : il choisit un espace de travail libre, dérive le nom de branche `you/eng-123-<slug>` depuis le ticket, et bascule l'espace de travail dessus (en exécutant d'abord la séquence de sécurité de mise de côté).
4. **Ticket promu automatiquement.** Le ticket est déplacé vers **En cours** automatiquement (idempotent, fire-and-forget) de sorte que votre tableau reflète la réalité sans changement de contexte.
5. **L'agent démarre.** L'agent reçoit un premier message amorcé (votre modèle personnalisable de *démarrage de ticket*, rempli avec le titre du ticket, la description et la branche) et commence : il explore le code, fait des modifications, exécute des commandes — tout cela dans l'espace de travail de son slot.
6. **Vérification dans le slot.** Pour un changement de jeu, l'agent **lance l'application dans son slot** (un éditeur de moteur + serveur sidecar sur un second écran) et exerce la fonctionnalité — en cliquant dans l'interface, en lisant les logs, en prenant des captures d'écran — au lieu de deviner que cela fonctionne.
7. **Fin verrouillée.** Quand il est prêt à pousser, l'agent **se met en pause** (pousser est une action verrouillée). La miniature passe au jaune (« a besoin de vous »).
8. **Vous relisez & livrez.** Ouvrez le **panneau SCM**, lisez le diff, et cliquez sur **Push PR** (ou **Push draft**). L'action envoie une instruction préremplie à l'agent, qui pousse la branche et ouvre la PR / revue Swarm contre votre base.

Tout du long, vous ne regardiez pas — vous faisiez la même chose pour deux autres tickets. Vous n'êtes intervenu qu'au point de contrôle.

### Un ticket de bug

Le flux de bug est le flux de fonctionnalité avec une boucle plus serrée, et il met en valeur le **parallélisme** :

1. Un rapport de bug arrive (un ticket, ou vous démarrez un chat manuellement avec la description du bug).
2. Faites naître un chat → il loue **son propre** slot et sa propre branche. Votre chat de fonctionnalité en cours n'est absolument pas touché — espace de travail différent, branche différente.
3. L'agent reproduit le bug **en exécutant l'application dans son slot**, trouve la cause, la corrige, et relance pour confirmer que la reproduction a disparu.
4. Vous jetez un œil à la **bande de miniatures** : chat de fonctionnalité vert (terminé, en attente de votre push), chat de bug bleu (en cours). Deux agents, deux arbres isolés, zéro collision.
5. Poussez le correctif quand il se met en pause pour approbation.

### Une revue de code

1. **Notification → Revues.** Un coéquipier demande votre revue. La PR (GitHub) ou la changelist (Swarm) apparaît dans la boîte de réception **Revues**.
2. **Chat instantané, sans repo.** Cliquez dessus → un **chat de revue** s'ouvre immédiatement — pas de slot, pas de checkout, pas d'attente. Il est amorcé avec le modèle *démarrage de revue de code* (lire le code environnant, pas seulement le diff ; tracer les systèmes ; traquer de vrais bugs, races, cas limites, problèmes de sécurité et de performance).
3. **Vraie revue.** L'agent lit le diff **et** le code autour, raisonne sur la correction, et poste des **commentaires en ligne** plus un verdict (approuver / demander des changements) sur GitHub ou Swarm — puis résume les points d'alerte pour vous dans le chat.
4. **Re-revue plus tard.** Si l'auteur pousse des correctifs, cliquez sur **re-revue** : PopBot met le focus sur le chat de revue existant et dit à l'agent de regarder **uniquement les nouveaux commits**, de vérifier que chaque fil précédent est effectivement traité, et de mettre à jour sa revue.

Tout cela se passe pendant que vos chats de build continuent de tourner — les revues ne prennent jamais un slot.

### Rouvrir un chat archivé

Le travail est rarement fini du premier coup. Le flux de réouverture est de première classe :

1. Un chat de fonctionnalité a livré sa PR ; vous l'avez **fermé** pour libérer le slot. Il est maintenant dans l'**archive** (transcription entièrement préservée).
2. Deux jours plus tard, le changement reçoit des commentaires de revue. Trouvez le chat dans l'archive (recherchez par ticket, branche, ou texte) et **rouvrez-le**.
3. PopBot **relance la location d'un slot**, restaure la branche du chat dans l'espace de travail, et l'agent reprend avec son **historique entier** — il sait déjà ce qu'il a construit et pourquoi. S'il atterrit dans un slot différent d'avant, PopBot l'oriente vers le nouveau répertoire de travail.
4. Collez ou résumez les retours de revue. L'agent les traite, retest dans le slot, et pousse la mise à jour — pas de réonboarding, pas de contexte perdu.

Parce que la branche, la transcription et le raisonnement persistent tous, reprendre une tâche coûte des secondes, pas une réexplication.

---

## Contrôle de source & revue intégrés

Le contrôle de source est profondément câblé, via la CLI native de chaque fournisseur — **`gh`/`git`** pour GitHub, **`p4`** et l'API Swarm pour Perforce — de sorte que tout ce qu'un agent fait est une activité réelle que votre équipe voit aux endroits habituels.

- **Boîte de réception des revues.** Les PRs GitHub et les changelists Swarm qui attendent votre revue (et vos propres soumissions récentes) apparaissent comme des sources de chat en un clic.
- **Puces de statut PR / revue.** Chaque chat lié à un changement affiche une puce de statut en direct — Ouverte / Fusionnée / Fermée / Brouillon — que vous pouvez cliquer pour l'ouvrir sur GitHub ou dans Swarm.
- **Le panneau SCM.** Pour tout chat de build, voyez le statut de l'arbre de travail/changelist, les commits récents, et les diffs par fichier. Cliquez sur un fichier pour une superposition de diff unifié complet.
- **Actions en un clic.** Des actions basées sur des modèles, modifiables, envoient une instruction préremplie à l'agent : **Commit**, **Push PR**, **Push draft PR**, **Rendre prêt**, **Traiter la CR** (traiter les commentaires de revue), **Rebaser sur la base**. Chacune développe des variables comme `${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, et `${prurl}` de sorte que l'agent ait exactement ce dont il a besoin.
- **Création contre votre base.** Pousser ouvre la PR (ou la revue Swarm) contre la base configurée du chat, nommée selon votre convention de branche.

La revue est un chemin distinct et optimisé (voir [Une revue de code](#une-revue-de-code)) :

- **Sans repo et instantané** — pas de slot, pas de checkout. Triez une file de revues en quelques secondes.
- **Lit le contexte, pas seulement le diff** — le modèle de revue dirige l'agent à lire le code environnant, tracer les systèmes, et chercher des bugs/races/cas-limites/sécurité/perf, pas à tamponner le patch.
- **Poste là où votre équipe travaille** — commentaires en ligne et une revue soumise sur GitHub ou Swarm.
- **La re-revue est cadrée** — lors d'un second passage, l'agent examine uniquement les nouveaux commits et confirme que chaque fil précédent est réellement résolu avant de mettre à jour sa revue.
- **Entièrement personnalisable** — les prompts *démarrage de revue de code* et *re-revue* sont des modèles modifiables, de sorte que vous puissiez ajuster la rigueur, la checklist et le ton au niveau de votre équipe. La *procédure de revue elle-même* (comment votre équipe veut qu'une revue GitHub ou Perforce soit faite) est à vous de la fournir — PopBot recommande et peut en échantillonner une, mais la norme reste avec votre équipe.

## Tester dans un slot : l'application testée

Le slot d'un chat de build n'est pas juste un dossier — c'est un endroit pour **exécuter et inspecter** le travail :

- **Terminal par chat.** Un terminal intégré (xterm + un vrai PTY) épinglé à l'espace de travail du chat. Exécutez des tests, inspectez des logs, ou lancez des commandes à la main pendant que l'agent travaille. Il persiste quand vous changez de chat.
- **Intégration d'éditeur.** Chaque référence `path/to/file.ts:42` dans la transcription est un lien cliquable qui s'ouvre dans **VS Code** ou **Cursor**, résolu par rapport à l'espace de travail du chat.
- **L'application testée.** Un slot peut lancer l'**application réelle** de sorte que l'agent puisse la piloter plutôt que de deviner. Pour une application web, une CLI, ou un service, c'est essentiellement l'affaire de l'agent lui-même — il exécute vos commandes de build et de test dans le terminal du slot, sollicite le serveur en cours d'exécution, lit la sortie. PopBot n'a besoin de rien savoir de spécial à leur sujet ; l'agent les gère de la même manière que vous le feriez. Les **moteurs** de jeu sont le cas qui nécessite une gestion supplémentaire, parce que l'éditeur est un processus GUI de longue durée avec son propre cache d'assets et sans boucle naturelle de « exécuter et vérifier » en ligne de commande. Donc pour **Unity** et **Unreal**, PopBot lance un éditeur en direct + un serveur sidecar, le place sur un second écran, et l'expose à l'agent via un **serveur MCP intégré à l'éditeur**. Chaque éditeur en cours obtient son **propre port MCP dérivé de son slot** — de sorte qu'un agent ne parle qu'à *son* éditeur, jamais à celui d'un autre slot — et PopBot connecte automatiquement l'agent de chaque chat à ce point de terminaison (en mémoire, de sorte que rien n'atterrisse dans le contrôle de source). Un moteur **personnalisé** s'intègre dans le même mécanisme : PopBot fait passer l'identité du slot jusqu'à votre commande de lancement et vous câblez comment l'agent le pilote. Dans tous les cas, l'agent peut exercer l'application — cliquer dans l'interface, lire les logs, prendre des captures d'écran, vérifier le comportement — et PopBot gère le cycle de vie de l'éditeur (démarrer le serveur, vérifier sa santé, démarrer l'éditeur, placer sa fenêtre, l'arrêter à la libération), en budgétisant les instances concurrentes contre la RAM disponible.

C'est la différence entre un agent qui *pense* que son changement fonctionne et un qui l'a *vu* fonctionner. Rien de tout cela n'est spécifique aux jeux — le développement web et autre sont des usages égaux de première classe. Les moteurs de jeu portent simplement l'état supplémentaire (un cache d'assets chaud, un éditeur en tant qu'application testée) dont le système doit être conscient, et ce même état supplémentaire est ce qui en fait la démonstration la plus nette des parties novatrices de l'outil : slots préchauffés, espaces de travail en copy-on-write, et une application en cours d'exécution que l'agent peut piloter.

## Permissions & sécurité

Autonomie avec un plancher strict :

- **Auto-autorisé (silencieux) :** lectures, modifications et commandes shell **à l'intérieur de l'espace de travail du slot**, appels aux propres services du slot (y compris son éditeur MCP), et opérations internes de l'agent. L'agent travaille simplement.
- **Toujours verrouillé (se met en pause pour vous) :** `git push` / `p4 submit` / reset / force, tout ce qui est **en dehors** de l'espace de travail, ouverture de PRs ou de revues, suppression en dehors d'un répertoire temporaire, envoi de messages (Slack/email), modification de la configuration système ou d'agent, et appels réseau vers des hôtes non autorisés.
- **Tout le reste :** vous invite à décider.

Quand vous approuvez quelque chose, vous pouvez l'accorder **une fois**, **pour la session**, ou **durablement** (toujours autoriser cet outil/cette cible). Les serveurs MCP peuvent être autorisés de la même manière — autorisez le MCP d'éditeur d'un slot une fois et c'est mémorisé, l'octroi étant visible et révocable dans Préférences → Permissions (PopBot active les MCP d'éditeur Unity/Unreal de cette manière automatiquement). Les octrois sont par chat ou globaux et tous **révocables**. Le plancher de refus strict (push/submit, réseau, hors-arbre) vit dans le code et n'est pas surchargeable par des règles d'interface — de sorte qu'un octroi mal configuré ne puisse pas laisser un agent atterrir sur la branche principale de son propre chef.

## Localisation

L'interface entière de PopBot — menus, paramètres, boîtes de dialogue, tout — est entièrement localisée. L'application est livrée en **douze langues** : anglais, espagnol, français, allemand, japonais, coréen, chinois simplifié, portugais brésilien, russe, italien, polonais et ukrainien — modifiable à tout moment depuis le menu des langues sans redémarrage. Si vous forkez PopBot, chaque locale est un catalogue de messages unique, de sorte qu'ajouter ou ajuster une langue est un changement contenu plutôt qu'une chasse au trésor à travers l'interface.

## Préférences

Tout est configuré dans l'application (aucun fichier de configuration à modifier) :

- **Agents** — modèle et effort de raisonnement par défaut, séparément pour les nouveaux chats vs. les revues de code.
- **Dépôts** — ajoutez/modifiez des dépôts via un assistant orienté dossier, conscient du SCM : chemin, fournisseur (Git/Perforce), branche ou stream de base, couleur, préfixe de slot, répertoire des espaces de travail, mode pool de slots vs. éphémère.
- **Runtime & slots** — taille du pool (combien d'agents s'exécutent à la fois), pré-création/suppression de slots, rétention des pièces jointes, rafraîchissement de l'image de base pour les espaces de travail en copy-on-write.
- **Intégrations** — connectez Linear, Jira, GitHub, et Helix Swarm (identifiants stockés localement) ; taux d'interrogation de revue configurables par fournisseur ; test avant sauvegarde.
- **Contrôle de source** — convention de nom de branche, base par défaut, et les modèles d'action modifiables.
- **Applications externes** — terminal (iTerm), éditeur (VS Code / Cursor), binaires de moteur et options par moteur (y compris le port de base du MCP d'éditeur), profil Chrome optionnel pour le routage d'URL.
- **Modèles de prompt** — chaque prompt amorcé (démarrage de ticket, démarrage/re-revue, et chaque action) est modifiable, avec une carte de référence de variables.
- **Permissions** — examinez et révoquez les octrois durables, y compris les autorisations par serveur MCP.
- **Notifications** — placement des toasts et comportement d'alerte.
- **Langue** — changez la locale de l'interface.

> Pour une référence panneau par panneau avec captures d'écran, voir le **[Guide de configuration](CONFIGURATION.md)**.

## Faites-le vôtre

Adapter PopBot est un usage principal prévu. Il est publié comme une implémentation de référence, et sa conception reflète une vision de la meilleure façon de construire des logiciels à l'ère de l'IA : une équipe prend une forme fonctionnelle, comprend *pourquoi* elle est façonnée ainsi, et la remodèle autour de son propre stack, de ses outils et de ses conventions plutôt que d'adopter un outil dont les décisions sont figées pour elle.

Sa forme est générale : **agents + slots isolés, préchauffés, en copy-on-write + une boîte de réception en tant que file d'attente + une application testée.** Ce modèle s'applique à la plupart des équipes qui exécutent plus d'un agent de codage à la fois. Il est **sous licence MIT** et structuré pour être forké — le code est organisé comme des *fournisseurs derrière de petites interfaces communes*, de sorte qu'une partie puisse être ajoutée ou échangée sans toucher au reste. L'approche générale : conserver les idées centrales, remplacer les instances spécifiques.

Les points de rupture sont listés ci-dessous avec *le comment, le où et le pourquoi* pour chacun. Chacun est une interface avec des implémentations modulaires ; le chemin pratique consiste à repérer un modèle sur une implémentation existante et à ajouter la vôtre.

- **Échangez l'application testée.** *Pourquoi :* tout l'intérêt est un agent qui *exécute et vérifie* votre application, et « votre application » est différente pour chacun. *Où :* `src/shared/gameEngine.ts` (descripteurs de moteur, câblage MCP) et `src/main/ipc/apps.ts` (lancement + cycle de vie). Unity et Unreal sont deux implémentations ; le hook de **moteur personnalisé** fait déjà passer l'identité du slot (`POPBOT_SLOT`, ports dérivés) jusqu'à votre commande de lancement, donc câbler votre application web, CLI, ou harnais de test revient à « remplir la commande de lancement et comment l'agent lui parle ».
- **Redirigez la boîte de réception ailleurs.** *Pourquoi :* la boîte-de-réception-en-tant-que-file-d'attente est l'idée durable ; le tracker spécifique est un détail. *Où :* `src/main/tickets/` — implémentez l'interface `TicketSource` dans `provider.ts`, normalisez les données de votre tracker dans les DTO partagés, et enregistrez-le dans `registry.ts` (l'en-tête du fichier note littéralement : *« ajouter un tracker, c'est une seule ligne ici plus son module `*Source.ts` »*). Linear, Jira, et GitHub Issues sont les exemples concrets. Le renderer ne se branche jamais sur l'id du fournisseur, donc vous ne touchez pas à l'interface.
- **Ajoutez ou échangez le contrôle de source.** *Pourquoi :* « isoler un changement, le réviser, l'intégrer » est agnostique au fournisseur ; Git et Perforce ne sont que deux backends. *Où :* `src/main/scm/` — étendez la classe de base `SourceControlProvider` (`provider.ts`), en suivant `gitProvider.ts` / `perforceProvider.ts`. Le comportement qui ne s'abstrait pas proprement est **détecté par capacité**, pas par `if (provider === …)`, de sorte qu'un VCS très différent puisse même opter pour sa propre interface client sans que les appelants aient à le traiter comme un cas particulier.
- **Échangez la surface de revue.** *Pourquoi :* les revues devraient atterrir là où votre équipe regarde déjà. *Où :* les fournisseurs de revue derrière `src/main/reviews/` (PRs GitHub via `git/reviews.ts`, changelists Swarm via `p4/swarmReviews.ts`). La *procédure de revue elle-même* — comment votre équipe veut qu'une revue soit faite — n'est **pas** intentionnellement livrée dans l'outil ; c'est un skill propre à votre équipe que vous fournissez, de sorte que PopBot recommande et échantillonne mais n'impose jamais votre norme.
- **Recâblez les actions et les prompts.** *Pourquoi :* les conventions de branches, les flux PR/revue, et comment vous briefez un agent sont propres à l'équipe. *Où :* aucun code nécessaire — les modèles d'action git et chaque prompt amorcé (démarrage-ticket, démarrage/re-revue) sont **modifiables dans les Préférences**, avec une carte de référence de variables. Changez la rigueur, la checklist, le ton.
- **Conservez le noyau.** *Pourquoi :* ce sont les idées qui font fonctionner l'ensemble, et ce sont les parties que vous devriez être le plus lent à changer. Les slots préchauffés, les espaces de travail en copy-on-write (`src/main/shado/`), les chats persistants, le plancher de permission codé en dur, et le cockpit multi-agents sont l'épine dorsale durable. Tout le reste est fait pour bouger.

Pour les frontières de processus, l'IPC, et où vit chaque sous-système, lisez le document **[Architecture](ARCHITECTURE.md)** — la carte pour trouver le point de rupture que vous voulez changer. Pour le modèle objet (Chat, Slot, AgentSession et leurs cycles de vie), voir **[Core Model](CORE_MODEL.md)**.

Pour les équipes qui exécutent plus d'un agent à la fois, ceci est un point de départ fonctionnel destiné à être démonté et reconstruit autour d'un workflow différent.

---

*Certaines intégrations mentionnées dans le [cahier des charges de conception](POPBOT_DESIGN.md) original (Slack, Sentry, et d'autres) existent comme des ébauches de connexion plutôt que des flux complets ; Linear, Jira, GitHub, et Helix Swarm sont les sources de boîte de réception entièrement câblées. Ce guide décrit comment l'application se comporte réellement aujourd'hui.*
