# 단계 구분

PopBot을 "설계 + 프로토타입" 상태에서 "쓸모 있는 일상 도구"로 만들어 가는 로드맵입니다. [POPBOT_DESIGN.md](POPBOT_DESIGN.md#단계-구분)의 단계 구분을 그대로 반영하되, 체크박스로 구체적인 진행 상황을 추적합니다.

항목이 완료될 때마다 이 파일을 갱신하세요. 하나의 커밋이 여러 박스를 체크할 수 있습니다.

---

## Phase 0 — 사전 준비 (~3일)

AutoRPG 리포지토리의 기초 작업 + 여기(PopBot 리포지토리)의 네이티브 헬퍼. 대부분은 실제 엔드투엔드 테스트를 막지만 Electron 스캐폴드 자체는 막지 않습니다.

### `~/pop/autorpg`에서

- [ ] **`POPBOT_MCP_PORT` 환경 변수 오버라이드**를 에디터 내 MCP 서버(`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`)에 적용. 환경 변수에서 포트를 읽고, `17893`으로 폴백. ~5분.
- [ ] **`./run_local.sh --port` + `--data-dir` 플래그.** 서버가 둘 다 인자로 받도록 함; 슬롯별 DB 격리를 위한 데이터 디렉터리. ~30분.
- [ ] **`/health` 엔드포인트 확장** — `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }`를 반환. PopBot은 리스 시점의 드리프트 감지에 이를 사용함. ~30분.

### 이 리포지토리에서

- [ ] **네이티브 macOS 창 이동기 헬퍼** — `native/popbot-windowmover/`에 위치한 Swift CLI. 서브커맨드: `move`, `minimize`, `wait-for-window`. ~반나절.
- [ ] **슬롯 생명주기 프로토타입** — `src/main/slots/` 아래의 독립형 TS 모듈로, `scripts/` 아래의 스크립트로 실행해봄. 워크트리 추가, master로부터의 Library COW, stash 안전 조치가 있는 브랜치 전환, 리스/해제, 고아 조정을 다룸. ~1일.

---

## Phase 1 — MCP 자동화 표면 (~3~5일)

`~/pop/autorpg`에서. 에이전트가 실제로 사용할 에디터 내 MCP 도구를 구축합니다.

- [ ] **작업(Job) 인프라** — `job_status`, `job_get_result`, `job_cancel`, `job_list`. 장시간 실행되는 모든 도구는 즉시 `{ jobId }`를 반환.
- [ ] **생명주기 도구** — `play_status`, `play_enter`(job), `play_exit`, `play_pause/resume/step`, `time_scale_set`, `editor_quit`.
- [ ] **관찰 도구** — `screenshot`, `game_state_summary`, `screen_stack`, `chapter_status`, `ui_tree`, `ui_query`.
- [ ] **행동 도구** — `ui_click`, `ui_click_by_loc`.
- [ ] **동기화 도구** — `wait_until`(job), `wait_for_idle`(job).
- [ ] **로그 / 서버 도구** — `console_get_logs` 확장(`sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack`), `server_logs`, `server_health`, `client_set_server_endpoint`.
- [ ] **세션** — 예측 가능한 아티팩트 디렉터리를 위한 `mcp_session_start`, `mcp_session_end`.
- [ ] **기존 장시간 실행 도구를 job 모델로 마이그레이션**: `rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`.

---

## Phase 2 — PopBot Electron MVP (~1~2주)

단일 채팅에 대해 엔드투엔드로 사용 가능한 상태. **진행 중.**

- [ ] **Electron 스캐폴드** — `package.json`, Vite + React + TS + Tailwind, electron-builder, ESLint + Prettier, Vitest.
- [ ] 타입이 지정된 IPC 브리지를 갖춘 **Main / preload / renderer 분리**.
- [ ] 프로토타입 JSX 8개를 `.tsx`로 **`src/renderer/`에 이식**. 기능적 백엔드 없이 정적 UI가 Electron 창에서 실행됨.
- [ ] **better-sqlite3 스키마** — chats, messages, slots, prefs.
- [ ] 단일 채팅 컬럼에 배선된 **단일 ClaudeBackend 세션**. 메시지 보내기, 이벤트 스트림 받기.
- [ ] **`canUseTool` 정책 엔진** — 하드코딩된 거부 목록 + 모드별 허용. 렌더러가 권한 요청을 모달로 표시.
- [ ] 배선된 **슬롯 매니저** — 슬롯 하나, 실제 워크트리, Phase 0 헬퍼를 통한 실제 Unity 실행.
- [ ] **네이티브 창 이동기 통합** — Unity가 열리면 헬퍼가 화면 2에 배치.
- [ ] **설정 패널 골격** — 채팅별 모드, 서버 모드, 시간 배율, 에이전트 백엔드.
- [ ] **엔드투엔드 루프 데모** — 채팅 열기 → 에이전트가 코드 읽기 → 에이전트가 게임 실행 → 에이전트가 스크린샷 → 에이전트가 보고.

---

## Phase 3 — 멀티 채팅 + 주의 큐 패널 (~1~2주)

[US-1](USER_STORIES.md#us-1--관심이-필요한-큐에-대한-인지), [US-2](USER_STORIES.md#us-2--원클릭-활성화), [US-5](USER_STORIES.md#us-5--썸네일을-통한-쉬운-멀티태스킹), [US-6](USER_STORIES.md#us-6--한눈에-알-수-있는-상태)을 구현합니다.

- [ ] 여러 채팅 컬럼; 떠 있는 추가/제거.
- [ ] 상태 색상이 있는 썸네일 스트립(US-5, US-6).
- [ ] **Linear 티켓 패널**(나에게 할당됨, 우선순위 + 마감일로 순위 매김).
- [ ] **미리뷰 PR 패널**(`gh` GraphQL).
- [ ] **Slack 패널** — DM, @멘션, 소유한 채널. 완전히 새로운 서브시스템(`src/main/slack/`); `keytar`를 통한 OAuth. [USER_STORIES.md → 편차](USER_STORIES.md#세-번째-관심-소스로서의-slack-us-1) 참고.
- [ ] 어떤 패널의 행에서든 **원클릭 채팅 생성**; 채팅은 그 출처의 맥락으로 시딩됨(US-2).
- [ ] 하단 로그 패널 — Unity + 서버 탭, 활성 채팅에 대한 동기화 스크롤.
- [ ] 채팅 설정의 모드 + 서버 모드 토글, 세션 중 재지정 포함.
- [ ] `remote-dev` 리스에 대한 드리프트 감지.

---

## Phase 4 — 다듬기 + 고급 기능

- [ ] **Codex 백엔드 어댑터** — `CodexBackend implements AgentBackend`, UI에 표시되는 기능 플래그.
- [ ] **헤드리스 `Window Mode`** — batchmode 검증 스크립트가 AutoRPG에서 동작함을 증명한 이후 옵트인.
- [ ] **`crash_dump`, `events_pop`, `command_apply`, 픽스처 관리** MCP 도구.
- [ ] Unity와 서버 패널 간의 **나란한 로그 시간 상관 분석**.
- [ ] **자율성 예산 + 루프 감지** 개선(토큰 / 시간 / 반복 실패 일시 정지 트리거).
- [ ] **업데이트 채널** — electron-builder + 서명된 빌드를 통한 자동 업데이트.

---

## 미해결 질문 (설계에서 이월됨)

1. AutoRPG가 실제로 `-batchmode` Play 모드에서 실행되는가? 검증 스크립트는 Phase 4쯤; v1을 막지 않음.
2. Master Library 새로 고침 주기 — 수동 버튼 대 자동 대 N일 TTL? 기본값: 환경설정의 수동 버튼.
3. 슬롯 개수 기본값 — 4로 하드코딩할지, RAM/코어에 따라 조정할지? 아마도 기본값 2~3, 설정 가능.
