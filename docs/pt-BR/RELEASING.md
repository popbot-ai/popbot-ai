# Lançando o PopBot

Releases são construídos pelo GitHub Actions em **macOS, Windows e Linux**
e publicados no **Cloudflare R2** (`download.popbot.app`) — *não* em GitHub
Releases. Cada plataforma compila em seu
próprio runner — os módulos nativos (`better-sqlite3`, `node-pty`) precisam compilar
contra o ABI do Electron por SO, então cross-compiling não é uma opção.

## Antes de cortar: atualize as notas da versão

Três lugares carregam o texto de "novidades" visível ao usuário, e os três são
**escritos à mão** — nada os gera. Atualize-os no mesmo PR da funcionalidade,
para que um release nunca saia descrevendo o anterior:

1. **Popup What's New no app** — `whatsNew.f1.*` / `whatsNew.f2.*` em
   `src/shared/i18n/messages/*.ts`. **Todos os 12 idiomas.** Exibido uma vez
   por versão na primeira abertura após uma atualização.
2. **Faixa hero do site** — as duas linhas `whatsnew.f*` em
   `site/index.html` **e** suas traduções em `site/i18n.js`.
   **Todos os 12 idiomas.**
3. **Tabela `## Recent releases` no topo do `README.md`** — adicione a nova
   versão e remova a mais antiga, mantendo três. **Somente o README em
   inglês**: as cópias traduzidas em `docs/<locale>/README.md` não trazem
   essa tabela de propósito, para que ela não fique desatualizada em outros
   11 idiomas.

Limite 1 e 2 a uma ou duas funcionalidades principais. Destaque qualquer coisa
que mude o comportamento de conversas existentes (por exemplo, um modelo
descontinuado que migra sozinho) — os usuários percebem de qualquer forma.

Betas são à parte: os itens da faixa beta vêm de `beta-highlights.json`, que
`scripts/gen-manifest.mjs` embute no manifesto de download.

## Cortando um release

Os releases rodam **inteiramente pelo GitHub Actions** — não há etapa local
(`npm run release` é apenas um stub que redireciona para cá).

GitHub → **Actions** → **Release** → **Run workflow**:

- **bump**: `patch` | `minor` | `major`
- **channel**: `prerelease` (build de teste em `beta/`; assinada apenas se os secrets
  de assinatura estiverem definidos — uma prerelease sem assinatura é permitida) |
  `release` (publicar em `stable/` como "latest"; no macOS a assinatura +
  notarização é **obrigatória**, caso contrário o job falha)

A próxima versão é calculada a partir da tag `v*` final mais recente (tags que
contêm `-` são ignoradas), incrementada conforme **bump**. Um `prerelease`
recebe ainda o sufixo `-rc.<run_number>` e vai para `beta/`; um `release` vai
para `stable/`.

**As tags do Git são a fonte da verdade para a versão.** O workflow baseia a
próxima versão na tag final mais recente; ele só recorre ao `package.json` quando
ainda não existe nenhuma tag `v*` final (ou seja, no primeiro release). Ele nunca
commita uma versão de volta: aplica a calculada em tempo de build com
`npm version --no-git-tag-version`. Ainda assim, mantenha a versão do
`package.json` em dia (incremente-a no PR do release) para que o repositório e as
builds locais de desenvolvimento não mostrem um número desatualizado.

## O que é produzido

| Plataforma | Artefatos |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | instalador NSIS `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (sem auto-atualização — veja a nota do Linux abaixo) |

Os arquivos `latest*.yml` + `.blockmap` são metadados do electron-updater
(a configuração `publish: generic` em [`electron-builder.yml`](../../electron-builder.yml)
os gera). O auto-atualizador dentro do app os consome para detectar, baixar,
e preparar atualizações — veja a seção de Auto-atualização abaixo.

Workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Gatilhos de CI

- **Push de tag `v*`** → compila todas as plataformas (assinado se os secrets estiverem definidos) +
  envia para `…/<channel>/<version>/` e promove o feed do canal.
- **Pull request para `main`** (não-docs) → apenas build de validação, **sempre
  não assinado**; artefatos são anexados à execução, nada é publicado, nenhum secret é usado.
- **Manual** → "Run workflow" (workflow_dispatch), não assinado.

Assinatura só roda em um push de tag `v*`, que apenas o dono do repositório pode
fazer. O GitHub nunca expõe secrets a execuções de PR disparadas por forks, então PRs de
contribuidores não conseguem alcançar os certificados de assinatura.

## Assinatura de código

A assinatura é conduzida por **secrets do GitHub Actions** (Settings → Secrets and
variables → Actions). Eles são criptografados, nunca ficam na árvore git, e são mascarados
nos logs. Sem nenhum definido, builds de tag produzem binários não assinados (macOS
Gatekeeper / Windows SmartScreen avisam no primeiro lançamento) e o CI ainda passa.

### macOS (assinar + notarizar)

| Secret | Valor |
|--------|-------|
| `MAC_CSC_LINK` | base64 do seu `.p12` "Developer ID Application" (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | senha para esse `.p12` |
| `APPLE_ID` | e-mail do Apple ID usado para notarização |
| `APPLE_APP_SPECIFIC_PASSWORD` | senha específica de app de appleid.apple.com |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Um build de tag assina + notariza apenas quando o **conjunto completo** está presente —
`MAC_CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, **e**
`APPLE_TEAM_ID` (mais `MAC_CSC_KEY_PASSWORD` para o certificado). Se algum estiver
faltando, ele compila sem assinatura em vez de falhar a notarização tarde, então um
conjunto de secrets parcialmente configurado não quebra o CI.

### Windows (opcional)

| Secret | Valor |
|--------|-------|
| `WIN_CSC_LINK` | base64 do seu `.pfx` de assinatura de código |
| `WIN_CSC_KEY_PASSWORD` | senha para esse `.pfx` |

Um build de tag assina quando `WIN_CSC_LINK` está presente; caso contrário, não assinado.

## Auto-atualização

A auto-atualização dentro do app é conectada com o **electron-updater**
([`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts)).
Em builds empacotadas, ele faz polling do feed R2 do canal
(`download.popbot.app/<channel>/`), **baixa silenciosamente**
uma versão mais nova em segundo plano, e mostra um toast de **"Restart to install"**
quando estiver preparada — clicar nele sai e relança na nova versão. Ele
lê os metadados `latest*.yml` + `.blockmap` que o workflow de release anexa; a
configuração `publish: generic` em `electron-builder.yml` incorpora o
`app-update.yml` que o cliente precisa.

**Assinatura é necessária para a etapa de instalação.** O macOS rejeita atualizações
não assinadas, então a instalação dentro do app só funciona uma vez que os releases estejam
assinados + notarizados (o caminho de build de tag com os secrets da Apple definidos). Até então
— e sempre que o atualizador encontrar um erro (sem metadados, falha de rede) — ele **recorre**
a um toast manual de "Download" que abre a página de release, conduzido pela
verificação leve do GitHub em
[`src/main/updates/check.ts`](../../src/main/updates/check.ts). Essa mesma
verificação leve também sustenta o "Check for updates" sob demanda do diálogo Sobre
e funciona em qualquer lugar, incluindo builds de dev e não assinadas.

Para que qualquer coisa disso exiba um release, o workflow precisa publicar
Releases **não-rascunho, não-prerelease** com os instaladores da plataforma
anexados — o que ele faz. A auto-atualização é desabilitada em dev.

### Verificando a auto-atualização (primeiro teste de ponta a ponta)

O caminho de auto-atualização só pode ser verificado contra **dois releases reais
assinados** — não em dev (está desabilitado) e não contra um único release
(não há nada mais novo para puxar). Faça isso uma vez, depois que a assinatura estiver configurada:

1. **Confirme que a assinatura está ligada.** Adicione os secrets do macOS (e opcionalmente Windows)
   da tabela acima. O primeiro release assinado precisa ter sucesso —
   no macOS, builds não assinadas/não notarizadas conseguem baixar mas **falham
   ao instalar**, então este teste inteiro não faz sentido sem assinatura.
2. **Corte o release N** — Actions → Release → bump `patch`, channel
   `release` (ex.: → `v0.1.2`). Espere o workflow publicar o Release com os
   que `download.popbot.app/stable/<version>/` tem os instaladores e que a raiz do
   canal `download.popbot.app/stable/` tem o `latest*.yml` promovido.
3. **Instale N a partir do Release publicado** em cada SO que você suporta
   (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Lance-o — verifique que
   Help ▸ About mostra a versão correta.
4. **Corte o release N+1** da mesma forma (ex.: → `v0.1.3`).
5. **Deixe a instalação N rodando.** Dentro de ~30s do lançamento (e depois a cada
   6h) ele verifica; em uma build assinada ele baixa N+1 silenciosamente, então mostra
   o toast de **"Restart to install"**. Clique nele.
6. **Confirme que relançou na N+1** — Help ▸ About agora mostra a nova
   versão. Isso prova que download → preparação → quitAndInstall → relançamento funciona
   naquele SO.

Notas por plataforma:
- **macOS:** o Squirrel.Mac aplica a atualização a partir do asset `.zip` (não do
  `.dmg`); ambos precisam estar no Release. O Gatekeeper rejeita uma atualização não assinada/
  não notarizada — se "Restart to install" não fizer nada, reverifique a
  notarização no build.
- **Linux:** o `.deb` **não** se auto-atualiza — o electron-updater só
  auto-atualiza AppImage no Linux. Atualize instalando o novo `.deb`
  (`sudo dpkg -i …` / `sudo apt install ./…`). Então pule as etapas de auto-atualização
  (4–6) para o Linux; apenas instale N+1 sobre N e confirme em About. Para
  restaurar a auto-atualização do Linux dentro do app, re-adicione `AppImage` ao `linux.target`
  em `electron-builder.yml`.
- **Windows:** a instalação NSIS atualiza no local; o SmartScreen pode avisar
  até que o build seja assinado com `WIN_CSC_LINK`.

Se a etapa 5 mostrar em vez disso um toast de **"Download"** (abrindo a página de release),
o atualizador dentro do app encontrou um erro e recorreu ao fallback — verifique o log
de diagnóstico (entradas `update.error` / `update.check.failed`) para saber por quê, mais
frequentemente uma build de macOS não assinada.
