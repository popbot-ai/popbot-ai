*Languages: [English](../CORE_MODEL.md) · [Español](../es/CORE_MODEL.md) · [Français](../fr/CORE_MODEL.md) · [Deutsch](../de/CORE_MODEL.md) · [日本語](../ja/CORE_MODEL.md) · [한국어](../ko/CORE_MODEL.md) · [简体中文](../zh-CN/CORE_MODEL.md) · **[Português (Brasil)](CORE_MODEL.md)** · [Русский](../ru/CORE_MODEL.md) · [Italiano](../it/CORE_MODEL.md)*

# Modelo Central

O grafo de objetos ao redor do qual o app do PopBot é construído. Tudo mais — IPC,
persistência, painéis de UI, o loop do agente — depende disso. Se você mudar
comportamento de uma forma que viole uma regra aqui, **ou atualize o modelo
primeiro ou avise o usuário que o modelo está mudando.**

Para "onde o código vive?" veja [ARCHITECTURE.md](ARCHITECTURE.md).
Para "o que o usuário vê?" veja [USER_STORIES.md](USER_STORIES.md).

---

## Resumo — os quatro substantivos que importam

| Substantivo | Durável? | Dono | Vida útil |
|---|---|---|---|
| **Chat** | sim (SQLite) | main | criado pelo usuário, vive até ser explicitamente deletado |
| **Message** | sim (SQLite, quase-somente-anexação) | main | filho de Chat |
| **Slot** | sim (sistema de arquivos + linha SQLite) | main / `SlotManager` | criado raramente, reutilizado; nunca por chat |
| **AgentSession** | **não** (apenas em memória) | main / `AgentHost` | gerado quando um Chat fica "em execução"; descartado quando o Chat fecha ou o app sai |

Tudo no renderer é uma **visão** sobre esses. O renderer nunca possui
estado canônico.

---

## Substantivos duráveis (sobrevivem a reinício)

### Chat

A unidade de trabalho do usuário. Um ticket, uma revisão de PR, uma thread do Slack, uma
sessão de "explorar o código" — cada um é um Chat.

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

**Ciclo de vida do status** (US-6 — o que colore a miniatura):

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

**Status é descritivo, não prescritivo** — derivado da AgentSession
quando uma está anexada, persistido no DB na transição. Um chat estar
`idle` significa "nenhum agente fazendo trabalho agora." Não significa "o chat está
fechado."

**Aberto vs. fechado:** um chat está "aberto" sse `closedAt IS NULL`. Chats abertos
são carregados em memória na inicialização; chats fechados são apenas para consulta. **Fechar
um chat libera seu arrendamento de slot + descarta sua AgentSession mas nunca
deleta Messages.**

### Message

Log de eventos quase-somente-anexação dentro de um Chat. A transcrição é uma sequência de
registros tipados:

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

**Por que JSON em `body`?** Cada tipo tem uma forma de payload diferente (texto vs.
chamada de ferramenta vs. requisição de permissão) e o renderer despacha em `kind`.
Armazenar como um blob JSON tipado mantém a tabela plana e o código do renderer
honesto.

**"Quase somente anexação":** linhas `tool` e `permission` são mutadas **uma vez**:

- linhas `tool`: escritas em `tool-use` (nome + args), atualizadas em `tool-result`
  (preenche `result` + `isError`).
- linhas `permission`: escritas em `permission-request` (ferramenta + args + motivo),
  atualizadas na decisão do usuário (define `decision`).
- linhas `text`: escritas em `message-start` com texto vazio, **coalescidas** em
  um pequeno buffer em memória à medida que eventos `text-delta` chegam, liberadas em
  `message-end` (e a cada ~250 ms para manter o renderer ao vivo). Uma linha por
  "turno de texto do agente," não uma linha por delta.

**Sem exclusões em cascata ao reverter trabalho do agente.** Se um agente comete um
erro e você quer que ele "tente de novo," você envia uma nova mensagem de usuário. A
transcrição antiga permanece. O modelo nunca reescreve o histórico silenciosamente.

### Slot

Um workspace aquecido, isolado e descartável: um checkout isolado sobre uma
pasta copy-on-write (um worktree Git, ou um client Perforce) + um cache de
build aquecido (por exemplo, o cache de asset/importação de uma engine) + (opcionalmente) um
editor em execução para o app sob teste (Unity, Unreal, ou uma engine customizada) +
(opcionalmente) um servidor sidecar em execução. **Criado raramente, reutilizado
continuamente.** Slots são de propriedade do usuário / app, não dos Chats.

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

**A ligação Slot ↔ Chat** é **transitória** — vive em `slot.leasedByChatId`
e nos metadados de runtime do Chat correspondente. Na inicialização reconciliamos isso
percorrendo os slots e comparando com chats abertos. Arrendamentos obsoletos (chat
fechado, arrendamento nunca liberado) são coletados.

Para o ciclo de vida completo do slot veja [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--a-unidade-durável).

### Concessão de permissão

Uma decisão durável do usuário de que alguma combinação de ferramenta / alvo é aprovada
sem reperguntar. Dois escopos:

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

`tool` pode ser um curinga `*` no final, então um servidor MCP inteiro pode ser
permitido com uma concessão (`allow-mcp-server` → `mcp__<server>__*`) — é assim
que o MCP de editor de um slot é permitido uma vez em vez de uma-vez-por-ferramenta. Regras de negação sempre
vencem sobre permissão, e um padrão mais específico vence sobre um mais
amplo (veja `resolvePermissionRules` em `src/shared/agent.ts`).

Concessões acumulam por chat (US-9: "sempre permitir git push para este chat").
Regras de **negação** fixas no código em [adr/0004](../adr/0004-canusetool-policy-boundary.md)
não são armazenadas aqui — vivem no código e não podem ser sobrescritas.

### Settings (Configurações)

Duas camadas:

- **Preferências globais**: tema, tipo de chat padrão, contagem de slots, cadência
  de atualização da Library mestra, etc. Tabela de uma linha.
- **Sobrescritas por chat**: modo servidor, escala de tempo, modo janela, orçamento
  de tokens, etc. Armazenadas em uma tabela `chat_settings` indexada por `chatId`.

Qualquer uma pode estar vazia (padrões se aplicam). Mutadas via painéis de Settings no
renderer.

### Itens de atenção em cache

As filas do usuário de tickets atribuídos (Linear / Jira / GitHub Issues) e
revisões pendentes (GitHub PRs / changelists do Helix Swarm). Em cache localmente para que
painéis renderizem instantaneamente; atualizados em uma programação + sob demanda.

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

Fontes de ticket são intercambiáveis por trás de um provedor comum (Linear, Jira,
GitHub Issues); fontes de revisão da mesma forma (GitHub PRs, Swarm). Em cache, não
autoritativas — a fonte da verdade é o próprio rastreador / sistema de revisão.

---

## Substantivos de runtime (em memória; não sobrevivem a reinício)

### AgentSession

A coisa que conversa com o LLM. Uma AgentSession por Chat "em execução".
Suportada por um `AgentBackend` (o Claude Agent SDK ou o Codex SDK; ambos
distribuídos hoje).

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**Propriedade do `AgentHost`** (um singleton no processo main). AgentHost mantém um
`Map<chatId, AgentSession>`. Sessões são criadas de forma preguiçosa no primeiro
`agent.send` para um chat e descartadas quando o chat fecha.

**Sessões emitem `AgentEvent`s** (veja `src/shared/agent.ts`). AgentHost
intercepta cada evento e:

1. **Persiste** ele (deltas coalescem em uma linha de texto; tool-use cria uma
   linha de ferramenta; permission-request cria uma linha de permissão).
2. **Retransmite** para o renderer via `webContents.send`. O
   renderer é um de N assinantes; main é o gravador autoritativo.
3. **Atualiza metadados do Chat** — `status`, `snippet`, `tokensUsed`,
   `lastActiveAt` são avançados à medida que eventos chegam.

**Sessões nunca escrevem no DB diretamente.** Apenas AgentHost faz isso. Isso
mantém a evolução do esquema de persistência desacoplada de trocas de backend.

### Requisição de permissão (em andamento)

Quando o callback `canUseTool` do SDK dispara:

1. PolicyEngine avalia: permissão fixa (automático), negação fixa (automático), ou pergunta ao usuário.
2. Se "pergunta ao usuário," AgentHost emite um evento `permission-request` para o
   renderer **e estaciona o callback do SDK** — indexado por `permissionId` — em um
   mapa pendente.
3. Renderer mostra o modal; usuário clica na decisão; IPC de volta para main.
4. AgentHost busca o callback pendente e o resolve. SDK prossegue
   ou aborta.
5. Se "sempre permitir isto" foi marcado, escreve uma linha `PermissionGrant`.

Requisições pendentes **não são persistidas**. Se o app travar no meio da decisão,
a chamada de ferramenta do agente é cancelada no reinício.

### Handles do supervisor de processo

Por slot: um `child_process.ChildProcess` para o editor do app-sob-teste
(Unity / Unreal / engine customizada — o campo `unityPid` registra seu PID
independentemente da engine), outro para o servidor sidecar. De propriedade do
`SlotManager`. Verificado por saúde via vivacidade de PID + sondas HTTP. Morto na
liberação de slot / saída do app. **Reconciliado na inicialização** percorrendo o `slot.json`
do diretório do slot e verificando se os PIDs registrados ainda estão vivos.

---

## Regras de propriedade

Estas são **invariantes**. Código que as viola é um bug.

1. **Renderer é visão pura.** Sem fs, sem child_process, sem acesso a DB. Fala
   com main exclusivamente via a ponte tipada `window.popbot.*`.

2. **Main é o único escritor no DB.** Renderer lê via IPC; nunca
   toca `popbot.db`.

3. **AgentHost é a única coisa que muta status / snippet / tokens do Chat
   durante uma sessão.** Outro código pode ler esses campos mas não pode
   escrevê-los enquanto uma sessão está ativa para aquele chat. (Mutações dirigidas pelo usuário
   como renomear acontecem quando nenhuma sessão está ativa, ou são enfileiradas.)

4. **Backends nunca escrevem no DB.** Emitem eventos; AgentHost
   persiste. Isso mantém ClaudeBackend / CodexBackend / StubBackend
   intercambiáveis sem entrelaçamento com o esquema do DB.

5. **PolicyEngine é a única fonte da verdade para "esta ferramenta pode rodar?"**
   Nenhum backend a contorna. Concessões de permissão fluem através dela.

6. **A ligação Slot ↔ Chat é transitória.** O registro Chat nunca nomeia um
   slot. O registro Slot nomeia o chat que possui o arrendamento (ponteiro
   suave, reconciliado na inicialização).

7. **A transcrição nunca muta silenciosamente.** Anexe novas linhas; as
   atualizações de uma vez em linhas de tool/permission são explícitas e limitadas.

---

## Fluxo de estado — uma única mensagem de usuário, de ponta a ponta

Um exemplo trabalhado do modelo em movimento.

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

Duas coisas a notar:

- **O renderer nunca decide nada.** Ele despacha intenções e
  re-renderiza a partir de eventos.
- **Escritas no DB acontecem no mesmo lugar que notificações do renderer.** Elas
  são vinculadas pelo mesmo handler no AgentHost. Isso significa que um travamento do renderer
  não pode causar desvio de persistência.

---

## Fluxo de recuperação — reinício a frio

US-7 em forma de código. O app sai de forma não graciosa. Horas depois, o usuário o abre de novo:

1. **Inicialização do DB** — `initDb()` abre `popbot.db`, roda migrações pendentes.
2. **Reconciliação de slot** — percorre `~/Library/Application Support/PopBot/slots/`,
   para cada slot lê `slot.json`, verifica se `unityPid` / `serverPid` estão
   vivos (`kill -0`); se mortos, marca o slot como livre e limpa os PIDs.
   Resolve quaisquer arrendamentos órfãos (chat que não existe, ou chat cujo
   `closedAt` está definido).
3. **Chats abertos** — `listOpenChats()` retorna chats com `closedAt IS NULL`,
   ordenados por `lastActiveAt DESC`. Renderer os solicita na primeira renderização.
4. **Sem geração automática de agente.** Sessões são geradas de forma preguiçosa no primeiro
   `agent.send`. Um usuário abrindo seu chat antigo apenas vê a transcrição;
   o agente não retoma de onde parou até que o usuário o solicite.
5. **Arrendamento de slot sob demanda.** O mesmo — o arrendamento acontece quando o tipo de chat
   precisa dele (Client/Server Test) e uma ferramenta que requer Unity está
   prestes a disparar.

O resultado: abrir o app é rápido (leitura de DB + ping de slot), e você pode
inspecionar o histórico de qualquer chat sem pagar o custo de geração do agente.

---

## Intercambiabilidade de backend

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** envolve `@anthropic-ai/claude-agent-sdk`. O padrão.
- **CodexBackend** envolve `@openai/codex-sdk` (que conduz `codex exec`).
  Distribuído. Cada backend anuncia suas `capabilities` e a UI
  as detecta por chat.
- **StubBackend** ecoa o texto do usuário com um stream falso. Usado para validação
  de conexão + testes de UI.

O campo `agent` do registro de chat seleciona qual backend o AgentHost gera.

---

## O que está intencionalmente FORA do modelo

- **Workflows / DAGs / cadeias de aprovação.** Um chat é uma conversa. Não estamos
  modelando pipelines.
- **Multiusuário.** Um desenvolvedor único por máquina; sem autenticação, sem compartilhamento.
- **Notebooks / consultas salvas / templates.** Todos emergentes da
  transcrição; ainda sem tipo de primeira classe.
- **Snapshots de chat versionados / transcrições ramificadas.** A transcrição é
  linear. Bifurcar um chat = criar um novo chat semeado a partir do histórico do
  antigo (um recurso futuro, não no modelo hoje).

Se acabarmos precisando de um desses, ele é adicionado aqui primeiro, depois ao código.
