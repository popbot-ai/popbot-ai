*Languages: [English](../PHASING.md) · [Español](../es/PHASING.md) · [Français](../fr/PHASING.md) · [Deutsch](../de/PHASING.md) · [日本語](../ja/PHASING.md) · [한국어](../ko/PHASING.md) · [简体中文](../zh-CN/PHASING.md) · **[Português (Brasil)](PHASING.md)** · [Русский](../ru/PHASING.md) · [Italiano](../it/PHASING.md)*

# Fases

Roadmap para levar o PopBot de "design + protótipo" a "ferramenta diária útil." Espelha o faseamento em [POPBOT_DESIGN.md](POPBOT_DESIGN.md#fases) mas rastreia progresso concreto com checkboxes.

Atualize este arquivo à medida que itens forem entregues. Um commit pode marcar várias caixas.

---

## Fase 0 — Pré-requisitos (~3 dias)

Peças fundamentais no repositório AutoRPG + um helper nativo aqui. A maioria delas bloqueia o teste real de ponta a ponta mas não o scaffold do Electron.

### Em `~/pop/autorpg`

- [ ] **Sobrescrita de env `POPBOT_MCP_PORT`** no servidor MCP dentro do Editor (`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`). Ler a porta do env, com fallback para `17893`. ~5 min.
- [ ] **Flags `./run_local.sh --port` + `--data-dir`.** O servidor aceita ambos como args; diretório de dados para isolamento de DB por slot. ~30 min.
- [ ] **Extensão do endpoint `/health`** — retorna `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }`. O PopBot usa isso para detecção de desvio no momento do arrendamento. ~30 min.

### Neste repositório

- [ ] **Helper nativo de movedor de janela do macOS** — CLI em Swift em `native/popbot-windowmover/`. Subcomandos: `move`, `minimize`, `wait-for-window`. ~½ dia.
- [ ] **Protótipo de ciclo de vida de slot** — módulo TS standalone em `src/main/slots/` exercitado por um script em `scripts/`. Cobre worktree add, Library COW a partir do master, troca de branch com segurança de stash, arrendamento/liberação, reconciliação de órfãos. ~1 dia.

---

## Fase 1 — Superfície de automação MCP (~3-5 dias)

Em `~/pop/autorpg`. Constrói as ferramentas MCP dentro do Editor que os agentes de fato usarão.

- [ ] **Infraestrutura de jobs** — `job_status`, `job_get_result`, `job_cancel`, `job_list`. Todas as ferramentas de longa duração retornam `{ jobId }` imediatamente.
- [ ] **Ferramentas de ciclo de vida** — `play_status`, `play_enter` (job), `play_exit`, `play_pause/resume/step`, `time_scale_set`, `editor_quit`.
- [ ] **Ferramentas de observação** — `screenshot`, `game_state_summary`, `screen_stack`, `chapter_status`, `ui_tree`, `ui_query`.
- [ ] **Ferramentas de ação** — `ui_click`, `ui_click_by_loc`.
- [ ] **Ferramentas de sincronização** — `wait_until` (job), `wait_for_idle` (job).
- [ ] **Ferramentas de logs / servidor** — `console_get_logs` estendido (`sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack`), `server_logs`, `server_health`, `client_set_server_endpoint`.
- [ ] **Sessões** — `mcp_session_start`, `mcp_session_end` para diretórios de artefato previsíveis.
- [ ] **Migrar ferramentas longas existentes** para o modelo de job: `rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`.

---

## Fase 2 — MVP do PopBot Electron (~1-2 semanas)

Utilizável de ponta a ponta para um único chat. **Em andamento.**

- [ ] **Scaffold do Electron** — `package.json`, Vite + React + TS + Tailwind, electron-builder, ESLint + Prettier, Vitest.
- [ ] **Divisão main / preload / renderer** com ponte IPC tipada.
- [ ] **Portar os 8 JSXs do protótipo** para `.tsx` em `src/renderer/`. UI estática roda na janela Electron sem suporte funcional.
- [ ] **Esquema better-sqlite3** — chats, messages, slots, prefs.
- [ ] **Sessão única do ClaudeBackend** conectada a uma coluna de chat. Enviar mensagem, receber stream de eventos.
- [ ] **Motor de política `canUseTool`** — lista de negação fixa no código + permitir-por-modo. O renderer exibe requisições de permissão como modais.
- [ ] **Gerenciador de slot** conectado — um slot, worktree real, lançamento real da Unity via o helper da Fase 0.
- [ ] **Integração do movedor de janela nativo** — a Unity abre, o helper a posiciona na tela 2.
- [ ] **Esqueleto do painel de configurações** — modo por chat, modo servidor, escala de tempo, backend de agente.
- [ ] **Demo do loop de ponta a ponta** — abrir chat → agente lê código → agente roda o jogo → agente tira screenshots → agente reporta.

---

## Fase 3 — Multi-chat + painéis da fila de atenção (~1-2 semanas)

Acende [US-1](USER_STORIES.md#us-1--consciência-da-fila-de-atenção), [US-2](USER_STORIES.md#us-2--ativação-em-um-clique), [US-5](USER_STORIES.md#us-5--multitarefa-fácil-via-miniaturas), [US-6](USER_STORIES.md#us-6--status-em-um-relance).

- [ ] Múltiplas colunas de chat; adicionar/remover flutuante.
- [ ] Faixa de miniaturas com cores de status (US-5, US-6).
- [ ] **Painel de tickets do Linear** (atribuídos a mim, classificados por prioridade + data de vencimento).
- [ ] **Painel de PRs não revisados** (`gh` GraphQL).
- [ ] **Painel Slack** — DMs, @menções, canais próprios. Subsistema totalmente novo (`src/main/slack/`); OAuth via `keytar`. Veja [USER_STORIES.md → Desvios](USER_STORIES.md#slack-como-uma-terceira-fonte-de-atenção-us-1).
- [ ] **Geração de chat em um clique** a partir de qualquer linha de painel; chat semeado com o contexto da fonte (US-2).
- [ ] Painel de log inferior — abas Unity + servidor, rolagem sincronizada para o chat ativo.
- [ ] Alternâncias de modo + modo-servidor nas configurações do chat, com reaponte no meio da sessão.
- [ ] Detecção de desvio no arrendamento `remote-dev`.

---

## Fase 4 — Polimento + avançado

- [ ] **Adaptador de backend Codex** — `CodexBackend implements AgentBackend`, capacidades sinalizadas na UI.
- [ ] **`Window Mode` Headless** — opt-in depois que o script de validação de batchmode provar que funciona no AutoRPG.
- [ ] Ferramentas MCP **`crash_dump`, `events_pop`, `command_apply`, gerenciamento de fixture**.
- [ ] **Correlação de tempo de log lado a lado** entre os painéis Unity e servidor.
- [ ] **Refinamento de orçamentos de autonomia + detecção de loop** (gatilhos de pausa por token / tempo / falha repetida).
- [ ] **Canal de atualização** — auto-updater via electron-builder + builds assinadas.

---

## Questões em aberto (carregadas do design)

1. O AutoRPG de fato roda em modo Play `-batchmode`? Script de validação na Fase 4-ish; não bloqueante para v1.
2. Cadência de atualização da Library mestra — botão manual vs. automático vs. TTL de N dias? Padrão: botão manual em preferências.
3. Contagem de slots padrão — 4 fixo, ou escala por RAM/núcleos? Provavelmente padrão de 2-3, configurável.
