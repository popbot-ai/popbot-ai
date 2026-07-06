# 핵심 모델

PopBot 앱이 세워진 객체 그래프입니다. 그 외 모든 것 — IPC,
영속성, UI 패널, 에이전트 루프 — 은 이것에 걸려 있습니다. 여기 있는 규칙을
위반하는 방식으로 동작을 바꾼다면, **먼저 모델을 업데이트하거나 모델이
바뀌고 있다고 사용자에게 알리세요.**

"코드가 어디 있는가?"에 대해서는 [ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.
"사용자가 무엇을 보는가?"에 대해서는 [USER_STORIES.md](USER_STORIES.md)를 참고하세요.

---

## 요약 — 중요한 네 개의 명사

| 명사 | 지속되는가? | 소유자 | 수명 |
|---|---|---|---|
| **Chat** | 예 (SQLite) | main | 사용자에 의해 생성되며, 명시적으로 삭제될 때까지 존재 |
| **Message** | 예 (SQLite, 거의 추가 전용) | main | Chat의 자식 |
| **Slot** | 예 (파일 시스템 + SQLite 행) | main / `SlotManager` | 드물게 생성되며 재사용됨; 채팅별로 생성되지 않음 |
| **AgentSession** | **아니오** (메모리에만 존재) | main / `AgentHost` | Chat이 "실행 중" 상태가 될 때 생성되며; Chat이 닫히거나 앱이 종료될 때 폐기 |

렌더러의 모든 것은 이들에 대한 **뷰**입니다. 렌더러는 결코
정본 상태(canonical state)를 소유하지 않습니다.

---

## 지속되는 명사 (재시작 후에도 살아남음)

### Chat

사용자의 작업 단위입니다. 하나의 티켓, 하나의 PR 리뷰, 하나의 Slack 스레드, 하나의
"코드베이스를 둘러보는" 세션 — 각각이 하나의 Chat입니다.

```ts
interface ChatRecord {
  id: string;                                // chat_<12hex>
  name: string;                              // "ENG-20512 · ability cooldown"
  ticket: string | null;                     // "ENG-20512"
  pr: number | null;                         // 7401
  branch: string | null;                     // git branch this work targets
  type: 'lite' | 'client_test' | 'server_test';
  mode: 'interactive' | 'autonomous';
  agent: 'claude' | 'codex';
  status: ChatStatus;                        // see lifecycle below
  snippet: string;                           // last agent prose (cached for thumbnail)
  tokensUsed: number;
  tokensBudget: number;
  createdAt: number;
  lastActiveAt: number;
  closedAt: number | null;                   // null = open
}
```

**상태 생명주기**(US-6 — 썸네일을 무슨 색으로 칠할지):

```text
              ┌──────────────┐
              │   idle (○)   │ ← initial state, no agent attached
              └──────┬───────┘
        send/respawn │
              ┌──────▼───────┐
              │  running (▶) │ ── error ──→  errored (✗)
              └──┬───────┬───┘
   needs review │       │ message-end + no work pending
              ┌─▼─────┐ │
              │paused │ │
              │  (?)  │ │
              └──┬────┘ │
       resolve   │      │
              ┌──▼──────▼─────┐
              │ complete (✓)  │
              └───────────────┘
```

**상태는 규범적이 아니라 서술적입니다** — 하나가 붙어 있을 때
AgentSession으로부터 도출되며, 전환 시 DB에 저장됩니다. 채팅이 `idle`이라는
것은 "지금 당장 작업을 하고 있는 에이전트가 없다"는 뜻입니다. "채팅이
닫혀 있다"는 뜻이 아닙니다.

**열림 대 닫힘:** 채팅은 `closedAt IS NULL`일 때만 "열려" 있습니다. 열린 채팅은
시작 시 메모리에 로드되며, 닫힌 채팅은 쿼리 전용입니다. **채팅을 닫으면
슬롯 리스를 해제하고 AgentSession을 폐기하지만 Message를 결코
삭제하지 않습니다.**

### Message

Chat 내부의 거의 추가 전용인 이벤트 로그입니다. 트랜스크립트는 타입이 지정된
레코드들의 시퀀스입니다.

```ts
interface MessageRecord {
  id: string;                                   // msg_<12hex>
  chatId: string;
  role: 'user' | 'agent' | 'system';
  kind: 'text' | 'tool' | 'permission' | 'system';
  body: string;                                 // JSON-encoded payload (shape per kind)
  createdAt: number;
  updatedAt: number;
}
```

**왜 `body`가 JSON인가?** 각 kind는 서로 다른 페이로드 형태(텍스트 대
도구 호출 대 권한 요청)를 가지며 렌더러는 `kind`에 따라 분기합니다.
타입이 지정된 JSON 블롭으로 저장하면 테이블은 평평하게, 렌더러 코드는
정직하게 유지됩니다.

**"거의 추가 전용":** `tool`과 `permission` 행은 **한 번** 변경됩니다.

- `tool` 행: `tool-use`에서 작성되고(이름 + 인자), `tool-result`에서
  업데이트됨(`result` + `isError`를 채움).
- `permission` 행: `permission-request`에서 작성되고(도구 + 인자 + 이유),
  사용자 결정 시 업데이트됨(`decision`을 설정).
- `text` 행: 빈 텍스트로 `message-start`에서 작성되고, `text-delta`
  이벤트가 도착할 때마다 작은 메모리 내 버퍼에서 **병합**되며, `message-end`에서
  플러시됩니다(렌더러를 실시간으로 유지하기 위해 ~250ms마다도). "에이전트
  텍스트 턴"당 하나의 행이지, 델타당 하나의 행이 아닙니다.

**에이전트 작업 롤백으로 인한 연쇄 삭제는 없습니다.** 에이전트가
실수를 하고 "다시 시도"하게 만들고 싶다면, 새 사용자 메시지를 보냅니다. 예전
트랜스크립트는 그대로 남습니다. 모델은 결코 히스토리를 조용히 다시 쓰지 않습니다.

### Slot

웜하고 격리되고 폐기 가능한 워크스페이스입니다: 카피-온-라이트 폴더 위의
격리된 체크아웃(Git 워크트리, 또는 Perforce 클라이언트) + 웜 빌드
캐시(예: 엔진의 에셋/임포트 캐시) + (선택적으로) 테스트 대상 앱(Unity,
Unreal, 또는 커스텀 엔진)을 위한 실행 중인 에디터 + (선택적으로) 실행 중인
사이드카 서버. **드물게 생성되며, 계속 재사용됩니다.** 슬롯은 Chat이 아니라
사용자/앱이 소유합니다.

```ts
interface SlotRecord {
  id: number;                                   // slot-1, slot-2, ...
  worktreePath: string;
  branch: string | null;                        // null if free / detached
  ports: { mcp: number; server: number };
  unityPid: number | null;                      // editor PID; refreshed via PID liveness
  serverPid: number | null;
  state: 'free' | 'leased' | 'degraded' | 'creating';
  pinnedBranch?: string;                        // refuse leases for other branches
  cleanOnRelease?: boolean;
  leasedByChatId?: string;                      // soft pointer; a Chat → Slot binding
  lastLeaseAt?: number;
}
```

**Slot ↔ Chat 바인딩**은 **일시적**입니다 — `slot.leasedByChatId`와
해당 Chat의 런타임 메타데이터에 존재합니다. 시작 시 우리는 슬롯을 순회하며
열린 채팅과 대조하여 이를 조정합니다. 오래된 리스(채팅이
닫혔지만 리스가 해제되지 않은 경우)는 정리됩니다.

전체 슬롯 생명주기는 [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#슬롯--지속되는-단위)를 참고하세요.

### Permission grant

재프롬프트 없이 특정 도구/대상 조합이 승인되었다는 지속되는 사용자
결정입니다. 두 범위:

```ts
interface PermissionGrant {
  id: string;                                   // grant_<12hex>
  scope: 'global' | 'chat';
  chatId: string | null;                        // non-null iff scope='chat'
  tool: string;                                 // exact tool, e.g. 'Bash', 'git_push', 'mcp__linear__save_issue',
                                                //   OR a trailing-`*` wildcard, e.g. 'mcp__unrealEditor__*'
  /** Optional refinement: 'Bash' tool restricted to commands matching this prefix. */
  argMatcher: string | null;                    // raw string OR /regex/ — TBD
  decision: 'allow' | 'deny';
  createdAt: number;
}
```

`tool`은 후행 `*` 와일드카드일 수 있으므로, 전체 MCP 서버를
하나의 승인으로 허용할 수 있습니다(`allow-mcp-server` → `mcp__<server>__*`) — 이것이
슬롯의 에디터 MCP가 도구마다가 아니라 한 번에 허용되는 방식입니다. 거부
규칙은 항상 허용을 이기며, 더 구체적인 패턴이 더 넓은 패턴을 이깁니다
(`src/shared/agent.ts`의 `resolvePermissionRules` 참고).

승인은 채팅별로 누적됩니다(US-9: "이 채팅에 대해 git push를 항상 허용").
[adr/0004](../adr/0004-canusetool-policy-boundary.md)의 하드코딩된 **거부 규칙**은
여기에 저장되지 않습니다 — 코드에 존재하며 재정의할 수 없습니다.

### Settings

두 개의 레이어:

- **전역 환경설정**: 테마, 기본 채팅 타입, 슬롯 개수, 마스터 Library
  갱신 주기 등. 한 행짜리 테이블.
- **채팅별 재정의**: 서버 모드, 시간 배율, 창 모드, 토큰
  예산 등. `chatId`로 키가 매겨진 `chat_settings` 테이블에 저장됨.

둘 다 비어 있을 수 있습니다(기본값이 적용됨). 렌더러의 설정 패널을 통해
변경됩니다.

### Cached attention items

사용자의 할당된 티켓(Linear / Jira / GitHub Issues) 큐와
대기 중인 리뷰(GitHub PRs / Helix Swarm changelists) 큐입니다. 패널이 즉시
렌더링되도록 로컬에 캐시되며, 일정에 따라 그리고 필요에 따라 새로고침됩니다.

```ts
interface AttentionItem {
  id: string;                                   // source-prefixed: linear:ENG-20512, jira:ENG-123, gh:7401, swarm:1284
  source: 'linear' | 'jira' | 'github' | 'swarm';
  /** Source-specific raw payload, JSON. */
  payload: string;
  /** Local UI-state: have I dismissed this? Is there a chat already open for it? */
  dismissedAt: number | null;
  spawnedChatId: string | null;
  fetchedAt: number;
}
```

티켓 소스는 공통 프로바이더(Linear, Jira, GitHub Issues) 뒤에서 서로
교체 가능합니다. 리뷰 소스도 마찬가지입니다(GitHub PRs, Swarm). 캐시된
것이지 권위 있는 것이 아닙니다 — 진실 공급원은 트래커/리뷰 시스템
자체입니다.

---

## 런타임 명사 (메모리에만 존재; 재시작 후 살아남지 않음)

### AgentSession

LLM과 이야기하는 것입니다. "실행 중"인 Chat당 하나의 AgentSession입니다.
`AgentBackend`(Claude Agent SDK 또는 Codex SDK; 둘 다 오늘 제공됩니다)로
뒷받침됩니다.

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**`AgentHost`가 소유합니다**(main 프로세스의 싱글턴). AgentHost는
`Map<chatId, AgentSession>`을 보유합니다. 세션은 채팅에 대한 첫
`agent.send`에서 지연 생성되며 채팅이 닫힐 때 폐기됩니다.

**세션은 `AgentEvent`를 발생시킵니다**(`src/shared/agent.ts` 참고). AgentHost는
모든 이벤트를 가로채서:

1. **저장합니다**(델타는 텍스트 행으로 병합되고, tool-use는
   도구 행을 만들고, permission-request는 권한 행을 만듭니다).
2. `webContents.send`를 통해 렌더러로 **다시 방송합니다**. 렌더러는
   N개 구독자 중 하나이며, main이 권위 있는 기록자입니다.
3. **Chat 메타데이터를 업데이트합니다** — 이벤트가 도착함에 따라 `status`,
   `snippet`, `tokensUsed`, `lastActiveAt`이 갱신됩니다.

**세션은 결코 DB에 직접 쓰지 않습니다.** AgentHost만 씁니다. 이는
영속성 스키마의 진화를 백엔드 교체와 분리된 상태로 유지합니다.

### Permission request (진행 중)

SDK의 `canUseTool` 콜백이 발동할 때:

1. PolicyEngine이 평가합니다: 하드 허용(자동), 하드 거부(자동), 또는 사용자에게 묻기.
2. "사용자에게 묻기"라면, AgentHost는 렌더러에 `permission-request` 이벤트를
   발생시키고 **SDK 콜백을 대기시킵니다** — `permissionId`로 키가 매겨져 —
   대기 중인 맵에.
3. 렌더러가 모달을 보여줍니다. 사용자가 결정을 클릭합니다. IPC가 main으로 돌아갑니다.
4. AgentHost는 대기 중인 콜백을 찾아 이를 해결합니다. SDK가 진행하거나
   중단합니다.
5. "이것을 항상 허용"이 체크되었다면, `PermissionGrant` 행을 씁니다.

대기 중인 요청은 **저장되지 않습니다**. 결정 도중 앱이 충돌하면,
에이전트의 도구 호출은 재시작 시 취소됩니다.

### Process supervisor handles

슬롯당: 테스트 대상 앱 에디터(Unity / Unreal / 커스텀 엔진 — `unityPid`
필드는 엔진과 관계없이 그 PID를 기록합니다)를 위한 `child_process.ChildProcess`,
사이드카 서버를 위한 또 다른 것. `SlotManager`가 소유합니다. PID
생존 여부 + HTTP 프로브를 통해 헬스 체크됩니다. 슬롯 해제 / 앱 종료 시
죽입니다. 슬롯 디렉터리의 `slot.json`을 순회하고 기록된 PID가 여전히
살아있는지 검증하여 **시작 시 조정됩니다**.

---

## 소유권 규칙

이것들은 **불변식**입니다. 이를 위반하는 코드는 버그입니다.

1. **렌더러는 순수한 뷰입니다.** fs도, child_process도, DB 접근도 없습니다. 타입이
   지정된 `window.popbot.*` 브리지를 통해서만 main과 이야기합니다.

2. **main만이 DB에 쓸 수 있는 유일한 존재입니다.** 렌더러는 IPC를 통해 읽습니다. 절대
   `popbot.db`를 건드리지 않습니다.

3. **세션 도중 Chat의 status/snippet/토큰을 변경할 수 있는 것은
   AgentHost뿐입니다.** 다른 코드는 이 필드들을 읽을 수는 있지만 그 채팅에
   세션이 활성 상태인 동안에는 쓸 수 없습니다.(이름 변경 같은 사용자 주도
   변경은 세션이 활성 상태가 아닐 때 일어나거나, 큐에 쌓입니다.)

4. **백엔드는 결코 DB에 쓰지 않습니다.** 이벤트를 발생시키고, AgentHost가
   저장합니다. 이는 ClaudeBackend / CodexBackend / StubBackend를
   DB 스키마 결합 없이 서로 교체 가능하게 유지합니다.

5. **PolicyEngine이 "이 도구가 실행되어도 되는가?"에 대한 단일 진실 공급원입니다.**
   어떤 백엔드도 이를 우회하지 않습니다. 권한 승인은 이를 거쳐 흐릅니다.

6. **Slot ↔ Chat 바인딩은 일시적입니다.** Chat 레코드는 결코 슬롯의
   이름을 명명하지 않습니다. Slot 레코드가 리스를 보유한 채팅의 이름을
   명명합니다(소프트 포인터, 시작 시 조정됨).

7. **트랜스크립트는 결코 조용히 변경되지 않습니다.** 새 행을 추가합니다. 도구/권한
   행에 대한 일회성 업데이트는 명시적이고 제한적입니다.

---

## 상태 흐름 — 하나의 사용자 메시지, 처음부터 끝까지

모델이 작동하는 모습을 보여주는 실제 예시입니다.

```text
User types "fix the cooldown flicker" in chat c1 and presses ⌘↵
  │
  ▼
Renderer: api.agent.send({ chatId: 'c1', text })
  │  IPC: pb:agent:send
  ▼
Main · AgentHost.send('c1', text)
  ├─→ DB: appendMessage({ chatId, role: 'user', kind: 'text', body: { text } })
  ├─→ DB: updateChatStatus('c1', 'running', snippet=text.slice(0,140))
  ├─→ webContents.send('pb:agent:event', { type: 'message-start', ..., role: 'user' })
  └─→ session.sendUser(text)            // AgentSession (Claude SDK)
        │
        │  SDK streams events back via the onEvent callback wired at spawn:
        │
        ├─→ { type: 'message-start', role: 'agent', messageId: 'msg_abc' }
        │     ├─→ DB: appendMessage({ id: 'msg_abc', kind: 'text', body: { text: '' } })
        │     └─→ webContents.send → renderer appends an empty agent message bubble
        │
        ├─→ { type: 'text-delta', messageId: 'msg_abc', delta: 'Looking at ' }
        │     ├─→ buffer.append('msg_abc', 'Looking at ')      // in-memory
        │     │     (flush every 250ms or on message-end → DB UPDATE)
        │     └─→ webContents.send → renderer concatenates into the bubble
        │
        ├─→ { type: 'tool-use', messageId: 'msg_abc', toolUseId: 't1',
        │     name: 'unity.run_fixture', args: {...} }
        │     ├─→ PolicyEngine.evaluate('unity.run_fixture', args)  → 'allow' (whitelisted)
        │     ├─→ DB: appendMessage({ id: 'tool_t1', kind: 'tool',
        │     │                        body: { toolUseId, name, args } })
        │     └─→ webContents.send → renderer renders tool row
        │
        ├─→ { type: 'tool-result', toolUseId: 't1',
        │     text: '3/3 ok · 14.2s', isError: false }
        │     ├─→ DB: updateMessageBody('tool_t1', { ...prev, result, isError })
        │     └─→ webContents.send → renderer updates tool row badge
        │
        ├─→ { type: 'permission-request', permissionId: 'p1',
        │     tool: 'git_push', args: { ref: '...' }, reason: 'back up progress' }
        │     ├─→ PolicyEngine.evaluate('git_push', args)   → 'ask'
        │     ├─→ AgentHost.pendingPermissions.set('p1', sdkCallback)
        │     ├─→ DB: appendMessage({ id: 'perm_p1', kind: 'permission',
        │     │                        body: { permissionId, tool, args, reason } })
        │     ├─→ DB: updateChatStatus('c1', 'paused', snippet='needs you: ...')
        │     └─→ webContents.send → renderer shows PermissionModal
        │
        │  ┌─── user clicks "Allow once" in the modal ───────────────────────┐
        │  ▼                                                                  │
        │  Renderer: api.agent.approve({ chatId: 'c1', permissionId: 'p1', │
        │                                 decision: 'allow' })                │
        │   │  IPC: pb:agent:approve                                          │
        │   ▼                                                                  │
        │  Main · AgentHost.approve('c1', 'p1', 'allow')                      │
        │     ├─→ DB: updateMessageBody('perm_p1', { ...prev, decision })     │
        │     ├─→ DB: updateChatStatus('c1', 'running')                       │
        │     ├─→ pendingPermissions.get('p1')(true)   // resolves SDK        │
        │     └─→ webContents.send → renderer dismisses modal                 │
        │
        ├─→ { type: 'message-end', messageId: 'msg_abc' }
        │     ├─→ buffer.flush('msg_abc')      → DB UPDATE final text
        │     └─→ webContents.send → renderer freezes the bubble
        │
        └─→ { type: 'session-status', status: 'idle' }
              ├─→ DB: updateChatStatus('c1', 'idle')
              └─→ webContents.send → renderer thumbnail goes from blue to gray
```

주목할 두 가지:

- **렌더러는 결코 아무것도 결정하지 않습니다.** 의도를 전달하고
  이벤트로부터 다시 렌더링합니다.
- **DB 쓰기는 렌더러 알림과 같은 위치에서 일어납니다.** 둘은 AgentHost의
  같은 핸들러에 묶여 있습니다. 이는 렌더러 충돌이 영속성 드리프트를
  일으킬 수 없음을 의미합니다.

---

## 복구 흐름 — 콜드 상태에서 재시작

코드로 표현된 US-7입니다. 앱이 비정상적으로 종료됩니다. 몇 시간 뒤, 사용자가 다시 엽니다.

1. **DB 초기화** — `initDb()`가 `popbot.db`를 열고, 대기 중인 마이그레이션을 실행합니다.
2. **슬롯 조정** — `~/Library/Application Support/PopBot/slots/`를 순회하며,
   각 슬롯에 대해 `slot.json`을 읽고, `unityPid` / `serverPid`가
   살아있는지 검증합니다(`kill -0`). 죽었다면 슬롯을 free로 표시하고 PID를
   지웁니다. 고아가 된 리스(존재하지 않는 채팅, 또는 `closedAt`이
   설정된 채팅)를 해결합니다.
3. **열린 채팅** — `listOpenChats()`는 `closedAt IS NULL`인 채팅을,
   `lastActiveAt DESC`로 정렬하여 반환합니다. 렌더러는 첫 페인트에서 이를 요청합니다.
4. **자동 에이전트 생성 없음.** 세션은 첫 `agent.send`에서 지연 생성됩니다.
   사용자가 예전 채팅을 열면 그냥 트랜스크립트만 보이며, 사용자가
   프롬프트할 때까지 에이전트는 멈춘 곳에서 다시 시작하지 않습니다.
5. **필요 시 슬롯 리스.** 마찬가지로, 채팅 타입이 이를
   필요로 할 때(Client/Server Test) 그리고 Unity가 필요한 도구가 발동하려는
   참일 때 리스가 일어납니다.

결과: 앱을 여는 것은 빠르며(DB 읽기 + 슬롯 핑), 에이전트 생성
비용을 지불하지 않고도 어떤 채팅의 히스토리든 살펴볼 수 있습니다.

---

## 백엔드 상호 교체 가능성

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend**는 `@anthropic-ai/claude-agent-sdk`를 감쌉니다. 기본값입니다.
- **CodexBackend**는 `@openai/codex-sdk`(`codex exec`를 구동함)를 감쌉니다.
  제공됩니다. 각 백엔드는 자신의 `capabilities`를 알리며 UI는
  채팅별로 이를 기능 감지합니다.
- **StubBackend**는 가짜 스트림으로 사용자 텍스트를 반향합니다. 배선
  검증 + UI 테스트에 사용됩니다.

채팅 레코드의 `agent` 필드가 AgentHost가 생성할 백엔드를 선택합니다.

---

## 의도적으로 모델에 없는 것

- **워크플로 / DAG / 승인 체인.** 채팅은 대화입니다. 우리는
  파이프라인을 모델링하지 않습니다.
- **멀티 유저.** 기기당 단일 개발자; 인증 없음, 공유 없음.
- **노트북 / 저장된 쿼리 / 템플릿.** 모두 트랜스크립트로부터
  자연스럽게 나오는 것들이며; 아직 1급 타입이 없습니다.
- **버전이 매겨진 채팅 스냅샷 / 분기하는 트랜스크립트.** 트랜스크립트는
  선형입니다. 채팅을 포크하는 것 = 예전 것의 히스토리로부터 채워진 새 채팅을
  만드는 것(향후 기능이며, 오늘의 모델에는 없습니다).

이것들 중 하나가 필요해진다면, 여기에 먼저 추가된 뒤 코드에 추가됩니다.
