*Languages: [English](../DEVELOPMENT.md) · [Español](../es/DEVELOPMENT.md) · [Français](../fr/DEVELOPMENT.md) · [Deutsch](../de/DEVELOPMENT.md) · [日本語](../ja/DEVELOPMENT.md) · [한국어](../ko/DEVELOPMENT.md) · [简体中文](../zh-CN/DEVELOPMENT.md) · **[Português (Brasil)](DEVELOPMENT.md)** · [Русский](../ru/DEVELOPMENT.md) · [Italiano](../it/DEVELOPMENT.md)*

# Desenvolvimento

## Pré-requisitos

- macOS (única plataforma suportada para v1)
- Node 20 LTS ou mais recente (`.nvmrc` vai fixar isso assim que o scaffold estiver pronto)
- pnpm (preferido) ou npm
- Xcode Command Line Tools (`xcode-select --install`) — necessário para o helper nativo em Swift e quaisquer builds node-gyp
- Um clone do [`autorpg`](../../../autorpg) em `~/pop/autorpg` para testes de ponta a ponta

## Configuração inicial

> Pendente do scaffold do Electron (Fase 2). Esta seção será preenchida assim que `package.json` estiver pronto.

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## Scripts (planejados)

| Comando | Propósito |
|---|---|
| `pnpm dev` | Servidor de dev Vite + Electron main com reload |
| `pnpm build` | Bundles de produção do renderer + main |
| `pnpm package` | electron-builder → `release/` (.dmg) |
| `pnpm typecheck` | tsc --noEmit em main, preload, renderer, shared |
| `pnpm lint` | Verificação ESLint + Prettier |
| `pnpm test` | Testes unitários Vitest |

## Convenções do repositório

- **TypeScript em todo lugar.** Nenhum `.js` fora de arquivos de configuração. Modo estrito ligado.
- **Sem IPC bruto em componentes.** O renderer fala com main via a ponte tipada `window.popbot.*` definida em `src/preload/`.
- **Renderer é visão pura.** Sem fs, sem child_process, sem módulos node com bindings nativos. Se um componente precisa de persistência ou uma chamada de sistema, exponha-a através de main + IPC.
- **Um arquivo por componente React**, nomeado em `PascalCase.tsx`. Hooks vivem ao lado do componente quando privados, ou em `renderer/hooks/` quando compartilhados.
- **Tailwind primeiro, CSS escopado em segundo.** O `design/prototype/styles.css` portado se torna uma camada Tailwind + um pequeno conjunto de propriedades customizadas CSS para os tokens do tema escuro (`--bg-1`, `--fg-2`, etc.).

## Trabalhando com o protótipo de design

O protótipo original vive em [`../design/prototype/`](../../design/prototype/) e é **referência congelada**, não um alvo de build. Veja [`design/README.md`](../../design/README.md) para como visualizá-lo.

Ao portar um componente:

1. Abra o `*.jsx` correspondente ao lado do seu `.tsx` para referência visual.
2. Remova os aliases `useStateA`/`useEffectA` (um hack que o protótipo usava para evitar colisões globais).
3. Substitua `INITIAL_CHATS` e outras fixtures em nível de módulo por imports de `renderer/fixtures/` ou, eventualmente, chamadas IPC.
4. Fique próximo do comportamento visual + de interação do protótipo — veja [memory: stick close to the design](../../).

## Estilo de commit

- Commits convencionais: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Corpo ≤ 72 colunas. Comece pelo **porquê**, não pelo **o quê**.
- Um PR por mudança lógica. Não empacote scaffold + features juntos.

## Trabalhando com repositórios relacionados

O PopBot conduz o projeto Unity AutoRPG + servidor sidecar. Vários pré-requisitos da Fase 0 aterrissam naquele repositório, não neste:

- Sobrescrita de env `POPBOT_MCP_PORT` no MCP dentro do Editor
- Flags `./run_local.sh --port` e `--data-dir`
- Extensões do endpoint `/health`

Quando você estiver trabalhando nisso, faça `cd ~/pop/autorpg` e siga as convenções daquele repositório.
