*Languages: [English](../DEVELOPMENT.md) · [Español](../es/DEVELOPMENT.md) · [Français](../fr/DEVELOPMENT.md) · [Deutsch](../de/DEVELOPMENT.md) · [日本語](../ja/DEVELOPMENT.md) · [한국어](DEVELOPMENT.md) · [简体中文](../zh-CN/DEVELOPMENT.md) · [Português (Brasil)](../pt-BR/DEVELOPMENT.md) · [Русский](../ru/DEVELOPMENT.md) · [Italiano](../it/DEVELOPMENT.md)*

# 개발

## 사전 준비 사항

- macOS(v1에서 유일하게 지원되는 플랫폼)
- Node 20 LTS 이상(스캐폴드가 들어오면 `.nvmrc`가 고정할 예정)
- pnpm(권장) 또는 npm
- Xcode Command Line Tools(`xcode-select --install`) — 네이티브 Swift
  헬퍼와 모든 node-gyp 빌드에 필요
- 엔드투엔드 테스트를 위해 `~/pop/autorpg`에 클론해 둔
  [`autorpg`](../../../autorpg)

## 최초 설정

> Electron 스캐폴드(2단계) 대기 중입니다. 이 섹션은 `package.json`이
> 들어오는 대로 채워질 예정입니다.

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## 스크립트(예정)

| 명령 | 목적 |
|---|---|
| `pnpm dev` | 리로드 기능이 있는 Vite 개발 서버 + Electron main |
| `pnpm build` | 프로덕션 렌더러 + main 번들 |
| `pnpm package` | electron-builder → `release/`(.dmg) |
| `pnpm typecheck` | main, preload, renderer, shared 전체에 대한 tsc --noEmit |
| `pnpm lint` | ESLint + Prettier 검사 |
| `pnpm test` | Vitest 단위 테스트 |

## 리포지토리 관례

- **어디서나 TypeScript.** 설정 파일 외에는 `.js`를 두지 않습니다. Strict
  모드 켜짐.
- **컴포넌트에서 원시 IPC 금지.** 렌더러는 `src/preload/`에 정의된 타입이
  지정된 `window.popbot.*` 브리지를 통해 main과 통신합니다.
- **렌더러는 순수 뷰입니다.** fs 없음, child_process 없음, 네이티브
  바인딩이 있는 node 모듈 없음. 컴포넌트가 영속성이나 시스템 호출이
  필요하다면, main + IPC를 통해 노출하세요.
- **React 컴포넌트당 하나의 파일**, `PascalCase.tsx`로 명명. 훅은 비공개일
  경우 컴포넌트와 나란히, 공유될 경우 `renderer/hooks/`에 둡니다.
- **Tailwind가 우선, 범위가 지정된 CSS는 그다음.** 이식된
  `design/prototype/styles.css`는 Tailwind 레이어와 다크 테마 토큰
  (`--bg-1`, `--fg-2` 등)을 위한 소수의 CSS 커스텀 프로퍼티 집합이 됩니다.

## 디자인 프로토타입 작업하기

원본 프로토타입은 [`../../design/prototype/`](../../design/prototype/)에
있으며 빌드 대상이 아니라 **고정된 참고 자료**입니다. 이를 보는 방법은
[`design/README.md`](../../design/README.md)를 참고하세요.

컴포넌트를 이식할 때는 다음을 따르세요.

1. 시각적 참고를 위해 여러분의 `.tsx` 옆에서 대응하는 `*.jsx`를 엽니다.
2. `useStateA`/`useEffectA` 별칭(프로토타입이 전역 충돌을 피하기 위해
   사용했던 임시방편)을 제거합니다.
3. `INITIAL_CHATS`와 그 밖의 모듈 수준 픽스처를 `renderer/fixtures/`로부터의
   임포트로, 또는 나중에는 IPC 호출로 대체합니다.
4. 프로토타입의 시각적/상호작용 동작에 가깝게 유지하세요 — [memory: 디자인에
   가깝게 유지하기](../)를 참고하세요.

## 커밋 스타일

- 컨벤셔널 커밋: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- 본문은 72열 이하로. **무엇을**이 아니라 **왜**를 먼저 씁니다.
- 논리적 변경 하나당 PR 하나. 스캐폴드와 기능을 한데 묶지 마세요.

## 관련 리포지토리 작업하기

PopBot은 AutoRPG Unity 프로젝트 + 사이드카 서버를 구동합니다. 여러 개의
0단계 전제 조건은 이 리포지토리가 아니라 그 리포지토리에 들어갑니다.

- 에디터 내 MCP에 대한 `POPBOT_MCP_PORT` 환경 변수 재정의
- `./run_local.sh --port`와 `--data-dir` 플래그
- `/health` 엔드포인트 확장

이런 작업을 할 때는 `cd ~/pop/autorpg`한 뒤 그 리포지토리의 관례를
따르세요.
