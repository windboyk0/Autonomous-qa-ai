# Autonomous QA 시스템 — 업무 분석 결과 (analyResult)

> 이 문서는 `CLAUDE.md`(정본 스펙)·`ROADMAP.md`(Phase 순서)·`.claude/agents/*.md`(역할 정의)·
> `packages/shared/src/*.ts`(데이터 계약)·`packages/fixture-*`(채점 정답지)와 **실제 소스 코드**를
> 대조 분석해, 이 프로젝트가 실제로 수행하는 업무를 프로그램 명세 수준으로 정리한 것이다.
> 각 업무는 `API 기능 / Source / 업무 Flow` 3단으로 기술하며, 문서(CLAUDE.md)와 코드가
> 어긋나는 지점은 "정책 대비 편차"로 별도 표기했다.
>
> 분석 시점: 2026-09-15, 브랜치 `windboyk0/analy-task` (최근 커밋: `883c8e0`, 1.0.8 이후).

---

## 0. 한눈에 보기

**만드는 것**: Windows에 설치하는 Electron 기반 자율 QA 도구. 사용자가 URL/계정/AI Provider/CRUD 범위만
입력하면 Playwright가 관리자웹을 자율 탐색하며 증적을 모으고, `report.md`+`issues.json`을 만든다.

**4가지 실행 모드** (`RunConfig.mode`, `packages/shared/src/run-config.ts:115,204-272`):

| 모드 | 입력 | 답하는 질문 | 담당 |
|---|---|---|---|
| `runtime` (실행 QA) | URL + 계정 | 화면이 실제로 동작하는가 | 업무3~9 |
| `source` (소스 QA) | 프로젝트 폴더 | 코드에 무엇이 빠져 있는가 | 업무10~11 |
| `integrated` (통합 QA) | 폴더 + URL + 계정 | 어느 파일 몇 번째 줄을 고쳐야 하는가 | 업무1 + 10 + 11 결합 |
| `app` (앱 QA) | Android 패키지명 | 앱 화면이 실제로 동작하는가 | 업무13 |

Change Impact(§업무11)는 별도 모드가 아니라 위 모드 위에 얹는 **범위 한정기**다.

**저장소 구조**:
```
packages/shared/      데이터 계약 (zod) — RunConfig·PageState·Action·Evidence·Issue·EngineEvent
packages/qa-engine/    QA 엔진 본체 — cli.ts 진입점, run.ts Run 본체, 기능별 모듈
packages/fixture-admin/ 정답을 아는 목 관리자웹 (실행 QA 채점용, 의도적 버그 10건)
packages/fixture-src/  정답을 아는 목 소스 프로젝트 (소스 QA 채점용, 의도적 버그 12건)
apps/desktop/          Electron 셸 — 엔진을 자식 프로세스로 띄우고 이벤트를 중계
mobile/                앱 QA의 원형 Python 프로토타입(explore.py, 현재는 TS로 대체됨)
```

**업무 목차**:

| # | 업무 | 핵심 파일 위치 |
|---|---|---|
| 1 | QA Run 생애주기 오케스트레이션 | `qa-engine/src/{cli,run,control,run-context,emitter,collector,browser}.ts` |
| 2 | 로그인 자동화 및 세션 유지 | `qa-engine/src/login.ts` |
| 3 | 자율 탐색(웹) — 상태지문·액션발견·위험분류·예산 | `qa-engine/src/{fingerprint,discover,classify,explorer,normalize}.ts` |
| 4 | CRUD 쓰기 테스트 및 테스트 데이터 관리 | `qa-engine/src/{forms,testdata,crud}.ts` |
| 5 | 증적 수집(Evidence) | `qa-engine/src/capture.ts` |
| 6 | 결함 검출(Console/Network/Visual 룰 기반) | `qa-engine/src/{visual,detect}.ts` |
| 7 | Issue 판정(Dedup·Severity·Priority) | `qa-engine/src/judge.ts`, `shared/src/issue.ts` |
| 8 | 리포트 생성(report.md/issues.json) | `qa-engine/src/report.ts` |
| 9 | AI Provider 추상화 및 AI 보강 | `qa-engine/src/ai/*.ts` |
| 10 | 소스 QA — 정적 분석·시크릿 정책·권한검사 누락 | `qa-engine/src/source/{scan,rules,secrets,security-config,endpoints}.ts` |
| 11 | API↔소스 매핑 및 Change Impact QA | `qa-engine/src/source/{api-map,change-impact,run-source,strip}.ts` |
| 12 | 빌드/테스트 동의 기반 실행 | `qa-engine/src/source/build-test.ts` |
| 13 | 앱(모바일) QA — Android 자율 탐색 | `qa-engine/src/app/{adb,classify-app,detect-app,driver,explorer,observe,preflight}.ts` |
| 14 | Electron 데스크톱 셸 — 프로젝트관리·설정·모니터링·자격증명 | `apps/desktop/electron/*.ts`, `apps/desktop/src/*` |

---

## 업무 1 — QA Run 생애주기 오케스트레이션

**개요**: CLI 인자 파싱부터 `report.md` 생성까지 Run 1회의 전체 생애주기를 지휘한다. 모드별(runtime/source/app)로
분기해 필요한 자원만 준비하고, pause/resume/stop 제어와 AI 실패 흡수, 증적 인덱스 보존까지 여기서 보장한다.

### API 기능

| 기능 | 시그니처 | 위치 |
|---|---|---|
| CLI 진입점 | `main(): Promise<void>` | `cli.ts:219` |
| 인자→설정 변환 | `buildConfig(args: RawArgs, password: string): RunConfig` | `cli.ts:129` |
| 비밀번호 확보 | `resolvePassword(args): Promise<{password, warning}>` — env → stdin → `--pass`(경고) 순 | `cli.ts:109` |
| Run 본체(최상위 디스패처) | `runQa(config: RunConfig, ctx: RunContext, options?): Promise<RunOutcome>` | `run.ts:502` |
| 앱 전용 파이프라인 | `runAppOnly(config, ctx, startedAt, options): Promise<RunOutcome>` | `run.ts:319` |
| 소스 전용 파이프라인 | `runSourceOnly(config, ctx, startedAt, options): Promise<RunOutcome>` | `run.ts:443` |
| AI 사전점검(탐색 전) | `preflightAi(config, makeProvider): Promise<AiReady \| null>` | `run.ts:245` |
| AI 보강(실패 흡수) | `enrichWithAi(input): Promise<EnrichResult>` | `run.ts:101` |
| 미검증 영역 산출 | `unverifiedAreas(results, config): string[]` | `run.ts:56` |
| 제어 채널 | `class RunControl { listen(); apply(cmd); waitIfPaused(); stopped; isPaused }` | `control.ts:22,53,104` |
| 출력 창구(유일) | `emit(event: EngineEvent)`, `log(level, message)`, `registerSecret()`, `scrub()` | `emitter.ts:16,21,27,32` |
| 증적/파일 창구(유일) | `class RunContext { writeText; writeJson; addEvidence; writeReport; writeIssues; saveEvidenceIndex }` | `run-context.ts:23-112` |
| 브라우저 기동 | `launch(config): Promise<BrowserSession>`, `preflightBrowser(): Promise<{ok,remediation}>` | `browser.ts:64,94` |
| 콘솔/네트워크 수집 | `class Collector { attach(page); drain(screen) }` | `collector.ts:63,189` |

### Source
`packages/qa-engine/src/cli.ts` · `run.ts` · `control.ts` · `run-context.ts` · `emitter.ts` · `collector.ts` · `browser.ts`
`packages/shared/src/events.ts`(EngineEvent/EngineCommand 계약) · `run-config.ts`(RunConfig 스키마)

### 업무 Flow

1. **인자 파싱·모드 결정**: `main()`(`cli.ts:219`) → `parseArgs`(`cli.ts:220`). 모드는 별도 플래그가 아니라
   입력값으로 자동 추론된다 — `package`값 있으면 `app`, `url && sourceDir`면 `integrated`, `url`만 있으면
   `runtime`, 그 외 `source`(`cli.ts:140-146`).
2. **사전 상태조회 분기**(선택): `--app-status`/`--claude-status`면 여기서 즉시 종료(`cli.ts:237,248`).
3. **비밀번호 확보·마스킹 등록**: `resolvePassword`(`cli.ts:273`) → `registerSecret`(`cli.ts:277`) — 이후
   모든 로그·리포트·이벤트에서 이 값이 `***REDACTED***`로 치환된다.
4. **RunConfig 확정**: `buildConfig` zod 파싱(`cli.ts:154-206`), `--delete`는 `--delete-consent` 없이 거부(`cli.ts:280-283`).
5. **RunContext 생성**: `runId`(`YYYYMMDD_HHMMSS`) 및 하위 디렉터리(`screenshots/dom/aria/network/console/actions/source`) 생성(`run-context.ts:23-27`), `run:status RUNNING` emit.
6. **제어채널 개시**: `RunControl.listen()` — TTY면 구독 안 함, stdin `unref()`로 부모(Electron) 파이프가 열려 있어도 프로세스 종료 가능(`control.ts:22-38`).
7. **`runQa()` 진입**(`run.ts:502`): source→`runSourceOnly`, app→`runAppOnly`로 조기 분기(`run.ts:515,520`). 이하 runtime/integrated 경로:
8. **브라우저 사전점검+기동**: `preflightBrowser`→`launch`→`Collector.attach`(`run.ts:524-532`).
9. **로그인**: 비밀번호 입력 전 화면 캡처 → `login()` 실행 → 실패 시 즉시 FAILED(`run.ts:547-579`).
10. **AI 사전점검**: 탐색 **전**에 확정해 Monitor에 즉시 반영(`run.ts:585`).
11. **Change Impact 계산**(선택): 탐색 순서 힌트로만 사용(`run.ts:589`).
12. **자율 탐색**: `Explorer.explore()` → `graph.json` 저장(`run.ts:590-600`).
13. **CRUD 쓰기 테스트**: **탐색 완료 후에만** 실행 — 쓰기가 상태지문 결정성을 흔들지 않도록(`run.ts:620-624`).
14. **소스 QA 병행**(integrated 전용): `runSourceQa()`(`run.ts:637-640`).
15. **Issue 확정**: `judge()`가 탐색+CRUD+소스 candidates를 통합 dedup(`run.ts:641-648`).
16. **API→소스 매핑**(integrated): `attachCodeRefs()` — AI 보강보다 먼저 수행(`run.ts:657-673`).
17. **AI 보강**: `enrichWithAi()` — 실패해도 절대 throw하지 않음(`run.ts:677-684`).
18. **이벤트 배출·요약·리포트**: `issue:found` emit(각 이슈) → `buildSummary()` → `renderReport()` → `writeReport/writeIssues` → `run:finished` emit(`run.ts:686-736`).
19. **정리(finally, 항상 실행)**: 브라우저 세션 close, `saveEvidenceIndex()` — **중단/실패에도 evidence.json은 항상 남는다**(`run.ts:747-753`).
20. **CLI 종료**: 최종 `run:status` emit, FAILED면 `exitCode=1`(`cli.ts:310-318`).

전 구간에서 `RunControl.waitIfPaused()`가 액션 실행 직전마다 체크되며, stop 시에도 지금까지 모은
증적으로 15~19단계가 그대로 진행되어 리포트가 생성된다(`control.ts:11-12,104-108`).

---

## 업무 2 — 로그인 자동화 및 세션 유지

**개요**: 관리자웹 로그인 폼을 자동 탐지해 로그인을 수행하고, 신호 기반으로 성공/실패를 판정한다.
탐색 중 세션이 끊기면 같은 로직으로 재로그인한다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 세션 끊김(로그인폼 재노출) 감지 | `hasLoginForm(page): Promise<boolean>` | `login.ts` |
| 로그인 실행 | `login(page, config: LoginConfig, targetUrl): Promise<LoginResult>` | `login.ts:89` |

### Source
`packages/qa-engine/src/login.ts`

### 업무 Flow
1. username/password/submit 셀렉터는 설정값 우선, 없으면 후보 목록에서 첫 visible 요소를 자동 탐지(`login.ts:66-87`).
2. 판정 신호 4가지 수집: `authOk`/`authRejected`(인증 API 응답 status), `urlChanged`, `formGone`, `newCookie`, `newStorage`(`login.ts:39,132-141,272-307`).
3. 판정 우선순위: ① `authRejected` → 즉시 FAIL. ② `authOk` → SUCCESS. ③ 인증 요청을 못 봤으면 4개 신호 중 2개 이상 충족 시 SUCCESS(`login.ts:210-262`).
4. 토큰 저장소는 **키만** 읽고 값은 읽지 않음(`login.ts:271`) — §16-1 "시크릿 값 미읽음" 원칙과 일치.
5. 탐색 중 `hasLoginForm()`으로 세션 끊김을 감지하면 explorer가 동일 로직으로 재로그인(`explorer.ts` `ensureSession`, `run-config.ts:77` `reloginOnSessionLoss`).

---

## 업무 3 — 자율 탐색(웹): 상태지문·액션발견·위험분류·예산

**개요**: 단순 링크 크롤러가 아니라 "PAGE → ACTION DISCOVERY → RISK CLASSIFICATION → EXECUTION →
STATE CHANGE DETECTION → NEW STATE" 상태기반 루프(§12)로 화면을 훑는다. 이 시스템의 핵심 엔진.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 상태 신호 계산 | `computeSignals(page): Promise<StateSignals>` | `fingerprint.ts` |
| 상태 지문(sha1) | `stateKeyOf(signals): string` | `fingerprint.ts:155-166` |
| 상태 읽기 | `readState(page, depth, arrivedByActionId): Promise<PageState>` | `fingerprint.ts:168` |
| 액션 발견 | `discoverActions(page, state, policy): Promise<DiscoveredAction[]>` | `discover.ts:138` |
| 위험도 분류 | `classify(input, policy): Classification` | `classify.ts:88` |
| 실행 게이트 보조 | `riskAtMost(risk, max): boolean`, `MIN_CONFIDENCE = 0.6` | `classify.ts` |
| 탐색 루프 본체 | `class Explorer { explore(startPlan): Promise<ExploreResult> }` | `explorer.ts` |
| 경로/쿼리 정규화 | `pathTemplate()`, `endpointTemplate()`, `queryKeys()`, `sha1()` | `normalize.ts` |

### Source
`packages/qa-engine/src/{fingerprint,discover,classify,explorer,normalize}.ts`, `packages/shared/src/{state,action}.ts`

### 업무 Flow — 상태 지문 (CLAUDE.md §27-2와 코드가 문장 단위로 일치 확인됨)
1. `stateKey = sha1(pathTemplate + heading + activeTab + dialogTitle + navLabels + structureHash)`
   (`fingerprint.ts:155-166`). `title`, `queryKeys`는 계산에서 제외.
2. `pathTemplate`: 숫자/UUID/24자리 hex 세그먼트를 `:id`로 정규화(`normalize.ts:18-34`) — 사용자 47명이 47개 상태가 되지 않음.
3. 쿼리는 지문에서 제외 — 처음엔 "키만 넣기"로 설계했다가 검색(`?keyword=`)과 정렬(`?keyword=&sort=&dir=&page=`)이
   같은 화면인데 다른 키 집합을 만드는 실측 문제로 폐기(`fingerprint.ts:143-153`).
4. `structureHash`: `main`/`[role=main]`/`#content` 첫 매치 대상, 안 보이는 요소 제외, 텍스트 노드 제거,
   형제 중 직렬화 결과가 같으면 접어서 정렬(`fingerprint.ts:68-106`) — 목록 10행/3행이 같은 화면이 됨.
5. 활성 탭·다이얼로그 개폐는 URL이 같아도 별도 상태로 취급(`fingerprint.ts:42-56`).

### 업무 Flow — 액션 발견·위험 분류·실행 게이트 (§27-3과 코드가 우선순위 그대로 일치)
1. 대상 셀렉터 `a[href], button, [role=button], [role=tab], summary`; 모달이 열려 있으면 그 안(root=openDialog)만 스캔(`discover.ts:57-70`).
2. 셀렉터 우선순위: `data-testid` > `href` > cssPath(`discover.ts:89-101`).
3. `classify()` 우선순위(`classify.ts:88-195`): ① `denyLabelPatterns` 매치 → DANGEROUS 절대(신뢰도 1.0)
   ② class/testid `danger|delete` 등 → DANGEROUS ③ `<thead>` 안 GET 링크 → SAFE(정렬 컨트롤)
   ④ 위험 라벨(삭제·권한·승인·발송…) → DANGEROUS ⑤ 그 외 GET 링크(비파괴적 href) → SAFE
   ⑥ 쓰기 라벨(등록·저장·수정) 버튼 → CAUTION ⑦ 분류 불가 → CAUTION, confidence 0.4(실행 하한 미만).
4. 실행 게이트(분류를 신뢰하지 않고 실행 직전 재확인): `denylist 미매치 && risk<=maxAutoRisk && confidence>=0.6`
   — `explorer.ts`의 `runAction()`이 이 3중 게이트를 그대로 재적용(`classify.ts:198-203`).
5. 탐색 예산 강제(§27-1과 기본값 완전 일치): `maxScreens=120`/`maxActions=600`/`maxDepth=8`/`maxDurationMs=900000`/
   `settleMs=700`/`navigationTimeoutMs=15000`(`run-config.ts:38-44`). 소진 시 남은 큐를 `explorationLimits`에 기록
   — 조용히 끝내지 않는다(`explorer.ts` `budgetExhausted()`).
6. 링크(NAVIGATE)는 클릭하지 않고 계획만 큐잉(결정적 재현); 버튼은 실제 클릭 후 `readState`로 상태 변화 감지,
   새 상태면 replay를 누적해 재큐잉, 원래 화면으로 복귀(`explorer.ts`).
7. 실행되지 않은 모든 액션도 outcome+이유와 함께 반드시 기록 — 미검증 영역 리포트의 근거(`action.ts` `ActionResult`).

---

## 업무 4 — CRUD 쓰기 테스트 및 테스트 데이터 관리

**개요**: 탐색 완료 후 Create/Update/Delete를 실제 실행하고, 룰 기반으로 PASS/FAIL을 판정하며,
`AUTO-QA-` 표식 데이터만 대상으로 삼아 종료 시 정리(cleanup)한다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 폼 자동 인식 | `analyzeForm(page): Promise<FormInfo\|null>`, `isFillable(field): boolean` | `forms.ts` |
| 테스트 데이터 마커 | `makeMarker(seq, now?): string` (`AUTO-QA-yyyyMMdd-HHmmss-SEQ`) | `testdata.ts` |
| 소유권 판정 | `isOwnedByQa(text): boolean` | `testdata.ts:20-22` |
| 테스트 데이터 대장 | `class TestDataLedger { nextMarker(); add(); markCleaned(); leftovers() }` | `testdata.ts` |
| CRUD 실행기 | `class CrudTester { run(graph: StateGraph): Promise<CrudOutcome> }` | `crud.ts:804` |

### Source
`packages/qa-engine/src/{forms,testdata,crud}.ts`

### 업무 Flow — 데이터 소유권 (§10 "판정 근거는 AUTO-QA- 접두사 하나뿐"과 정확히 일치)
1. **Create 대상 화면 발굴**: `pathTemplate`이 `/(new|create|regist|write|add)(\/|$)/i` 매치하는 노드만 —
   `edit`는 이 정규식에서 명시적으로 제외됨(`/surveys/:id/edit`을 등록 화면으로 착각해 실데이터를
   수정한 실측 사고의 재발 방지, `crud.ts:153-157`).
2. 주소로 못 찾으면 "폼을 여는 버튼"으로 분류된 SAFE 액션을 탐침(`openerScreens`), 눌러본 뒤 실제로
   쓰기 요청이 발생하면 분류 오류로 보고 그 버튼을 폐기(`crud.ts:170-255`) — 실행 시점 안전망.
3. **기존 데이터 보호(핵심 방어)**: 채울 수 있는 필드에 이미 값이 있고 그 값이 `AUTO-QA`를 포함하지
   않으면 기존 데이터로 판정해 건드리지 않음(`holdsExistingData`, `crud.ts:279-293`) — Create/Update 양쪽에서 재확인.
4. **Update/Delete 대상 확정**: ledger 레코드의 `landedUrl`로 이동해 본문에 `AUTO-QA` 마커가 실제로
   있는지 확인해야만 진행, 목록이면 마커를 포함하는 행(row)만 scope로 잡고 수정/삭제 버튼 셀렉터를
   그 행 안으로 한정(`scopedSelector`, `crud.ts:46-52,409-431`) — "행을 못 찾으면 아무것도 하지 않는다".
5. Delete는 `config.crud.delete && config.crud.deleteConsent` 둘 다 있어야 실행, 없으면 지우지 않고
   잔여로 리포트(`crud.ts:764-801`).

### 업무 Flow — Functional PASS 판정 (§11과 대조: 판정 체인이 문서보다 한 단계 짧음, 더 엄격→더 관대 방향)
1. `judgeWrite()`: 저장 클릭 실패 → FAIL(`FUNC-CLICK-FAILED`); 쓰기 요청(POST/PUT/PATCH/DELETE) 0건 → FAIL
   (`FUNC-NO-RESPONSE`/`FUNC-NO-REQUEST`); 쓰기 요청 status≥400 → FAIL; `loadingStuck` → FAIL
   (`FUNC-INFINITE-LOADING`); 전부 통과 → PASS(`crud.ts:326-371`).
2. PASS 판정 후 **재조회 확인**(목록 페이지에서 marker 텍스트 검색)까지 실패하면 `FUNC-PHANTOM-SUCCESS`로
   FAIL 전환(`crud.ts:390-399,505-522`) — 문서의 "저장→2xx→토스트→재조회→데이터존재→PASS" 시퀀스 구현.
   **단, 토스트/메시지 신호는 관측만 하고 PASS/FAIL 자체를 좌우하지 않는다** — 실제 판정은
   (쓰기요청→2xx→재조회)만으로 완결(문서보다 관대한 지점).
3. 필수 필드를 하나씩 비우고 저장을 시도해 `FUNC-VALIDATION-MISSING` 검출(`probeValidation`, `crud.ts:538-584`).
4. 종료 시 `cleanup()`이 삭제 동의 있으면 역순으로 정리, 없으면 잔여 데이터를 리포트에 남김.

---

## 업무 5 — 증적 수집 (Evidence)

**개요**: 화면 방문마다 스크린샷/DOM/ARIA/콘솔/네트워크/시각계측을 한 묶음으로 수집·저장한다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 화면당 증적 캡처 | `captureScreen(page, ctx, collector, screen, options?): Promise<ScreenCapture>` | `capture.ts` |
| 캡처 옵션 | `CaptureOptions { clearPasswordFields?; fullPage?; measureVisual? }` | `capture.ts` |

### Source
`packages/qa-engine/src/capture.ts`, `packages/shared/src/evidence.ts`

### 업무 Flow
1. 비밀번호 필드를 클리어한 후 뷰포트/풀페이지 스크린샷 각각 독립적으로 촬영(실패해도 서로 영향 없음).
2. DOM은 `script`/`style` 제거, `input[type=password]` value 공백화 후 저장 — §16 마스킹 정책과 겸함.
3. ARIA는 `body.ariaSnapshot()`으로 획득.
4. Visual 계측(`measureVisual`, 업무6)과 console/network drain 결과(업무1 Collector)를 함께 Evidence로 묶음.
5. **개별 캡처 실패는 절대 throw하지 않고 경고 로그만 남김** — 스크린샷 1건 실패로 탐색이 멈추지 않음.
6. **편차**: §14가 명시한 12종(Screenshot/DOM/ARIA/URL/Title/Console/Network/Action History/Form Fields/
   Visible Text/Before/After/Timing) 중 이 파일이 실제로 채우는 건 6종(screenshot/dom/aria/console/network/visual).
   Action History/Form Fields/Visible Text/Timing은 별도 모듈(액션 기록 등)이 담당하거나 `pairedWithId` 필드만
   선점된 상태(Before/After).

---

## 업무 6 — 결함 검출 (Console / Network / Visual, 룰 기반)

**개요**: AI 없이 브라우저 관측값만으로 결함 후보(`IssueCandidate`)를 만든다. §16(Console/Network)과
§15(Visual)의 실행부.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 룰 계측(레이아웃) | `measureVisual(page): Promise<VisualReading>` (`{metrics, loadingStuck}`) | `visual.ts` |
| 네트워크 검출 | `detectNetwork(entries, screen): IssueCandidate[]` | `detect.ts` |
| 콘솔 검출 | `detectConsole(entries, screen): IssueCandidate[]` | `detect.ts` |
| 시각 검출 | `detectVisual(metrics, loadingStuck, screen): IssueCandidate[]` | `detect.ts` |

### Source
`packages/qa-engine/src/{visual,detect}.ts`

### 업무 Flow — Visual (§15 대비 일치 + 오탐 억제 추가규칙)
1. viewport overflow/horizontal scroll(`scrollWidth > vw+8`), element overlap(형제끼리만, 겹침 비율≥0.3),
   hidden CTA(모달 열려있으면 모달 내부만 스캔), 비정상 empty area, 텍스트 잘림(문서 외 추가), 로딩 무한
   감지(2초 재확인 후 확정, 문서 외 추가)를 계측.
2. 각 카테고리 최대 10건 캡 — 리포트 폭주 방지.

### 업무 Flow — Network/Console (§16 대비: 세분화 정도에 일부 편차)
1. Network: `>=500→NET-5XX/HIGH`, `401/403→NET-AUTH/HIGH`, 그 외 4xx→`NET-4XX/MEDIUM`(**편차**: §16이
   404/409/422를 개별 열거하지만 구현은 2그룹으로만 분기). 정적 리소스 4xx는 LOW로 강등(오탐 억제, 문서 외 추가).
   CORS/timeout/DNS/TLS→HIGH, ORB/CORB→MEDIUM, 클라이언트차단/자체취소→LOW로 세분화(§16 요구를 구체화 구현).
   느린 응답(`xhr`/`fetch` &`durationMs>3000ms`)→`NET-SLOW/LOW`.
2. Console: `level==="error"`만 처리. rejection→`CON-REJECTION/MEDIUM`, TypeError류→`CON-UNCAUGHT/HIGH`,
   프레임워크 오류→`CON-FRAMEWORK/MEDIUM`, 그 외→`CON-ERROR/LOW`.
3. 마스킹은 이 파일이 아니라 **수집 시점**(`collector.ts` `maskHeaders`)에서 완료(§16 요구 위치와 다르나
   결과는 동일 — 원본이 파일로 새어나갈 경로 자체를 차단).
4. `candidate()`가 `evidenceId` 없으면 후보를 아예 버림 — "모든 최종 Issue는 최소 1개 Evidence" 원칙을
   후보 생성 단계부터 강제.
5. **편차**: §17 CRITICAL 기준(로그인불가/권한우회/개인정보노출/데이터손실/시스템전체불가)을 부여하는
   룰이 이 서브시스템에는 전무 — CRITICAL은 security-analyzer(업무10) 계열에서만 나온다.

---

## 업무 7 — Issue 판정 (Dedup·Severity·Priority)

**개요**: `IssueCandidate[]`를 중복 제거해 최종 `Issue[]`로 확정하고 Severity/Priority/재현절차를 부여한다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 판정 본체 | `judge(candidates, graph): JudgeResult` (`{issues, mergedFrom}`) | `judge.ts` |
| Priority 계산(정본) | `toPriority(score, severity): Priority`, `SEVERITY_WEIGHT`, `PRIORITY_BAND` | `shared/src/issue.ts:121-161` |

### Source
`packages/qa-engine/src/judge.ts`, `packages/shared/src/issue.ts`

### 업무 Flow (§18/§19 대비: Priority 공식은 완전 일치, Dedup 키는 일부만 사용)
1. **Dedup**: `dedupKey`(source+ruleId+엔드포인트/시그니처+status) 하나로 그룹화(**편차**: §19가 나열한 7개
   기준 중 DOM Selector/Action/Screen은 조합에 직접 포함되지 않음, 대신 병합 후 evidenceIds/screens로 합집합
   보존). 병합 시 severity는 그룹 내 최댓값 채택.
2. **Priority**(§18과 정확히 일치): `score = severityWeight × businessImpact × frequency × userExposure ÷ fixEffort`.
   **Frequency는 distinct stateKey 수**(원시 후보 건수 아님) — 실측 근거("404 하나가 후보 332건")를 코드
   주석에 그대로 인용. `occurrenceCount`는 사실 그대로 보존하되 점수 계산에는 미사용.
3. **대역 클램프**: `toPriority(score, severity)`가 severity별 대역(CRITICAL→[P0,P0], HIGH→[P0,P1],
   MEDIUM→[P1,P2], LOW→[P2,P3]) 안에서만 점수 순서를 반영 — "넓게 퍼짐이 심각함을 덮는" 문제(문서에
   기록된 실측 사례) 방지.
4. `reproductionSteps()`가 StateGraph BFS로 최단경로를 재현 절차 문장으로 자동 생성.
5. Priority→score→severity→ruleId 순 안정 정렬 후 `QA-0001...` ID 부여(회귀 비교를 위한 재현성 보장).

---

## 업무 8 — 리포트 생성 (report.md / issues.json)

**개요**: AI 없이도 완결되는 룰 템플릿 리포트 렌더러. §25의 17개 섹션을 채운다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 리포트 렌더 | `renderReport(input: {summary, issues, evidences, aiSummary?, missingFeatures?, suspectedFalsePositives?}): string` | `report.ts` |

### Source
`packages/qa-engine/src/report.ts`, `packages/shared/src/report.ts`(RunSummary/IssuesFile 계약)

### 업무 Flow (§25 목차 17개 항목 전부 확인, Change Impact 섹션은 문서 외 확장)
1. 실행정보/테스트환경/Executive Summary/(Change Impact, 확장)/CRUD 결과/Critical~Low/화면별 개선점/
   Console·Network·UX 오류/기능 누락 후보/우선순위/권장 수정 순서/탐색 제한/미검증 기능 순으로 렌더.
2. 이슈 상세는 관측 사실과 AI 분석을 `[AI 원인 분석]` 마커로 분리 — "룰 문장을 AI가 덮어쓰지 않는다" 원칙의
   마크업 차원 구현. CodeRef는 `confidence>=1`이 아니면 "추정 N%" 표기.
3. AI가 오탐으로 판단한 이슈도 삭제하지 않고 부록에 남김.
4. `aiSummary` 없으면 최상위 이슈 기반 룰 문장을 자동 생성 — 어떤 섹션도 AI 부재로 비지 않음(§29 요구와 일치).
5. "미검증 기능" 섹션은 값이 없어도 "- 없음"을 출력 — 생략 자체를 금지.

---

## 업무 9 — AI Provider 추상화 및 AI 보강

**개요**: Claude/Ollama/none 3개 구현체를 동일 인터페이스로 추상화하고, AI 실패가 절대 상위로 전파되지
않도록 하는 이중·삼중 안전망을 갖는다. **AI는 판정하지 않는다** — PASS/FAIL은 이미 룰이 정한 사실이며,
AI는 원인 설명·중복 판단 보조·문장 생성에만 관여한다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| Provider 계약 | `interface AiProvider { healthCheck; analyzePage; analyzeFunction; analyzeScreenshot; judgeIssues; generateReport }` | `shared/src/ai.ts:138-146` |
| 팩토리 | `createProvider(config: AiProviderConfig): AiProvider` | `ai/index.ts` |
| Claude 구현체 | `class ClaudeProvider implements AiProvider` (CLI `claude -p` 경유) | `ai/claude.ts` |
| Claude CLI 저수준 유틸 | `resolveClaudeCli()`, `claudeAuthStatus()`, `runClaude()` | `ai/claude-cli.ts` |
| Ollama 구현체 | `class OllamaProvider implements AiProvider` (`/api/chat`, temperature:0) | `ai/ollama.ts` |
| 폴백 구현체 | `class NoneProvider implements AiProvider` (전 메서드 빈 값 반환) | `ai/none.ts` |
| 실패 흡수 가드 | `class AiGuard { run<T>(); status(); failureReason() }`, `parseJson()`, `retryOnce()`, `mapLimited()` | `ai/guard.ts` |
| 보강 파이프라인 | `enrich(input): Promise<EnrichResult>`, `passthrough(issues): EnrichResult` | `ai/enrich.ts` |
| 프롬프트/스키마 | `pageAnalysisPrompt`, `functionalAnalysisPrompt`, `visualAnalysisPrompt`, `issueJudgePrompt`, `reportSummaryPrompt` | `ai/prompts.ts` |

### Source
`packages/qa-engine/src/ai/{index,claude,claude-cli,ollama,none,guard,enrich,prompts}.ts`, `packages/shared/src/ai.ts`

### 업무 Flow (§5·§6·§7 대비 대부분 일치, 세부 편차 2건)
1. `preflightAi()`(업무1)가 탐색 **전**에 `healthCheck()` 1회 확인 — 탐색 끝나고 나서 연결 실패를 아는 것을 방지.
2. 룰 기반으로 이미 확정된 Issue 목록(업무7의 산출물)에 대해서만 `enrich()`가 4단계로 보강:
   ① `analyzeFunction` — **관련된 action이 없으면 반드시 null로 넘김**(같은 화면·EXECUTED 결과일 때만 연결).
   실측 사고(무관한 화면이동 액션이 네트워크 500 분석에 섞여 룰 문장을 덮어쓴 사례)를 코드 주석에 그대로 인용.
   ② `judgeIssues` — 오탐은 삭제 아닌 표시만, `codeRefs`/`apiRef`는 비워서 전송(관련없는 컨텍스트 배제).
   ③ 대표 화면 5개만 `analyzePage`(비용 절감). ④ `generateReport`로 Executive Summary 생성.
3. **모든 AI 호출은 `AiGuard.run()`을 거쳐 예외를 삼킴** → `run.ts`가 `enrichWithAi()` 전체를 또 한번
   try/catch(이중 안전망) → 실패 시 `passthrough(issues)`로 폴백, `status:"failed"`.
4. 소형 로컬 모델의 응답 형태 오류(배열 자리에 문자열 등)는 `coerceShape()`가 스키마 자체는 바꾸지 않고
   파싱 직전 값만 교정 — "계약은 엄격, 어댑터는 관대"(§5) 원칙과 정확히 일치. 근본적 타입 오류는 여전히 throw.
5. `confidence < 0.5`이면 `impact`/`recommendation`은 룰 문장을 유지(**경미한 편차**: `rootCause`는 confidence와
   무관하게 `description`에 항상 append됨 — 다만 `[AI 원인 분석]` 접두사로 원문과 분리되어 실질적 훼손은 아님).
6. 모든 프롬프트 문자열은 `scrub()`을 거쳐 나감(§16 마스킹 정책과 일치).
7. **편차**: `analyzeScreenshot`(Visual AI 2차 검토, §15)은 `enrich.ts`에서 아직 호출되지 않음 — Visual QA의
   AI 보강 경로가 파이프라인에 완전히 연결되지 않은 상태로 보임.

---

## 업무 10 — 소스 QA: 정적 분석·시크릿 정책·권한검사 누락 검출

**개요**: 프로젝트 폴더를 코드 실행 없이 정적으로 분석해 결함을 찾는다. §16-1(소스 취급 정책)의 핵심 실행부이자,
"실행 QA가 원리적으로 못 찾는 것"(권한 검사 누락 등)을 유일하게 직접 구현하는 검출기를 포함한다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 프로젝트 스캔 | `scanProject(rootDir, budget: ScanBudget): ProjectScan` | `source/scan.ts` |
| 정적 룰 검출(6종) | `findSqlConcat`, `findEmptyCatch`, `findOptionalGet`, `findHardcodedSecret`, `findPlainPassword`, `findRawHtml`, `findFetchIssues`, `runFileRules(file, raw)` | `source/rules.ts` |
| 시크릿 취급 | `accessOf(path): FileAccess`("read"\|"keys-only"\|"presence-only"), `isSecretKey()`, `readConfigKeys()`, `readYamlKeyPaths()` | `source/secrets.ts` |
| Spring Security 규칙 해석 | `readSecurityConfig(rootDir, scan): SecurityRules`, `isPubliclyPermitted()` | `source/security-config.ts` |
| 엔드포인트 추출·권한판정(직접구현 유일 검출기) | `extractSpringEndpoints()`, `unauthorizedEndpoints()`(gap: "open"\|"no-role-check") | `source/endpoints.ts` |
| 주석 제거(부정행위 방지) | `stripComments(text)` | `source/strip.ts` |

### Source
`packages/qa-engine/src/source/{scan,rules,secrets,security-config,endpoints,strip}.ts`
`packages/fixture-src/KNOWN_SOURCE_BUGS.md`(정답지, 결함 12건)

### 업무 Flow (§16-1/§9/§30 대비: 대부분 문장 단위로 일치, aiUpload 게이팅은 스키마만 존재)
1. **스캔**: Git 저장소면 `git ls-files`로 추적 파일만 수집(`.gitignore` 직접 파싱 대신 git에 위임 —
   동봉 Chromium 소스까지 읽은 실측 사고 방지). `SKIP_DIRS`/`SKIP_EXT` 필터 + `maxFiles`/`maxFileBytes`/
   `maxTotalBytes` 예산, 초과 시 `limits`에 사유 기록. 파일별 `access`는 `secrets.ts::accessOf()`로 결정.
2. **시크릿 정책**(§16-1과 정확히 일치): `.pem/.key/.p12/.pfx/id_rsa*`(+`.jks`, 문서 외 보수적 확장)는
   **존재만** 확인(`presence-only`). `.env`, `application-*.yml/properties`, `credentials*`, `secrets*`는
   **키 이름만** 읽고(`keys-only`) 값은 절대 읽지 않음 — `ConfigKey` 타입 자체에 값 필드가 없어 **타입
   시스템 수준에서 값 유출을 봉쇄**.
3. **룰 검출**: `stripComments()`로 주석 제거 후(정답 태그를 근거로 삼는 부정행위 원천 차단) SQL 조립,
   빈 catch, Optional 무검사, 하드코딩 시크릿, 평문 비밀번호 저장, XSS(`dangerouslySetInnerHTML`), fetch
   응답 미검증을 좁은 모양으로만 검출 — ESLint/Semgrep이 하는 일은 재구현하지 않는다(§30).
4. **권한 검사 누락 판정(직접 구현 유일 검출기)**: `readSecurityConfig`로 전역 규칙(`permitAll`,
   `anyRequest().authenticated()`)을 먼저 읽어 오탐을 줄인 뒤, `unauthorizedEndpoints`가 **같은 파일에
   인가된 형제 엔드포인트가 있을 때만** 보고(전역 필터 기반 프로젝트를 전부 결함으로 오판하는 것 방지).
   `gap`을 "open"(아무나 접근)/"no-role-check"(로그인만 하면 됨)로 세분화해 CRITICAL/HIGH 과장을 방지.
5. **KNOWN_SOURCE_BUGS.md 대응 확인**: SRC-01(삭제 엔드포인트 권한 누락, CRITICAL, 실행 QA로는 탐지 불가)과
   이 로직이 정확히 대응 — "🔐권한관리 16회 발견/0회 실행"이라는 실측 근거가 소스 QA 존재 이유의 핵심.
6. **편차 1(중요)**: `source.aiUpload`(none/snippets/files) 스키마는 정의돼 있으나, AI에 실제로 무엇을
   보낼지 잘라내는 로직이 `run-source.ts`/`ai/enrich.ts` 어디에도 없다 — `enrich()`가 보내는 `finding`에는
   파일 경로 문자열만 있고 실제 소스 스니펫이 없어 현재는 사실상 "none"과 다르지 않지만, §16-1이 요구하는
   3단계 차등 노출은 **집행 코드가 없는 상태**.
7. **편차 2**: 실행 전 "일부 소스가 &lt;Provider&gt;로 전송됩니다" 고지 문구, Ollama 선택 시 "룰 결과만
   실림"을 리포트에 명시하는 로직 모두 코드에서 확인되지 않음 — §16-1 요구사항 미충족(단, 편차1로 인해
   실질적 노출 위험 자체는 낮음).

---

## 업무 11 — API↔소스 매핑 및 Change Impact QA

**개요**: 통합 QA의 본체 — 실행 QA가 관측한 `POST /api/users → 500`을 파일·줄로 옮기고(Root Cause 1차),
git diff로 변경 영향 화면을 앞으로 당겨온다(Change Impact).

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 인덱스 구성 | `buildApiIndex(rootDir, endpoints, files): ApiSourceIndex` | `source/api-map.ts` |
| 매핑 | `mapApiToSource(api: ApiRef, index): CodeRef[]`, `attachCodeRefs(issues, index)` | `source/api-map.ts` |
| git diff 조회 | `gitChangedFiles(rootDir, base?): ChangedFiles` | `source/change-impact.ts` |
| 영향도 계산 | `computeImpact(rootDir, scan, changed): ChangeImpact`, `impactScore(url, hints): number` | `source/change-impact.ts` |
| 소스 QA 오케스트레이터 | `runSourceQa(config, ctx, progress?): SourceQaOutcome` | `source/run-source.ts` |

### Source
`packages/qa-engine/src/source/{api-map,change-impact,run-source}.ts`
`packages/fixture-src/KNOWN_ENDPOINTS.md`(정답지)

### 업무 Flow (KNOWN_ENDPOINTS.md 및 §2-1과 문장 단위로 일치)
1. **API↔소스 매핑**: `normalizePath`로 실행 QA의 `pathTemplate`과 대조 가능하게 정규화. 컨트롤러는
   `confidence:1`로 확정(어노테이션 문자열 매칭이라 정확), 생성자 주입 타입이 정의된 파일은 `confidence:0.5`로
   "한 걸음 더"만 붙임. **호출 그래프는 만들지 않는다** — Controller→Service→Repository의 정확한 그래프는
   컴파일러 없이 만들 수 없다는 판단(이름이 같은 메서드, 인터페이스 구현체 선택, 동적 위임에서 틀림).
   매칭 실패는 빈 배열 반환(억지 매칭 금지), `unmapped`로 별도 집계.
2. **Change Impact**(범위 한정기, 별도 모드 아님): `git diff base...HEAD` → 없으면 커밋 안 한 변경 →
   작업 트리가 깨끗하면 마지막 커밋으로 폴백. git 미설치/비-저장소를 구분해 다른 안내. 바뀐 컨트롤러는
   확정 엔드포인트로, 바뀐 서비스/리포지터리는 이름을 언급하는 컨트롤러만 추정으로 편입(호출 그래프 미작성
   원칙 재확인). `impactScore`는 **탐색 대상을 줄이지 않고 순서만 바꾼다**.
3. `runSourceQa()`가 스캔(업무10) → 룰 검출 → 시크릿 → 빌드/테스트(업무12) → 권한판정 → Change Impact →
   `IssueCandidate[]` 단일 반환으로 수렴, 1부(웹) 공용 judge/report 파이프라인(업무7,8)에 그대로 합류한다 —
   "새 파이프라인을 만들지 않는다"는 설계 원칙과 일치.

---

## 업무 12 — 빌드/테스트 동의 기반 실행

**개요**: 소스 QA에서 유일하게 대상 프로젝트의 임의 코드를 사용자 권한으로 실행할 수 있는 지점.
동의·화이트리스트·명령 전문 공개 3중으로 통제한다.

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| 실행 계획 수립 | `plannedCommands(scan: ProjectScan, config: RunConfig): PlannedCommand[]` | `source/build-test.ts` |
| 명령 실행 | `runCommand(rootDir, planned): CommandResult` | `source/build-test.ts` |
| 결과→이슈 변환 | `commandCandidates(results, evidenceId): IssueCandidate[]` | `source/build-test.ts` |
| 오케스트레이션 | `runBuildAndTest(config, scan, evidenceId): BuildTestOutcome` | `source/build-test.ts` |

### Source
`packages/qa-engine/src/source/build-test.ts`

### 업무 Flow (§9 3원칙과 완전히 일치 — 코드 구조로 정책이 강제됨)
1. **화이트리스트**: `^npm run (build|test|lint)$`, `^\.\/gradlew (build|test)$`, `^mvn (test|verify)$` 정규식
   패턴에 매치하는 명령만 허용 대상. `npm install` 등 의존성 설치, DB 마이그레이션, 외부 배포는 이 목록
   어디에도 없어 **동의 여부와 무관하게 애초에 실행 불가**.
2. **동의 게이트**: `config.source.allowBuild`/`allowTest` 동의와 화이트리스트 모양을 모두 통과해야
   `plannedCommands`에 남는다.
3. **실행**: Windows `.cmd` 래퍼(npm/mvn) spawn 제약 우회를 위해 `cmd.exe`를 거치지만, 셸에 넘기는 문자열은
   상수 도구명 + 화이트리스트가 잡아낸 `build|test|lint` 세 낱말뿐 — 사용자 입력이 셸 인자에 섞이지 않음.
   `QA_PASSWORD` 환경변수는 명시적으로 지워 자식 프로세스에 전달 안 함. 출력은 `scrub()` 후 40,000자로 절단.
4. **명령 전문 공개**(§9 "실행할 명령 전문을 그대로 보여주고 동의를 받는다"): 실행 전/후 모두 `log("warn",...)`
   으로 실제 실행 명령을 그대로 남김.
5. 성공(exitCode 0)은 후보를 만들지 않고, 실패만 `BUILD-FAILED`/`BUILD-TEST-FAILED`/`BUILD-LINT-FAILED`로
   이슈화. 동의 안 된 명령은 `notRun`에 사유와 함께 축적되어 "미검증 기능" 절로 흘러감.

---

## 업무 13 — 앱(모바일) QA: Android 자율 탐색

**개요**: 웹 자율탐색(업무3)의 형제 모듈. adb로 Android 앱을 자율 탐색해 웹과 동일한 `IssueCandidate`/
`report.md` 파이프라인에 합류시킨다. **CLAUDE.md §26 에이전트 표에는 없으나 실제로 구현·연결되어 있는
확장 기능**이다(ROADMAP.md는 "Phase 15 예정"으로 표기되어 있지만, 커밋 `23927e5`(1.0.7)로 이미 파이프라인에
연결 완료됨 — 문서 갱신이 코드를 따라가지 못한 사례).

### API 기능
| 기능 | 시그니처 | 위치 |
|---|---|---|
| adb 전송 계층 | `class Adb { dumpUi(); screenshot(); tap(); back(); swipe(); currentFocus(); launch(); isInstalled(); logcatSince() }`, `resolveAdb()`, `listDevices()` | `app/adb.ts` |
| 앱 위험도 분류 | `classifyAppElement(element, policy, riskyLabels): Classification` | `app/classify-app.ts` |
| 결함 후보 변환 | `detectAppIssues(result, ctx): IssueCandidate[]`, `appUnverifiedAreas(result): string[]` | `app/detect-app.ts` |
| 조작 인터페이스(테스트 대체용) | `interface AppDriver`, `class AdbDriver implements AppDriver` | `app/driver.ts` |
| 탐색 루프 | `class AppExplorer { explore(): AppExploreResult }` | `app/explorer.ts` |
| UI 덤프→요소/지문 | `readScreen(xml): AppScreen\|null`, `pickLogcatErrors()` | `app/observe.ts` |
| 사전 점검 | `preflightApp(input): AppPreflight` | `app/preflight.ts` |

### Source
`packages/qa-engine/src/app/{adb,classify-app,detect-app,driver,explorer,observe,preflight}.ts`
`mobile/`(원형 Python 프로토타입, 참고용)

### 업무 Flow (문서화된 §13 시리즈 설계 결정과 코드가 전부 일치 확인됨)
1. **사전 점검**(`preflightApp`): adb 없음 → 기기 없음 → **unauthorized(USB 디버깅 미허용) vs 기타 상태
   구분** → 다중 기기면 하드웨어 시리얼로 중복(무선 디버깅 이중 등록) 통합 후에도 2대 이상이면 명시적
   `deviceSerial` 없이는 **자동 선택하지 않고 실패 반환** → 앱 미설치 → 화면 꺼짐/잠김, 각 단계마다 다른
   `remediation` 문구 제공.
2. **탐색**(`AppExplorer.explore`): URL이 없는 환경이라 BFS 큐 대신 **깊이우선 + back 복귀 + 경로 재생**
   (back으로 못 돌아오면 앱을 재시작해 경로를 replay). `maxSteps`/`maxScreens`/`maxDurationMs` 예산 강제,
   소진 시 `limits` 기록.
3. **상태 지문**(`observe.ts::fingerprint`): 웹과 달리 title+클릭가능 라벨을 지문에 포함 — Flutter 덤프는
   class/resource-id가 거의 없어(`android.view.View`뿐) 라벨 없이는 전 화면이 동일 지문이 된 실측 실패
   때문. 단, 같은 모양이 **3회 이상 반복**되면 목록으로 보고 라벨을 버림(`LIST_GROUP_MIN=3`) — 47명이
   47개 화면이 되는 것을 방지.
4. **위험도 분류**(`classifyAppElement`): denylist 절대성은 웹과 동일하나, **모르는 라벨은 SAFE로 간주해
   이동으로 클릭**(웹은 반대로 CAUTION 미실행) — 앱에는 href 같은 이동/변경 구분 신호가 없어, 모르면
   안 누르는 웹 방식을 그대로 쓰면 화면을 거의 못 보기 때문(실측: 4개 중 1개만 눌림). `riskyLabels`
   (기본: 출근/퇴근/휴식/체크인/체크아웃/결제/구매/주문/해지/신고/제출)는 CAUTION으로 강등돼 실행 게이트에서
   지연(`deferred` 큐)된다.
5. **되돌릴 수 없는 동작**: 즉시 스킵이 아니라 `deferred` 큐에 경로와 함께 적립, `tryRiskyLast` 동의가
   있을 때만 **탐색 종료 후 딱 1회** 경로를 재생해 실행 — "동의해도 맨 마지막에 시도"라는 설계 결정과 일치.
6. **결함 후보**(`detectAppIssues`): `APP-SCREEN-ERROR`(HIGH, 화면 노출 예외), `APP-LOG-ERROR`(MEDIUM,
   조작 직후 logcat 오류), `APP-ACTION-FAILED`(MEDIUM, 조작 자체 실패), `APP-DEAD-CONTROL`(LOW, 눌러도
   화면 불변) 4개 룰만 직접 구현 — 자체 검출기를 늘리지 않는다는 원칙(§30)을 앱 도메인에도 적용.
7. 이후 결과는 웹과 동일한 `judge()`(업무7)→`renderReport()`(업무8) 파이프라인에 그대로 합류한다.

---

## 업무 14 — Electron 데스크톱 셸: 프로젝트 관리·설정·모니터링·자격증명

**개요**: `packages/qa-engine`을 자식 프로세스로 스폰해 stdout JSON Lines(`EngineEvent`)를 중계하는
얇은 GUI 셸. QA 로직은 이 패키지에 전혀 없다.

### API 기능 — IPC 채널 전체 목록

| 채널 | 방향 | 목적 | 위치 |
|---|---|---|---|
| `projects:list`/`get`/`save`/`delete` | R→M | 프로젝트 CRUD. `save` 시 비밀번호는 즉시 `encryptPassword`로 암호화 | `electron/ipc.ts:86-133` |
| `run:preflight` | R→M | 자격증명 저장 가능 여부, 엔진 경로/오류 확인 | `electron/ipc.ts:136-146` |
| `dialog:pickFolder` | R→M | 소스 QA 대상 폴더 선택 | `electron/ipc.ts:160-170` |
| `ai:claudeStatus`/`ai:claudeLogin`/`ai:ollamaModels` | R→M | Claude CLI 상태 확인·로그인, Ollama 모델 조회(CSP로 렌더러 직접 fetch 불가해 main이 대행) | `electron/ipc.ts:180-240` |
| `app:status` | R→M | 앱 QA용 adb/기기/패키지 사전 점검 | `electron/ipc.ts:188-190` |
| `run:start`/`pause`/`resume`/`stop` | R→M | RunConfig 검증(zod) 후 엔진 시작, stdin으로 제어 명령 전송(stop은 15초 grace 후 강제 kill) | `electron/ipc.ts:242-248` |
| `runs:list`/`detail`/`report`/`evidence`/`openFolder` | R→M | Run 이력·리포트·증적 조회 | `electron/ipc.ts:251-273` |
| `qa:run` | M→R (event) | 엔진 생애주기 이벤트 푸시(`started`/`event`/`engine-noise`/`exited`) | `electron/ipc.ts:80-82` |

모든 채널은 `contextBridge.exposeInMainWorld("qa", api)`로만 노출 — 렌더러는 Node/파일시스템/자식프로세스에 직접 접근 불가(`electron/preload.ts`).

### Source
`apps/desktop/electron/{main,ipc,engine,credentials,store,preload}.ts`
`apps/desktop/src/{api,store,App}.tsx`, `apps/desktop/src/screens/{Projects,Setup,Monitor,Issues,Evidence,Report,History}.tsx`

### 업무 Flow (자격증명 흐름은 §20/§29 요구사항과 완전히 일치 확인됨)
1. **프로젝트 생성/선택**(`Projects.tsx`) → `projects:save` → SQLite 저장(비밀번호 없이 초기 생성).
2. **설정 입력**(`Setup.tsx`): URL/계정/AI Provider/CRUD 범위/Safety Policy 입력 → `buildConfig()`가 `RunConfig` 구성.
   `blockReason`으로 시작 불가 사유를 항상 화면에 노출.
3. **QA 시작**: `projects:save` → `run:start({projectId, config, password, savePassword})`.
4. **main: 실행 시작**(`ipc.ts::startRun`): zod 검증 → delete 동의 재확인(UI 체크박스 + main 재검증 이중 게이트)
   → 비밀번호 해석(입력값 우선, 없으면 저장된 암호문을 `safeStorage`로 복호화) → 저장 옵션이면 재암호화 → `EngineProcess.start()`.
5. **엔진 스폰**(`engine.ts`): `spawn(process.execPath, [enginePath, ...args], {env:{ELECTRON_RUN_AS_NODE:1,
   QA_PASSWORD:password, ...}})` — **비밀번호는 환경변수로만 전달, CLI 인자에는 없음**(OS 프로세스 목록 노출 방지).
6. **이벤트 릴레이**: 엔진 stdout 각 줄 → `EngineEvent.safeParse` → `IpcLayer.onEngineEvent` → `webContents.send("qa:run",...)`.
7. **렌더러 반영**(`store.ts::applyEvent`): `run:status`→runStatus, `run:progress`→progress, `state:visited`→
   스크린샷 경로 포함 방문화면, `issue:found`→liveIssues, `ai:status`→aiDetail, `run:finished`→summary,
   `log`→logs(최대 500줄) — `Monitor.tsx`가 이를 실시간 렌더링.
8. **종료**: 엔진 child exit → `IpcLayer.onExit`가 크래시(결과 없이 죽음) vs 판정 실패(정상 종료)를 구분해
   저장 → `runs:list`/`runs:detail` 재호출로 **DB에 확정 저장된 결과로 스토어를 덮어씀**(엔진 이벤트 스트림이
   아닌 SQLite가 최종 소스).
9. **열람**: `Issues.tsx`(목록+상세 통합) → `Evidence.tsx`(`runs:evidence`로 스크린샷/DOM/네트워크 파일 열람)
   → `Report.tsx`(`runs:report`로 `report.md` 원문 표시, **여기서 리포트를 다시 만들지 않는다**) → `History.tsx`(과거 Run 재조회).

### 자격증명 흐름 (검증 결과: §20/§29 요구사항과 일치)
`Setup.tsx` 입력(`type="password"`) → IPC(프로세스 내부 통신, 네트워크 노출 없음) → main에서 즉시
`safeStorage.encryptString`으로 암호화 → SQLite `password_enc BLOB` 컬럼(평문 컬럼 없음) → 실행 시 main
내부에서만 복호화 → 엔진에는 환경변수로 전달 → 렌더러 state는 전송 직후 즉시 삭제. `getPasswordEnc()`는
IPC 핸들러 어디서도 직접 반환되지 않음 — 렌더러는 `hasPassword` boolean만 받는다. 코드 전체에서
`console.log` 등으로 password/token을 출력하는 지점 없음.

---

## 부록 A — 정책 대비 편차 종합 (스펙 갱신 시 우선 확인 대상)

| 영역 | 편차 | 심각도(문서 정합성 관점) |
|---|---|---|
| 소스 QA (업무10-11) | `source.aiUpload`(none/snippets/files) 스키마만 존재, 실제 스니펫 절단·차등 노출 집행 코드 없음 | 중 — 현재는 과다노출은 아니나 "files" 설정이 의미 없음 |
| 소스 QA (업무10-11) | 실행 전 "소스 일부가 &lt;Provider&gt;로 전송됩니다" 고지 문구 없음, Ollama 선택 시 "룰 결과만" 리포트 명시 없음 | 중 — §16-1 사용자 고지 요구 미충족 |
| 결함 검출 (업무6) | Network 4xx 세분화(404/409/422 개별)가 §16 문서보다 단순(401/403 vs 기타 4xx 2그룹) | 낮 — 실질 기능은 더 정교한 대체 규칙(정적리소스 강등, 실패유형 세분화)으로 보완됨 |
| Issue 판정 (업무7) | CRITICAL을 부여하는 룰이 console/network/visual 계열에 전무(security-analyzer 계열에만 존재) | 낮 — 설계상 역할 분담으로 보임, 문서화 필요 |
| AI 보강 (업무9) | `confidence<0.5`여도 `rootCause`는 description에 항상 append(impact/recommendation만 유지) | 낮 — `[AI 원인 분석]` 마커로 분리되어 실질 훼손 아님 |
| AI 보강 (업무9) | `analyzeScreenshot`(Visual AI 2차)이 enrich 파이프라인에서 미호출 | 중 — §15 "AI Vision 2차 검토"가 아직 미연결 |
| 앱 QA (업무13) | ROADMAP.md가 "Phase 15 예정"으로 표기하나 실제로는 완료·연결됨(커밋 `23927e5`) | 낮(문서 지연) — 스펙 작성 시 ROADMAP 표기보다 코드/커밋을 근거로 삼아야 함 |
| 웹 탐색 (업무3) | discover.ts 셀렉터 전략이 실질적으로 `testid > href-css > css`이며, 계약 주석의 `role+name` 전략 미구현 | 낮 |

## 부록 B — 채점 정답지 현황 (회귀 기준)

- `packages/fixture-admin/KNOWN_BUGS.md`: 실행 QA 결함 10건, **Phase 3/6 시점 실측 10/10 탐지, 오탐 0건**.
- `packages/fixture-admin/KNOWN_SCREENS.md`: 탐색 정답지 16개 상태(+로그인 1) — 지문 규칙 검증 기준.
- `packages/fixture-src/KNOWN_SOURCE_BUGS.md`: 소스 QA 결함 12건 — 이 중 8건은 실행 QA로 원리적 탐지 불가.
- `packages/fixture-src/KNOWN_ENDPOINTS.md`: 엔드포인트↔소스 매핑 정답지(Spring 컨트롤러 5개).
