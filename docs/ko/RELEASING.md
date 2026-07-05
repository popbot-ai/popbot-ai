*Languages: [English](../RELEASING.md) · [Español](../es/RELEASING.md) · [Français](../fr/RELEASING.md) · [Deutsch](../de/RELEASING.md) · [日本語](../ja/RELEASING.md) · [한국어](RELEASING.md) · [简体中文](../zh-CN/RELEASING.md) · [Português (Brasil)](../pt-BR/RELEASING.md) · [Русский](../ru/RELEASING.md) · [Italiano](../it/RELEASING.md)*

# PopBot 릴리스하기

릴리스는 **macOS, Windows, Linux** 전체에서 GitHub Actions로 빌드되어 이
리포지토리의 GitHub Release에 게시됩니다. 각 플랫폼은 자신의 러너에서
빌드됩니다 — 네이티브 모듈(`better-sqlite3`, `node-pty`)은 OS별로
Electron의 ABI에 맞춰 컴파일되어야 하므로, 크로스 컴파일은 선택지가
아닙니다.

## 릴리스 만들기

`main`의 깨끗한 워킹 트리에서 실행합니다.

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh`는 버전을 올리고, 커밋하고, 주석이 달린 `vX.Y.Z` 태그를
만들고, 둘 다 푸시합니다. 푸시된 태그는 **Build** 워크플로를 트리거하며,
이 워크플로는 세 플랫폼 모두를 빌드하고 아티팩트가 첨부된 GitHub Release를
게시합니다. `gh run watch`나 Actions 탭으로 지켜보세요.

다음 버전은 가장 최근의 `v*` 태그로부터 계산되며, 위 인자에 따라
올려집니다. 태그가 하나도 없는 상태에서는 `package.json`의 버전으로
대체됩니다(그래서 첫 릴리스는 그 버전보다 한 단계 위가 됩니다). 이
스크립트는 `main` 외의 브랜치에서는 실행을 거부합니다(`RELEASE_BRANCH=<name>`으로
재정의 가능).

## 생성되는 산출물

| 플랫폼 | 아티팩트 |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | NSIS 설치 프로그램 `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb`(자동 업데이트 없음 — 아래 Linux 노트 참고) |

`latest*.yml` + `.blockmap` 파일은 electron-updater 메타데이터입니다
([`electron-builder.yml`](../../electron-builder.yml)의 `publish: github`이
이를 생성합니다). 앱 내 자동 업데이터는 이를 소비하여 업데이트를 감지,
다운로드, 스테이징합니다 — 아래의 자동 업데이트 섹션을 참고하세요.

워크플로: [`.github/workflows/build.yml`](../../.github/workflows/build.yml).

## CI 트리거

- **`v*` 태그 푸시** → 모든 플랫폼 빌드(시크릿이 설정되어 있으면 서명됨) +
  GitHub Release 게시.
- **`main`으로의 풀 리퀘스트**(문서 제외) → 검증 빌드만, **항상
  서명되지 않음**; 아티팩트는 실행에 첨부되지만 아무것도 게시되지 않고
  시크릿도 사용되지 않습니다.
- **수동** → "Run workflow"(workflow_dispatch), 서명되지 않음.

서명은 오직 `v*` 태그 푸시에서만 실행되며, 이는 리포지토리 소유자만 할 수
있습니다. GitHub는 포크에서 트리거된 PR 실행에는 결코 시크릿을 노출하지
않으므로, 기여자의 PR은 서명 인증서에 접근할 수 없습니다.

## 코드 서명

서명은 **GitHub Actions 시크릿**(Settings → Secrets and variables →
Actions)으로 구동됩니다. 이들은 암호화되어 있고, git 트리에는 절대
존재하지 않으며, 로그에서 마스킹됩니다. 아무것도 설정되지 않은 경우 태그
빌드는 서명되지 않은 바이너리를 생성하며(macOS Gatekeeper / Windows
SmartScreen이 첫 실행 시 경고), CI는 여전히 통과합니다.

### macOS(서명 + 공증)

| 시크릿 | 값 |
|--------|-------|
| `MAC_CSC_LINK` | "Developer ID Application" `.p12`의 base64(`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | 그 `.p12`의 비밀번호 |
| `APPLE_ID` | 공증에 사용되는 Apple ID 이메일 |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com에서 발급받은 앱 전용 비밀번호 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

태그 빌드는 **전체 집합**이 존재할 때만 서명 + 공증을 수행합니다 —
`MAC_CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, **그리고**
`APPLE_TEAM_ID`(인증서를 위한 `MAC_CSC_KEY_PASSWORD`도 포함). 하나라도
누락되면 공증을 나중에 실패시키는 대신 서명되지 않은 채로 빌드하므로,
절반만 설정된 시크릿 집합이 CI를 깨뜨리지 않습니다.

### Windows(선택 사항)

| 시크릿 | 값 |
|--------|-------|
| `WIN_CSC_LINK` | 코드 서명 `.pfx`의 base64 |
| `WIN_CSC_KEY_PASSWORD` | 그 `.pfx`의 비밀번호 |

태그 빌드는 `WIN_CSC_LINK`가 존재할 때 서명합니다. 그렇지 않으면 서명되지
않습니다.

## 자동 업데이트

앱 내 자동 업데이트는 **electron-updater**
([`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts))로
배선되어 있습니다. 패키징된 빌드에서는 이 리포지토리의 릴리스를 폴링하여
더 새로운 버전을 백그라운드에서 **조용히 다운로드**하고, 준비가 완료되면
**"Restart to install"** 토스트를 보여줍니다 — 클릭하면 종료 후 새 버전으로
다시 실행됩니다. 이는 릴리스 워크플로가 첨부하는 `latest*.yml` +
`.blockmap` 메타데이터를 읽습니다. `electron-builder.yml`의 `publish:
github` 설정이 클라이언트에 필요한 `app-update.yml`을 생성합니다.

**설치 단계에는 서명이 필요합니다.** macOS는 서명되지 않은 업데이트를
거부하므로, 앱 내 설치는 릴리스가 서명 + 공증된 이후에만 작동합니다(Apple
시크릿이 설정된 태그 빌드 경로). 그전까지는 — 그리고 업데이터가 오류를
만날 때마다(메타데이터 없음, 네트워크 실패) — [`src/main/updates/check.ts`](../../src/main/updates/check.ts)의
가벼운 GitHub 확인 로직이 구동하는, 릴리스 페이지를 여는 수동 "Download"
토스트로 **폴백**합니다. 이 동일한 가벼운 확인 로직은 About 대화상자의
온디맨드 "Check for updates"도 뒷받침하며, 개발 환경과 서명되지 않은
빌드를 포함해 모든 곳에서 작동합니다.

이 중 무엇이든 릴리스로 표면화되려면, 워크플로가 플랫폼 설치 프로그램이
첨부된 **드래프트가 아니고 프리릴리스도 아닌** Release를 게시해야 합니다 —
실제로 그렇게 하고 있습니다. 자동 업데이트는 개발 환경에서는 비활성화되어
있습니다.

### 자동 업데이트 검증하기(첫 엔드투엔드 테스트)

자동 업데이트 경로는 **실제로 서명된 두 개의 릴리스**에 대해서만 검증할 수
있습니다 — 개발 환경에서는 불가능하고(비활성화되어 있음) 릴리스가 하나뿐일
때도 불가능합니다(끌어올 더 새로운 것이 없음). 서명이 설정된 후 한 번
수행하세요.

1. **서명이 켜져 있는지 확인합니다.** 위 표의 macOS(선택적으로 Windows)
   시크릿을 추가하세요. 첫 서명된 릴리스는 반드시 성공해야 합니다 —
   macOS에서 서명되지 않은/공증되지 않은 빌드는 다운로드는 되지만 **설치에
   실패**하므로, 이 테스트 전체가 서명되지 않은 상태에서는 의미가
   없습니다.
2. **릴리스 N을 만듭니다**, 예: `npm run release` → `v0.0.18`. 워크플로가
   에셋 + `latest*.yml`과 함께 Release를 게시할 때까지 기다립니다.
3. 지원하는 각 OS에서 **게시된 Release로부터 N을 설치합니다**(macOS
   `.dmg`, Windows `.exe`, Linux `.deb`). 실행한 뒤 — Help ▸ About이 올바른
   버전을 보여주는지 확인합니다.
4. **릴리스 N+1을 만듭니다**, 예: `npm run release` → `v0.0.19`.
5. **N 설치본을 계속 실행해 둡니다.** 실행 후 약 30초 이내(그 후에는 6시간
   마다) 확인 작업이 실행되며, 서명된 빌드에서는 N+1을 조용히 다운로드한
   뒤 **"Restart to install"** 토스트를 보여줍니다. 클릭하세요.
6. **N+1로 다시 실행되었는지 확인합니다** — Help ▸ About이 이제 새 버전을
   보여줍니다. 이는 그 OS에서 다운로드 → 스테이징 → quitAndInstall →
   재실행이 작동함을 증명합니다.

플랫폼별 노트:
- **macOS:** Squirrel.Mac은 `.dmg`가 아니라 `.zip` 에셋으로부터 업데이트를
  적용합니다. 둘 다 Release에 있어야 합니다. Gatekeeper는 서명되지
  않은/공증되지 않은 업데이트를 거부합니다 — "Restart to install"이 아무
  동작도 하지 않는다면, 빌드의 공증 여부를 다시 확인하세요.
- **Linux:** `.deb`는 자체 업데이트를 **하지 않습니다** — electron-updater는
  Linux에서 AppImage만 자동 업데이트합니다. 새 `.deb`를 설치하여
  업데이트하세요(`sudo dpkg -i …` / `sudo apt install ./…`). 따라서
  Linux에서는 자동 업데이트 단계(4~6)를 건너뛰고, N+1을 N 위에 설치한 뒤
  About만 확인하세요. 앱 내 Linux 자동 업데이트를 복원하려면,
  `electron-builder.yml`의 `linux.target`에 `AppImage`를 다시 추가하세요.
- **Windows:** NSIS 설치 프로그램은 제자리에서 업데이트됩니다.
  `WIN_CSC_LINK`로 빌드가 서명되기 전까지는 SmartScreen이 경고할 수
  있습니다.

5단계에서 대신 (릴리스 페이지를 여는) **"Download"** 토스트가 보인다면,
앱 내 업데이터가 오류를 만나 폴백한 것입니다 — 이유를 확인하려면 진단 로그
(`update.error` / `update.check.failed` 항목)를 확인하세요. 가장 흔한
원인은 서명되지 않은 macOS 빌드입니다.
