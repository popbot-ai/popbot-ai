*Languages: [English](../USER_STORIES.md) · [Español](../es/USER_STORIES.md) · [Français](../fr/USER_STORIES.md) · [Deutsch](../de/USER_STORIES.md) · [日本語](../ja/USER_STORIES.md) · [한국어](../ko/USER_STORIES.md) · [简体中文](../zh-CN/USER_STORIES.md) · **[Português (Brasil)](USER_STORIES.md)** · [Русский](../ru/USER_STORIES.md) · [Italiano](../it/USER_STORIES.md)*

# Histórias de Usuário

A referência de "como é o sucesso" para o PopBot. Capturado em 2026-05-01. Toda escolha de implementação deve remontar a uma dessas.

O usuário é um único desenvolvedor (Ben) rodando o PopBot em sua própria máquina. "Eu" abaixo é ele.

> **Status (anotação adicionada em 2026-07, na publicação).** As histórias abaixo são as histórias de usuário *fundadoras* capturadas em 2026-05, preservadas aqui como o registro original da intenção de design. O PopBot desde então foi generalizado bem além daquele primeiro escopo de usuário único Unity/Linear/Slack/GitHub — agora abrange Git e Perforce, Unity e Unreal, Linear/Jira/GitHub Issues, GitHub PRs e Helix Swarm, e é distribuído localizado em vários idiomas sob uma licença MIT. Este documento intencionalmente *não* foi retroadaptado para corresponder; trate-o como história, e veja [GUIDE.md](GUIDE.md) para o conjunto de recursos atual. As histórias US-1..US-9 e a captura de 2026-05 estão inalteradas.

---

## US-1 · Consciência da fila de atenção

> *"Eu deveria estar ciente de issues de alta prioridade, mensagens do Slack, e outros PRs que preciso atender."*

Três fontes exibidas juntas no topo da janela:

- **Tickets do Linear** atribuídos a mim, classificados por prioridade + data de vencimento.
- **Mensagens do Slack** endereçadas a mim (DMs, @menções, canais que possuo). _Novo requisito; não estava no design original — veja [Desvios](#desvios-e-adições)._
- **PRs do GitHub** solicitando minha revisão.

Cada linha mostra o suficiente em um relance para triar sem clicar (título, fonte, idade, indicador de prioridade). Itens de alta prioridade se destacam visualmente dos de baixa prioridade.

**Mapeia para:** [POPBOT_DESIGN.md → Layout do app](POPBOT_DESIGN.md#layout-do-app) (painéis Tickets / Reviews — estender com um painel Slack).

---

## US-2 · Ativação em um clique

> *"Eu deveria conseguir iniciar atividade em qualquer um desses facilmente, e abrir um chat para começar o trabalho."*

Clicar em qualquer linha na fila de atenção gera um novo chat semeado para aquele trabalho:

- Ticket do Linear → chat semeado com o corpo do ticket, branch nomeado pela chave do ticket, prompt do agente pré-preenchido.
- Mensagem do Slack → chat semeado com o contexto da conversa, pronto para rascunhar uma resposta ou iniciar trabalho real.
- PR → chat semeado com o diff e checklist de revisão.

Nenhum atrito de configuração entre "vejo algo que preciso tratar" e "um agente está trabalhando nisso."

**Mapeia para:** [POPBOT_DESIGN.md → Layout do app](POPBOT_DESIGN.md#layout-do-app) ("Clique em uma linha → gere um chat semeado para aquele trabalho").

---

## US-3 · Teste de jogo real no chat

> *"Chats deveriam conseguir engajar uma instância Unity e rodar unity/server quando necessário para que possam testar e depurar o trabalho."*

Quando um chat precisa verificar comportamento no jogo real, o chat adquire um slot, gera a Unity (posicionada na tela 2), e opcionalmente gera o servidor sidecar. O agente conduz o jogo via o MCP no Editor — entrando em modo Play, clicando na UI, tirando screenshots, lendo logs, verificando estado.

Adquirir um slot é a parte lenta na primeira vez (~15-30 s a frio); atividade subsequente é pegajosa (~50 ms).

**Mapeia para:** [POPBOT_DESIGN.md → Tipos de chat](POPBOT_DESIGN.md#tipos-de-chat) (Client Test / Server Test), [Slots](POPBOT_DESIGN.md#slots--a-unidade-durável), [Superfície de automação MCP](POPBOT_DESIGN.md#superfície-de-automação-mcp).

---

## US-4 · Conclusão autônoma de ponta a ponta com prova

> *"Agentes deveriam conseguir trabalhar de forma totalmente autônoma, e corrigir/depurar e completar um ticket inteiro, incluindo entregar prova de que a correção/mudança funcionou como exigido em um documento markdown que possa ser inspecionado."*

No modo autônomo o agente executa um ciclo completo de ler → reproduzir → corrigir → verificar sem intervenção, e escreve um artefato `proof.md` no final. A prova contém:

- **Reprodução** — os passos exatos que demonstraram o bug.
- **Antes** — screenshots + dumps de log filtrados do estado quebrado.
- **Causa raiz** — o diagnóstico do agente.
- **Correção** — o diff ou resumo das mudanças.
- **Depois** — screenshots + dumps de log limpos do estado corrigido.
- **Verificação** — uma nova execução da reprodução, agora passando.

Posso abrir o `proof.md` e decidir se o trabalho está bom sem re-executar nada eu mesmo. Pausar-para-revisar só é necessário para operações arriscadas (`git push`, `gh pr create`, etc.).

**Mapeia para:** [POPBOT_DESIGN.md → Modo autônomo](POPBOT_DESIGN.md#modo-autônomo), [Artefatos de prova](POPBOT_DESIGN.md#artefatos-de-prova-entregável-de-depuração-do-agente).

---

## US-5 · Multitarefa fácil via miniaturas

> *"Eu deveria conseguir facilmente fazer multitarefa entre agentes, clicando em miniaturas."*

A faixa de miniaturas é a superfície de navegação primária para trabalho paralelo. Uma linha de prévias compactas — uma por chat — me permite pular entre agentes instantaneamente. Clicar em uma miniatura traz aquele chat para o primeiro plano; os outros chats continuam rodando em segundo plano.

A própria miniatura comunica estado, não apenas identidade. Veja US-6.

**Mapeia para:** [POPBOT_DESIGN.md → Layout do app](POPBOT_DESIGN.md#layout-do-app) (linha de miniaturas), Fase 3 em [PHASING.md](PHASING.md).

---

## US-6 · Status em um relance

> *"Eu deveria conseguir facilmente ter uma ideia do que um agente está fazendo, e se precisa de assistência ou direção minha, em um relance."*

Toda miniatura de chat mostra seu estado atual sem que eu precise clicar nela:

| Cor | Significado |
|---|---|
| Azul | Em execução |
| Verde | Tarefa concluída |
| **Amarelo** | **Pausado — precisa de mim** |
| Vermelho | Com erro |
| Cinza | Ocioso / não iniciado |

Amarelo é o que exige atenção. Escanear a linha de miniaturas deveria responder "alguém está travado?" em menos de um segundo. Além da cor, a miniatura exibe uma breve dica de progresso (última ação, etapa atual) para que eu possa decidir se vale a pena entrar.

**Mapeia para:** [POPBOT_DESIGN.md → Cores de status](POPBOT_DESIGN.md#cores-de-status-miniatura-do-chat).

---

---

## US-7 · Recuperar e continuar de qualquer lugar

> *"Eu deveria conseguir facilmente recuperar e continuar com tickets, mesmo os que não estão mais ativos, de onde parei."*

Um chat é durável. Mesmo depois de fechá-lo, reiniciar o PopBot, ou reiniciar a máquina, posso reabrir qualquer chat passado e retomar exatamente de onde parei:

- A transcrição completa é reproduzida na coluna do chat.
- O slot é readquirido (ou reiniciado a frio) no mesmo branch em que eu estava.
- O estado da Unity + sidecar restaura para a fixture / save blob relevante, se uma foi definida.
- O agente relê a transcrição recente antes de responder à minha próxima mensagem — o contexto não se perde entre reinícios.

Fechar um chat libera seu slot; reabrir readquire. O chat é o registro durável; o slot é infraestrutura transitória.

**Mapeia para:** [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--a-unidade-durável) (ciclo de vida de slot vs. chat), [Stack técnica → better-sqlite3](POPBOT_DESIGN.md#stack-técnica) (persistência de transcrição). O esquema de registro por chat vive em `src/main/persistence/`.

---

## US-8 · Inspeção por ticket: chat + Unity + logs + prova

> *"Eu deveria conseguir facilmente dar uma olhada no progresso de um ticket mostrando o conteúdo, a instância server/Unity em execução, logs relevantes, artefato de conclusão (markdown)."*

Para qualquer chat (ativo ou pausado), um clique traz tudo que preciso para avaliar o progresso:

- **Conteúdo do chat** — a transcrição em execução com o raciocínio, chamadas de ferramenta e saídas do agente.
- **Status de server / Unity** — o slot está ativo, em qual branch, qual é a pilha de telas, a Unity está em modo Play.
- **Logs relevantes** — console da Unity + servidor sidecar, filtrados para a sessão do chat, com rolagem sincronizada.
- **Artefato de conclusão** — o `proof.md` (e os `before/`, `after/`, `diff.patch` de apoio) que o agente produziu, renderizado inline.

Esta é a visão "me mostre o que aconteceu." Não a torrente bruta — a seção transversal curada que responde "isso foi bem feito?"

**Mapeia para:** [POPBOT_DESIGN.md → Layout do app](POPBOT_DESIGN.md#layout-do-app) (coluna de chat + painel de log inferior), [Artefatos de prova](POPBOT_DESIGN.md#artefatos-de-prova-entregável-de-depuração-do-agente). O renderizador de prova vive em `src/renderer/chat/ProofViewer.tsx` (planejado).

---

## US-9 · Concessões de permissão just-in-time

> *"Eu deveria conseguir facilmente dar permissão a agentes para fazer várias coisas que eles não deveriam ter permissão de fazer de forma inteiramente autônoma."*

Quando um agente quer fazer algo na lista de sempre-pausar (`git push`, `gh pr create`, `rm` fora do slot, chamadas de rede para hosts não permitidos, etc.), o PopBot pausa e me pergunta. O fluxo de concessão é:

- Um modal aparece com **o que** o agente quer fazer, **por quê** (o motivo declarado do agente), e o **comando / argumentos**.
- Posso **permitir uma vez**, **permitir para este chat / sessão**, **sempre permitir** (regra durável por ferramenta, por alvo), ou **negar**.
- Regras de permissão acumulam por chat, exibidas no painel de configurações do chat para que eu possa revogá-las.
- A lista de negação fixa no código nunca é sobrescrevível pela UI — veja [adr/0004](../adr/0004-canusetool-policy-boundary.md).

O ponto: autonomia é o padrão, mas posso aprovar sem atrito uma ação arriscada específica sem abrir um terminal ou ficar de babá do agente.

**Mapeia para:** [POPBOT_DESIGN.md → Modo autônomo](POPBOT_DESIGN.md#modo-autônomo), [adr/0004 — Limite de política canUseTool](../adr/0004-canusetool-policy-boundary.md). O armazenamento de concessões vive em `src/main/agents/policy/`.

---

## Desvios e adições

Esta seção sinaliza lugares onde as histórias de usuário divergem do design fixado. Ao implementar, use as histórias de usuário como a fonte da verdade e atualize o documento de design.

### Slack como uma terceira fonte de atenção (US-1)

O design original cobre tickets do Linear e PRs não revisados. Mensagens do Slack não estavam no escopo. Para honrar a US-1:

- Adicionar um **painel Slack** ao grupo de abas superior-esquerdo ao lado de Tickets e Reviews.
- Fonte: DMs do Slack, @menções, e mensagens em canais que possuo. Regras de filtragem a definir por fluxo de geração de chat.
- Autenticação: OAuth do Slack (token no chaveiro via `keytar`).
- Gerar um chat a partir de uma mensagem do Slack semeia o agente com o contexto da conversa.

Este é um **subsistema totalmente novo** — cliente de API do Slack em `src/main/slack/`, painel em `src/renderer/panels/slack/`. Faseie-o em [PHASING.md](PHASING.md) Fase 3 ao lado dos outros painéis, mas trate-o como um par de primeira classe, não uma reflexão tardia.
