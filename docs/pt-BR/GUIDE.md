*Languages: [English](../GUIDE.md) · [Español](../es/GUIDE.md) · [Français](../fr/GUIDE.md) · [Deutsch](../de/GUIDE.md) · [日本語](../ja/GUIDE.md) · [한국어](../ko/GUIDE.md) · [简体中文](../zh-CN/GUIDE.md) · **[Português (Brasil)](GUIDE.md)** · [Русский](../ru/GUIDE.md) · [Italiano](../it/GUIDE.md)*

# PopBot — Guia de Recursos e Fluxo de Trabalho

O PopBot é um cockpit desktop para rodar **muitos agentes de IA de codificação em paralelo**. Este guia cobre as ideias sobre as quais ele foi construído — por que existe, como as peças funcionam, o que moldou o design, e como uma equipe na Proof of Play o usou em um projeto real, pesado em assets, que foi lançado. É escrito para engenheiros que conseguem encontrar a UI por conta própria; o ponto aqui é o raciocínio, para que você possa adaptar a ferramenta ao seu próprio fluxo de trabalho em vez de seguir um roteiro.

Adaptá-la ao seu fluxo de trabalho é um uso pretendido, não uma reflexão tardia. O PopBot é publicado como uma implementação de referência — uma forma para modificar para sua equipe em vez de um produto fixo — refletindo uma visão sobre como o software é melhor construído na era da IA: equipes rodando frotas de agentes são geralmente mais bem servidas possuindo e remodelando a ferramenta do que adotando uma cujas decisões são fixas para elas. Leia o "porquê" por trás de cada peça abaixo como um mapa de onde você cortaria para mudá-la. [Faça do seu jeito](#faça-do-seu-jeito) cobre o como, onde e por quê em detalhe.

- [Por que construímos o PopBot](#por-que-construímos-o-popbot)
- [Conceitos centrais](#conceitos-centrais)
  - [Agentes e modelos](#agentes-e-modelos)
  - [Slots: workspaces aquecidos, isolados e descartáveis](#slots-workspaces-aquecidos-isolados-e-descartáveis)
  - [Copy-on-write: cópias ilimitadas no disco de um único repositório](#copy-on-write-cópias-ilimitadas-no-disco-de-um-único-repositório)
  - [Controle de versão: Git e Perforce](#controle-de-versão-git-e-perforce)
  - [A caixa de entrada: uma fila, muitas fontes](#a-caixa-de-entrada-uma-fila-muitas-fontes)
  - [Chats sem repositório (para revisão de código)](#chats-sem-repositório-para-revisão-de-código)
  - [Branch base](#branch-base)
  - [Chats persistentes e arquiváveis](#chats-persistentes-e-arquiváveis)
- [Anatomia do workspace](#anatomia-do-workspace)
- [Como foi usado na Proof of Play](#como-foi-usado-na-proof-of-play)
- [Fluxos de trabalho de ponta a ponta](#fluxos-de-trabalho-de-ponta-a-ponta)
  - [Um ticket de feature](#um-ticket-de-feature)
  - [Um ticket de bug](#um-ticket-de-bug)
  - [Uma revisão de código](#uma-revisão-de-código)
  - [Reabrindo um chat arquivado](#reabrindo-um-chat-arquivado)
- [Controle de versão e revisão integrados](#controle-de-versão-e-revisão-integrados)
- [Testando em um slot: o app sob teste](#testando-em-um-slot-o-app-sob-teste)
- [Permissões e segurança](#permissões-e-segurança)
- [Localização](#localização)
- [Preferências](#preferências)
- [Faça do seu jeito](#faça-do-seu-jeito)

---

## Por que construímos o PopBot

Um único agente de IA de codificação é fácil de rodar. No momento em que você quer **mais de um trabalhando ao mesmo tempo**, três problemas aparecem:

1. **Isolamento.** Dois agentes editando o mesmo checkout corrompem o trabalho um do outro. Você não pode ter três agentes e uma única árvore de trabalho — e em um projeto de jogo grande, também não pode arcar com três checkouts completos.
2. **Supervisão.** Agentes são rápidos e majoritariamente corretos, mas "majoritariamente" não é bom o suficiente para `git push`, `p4 submit`, ou abrir um PR. Você precisa de um portão humano nas ações irreversíveis — sem ficar de babá em cada edição de arquivo.
3. **Verificação.** Código que compila não é código que funciona. Para um jogo especialmente, o único teste real é *rodá-lo* e clicar pelas telas. Um agente que não consegue ver o app está apenas adivinhando.

O PopBot foi construído para resolver os três para uma pequena equipe lançando um jogo ao vivo. A ideia central: tratar cada unidade de trabalho — um ticket, um bug, uma revisão — como um **chat**, dar a cada chat seu próprio **workspace** isolado mais (quando necessário) sua própria cópia em execução do app, executá-los de forma **autônoma mas bloqueada**, e exibir a frota inteira em uma única janela para que uma pessoa possa liderar uma dúzia de agentes de uma vez.

O design foi guiado por um conjunto concreto de [histórias de usuário](USER_STORIES.md): *"Como engenheiro, clico em um ticket e um agente começa a trabalhar nele em um branch correto."* *"Como revisor, abro uma changelist e recebo uma revisão real sem fazer checkout de nada."* *"Como líder, olho para o painel e sei quais agentes precisam de mim."* Tudo abaixo existe para servir a isso. Se você entender *por que* cada peça é moldada da forma que é, saberá quais partes manter e quais substituir ao bifurcar (fork) para sua própria stack.

---

## Conceitos centrais

### Agentes e modelos

Todo chat é conduzido por um **backend de agente**:

- **Claude Code** — via Claude Agent SDK. Modelos: **Claude Opus** (padrão) e **Claude Fable**.
- **Codex** — via OpenAI Codex SDK. Modelo: **GPT / Codex**.

O PopBot não reimplementa esses agentes — ele **conduz os reais** através de seus SDKs oficiais, que envolvem as mesmas ferramentas de linha de comando **`claude`** e **`codex`** que você rodaria em um terminal. O poder total de cada agente — suas ferramentas, skills, servidores MCP e subagentes — está disponível dentro de cada chat, e o PopBot permanece sincronizado com qualquer versão dessas CLIs que você tenha instalada. Se funciona no Claude Code de terminal, funciona aqui. Essa é uma aposta deliberada: agentes melhoram rápido, e qualquer coisa que os envolvesse ou bifurcasse ficaria obsoleta. Ao conduzir as CLIs diretamente, o PopBot herda cada atualização de graça.

Por chat, você escolhe o backend, o **modelo**, e o **esforço de raciocínio** (`low` → `xhigh` / `max` — mais esforço significa pensamento mais profundo e uso mais completo de ferramentas, a um custo/latência maior). Você define **padrões** sensatos — separadamente para *novos chats* e para *revisões de código*, já que uma revisão quer uma profundidade diferente de uma construção de feature — e sobrescreve por chat quando uma tarefa justifica.

Dois controles de sessão importam para trabalho de longa duração:

- **Trocar no meio da sessão.** Mude o modelo ou esforço em um chat em andamento; o PopBot reconfigura o agente sem perder o fio da conversa.
- **Reiniciar com contexto.** Inicie uma sessão de agente *nova*, preparada com a transcrição deste chat (seus turnos iniciais mais os mais recentes), útil quando uma sessão fica longa ou travada. O histórico da conversa é preservado; o agente simplesmente recebe um runtime limpo.

Credenciais para as integrações são armazenadas **localmente na sua máquina**, no próprio banco de dados do app — nunca neste repositório.

### Slots: workspaces aquecidos, isolados e descartáveis

Um **slot** é a unidade de paralelismo, e é a ideia central no PopBot. A forma ingênua de rodar N agentes é N checkouts do repositório — o que colide em árvores compartilhadas, ou custa N × (tempo de checkout + cache de build). Um slot é a resposta para "como você dá a um agente um lugar *real e independente* para trabalhar que também já esteja *aquecido* e *barato de devolver*."

Um slot tem três propriedades, e cada uma é estrutural:

- **Isolado.** Cada slot é seu próprio diretório de trabalho em seu próprio branch (ou stream Perforce), então N agentes editam N branches com zero interferência. O `git reset` de um agente não pode tocar no trabalho de outro.
- **Aquecido.** Um slot mantém artefatos de build com estado que persistem entre usos — para uma engine de jogo, seu próprio cache de importação/assets; um **servidor sidecar** dedicado com seu próprio diretório de dados; **portas** atribuídas; logs por slot; e, enquanto um chat está ativo, um **processo de editor** ao vivo. Um diretório de trabalho puro te dá *código-fonte* isolado; um slot te dá um lugar isolado, já *aquecido*, para compilar, executar e testar.
- **Descartável.** Slots são agrupados em pool. Um chat **arrenda** um slot livre pela sua vida útil e **devolve** ao fechar. Criar um workspace aquecido é caro; reutilizar um é quase de graça, então o PopBot mantém um pool deles aquecidos e faz o trabalho circular por ele.

**Por que "aquecido" é o jogo todo para trabalho de engine.** Uma engine de jogo mantém um cache massivo de assets processados — o `Library/` da Unity, o `DerivedDataCache` da Unreal — frequentemente vários gigabytes, caro de produzir. Um checkout novo, ou uma troca de branch que o invalida, força a engine a **reimportar o projeto**, o que pode levar muitos minutos. Pague isso a cada tarefa e a cada troca de branch e seus agentes gastam mais tempo esperando a engine do que escrevendo código. Slots eliminam esse imposto dando a cada um seu **próprio cache persistente**:

- **Trocar um agente de volta para seu slot leva segundos, não minutos** — o cache já está aquecido, então apenas assets genuinamente alterados são reprocessados.
- **Um slot pode manter o editor *em execução*.** Uma reutilização "pegajosa" (mesmo slot, mesmo branch) entrega ao agente um editor ao vivo quase instantaneamente em vez de um lançamento frio.
- **Dez agentes não sobrecarregam um único cache de importação.** Cada slot tem seu próprio cache aquecido, então trabalho paralelo de jogo nunca serializa atrás de uma única reimportação.

Antes de qualquer troca de branch, o PopBot executa uma **sequência de segurança** — ele guarda (stash) trabalho não commitado, recusa-se a sobrescrever commits que o agente possui, troca, e restaura o estado — então a transferência de um slot nunca perde trabalho silenciosamente. Slots podem rodar em modo **pool de slots** (reutilizado, o padrão) ou modo **efêmero** (um workspace novo por chat) quando você preferir trocar o aquecimento por um estado limpo.

> **Por que isso importa:** isolamento é o que torna "dez agentes de uma vez" seguro em vez de catastrófico. Aquecimento é o que o torna *rápido*. Descartabilidade é o que o torna *barato*. Remova qualquer um dos três e agentes paralelos deixam de valer a pena.

### Copy-on-write: cópias ilimitadas no disco de um único repositório

Isolamento e aquecimento só são financeiramente viáveis se os *arquivos* de um slot forem baratos. Em um repositório pequeno, N worktrees git estão bem. Em um projeto de jogo em escala de terabytes — com uma biblioteca de assets enorme e, em muitas equipes, **Perforce** em vez de Git — N cópias reais seriam centenas de gigabytes e minutos cada para materializar. Isso mata o modelo inteiro.

Então o workspace de um slot é uma **pasta copy-on-write**. Cada slot compartilha uma **imagem base** do repositório e armazena apenas os blocos que de fato altera. O resultado prático:

- **Uma cópia fresca, ao vivo e completa de uma árvore de terabytes fica pronta em segundos** — não uma visão superficial, arquivos editáveis reais — e é liberada tão rápido quanto.
- **Cópias ilimitadas custam o disco de um único repositório.** Dez agentes em um projeto de 1 TB não precisam de 10 TB; precisam de ~1 TB mais o pequeno delta de cada slot.
- **Funciona da mesma forma no Windows, macOS e Linux** (via `shado`, a camada de shadow-workspace do PopBot — VHDX de diferenciação no Windows, sistemas de arquivos CoW nativos em outros lugares), e é o que permite que árvores Perforce participem.

Esta é a peça que faz a ideia de slot escalar de "um repositório web com alguns worktrees" para "uma árvore de jogo de tamanho AAA com uma frota de agentes." É também o recurso menos visível e possivelmente o mais importante: sem cópias baratas, slots isolados aquecidos são um luxo; com elas, são o padrão.

### Controle de versão: Git e Perforce

O PopBot trata controle de versão como um **provedor** por trás de uma interface comum, porque "rodar um agente em um branch isolado, depois revisar e aterrissar a mudança" tem a mesma forma seja o backend Git ou Perforce. Ambos são de primeira classe:

- **Git** — worktrees para isolamento, branches por chat, PRs via CLI `gh`, GitHub como a superfície de revisão.
- **Perforce** — streams/branches por chat sobre shadow workspaces copy-on-write, changelists como a unidade de trabalho, e **Helix Swarm** como a superfície de revisão. Revisões do Swarm fixam na mesma caixa de entrada de Revisões que os GitHub PRs, cada uma abrindo seu próprio chat de revisão.

Os conceitos que você verá abaixo — branch base, o painel git/SCM, ações com template, a caixa de entrada de revisão — são escritos contra esta interface comum. Onde a redação diz "branch" ou "PR," leia "changelist" ou "revisão do Swarm" se você estiver no Perforce; o fluxo de trabalho é deliberadamente idêntico.

### A caixa de entrada: uma fila, muitas fontes

A caixa de entrada é uma *ideia*, não uma integração: **seu trabalho atribuído e suas revisões pendentes, classificados, cada um a um clique de distância de se tornar um chat de agente.** O que a alimenta é conectável:

- **Tickets** — issues do **Linear**, issues do **Jira**, e **GitHub Issues** atribuídos a você (o suporte a GitHub Issues é mais novo e ainda um pouco experimental). Clique em um e o PopBot nomeia um branch, arrenda um slot, move o ticket para *Em andamento*, e alimenta o agente com sua descrição.
- **Revisões** — pull requests do **GitHub** e changelists do **Helix Swarm** aguardando sua revisão. Clique em uma e um chat de revisão sem repositório abre instantaneamente.

Adicionar uma fonte não muda o fluxo de trabalho — apenas adiciona linhas à mesma fila. Esse é o ponto: o modelo de caixa-de-entrada-como-fila é genérico, e os rastreadores específicos são padrões intercambiáveis.

### Chats sem repositório (para revisão de código)

Nem todo chat precisa de um workspace. **Revisar** uma mudança é somente leitura — você não edita, você lê o diff e o código ao redor e posta comentários. Então chats de revisão são **sem repositório**: eles nascem instantaneamente, não arrendam slot, e não consomem workspace.

Esta é uma divisão deliberada e importante:

- Um **chat de build** (feature/bug) arrenda um slot, pode levar um momento para aquecer, e mantém um workspace pela sua vida útil.
- Um **chat de revisão** é **instantâneo e gratuito** — você pode abrir cinco deles para triar sua fila de revisão enquanto seus chats de build continuam rodando sem perturbação.

Isso também significa que seu pool de slots é reservado para trabalho que de fato precisa de isolamento. Revisões nunca privam builds de slots — uma propriedade que importa muito quando o pool é limitado por RAM e disco.

### Branch base

Quando um chat *de fato* escreve código, ele bifurca a partir de uma **base** — tipicamente `develop`/`main` no Git, ou a stream principal no Perforce. O PopBot define a base padrão por repositório, lembra sua última escolha para que o caso comum seja um clique, e permite bifurcar de uma linha de feature ou branch de release quando uma tarefa precisar. Ele deriva o nome do novo branch da sua convenção — por exemplo, `<username>/<ticket>-<slug>` — para que os branches sejam consistentes e rastreáveis de volta ao seu ticket. A base também potencializa ações posteriores: "rebase sobre a base," "abrir PR / revisão contra a base," e verificações de desvio dependem todas dela.

### Chats persistentes e arquiváveis

Todo chat é uma **transcrição durável** armazenada localmente — texto, chamadas de ferramenta, diffs, decisões de permissão, tudo. Nada é efêmero.

- **Fechar** um chat libera seu slot (liberando um workspace para outros agentes) mas **mantém tudo**. O chat se move para o **arquivo**.
- **Reabrir** um chat a partir do arquivo re-arrenda um slot, restaura seu branch, e o agente retoma com seu **histórico completo** — você pode retomar uma feature dias depois para tratar feedback de revisão sem reexplicar nada. Se ele reabrir em um slot *diferente*, o PopBot avisa o agente disso de antemão, para que ele se reoriente ao novo diretório de trabalho de forma limpa.
- O arquivo é pesquisável por nome, ticket, branch e conteúdo.

Como reverter é apenas "enviar outra mensagem" (não há edições destrutivas de histórico), um chat acumula a história completa e auditável de como uma mudança foi feita.

---

## Anatomia do workspace

![PopBot UI anatomy](../../images/anatomy.png)

| Região | O que é |
|---|---|
| **Caixa de entrada — tickets e revisões** | Tickets atribuídos (Linear / Jira / GitHub Issues) e revisões aguardando você (GitHub PRs / changelists do Swarm), classificados. Clique em uma linha para gerar um chat semeado com seu contexto. |
| **Slots** | O pool de workspaces aquecidos. Cada cápsula mostra se um slot está livre ou arrendado por um chat. |
| **Arquivo de chats** | Todo chat passado, pesquisável e reabrível com histórico completo. |
| **Miniaturas de chat** | Uma prévia ao vivo e rolável de todo chat aberto — uma visão real do que cada agente está fazendo agora, codificada por cor conforme o status: azul = em execução, verde = concluído, amarelo = precisa de você, vermelho = erro, cinza = ocioso. |
| **Chats** | As sessões de agente em foco — texto transmitido ao vivo, chamadas de ferramenta e diffs de código inline. |
| **Terminal por chat** | Um terminal embutido fixado no workspace daquele chat. |
| **Painel SCM** | Status da árvore de trabalho/changelist, commits recentes, diffs de arquivo, e ações de um clique de commit / push / PR / revisão. |

Porque todo chat permanece na **faixa de miniaturas** e as **colunas ficam lado a lado**, você nunca fica caçando status. A cor é o sinal — azul = em execução, verde = concluído, amarelo = precisa de você, vermelho = erro — então um relance te diz quais agentes estão trabalhando, quais estão concluídos, e quais estão **aguardando você**.

Mas cada miniatura também é uma **prévia ao vivo da conversa**, não apenas uma luz de status — então em um relance você pode ver *no que* cada agente está de fato trabalhando. É isso que permite **detectar trabalho inútil cedo**: perceber um agente indo pelo caminho errado e redirecioná-lo antes que consuma tempo e tokens, em vez de descobrir o beco sem saída depois que está "pronto." É a diferença entre supervisionar uma frota e ser surpreendido por ela.

### Por que miniaturas, e por que uma única visão

Este layout é uma resposta deliberada a um problema específico, e vale a pena declarar o raciocínio porque é a parte que a maioria das ferramentas erra.

Rodar um agente é uma tarefa de foco: você observa uma única conversa e responde. Rodar *muitos* é uma tarefa de **monitoramento**, e monitoramento tem um modo de falha diferente — o gargalo não é sua velocidade de digitação, é sua atenção. Um agente que discretamente se desvia produz trabalho que você tem que perceber, entender e descartar. Com N agentes, o custo de *não perceber* escala com N, e as interfaces naturais tornam perceber difícil: abas escondem todo agente menos um, e um modelo de lançar-e-esperar os esconde todos até que apresentem um resultado.

Então o design se compromete com duas coisas:

- **Todo agente está sempre visível.** A faixa de miniaturas mostra a frota inteira de uma vez, e cada miniatura é uma visão ao vivo da conversa real, não um spinner. A ideia é que você consiga dar um passo atrás e absorver o estado de uma dúzia de agentes em uma única passada de olhos — quais agentes estão se movendo, quais estão travados, quais estão prestes a fazer algo que você gostaria de impedir.
- **Status é uma cor, conteúdo está a um relance de distância.** A cor responde "quem precisa de mim?" em menos de um segundo; a prévia ao vivo responde "o que este está fazendo?" sem um clique; e as colunas lado a lado permitem entrar em qualquer um deles sem perder os outros. A interface é otimizada para *reverificação barata*, porque com muitos agentes você reverifica constantemente.

O retorno é a capacidade de **intervir cedo**. O erro caro com agentes autônomos não é uma falha — é um agente confiantemente gastando uma hora construindo a coisa errada. Uma visão que revela intenção continuamente transforma isso de uma descoberta posterior em uma correção de meio de percurso. Essa é toda a razão pela qual a frota fica na tela o tempo todo em vez de atrás de abas ou uma notificação.

---

## Como foi usado na Proof of Play

O PopBot não foi um experimento de laboratório. Foi construído e usado diariamente pela equipe na **Proof of Play** em um projeto real, pesado em assets, que foi lançado. Essa origem explica a maioria das escolhas de design, e é a forma mais clara de entender para que a ferramenta serve.

O resultado prático foi direto: o modelo de slots — workspaces aquecidos, isolados, copy-on-write — tornou viável o trabalho de agente paralelo em uma árvore de assets grande, e a equipe conseguiu fazer mais por causa disso. Vários agentes podiam rodar de uma vez sem colidir ou pagar o imposto de reimportação da engine a cada troca, então a vazão aumentou em vez do paralelismo se transformar em overhead.

A forma de um dia típico: um líder com o painel de miniaturas aberto, quatro ou cinco agentes em voo — um par pegando tickets de feature, um caçando um bug, um ou dois fazendo revisões de código. O líder não está escrevendo código minuto a minuto; está **observando a frota**, intervindo apenas nos portões (um push, um PR, uma ação arriscada) e quando uma miniatura fica amarela ou um agente visivelmente se desvia. Os tickets vêm do rastreador real da equipe; as revisões são PRs e changelists reais que o resto da equipe vê aterrissar.

As restrições rígidas que aquele projeto de jogo impôs são exatamente os recursos que acabaram importando mais:

- **A árvore de assets era enorme**, então slots aquecidos e workspaces copy-on-write não eram um luxo — sem eles, uma frota de agentes naquela árvore era simplesmente inviável. É por isso que essas duas ideias são a espinha dorsal da ferramenta.
- **A engine era a fonte da verdade para "isso funciona,"** então um agente que não conseguia lançar e conduzir o jogo em execução era inútil para a maior parte do trabalho de gameplay. Daí a integração de app sob teste.
- **O controle de versão era Perforce para o jogo e Git para ferramentas**, então SCM agnóstico de provedor não era opcional.
- **Uma pessoa precisava liderar muitos agentes**, então o cockpit inteiro é otimizado para *supervisão em um relance* em vez de foco profundo em sessão única.

Se sua situação rima com algo disso — uma árvore grande, um app real para testar, mais trabalho do que um agente consegue lidar — o design vai se encaixar de perto nas suas necessidades, porque foi construído exatamente para isso. Se não, a seção [Faça do seu jeito](#faça-do-seu-jeito) é sobre manter as ideias e trocar os detalhes específicos.

Uma nota sobre escopo: aquele projeto no fim não encontrou tração comercial, e não estamos alegando o contrário. Mas o problema de engenharia que ele apresentou era real — uma árvore de assets grande, uma frota de agentes, uma equipe — e as partes do PopBot que o resolveram são as partes documentadas aqui. O valor da ferramenta não depende do resultado do jogo, e preferimos declarar isso claramente a insinuar mais.

---

## Fluxos de trabalho de ponta a ponta

### Um ticket de feature

1. **Notificação → caixa de entrada.** Um ticket atribuído a você aparece na caixa de entrada de **Tickets** (o PopBot faz polling do Linear / Jira / GitHub Issues, classificado por prioridade e data de vencimento). O sino de notificação o sinaliza.
2. **Um clique para começar.** Clique na linha do ticket. O PopBot abre um diálogo de **novo chat** padronizado para seu repositório e base (lembrado da última vez) — confirme, ou ajuste o agente/modelo/esforço.
3. **Alocação de slot.** Como este chat vai escrever código, o PopBot **arrenda um slot**: escolhe um workspace livre, deriva o nome do branch `you/eng-123-<slug>` a partir do ticket, e troca o workspace para ele (executando a sequência de segurança de stash primeiro).
4. **Ticket promovido automaticamente.** O ticket é movido para **Em andamento** automaticamente (idempotente, fire-and-forget) para que seu quadro reflita a realidade sem uma troca de contexto.
5. **O agente começa.** O agente recebe uma primeira mensagem semeada (seu template customizável de *início de ticket*, preenchido com o título, descrição e branch do ticket) e começa: explorando o código, fazendo edições, rodando comandos — tudo dentro do workspace de seu slot.
6. **Verificação no slot.** Para uma mudança de jogo, o agente **lança o app em seu slot** (um editor de engine + servidor sidecar em uma segunda tela) e exercita a feature — clicando pela UI, lendo logs, tirando screenshots — em vez de adivinhar que funciona.
7. **Finalização bloqueada.** Quando está pronto para fazer push, o agente **pausa** (fazer push é uma ação bloqueada). A miniatura fica amarela ("precisa de você").
8. **Você revisa e publica.** Abra o **painel SCM**, leia o diff, e clique em **Push PR** (ou **Push draft**). A ação envia uma instrução pré-preenchida ao agente, que faz push do branch e abre o PR / revisão do Swarm contra sua base.

Durante tudo isso, você não estava observando — você estava fazendo o mesmo para outros dois tickets. Você só interveio no portão.

### Um ticket de bug

O fluxo de bug é o fluxo de feature com um ciclo mais apertado, e mostra o **paralelismo**:

1. Um relatório de bug chega (um ticket, ou você inicia um chat manualmente com a descrição do bug).
2. Gere um chat → ele arrenda **seu próprio** slot e branch. Seu chat de feature em andamento fica completamente intocado — workspace diferente, branch diferente.
3. O agente reproduz o bug **rodando o app em seu slot**, encontra a causa, corrige, e roda novamente para confirmar que a reprodução sumiu.
4. Você dá uma olhada na **faixa de miniaturas**: chat de feature verde (concluído, aguardando seu push), chat de bug azul (em execução). Dois agentes, duas árvores isoladas, zero colisões.
5. Faça push da correção quando ele pausar para aprovação.

### Uma revisão de código

1. **Notificação → Revisões.** Um colega de equipe solicita sua revisão. O PR (GitHub) ou changelist (Swarm) aparece na caixa de entrada de **Revisões**.
2. **Chat instantâneo, sem repositório.** Clique nele → um **chat de revisão** abre imediatamente — sem slot, sem checkout, sem espera. É semeado com o template de *início de revisão de código* (ler o código ao redor, não apenas o diff; rastrear os sistemas; caçar bugs reais, condições de corrida, casos extremos, questões de segurança e desempenho).
3. **Revisão real.** O agente lê o diff **e** o código ao redor, raciocina sobre correção, e posta **comentários inline** mais um veredito (aprovar / solicitar mudanças) no GitHub ou Swarm — então resume os pontos de atenção para você no chat.
4. **Re-revisão depois.** Se o autor fizer push de correções, clique em **re-revisão**: o PopBot foca o chat de revisão existente e diz ao agente para olhar **apenas os novos commits**, verificar que cada thread anterior foi de fato tratada, e atualizar sua revisão.

Tudo isso acontece enquanto seus chats de build continuam rodando — revisões nunca ocupam um slot.

### Reabrindo um chat arquivado

Trabalho raramente é feito de uma só vez. O fluxo de reabertura é de primeira classe:

1. Um chat de feature publicou seu PR; você o **fechou** para liberar o slot. Agora está no **arquivo** (transcrição totalmente preservada).
2. Dois dias depois, a mudança recebe comentários de revisão. Encontre o chat no arquivo (pesquise por ticket, branch, ou texto) e **reabra-o**.
3. O PopBot **re-arrenda um slot**, restaura o branch do chat no workspace, e o agente retoma com seu **histórico inteiro** — ele já sabe o que construiu e por quê. Se ele aterrissar em um slot diferente do anterior, o PopBot o orienta ao novo diretório de trabalho.
4. Cole ou resuma o feedback da revisão. O agente o trata, testa novamente no slot, e faz push da atualização — sem reintegração, sem contexto perdido.

Porque o branch, a transcrição e o raciocínio persistem todos, retomar uma tarefa custa segundos, não uma reexplicação.

---

## Controle de versão e revisão integrados

O controle de versão está profundamente conectado, através da CLI nativa de cada provedor — **`gh`/`git`** para GitHub, **`p4`** e a API do Swarm para Perforce — então tudo que um agente faz é atividade real que sua equipe vê nos lugares normais.

- **Caixa de entrada de revisões.** GitHub PRs e changelists do Swarm aguardando sua revisão (e suas próprias submissões recentes) surgem como fontes de chat de um clique.
- **Chips de status de PR / revisão.** Cada chat vinculado a uma mudança mostra um chip de status ao vivo — Aberto / Mesclado / Fechado / Rascunho — no qual você pode clicar para abri-lo no GitHub ou no Swarm.
- **O painel SCM.** Para qualquer chat de build, veja status da árvore de trabalho/changelist, commits recentes, e diffs por arquivo. Clique em um arquivo para uma sobreposição de diff unificado completo.
- **Ações de um clique.** Ações com template, editáveis, enviam uma instrução pré-preenchida ao agente: **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR** (tratar comentários de revisão), **Rebase onto base**. Cada uma expande variáveis como `${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, e `${prurl}` para que o agente tenha exatamente o que precisa.
- **Criação contra sua base.** Fazer push abre o PR (ou revisão do Swarm) contra a base configurada do chat, nomeado pela sua convenção de branch.

Revisão é um caminho distinto e otimizado (veja [Uma revisão de código](#uma-revisão-de-código)):

- **Sem repositório e instantânea** — sem slot, sem checkout. Trie uma fila de revisões em segundos.
- **Lê contexto, não apenas o diff** — o template de revisão direciona o agente a ler o código ao redor, rastrear sistemas, e procurar por bugs/condições de corrida/casos extremos/segurança/desempenho, não apenas carimbar o patch.
- **Posta onde sua equipe trabalha** — comentários inline e uma revisão submetida no GitHub ou Swarm.
- **Re-revisão é escopada** — em uma segunda passada, o agente examina apenas os novos commits e confirma que cada thread anterior está genuinamente resolvida antes de atualizar sua revisão.
- **Totalmente customizável** — os prompts de *início de revisão de código* e *re-revisão* são templates editáveis, para que você possa ajustar o rigor, a checklist e o tom ao padrão da sua equipe. O *procedimento de revisão em si* (como sua empresa quer que uma revisão do GitHub ou Perforce seja feita) é seu para fornecer — o PopBot recomenda e pode dar uma amostra, mas o padrão vive com sua equipe.

## Testando em um slot: o app sob teste

O slot de um chat de build não é apenas uma pasta — é um lugar para **rodar e inspecionar** o trabalho:

- **Terminal por chat.** Um terminal embutido (xterm + um PTY real) fixado no workspace do chat. Rode testes, inspecione logs, ou dispare comandos manualmente enquanto o agente trabalha. Persiste enquanto você troca entre chats.
- **Integração com editor.** Toda referência `path/to/file.ts:42` na transcrição é um link clicável que abre no **VS Code** ou **Cursor**, resolvido contra o workspace do chat.
- **O app sob teste.** Um slot pode lançar a **aplicação real** para que o agente possa conduzi-la em vez de adivinhar. Para um app web, uma CLI, ou um serviço, isso é majoritariamente obra do próprio agente — ele roda seus comandos de build e teste no terminal do slot, acessa o servidor em execução, lê a saída. O PopBot não precisa saber nada especial sobre eles; o agente os trata da mesma forma que você trataria. **Engines** de jogo são o caso que precisa de tratamento extra, porque o editor é um processo GUI de longa vida com seu próprio cache de assets e nenhum ciclo natural de "rodar e verificar" por linha de comando. Então, para **Unity** e **Unreal**, o PopBot lança um editor ao vivo + servidor sidecar, o coloca em uma segunda tela, e o expõe ao agente através de um **servidor MCP no próprio editor**. Cada editor em execução recebe sua **própria porta MCP derivada de seu slot** — então um agente fala apenas com *seu* editor, nunca com o de outro slot — e o PopBot conecta o agente de cada chat àquele endpoint automaticamente (em memória, então nada aterrissa no controle de versão). Uma engine **customizada** se encaixa na mesma maquinaria: o PopBot passa a identidade do slot adiante para seu comando de lançamento e você conecta como o agente a conduz. Em todo caso o agente pode exercitar o app — clicar na UI, ler logs, tirar screenshot, verificar comportamento — e o PopBot gerencia o ciclo de vida do editor (iniciar o servidor, verificar sua saúde, iniciar o editor, posicionar sua janela, encerrá-lo na liberação), orçando instâncias concorrentes contra a RAM disponível.

Esta é a diferença entre um agente que *acha* que sua mudança funciona e um que *viu* funcionar. Nada nisso é específico de jogos — desenvolvimento web e de outros tipos são usos igualmente de primeira classe. Engines de jogo simplesmente carregam o estado extra (um cache de assets aquecido, um editor como app-sob-teste) do qual o sistema precisa estar ciente, e esse mesmo estado extra é o que os torna a demonstração mais nítida das partes inovadoras da ferramenta: slots aquecidos, workspaces copy-on-write, e um app em execução que o agente pode conduzir.

## Permissões e segurança

Autonomia com um piso rígido:

- **Auto-permitido (silencioso):** leituras, edições e comandos de shell **dentro do workspace do slot**, chamadas aos próprios serviços do slot (incluindo seu MCP de editor), e operações internas do agente. O agente simplesmente trabalha.
- **Sempre bloqueado (pausa para você):** `git push` / `p4 submit` / reset / force, qualquer coisa **fora** do workspace, abrir PRs ou revisões, deletar fora de um diretório de rascunho, enviar mensagens (Slack/e-mail), tocar em configuração de sistema ou de agente, e chamadas de rede para hosts não permitidos.
- **Todo o resto:** pergunta para você decidir.

Quando você aprova algo, pode conceder **uma vez**, **para a sessão**, ou **durável** (sempre permitir esta ferramenta/alvo). Servidores MCP podem ser permitidos da mesma forma — permita o MCP de editor de um slot uma vez e é lembrado, com a concessão visível e revogável em Preferências → Permissões (o PopBot habilita os MCPs de editor Unity/Unreal desta forma automaticamente). Concessões são por chat ou globais e todas **revogáveis**. O piso de negação rígida (push/submit, rede, fora da árvore) vive no código e não é sobrescrevível por regras de UI — então uma concessão mal configurada não pode deixar um agente aterrissar na linha principal por conta própria.

## Localização

A interface inteira do PopBot — menus, configurações, diálogos, tudo — é totalmente localizada. O app é distribuído em **oito idiomas**: inglês, espanhol, francês, alemão, japonês, coreano, chinês simplificado, e português brasileiro — alternável a qualquer momento pelo menu de idioma sem reiniciar. (O site de marketing adicionalmente oferece russo e italiano.) Se você bifurcar o PopBot, cada locale é um único catálogo de mensagens, então adicionar ou ajustar um idioma é uma mudança contida em vez de uma caça ao tesouro pela UI.

## Preferências

Tudo é configurado no próprio app (sem editar arquivos de configuração):

- **Agentes** — modelo padrão e esforço de raciocínio, separadamente para novos chats vs. revisões de código.
- **Repositórios** — adicione/edite repositórios via um assistente cientificado de pasta primeiro, ciente de SCM: caminho, provedor (Git/Perforce), branch ou stream base, cor, prefixo de slot, diretório de workspaces, modo pool-de-slots vs. efêmero.
- **Runtime e slots** — tamanho do pool (quantos agentes rodam de uma vez), pré-criar/deletar slots, retenção de anexos, atualização de imagem base para workspaces copy-on-write.
- **Integrações** — conecte Linear, Jira, GitHub, e Helix Swarm (credenciais armazenadas localmente); taxas de polling de revisão configuráveis por provedor; teste antes de salvar.
- **Controle de versão** — convenção de nome de branch, base padrão, e os templates de ação editáveis.
- **Apps externos** — terminal (iTerm), editor (VS Code / Cursor), binários de engine e opções por engine (incluindo a porta base do MCP de editor), perfil Chrome opcional para roteamento de URL.
- **Templates de prompt** — todo prompt semeado (início de ticket, início/re-revisão, e cada ação) é editável, com um cartão de referência de variáveis.
- **Permissões** — revise e revogue concessões duráveis, incluindo permissões por servidor MCP.
- **Notificações** — posicionamento de toast e comportamento de alerta.
- **Idioma** — troque o locale da interface.

> Para uma referência painel-por-painel com capturas de tela, veja o **[Guia de Configuração](CONFIGURATION.md)**.

## Faça do seu jeito

Adaptar o PopBot é um uso pretendido primário. É publicado como uma implementação de referência, e seu design reflete uma visão sobre como o software é melhor construído na era da IA: uma equipe pega uma forma funcional, entende *por que* ela é moldada daquele jeito, e a remodela em torno de sua própria stack, ferramentas e convenções em vez de adotar uma ferramenta cujas decisões são fixas para ela.

Sua forma é geral: **agentes + slots isolados, aquecidos, copy-on-write + uma caixa de entrada como fila + um app sob teste.** Esse padrão se aplica à maioria das equipes rodando mais de um agente de codificação de uma vez. É **licenciado sob MIT** e estruturado para ser bifurcado (fork) — o código é organizado como *provedores por trás de pequenas interfaces comuns*, então uma parte pode ser adicionada ou trocada sem tocar no resto. A abordagem geral: manter as ideias centrais, substituir as instâncias específicas.

As costuras estão listadas abaixo com *como, onde e por quê* para cada uma. Cada uma é uma interface com implementações conectáveis; o caminho prático é encontrar um padrão em uma implementação existente e adicionar a sua.

- **Troque o app sob teste.** *Por quê:* o ponto inteiro é um agente que *roda e verifica* seu app, e "seu app" é diferente para todo mundo. *Onde:* `src/shared/gameEngine.ts` (descritores de engine, conexão MCP) e `src/main/ipc/apps.ts` (lançamento + ciclo de vida). Unity e Unreal são duas implementações; o hook de **engine customizada** já passa a identidade do slot (`POPBOT_SLOT`, portas derivadas) adiante para seu comando de lançamento, então conectar seu app web, CLI, ou harness de teste é "preencher o comando de lançamento e como o agente fala com ele."
- **Aponte a caixa de entrada para outro lugar.** *Por quê:* a caixa-de-entrada-como-fila é a ideia durável; o rastreador específico é um detalhe. *Onde:* `src/main/tickets/` — implemente a interface `TicketSource` em `provider.ts`, normalize os dados do seu rastreador nos DTOs compartilhados, e registre-o em `registry.ts` (o cabeçalho do arquivo literalmente observa: *"adicionar um rastreador é uma única linha aqui mais seu módulo `*Source.ts`"*). Linear, Jira, e GitHub Issues são os exemplos funcionais. O renderer nunca ramifica no id do provedor, então você não toca na UI.
- **Adicione ou troque o controle de versão.** *Por quê:* "isolar uma mudança, revisá-la, aterrissá-la" é agnóstico de provedor; Git e Perforce são apenas dois backends. *Onde:* `src/main/scm/` — estenda a classe base `SourceControlProvider` (`provider.ts`), seguindo `gitProvider.ts` / `perforceProvider.ts`. Comportamento que não se abstrai de forma limpa é **detectado por capacidades**, não `if (provider === …)`, então um VCS muito diferente pode até optar por sua própria UI de cliente sem que os chamadores façam tratamento especial.
- **Troque a superfície de revisão.** *Por quê:* revisões devem aterrissar onde sua equipe já olha. *Onde:* os provedores de revisão por trás de `src/main/reviews/` (GitHub PRs via `git/reviews.ts`, changelists do Swarm via `p4/swarmReviews.ts`). O *procedimento de revisão em si* — como sua empresa quer que uma revisão seja feita — é intencionalmente **não** distribuído na ferramenta; é uma skill por empresa que você fornece, então o PopBot recomenda e dá amostras mas nunca impõe seu padrão.
- **Reconfigure as ações e prompts.** *Por quê:* convenções de branch, fluxos de PR/revisão, e como você orienta um agente são específicos da equipe. *Onde:* nenhum código necessário — os templates de ação git e todo prompt semeado (início de ticket, início/re-revisão) são **editáveis em Preferências**, com um cartão de referência de variáveis. Mude o rigor, a checklist, o tom.
- **Mantenha o núcleo.** *Por quê:* estas são as ideias que fazem a coisa toda funcionar, e são as partes que você deve ser mais devagar para mudar. Slots aquecidos, workspaces copy-on-write (`src/main/shado/`), chats persistentes, o piso de permissão fixo no código, e o cockpit de agentes paralelos são a espinha dorsal durável. Tudo mais é feito para se mover.

Para os limites de processo, IPC, e onde cada subsistema vive, leia o documento de **[Arquitetura](ARCHITECTURE.md)** — o mapa para encontrar a costura que você quer mudar. Para o modelo de objetos (Chat, Slot, AgentSession e seus ciclos de vida), veja **[Modelo Central](CORE_MODEL.md)**.

Para equipes rodando mais de um agente de uma vez, este é um ponto de partida funcional pretendido para ser desmontado e reconstruído em torno de um fluxo de trabalho diferente.

---

*Algumas integrações referenciadas na [especificação de design](POPBOT_DESIGN.md) original (Slack, Sentry, e outras) existem como esboços de conexão em vez de fluxos completos; Linear, Jira, GitHub, e Helix Swarm são as fontes de caixa de entrada totalmente conectadas. Este guia descreve como o app de fato se comporta hoje.*
