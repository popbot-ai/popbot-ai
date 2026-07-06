<div align="center">

![PopBot — a battle-tested multi-chat & multi-slot agentic coding tool](../../images/hero_banner_2.png)

Uma ferramenta desktop battle-tested para rodar uma equipe de agentes de IA de codificação em paralelo — um por ticket, bug ou revisão, cada um isolado em seu próprio "slot" aquecido, cada um capaz de compilar, executar e testar seu app de ponta a ponta.

[Por que o PopBot](#por-que-o-popbot) · [Recursos](#recursos-definidores) · [Como funciona](#anatomia-do-workspace) · [Um dia com o PopBot](#um-dia-com-o-popbot) · [Instalação](#instalação) · [Faça do seu jeito](#faça-do-seu-jeito)

</div>

---

## Por que o PopBot

Rodar um único agente de IA de codificação é simples. Rodar vários ao mesmo tempo introduz problemas que um agente único não tem: manter o trabalho deles isolado para que não sobrescrevam uns aos outros, de fato testar o que constroem, revisar isso, e colocar um portão nas ações irreversíveis para que nenhum agente tome uma sem supervisão.

O PopBot é uma camada de orquestração para isso. Ele transforma tickets e solicitações de revisão em sessões de agente de um clique, dá a cada agente um workspace isolado (sua própria cópia de trabalho — e, para projetos de jogos, sua própria cópia em execução do app sob teste), executa-os de forma autônoma por padrão com um portão humano em ações arriscadas, e reúne cada transcrição, diff, terminal e log em uma única janela. O operador passa os olhos pelas colunas, aprova as ações bloqueadas e publica.

Foi construído por uma pequena equipe na **Proof of Play** e usado diariamente em um projeto de produção real e pesado em assets que foi lançado. Esse é o ambiente em que foi comprovado: muitos gigabytes de assets, controle de versão real, prazos reais. O modelo de slots — workspaces aquecidos, isolados, copy-on-write — foi o que tornou viável rodar agentes em paralelo ali, e aumentou o quanto a equipe conseguia fazer de uma vez. Publicamos e damos suporte ao PopBot como uma implementação de referência: não um produto acabado para consumir como está, mas uma forma para ser pega e remodelada para sua própria stack e fluxo de trabalho. Isso reflete uma visão sobre como o software é melhor construído na era da IA — que equipes rodando frotas de agentes são mais bem servidas possuindo e modificando a ferramenta do que adotando uma fixa. É licenciado sob MIT e organizado para ser bifurcado (fork); veja [Faça do seu jeito](#faça-do-seu-jeito).

![The PopBot workspace — the thumbnail strip, side-by-side chat columns, and a per-chat terminal](../../images/screenshot1.png)

<div align="center"><em>Uma sessão real do PopBot — vários agentes trabalhando em paralelo, cada um em seu próprio slot. Miniaturas ao vivo no topo, chats em foco em colunas, um terminal por chat abaixo, e o painel de controle de versão à direita.</em></div>

## Recursos definidores

### Visão multi-chat com miniaturas ao vivo

Todo chat aberto permanece na tela — uma faixa de **miniaturas ao vivo** acima de **colunas** lado a lado. Cada miniatura é uma visão real e atualizada daquele chat (não apenas um ponto de status), codificada por cor conforme o estado: em execução, concluído, aguardando você, erro. Em um relance você vê *o que cada agente está fazendo* e quem precisa de você — e você pode **detectar um caminho errado cedo**, redirecionando antes que consuma tempo e tokens. Uma pessoa supervisiona uma frota inteira a partir de uma única janela.

### Slots aquecidos — agentes em paralelo sem o imposto de re-importação

Cada chat em atividade arrenda um **slot** — uma cópia de trabalho persistente mais seu próprio estado de build aquecido, criado uma vez e reutilizado. Para uma engine de jogo, isso significa que o slot mantém seu próprio cache de assets quente (o `Library` da Unity, o DDC da Unreal) e pode manter o editor em execução, então trocar um agente de volta para seu slot leva **segundos, não uma reimportação de vários minutos**. Dez agentes rodam em verdadeiro isolamento de branch sem sobrecarregar um único cache de importação. [Como os slots funcionam →](../pt-BR/GUIDE.md#slots-workspaces-aquecidos-isolados-e-descartáveis)

### Cópias ilimitadas no disco de um único repositório

O workspace de um slot é uma **pasta copy-on-write**: cada slot compartilha uma imagem base e armazena apenas o que altera. Assim, uma cópia fresca, ao vivo e completa de uma árvore de jogo em **escala de terabytes** fica pronta em **segundos** — arquivos editáveis reais, não uma visão superficial — e cópias ilimitadas custam o disco de um único repositório. Funciona no **Windows, macOS e Linux**, e é o que permite que árvores Perforce enormes participem da frota. [Por que isso importa →](../pt-BR/GUIDE.md#copy-on-write-cópias-ilimitadas-no-disco-de-um-único-repositório)

### Git e Perforce, com revisão integrada

O controle de versão é um **provedor** por trás de uma única interface: **Git** (worktrees, branches, PRs via `gh`) e **Perforce** (streams sobre shadow workspaces, changelists, revisões do **Helix Swarm**) são ambos de primeira classe. Um painel de controle de versão escopado ao *workspace próprio de cada chat* mostra status, commits e diffs por arquivo exatamente daquele branch. Ações com template de um clique (**Commit**, **Push PR**, **Make ready**, **Address CR**, **Rebase onto base**) enviam uma instrução pré-preenchida para o agente daquele chat, com `${branch}` / `${ticket}` / `${prnum}` preenchidos.

### Uma caixa de entrada, muitas fontes

O ciclo inteiro em um só lugar: sua **caixa de entrada** — tickets atribuídos do **Linear**, **Jira** e **GitHub Issues**, além de revisões aguardando você como **GitHub PRs** e **changelists do Swarm** → trabalho do agente **em andamento** em slots isolados → **push** e abrir o PR / revisão → **arquivar** um chat concluído → **reabrir e reiniciar** mais tarde com o histórico completo. Clique em um ticket e o PopBot nomeia o branch, arrenda um slot, move o ticket para *Em andamento*, e alimenta o agente — então o conduz até uma mudança mesclada e de volta. [Passo a passo dos fluxos de trabalho →](../pt-BR/GUIDE.md#fluxos-de-trabalho-de-ponta-a-ponta)

## Recursos adicionais

- **O verdadeiro Claude Code e Codex — não uma reimplementação.** Cada chat conduz o agente *real* através de seu SDK oficial — as mesmas CLIs `claude` e `codex` que você roda em um terminal, com todas as suas ferramentas, skills e servidores MCP intactos. Escolha o modelo (Opus / Fable / GPT) e o esforço de raciocínio por chat, troque no meio da sessão, ou reinicie uma sessão nova preparada com o histórico do chat.
- **Agentes que testam seu próprio trabalho.** Um slot pode iniciar o app real — para Unity e Unreal, um editor ao vivo + servidor sidecar em um segundo monitor, conduzido pelo agente por um servidor MCP no próprio editor em uma **porta por slot** — então o agente clica pela UI, lê logs e verifica suas mudanças em vez de adivinhar. Engines customizadas também são suportadas.
- **Chats persistentes e arquiváveis.** Todo chat é uma transcrição durável; feche-o para liberar seu slot, e reabra-o depois com o histórico completo intacto.
- **Terminal por chat e código clicável.** Um terminal embutido fixado no workspace do chat, e links `file.ts:42` que abrem no VS Code ou Cursor.
- **Autônomo, mas nunca imprudente.** Os agentes executam automaticamente trabalho seguro dentro de seu slot e pausam para você em qualquer coisa arriscada — `git push` / `p4 submit`, abrir PRs, qualquer coisa fora do workspace, chamadas de rede. As concessões são por chat, duráveis e revogáveis — servidores MCP incluídos.
- **Totalmente localizado.** A interface inteira é entregue em doze idiomas (inglês, espanhol, francês, alemão, japonês, coreano, chinês simplificado, português brasileiro, russo, italiano, polonês, ucraniano), alternável a qualquer momento pelo menu de idioma.
- **Multi-repositório.** Conduza vários repositórios lado a lado, cada um com seu próprio pool de slots, cor, provedor e convenções de branch.

## Como o PopBot é diferente

Ferramentas de codificação agêntica tendem a se encaixar em algumas categorias. O PopBot ocupa um lugar diferente: um **cockpit local para rodar muitos agentes *reais* em paralelo, com estado de build aquecido e supervisão humana ao vivo.**

| Em vez de… | …o PopBot |
|---|---|
| **Um agente em um terminal ou IDE** — uma única tarefa em uma única árvore de trabalho por vez | **Muitos agentes de uma vez**, cada um isolado em seu próprio slot aquecido, todos visíveis como uma frota ao vivo que você direciona a partir de uma única janela |
| **Agentes em nuvem assíncronos** — opacos e remotos; envie uma tarefa, espere por um PR | **Local e ao vivo** — observe cada agente trabalhar e detecte um caminho errado cedo, e ele conduz *seu app real* (um editor de engine em uma segunda tela) para um teste de ponta a ponta genuíno |
| **Malabarismo caseiro com `tmux` + worktrees** — paralelo, mas manual, e cada novo checkout paga o imposto de reimportação de vários minutos da engine | **Slots aquecidos gerenciados** — workspaces reutilizados, copy-on-write, que mantêm o cache de assets quente, com ciclo de vida de branch/workspace, o painel SCM e revisão de código tratados para você |
| **Frameworks de orquestração de agentes** — kits de ferramentas para *construir* sistemas de agentes | **Um app finalizado e opinativo** conectado à sua caixa de entrada e ciclo de revisão — humano-no-circuito por design, não uma biblioteca para montar |

E criticamente: o PopBot não substitui o Claude Code ou o Codex — ele **os executa**. Você obtém os agentes exatos (e suas versões exatas de CLI) em que você já confia, só que muitos de uma vez, com a orquestração, o isolamento e a supervisão envolvendo-os.

## Anatomia do workspace

![PopBot UI anatomy](../../images/anatomy.png)

| Região | O que é |
|---|---|
| **Caixa de entrada — tickets e revisões** | Tickets atribuídos (Linear / Jira / GitHub Issues) e revisões aguardando você (GitHub PRs / changelists do Swarm), classificados. Um clique gera um chat. |
| **Slots** | O pool de workspaces aquecidos e isolados — uma cópia de trabalho copy-on-write *mais* estado de build persistente (para uma engine de jogo, seu próprio cache de assets quente). Um chat arrenda um enquanto trabalha e o devolve ao fechar. |
| **Arquivo de chats** | Todo chat passado, pesquisável e reabrível com histórico completo. |
| **Miniaturas de chat** | Uma faixa ao vivo de todos os chats abertos — codificada por cor conforme o status (em execução / concluído / precisa de você / erro). |
| **Chats** | As sessões de agente em foco: texto, chamadas de ferramenta e diffs de código inline, transmitidos ao vivo. |
| **Terminal por chat** | Um terminal embutido apontado para o workspace daquele chat, para comandos manuais. |
| **Painel SCM** | Status da árvore de trabalho / changelist, commits, diffs de arquivo, e ações de um clique de commit / push / PR / revisão. |

## Um dia com o PopBot

**Um ticket de feature.** Um ticket chega na sua caixa de entrada. Clique nele → o PopBot abre um chat em `you/eng-123-…`, arrenda um slot, move o ticket para *Em andamento*, e entrega ao agente a descrição completa. Ele escreve o código, executa o app em seu slot para verificar, e pausa para seu OK antes de fazer o push. Você revisa o diff no painel SCM e clica em **Push PR**.

**Um bug, em paralelo.** Enquanto isso está rodando, chega um relatório de bug. Gere um segundo chat — seu próprio slot, seu próprio branch — e os dois agentes trabalham simultaneamente sem nunca tocar na árvore um do outro. A faixa de miniaturas mostra ambos: um verde (concluído), um azul (em execução).

**Uma solicitação de revisão.** O PR de um colega de equipe (ou changelist do Swarm) aparece na sua aba Revisões. Clique nele → um chat de revisão **sem repositório** instantâneo se abre, o agente lê o diff *e* o código ao redor, caça bugs reais, e posta uma revisão inline no GitHub ou Swarm — enquanto seus dois chats de build continuam.

**Retome amanhã.** Feche os chats concluídos para liberar seus slots. Na manhã seguinte, reabra o chat da feature a partir do arquivo para tratar o feedback da revisão — o agente retoma com a conversa inteira e seu workspace intactos.

→ Passo a passos completos (fluxos de feature, bug e revisão, além de como slots, workspaces copy-on-write e reabertura funcionam por baixo do capô) estão no **[Guia de Recursos e Fluxo de Trabalho](GUIDE.md)**.

## Instalação

Instaladores assinados e pré-compilados estão disponíveis em **[popbot.app](https://popbot.app)**:

- **macOS** — `.dmg` assinado e notarizado (Apple silicon)
- **Windows** — instalador `.exe` assinado
- **Linux** — pacote `.deb`

O app se atualiza automaticamente a partir de seu canal de release. Para rodar sua própria build, veja [Compilar a partir do código-fonte](#compilar-a-partir-do-código-fonte).

## Compilar a partir do código-fonte

```bash
npm install
npm run dev        # run the app in development
npm run package    # build a signed installer for your platform
```

**Requisitos**

- **macOS, Windows ou Linux.** macOS é a plataforma mais exercitada (o fluxo de app-sob-teste em segunda tela depende das APIs de Acessibilidade do macOS); Windows e Linux são suportados e distribuídos — veja [WINDOWS.md](WINDOWS.md) para as notas de configuração Windows/WSL.
- **Node 20+** (Node 20 / 22 evitam uma recompilação de módulo nativo; veja as notas do Windows).
- As CLIs **`claude`** e/ou **`codex`** (os backends de agente), além de **`git`** e, para fluxos GitHub, **`gh`**. Para Perforce, a CLI **`p4`**.
- Credenciais (Linear, Jira, GitHub, Helix Swarm) são armazenadas **localmente na sua máquina**, no próprio banco de dados do app — nunca neste repositório.
- Opcional: um editor Unity ou Unreal para projetos de jogos; VS Code / Cursor; iTerm.

## Faça do seu jeito

O PopBot é publicado como uma implementação de referência, feita para ser bifurcada (fork) e adaptada em vez de adotada como está. Sua forma é geral — **agentes + slots isolados, aquecidos, copy-on-write + uma caixa de entrada como fila + um app sob teste** — e o código é organizado como *provedores por trás de pequenas interfaces comuns*, para que uma equipe possa trocar uma parte sem tocar no resto. É **licenciado sob MIT**. A abordagem geral é manter as ideias centrais e substituir as instâncias específicas:

- **Troque o app sob teste.** Unity e Unreal são duas implementações de "deixe o agente rodar e verificar o app." O hook de engine customizada já passa a identidade do slot adiante para seu comando de lançamento — aponte-o para seu app web, CLI ou harness de teste. *(`src/shared/gameEngine.ts`, `src/main/ipc/apps.ts`)*
- **Aponte a caixa de entrada para outro lugar.** Linear, Jira e GitHub Issues são exemplos funcionais; adicione um rastreador implementando uma interface e registrando-o. *(`src/main/tickets/`)*
- **Adicione ou troque o controle de versão.** Estenda a classe base do provedor ao lado de Git e Perforce; os chamadores ramificam-se em *capacidades*, nunca no id do provedor. *(`src/main/scm/`)*
- **Reconfigure as ações e prompts.** Convenções de branch, fluxos de PR/revisão, e todo prompt semeado são templates editáveis em Preferências — sem necessidade de código.
- **Mantenha o núcleo.** Slots aquecidos, workspaces copy-on-write, chats persistentes, o piso de permissão fixo no código, e o cockpit de agentes paralelos são a espinha dorsal durável.

O **[Guia de Recursos e Fluxo de Trabalho](GUIDE.md)** explica o raciocínio por trás de cada costura; o documento de **[Arquitetura](ARCHITECTURE.md)** mapeia onde encontrá-la no código.

## Documentação

| Doc | O que tem dentro |
|---|---|
| **[Guia de Recursos e Fluxo de Trabalho](GUIDE.md)** | O tour completo — as ideias, como cada peça funciona, e fluxos de trabalho de ponta a ponta. Comece aqui. |
| **[Guia de Configuração](CONFIGURATION.md)** | Configure cada painel de Preferências — integrações, repositórios, slots, agentes — com capturas de tela. |
| [USER_STORIES.md](USER_STORIES.md) | As histórias de usuário contra as quais o PopBot foi medido. |
| [CORE_MODEL.md](CORE_MODEL.md) | O modelo de objetos — Chat, Message, Slot, AgentSession — e seus ciclos de vida. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Limites de processo, IPC, onde cada subsistema vive. |
| [WINDOWS.md](WINDOWS.md) | Notas de configuração Windows / WSL. |
| [POPBOT_DESIGN.md](POPBOT_DESIGN.md) | A especificação de design original (histórica). |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Configuração de desenvolvimento local, scripts, convenções. |

## Licença

[MIT](../../LICENSE) © 2026 Proof of Play, Inc. Componentes de terceiros e marcas registradas estão listados em [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) — note que a dependência de runtime `@anthropic-ai/claude-agent-sdk` é proprietária e usada sob os termos da Anthropic, não sob a licença MIT.
