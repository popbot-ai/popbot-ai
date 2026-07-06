# Configurando o PopBot

Tudo no PopBot é configurado no próprio app através de **Preferências** (a engrenagem na barra de título, ou `⌘,`) — não há arquivos de configuração para editar manualmente. Este guia percorre cada painel na ordem em que a navegação os lista, o que é aproximadamente a ordem em que você os configuraria pela primeira vez.

> Credenciais que você insere (Linear, Jira, GitHub, Perforce, etc.) são armazenadas **localmente na sua máquina** no próprio banco de dados do app — nunca neste repositório.

- [Integrações](#integrações) · [Agentes](#agentes) · [Runtime e slots](#runtime-e-slots) · [Repositórios](#repositórios) · [Controle de versão](#controle-de-versão) · [Apps externos](#apps-externos) · [Templates de prompt](#templates-de-prompt) · [Revisões de código](#revisões-de-código) · [Notificações](#notificações) · [Permissões](#permissões) · [Idioma](#idioma)

---

## Integrações

Dois grupos independentes vivem aqui: a **fonte de tickets** que alimenta a fila de Tickets, e as **engines de jogo** que um slot pode lançar.

![Integrations — Linear](../../images/preferences_integrations1.png)

### Fonte de tickets

Um único rastreador de issues ativo alimenta a fila de Tickets. Escolha-o no seletor no topo do painel; o formulário de configuração abaixo se ajusta para corresponder. Apenas um rastreador está ativo por vez.

- **Linear** — cole uma chave de API (de *linear.app → Settings → API*). Opcionalmente defina uma **Team key** (por exemplo, `ENG`) para restringir o feed de tickets a uma equipe, e escolha um **Project** para restringir ainda mais. Salvar verifica a chave e mostra com quem ela se conectou.
- **Jira** — insira a URL do seu site (`https://your-domain.atlassian.net`), o e-mail da conta, e um token de API (de *id.atlassian.com → Security → API tokens*). Opcionalmente restrinja a um **Project** e adicione um filtro **JQL** (por exemplo, `labels = backend`). Salvar verifica as credenciais antes de persisti-las.
- **GitHub** — GitHub Issues não precisa de credenciais aqui: o provedor invoca a CLI `gh` que você já autenticou para revisões e ações git, e a fila abrange os mesmos repositórios configurados em [Repositórios](#repositórios). O formulário é uma verificação de status que confirma que o `gh` está instalado e autenticado e relata quantos repositórios ele cobre.

Cada rastreador com credenciais as verifica ao **Salvar** antes de persistir, e mostra uma pílula de status *Conectado / Não conectado*.

### Engines de jogo

Diferente da fonte de tickets de seleção única, engines são **independentes** — você pode habilitar Unity, Unreal, e uma engine Customizada ao mesmo tempo. Cada engine habilitada adiciona um botão **Run** à barra do chat que lança seu editor a partir do workspace de slot do chat.

- **Habilitada** — uma caixa de seleção por engine que exibe (ou esconde) o botão Run daquela engine na barra do chat.
- **Instalações detectadas / Editor binary** *(Unity, Unreal)* — o PopBot varre por editores instalados (Unity Hub / instalações Epic), com um link de **rescan**; escolha uma versão detectada, ou insira um caminho absoluto de **Editor binary** para sobrescrever o dropdown.
- **Comando de execução** *(Custom)* — um comando de shell livre executado no diretório do projeto, com variantes separadas para **macOS / Linux** e **Windows** para que uma única configuração funcione entre plataformas. Uma engine customizada não tem auto-detecção; o PopBot passa a identidade do slot adiante para seu comando via uma variável de ambiente `POPBOT_SLOT` para que você possa conectar seu próprio fluxo de "rodar e verificar."
- **Subcaminho do projeto** — o caminho do projeto da engine relativo à raiz do workspace (a pasta do projeto Unity; a pasta contendo o `.uproject`; ou o cwd em que um comando customizado roda). Deixe em branco se a raiz do workspace *for* o projeto.
- **Use MCP + Base MCP port** *(Unity, Unreal)* — quando a caixa de seleção **Use MCP** está ativada, o editor é lançado apontado para um servidor MCP no próprio editor para que um agente possa conduzi-lo. Cada slot recebe sua **própria porta** para que slots paralelos nunca colidam: a porta é `basePort + (slotId − 1)` (slot 1 → base, slot 2 → base + 1, …). O campo **Base MCP port** define a porta do slot 1; o padrão é **8000 para Unreal** e **8080 para Unity** (correspondendo ao padrão do plugin MCP de cada engine) e é restaurado a esse padrão quando limpo.
- **Show project path in title bar** *(Unity)* — um botão **Install title-bar script** que insere um pequeno script de editor no seu projeto Unity para que cada Editor aberto mostre seu caminho completo de projeto na barra de título, facilitando a distinção entre janelas de slot. O script é seguro para commitar.

> **Slack** e **Sentry** permanecem como esboços de conexão em vez de fontes de caixa de entrada conectadas, então não são mostrados como painéis aqui hoje. Eles podem ser reabilitados sem mudanças estruturais; veja a nota no final do [Guia de Recursos e Fluxo de Trabalho](GUIDE.md).

## Agentes

**Esforço de raciocínio** do modelo padrão para chats recém-criados (chats existentes mantêm o seu próprio até que você os mude no compositor do chat).

![Agents](../../images/preferences_agents.png)

- Defina o esforço independentemente para **Claude** e **Codex**, e separadamente para:
  - **Novos chats** — chats genéricos e de ticket.
  - **Revisões de código** — chats de revisão de PR, chats de fallback de re-revisão, e notificações de revisão.

Mais esforço significa raciocínio mais profundo e uso mais completo de ferramentas, a um custo e latência maiores. Revisões frequentemente querem uma profundidade diferente de construções de feature — daí a divisão.

## Runtime e slots

Este painel controla a **retenção de anexos**. (O dimensionamento de pool de slots agora é por repositório e vive em [Repositórios](#repositórios) — veja a nota lá.)

![Runtime & slots](../../images/preferences_slots.png)

- **Keep attachments for** — por quanto tempo arquivos e imagens que você anexa a um chat são mantidos no armazenamento próprio do PopBot (padrão de 60 dias, faixa de 1–365). Anexos são copiados para o armazenamento do PopBot para que continuem abrindo a partir do histórico do chat mesmo depois que o original é movido; uma varredura na inicialização deleta cópias mais antigas que essa janela para que a pasta não cresça sem limite.

> A captura de tela acima pode ser anterior à divisão do dimensionamento de pool de slots para o fluxo por repositório.

## Repositórios

Todo chat vive em um **repositório**. Este painel lista seus repositórios e é onde controle de versão, slots, e workspaces copy-on-write por repositório são configurados.

![Repositories](../../images/preferences_repositories.png)

- **Add Repository** abre um assistente com pasta primeiro: escolha uma pasta, e o PopBot **detecta seu controle de versão** (Git ou Perforce) e ramifica de acordo. Você então define um id, cor de destaque, prefixo de slot, e contagem de slots.
  - Repositórios **Git** escolhem o modo **slots** (um pool reutilizado de workspaces — o padrão, mostrado como `slots × N`) ou **efêmero** (um workspace novo por chat). O modo slots mantém caches de build aquecidos entre chats.
  - Repositórios **Perforce** são sempre modo slot. O assistente captura a conexão P4, executa uma **verificação prévia de disco**, e constrói uma **imagem base** congelada da árvore sincronizada; slots são então criados como filhos copy-on-write dessa base (veja abaixo).
- **Workspaces copy-on-write.** O workspace de um slot é uma pasta copy-on-write que compartilha uma **imagem base** do repositório e armazena apenas os blocos que altera, via `shado` (a camada de shadow-workspace do PopBot): **VHDX de diferenciação** no Windows, copy-on-write nativo (APFS / reflink) no macOS e Linux. Dez slots em uma árvore em escala de terabytes custam aproximadamente o disco de um repositório mais o pequeno delta de cada slot — o que é o que permite que árvores Perforce grandes participem. A imagem base é construída uma vez, como uma etapa do assistente Add-Repository.
- **O modo é permanente.** O modo slots-vs-efêmero de um repositório é fixo na criação; trocar orfanaria os workspaces de chats em andamento.
- **Edit** um repositório para mudar sua cor de destaque, branch base padrão (Git), ou diretório de trabalho do agente Perforce, e para **Resize slots** (aumentar ou diminuir o pool um workspace por vez, condicionado a todos os chats naquele repositório estarem fechados).
- **Delete** um repositório; a confirmação avisa se chats ainda o referenciam.

Vários repositórios rodam lado a lado, cada um com seu próprio pool de slots e cor de destaque (a cor tinge as cápsulas de slot daquele repositório para que você distinga chats em um relance). Cada cartão de repositório mostra seu provedor de controle de versão e modo.

## Controle de versão

Configurações globais de controle de versão e os templates de ação editáveis. Os painéis Git e Perforce são mostrados lado a lado, porque o provedor de um repositório é detectado por pasta e ambos podem estar em uso ao mesmo tempo.

![Source control](../../images/preferences_source_control.png)

- **Limite de arquivos da visão de mudança** *(compartilhado)* — o máximo de arquivos mostrados na visão de mudança antes que a lista seja limitada. Aplica-se tanto ao Git quanto ao Perforce.

**Git**

- **Nome de usuário do branch** — o prefixo para novos branches: `<username>/<ticket>-<slug>`.
- **Templates de ação** — os prompts que o painel SCM envia ao agente para **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR**, e **Rebase onto base**. Cada um suporta macros `${name}` (`${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, `${prurl}`…).

**Perforce**

- **Padrões de conexão** — o caminho do binário `p4`, porta padrão do servidor, e usuário padrão, que pré-preenchem a etapa de conexão Add-Repository → Perforce.
- **Opções de transferência / submit** — número de threads de sincronização paralelos, e se deve reverter arquivos inalterados no submit.
- **Intervalo de polling de revisão do Swarm** — com que frequência o painel de Revisões faz polling do Helix Swarm por changelists aguardando sua revisão. Isso é **independente do polling do GitHub** e tem um **piso de 30 segundos**; aumente-o para aliviar a carga em um servidor Perforce/Swarm compartilhado em escala.
- **Templates de ação do Perforce** — os prompts que o painel Perforce envia ao agente para **CR** (abrir/atualizar uma revisão do Helix Swarm), **Run tests**, e **Review & commit**, cada um com macros `${name}`.

## Apps externos

Os aplicativos desktop que o PopBot lança a partir da linha de ícones de um chat, todos apontados para o workspace de slot daquele chat.

![External apps](../../images/preferences_external_apps.png)

- **Terminal** — qual terminal o lançador de ícone de terminal abre (por exemplo, iTerm2).
- **Terminal shell (Windows)** — o shell usado pelo painel de terminal integrado ao app: PowerShell, Prompt de Comando, ou PowerShell 7. Aplica-se a terminais abertos após a mudança.
- **Editor de código** — VS Code ou Cursor; também usado para os links clicáveis `file.ts:42` nas linhas da ferramenta Edit.
- **Cliente Git** — o padrão é GitHub Desktop.
- **Perfil Chrome para URLs** — fixa a abertura de links a um perfil Chrome específico (pelo nome de seu *diretório* de perfil) para que sempre aterrissem na sua conta de trabalho.

> Binários de engine e suas opções de MCP são configurados em [Integrações → Engines de jogo](#integrações), não aqui.

## Templates de prompt

A primeira mensagem que o PopBot envia quando um chat nasce. Todo template é editável, com um cartão de referência das macros `${name}` disponíveis para ele. (Templates de ação do painel SCM vivem em [Controle de versão](#controle-de-versão).)

![Prompt templates](../../images/preferences_prompt_templates.png)

- **Start ticket** — disparado quando você gera um chat a partir de um ticket, independente da fonte (Linear, Jira, ou GitHub Issues). Macros incluem `${ticketid}`, `${tickettitle}`, `${markdown}`, `${branch}`, e `${slot}`.
- **Start code review** — disparado quando você gera um chat a partir de uma revisão — um PR do GitHub ou uma changelist do Helix Swarm. O padrão direciona o agente a usar a skill de revisão, ler o código ao redor (não apenas o diff), e tratar o chat como somente leitura.
- **Re-review** — disparado quando você re-revisa um chat de revisão existente; escopa o agente apenas aos novos commits.

Ajuste-os para codificar as convenções, checklists e tom da sua equipe.

## Revisões de código

Controles para a caixa de entrada de **Revisões**. A fila exibe GitHub PRs e changelists do Helix Swarm aguardando sua revisão; PRs que você já revisou são removidos automaticamente.

![Code reviews](../../images/preferences_code_reviews.png)

- **Janela de cache de busca** — quantos dias no passado o seletor **+ Add** faz correspondência fuzzy de tickets e PRs recentes (maior = mais pesquisável, atualização ligeiramente mais lenta e mais orçamento de API). Tickets atribuídos a você são sempre incluídos independentemente deste corte.
- **Ignore by title** — substrings (uma por linha, sem diferenciação de maiúsculas/minúsculas) que removem um PR da fila.
- **Ignore by GitHub author** — logins de bot/autor (um por linha, por exemplo `renovate[bot]`) a silenciar.

> As **taxas de polling** de revisão são configuradas por provedor, não aqui: o intervalo de polling do Helix Swarm vive em [Controle de versão → Perforce](#controle-de-versão), independente do polling do GitHub, para que um servidor Perforce/Swarm compartilhado possa ser protegido sem desacelerar o GitHub.

## Notificações

Como os alertas surgem.

![Notifications](../../images/preferences_notifications.png)

- **Nomes VIP** — pessoas cujas mensagens sempre são elevadas a prioridade urgente. Correspondidos como substrings sem diferenciação de maiúsculas/minúsculas do nome de exibição, então mantenha os nomes específicos.
- **Posicionamento de toast** — *Centro superior, voa para o sino ao dispensar* (padrão), ou toasts clássicos no canto superior direito. A alternância se aplica imediatamente.
- **Test new-item flow** — sinaliza temporariamente alguns itens reais da fila como NOVO para pré-visualizar o comportamento de chip/ponto (nada é persistido). Esta é uma ajuda de desenvolvimento temporária.

## Permissões

O padrão global para cada ferramenta de agente, e o piso sob o modo autônomo.

![Permissions](../../images/preferences_permissions.png)

- Para cada ferramenta (**Bash**, **Read**, **Write**, **Edit**, **Grep**, **Glob**, **WebFetch**, **WebSearch**, …): **Ask** (pergunta a cada vez — o padrão), **Allow** (auto-aprova), ou **Deny** (auto-rejeita).
- **Permissões por servidor MCP.** O servidor MCP de editor de um slot (Unity, Unreal, ou qualquer servidor MCP que um agente carregue) pode ser permitido das mesmas três formas. Conceder o MCP de editor de um slot uma vez é lembrado, e a concessão é visível e revogável aqui — mostrada como `unityEditor → all tools` / `unrealEditor → all tools` em vez do namespace bruto. O PopBot habilita os MCPs de editor Unity e Unreal desta forma automaticamente; uma regra por ferramenta que difere de um curinga é mantida como uma sobrescrita.
- Regras por chat (definidas a partir do cartão de permissão via *Allow this chat* / *Deny this chat*) sobrescrevem esses globais, então um único chat pode bloquear uma ferramenta que você permitiu em todo o resto.

> Um piso de negação rígida — `git push` / `p4 submit`, rede para hosts não permitidos, qualquer coisa fora do workspace — vive no código e **não** é sobrescrevível aqui, então uma regra mal configurada não pode deixar um agente aterrissar na linha principal por conta própria.

## Idioma

A interface do PopBot é totalmente localizada.

- **Idioma de exibição** — troque o locale da interface pelo menu de idioma, que lista cada idioma em seu próprio nome. Os locales distribuídos são inglês, espanhol, francês, alemão, chinês (simplificado), japonês, coreano, e português (brasileiro). A maior parte do texto e os menus atualizam imediatamente; algumas strings de sistema terminam de atualizar após um reinício. Novas janelas e o menu do app também usam esse idioma.

---

Veja o **[Guia de Recursos e Fluxo de Trabalho](GUIDE.md)** para como essas configurações se desdobram em fluxos de trabalho reais.
