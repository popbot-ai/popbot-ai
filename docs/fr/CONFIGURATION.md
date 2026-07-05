*Languages: [English](../CONFIGURATION.md) · [Español](../es/CONFIGURATION.md) · [Français](CONFIGURATION.md) · [Deutsch](../de/CONFIGURATION.md) · [日本語](../ja/CONFIGURATION.md) · [한국어](../ko/CONFIGURATION.md) · [简体中文](../zh-CN/CONFIGURATION.md) · [Português (Brasil)](../pt-BR/CONFIGURATION.md) · [Русский](../ru/CONFIGURATION.md) · [Italiano](../it/CONFIGURATION.md)*

# Configurer PopBot

Tout dans PopBot est configuré dans l'application via les **Préférences** (l'icône d'engrenage dans la barre de titre, ou `⌘,`) — il n'y a aucun fichier de configuration à modifier à la main. Ce guide parcourt chaque panneau dans l'ordre où la navigation les liste, ce qui est à peu près l'ordre dans lequel vous les configureriez la première fois.

> Les identifiants que vous saisissez (Linear, Jira, GitHub, Perforce, etc.) sont stockés **localement sur votre machine** dans la base de données propre à l'application — jamais dans ce dépôt.

- [Intégrations](#intégrations) · [Agents](#agents) · [Runtime & slots](#runtime--slots) · [Dépôts](#dépôts) · [Contrôle de source](#contrôle-de-source) · [Applications externes](#applications-externes) · [Modèles de prompt](#modèles-de-prompt) · [Revues de code](#revues-de-code) · [Notifications](#notifications) · [Permissions](#permissions) · [Langue](#langue)

---

## Intégrations

Deux groupes indépendants vivent ici : la **source de tickets** qui alimente la file d'attente Tickets, et les **moteurs de jeu** qu'un slot peut lancer.

![Integrations — Linear](../../images/preferences_integrations1.png)

### Source de tickets

Un seul tracker d'issues actif alimente la file d'attente Tickets. Choisissez-le dans le sélecteur en haut du panneau ; le formulaire de configuration ci-dessous s'adapte en conséquence. Un seul tracker est actif à la fois.

- **Linear** — collez une clé API (depuis *linear.app → Settings → API*). Définissez optionnellement une **clé d'équipe** (par ex. `ENG`) pour cadrer le flux de tickets à une seule équipe, et choisissez un **Projet** pour l'affiner davantage. Sauvegarder vérifie la clé et montre en tant que qui elle s'est connectée.
- **Jira** — saisissez l'URL de votre site (`https://your-domain.atlassian.net`), l'email du compte, et un jeton API (depuis *id.atlassian.com → Security → API tokens*). Cadrez optionnellement à un **Projet** et ajoutez un filtre **JQL** (par ex. `labels = backend`). Sauvegarder vérifie les identifiants avant de les conserver.
- **GitHub** — les GitHub Issues n'ont besoin d'aucun identifiant ici : le fournisseur délègue à la CLI `gh` que vous avez déjà authentifiée pour les revues et les actions git, et la file d'attente couvre les mêmes dépôts configurés sous [Dépôts](#dépôts). Le formulaire est une vérification de statut qui confirme que `gh` est installé et authentifié et rapporte combien de dépôts il couvre.

Chaque tracker avec des identifiants les vérifie à la **Sauvegarde** avant de les conserver, et affiche une pastille de statut *Connecté / Non connecté*.

### Moteurs de jeu

Contrairement à la source de tickets à sélection unique, les moteurs sont **indépendants** — vous pouvez activer Unity, Unreal, et un moteur personnalisé en même temps. Chaque moteur activé ajoute un bouton **Exécuter** à la barre du chat qui lance son éditeur depuis l'espace de travail du slot du chat.

- **Activé** — une case à cocher par moteur qui affiche (ou masque) le bouton Exécuter de ce moteur sur la barre du chat.
- **Installations détectées / binaire de l'éditeur** *(Unity, Unreal)* — PopBot scanne les éditeurs installés (installations Unity Hub / Epic), avec un lien de **rebalayage** ; choisissez une version détectée, ou saisissez un chemin absolu de **binaire de l'éditeur** pour outrepasser le menu déroulant.
- **Commande d'exécution** *(Personnalisé)* — une commande shell libre exécutée dans le répertoire du projet, avec des variantes **macOS / Linux** et **Windows** séparées pour qu'une seule configuration fonctionne sur toutes les plateformes. Un moteur personnalisé n'a pas de détection automatique ; PopBot fait passer l'identité du slot jusqu'à votre commande via une variable d'environnement `POPBOT_SLOT` pour que vous puissiez câbler votre propre flux « exécuter et vérifier ».
- **Sous-chemin du projet** — le chemin du projet du moteur relatif à la racine de l'espace de travail (le dossier du projet Unity ; le dossier contenant le `.uproject` ; ou le répertoire de travail dans lequel s'exécute une commande personnalisée). Laissez vide si la racine de l'espace de travail *est* le projet.
- **Utiliser MCP + Port MCP de base** *(Unity, Unreal)* — quand la case **Utiliser MCP** est cochée, l'éditeur est lancé en pointant vers un serveur MCP intégré à l'éditeur pour qu'un agent puisse le piloter. Chaque slot obtient son **propre port** de sorte que les slots parallèles n'entrent jamais en collision : le port est `basePort + (slotId − 1)` (slot 1 → base, slot 2 → base + 1, …). Le champ **Port MCP de base** définit le port du slot 1 ; il vaut par défaut **8000 pour Unreal** et **8080 pour Unity** (correspondant à la valeur par défaut du plugin MCP de chaque moteur) et est restauré à cette valeur par défaut quand il est effacé.
- **Afficher le chemin du projet dans la barre de titre** *(Unity)* — un bouton **Installer le script de barre de titre** qui dépose un petit script d'éditeur dans votre projet Unity pour que chaque Editor ouvert affiche son chemin de projet complet dans sa barre de titre, rendant les fenêtres de slot faciles à distinguer. Le script peut être commité sans risque.

> **Slack** et **Sentry** restent des ébauches de connexion plutôt que des sources de boîte de réception câblées, donc ils ne sont pas affichés comme des panneaux ici aujourd'hui. Ils peuvent être réactivés sans changements structurels ; voir la note à la fin du [Guide des fonctionnalités et workflows](GUIDE.md).

## Agents

**Effort de raisonnement** du modèle par défaut pour les chats nouvellement créés (les chats existants conservent le leur jusqu'à ce que vous le changiez dans le compositeur de chat).

![Agents](../../images/preferences_agents.png)

- Définissez l'effort indépendamment pour **Claude** et **Codex**, et séparément pour :
  - **Nouveaux chats** — chats génériques et chats de ticket.
  - **Revues de code** — chats de revue de PR, chats de repli de re-revue, et notifications de revue.

Un effort plus élevé signifie un raisonnement plus profond et un usage d'outils plus approfondi, à un coût et une latence plus élevés. Les revues veulent souvent une profondeur différente des constructions de fonctionnalités — d'où la séparation.

## Runtime & slots

Ce panneau contrôle la **rétention des pièces jointes**. (Le dimensionnement du pool de slots est maintenant par dépôt et se trouve sous [Dépôts](#dépôts) — voir la note à cet endroit.)

![Runtime & slots](../../images/preferences_slots.png)

- **Conserver les pièces jointes pendant** — combien de temps les fichiers et images que vous attachez à un chat sont conservés dans le stockage propre de PopBot (60 jours par défaut, plage 1–365). Les pièces jointes sont copiées dans le stockage de PopBot de sorte qu'elles continuent de s'ouvrir depuis l'historique du chat même après que l'original a été déplacé ; un balayage au démarrage supprime les copies plus anciennes que cette fenêtre pour que le dossier ne puisse pas grossir sans limite.

> La capture d'écran ci-dessus peut dater d'avant la séparation du dimensionnement du pool de slots dans le flux par dépôt.

## Dépôts

Chaque chat vit dans un **dépôt**. Ce panneau liste vos dépôts et c'est là que le contrôle de source, les slots, et les espaces de travail en copy-on-write par dépôt sont configurés.

![Repositories](../../images/preferences_repositories.png)

- **Ajouter un dépôt** ouvre un assistant orienté dossier : choisissez un dossier, et PopBot **détecte son contrôle de source** (Git ou Perforce) et se branche en conséquence. Vous définissez ensuite un id, une couleur d'accent, un préfixe de slot, et un nombre de slots.
  - Les dépôts **Git** choisissent le mode **slots** (un pool réutilisé d'espaces de travail — le défaut, affiché comme `slots × N`) ou **éphémère** (un espace de travail frais par chat). Le mode slots garde les caches de build chauds entre les chats.
  - Les dépôts **Perforce** sont toujours en mode slot. L'assistant capture la connexion P4, exécute une **vérification préalable du disque**, et construit une **image de base** figée de l'arbre synchronisé ; les slots sont alors créés comme des enfants en copy-on-write de cette base (voir ci-dessous).
- **Espaces de travail en copy-on-write.** L'espace de travail d'un slot est un dossier en copy-on-write qui partage une seule **image de base** du dépôt et ne stocke que les blocs qu'il modifie, via `shado` (la couche d'espace de travail fantôme de PopBot) : **VHDX différencié** sur Windows, copy-on-write natif (APFS / reflink) sur macOS et Linux. Dix slots sur un arbre à l'échelle du téraoctet coûtent à peu près le disque d'un seul dépôt plus le petit delta de chaque slot — ce qui est ce qui permet à de larges arbres Perforce de participer. L'image de base est construite une fois, comme une étape de l'assistant Ajouter-un-dépôt.
- **Le mode est permanent.** Le mode slots-vs-éphémère d'un dépôt est fixé à la création ; en changer orphelinerait les espaces de travail des chats en cours.
- **Modifier** un dépôt pour changer sa couleur d'accent, sa branche de base par défaut (Git), ou le répertoire de travail de l'agent Perforce, et pour **redimensionner les slots** (agrandir ou réduire le pool un espace de travail à la fois, conditionné à ce que tous les chats de ce dépôt soient fermés).
- **Supprimer** un dépôt ; la confirmation vous avertit si des chats y font encore référence.

Plusieurs dépôts s'exécutent côte à côte, chacun avec son propre pool de slots et sa couleur d'accent (la couleur teinte les pastilles de slot de ce dépôt pour que vous puissiez distinguer les chats en un coup d'œil). Chaque carte de dépôt affiche son fournisseur de contrôle de source et son mode.

## Contrôle de source

Paramètres globaux de contrôle de source et les modèles d'action modifiables. Les panneaux Git et Perforce sont affichés côte à côte, parce que le fournisseur d'un dépôt est détecté par dossier et les deux peuvent être utilisés en même temps.

![Source control](../../images/preferences_source_control.png)

- **Limite de fichiers de la vue de changement** *(partagée)* — le nombre maximal de fichiers affichés dans la vue de changement avant que la liste ne soit plafonnée. S'applique à la fois à Git et à Perforce.

**Git**

- **Nom d'utilisateur de branche** — le préfixe pour les nouvelles branches : `<username>/<ticket>-<slug>`.
- **Modèles d'action** — les prompts que le panneau SCM envoie à l'agent pour **Commit**, **Push PR**, **Push draft PR**, **Rendre prêt**, **Traiter la CR**, et **Rebaser sur la base**. Chacun prend en charge des macros `${name}` (`${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, `${prurl}`…).

**Perforce**

- **Valeurs par défaut de connexion** — le chemin du binaire `p4`, le port serveur par défaut, et l'utilisateur par défaut, qui préremplissent l'étape de connexion Perforce de l'assistant Ajouter-un-dépôt.
- **Options de transfert / soumission** — nombre de threads de synchronisation parallèles, et si les fichiers inchangés doivent être annulés à la soumission.
- **Intervalle d'interrogation des revues Swarm** — la fréquence à laquelle le panneau Revues interroge Helix Swarm pour les changelists en attente de votre revue. Ceci est **indépendant de l'interrogation de GitHub** et a un **plancher de 30 secondes** ; augmentez-le pour alléger la charge sur un serveur Perforce/Swarm partagé à grande échelle.
- **Modèles d'action Perforce** — les prompts que le panneau Perforce envoie à l'agent pour **CR** (ouvrir/mettre à jour une revue Helix Swarm), **Exécuter les tests**, et **Réviser & commiter**, chacun avec des macros `${name}`.

## Applications externes

Les applications de bureau que PopBot lance depuis la rangée d'icônes d'un chat, toutes pointées vers l'espace de travail du slot de ce chat.

![External apps](../../images/preferences_external_apps.png)

- **Terminal** — quel terminal le lanceur d'icône de terminal ouvre (par ex. iTerm2).
- **Shell de terminal (Windows)** — le shell utilisé par le panneau de terminal intégré à l'application : PowerShell, Invite de commandes, ou PowerShell 7. S'applique aux terminaux ouverts après le changement.
- **Éditeur de code** — VS Code ou Cursor ; également utilisé pour les liens cliquables `file.ts:42` dans les lignes de l'outil Edit.
- **Client Git** — par défaut GitHub Desktop.
- **Profil Chrome pour les URLs** — épinglez l'ouverture de liens à un profil Chrome spécifique (par son nom de *répertoire* de profil) de sorte qu'ils atterrissent toujours dans votre compte de travail.

> Les binaires de moteur et leurs options MCP sont configurés sous [Intégrations → Moteurs de jeu](#intégrations), pas ici.

## Modèles de prompt

Le premier message que PopBot envoie quand un chat naît. Chaque modèle est modifiable, avec une carte de référence des macros `${name}` qui lui sont disponibles. (Les modèles d'action du panneau SCM se trouvent sous [Contrôle de source](#contrôle-de-source).)

![Prompt templates](../../images/preferences_prompt_templates.png)

- **Démarrage de ticket** — déclenché quand vous faites naître un chat depuis un ticket, quelle que soit la source (Linear, Jira, ou GitHub Issues). Les macros incluent `${ticketid}`, `${tickettitle}`, `${markdown}`, `${branch}`, et `${slot}`.
- **Démarrage de revue de code** — déclenché quand vous faites naître un chat depuis une revue — une PR GitHub ou une changelist Helix Swarm. Le défaut dirige l'agent à utiliser le skill de revue, lire le code environnant (pas seulement le diff), et traiter le chat comme lecture seule.
- **Re-revue** — déclenché quand vous re-révisez un chat de revue existant ; il cadre l'agent aux nouveaux commits uniquement.

Ajustez-les pour encoder les conventions, les checklists, et le ton de votre équipe.

## Revues de code

Contrôles pour la boîte de réception **Revues**. La file d'attente affiche les PRs GitHub et les changelists Helix Swarm en attente de votre revue ; les PRs que vous avez déjà révisées sont automatiquement retirées.

![Code reviews](../../images/preferences_code_reviews.png)

- **Fenêtre du cache de recherche** — combien de jours en arrière le sélecteur **+ Ajouter** fait correspondre approximativement les tickets et PRs récents (plus grand = plus consultable, actualisation légèrement plus lente et plus de budget API). Les tickets qui vous sont assignés sont toujours inclus quel que soit ce seuil.
- **Ignorer par titre** — sous-chaînes (une par ligne, insensible à la casse) qui retirent une PR de la file d'attente.
- **Ignorer par auteur GitHub** — logins de bot/auteur (un par ligne, par ex. `renovate[bot]`) à mettre en sourdine.

> Les **taux d'interrogation** de revue sont configurés par fournisseur, pas ici : l'intervalle d'interrogation Helix Swarm se trouve sous [Contrôle de source → Perforce](#contrôle-de-source), indépendant de l'interrogation de GitHub, de sorte qu'un serveur Perforce/Swarm partagé puisse être protégé sans ralentir GitHub.

## Notifications

Comment les alertes apparaissent.

![Notifications](../../images/preferences_notifications.png)

- **Noms VIP** — les personnes dont les messages sont toujours élevés en priorité urgente. Comparés comme des sous-chaînes insensibles à la casse du nom d'affichage, donc gardez les noms spécifiques.
- **Placement des toasts** — *Haut-centre, vole vers la cloche à la fermeture* (par défaut), ou toasts classiques dans le coin supérieur droit. Le bouton bascule s'applique immédiatement.
- **Tester le flux de nouvel élément** — marque temporairement quelques éléments réels de la file d'attente comme NOUVEAU pour prévisualiser le comportement de la puce/pastille (rien n'est persisté). Ceci est une aide de développement temporaire.

## Permissions

La valeur par défaut globale pour chaque outil d'agent, et le plancher sous le mode autonome.

![Permissions](../../images/preferences_permissions.png)

- Pour chaque outil (**Bash**, **Read**, **Write**, **Edit**, **Grep**, **Glob**, **WebFetch**, **WebSearch**, …) : **Demander** (invite à chaque fois — le défaut), **Autoriser** (approbation automatique), ou **Refuser** (rejet automatique).
- **Autorisations par serveur MCP.** Le serveur MCP d'éditeur d'un slot (Unity, Unreal, ou tout serveur MCP qu'un agent charge) peut être autorisé de ces trois mêmes manières. Autoriser le MCP d'éditeur d'un slot une fois est mémorisé, et l'octroi est visible et révocable ici — affiché comme `unityEditor → all tools` / `unrealEditor → all tools` plutôt que l'espace de noms brut. PopBot active les MCP d'éditeur Unity et Unreal de cette manière automatiquement ; une règle par outil qui diffère d'un joker est conservée comme une surcharge.
- Les règles par chat (définies depuis la carte de permission via *Autoriser ce chat* / *Refuser ce chat*) outrepassent ces globales, de sorte qu'un seul chat puisse verrouiller un outil que vous avez par ailleurs autorisé partout.

> Un plancher de refus strict — `git push` / `p4 submit`, réseau vers des hôtes non autorisés, tout ce qui est en dehors de l'espace de travail — vit dans le code et n'est **pas** surchargeable ici, de sorte qu'une règle mal configurée ne puisse pas laisser un agent atterrir sur la branche principale de son propre chef.

## Langue

L'interface de PopBot est entièrement localisée.

- **Langue d'affichage** — changez la locale de l'interface depuis le menu des langues, qui liste chaque langue dans son propre nom. Les locales livrées sont anglais, espagnol, français, allemand, chinois (simplifié), japonais, coréen, et portugais (brésilien). La plupart du texte et les menus se mettent à jour immédiatement ; quelques chaînes système finissent leur mise à jour après un redémarrage. Les nouvelles fenêtres et le menu de l'application utilisent aussi cette langue.

---

Voir le **[Guide des fonctionnalités et workflows](GUIDE.md)** pour voir comment ces paramètres se déroulent dans de vrais workflows.
