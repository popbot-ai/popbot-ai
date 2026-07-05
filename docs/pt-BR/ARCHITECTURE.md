*Languages: [English](../ARCHITECTURE.md) · [Español](../es/ARCHITECTURE.md) · [Français](../fr/ARCHITECTURE.md) · [Deutsch](../de/ARCHITECTURE.md) · [日本語](../ja/ARCHITECTURE.md) · [한국어](../ko/ARCHITECTURE.md) · [简体中文](../zh-CN/ARCHITECTURE.md) · **[Português (Brasil)](ARCHITECTURE.md)** · [Русский](../ru/ARCHITECTURE.md) · [Italiano](../it/ARCHITECTURE.md)*

# Arquitetura

Um mapa prático do modelo de processos do Electron e onde cada subsistema vive. Para o "porquê," veja [POPBOT_DESIGN.md](POPBOT_DESIGN.md). Para o **grafo de objetos + ciclos de vida + regras de propriedade** dos quais tudo neste documento depende, veja [CORE_MODEL.md](CORE_MODEL.md) — leia isso primeiro se algo abaixo parecer sem motivação.

## Modelo de processos

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

**Regra:** o renderer nunca toca o sistema de arquivos, nunca gera processos filho, nunca mantém estado canônico. Tudo isso é main. O renderer se inscreve em eventos e despacha intenções.

## Layout do código-fonte

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
    ├── domain.ts                # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## Contrato IPC

Todo IPC é tipado e centralizado em [`src/shared/ipc.ts`](../../src/shared/ipc.ts) — o mapa de strings `IpcChannel`, os tipos de payload de request/response, e a superfície `PopBotApi` que a ponte de preload expõe. Convenções:

- **Prefixo `pb:`** em todo nome de canal, organizado por namespace por subsistema (`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). Veja a const `IpcChannel` para a lista completa.
- **Request/response** usa `ipcRenderer.invoke` + `ipcMain.handle`. Retornos são tipados. Handlers são registrados por subsistema a partir de `main/ipc/*` e conectados em `main/index.ts`.
- **Eventos push** (stream do agente, dados de PTY, notificações, progresso de atualização, maximização de janela) usam `webContents.send` + `ipcRenderer.on`. O renderer se inscreve; main empurra.
- **Sem IPC bruto em componentes.** O script de preload (`src/preload/index.ts`) expõe a ponte tipada `window.popbot.*`; o código do renderer passa pelos hooks/buses em `renderer/src/lib/` (`useChats`, `useReviews`, `agentEventBus`, …) em vez de chamar `ipcRenderer` diretamente.

## Slot, em termos de código

Um slot não é uma única struct; é um **arrendamento numerado** (`slot_id`) mais o
worktree/clone em disco para o qual esse arrendamento aponta. O estado do arrendamento vive na linha do chat
(`chats.slot_id`, `chats.worktree_path` em `persistence/`), e o cálculo de
slot-livre é uma query sobre chats abertos segurando um slot para o repositório — o tamanho do pool
de um repositório é `repos.slot_count`. `shared/domain.ts` carrega o pequeno enum
compartilhado mais um registro `Slot` legado:

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

Aquisição / liberação / reconciliação de slot está espalhada por `git/worktrees.ts` (worktrees
git), `shado/slots.ts` + `scm/*Provider.ts` (slots VHDX + configuração de
clone/client por SCM), e os handlers `ipc/repos.ts` + `ipc/chats.ts`. Veja
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--a-unidade-durável) para a política
de arrendamento, e **Continuidade entre slots** abaixo para como o trabalho de um chat o segue
através de slots.

## Armazenamento de slot aquecido: shado VHDX copy-on-write

Para árvores em escala AAA (depósitos de jogo Perforce de 0,5–1 TB) um slot não pode ser um `git
worktree` ou um checkout completo — você não pode copiar o depósito N vezes, e uma
sincronização+build a frio leva de minutos a horas. **shado** (CLI Go empacotada, repositório irmão
`github.com/popbot-ai/shado`, invocado via `main/shado/`) fornece o substrato
de armazenamento no Windows:

- **Saturar + congelar uma base.** `shado create <repoPath>` sincroniza/copia a pasta
  do repositório em um VHDX expansível, então a congela como **somente leitura**. A base contém
  a árvore completa *mais* estado derivado aquecido (caches de build, `node_modules`,
  `Intermediate/`, `Saved/`, `DerivedDataCache/`, …).
- **Filhos de diferenciação = slots.** Cada slot é um filho VHDX copy-on-write da base
  congelada (`shado clone create --slot N`), montado via `Mount-VHD` +
  `Add-PartitionAccessPath` em uma **pasta de ponto de montagem** (não uma letra de unidade, então
  escalamos além de ~20 slots). Um slot fresco e pronto para build custa segundos e alguns GB
  de delta em vez de uma ressincronização de 1 TB + build a frio. Reset = destruir filho +
  recriar a partir da base (limpeza instantânea).
- **Layout.** Slots vivem na **mesma unidade que o repositório** (o modelo VHDX
  exige isso): `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`;
  a base + diffs + metadados de slot em `…/workspaces/<repoId>/shado`
  (`SHADO_HOME`). Caminhos são derivados em `main/shado/client.ts`
  (`popbotRootForRepo`, `shadoHomeForRepo`).
- **Elevação.** `shado create` / `clone create` / `remount` / `restore` precisam de
  administrador; o PopBot roda não-elevado, então são lançados através de um único UAC
  (`.bat` temporário + `Start-Process -Verb RunAs`). Clones criados de forma elevada acabam
  pertencendo ao grupo Administrators → o git recebe `-c safe.directory=*` por
  invocação, e clientes p4 são travados por host.
- **Reboot.** Montagens VHDX não sobrevivem a um reboot (clones desconectados + pastas
  de reparse de ponto de montagem quebradas). No lançamento detectamos repositórios de slot desconectados e
  exibimos um **modal central** ("Reconnect") no qual o usuário clica — um único UAC remonta
  todos eles (`remountReposElevated`). Veja `main/shado/base.ts`.

O caminho de worktree git (`repo.mode = 'slots'` em um repositório sem shado) ainda existe
para repositórios comuns; shado é selecionado por repositório para o caso VHDX/Perforce.

### Configuração de slot por SCM

Um slot é um **clone/client independente**, não um checkout compartilhado — este é o
fato-chave por trás da continuidade entre slots abaixo.

- **git** (`scm/gitProvider.ts`): o slot é um clone completo da base congelada.
  `ensureSlotWorktree` o estaciona em `popbot/slot-N`; `checkoutBranch` cria o
  branch do chat a partir da base **mais recente** (`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`), descartando sujeira herdada da base enquanto mantém
  caches aquecidos ignorados pelo git.
- **perforce** (`p4/*`, `scm/perforceProvider.ts`): cada slot tem seu próprio client p4
  `popbot_<repoId>_slot<N>` enraizado na montagem. A configuração é `p4 flush
  @baseChangelist` (atualização de have-table de 0 bytes contra a base congelada) + `p4 sync`
  apenas do delta base→head. Não há **`p4 reconcile`** (uma varredura de árvore de 20 min em um depósito
  de jogo): um `fs.watch` por slot registra caminhos alterados e o
  provedor abre apenas esses com `p4 edit/add/delete` direcionado. As próprias escritas
  do PopBot (sync/revert/unshelve) **pausam** o watcher para que não sejam reabertas.

## Continuidade entre slots: a casa do branch / changelist de um chat

**Problema.** Como cada slot é um clone (git) / client (perforce) independente,
o branch ou changelist pendente de um chat vive **apenas no slot em que
foi criado**. Chats tomam emprestado slots de um pool compartilhado e podem reabrir em um slot
*diferente* — onde esse trabalho não existiria. (O antigo modelo de `git worktree`
não tinha isso: todos os worktrees compartilhavam um `.git`, então os branches eram centrais.)

**Solução.** Consolidar o trabalho de um chat em uma **casa** independente de slot ao fechar
e restaurá-lo ao reabrir. Conectado via `SourceControlProvider.persistChatOnClose`
/ `restoreChatOnReopen`, chamado a partir dos handlers `ChatsClose` / `ChatsReopen`
(`ipc/chats.ts`), substituindo o antigo stash local ao slot. Estado persistido no
chat: `chats.p4_shelf_cl` (perforce; git não precisa de nenhum).

- **git → o repositório LOCAL ROOT.** A casa é `repo.repoPath` — a pasta do
  repositório em disco da qual todo slot foi clonado — adicionada a cada slot como um remote
  `root` (`origin` permanece o remote real do GitHub, para PRs).
  - *Fechar:* carregar trabalho não commitado como um commit descartável `[Soft committed unstaged
    files]` (a menos que o usuário tenha descartado), então `git push -f root <branch>`.
    O root local acumula o branch de cada chat (sua lista de branches = o antigo
    comportamento de worktree compartilhado).
  - *Reabrir:* depois do checkout da base, `git fetch root <branch>` → `checkout -f
    -B branch FETCH_HEAD` → desfazer suavemente o commit WIP para que as edições voltem sem commit.
- **perforce → o ROOT CLIENT como um shelf.** Uma changelist pendente é por slot,
  então a casa é um **shelf** do lado do servidor pertencente a um client
  estável, nunca sincronizado, por repositório `popbot_<repoId>_root` (`ensureRootClient` — apenas
  spec, sem sync).
  - *Fechar:* `p4 shelve` a CL do slot, então `p4 reshelve -f` na CL
    pertencente ao root do chat. **`reshelve` move conteúdo shelved no lado do servidor** — verificado no
    Helix 2025.2: entre clients, sem sync de workspace, nada escrito no
    disco do root ("move shelves, não modifica arquivos"). Então deleta o shelf do slot + arquivos
    abertos + CL, para que o slot fique **vazio**; o client root possui um
    CL shelved por chat.
  - *Reabrir:* `p4 unshelve -s <rootCl> -c <newSlotCl>` na CL fresca do novo slot
    (watcher pausado), mantendo o shelf root como o backup estacionado.

Resultado líquido: slots são espaço de rascunho intercambiável; o repositório git local-root e o
client p4 root são as casas duráveis e visíveis ao usuário para trabalho em andamento.

## Backend de agente

`AgentBackend` (`main/agents/types.ts`) é a interface entre `AgentHost` e
um backend concreto. **Dois backends reais são distribuídos hoje** — `ClaudeBackend` (envolve
`@anthropic-ai/claude-agent-sdk`) e `CodexBackend` (envolve `@openai/codex-sdk`)
— mais um `StubBackend` para testes. Um chat escolhe seu backend (`chats.agent`) e
pode trocar; porque os dois SDKs têm handles de resume nativos, modelo, e
configurações de esforço diferentes, esses são persistidos **por escopo de provedor**
(`session_id` do Claude + `claude_model`/`claude_reasoning_effort`; `codex_thread_id` do Codex
+ `codex_model`/`codex_reasoning_effort`). `AgentHost` seleciona o backend, gera
uma sessão por chat, e retransmite os `AgentEvent`s de cada sessão para o
renderer + persistência.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

O MCP de editor por slot é entregue ao backend no spawn: `SpawnOpts.mcpServers`
carrega o endpoint de editor Unity/Unreal do chat (`{ type: 'http', url }`),
registrado em memória nas opções do SDK — nada escrito em disco. Apenas o
backend com capacidade `mcpHttp` o consome. Veja **MCP de editor por slot** abaixo.

O callback `canUseTool` vive ao lado do backend, não no prompt do agente — é nosso limite de segurança de veto rígido. A resolução de regra (`resolveRule`) consulta regras de permissão por chat e depois globais antes de perguntar. Veja [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md).

## Persistência

- **`better-sqlite3`** em `<userData>/popbot.db` (macOS: `~/Library/Application
  Support/PopBot/`; equivalente por SO via `app.getPath('userData')` no Windows /
  Linux). O esquema é uma lista numerada de migrações em `persistence/db.ts`
  (bloqueado por `user_version`, cada etapa atômica). Tabelas atuais:
  - `chats` — uma linha por chat: arrendamento de slot (`slot_id`), `worktree_path`, `repo_id`,
    `agent` ativo, modelo/esforço por provedor + handles de resume (`session_id`,
    `codex_thread_id`), `permission_rules`, e estado entre slots (`p4_shelf_cl`).
  - `messages` — uma linha por evento de agente (a transcrição durável).
  - `repos` — configuração por repositório (caminho, cor, prefixo de slot, base padrão, contagem de slots,
    `mode` = `slots`/`ephemeral`, `scm`, `p4_config` JSON).
  - `settings` — preferências do app em chave/valor JSON (referências de credenciais de integração, preferências de UI).
  - `notifications` — o feed de notificação no app.
  - `sdk_session_entries` — tabela de suporte do SessionStore do SDK Claude (indexada por chat;
    o PopBot possui a cópia de recuperação para que o resume não dependa de JSONLs de `~/.claude`).
  - `codex_thread_events` — cache durável de eventos de stream brutos do Codex (o Codex retoma
    a partir de `~/.codex/sessions`; esta é a própria cópia de recuperação/diagnóstico do PopBot).

  Não há **tabela** de cache de ticket/PR: as filas de Tickets e Revisões fazem cache
  no renderer (veja os comentários de IPC `list-recent`), não no SQLite.
- **Rascunho por slot** vive no worktree/montagem do slot e nos diretórios de runtime
  por chat (arquivos de sessão da CLI de agente, PTY, anexos retidos). Slots VHDX do shado vivem
  na unidade do repositório em `…/popbot/workspaces/<repoId>/…` (veja a seção shado).
- **Segredos** via `keytar` (chaveiro do SO — macOS Keychain / Windows Credential
  Vault / libsecret). Nunca no banco SQLite, nunca em logs.

## Fontes de ticket, provedores SCM, revisões, editores, atualizações

Cinco costuras de provedor das quais os subsistemas de nível superior dependem — todas projetadas para que
adicionar um backend seja local, e os chamadores permaneçam genéricos:

- **Fontes de ticket** (`tickets/`). Um `TicketSource` ativo alimenta a fila de
  Tickets, escolhido pela configuração `ticketSource` via `tickets/registry.ts` (Linear /
  Jira / GitHub; o padrão é Linear). Toda fonte normaliza para os DTOs Linear
  compartilhados, então o renderer renderiza todos os rastreadores por um único caminho e ramifica apenas nas
  capacidades em `shared/ticketProvider.ts`, nunca no id do provedor. Adicionar um
  rastreador é uma linha no registro + um `*Source.ts` + um descritor.
- **Provedores SCM** (`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`
  é a pequena superfície comum (ciclo de vida do workspace, revisão de árvore de trabalho, detecção de
  PR/revisão, continuidade entre slots). `GitProvider` e `PerforceProvider` são reais;
  `lore` está rascunhado. `scm/index.ts` retorna uma instância por id. **Chamadores ramificam
  em CAPACIDADES (`shared/sourceControl.ts`), nunca no id do provedor** — qualquer coisa
  que não se abstraia de forma limpa é um flag de capacidade, e um provedor muito divergente
  opta por sua própria janela de cliente via `capabilities.nativeClientUi`.
- **Revisões** (`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`). Um
  orquestrador agnóstico de provedor agrupa repositórios configurados por SCM e despacha para
  os métodos de revisão de cada provedor (bloqueado por `capabilities.pullRequests`), mesclando
  GitHub PRs e revisões do Helix Swarm em um único painel. Cada provedor possui sua **própria
  cadência de polling** (`reviewPollIntervalMs` — Swarm mais lento que o GitHub para proteger um
  p4d compartilhado), e o painel roda um timer por provedor (`pb:reviews:providers` /
  `pb:reviews:list-for`).
- **MCP de editor por slot** (`ipc/apps.ts`, `shared/gameEngine.ts`). Engines
  (Unity / Unreal / custom) são habilitáveis independentemente. Quando `useMcp` está ativado, o editor de cada
  slot é lançado com uma **porta MCP por slot** (`mcpBasePort + (slotId-1)`)
  para que editores paralelos não colidam, e `mcpEndpointForChat` entrega ao agente a URL HTTP
  do MCP de editor daquele slot no spawn. Editores são lançados **desanexados** (foca-ou-
  lança), não filhos de longa vida supervisionados.
- **Atualizações** (`updates/`). Auto-atualização electron-updater com um fallback de
  download manual para builds não assinadas, mais uma verificação sob demanda para o diálogo Sobre
  (`pb:updates:*`).

## Transversal

- **Logging** — main escreve logs de diagnóstico via `diagLog` (`dlog`); a CLI de agente
  e o PTY carregam sua própria saída de runtime por chat; logs do renderer são roteados através de main
  via IPC.
- **Recuperação na inicialização** — a recuperação é orientada por DB e sessão, não baseada em arquivo PID
  (sequência de boot em `main/index.ts`): `initDb()` roda migrações pendentes;
  `clearStaleRunningStatuses()` reverte qualquer chat deixado em `run` de volta para `idle` (a
  sessão de agente de uma execução anterior se foi); importação de session-store + migração de diretório
  de projeto do SDK + `sessionPinRepair` + `recoverChatSessions` reconciliam sessões
  Claude/Codex fixadas contra o que de fato está em disco; as sondas de CLI relatam
  quais backends estão online. No Windows, slots VHDX do shado desconectados (um reboot
  derrubou suas montagens) são detectados e exibidos para uma remontagem de um único UAC (veja a
  nota **Reboot** do shado acima).
- **Atualizações** — auto-atualização electron-updater; veja o provedor de **Atualizações** acima.
