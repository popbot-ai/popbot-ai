*Languages: [English](../USER_STORIES.md) · [Español](../es/USER_STORIES.md) · [Français](USER_STORIES.md) · [Deutsch](../de/USER_STORIES.md) · [日本語](../ja/USER_STORIES.md) · [한국어](../ko/USER_STORIES.md) · [简体中文](../zh-CN/USER_STORIES.md) · [Português (Brasil)](../pt-BR/USER_STORIES.md) · [Русский](../ru/USER_STORIES.md) · [Italiano](../it/USER_STORIES.md)*

# User Stories

La référence « à quoi ressemble le succès » pour PopBot. Capturée le 2026-05-01. Chaque choix d'implémentation devrait pouvoir se retracer à l'une d'elles.

L'utilisateur est un développeur unique (Ben) exécutant PopBot sur sa propre machine. Le « je » ci-dessous, c'est lui.

> **Statut (annotation ajoutée en 2026-07, à la publication).** Les user stories ci-dessous sont les *user stories fondatrices* capturées en 2026-05, préservées ici comme l'enregistrement original de l'intention de conception. PopBot a depuis été généralisé bien au-delà de ce premier périmètre mono-utilisateur, Unity/Linear/Slack/GitHub — il couvre maintenant Git et Perforce, Unity et Unreal, Linear/Jira/GitHub Issues, les PRs GitHub et Helix Swarm, et est livré localisé en plusieurs langues sous licence MIT. Ce document n'est intentionnellement *pas* rétroadapté pour correspondre ; traitez-le comme de l'histoire, et voir [GUIDE.md](GUIDE.md) pour l'ensemble de fonctionnalités actuel. Les user stories US-1..US-9 et la capture de 2026-05 sont inchangées.

---

## US-1 · Conscience de la file d'attention

> *« Je devrais être conscient des problèmes de haute priorité, des messages Slack, et des autres PRs auxquels je dois prêter attention. »*

Trois sources affichées ensemble en haut de la fenêtre :

- **Tickets Linear** qui me sont assignés, classés par priorité + date d'échéance.
- **Messages Slack** qui me sont adressés (DM, @mentions, canaux que je possède). *Nouvelle exigence ; pas dans la conception originale — voir [Déviations](#déviations-et-ajouts).*
- **PRs GitHub** demandant ma revue.

Chaque ligne montre assez en un coup d'œil pour trier sans cliquer (titre, source, ancienneté, indicateur de priorité). Les éléments de haute priorité se distinguent visuellement de ceux de basse priorité.

**Correspond à :** [POPBOT_DESIGN.md → Disposition de l'application](POPBOT_DESIGN.md#disposition-de-lapplication) (panneaux Tickets / Reviews — étendre avec un panneau Slack).

---

## US-2 · Activation en un clic

> *« Je devrais pouvoir facilement initier une activité sur n'importe lequel de ces éléments, et ouvrir un chat pour commencer le travail. »*

Cliquer sur n'importe quelle ligne de la file d'attention fait naître un nouveau chat amorcé pour ce travail :

- Ticket Linear → chat amorcé avec le corps du ticket, branche nommée pour la clé du ticket, prompt d'agent prérempli.
- Message Slack → chat amorcé avec le contexte de la conversation, prêt à rédiger une réponse ou à lancer un vrai travail.
- PR → chat amorcé avec le diff et la checklist de revue.

Aucune friction de configuration entre « je vois quelque chose que je dois traiter » et « un agent y travaille ».

**Correspond à :** [POPBOT_DESIGN.md → Disposition de l'application](POPBOT_DESIGN.md#disposition-de-lapplication) (« Cliquez sur une ligne → faites naître un chat amorcé pour ce travail »).

---

## US-3 · Vrai test de jeu dans le chat

> *« Les chats devraient pouvoir engager une instance Unity et exécuter unity/server quand nécessaire pour qu'ils puissent tester et déboguer le travail. »*

Quand un chat a besoin de vérifier un comportement dans le vrai jeu, le chat acquiert un slot, lance Unity (placé sur l'écran 2), et lance optionnellement le serveur sidecar. L'agent pilote le jeu via le MCP intégré à l'Editor — en entrant en mode Play, en cliquant dans l'interface, en prenant des captures d'écran, en lisant les logs, en vérifiant l'état.

Acquérir un slot est la partie lente la première fois (~15-30 s à froid) ; l'activité suivante est collante (~50 ms).

**Correspond à :** [POPBOT_DESIGN.md → Types de chat](POPBOT_DESIGN.md#types-de-chat) (Client Test / Server Test), [Slots](POPBOT_DESIGN.md#slots--lunité-durable), [Surface d'automatisation MCP](POPBOT_DESIGN.md#surface-dautomatisation-mcp).

---

## US-4 · Achèvement autonome de bout en bout avec preuve

> *« Les agents devraient pouvoir travailler entièrement de manière autonome, et corriger/déboguer et compléter un ticket entier, y compris en livrant une preuve que le correctif/changement a fonctionné comme requis dans un document markdown inspectable. »*

En mode autonome, l'agent exécute un cycle complet lire → reproduire → corriger → vérifier sans intervention, et écrit un artefact `proof.md` à la fin. La preuve contient :

- **Repro** — les étapes exactes qui ont démontré le bug.
- **Avant** — captures d'écran + dumps de logs filtrés depuis l'état cassé.
- **Cause racine** — le diagnostic de l'agent.
- **Correctif** — le diff ou un résumé des changements.
- **Après** — captures d'écran + dumps de logs propres depuis l'état corrigé.
- **Vérification** — une relance de la reproduction, réussie maintenant.

Je peux ouvrir `proof.md` et décider si le travail est bon sans avoir à relancer quoi que ce soit moi-même. La pause pour revue n'est nécessaire que pour les opérations risquées (`git push`, `gh pr create`, etc.).

**Correspond à :** [POPBOT_DESIGN.md → Mode autonome](POPBOT_DESIGN.md#mode-autonome), [Artefacts de preuve](POPBOT_DESIGN.md#artefacts-de-preuve-livrable-de-débogage-de-lagent).

---

## US-5 · Multitâche facile via les miniatures

> *« Je devrais pouvoir facilement faire du multitâche entre les agents, en cliquant sur les miniatures. »*

La bande de miniatures est la surface de navigation principale pour le travail parallèle. Une rangée d'aperçus compacts — un par chat — me permet de sauter entre agents instantanément. Cliquer sur une miniature amène ce chat au premier plan ; les autres chats continuent de s'exécuter en arrière-plan.

La miniature elle-même communique l'état, pas seulement l'identité. Voir US-6.

**Correspond à :** [POPBOT_DESIGN.md → Disposition de l'application](POPBOT_DESIGN.md#disposition-de-lapplication) (rangée de miniatures), Phase 3 dans [PHASING.md](PHASING.md).

---

## US-6 · Statut en un coup d'œil

> *« Je devrais pouvoir facilement me faire une idée de ce que fait un agent, et s'il a besoin d'assistance ou de direction de ma part, en un coup d'œil. »*

Chaque miniature de chat montre son état actuel sans que j'aie à cliquer dedans :

| Couleur | Signification |
|---|---|
| Bleu | En cours |
| Vert | Tâche terminée |
| **Jaune** | **En pause — a besoin de moi** |
| Rouge | En erreur |
| Gris | Inactif / non démarré |

Le jaune est celui qui exige de l'attention. Parcourir la rangée de miniatures devrait répondre à « quelqu'un est-il coincé ? » en moins d'une seconde. Au-delà de la couleur, la miniature affiche une brève indication de progression (dernière action, étape actuelle) pour que je puisse décider si je dois plonger dedans.

**Correspond à :** [POPBOT_DESIGN.md → Couleurs de statut](POPBOT_DESIGN.md#couleurs-de-statut-miniature-de-chat).

---

---

## US-7 · Récupérer et continuer depuis n'importe où

> *« Je devrais pouvoir facilement récupérer et continuer avec des tickets, même ceux qui ne sont plus actifs, à partir de là où je me suis arrêté. »*

Un chat est durable. Même après l'avoir fermé, avoir redémarré PopBot, ou redémarré la machine, je peux rouvrir n'importe quel chat passé et reprendre exactement où je m'étais arrêté :

- La transcription complète se rejoue dans la colonne du chat.
- Le slot est réacquis (ou relancé à froid) sur la même branche où j'étais.
- L'état d'Unity + sidecar se restaure vers la fixture / le blob de sauvegarde pertinent s'il en était défini un.
- L'agent relit la transcription récente avant de répondre à mon prochain message — le contexte n'est pas perdu à travers le redémarrage.

Fermer un chat libère son slot ; le rouvrir le réacquiert. Le chat est l'enregistrement durable ; le slot est une infrastructure transitoire.

**Correspond à :** [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--lunité-durable) (cycle de vie slot vs. chat), [Stack technique → better-sqlite3](POPBOT_DESIGN.md#stack-technique) (persistance de la transcription). Le schéma d'enregistrement par chat vit dans `src/main/persistence/`.

---

## US-8 · Inspection par ticket : chat + Unity + logs + preuve

> *« Je devrais pouvoir facilement regarder la progression d'un ticket en affichant le contenu, l'instance serveur/Unity en cours d'exécution, les logs pertinents, l'artefact d'achèvement (markdown). »*

Pour n'importe quel chat (actif ou en pause), un clic fait apparaître tout ce dont j'ai besoin pour évaluer la progression :

- **Contenu du chat** — la transcription en cours avec le raisonnement de l'agent, les appels d'outils, et les sorties.
- **Statut serveur / Unity** — le slot est-il actif, sur quelle branche, quelle est la pile d'écrans, Unity est-il en mode Play.
- **Logs pertinents** — console Unity + serveur sidecar, filtrés sur la session du chat, défilement synchronisé.
- **Artefact d'achèvement** — le `proof.md` (et les `before/`, `after/`, `diff.patch` associés) que l'agent a produit, rendu en ligne.

C'est la vue « montre-moi ce qui s'est passé ». Pas le flux brut — la coupe transversale sélectionnée qui répond à « est-ce bien fait ? ».

**Correspond à :** [POPBOT_DESIGN.md → Disposition de l'application](POPBOT_DESIGN.md#disposition-de-lapplication) (colonne de chat + panneau de logs inférieur), [Artefacts de preuve](POPBOT_DESIGN.md#artefacts-de-preuve-livrable-de-débogage-de-lagent). Le rendu de preuve vit dans `src/renderer/chat/ProofViewer.tsx` (prévu).

---

## US-9 · Octrois de permission juste-à-temps

> *« Je devrais pouvoir facilement donner la permission aux agents de faire diverses choses qu'ils ne devraient pas être autorisés à faire entièrement de manière autonome. »*

Quand un agent veut faire quelque chose qui est sur la liste toujours-en-pause (`git push`, `gh pr create`, `rm` en dehors du slot, appels réseau vers des hôtes non autorisés, etc.), PopBot se met en pause et me demande. Le flux d'octroi est :

- Une modale apparaît avec **ce que** l'agent veut faire, **pourquoi** (la raison énoncée par l'agent), et la **commande / les arguments**.
- Je peux **autoriser une fois**, **autoriser pour ce chat / cette session**, **toujours autoriser** (règle durable par outil, par cible), ou **refuser**.
- Les règles d'autorisation s'accumulent par chat, affichées dans le panneau de paramètres du chat pour que je puisse les révoquer.
- La liste de refus codée en dur n'est jamais surchargeable depuis l'interface — voir [adr/0004](../adr/0004-canusetool-policy-boundary.md).

Le point : l'autonomie est le défaut, mais je peux approuver sans friction une action risquée spécifique sans ouvrir un terminal ou surveiller l'agent.

**Correspond à :** [POPBOT_DESIGN.md → Mode autonome](POPBOT_DESIGN.md#mode-autonome), [adr/0004 — frontière de politique canUseTool](../adr/0004-canusetool-policy-boundary.md). Le magasin d'octrois vit dans `src/main/agents/policy/`.

---

## Déviations et ajouts

Cette section signale les endroits où les user stories divergent de la conception verrouillée. Lors de l'implémentation, utilisez les user stories comme source de vérité et mettez à jour le document de conception.

### Slack comme troisième source d'attention (US-1)

La conception originale couvre les tickets Linear et les PRs non revues. Les messages Slack n'étaient pas dans le périmètre. Pour honorer US-1 :

- Ajoutez un **panneau Slack** au groupe d'onglets supérieur gauche aux côtés de Tickets et Reviews.
- Source : DM Slack, @mentions, et messages dans les canaux que je possède. Les règles de filtrage sont à déterminer par workflow de naissance de chat.
- Auth : OAuth Slack (jeton dans le trousseau via `keytar`).
- Faire naître un chat depuis un message Slack amorce l'agent avec le contexte de la conversation.

Ceci est un **sous-système entièrement nouveau** — client d'API Slack dans `src/main/slack/`, panneau dans `src/renderer/panels/slack/`. Phasez-le dans la Phase 3 de [PHASING.md](PHASING.md) aux côtés des autres panneaux, mais traitez-le comme un pair de première classe, pas une réflexion après coup.
