*Languages: [English](../POPBOT_DESIGN.md) · [Español](../es/POPBOT_DESIGN.md) · [Français](../fr/POPBOT_DESIGN.md) · [Deutsch](../de/POPBOT_DESIGN.md) · [日本語](../ja/POPBOT_DESIGN.md) · [한국어](../ko/POPBOT_DESIGN.md) · [简体中文](../zh-CN/POPBOT_DESIGN.md) · **[Português (Brasil)](POPBOT_DESIGN.md)** · [Русский](../ru/POPBOT_DESIGN.md) · [Italiano](../it/POPBOT_DESIGN.md)*

# Design do PopBot

Um orquestrador de desenvolvimento multi-agente para o AutoRPG. Inspirado no Conductor; adiciona infraestrutura de teste dentro do jogo para que agentes possam lançar o jogo real, clicar por ele, e verificar comportamento.

> **Status:** design — fixado em 2026-05-01. Documento vivo; atualize no local à medida que descobrirmos durante a implementação.
>
> **Leia isto primeiro:** [USER_STORIES.md](USER_STORIES.md) define os seis resultados para os quais este design existe para entregar. Quando este documento e as histórias de usuário discordam, as histórias de usuário vencem e este documento é atualizado.

## Objetivos

1. Rodar múltiplos agentes de desenvolvimento de IA em paralelo, cada um em seu próprio worktree git.
2. Deixar agentes conduzirem o jogo real (Unity Editor em janela) para testes de ponta a ponta.
3. Exibir filas de ticket / PR / Slack, histórico de transcrição, logs, e terminais em uma única janela.
4. Padrão para operação autônoma; pausar apenas em eventos verdadeiramente bloqueantes.

## Não-objetivos (v1)

- CI/CD de produção (preocupações separadas)
- Multiplataforma (apenas macOS; Linux/Windows depois se necessário)
- Multiusuário / SSO (um único desenvolvedor por máquina)

## Layout do app

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

Abas superior-esquerda: **Tickets** (Linear atribuído a mim) e **Reviews** (PRs solicitando minha revisão). Clique em uma linha → gere um chat semeado para aquele trabalho.

## Slots — a unidade durável

Um slot = um worktree git + sua Library + (opcionalmente) seu Unity Editor em execução + (opcionalmente) seu servidor sidecar em execução. **Slots são criados raramente, reutilizados continuamente.**

### Diretório por slot

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

### Números de custo reais (medidos em 2026-05-01 no AutoRPG)

| Operação | Tempo |
|---|---|
| `git worktree add` (fresco, 62 mil arquivos, smudge LFS) | ~23 s |
| Library COW a partir do master (APFS clonefile) | ~1 s |
| Primeiro lançamento da Unity em um slot (Library a frio) | 1-3 min |
| Acerto pegajoso (Unity já em execução, ociosa) | ~50 ms |
| Início a frio (Unity desligada, branch corresponde) | 15-30 s |
| Troca de branch em slot existente (delta + reload da Unity) | 5-15 s |
| Total de criação de slot (worktree add + COW + primeira importação) | ~1-3 min, **raro** |

### Orçamento de disco

~14 GB por slot (8 GB Library + 5,5 GB Assets + rascunho). 4 slots = ~55 GB. `.git` compartilhado (~8 GB) contado uma vez.

### Política de arrendamento

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### Unicidade de branch

O Git se recusa a fazer checkout do mesmo branch em dois worktrees. Resolvido por:
- **Chats Lite / de revisão** usam HEAD destacado (sem conflito).
- **Dois chats de teste no mesmo branch** — o segundo usa um branch temporário (`<branch>-slot-N`) ou HEAD destacado; o agendador do PopBot escolhe automaticamente.

### Segurança pré-checkout

Antes de qualquer troca de branch em um slot existente:

1. `git stash --include-untracked` (sempre; rede de segurança).
2. Recusar se houver commits não staged que o agente possui; commitar primeiro ou falhar ruidosamente.
3. Fechar quaisquer cenas Unity abertas (evitar problemas de resolução de GUID entre branches).
4. `git checkout <branch>`.
5. Aplicar (pop) o stash se aplicável, ou restaurar a partir de um registro de stash por branch.

### Controles de política por slot (em preferências)

- `pinnedBranch?` — recusar arrendamentos para outros branches; slot de trabalho primário.
- `cleanOnRelease: bool` — `git clean -fd && git checkout .` na liberação; padrão desligado.
- `autoStashOnSwitch: bool` — padrão ligado.

## Orçamentos de recursos (controles independentes)

Slots e instâncias Unity ativas são **orçamentos separados**. Um slot pode existir com sua Unity desligada — é apenas armazenamento nesse ponto. Rodar a Unity é limitado por RAM e ajustável independentemente.

| Orçamento | Custo por unidade | Padrão | Preferência do usuário |
|---|---|---|---|
| **Contagem de slots** (worktrees em disco) | ~14 GB | 2-4 | Preferências: "Slots" |
| **Máximo de Unity ativas** (processos em execução) | ~3-4 GB RAM | 2 | Preferências: "Max active Unity" |
| **Teto rígido de Unity** (limite de auto-aprovação do modo autônomo) | — | calculado: `floor(systemRAM / 4 GB)` | Preferências: "Unity hard cap" |

### Política de arrendamento (estendida)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### Ajuste iniciado pelo agente

Nova ferramenta MCP, disponível quando o agente está bloqueado por capacidade da Unity:

| Ferramenta | Modo | Retorna |
|---|---|---|
| `request_unity_capacity` | síncrono | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

Comportamento:

- **Chat interativo** → o chat fica amarelo, um banner pede ao usuário para aprovar.
- **Chat autônomo** → auto-aprova até o `Unity hard cap`; pausa para humano acima disso.
- O usuário também pode ajustar para cima/baixo preemptivamente nas preferências a qualquer momento. Ajustar para baixo remove Unitys ociosas por LRU (nunca as ocupadas).

## Tipos de chat

| Tipo | Slot | Library | Unity | Sidecar | Início | RAM |
|---|---|---|---|---|---|---|
| **Lite** (revisão, plano, triagem) | opcional | — | — | — | ~1-2 s | ~50-100 MB |
| **Client Test** | obrigatório | de propriedade do slot | GUI na tela 2 | local ou remoto | 50ms-30s | ~2-4 GB |
| **Server Test** | obrigatório | de propriedade do slot | GUI na tela 2 | local sempre | 50ms-35s | ~2-5 GB |

Padrão para novos chats: **Lite**. Promova quando o teste de jogo for realmente necessário.

## Modos de servidor

Configuração por chat; alternável em tempo real.

| Modo | Fonte do servidor | Use quando |
|---|---|---|
| `local` (padrão) | `./run_local.sh --port <P> --data-dir <D>` por slot | Execuções cotidianas do agente; mudanças de backend; estado determinístico |
| `remote-dev` | Servidor de desenvolvimento remoto compartilhado | Iteração pura de cliente; detecção de desvio protege a entrada |

### Detecção de desvio

Antes de aceitar um arrendamento remote-dev: o PopBot lê a constante `Assets/Scripts/Simulation/GameDataHash.cs` + versão do DTO localmente; faz GET em `/health` remotamente; compara. Incompatibilidade → rejeita o arrendamento com erro estruturado.

### Retorno de `/health`

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### Alternância no meio da sessão

O usuário alterna `Server Mode` nas configurações do chat; o PopBot:

1. Verificação de desvio (se entrando em remote-dev). Recusa em caso de incompatibilidade.
2. Para / inicia o processo sidecar conforme necessário.
3. `client_set_server_endpoint { url }` via MCP — reaponta em tempo de execução.
4. Força um reset de sessão dentro do jogo (logout/título) — autenticação antiga inválida.
5. Cancela jobs em andamento, banner: "server changed, restart task."

## Painel de configurações por chat

| Configuração | Padrão | Notas |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = auto-aprova o seguro, pausa quando verdadeiramente travado |
| Server mode | `local` | `remote-dev` (verificado por desvio) |
| Window mode | `GUI on screen 2` | `Headless` (depois, opt-in) / `Visible` |
| Time scale | `1.0` | Acelera animações |
| Game view resolution | `1920×1080` | Fixado para screenshots reproduzíveis |
| Auto-screenshot every action | desligado | Para pacotes de prova |
| Verbose logs | desligado | Alterna ao depurar o próprio agente |
| Agent backend | `claude` | `codex` (Fase 4) |
| Default fixture | nenhum | Inicia com um save blob |
| Token budget | `1M` | Pausa ao atingir (modo autônomo) |
| Time budget | `60m` | Pausa ao atingir (modo autônomo) |
| Loop detection | ligado | Pausa em N chamadas de ferramenta idênticas / sem progresso por K min |

## Modo autônomo

### Motor de política — conectado ao `canUseTool`

Não enterre a política no prompt; o modelo pode se convencer a ignorá-la. Use o hook de veto rígido do SDK.

**Auto-aprovar em modo autônomo (silencioso):**

- Read / Edit / Write / Grep / Glob dentro do worktree do slot
- Bash dentro do worktree (com a lista de negação abaixo)
- Chamadas MCP para o próprio servidor MCP do slot
- Invocações de skill / subagente
- TodoWrite, operações internas do SDK

**Sempre pausar para humano (mesmo autônomo):**

- `git push`, `git reset --hard`, `git checkout --`, qualquer force, deleção de branch
- Qualquer coisa fora do caminho do worktree do slot
- Chamadas de rede para hosts não permitidos
- `rm -rf` fora de `tmp/` ou do diretório do slot
- `gh pr create` e qualquer ação de publicação no GitHub
- Slack / e-mail / mensagens externas
- Modificar `~/.claude`, `.mcp.json`, configuração de sistema

### Detecção de "verdadeiramente travado"

**O agente se autorreporta** (via a forma `message_done` do SDK):

- Pergunta de esclarecimento
- Bloqueador explícito
- "Terminei" terminal

**O PopBot observa** (defesa em profundidade):

- Loop — N chamadas de ferramenta idênticas seguidas
- Estagnação — nenhum evento de progresso por K minutos
- Orçamento de token / tempo excedido
- Falhas de teste repetidas (mesma falha K vezes)

### Cores de status (miniatura do chat)

| Cor | Estado |
|---|---|
| Azul | Em execução |
| Verde | Tarefa concluída |
| Amarelo | Pausado — precisa do usuário |
| Vermelho | Com erro |
| Cinza | Ocioso / não iniciado |

No modo autônomo você escaneia as miniaturas em busca de **amarelo**. Todo o resto está bem.

## Superfície de automação MCP

### Regra: toda ferramenta retorna dentro de ~100 ms

Operações longas retornam `{ jobId }` imediatamente; o agente faz polling. Nunca bloqueie o listener HTTP do MCP por mais de 100 ms.

### Infraestrutura de jobs

| Ferramenta | Modo | Retorna |
|---|---|---|
| `job_status` | síncrono | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | síncrono | payload completo da ferramenta; descarta o job |
| `job_cancel` | síncrono | define um flag cooperativo de cancelamento |
| `job_list` | síncrono | ativos + recentes (TTL ~60s) |

Coroutines rodam via `EditorCoroutineUtility.StartCoroutineOwnerless`, conduzidas por `EditorApplication.update`. `JobContext` expõe `SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)`.

### Catálogo de ferramentas — mínimo da Fase 1

**Ciclo de vida:**

- `play_status` (síncrono), `play_pause` / `play_resume` / `play_step` (síncrono), `time_scale_set` (síncrono)
- `play_enter` (job), `play_exit` (síncrono)
- `editor_quit` (síncrono)

**Observar:**

- `screenshot` (síncrono) — escreve em `Library/MCP/Screenshots/{session}/{label}.png`, retorna o caminho
- `game_state_summary` (síncrono) — topo da pilha de telas, moedas, nível, capítulo, equipado, desbloqueios, últimos 10 erros
- `screen_stack` (síncrono), `chapter_status` (síncrono)
- `ui_tree` (síncrono) — hierarquia com `text-loc` resolvido
- `ui_query` (síncrono) — seletores estilo CSS (`.btn`, `#Confirm`, `[text-loc=Friends.Title]`)

**Agir:**

- `ui_click` (síncrono), `ui_click_by_loc` (síncrono) — dispara `PointerDown/Up/ClickEvent` via `panel.SendEvent`

**Sincronizar / esperar:**

- `wait_until` (job) — predicados: `screen`, `log`, `event`, `path`
- `wait_for_idle` (job)

**Logs (estender existentes):**

- `console_get_logs` — adicionar `sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack: "none"|"first"|"all"`
- `server_logs` (síncrono) — segue (tail) o `server.log` do PopBot, mesma forma que `console_get_logs`
- `server_health` (síncrono), `client_set_server_endpoint` (síncrono)

**Sessões:**

- `mcp_session_start` / `mcp_session_end` — diretórios de artefato previsíveis em `tmp/mcp-sessions/{slug}/`

### Catálogo de ferramentas — fases posteriores

- `command_apply`, `command_list` — superfície de ação primária contornando a UI
- `save_blob_get` / `save_blob_load`, gerenciamento de fixture
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`, `gameview_resolution_set`
- `game_state_path` — leitor baseado em reflection com raízes permitidas

## Gerenciamento de janelas

Padrão: Editor GUI com a janela posicionada por um helper nativo.

**Movedor de janela nativo do macOS (~50 LOC Swift):**

1. Polling apertado de `AXUIElement` (50 ms) para que o helper capture a janela dentro de ~100 ms de seu aparecimento.
2. `setFrame:` para um retângulo configurado na tela 2.
3. `kAXMinimizedAttribute = true` (soltar para o dock).
4. Não roubar o foco.

**Pré-definir `EditorPrefs` para a posição da janela antes do lançamento.** A Unity restaura a última posição de janela na inicialização, então a partir do *segundo* lançamento ele abre já posicionado. O primeiro lançamento pisca brevemente (~200 ms); lançamentos subsequentes não.

**Configuração única do lado do usuário** (documentada na primeira execução do PopBot): `Dock → botão direito na Unity → Options → Assign To: Desktop X`. O macOS roteia janelas futuras da Unity para aquele Espaço automaticamente. Com isso definido, mesmo o flash do primeiro lançamento acontece em um Espaço que o usuário não está olhando.

Posição configurável por slot para que várias Unitys aterrissem em pontos previsíveis na tela 2.

**`Window Mode` Headless** é opt-in depois que a validação de batchmode passa (Fase 4-ish). Arquitetura idêntica; apenas a flag de lançamento muda.

## Protocolo de pareamento Server / Unity

A ordem de inicialização e o ciclo de vida precisam ser rígidos ou você atinge falhas sutis.

### Sequência de inicialização (o PopBot impõe)

1. Gerar `./run_local.sh --port S --data-dir D`. Encaminhar (tee) stdio para `server.log`. Registrar `server_pid`.
2. Fazer polling de `/health` até 200 (com `commit/gameDataHash/dtoVersion`). Timeout de 30 s. Falha → mata o servidor, exibe erro.
3. Escrever `client-server.json` no worktree apontando para `localhost:S`.
4. Gerar a Unity com `POPBOT_MCP_PORT=M`. Registrar `unity_pid`.
5. Fazer polling de `/mcp` até 200. Timeout de 60 s. Falha → mata ambos, exibe erro.
6. O movedor de janela nativo roda.
7. O slot está ativo; o agente pode arrendar.

### Cascata de morte

- **Servidor morre no meio da sessão** → o PopBot detecta via vivacidade de PID + 5xx de `server_health` → marca o slot como degradado → tenta um reinício do servidor → se isso falhar, exibe em vermelho no chat.
- **Unity morre** → o servidor continua rodando (o servidor sobrevive a reinícios da Unity; mais barato). O PopBot pode gerar uma Unity fresca contra o mesmo servidor.
- **Liberação de slot** → SIGTERM do servidor (5 s de graça) → SIGKILL → chamada MCP `editor_quit` da Unity → SIGTERM (5 s de graça) → SIGKILL.

### Reconciliação na inicialização do PopBot

Varre arquivos slot.json; para qualquer pid registrado, `kill -0 <pid>`; se morto, limpa o estado e reseta o slot. Higiene padrão de processo órfão.

## Integração de agente

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

O que ganhamos de graça: skills, memória, subagentes, hooks, MCP, requisições de permissão como eventos estruturados. **Não faça scraping de subprocesso da CLI `claude`** — briga com o SDK por cada recurso avançado.

### Interface AgentBackend (definida no dia 1; uma implementação na v1)

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

O backend Codex (Fase 4) adapta o OpenAI Agents SDK para esta interface. Skills/memória não disponíveis; a UI sinaliza isso claramente.

### Configuração MCP por chat

Cada agente é gerado com `mcpServers` injetado para as portas do **seu slot** — a URL `popbot-unity` = `localhost:<slot.mcpPort>/mcp`. Outros MCPs (Linear, Sentry, Amplitude, BetterStack) são herdados de `~/.claude/settings.json` ou `.mcp.json` automaticamente pelo SDK.

## Stack técnica

- **Electron** (Node + Chromium)
- **React + Tailwind** para UI
- **xterm.js + node-pty** para o painel de terminal
- **better-sqlite3** para persistência de transcrição (uma linha por evento, indexada por chat + timestamp)
- **keytar** para tokens OAuth / chaves de API / credenciais de agente
- **API GraphQL do Linear** para o painel de tickets
- **`gh` GraphQL** para o painel de PRs não revisados
- **Helper nativo em Swift** para posicionamento de janela

## Fases

### Fase 0 — Pré-requisitos (~3 dias)

| Item | Dono | Tamanho |
|---|---|---|
| Sobrescrita de env `POPBOT_MCP_PORT` no MCP | Unity MCP | 5 min |
| Flags `./run_local.sh --port` + `--data-dir` | server | 30 min |
| `/health` retorna `commit`, `gameDataHash`, `dtoVersion` | server | 30 min |
| Helper nativo de movedor de janela do macOS (Swift) | PopBot | ~½ dia |
| Protótipo de ciclo de vida de slot (worktree add, Library COW, troca de branch, segurança de stash) | PopBot | ~1 dia |

### Fase 1 — Superfície de automação MCP (~3-5 dias)

Infraestrutura de jobs + o catálogo de ferramentas da Fase 1 acima. Migrar ferramentas longas existentes (`rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`) para o modelo de job.

### Fase 2 — MVP do PopBot Electron (~1-2 semanas)

Coluna de chat única, apenas `ClaudeBackend`, slot único, Unity única. Esqueleto de painel de configurações. Motor de política `canUseTool`. Helper nativo integrado. Loop de ponta a ponta: abrir chat → agente edita código → agente roda o jogo → agente verifica via screenshots + logs → concluído.

### Fase 3 — Multi-chat + painéis (~1 semana)

Múltiplas colunas de chat (adicionar/remover com +/x flutuantes). Faixa de miniaturas com cores de status. Painéis de tickets do Linear + PRs não revisados. Painel de log inferior com abas Unity/servidor lado a lado. Alternâncias de modo/modo-servidor nas configurações do chat.

### Fase 4 — Polimento + avançado

Adaptador de backend Codex. `Window Mode` Headless (depois de validação de batchmode). `crash_dump`, `events_pop`, `command_apply`, gerenciamento de fixture. Correlação de tempo de log lado a lado. Refinamento de orçamentos de autonomia e detecção de loop.

## Questões em aberto

1. **Validação de batchmode** — o AutoRPG de fato roda em modo Play `-batchmode`? Script de validação na Fase 4-ish; não bloqueante para v1.
2. **Cadência de atualização da Library mestra** — botão manual vs. automático vs. TTL de N dias? Padrão: botão manual em preferências.
3. **Contagem de slots padrão** — 4 fixo, ou escala por RAM/núcleos? Provavelmente padrão de 2-3, configurável.
4. **Repositório do PopBot** — separado do `autorpg`, ou vive em `tools/popbot/`? Separado quando estabilizar; no mesmo repositório durante o desenvolvimento inicial.

## Riscos

| Risco | Mitigação |
|---|---|
| `git checkout` corrompe um slot no meio de um stash | Sempre faça stash primeiro; verifique limpeza pós-checkout; recuse se sujo |
| Duas instâncias do PopBot pisam no mesmo slot | Arquivo de trava por diretório de slot; reconcilia órfãos na inicialização |
| Unity trava e o arrendamento de slot nunca libera | Verificação de vivacidade de PID + GC na inicialização do PopBot |
| Conflitos de trava LFS entre worktrees | Raro; exiba claramente quando acontecer |
| Library do slot desvia muito do master | "Reset slot" manual reconstrói a partir do master |
| Disco enche | Mostre o tamanho por slot em preferências; "reset" recupera |
| Desvio de backend em remote-dev no meio da sessão | Reverificação de `server_health` em erros; banner + parada |
| Modo autônomo auto-aprova algo inseguro | Lista de negação fixa no código em `canUseTool`; nunca sobrescrevível pela configuração do chat |

## Artefatos de prova (entregável de depuração do agente)

Quando um agente completa uma tarefa de depuração, ele escreve em `tmp/mcp-sessions/{slug}/`:

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` segue um template de 6 seções (Repro / Before / Root Cause / Fix / After / Verification). A convenção é documentada em uma SKILL (`agent-debug`); o MCP só fornece caminhos de sessão previsíveis.

## Referência rápida — o que mudou desde propostas anteriores

Para quem estiver lendo a conversa que produziu este documento:

- Pool de Library / pool de processo / pool de worktree **colapsaram em um conceito único: o slot.** O slot possui seu worktree, Library, Unity opcional, sidecar opcional. Sem symlinks, sem pools separados.
- `git worktree add` é **~23s no AutoRPG** (smudge LFS sobre 62 mil arquivos), não 1-2s. A criação de slot é rara; reutilização via checkout é o caminho quente cotidiano.
- **Editor GUI na tela 2** é o padrão da v1. Batchmode headless é opt-in da Fase 4.
- O servidor roda no mesmo repositório via `./run_local.sh`; porta + diretório de dados por slot para isolamento.
- Integração de agente: **Claude Agent SDK primeiro**, interface AgentBackend, Codex na Fase 4.
