*Languages: [English](../ARCHITECTURE.md) · [Español](../es/ARCHITECTURE.md) · [Français](../fr/ARCHITECTURE.md) · [Deutsch](../de/ARCHITECTURE.md) · [日本語](../ja/ARCHITECTURE.md) · [한국어](ARCHITECTURE.md) · [简体中文](../zh-CN/ARCHITECTURE.md) · [Português (Brasil)](../pt-BR/ARCHITECTURE.md) · [Русский](../ru/ARCHITECTURE.md) · [Italiano](../it/ARCHITECTURE.md)*

# 아키텍처

Electron 프로세스 모델과 각 서브시스템이 위치하는 곳에 대한 실용적인 지도입니다. "왜"에 대해서는 [POPBOT_DESIGN.md](POPBOT_DESIGN.md)를 참고하세요. 이 문서의 모든 내용이 걸려 있는 **객체 그래프 + 생명주기 + 소유권 규칙**에 대해서는 [CORE_MODEL.md](CORE_MODEL.md)를 참고하세요 — 아래 내용이 뜬금없게 느껴진다면 그것부터 먼저 읽으세요.

## 프로세스 모델

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                         │
│  ─ Slot / worktree lifecycle — git worktrees or shado VHDX slots,    │
│    per-SCM clone/client setup, branch/changelist switching           │
│  ─ SCM provider registry — git + perforce behind one abstraction;    │
│    callers branch on CAPABILITIES, not provider id                   │
│  ─ Agent host — Claude AND Codex backends behind AgentBackend        │
│    (one session per chat); the canUseTool policy boundary            │
│  ─ Editor launcher + per-slot MCP glue — focus/launch Unity/Unreal/  │
│    custom editors; hand the agent its slot's editor MCP HTTP URL     │
│  ─ PTY manager — a persistent terminal per chat                      │
│  ─ Persistence — better-sqlite3 (transcripts, chat/slot/repo state,  │
│    prefs, SDK + Codex session caches)                                │
│  ─ External APIs — tickets (Linear / Jira / GitHub), reviews         │
│    (GitHub PRs / Helix Swarm), Slack, Sentry                         │
└────────┬─────────────────────────────────────────────────────────────┘
         │ contextBridge (typed IPC channels, `window.popbot.*`)
┌────────▼─────────────────────────────────────────────────────────────┐
│ Renderer (Chromium + React + Tailwind)                               │
│  ─ App shell, panels, chat columns, settings sheets, modals          │
│  ─ Subscribes to agent event streams over IPC                        │
│  ─ Sends user actions (approve permission, send message, ...) back   │
│  ─ Owns nothing the main process needs to recover after a renderer   │
│    crash; renderer is a view layer                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**규칙:** 렌더러는 결코 파일 시스템을 건드리지 않고, 자식 프로세스를 생성하지 않으며, 정본 상태(canonical state)를 보유하지 않습니다. 그 모든 것은 main의 몫입니다. 렌더러는 이벤트를 구독하고 의도(intent)를 전달합니다.

## 소스 레이아웃

```text
src/
├── main/                       # Electron main process — Node, no DOM
│   ├── index.ts                # entry; createWindow, app lifecycle, handler wiring
│   ├── ipc/                    # typed IPC handlers, one module per subsystem
│   │                           #   (agent, apps, chats, files, git, notifications,
│   │                           #    repos, reviews, sentry, settings, slack, term, tickets)
│   ├── agents/                 # AgentBackend interface + ClaudeBackend + CodexBackend
│   │                           #   + StubBackend; AgentHost, SDK/Codex session stores,
│   │                           #   CLI probes, recovery
│   ├── scm/                    # source-control provider registry + base class;
│   │                           #   gitProvider, perforceProvider, detect
│   ├── git/                    # git plumbing: worktrees, chat paths, reviews (gh PRs)
│   ├── p4/                     # Perforce: exec, client/workspace, file watcher,
│   │                           #   Swarm client + swarmReviews
│   ├── shado/                  # bundled shado VHDX CLI wrapper: base, slots, client
│   ├── tickets/                # ticket-source registry + linear/jira/github sources
│   ├── reviews/                # provider-agnostic Reviews orchestrator (groups by SCM)
│   ├── linear/                 # Linear API client
│   ├── jira/                   # Jira Cloud API client
│   ├── github/                 # GitHub (`gh` CLI) client
│   ├── slack/                  # Slack client + DM/@mention/channel poller
│   ├── sentry/                 # Sentry client + issue poller
│   ├── notifications/          # in-app notification classify + dispatch
│   ├── term/                   # per-chat PTY manager (node-pty)
│   ├── attachments/            # chat attachment (image/file) retention store
│   ├── persistence/            # better-sqlite3 schema (migrations) + typed queries
│   └── updates/                # electron-updater auto-update + on-demand check
├── preload/
│   └── index.ts                # contextBridge — exposes the typed `window.popbot` API
├── renderer/src/               # React UI
│   ├── main.tsx                # ReactDOM.createRoot mount
│   ├── App.tsx
│   ├── components/             # FLAT dir — panels (PanelA/B/D), chat column, dialogs,
│   │                           #   sheets, git/P4 panels, modals, primitives
│   ├── lib/                    # client-side hooks + buses (useChats, useReviews,
│   │                           #   agentEventBus, …); calls `window.popbot.*`, no Node
│   ├── styles/                 # Tailwind layer + ported styles
│   ├── assets/                 # engine / SCM / notification icons
│   └── fixtures/               # static sample data for dev
└── shared/                     # types/contracts shared across the bridge
    ├── ipc.ts                  # IPC channel names, payload types, the PopBotApi surface
    ├── domain.ts                # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## IPC 계약

모든 IPC는 타입이 지정되어 있으며 [`src/shared/ipc.ts`](../../src/shared/ipc.ts)에 중앙화되어 있습니다 — `IpcChannel` 문자열 맵, 요청/응답 페이로드 타입, 그리고 프리로드 브리지가 노출하는 `PopBotApi` 표면입니다. 관례:

- 서브시스템별로 네임스페이스가 지정된, 모든 채널 이름에 붙는 **`pb:` 접두사**(`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). 전체 목록은 `IpcChannel` 상수를 참고하세요.
- **요청/응답**은 `ipcRenderer.invoke` + `ipcMain.handle`을 사용합니다. 반환값은 타입이 지정됩니다. 핸들러는 `main/ipc/*`에서 서브시스템별로 등록되고 `main/index.ts`에 배선됩니다.
- **푸시 이벤트**(에이전트 스트림, PTY 데이터, 알림, 업데이트 진행 상황, 창 최대화)는 `webContents.send` + `ipcRenderer.on`을 사용합니다. 렌더러가 구독하고, main이 푸시합니다.
- **컴포넌트에서의 원시 IPC 금지.** 프리로드 스크립트(`src/preload/index.ts`)는 타입이 지정된 `window.popbot.*` 브리지를 노출하며, 렌더러 코드는 `ipcRenderer`를 직접 호출하는 대신 `renderer/src/lib/`의 훅/버스(`useChats`, `useReviews`, `agentEventBus` 등)를 거칩니다.

## 코드로 본 슬롯

슬롯은 단일 구조체가 아닙니다. 그것은 **번호가 매겨진 리스(lease)**(`slot_id`)와 그 리스가 가리키는 디스크상의 워크트리/클론입니다. 리스 상태는 채팅 행(`persistence/`의 `chats.slot_id`, `chats.worktree_path`)에 존재하며, 빈 슬롯 계산은 그 리포지토리의 슬롯을 보유한 열린 채팅들에 대한 쿼리입니다 — 리포지토리의 풀 크기는 `repos.slot_count`입니다. `shared/domain.ts`는 작은 공유 열거형과 레거시 `Slot` 레코드를 담고 있습니다.

```ts
export type SlotState = 'free' | 'leased' | 'degraded' | 'creating';

// NOTE: this `Slot` interface is currently unused by the running code
// (only SlotState + ChatStatus are imported). It still names Unity
// specifically; the live model has generalized past that — the editor is
// engine-agnostic (Unity/Unreal/custom) and isn't a supervised child with a
// tracked pid, so treat this shape as legacy, not authoritative.
export interface Slot {
  id: number;
  worktreePath: string;
  branch: string | null;
  ports: { mcp: number; server: number };
  unityPid: number | null;
  serverPid: number | null;
  state: SlotState;
  pinnedBranch?: string;
  cleanOnRelease?: boolean;
}
```

슬롯 획득/해제/조정(reconcile)은 `git/worktrees.ts`(git 워크트리), `shado/slots.ts` + `scm/*Provider.ts`(VHDX 슬롯 + SCM별 클론/클라이언트 설정), 그리고 `ipc/repos.ts` + `ipc/chats.ts` 핸들러에 걸쳐 있습니다. 리스 정책에 대해서는 [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#슬롯--지속되는-단위)를, 채팅의 작업이 슬롯을 넘나들며 어떻게 따라가는지에 대해서는 아래의 **크로스 슬롯 연속성**을 참고하세요.

## 웜 슬롯 저장소: shado VHDX 카피-온-라이트

AAA급 규모의 트리(0.5~1TB Perforce 게임 데포)에서는 슬롯이 `git worktree`나 완전한 체크아웃일 수 없습니다 — 데포를 N번 복사할 수도 없고, 콜드 동기화+빌드는 몇 분에서 몇 시간이 걸립니다. **shado**(번들된 Go CLI, 자매 리포지토리 `github.com/popbot-ai/shado`, `main/shado/`를 통해 호출됨)는 Windows에서 저장소 기반을 제공합니다.

- **베이스를 채우고 고정합니다.** `shado create <repoPath>`는 리포지토리 폴더를 확장 가능한 VHDX로 동기화/복사한 뒤, 이를 **읽기 전용**으로 고정합니다. 베이스는 전체 트리 *더하기* 웜 파생 상태(빌드 캐시, `node_modules`, `Intermediate/`, `Saved/`, `DerivedDataCache/` 등)를 담습니다.
- **디퍼런싱 자식 = 슬롯.** 각 슬롯은 고정된 베이스의 카피-온-라이트 VHDX 자식(`shado clone create --slot N`)이며, 드라이브 문자가 아니라 **마운트 포인트 폴더**(약 20개 슬롯을 넘어 확장할 수 있도록)에 `Mount-VHD` + `Add-PartitionAccessPath`를 통해 마운트됩니다. 새롭고 빌드 준비가 된 슬롯은 1TB 재동기화 + 콜드 빌드 대신 몇 초와 몇 GB의 델타만 소모합니다. 리셋 = 자식 파괴 + 베이스로부터 재생성(즉시 깨끗해짐).
- **레이아웃.** 슬롯은 (VHDX 모델이 요구하는 대로) **리포지토리와 같은 드라이브**에 위치합니다: `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`. 베이스 + diff + 슬롯 메타데이터는 `…/workspaces/<repoId>/shado`(`SHADO_HOME`) 아래에 있습니다. 경로는 `main/shado/client.ts`(`popbotRootForRepo`, `shadoHomeForRepo`)에서 도출됩니다.
- **권한 상승.** `shado create` / `clone create` / `remount` / `restore`는 관리자 권한이 필요합니다. PopBot은 권한 상승 없이 실행되므로, 이들은 단일 UAC(임시 `.bat` + `Start-Process -Verb RunAs`)를 통해 실행됩니다. 권한 상승으로 생성된 클론은 결국 Administrators 그룹 소유가 되므로 → git은 호출마다 `-c safe.directory=*`를 받고, p4 클라이언트는 호스트에 고정됩니다.
- **재부팅.** VHDX 마운트는 재부팅을 견디지 못합니다(분리된 클론 + 깨진 마운트 포인트 reparse 폴더). 실행 시 연결이 끊긴 슬롯 리포지토리를 감지하고, 사용자가 클릭하는 **중앙 모달**("재연결")을 표시합니다 — 하나의 UAC로 모두를 다시 마운트합니다(`remountReposElevated`). `main/shado/base.ts`를 참고하세요.

git 워크트리 경로(shado가 아닌 리포지토리의 `repo.mode = 'slots'`)는 일반 리포지토리를 위해 여전히 존재합니다. shado는 VHDX/Perforce 케이스를 위해 리포지토리별로 선택됩니다.

### SCM별 슬롯 설정

슬롯은 공유 체크아웃이 아니라 **독립적인 클론/클라이언트**입니다 — 이것이 아래의 크로스 슬롯 연속성 뒤에 있는 핵심 사실입니다.

- **git**(`scm/gitProvider.ts`): 슬롯은 고정된 베이스의 완전한 클론입니다. `ensureSlotWorktree`는 이를 `popbot/slot-N`에 파킹합니다. `checkoutBranch`는 **최신** 베이스로부터 채팅 브랜치를 생성합니다(`fetch origin` → `checkout -f -B branch origin/<base>` → `clean -fd`). 물려받은 베이스의 지저분한 부분은 버리면서 gitignore된 웜 캐시는 유지합니다.
- **perforce**(`p4/*`, `scm/perforceProvider.ts`): 각 슬롯은 마운트에 뿌리를 둔 자신만의 p4 클라이언트 `popbot_<repoId>_slot<N>`을 가집니다. 설정은 `p4 flush @baseChangelist`(고정된 베이스에 대한 0바이트 have-table 업데이트) + 베이스→헤드 델타만의 `p4 sync`입니다. **`p4 reconcile`은 없습니다**(게임 데포에서 20분짜리 트리 순회입니다). 슬롯별 `fs.watch`가 변경된 경로를 기록하고, 프로바이더는 대상이 된 `p4 edit/add/delete`로 그 경로들만 엽니다. PopBot 자체의 쓰기 작업(sync/revert/unshelve)은 다시 열리지 않도록 워처를 **일시 정지**시킵니다.

## 크로스 슬롯 연속성: 채팅의 브랜치/체인지리스트 홈

**문제.** 각 슬롯은 독립적인 클론(git)/클라이언트(perforce)이므로, 채팅의 브랜치나 대기 중인 체인지리스트는 **그것이 생성된 슬롯에만** 존재합니다. 채팅은 공유 풀에서 슬롯을 빌려오며, *다른* 슬롯에서 다시 열릴 수 있습니다 — 그곳에는 그 작업이 존재하지 않을 것입니다.(예전 `git worktree` 모델에는 이 문제가 없었습니다. 모든 워크트리가 하나의 `.git`을 공유했으므로 브랜치가 중앙화되어 있었습니다.)

**해결책.** 채팅의 작업을 닫을 때 슬롯에 구애받지 않는 **홈**으로 통합하고, 다시 열 때 복원합니다. `SourceControlProvider.persistChatOnClose` / `restoreChatOnReopen`을 통해 훅되며, `ChatsClose` / `ChatsReopen` 핸들러(`ipc/chats.ts`)에서 호출되어 예전의 슬롯 로컬 스태시를 대체합니다. 채팅에 저장되는 상태: `chats.p4_shelf_cl`(perforce; git은 필요 없음).

- **git → 로컬 루트 리포지토리.** 홈은 모든 슬롯이 클론되어 나온 디스크상의 리포지토리 폴더인 `repo.repoPath`이며, 각 슬롯에 `root` 리모트로 추가됩니다(`origin`은 PR을 위해 실제 GitHub 리모트로 유지됩니다).
  - *닫기:* 커밋되지 않은 작업을 버릴 수 있는 `[Soft committed unstaged files]` 커밋으로 옮긴 뒤(사용자가 폐기하지 않았다면), `git push -f root <branch>`. 로컬 루트는 모든 채팅의 브랜치를 누적합니다(그 브랜치 목록 = 예전의 공유 워크트리 동작).
  - *재개:* 베이스 체크아웃 후, `git fetch root <branch>` → `checkout -f -B branch FETCH_HEAD` → WIP 커밋을 소프트 언두하여 편집 사항이 커밋되지 않은 상태로 돌아가게 함.
- **perforce → 셸프로서의 루트 클라이언트.** 대기 중인 체인지리스트는 슬롯별이므로, 홈은 안정적이고 결코 동기화되지 않는 리포지토리별 클라이언트 `popbot_<repoId>_root`(`ensureRootClient` — 스펙만 있고 동기화는 없음)가 소유한 서버 측 **셸프**입니다.
  - *닫기:* 슬롯의 CL을 `p4 shelve`한 뒤, 채팅의 루트 소유 CL로 `p4 reshelve -f`합니다. **`reshelve`는 셸브된 콘텐츠를 서버 측에서 이동시킵니다** — Helix 2025.2에서 검증됨: 클라이언트를 넘나들며, 워크스페이스 동기화 없이, 루트의 디스크에는 아무것도 쓰지 않습니다("파일을 수정하지 않고 셸프를 이동합니다"). 그런 다음 슬롯의 셸프 + 열린 파일 + CL을 삭제하여 슬롯이 결국 **비어 있게** 만듭니다. 루트 클라이언트는 채팅당 하나의 셸브된 CL을 소유합니다.
  - *재개:* `p4 unshelve -s <rootCl> -c <newSlotCl>`을 새 슬롯의 새로운 CL로(워처는 일시 정지된 상태) 언셸브하며, 루트 셸프는 파킹된 백업으로 유지됩니다.

결론: 슬롯은 서로 교체 가능한 스크래치 공간이며, 로컬 루트 git 리포지토리와 루트 p4 클라이언트가 진행 중인 작업을 위한 지속적이고 사용자에게 보이는 홈입니다.

## 에이전트 백엔드

`AgentBackend`(`main/agents/types.ts`)는 `AgentHost`와 구체적인 백엔드 사이의 인터페이스입니다. **오늘날 두 개의 실제 백엔드가 제공됩니다** — `ClaudeBackend`(`@anthropic-ai/claude-agent-sdk`를 감쌈)와 `CodexBackend`(`@openai/codex-sdk`를 감쌈) — 그리고 테스트를 위한 `StubBackend`도 있습니다. 채팅은 자신의 백엔드(`chats.agent`)를 선택하고 전환할 수 있습니다. 두 SDK는 서로 다른 네이티브 재개 핸들, 모델, 강도 설정을 가지므로, 이것들은 **프로바이더 범위로** 저장됩니다(Claude의 `session_id` + `claude_model`/`claude_reasoning_effort`; Codex의 `codex_thread_id` + `codex_model`/`codex_reasoning_effort`). `AgentHost`는 백엔드를 선택하고, 채팅당 하나의 세션을 생성하며, 각 세션의 `AgentEvent`를 렌더러 + 영속 계층으로 다시 방송합니다.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

슬롯별 에디터 MCP는 생성 시 백엔드에 전달됩니다. `SpawnOpts.mcpServers`는 채팅의 Unity/Unreal 에디터 엔드포인트(`{ type: 'http', url }`)를 담으며, SDK 옵션에 메모리상으로만 등록됩니다 — 디스크에는 아무것도 쓰지 않습니다. `mcpHttp` 기능이 있는 백엔드만 이를 소비합니다. 아래의 **슬롯별 에디터 MCP**를 참고하세요.

`canUseTool` 콜백은 에이전트 프롬프트가 아니라 백엔드 옆에 존재합니다 — 이것이 우리의 하드 비토(hard-veto) 안전 경계입니다. 규칙 해석(`resolveRule`)은 사용자에게 묻기 전에 채팅별, 그다음 전역 권한 규칙을 참조합니다. [adr/0004-canusetool-policy-boundary.md](../adr/0004-canusetool-policy-boundary.md)를 참고하세요.

## 영속성

- **`better-sqlite3`**는 `<userData>/popbot.db`에 있습니다(macOS: `~/Library/Application Support/PopBot/`; Windows/Linux에서는 OS별로 동등한 `app.getPath('userData')`). 스키마는 `persistence/db.ts`에 번호가 매겨진 마이그레이션 목록으로 존재합니다(`user_version`으로 게이트되며, 각 단계는 원자적입니다). 현재 테이블:
  - `chats` — 채팅당 한 행: 슬롯 리스(`slot_id`), `worktree_path`, `repo_id`, 활성 `agent`, 프로바이더별 모델/강도 + 재개 핸들(`session_id`, `codex_thread_id`), `permission_rules`, 크로스 슬롯 상태(`p4_shelf_cl`).
  - `messages` — 에이전트 이벤트당 한 행(지속되는 트랜스크립트).
  - `repos` — 리포지토리별 설정(경로, 색상, 슬롯 접두사, 기본 베이스, 슬롯 개수, `mode` = `slots`/`ephemeral`, `scm`, `p4_config` JSON).
  - `settings` — JSON 키/값 앱 환경설정(연동 자격 증명 참조, UI 환경설정).
  - `notifications` — 앱 내 알림 피드.
  - `sdk_session_entries` — Claude SDK SessionStore 백업 테이블(채팅 키 기반; PopBot이 복구 사본을 소유하므로 재개가 `~/.claude` JSONL에 의존하지 않습니다).
  - `codex_thread_events` — 원시 Codex 스트림 이벤트의 지속되는 캐시(Codex는 `~/.codex/sessions`로부터 재개합니다. 이는 PopBot 자체의 복구/진단용 사본입니다).

  티켓/PR 캐시 *테이블*은 **없습니다**. 티켓과 리뷰 큐는 SQLite가 아니라 렌더러에서 캐시됩니다(`list-recent` IPC 코멘트 참고).
- **슬롯별 스크래치**는 슬롯의 워크트리/마운트와 채팅별 런타임 디렉터리(에이전트 CLI 세션 파일, PTY, 보관된 첨부 파일)에 있습니다. shado VHDX 슬롯은 리포지토리의 드라이브에서 `…/popbot/workspaces/<repoId>/…` 아래에 있습니다(shado 섹션 참고).
- **비밀 정보**는 `keytar`(OS 키체인 — macOS Keychain / Windows Credential Vault / libsecret)를 통합니다. SQLite DB에도, 로그에도 결코 저장되지 않습니다.

## 티켓 소스, SCM 프로바이더, 리뷰, 에디터, 업데이트

최상위 서브시스템이 걸려 있는 다섯 개의 프로바이더 이음매입니다 — 모두 백엔드 추가가 로컬화되고 호출부가 일반적으로 유지되도록 설계되었습니다.

- **티켓 소스**(`tickets/`). 하나의 활성 `TicketSource`가 `tickets/registry.ts`를 통해 `ticketSource` 설정에 의해 선택되어 티켓 큐를 채웁니다(Linear / Jira / GitHub; 기본값은 Linear). 모든 소스는 공유 Linear DTO로 정규화되므로, 렌더러는 모든 트래커를 하나의 경로로 렌더링하고 프로바이더 id가 아니라 `shared/ticketProvider.ts`의 기능(capability)에 대해서만 분기합니다. 트래커를 추가하는 것은 레지스트리에 한 줄 더하기 `*Source.ts`와 디스크립터입니다.
- **SCM 프로바이더**(`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`는 작은 공통 표면입니다(워크스페이스 생명주기, 작업 트리 리뷰, PR/리뷰 감지, 크로스 슬롯 연속성). `GitProvider`와 `PerforceProvider`는 실제이며, `lore`는 기초 작업만 되어 있습니다. `scm/index.ts`는 id당 하나의 인스턴스를 반환합니다. **호출부는 프로바이더 id가 아니라 기능(`shared/sourceControl.ts`)에 대해 분기합니다** — 깔끔하게 추상화되지 않는 것은 무엇이든 기능 플래그이며, 너무 다른 프로바이더는 `capabilities.nativeClientUi`를 통해 자신만의 클라이언트 창을 선택할 수 있습니다.
- **리뷰**(`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`). 프로바이더에 구애받지 않는 오케스트레이터가 설정된 리포지토리를 SCM별로 그룹화하고 각 프로바이더의 리뷰 메서드로 디스패치합니다(`capabilities.pullRequests`로 게이트됨). GitHub PR과 Helix Swarm 리뷰를 하나의 패널로 병합합니다. 각 프로바이더는 자신만의 **폴링 주기**(`reviewPollIntervalMs` — 공유 p4d를 보호하기 위해 GitHub보다 느린 Swarm)를 소유하며, 패널은 프로바이더당 하나의 타이머를 실행합니다(`pb:reviews:providers` / `pb:reviews:list-for`).
- **슬롯별 에디터 MCP**(`ipc/apps.ts`, `shared/gameEngine.ts`). 엔진(Unity / Unreal / 커스텀)은 독립적으로 활성화 가능합니다. `useMcp`가 켜져 있으면, 각 슬롯의 에디터는 병렬 에디터들이 충돌하지 않도록 **슬롯별 MCP 포트**(`mcpBasePort + (slotId-1)`)로 실행되며, `mcpEndpointForChat`은 생성 시 에이전트에게 그 슬롯의 에디터 MCP HTTP URL을 건네줍니다. 에디터는 **분리된(detached)** 상태로 실행되며(포커스 또는 실행), 감독되는 장수 자식 프로세스가 아닙니다.
- **업데이트**(`updates/`). 서명되지 않은 빌드를 위한 수동 다운로드 폴백이 있는 electron-updater 자동 업데이트와, About 대화상자를 위한 온디맨드 확인(`pb:updates:*`).

## 횡단 관심사

- **로깅** — main은 `diagLog`(`dlog`)를 통해 진단 로그를 씁니다. 에이전트 CLI와 PTY는 자신만의 채팅별 런타임 출력을 가지며, 렌더러 로그는 IPC를 통해 main으로 라우팅됩니다.
- **시작 복구** — 복구는 PID 파일 기반이 아니라 DB와 세션 주도적입니다(`main/index.ts` 부팅 시퀀스): `initDb()`가 대기 중인 마이그레이션을 실행합니다. `clearStaleRunningStatuses()`는 `run` 상태로 남아 있는 모든 채팅을 `idle`로 되돌립니다(이전 실행의 에이전트 세션은 사라졌으므로). 세션 스토어 임포트 + SDK 프로젝트 디렉터리 마이그레이션 + `sessionPinRepair` + `recoverChatSessions`는 고정된 Claude/Codex 세션을 실제 디스크 내용과 대조하여 조정합니다. CLI 프로브는 어떤 백엔드가 온라인 상태인지 보고합니다. Windows에서는, 연결이 끊긴 shado VHDX 슬롯(재부팅으로 마운트가 끊긴 경우)이 감지되어 하나의 UAC로 다시 마운트하도록 표시됩니다(위의 shado **재부팅** 노트 참고).
- **업데이트** — electron-updater 자동 업데이트. 위의 **업데이트** 프로바이더를 참고하세요.
