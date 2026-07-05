*Languages: [English](../WINDOWS.md) · [Español](../es/WINDOWS.md) · [Français](../fr/WINDOWS.md) · [Deutsch](../de/WINDOWS.md) · [日本語](../ja/WINDOWS.md) · [한국어](WINDOWS.md) · [简体中文](../zh-CN/WINDOWS.md) · [Português (Brasil)](../pt-BR/WINDOWS.md) · [Русский](../ru/WINDOWS.md) · [Italiano](../it/WINDOWS.md)*

# Windows에서 PopBot 실행하기

PopBot은 Electron + Node로 빌드되어 있으며 Windows에서도 실행되지만, 몇 가지 설정
단계가 macOS와 다릅니다 — 대부분 두 개의 네이티브 모듈
(`better-sqlite3`, `node-pty`)과 Electron의 한 가지 특이 사항에 관한 것입니다.
이 문서는 실제로 동작하는 설정을 정리합니다.

## 사전 준비 사항

- **Node 20 LTS 이상.** Node 24도 앱을 *실행*하는 데는 문제가 없지만,
  너무 최신이라 `better-sqlite3`에 대응하는 사전 빌드된 바이너리가 없어서
  일반적인 `npm install`이 Node의 ABI에 맞춰 소스에서 컴파일을 시도하다가
  실패할 수 있습니다(아래 "네이티브 모듈" 참고). Node 20 / 22는 이 컴파일
  문제를 피할 수 있습니다.
- `PATH`에 있는 **Git for Windows**(`git`)와 **GitHub CLI**(`gh`).
- `PATH`에 있는 **`claude`** CLI(`claude.exe` — PopBot은 이를 `where.exe`를
  통해 찾습니다). `codex`는 선택 사항입니다.
- *Desktop development with C++* 워크로드가 포함된 **Visual Studio Build
  Tools 2022** — 네이티브 모듈이 소스에서 컴파일되어야 하는 경우에만
  필요합니다(예: `node-pty`의 winpty).

## 최초 설정

네이티브 모듈은 여러분 시스템의 Node가 아니라 **Electron**의 ABI에 맞춰
빌드되어야 합니다. 신뢰할 수 있는 순서는 다음과 같습니다.

```bash
# 1. 네이티브 빌드 스크립트를 실행하지 않고 JS 의존성을 설치합니다
#    (설치를 롤백시키는 better-sqlite3의 Node-ABI 소스 빌드를 피합니다).
npm install --ignore-scripts

# 2. 1단계에서 건너뛴 Electron 바이너리를 다운로드합니다.
node node_modules/electron/install.js

# 3. Electron의 ABI에 맞춰 네이티브 모듈을 빌드합니다.
npx electron-rebuild -f -w better-sqlite3,node-pty

# 4. 실행합니다.
npm run dev
```

`--ignore-scripts`를 사용했다면 2단계가 필수입니다 — 그렇지 않으면
electron-vite가 `Error: Electron uninstall`로 실패합니다.

## 마주칠 수 있는 두 가지 문제

### `node-pty` 빌드: `'GetCommitHash.bat' is not recognized`

`node-pty`는 **winpty**를 번들로 포함하며, 그 빌드는 `cd shared &&
GetCommitHash.bat`을 실행합니다. 여러분의 환경에
**`NoDefaultCurrentDirectoryInExePath=1`**(보안 강화 플래그)가 설정되어
있다면, cmd.exe는 현재 디렉터리에서 `.bat`을 실행하기를 거부하고 빌드가
실패합니다. 빌드를 위해 이를 해제하세요.

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### 실행 시 `Cannot read properties of undefined (reading 'setName')`

이는 Electron이 Electron이 아니라 **일반 Node**로 시작되어 `electron.app`이
`undefined`가 되었다는 의미입니다. 이는 환경에 `ELECTRON_RUN_AS_NODE`가
존재할 때 발생합니다 — Windows에서는 Electron이 그 변수가 (비어 있더라도)
**단순히 존재하는 것만으로도** "Node로 실행"으로 취급하기 때문입니다. 이는
다른 Electron 앱(VS Code, Claude Code)에 내장된 터미널에서 실행할 때
발생하는데, 그런 앱들은 `ELECTRON_RUN_AS_NODE=1`을 내보내기 때문입니다.

`npm run dev` / `npm run start`는 `scripts/electron-vite.mjs`를 거치며,
이 스크립트는 Electron을 시작하기 전에 그 변수를 **삭제**하므로 이 문제는
처리되어 있습니다. `electron-vite`를 직접 호출한다면, `ELECTRON_RUN_AS_NODE`가
(단순히 비어 있는 것이 아니라) 설정 해제되어 있는지 확인하세요.

## 패키징

```bash
npm run package:win    # NSIS 설치 프로그램 + zip → release/
```

Windows 빌드는 현재 **서명되지 않았으므로**, 첫 실행 시 SmartScreen이
경고를 표시합니다. 서명하려면 `CSC_LINK`(`.pfx` 경로)와
`CSC_KEY_PASSWORD`를 설정하세요.

## 기능 지원 현황 참고 사항

- **에이전트, 채팅, git 워크트리, 내장 터미널, Git 패널**은 모두 Windows에서
  작동합니다.
- **외부 앱 실행기**(슬롯별 아이콘 행): "터미널 열기"(Windows Terminal /
  cmd), "에디터 열기"(VS Code / Cursor), "git 클라이언트 열기"(GitHub
  Desktop)는 배선되어 있습니다. **Unity** 실행/포커스와 슬롯별 "실행 중인
  앱" 감지는 현재로서는 macOS 전용이며(`ps`/`lsof`/AppleScript에 의존함)
  Windows에서는 아무 동작도 하지 않습니다.
- macOS 전용 부분들 — Dock 메뉴, 로그인 셸 `PATH` 패칭, Chrome 프로필 URL
  라우팅 — 은 가드 처리되어 Windows에서는 그냥 건너뜁니다.
