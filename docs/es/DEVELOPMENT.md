# Desarrollo

## Prerrequisitos

- macOS (única plataforma compatible para v1)
- Node 20 LTS o más reciente (`.nvmrc` lo fijará una vez que aterrice el
  scaffold)
- pnpm (preferido) o npm
- Xcode Command Line Tools (`xcode-select --install`) — necesario para el
  helper nativo de Swift y cualquier compilación de node-gyp
- Un clon de [`autorpg`](../../../autorpg) en `~/pop/autorpg` para pruebas de
  extremo a extremo

## Configuración inicial

> Pendiente el scaffold de Electron (Fase 2). Esta sección se completará
> cuando aterrice `package.json`.

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## Scripts (planeados)

| Comando | Propósito |
|---|---|
| `pnpm dev` | Servidor de desarrollo de Vite + Electron main con recarga |
| `pnpm build` | Paquetes de producción del renderer + main |
| `pnpm package` | electron-builder → `release/` (.dmg) |
| `pnpm typecheck` | tsc --noEmit a través de main, preload, renderer, shared |
| `pnpm lint` | Verificación de ESLint + Prettier |
| `pnpm test` | Pruebas unitarias de Vitest |

## Convenciones del repositorio

- **TypeScript en todas partes.** Ningún `.js` fuera de los archivos de
  configuración. Modo estricto activado.
- **Sin IPC crudo en los componentes.** El renderer habla con el main vía
  el puente tipado `window.popbot.*` definido en `src/preload/`.
- **El renderer es vista pura.** Sin fs, sin child_process, sin módulos de
  node con bindings nativos. Si un componente necesita persistencia o una
  llamada al sistema, expónla a través del main + IPC.
- **Un archivo por componente de React**, nombrado en `PascalCase.tsx`. Los
  hooks viven junto al componente cuando son privados, o en
  `renderer/hooks/` cuando son compartidos.
- **Tailwind primero, CSS delimitado en segundo lugar.** El
  `design/prototype/styles.css` portado se convierte en una capa de
  Tailwind + un pequeño conjunto de propiedades personalizadas de CSS para
  los tokens del tema oscuro (`--bg-1`, `--fg-2`, etc.).

## Trabajar con el prototipo de diseño

El prototipo original vive en [`../design/prototype/`](../../design/prototype/)
y es **referencia congelada**, no un objetivo de compilación. Consulta
[`design/README.md`](../../design/README.md) para cómo verlo.

Al portar un componente:

1. Abre el `*.jsx` correspondiente junto a tu `.tsx` como referencia visual.
2. Elimina los alias `useStateA`/`useEffectA` (un truco que usaba el
   prototipo para evitar colisiones globales).
3. Reemplaza `INITIAL_CHATS` y otros fixtures a nivel de módulo con
   importaciones desde `renderer/fixtures/` o, eventualmente, llamadas IPC.
4. Mantente cerca del comportamiento visual + de interacción del prototipo
   — consulta [memory: stick close to the design](../../).

## Estilo de commits

- Commits convencionales: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`.
- Cuerpo ≤ 72 columnas. Encabeza con el **por qué**, no el **qué**.
- Un PR por cambio lógico. No agrupes scaffold + funcionalidades.

## Trabajar con repositorios relacionados

PopBot maneja el proyecto de Unity de AutoRPG + el servidor sidecar. Varios
prerrequisitos de la Fase 0 aterrizan en ese repositorio, no en este:

- Anulación de la variable de entorno `POPBOT_MCP_PORT` en el MCP dentro
  del Editor
- Banderas `./run_local.sh --port` y `--data-dir`
- Extensiones del endpoint `/health`

Cuando estés trabajando en eso, haz `cd ~/pop/autorpg` y sigue las
convenciones de ese repositorio.
