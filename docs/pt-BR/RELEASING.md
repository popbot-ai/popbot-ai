# Lançando o PopBot

Releases são construídos pelo GitHub Actions em **macOS, Windows e Linux**
e publicados em um GitHub Release neste repositório. Cada plataforma compila em seu
próprio runner — os módulos nativos (`better-sqlite3`, `node-pty`) precisam compilar
contra o ABI do Electron por SO, então cross-compiling não é uma opção.

## Cortando um release

A partir de uma árvore de trabalho limpa em `main`:

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh` incrementa a versão, commita, cria uma tag anotada
`vX.Y.Z`, e faz push de ambos. A tag enviada dispara o workflow de **Build**,
que compila as três plataformas e publica o GitHub Release com os
artefatos anexados. Acompanhe com `gh run watch` ou a aba Actions.

A próxima versão é calculada a partir da tag `v*` mais recente, incrementada pelo
argumento acima. Antes que qualquer tag exista, recorre à versão em
`package.json` (então o primeiro release é o próximo incremento acima disso). O
script se recusa a rodar de qualquer branch que não seja `main` (sobrescreva com
`RELEASE_BRANCH=<name>`).

## O que é produzido

| Plataforma | Artefatos |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | instalador NSIS `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (sem auto-atualização — veja a nota do Linux abaixo) |

Os arquivos `latest*.yml` + `.blockmap` são metadados do electron-updater
(a configuração `publish: github` em [`electron-builder.yml`](../../electron-builder.yml)
os gera). O auto-atualizador dentro do app os consome para detectar, baixar,
e preparar atualizações — veja a seção de Auto-atualização abaixo.

Workflow: [`.github/workflows/build.yml`](../../.github/workflows/build.yml).

## Gatilhos de CI

- **Push de tag `v*`** → compila todas as plataformas (assinado se os secrets estiverem definidos) +
  publica um GitHub Release.
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
Em builds empacotadas, ele faz polling dos releases deste repositório, **baixa silenciosamente**
uma versão mais nova em segundo plano, e mostra um toast de **"Restart to install"**
quando estiver preparada — clicar nele sai e relança na nova versão. Ele
lê os metadados `latest*.yml` + `.blockmap` que o workflow de release anexa; a
configuração `publish: github` em `electron-builder.yml` incorpora o
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
2. **Corte o release N**, por exemplo `npm run release` → `v0.0.18`. Espere o
   workflow publicar o Release com os assets + `latest*.yml`.
3. **Instale N a partir do Release publicado** em cada SO que você suporta
   (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Lance-o — verifique que
   Help ▸ About mostra a versão correta.
4. **Corte o release N+1**, por exemplo `npm run release` → `v0.0.19`.
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
