*Languages: [English](../POPBOT_DESIGN.md) · [Español](../es/POPBOT_DESIGN.md) · [Français](../fr/POPBOT_DESIGN.md) · [Deutsch](../de/POPBOT_DESIGN.md) · [日本語](../ja/POPBOT_DESIGN.md) · [한국어](POPBOT_DESIGN.md) · [简体中文](../zh-CN/POPBOT_DESIGN.md) · [Português (Brasil)](../pt-BR/POPBOT_DESIGN.md) · [Русский](../ru/POPBOT_DESIGN.md) · [Italiano](../it/POPBOT_DESIGN.md)*

# PopBot 설계

AutoRPG를 위한 멀티 에이전트 개발 오케스트레이터입니다. Conductor에서 영감을 받았으며, 에이전트가 실제 게임을 실행하고, 클릭해서 조작하고, 동작을 검증할 수 있도록 인게임 테스트 인프라를 추가합니다.

> **상태:** 설계 — 2026-05-01에 확정. 살아 있는 문서이며, 구현 중 발견하는 사항을 그때그때 반영하여 갱신합니다.
>
> **먼저 읽으세요:** [USER_STORIES.md](USER_STORIES.md)는 이 설계가 존재하는 이유인 여섯 가지 결과를 정의합니다. 이 문서와 사용자 스토리가 상충할 경우, 사용자 스토리가 우선하며 이 문서가 그에 맞춰 갱신됩니다.

## 목표

1. 여러 AI 개발 에이전트를 병렬로 실행하되, 각각 자신만의 git 워크트리에서 실행합니다.
2. 에이전트가 실제 게임(창 모드 Unity 에디터)을 구동하여 엔드투엔드 테스트를 할 수 있게 합니다.
3. 티켓 / PR / Slack 큐, 트랜스크립트 히스토리, 로그, 터미널을 하나의 창에 표시합니다.
4. 기본값은 자율 동작으로 하되, 진정으로 차단되는 이벤트에서만 일시 정지합니다.

## 비목표 (v1)

- 프로덕션 CI/CD(별개의 관심사)
- 크로스 플랫폼(macOS 전용; 필요하다면 Linux/Windows는 이후)
- 다중 사용자 / SSO(기기당 단일 개발자)

## 앱 레이아웃

```text
┌──────────────┬─────────────────────────────────────────────┐
│ Tickets │ PRs│  ┌──┐ ┌──┐ ┌──┐ ┌──┐  Thumbnails (zoom-out)│
│   ENG-...    │  └──┘ └──┘ └──┘ └──┘                       │
│   ENG-...    ├─────────────────────────────────────────────┤
│   ENG-...    │                                             │
├──────────────┤  ┌────────┐  ┌────────┐  ┌────────┐        │
│ Chats        │  │ chat-1 │  │ chat-2 │  │ chat-3 │  + new │
│   live...    │  │        │  │        │  │        │        │
│   ──────     │  │        │  │        │  │        │        │
│   inactive   │  │        │  │        │  │        │        │
│              │  └────────┘  └────────┘  └────────┘        │
├──────────────┴─────────────────────────────────────────────┤
│ Logs ▼  Terminal  ...                                      │
│ [Unity] [Server]   (active chat's streams, sync-scroll)    │
└────────────────────────────────────────────────────────────┘
```

왼쪽 상단 탭: **티켓**(나에게 할당된 Linear 항목)과 **리뷰**(내 리뷰를 요청한 PR). 행을 클릭하면 → 그 작업을 위해 시딩된 채팅이 생성됩니다.

## 슬롯 — 지속되는 단위

슬롯 = 하나의 git 워크트리 + 그 Library + (선택적으로) 실행 중인 Unity 에디터 + (선택적으로) 실행 중인 사이드카 서버입니다. **슬롯은 드물게 생성되고, 지속적으로 재사용됩니다.**

### 슬롯별 디렉터리

```text
~/Library/Application Support/PopBot/slots/
├── slot-1/
│   ├── worktree/                    git worktree (persistent)
│   │   ├── Library/                 ~8 GB, lives here, slot owns it
│   │   ├── Assets/                  ~5.5 GB
│   │   └── ...
│   ├── server-data/                 sidecar's DB (local mode only)
│   ├── ports.json                   { mcp: 17901, server: 5101 }
│   ├── unity.log
│   ├── server.log
│   └── slot.json                    { branch, leasedBy, lastLeaseAt, unityPid?, serverPid? }
└── slot-2/...
```

### 실측 비용 수치 (2026-05-01 AutoRPG에서 측정)

| 작업 | 시간 |
|---|---|
| `git worktree add`(새로 생성, 62,000개 파일, LFS smudge) | ~23초 |
| master로부터 Library COW(APFS clonefile) | ~1초 |
| 슬롯에서의 첫 Unity 실행(콜드 Library) | 1~3분 |
| 스티키 히트(Unity가 이미 실행 중, 유휴 상태) | ~50ms |
| 콜드 스타트(Unity 꺼짐, 브랜치 일치) | 15~30초 |
| 기존 슬롯에서의 브랜치 전환(델타 + Unity 리로드) | 5~15초 |
| 슬롯 생성 전체(워크트리 추가 + COW + 첫 임포트) | ~1~3분, **드물게 발생** |

### 디스크 예산

슬롯당 ~14GB(Library 8GB + Assets 5.5GB + 스크래치). 슬롯 4개 = ~55GB. 공유 `.git`(~8GB)은 한 번만 계산됩니다.

### 리스 정책

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### 브랜치 고유성

Git은 같은 브랜치를 두 워크트리에서 동시에 체크아웃하는 것을 거부합니다. 다음으로 해결합니다.
- **Lite / 리뷰 채팅**은 detached HEAD를 사용합니다(충돌 없음).
- **같은 브랜치의 두 테스트 채팅** — 두 번째는 임시 브랜치(`<branch>-slot-N`)나 detached HEAD를 사용합니다. PopBot의 스케줄러가 자동으로 선택합니다.

### 체크아웃 전 안전 조치

기존 슬롯에서 브랜치를 전환하기 전에:

1. `git stash --include-untracked`(항상; 안전망).
2. 에이전트가 소유한 커밋되지 않은 커밋이 있으면 거부합니다. 먼저 커밋하거나 크게 실패시킵니다.
3. 열려 있는 Unity 씬을 닫습니다(브랜치 간 GUID 해석 문제 방지).
4. `git checkout <branch>`.
5. 해당되면 stash를 pop하거나, 브랜치별 stash 기록으로부터 복원합니다.

### 슬롯별 정책 설정값 (환경설정에서)

- `pinnedBranch?` — 다른 브랜치를 위한 리스를 거부합니다; 주력 작업 슬롯.
- `cleanOnRelease: bool` — 해제 시 `git clean -fd && git checkout .`; 기본값 꺼짐.
- `autoStashOnSwitch: bool` — 기본값 켜짐.

## 리소스 예산 (독립적인 설정값)

슬롯과 활성 Unity 인스턴스는 **별개의 예산**입니다. 슬롯은 Unity가 꺼진 채로도 존재할 수 있습니다 — 그 시점에는 그저 저장소일 뿐입니다. 실행 중인 Unity는 RAM에 종속되며 독립적으로 조절 가능합니다.

| 예산 | 단위당 비용 | 기본값 | 사용자 설정 |
|---|---|---|---|
| **슬롯 개수**(디스크상의 워크트리) | ~14GB | 2~4 | 환경설정: "슬롯" |
| **최대 활성 Unity**(실행 중인 프로세스) | ~3~4GB RAM | 2 | 환경설정: "최대 활성 Unity" |
| **Unity 하드 상한**(자율 모드 자동 승인 상한) | — | 계산값: `floor(systemRAM / 4 GB)` | 환경설정: "Unity 하드 상한" |

### 리스 정책 (확장)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### 에이전트 주도 용량 확장

Unity 용량으로 에이전트가 막혀 있을 때 사용 가능한 새 MCP 도구입니다.

| 도구 | 모드 | 반환값 |
|---|---|---|
| `request_unity_capacity` | 동기 | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

동작:

- **인터랙티브 채팅** → 채팅이 노란색이 되고, 배너가 사용자에게 승인을 요청합니다.
- **자율 채팅** → `Unity 하드 상한`까지 자동 승인합니다. 그 이상은 사람을 위해 일시 정지합니다.
- 사용자는 언제든 환경설정에서 선제적으로 용량을 늘리거나 줄일 수도 있습니다. 용량 축소는 (사용 중이 아닌) LRU 유휴 Unity를 축출합니다.

## 채팅 유형

| 유형 | 슬롯 | Library | Unity | 사이드카 | 시작 시간 | RAM |
|---|---|---|---|---|---|---|
| **Lite**(리뷰, 계획, 트리아지) | 선택적 | — | — | — | ~1~2초 | ~50~100MB |
| **클라이언트 테스트** | 필수 | 슬롯이 소유 | 화면 2에 GUI | 로컬 또는 원격 | 50ms~30초 | ~2~4GB |
| **서버 테스트** | 필수 | 슬롯이 소유 | 화면 2에 GUI | 항상 로컬 | 50ms~35초 | ~2~5GB |

새 채팅의 기본값: **Lite**. 실제로 게임 테스트가 필요할 때 승격시킵니다.

## 서버 모드

채팅별 설정이며, 실행 중에도 전환할 수 있습니다.

| 모드 | 서버 소스 | 사용 시점 |
|---|---|---|
| `local`(기본값) | 슬롯당 `./run_local.sh --port <P> --data-dir <D>` | 일상적인 에이전트 실행; 백엔드 변경; 결정적 상태 |
| `remote-dev` | 공유 원격 개발 서버 | 순수 클라이언트 반복 작업; 드리프트 감지가 진입을 지킴 |

### 드리프트 감지

`remote-dev` 리스가 수락되기 전: PopBot은 로컬에서 `Assets/Scripts/Simulation/GameDataHash.cs` 상수 + DTO 버전을 읽고, 원격의 `/health`를 GET하여 비교합니다. 불일치 시 → 구조화된 오류와 함께 리스를 거부합니다.

### `/health` 반환값

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### 세션 중 전환

사용자가 채팅 설정에서 `Server Mode`를 전환하면, PopBot은 다음을 수행합니다.

1. 드리프트 점검(`remote-dev`로 진입하는 경우). 불일치 시 거부.
2. 필요에 따라 사이드카 프로세스를 중지 / 시작.
3. MCP를 통한 `client_set_server_endpoint { url }` — 런타임 재지정.
4. 인게임 세션 리셋 강제(로그아웃/타이틀로) — 기존 인증은 무효.
5. 진행 중인 작업 취소, 배너 표시: "server changed, restart task."

## 채팅별 설정 패널

| 설정 | 기본값 | 참고 |
|---|---|---|
| 모드 | `Interactive` | `Autonomous` = 안전한 것은 자동 승인, 진정으로 막혔을 때만 일시 정지 |
| 서버 모드 | `local` | `remote-dev`(드리프트 점검됨) |
| 창 모드 | `GUI on screen 2` | `Headless`(추후, 옵트인) / `Visible` |
| 시간 배율 | `1.0` | 애니메이션 빨리 감기 |
| 게임 뷰 해상도 | `1920×1080` | 재현 가능한 스크린샷을 위해 고정 |
| 액션마다 자동 스크린샷 | 꺼짐 | 증빙 번들용 |
| 상세 로그 | 꺼짐 | 에이전트 자체를 디버깅할 때 전환 |
| 에이전트 백엔드 | `claude` | `codex`(Phase 4) |
| 기본 픽스처 | 없음 | 세이브 블롭으로 부팅 |
| 토큰 예산 | `1M` | 도달 시 일시 정지(자율 모드) |
| 시간 예산 | `60분` | 도달 시 일시 정지(자율 모드) |
| 루프 감지 | 켜짐 | N회 동일한 도구 호출 / K분간 진행 없음 시 일시 정지 |

## 자율 모드

### 정책 엔진 — `canUseTool`에 연결됨

정책을 프롬프트에 파묻지 마세요. 모델이 스스로를 설득해 빠져나갈 수 있습니다. SDK의 하드 비토 훅을 사용하세요.

**자율 모드에서 자동 승인 (조용히):**

- 슬롯의 워크트리 내부에서의 Read / Edit / Write / Grep / Glob
- 워크트리 내부에서의 Bash(아래 거부 목록 적용)
- 슬롯 자신의 MCP 서버에 대한 MCP 호출
- Skill / 서브 에이전트 호출
- TodoWrite, 내부 SDK 작업

**항상 사람을 위해 일시 정지 (자율 모드에서도):**

- `git push`, `git reset --hard`, `git checkout --`, force가 붙은 모든 것, 브랜치 삭제
- 슬롯의 워크트리 경로 바깥의 모든 것
- 허용 목록에 없는 호스트로의 네트워크 호출
- `tmp/`나 슬롯 디렉터리 바깥의 `rm -rf`
- `gh pr create` 및 모든 GitHub 게시 액션
- Slack / 이메일 / 외부 메시징
- `~/.claude`, `.mcp.json`, 시스템 설정 수정

### "진정으로 막힘" 감지

**에이전트 자가 보고**(SDK `message_done` 형태를 통해):

- 명확화 질문
- 명시적 차단 요인
- 최종 "완료했습니다"

**PopBot이 감시**(심층 방어):

- 루프 — 동일한 도구 호출이 N회 연속
- 정체 — K분 동안 진행 이벤트 없음
- 토큰 / 시간 예산 초과
- 반복되는 테스트 실패(동일한 실패가 K회)

### 상태 색상 (채팅 썸네일)

| 색상 | 상태 |
|---|---|
| 파랑 | 실행 중 |
| 초록 | 작업 완료 |
| 노랑 | 일시 정지 — 사용자 필요 |
| 빨강 | 오류 발생 |
| 회색 | 유휴 / 미시작 |

자율 모드에서는 썸네일을 훑어보며 **노랑**을 찾습니다. 그 외에는 다 괜찮습니다.

## MCP 자동화 표면

### 규칙: 모든 도구는 ~100ms 이내에 반환

오래 걸리는 작업은 즉시 `{ jobId }`를 반환하고, 에이전트가 폴링합니다. MCP HTTP 리스너를 100ms 넘게 블로킹하지 마세요.

### 작업(Job) 인프라

| 도구 | 모드 | 반환값 |
|---|---|---|
| `job_status` | 동기 | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | 동기 | 도구의 전체 페이로드; job을 폐기 |
| `job_cancel` | 동기 | 협조적 취소 플래그를 설정 |
| `job_list` | 동기 | 활성 + 최근(TTL ~60초) |

코루틴은 `EditorCoroutineUtility.StartCoroutineOwnerless`를 통해 실행되며, `EditorApplication.update`가 구동합니다. `JobContext`는 `SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)`를 노출합니다.

### 도구 카탈로그 — Phase 1 최소 구성

**생명주기:**

- `play_status`(동기), `play_pause` / `play_resume` / `play_step`(동기), `time_scale_set`(동기)
- `play_enter`(job), `play_exit`(동기)
- `editor_quit`(동기)

**관찰:**

- `screenshot`(동기) — `Library/MCP/Screenshots/{session}/{label}.png`에 기록하고 경로를 반환
- `game_state_summary`(동기) — 화면 스택 최상단, 재화, 레벨, 챕터, 장착 장비, 해금 항목, 최근 오류 10개
- `screen_stack`(동기), `chapter_status`(동기)
- `ui_tree`(동기) — 해석된 `text-loc`이 포함된 계층 구조
- `ui_query`(동기) — CSS와 유사한 셀렉터(`.btn`, `#Confirm`, `[text-loc=Friends.Title]`)

**행동:**

- `ui_click`(동기), `ui_click_by_loc`(동기) — `panel.SendEvent`를 통해 `PointerDown/Up/ClickEvent`를 발생시킴

**동기화 / 대기:**

- `wait_until`(job) — 조건: `screen`, `log`, `event`, `path`
- `wait_for_idle`(job)

**로그(기존 확장):**

- `console_get_logs` — `sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack: "none"|"first"|"all"` 추가
- `server_logs`(동기) — PopBot의 `server.log`를 tail, `console_get_logs`와 동일한 형태
- `server_health`(동기), `client_set_server_endpoint`(동기)

**세션:**

- `mcp_session_start` / `mcp_session_end` — `tmp/mcp-sessions/{slug}/`에 예측 가능한 아티팩트 디렉터리

### 도구 카탈로그 — 이후 단계

- `command_apply`, `command_list` — UI를 우회하는 주요 액션 표면
- `save_blob_get` / `save_blob_load`, 픽스처 관리
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`, `gameview_resolution_set`
- `game_state_path` — 허용 목록에 있는 루트를 사용하는 리플렉션 기반 리더

## 창 관리

기본값: 네이티브 헬퍼가 창을 배치하는 GUI 에디터.

**네이티브 macOS 창 이동기 (~50줄 Swift):**

1. 헬퍼가 창이 나타난 후 ~100ms 이내에 붙잡을 수 있도록 촘촘한 `AXUIElement` 폴링(50ms).
2. 화면 2의 설정된 사각형으로 `setFrame:`.
3. `kAXMinimizedAttribute = true`(Dock으로 내림).
4. 포커스를 빼앗지 않음.

**실행 전에 창 위치를 위한 `EditorPrefs`를 미리 설정합니다.** Unity는 시작 시 마지막 창 위치를 복원하므로, *두 번째* 실행부터는 이미 배치된 채로 열립니다. 첫 실행은 짧게(~200ms) 깜빡이지만, 이후 실행은 그렇지 않습니다.

**사용자 측 일회성 설정**(PopBot 최초 실행 안내에 문서화됨): `Dock → Unity 우클릭 → Options → Assign To: Desktop X`. macOS는 이후 Unity 창을 그 Space로 자동 라우팅합니다. 이렇게 설정하면, 첫 실행의 깜빡임조차 사용자가 보고 있지 않은 Space에서 일어납니다.

여러 Unity가 화면 2의 예측 가능한 위치에 놓이도록 슬롯별로 위치를 설정할 수 있습니다.

**헤드리스 `Window Mode`**는 batchmode 검증이 통과한 이후 옵트인입니다(Phase 4쯤). 아키텍처는 동일하며, 실행 플래그만 바뀝니다.

## 서버 / Unity 페어링 프로토콜

시작 순서와 생명주기가 엄격하게 관리되지 않으면 미묘한 실패에 부딪힙니다.

### 시작 순서 (PopBot이 강제)

1. `./run_local.sh --port S --data-dir D`를 실행. stdio를 `server.log`로 tee. `server_pid`를 기록.
2. `/health`가 200을 반환할 때까지 폴링(`commit/gameDataHash/dtoVersion` 포함). 타임아웃 30초. 실패 → 서버를 종료하고 오류를 표시.
3. 워크트리에 `client-server.json`을 작성하여 `localhost:S`를 가리키게 함.
4. `POPBOT_MCP_PORT=M`으로 Unity를 실행. `unity_pid`를 기록.
5. `/mcp`가 200을 반환할 때까지 폴링. 타임아웃 60초. 실패 → 둘 다 종료하고 오류를 표시.
6. 네이티브 창 이동기가 실행됨.
7. 슬롯이 활성화됨; 에이전트가 리스할 수 있음.

### 연쇄 실패

- **세션 도중 서버 사망** → PopBot이 PID 생존 확인 + `server_health` 5xx로 감지 → 슬롯을 저하됨으로 표시 → 서버 재시작을 한 번 시도 → 그마저 실패하면 채팅에 빨간색으로 표시.
- **Unity 사망** → 서버는 계속 실행됨(서버는 Unity 재시작보다 오래 살아남음; 비용이 더 저렴). PopBot은 동일한 서버를 대상으로 새 Unity를 실행할 수 있음.
- **슬롯 해제** → 서버 SIGTERM(5초 유예) → SIGKILL → Unity `editor_quit` MCP 호출 → SIGTERM(5초 유예) → SIGKILL.

### PopBot 시작 시 조정(reconciliation)

`slot.json` 파일을 스캔합니다. 기록된 각 pid에 대해 `kill -0 <pid>`를 실행하고, 죽어 있으면 상태를 정리하고 슬롯을 리셋합니다. 표준적인 고아 프로세스 정리입니다.

## 에이전트 통합

### Claude Agent SDK (v1)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = query({
  prompt,
  options: {
    cwd: slot.worktreePath,
    mcpServers: {
      'popbot-unity': { type: 'http', url: `http://localhost:${slot.mcpPort}/mcp` }
    },
    permissionMode: chat.autonomous ? 'acceptEdits' : 'default',
    canUseTool: (tool, args) => popbotPolicy.evaluate(tool, args, chat),
  }
});

for await (const event of session) {
  routeToChatUI(event);
  routeToLogBuffers(event);
  autonomyEngine.observe(event);
}
```

이를 통해 공짜로 얻는 것: skill, 메모리, 서브 에이전트, 훅, MCP, 구조화된 이벤트로서의 권한 요청. **`claude` CLI를 서브프로세스로 스크래핑하지 마세요** — 모든 고급 기능마다 SDK와 싸우게 됩니다.

### AgentBackend 인터페이스 (첫날부터 정의; v1에서는 구현체 하나)

```ts
interface AgentBackend {
  spawn(opts: SpawnOpts): AgentSession;
  capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
}
interface AgentSession {
  sendUser(text: string): void;
  approve(permId: string, decision: 'allow' | 'deny'): void;
  pause(): void;
  stop(): void;
  events: AsyncIterable<AgentEvent>;
}
```

Codex 백엔드(Phase 4)는 OpenAI Agents SDK를 이 인터페이스에 어댑팅합니다. Skill/메모리는 사용할 수 없으며, UI가 이를 명확히 표시합니다.

### 채팅별 MCP 설정

각 에이전트는 **자신의 슬롯**의 포트로 주입된 `mcpServers`와 함께 생성됩니다 — `popbot-unity` URL = `localhost:<slot.mcpPort>/mcp`. 다른 MCP들(Linear, Sentry, Amplitude, BetterStack)은 SDK에 의해 `~/.claude/settings.json`이나 `.mcp.json`으로부터 자동으로 상속됩니다.

## 기술 스택

- **Electron**(Node + Chromium)
- UI를 위한 **React + Tailwind**
- 터미널 패널을 위한 **xterm.js + node-pty**
- 트랜스크립트 영속성을 위한 **better-sqlite3**(이벤트당 한 행, 채팅 + 타임스탬프로 색인)
- OAuth 토큰 / API 키 / 에이전트 자격 증명을 위한 **keytar**
- 티켓 패널을 위한 **Linear GraphQL API**
- 미리뷰 PR 패널을 위한 **`gh` GraphQL**
- 창 배치를 위한 **네이티브 Swift 헬퍼**

## 단계 구분

### Phase 0 — 사전 준비 (~3일)

| 항목 | 담당 | 규모 |
|---|---|---|
| MCP `POPBOT_MCP_PORT` 환경 변수 오버라이드 | Unity MCP | 5분 |
| `./run_local.sh --port` + `--data-dir` 인자 | 서버 | 30분 |
| `/health`가 `commit`, `gameDataHash`, `dtoVersion`을 반환 | 서버 | 30분 |
| 네이티브 macOS 창 이동기 헬퍼(Swift) | PopBot | ~반나절 |
| 슬롯 생명주기 프로토타입(워크트리 추가, Library COW, 브랜치 전환, stash 안전 조치) | PopBot | ~1일 |

### Phase 1 — MCP 자동화 표면 (~3~5일)

작업(Job) 인프라 + 위의 Phase 1 도구 카탈로그. 기존의 장시간 실행 도구(`rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`)를 job 모델로 마이그레이션.

### Phase 2 — PopBot Electron MVP (~1~2주)

단일 채팅 컬럼, `ClaudeBackend`만, 단일 슬롯, 단일 Unity. 설정 패널 골격. `canUseTool` 정책 엔진. 네이티브 헬퍼 통합. 엔드투엔드 루프: 채팅 열기 → 에이전트가 코드 수정 → 에이전트가 게임 실행 → 에이전트가 스크린샷 + 로그로 검증 → 완료.

### Phase 3 — 멀티 채팅 + 패널 (~1주)

여러 채팅 컬럼(떠 있는 +/x로 추가/제거). 상태 색상이 있는 썸네일 스트립. Linear 티켓 + 미리뷰 PR 패널. Unity/서버 탭을 나란히 배치한 하단 로그 패널. 채팅 설정의 모드/서버 모드 토글.

### Phase 4 — 다듬기 + 고급 기능

Codex 백엔드 어댑터. (batchmode 검증 이후) 헤드리스 `Window Mode`. `crash_dump`, `events_pop`, `command_apply`, 픽스처 관리. 나란한 로그 시간 상관 분석. 자율성 예산과 루프 감지 개선.

## 미해결 질문

1. **Batchmode 검증** — AutoRPG가 실제로 `-batchmode` Play 모드에서 실행되는가? 검증 스크립트는 Phase 4쯤; v1을 막지 않음.
2. **Master Library 새로 고침 주기** — 수동 버튼 대 자동 대 N일 TTL? 기본값: 환경설정의 수동 버튼.
3. **슬롯 개수 기본값** — 4로 하드코딩할지, RAM/코어에 따라 조정할지? 아마도 기본값 2~3, 설정 가능.
4. **PopBot 리포지토리** — `autorpg`와 분리할지, `tools/popbot/`에 둘지? 안정화되면 분리, 초기 개발 중에는 인트리(in-tree).

## 리스크

| 리스크 | 완화 방안 |
|---|---|
| `git checkout`이 stash 도중 슬롯을 손상시킴 | 항상 먼저 stash; 체크아웃 후 깨끗한지 검증; 지저분하면 거부 |
| 두 PopBot 인스턴스가 같은 슬롯을 밟음 | 슬롯 디렉터리별 락 파일; 시작 시 고아를 조정 |
| Unity가 멈추고 슬롯 리스가 결코 해제되지 않음 | PID 생존 확인 + PopBot 시작 시 GC |
| 워크트리 간 LFS 잠금 충돌 | 드묾; 발생 시 명확하게 표시 |
| 슬롯 Library가 master로부터 크게 드리프트 | 수동 "슬롯 리셋"이 master로부터 재구축 |
| 디스크가 가득 참 | 환경설정에 슬롯별 크기 표시; "리셋"이 공간을 회수 |
| 세션 중 remote-dev에서의 백엔드 드리프트 | 오류 시 `server_health` 재점검; 배너 + 중단 |
| 자율 모드가 안전하지 않은 것을 자동 승인 | `canUseTool`의 하드코딩된 거부 목록; 채팅 설정으로 결코 재정의 불가 |

## 증빙 아티팩트 (에이전트 디버그 산출물)

에이전트가 디버그 작업을 완료하면, `tmp/mcp-sessions/{slug}/`에 다음을 씁니다.

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md`는 6개 섹션 템플릿(재현 / 이전 / 근본 원인 / 수정 / 이후 / 검증)을 따릅니다. 이 관례는 SKILL(`agent-debug`)에 문서화되어 있으며, MCP는 예측 가능한 세션 경로만 제공합니다.

## 빠른 참조 — 이전 제안에서 바뀐 점

이 문서를 만든 대화를 읽는 모든 이를 위해:

- Library 풀 / 프로세스 풀 / 워크트리 풀이 **하나의 개념으로 통합됨: 슬롯.** 슬롯은 자신의 워크트리, Library, 선택적 Unity, 선택적 사이드카를 소유합니다. 심볼릭 링크도, 별도의 풀도 없습니다.
- `git worktree add`는 AutoRPG에서 **~23초**입니다(62,000개 파일에 걸친 LFS smudge), 1~2초가 아닙니다. 슬롯 생성은 드물며, 체크아웃을 통한 재사용이 일상적인 핫 패스입니다.
- **화면 2의 GUI 에디터**가 v1 기본값입니다. 헤드리스 batchmode는 검증 이후의 Phase 4 옵트인입니다.
- 서버는 `./run_local.sh`를 통해 인트리로 실행됩니다; 격리를 위한 슬롯별 포트 + 데이터 디렉터리.
- 에이전트 통합: **Claude Agent SDK 우선**, AgentBackend 인터페이스, Codex는 Phase 4.
