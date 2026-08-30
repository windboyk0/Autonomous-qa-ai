# ROADMAP — 바이브코딩 작업 순서

정본 스펙은 [CLAUDE.md](CLAUDE.md). 이 문서는 **무엇을 어떤 순서로 만들 것인가**만 다룬다.

## 원칙 2가지

### A. 엔진 우선, UI 최후
QA 엔진을 먼저 **CLI 프로그램**으로 완성한다. `pnpm qa --url ... --provider ollama` 한 줄로
`report.md`가 나오는 상태를 만든 뒤, Electron은 그 엔진을 감싸는 얇은 껍데기로 붙인다.

이유: Playwright 자율탐색은 수십~수백 회 재실행하며 튜닝하는 작업이다. 그 반복이 매번
Electron 창을 거치면 사이클이 느려지고, 오류 원인이 UI / IPC / 엔진 중 어디인지 분리되지 않는다.

### B. 목(mock) 관리자웹을 0단계에
정답을 아는 테스트 대상(`packages/fixture-admin`)을 먼저 만든다.
탐지율과 오탐률을 **숫자로** 재야 회귀가 가능하다. 이것 없이는 "잘 되는 것 같다" 이상을 판단할 수 없다.

실제 관리자웹은 **Phase 3 이후에만**, 그리고 Read-only로만 접속한다.

---

## Phase 0 — 착지장 ✅

- [x] `git init` + `.gitignore`
- [x] 문서 정리 — `CLAUDE.md` 정본화 / `autonomous-qa.md`·zip → `docs/archive/`
- [x] `agents/*.md` → `.claude/agents/` 이전 + frontmatter + 입출력 스키마
- [x] pnpm 모노레포 스캐폴딩
- [x] `packages/shared` 데이터 계약 (zod)
- [x] `packages/fixture-admin` + 의도적 버그 10개 정답지
- [x] `pnpm install` / `pnpm build` / `pnpm test` 통과 (Node.js 24.19.0)

**DoD** — `pnpm dev:fixture` → `localhost:3100` 목 관리자웹 동작, `pnpm build` 타입 통과,
`packages/fixture-admin/KNOWN_BUGS.md`에 버그 10개 정답지 존재

## Phase 1 — 엔진 CLI: 로그인 + 증적 수집 ✅

- `packages/qa-engine` CLI 진입점 (`--url --user --pass --out`)
- **Login Agent** — 로그인 폼 탐지 → selector 추정 → 성공 판정(URL 변화 + 폼 소멸 + 세션쿠키)
- **Evidence Agent** — `runs/<ts>/`에 screenshot·DOM·ARIA·console·network 기록, 민감헤더 마스킹
- 비밀번호가 로그·evidence·에러메시지 어디에도 남지 않음을 **테스트로 강제**

**DoD 결과 — 통과 (테스트 31건)**

| 검증 | 결과 |
|---|---|
| fixture 로그인 성공 | 신호 3/3 (URL변경·폼소멸·새쿠키) |
| `runs/` 트리 생성 | 6개 하위 디렉터리 + `evidence.json` |
| 증적에 비밀번호 0건 | 통과 (성공·실패 경로 모두) |
| 증적 색인 깨진 링크 | 0건 |
| BUG-02(404) / BUG-04(rejection) 포착 | 통과 |
| 302를 실패로 세지 않음 | 통과 |
| Cookie / Set-Cookie 마스킹 | 통과 |
| 잘못된 비밀번호 → FAILED + 실패 화면 증적 | 통과 |

### Phase 1에서 확정된 설계

- **stateKey는 이벤트 발생 시점이 아니라 `drain()` 시점에 찍는다.**
  클릭 → 이동 → 화면 확정 순서라 이벤트가 터지는 순간에는 어느 화면인지 알 수 없다.
- **`ok`는 `status < 400`.** Playwright의 `res.ok()`는 3xx를 실패로 보는데 리다이렉트는 정상 동작이다.
- **`Failed to load resource` 계열 콘솔 오류는 버린다.** 네트워크 항목과 중복되어
  같은 결함이 Issue 2건으로 세어진다.
- **증적 색인 저장은 `runQa`의 finally에서.** CLI에 두면 엔진을 직접 호출하는
  Phase 5의 Electron과 통합 테스트가 색인을 못 받는다.

## Phase 2 — 자율 탐색 (Read-only) ✅

- [x] **상태 지문** (`fingerprint.ts`) — `pathTemplate + heading + activeTab + dialogTitle + navLabels + structureHash`
- [x] **Action Discovery** (`discover.ts`) — 모달이 열려 있으면 그 안만 훑는다
- [x] **Risk Classifier** (`classify.ts`) — 7단계 우선순위, denylist 최우선
- [x] **Explorer** (`explorer.ts`) — BFS 큐, 3중 실행 게이트, 예산, 세션 복구
- [x] 가드레일: 로그아웃 차단, 외부 도메인 이탈 차단, 예산 4종
- [x] 방문 그래프를 `runs/<ts>/actions/graph.json`으로 기록

**DoD 결과 — 통과 (테스트 78건 누계)**

| 검증 | 결과 |
|---|---|
| `KNOWN_SCREENS.md` 13개 상태 완주 | 통과 (중복 0) |
| 2회 연속 실행 결정성 | 상태·순서·간선·액션결과 **완전 동일** |
| DANGEROUS 액션 실행 | **0건** (실행된 145건 전부 SAFE) |
| 실행 금지 액션 8종 | 전부 사유와 함께 기록 |
| 클릭 실패(FAILED) | 0건 |
| id 폭발 방지 | `/users/:id` 상태 2개 (상세 + 모달) |
| 탭·모달 구별 | `/settings` 3개, dialog 1개 |

### Phase 2에서 확정된 설계

- **쿼리는 지문에서 뺀다.** "키만 넣고 값은 버린다"로 설계했으나 실측에서 깨졌다 —
  검색 버튼은 `?keyword=`, 정렬 헤더는 `?keyword=&sort=&dir=&page=` 를 만들어
  같은 화면이 갈라진다. 자세한 근거는 `KNOWN_SCREENS.md`.
- **구조 해시는 보이는 요소만 · 형제 접기 · 정렬.** 목록 행 수와 페이저 위치에
  흔들리지 않으면서, 스피너만 남은 로딩 화면은 구별한다.
- **링크는 라벨이 아니라 하는 일로 분류한다.** 라벨만 보면 "신규 등록" 링크가
  CAUTION으로 막혀 등록 화면을 영영 못 본다 (실제로 놓쳤다).
- **`<thead>` 안의 링크는 정렬 컨트롤이다.** `권한` 컬럼 헤더가 DANGEROUS로 막혔다.
  단 denylist는 이 규칙보다 위에 있어 여전히 절대적이다 — 커버리지보다 안전.
- **모달이 열려 있으면 그 안만 훑는다.** `<dialog>`는 바깥을 inert로 만들어서,
  모르고 뒤쪽 메뉴를 클릭하면 전부 타임아웃 나고 리포트가 가짜 FAILED로 뒤덮인다.
- **큐는 "도달 방법"을 담는다.** URL + 재생할 클릭 목록. 모달·탭처럼 URL이 없는
  화면도 같은 방식으로 재방문할 수 있고, 재현이 결정적이다.
- **계획 지문에서 id를 접는다.** 목록의 사용자 47명 링크가 전부 큐에 들어가면
  46번은 방문 후 버려진다 — 예산만 태운다.

## Phase 3 — 룰 기반 검출 + 리포트 (AI 없음) ✅

- [x] **룰 검출기** (`detect.ts`) — Network 7종 · Console 4종 · Visual 4종 · Functional 1종
- [x] **화면 계측** (`visual.ts`) — 오버플로·겹침·잘림·가려진 CTA·무한 로딩
- [x] **Issue Judge** (`judge.ts`) — dedupKey 병합, Severity 승격, Priority 점수, 재현 절차 자동 생성
- [x] **Report Writer** (`report.ts`) — `report.md` 17개 목차 + `issues.json`

**DoD 결과 — 통과 (테스트 128건 누계)**

| 검증 | 결과 |
|---|---|
| Phase 3 검출 대상 8건 탐지 | **8/8** |
| 오탐 | **0건** (기준 3건 이하) |
| BUG-02 병합 | 후보 332건 → **Issue 1건 + Evidence 13건 / 12화면** |
| 전체 병합률 | 후보 520건 → Issue 8건 |
| 모든 Issue에 증적 | 통과 (깨진 링크 0) |
| `report.md` 17개 목차 | 전부 채워짐 |
| `issues.json` 스키마 | 통과 |
| AI 없이 리포트 완성 | 통과 (`aiStatus: not_used`) |
| 리포트에 비밀번호 | 0건 |

### Phase 3에서 확정된 설계

- **심각도가 우선순위 대역을 정한다.** 곱셈식만 쓰니 "넓게 퍼짐"이 "심각함"을 덮었다 —
  화면이 아예 안 열리는 HIGH 결함이 P3, 모든 화면에 반복되는 MEDIUM 콘솔 오류가 P0으로 나왔다.
  이제 CRITICAL→P0 / HIGH→P0~P1 / MEDIUM→P1~P2 / LOW→P2~P3 대역 안에서 점수가 순서를 정한다.
- **빈도는 원시 후보 수가 아니라 화면 수로 센다.** 탐색기가 액션마다 되돌아가느라
  같은 404가 후보 332건으로 잡혔다. 사용자가 겪는 빈도는 "몇 개 화면에서 나는가"에 가깝다.
  (`occurrenceCount`는 사실이므로 그대로 두고, 점수 계산에만 화면 수를 쓴다)
- **모달이 열려 있으면 뒤쪽 버튼의 "가려짐"은 정상이다.** 모달 있는 화면마다 오탐이 쏟아진다
  (실측 3건). 지문·탐색과 같은 원칙 — 모달이 열리면 그 안만 본다.
- **로딩 인디케이터는 한 번 더 기다렸다 재확인한다.** 잠깐 뜬 스피너를 무한 로딩으로
  오해하지 않기 위해서다.
- **`captureScreen`이 값을 함께 돌려준다.** 파일을 다시 읽어 파싱하는 경로를 만들면
  마스킹과 인코딩이 두 군데로 갈라진다.
- **증적 없는 후보는 만들지 않는다.** 리포트에서 근거를 댈 수 없는 Issue는 없어야 한다.

## Phase 4 — AI Provider 레이어 ✅

- [x] `AiGuard` — 모든 AI 호출의 안전망. 타임아웃·실패 흡수·상태 집계
- [x] `NoneProvider` → `OllamaProvider` → `ClaudeProvider` 순으로 구현
- [x] zod 검증 + 1회 재시도 + 모델 버릇 흡수(배열 자리의 문자열 등)
- [x] 동시성 상한, 호출당 타임아웃
- [x] 보강 결과를 리포트에 반영 (Executive Summary · 원인 분석 · 기능 누락 후보 · 오탐 표시)

**DoD 결과 — 통과 (테스트 176건 누계)**

| 검증 | 결과 |
|---|---|
| 모든 호출이 터져도 Run 완료 | 통과 |
| **폭발 Provider에서 Issue가 룰 결과와 완전 동일** | 통과 |
| 헬스체크 실패 / 부분 실패에서도 Issue 동일 | 통과 |
| 4개 경로(none·폭발·미설치·불안정) 17개 목차 | 전부 통과 |
| AI 상태 보고 | not_used / failed / degraded 정확 |
| Provider 미설치 시 조치 안내 | 통과 |
| 실제 Ollama 왕복 (`exaone3.5:2.4b`) | **AI 호출 15건 전부 성공** |

### Phase 4에서 확정된 설계

- **잘못된 입력을 주면 모델은 조용히, 자신 있게 잘못된 답을 낸다.**
  네트워크 결함(`/api/stats/export` 500)에 무관한 화면 이동 액션을 넘겼더니
  모델이 "대시보드 네비게이션 문제"라는 그럴듯한 분석을 써냈고, 그게 **올바른
  룰 문장을 덮어썼다.** `FunctionalAnalysisInput.action`을 nullable로 바꾸고
  `finding`(결함의 실제 사실)을 필수로 만들었다. 없으면 없는 채로 넘긴다.
- **확신이 낮으면(< 0.5) 룰 문장을 지킨다.** 검증된 문장을 추측으로 바꾸는 것은
  이 도구의 신뢰를 깎는 쪽이다. 원인 분석은 덧붙이되 영향·권장은 확신이 있을 때만 대체한다.
- **계약은 엄격하게, 어댑터는 관대하게.** exaone 2.4B는 배열 자리에 문자열을 넣는
  습관이 있고 재시도해도 반복한다(실측 5건 실패). 스키마를 느슨하게 푸는 대신
  `parseJson`이 모양을 고쳐 넣는다. 고친 뒤 15건 전부 성공.
- **AI는 탐색이 끝난 뒤에만 돈다.** 탐색 중에 부르면 결정성이 깨지고, 모델이 느릴 때
  브라우저 세션이 하염없이 열려 있게 된다.
- **오탐 판정은 표시만 하고 지우지 않는다.** AI가 틀렸을 때 사람이 되짚을 수 있어야 한다.
- **Vision 미지원 모델은 스크린샷 분석을 거부한다.** 이미지를 보내면 조용히 헛소리를 한다.

## Phase 5 — Electron 셸 ✅

- [x] Main: 엔진을 child process로 실행, stdout JSON Lines → IPC → Renderer
- [x] SQLite(projects / qa_runs / qa_issues) — WASM SQLite
- [x] 자격증명은 `safeStorage`로 암호화, 렌더러에 읽는 경로 없음
- [x] 화면 7개: 프로젝트 / QA설정 / Monitor / Issue / 증적 / 리포트 / History
- [x] 엔진 stdin 제어 채널 (Pause / Resume / Stop)

**DoD 결과 — 통과 (테스트 185건 누계)**

| 검증 | 결과 |
|---|---|
| **클릭만으로 리포트 생성** | 프로젝트 생성 → 설정 → QA 시작 → 리포트까지 통과 |
| 화면에 뜬 리포트가 Phase 3·4와 동일 | 17개 목차 확인 |
| **엔진 비정상 종료 시 UI 생존** | 통과, 실패 Run도 History에 기록 |
| 렌더러가 Node에 직접 접근 | 불가 (`require`·`process` 없음) |
| preload에 자격증명 읽는 API | 없음 |
| 화면·DB에 비밀번호 평문 | 0건 |

### Phase 5에서 확정된 설계

- **main 프로세스는 CJS 번들이어야 한다.** `node_modules/electron`은 실행 파일 경로만
  문자열로 내보내는 npm 셸이고, ESM 해석기는 그쪽을 먼저 찾는다. 그래서 ESM main에서는
  `import { app } from "electron"` 도 `createRequire("electron")` 도 전부 문자열을 받는다
  (실측 확인). esbuild로 CJS 번들을 만들면 Electron이 패치한 `require`가 내장 모듈을 준다.
  `@qa/shared`(ESM)는 번들에 인라인한다 — Phase 7 패키징에도 필요한 단계다.
- **`ELECTRON_RUN_AS_NODE`를 지우고 Electron을 띄운다.** 이 값이 켜져 있으면 Electron이
  순수 Node로 실행되어 앱이 기동조차 못 한다. VS Code 같은 Electron 기반 도구가
  자식 프로세스에 심어두므로 개발 환경에서 조용히 상속된다.
  (반대로 **엔진을 띄울 때는 일부러 켠다** — 사용자 PC에 Node가 없어도 Electron을 Node로 재사용한다)
- **제어 채널의 stdin은 unref한다.** 부모가 연 파이프는 끝나지 않으므로 readline이
  참조를 쥐고 있으면 리포트를 다 쓴 뒤에도 엔진이 종료되지 않는다. 실측에서
  리포트는 나왔는데 화면의 중단 버튼이 영원히 활성 상태로 남았다.
- **네이티브 SQLite를 쓰지 않는다.** Electron 33은 Node 20을 품고 있어 `node:sqlite`가
  없고, better-sqlite3는 Electron ABI에 맞춰 다시 빌드해야 해서 사용자 PC마다
  빌드 도구가 필요해진다. 설치본 하나로 끝나야 하는 제품에 맞지 않는다.
- **증적은 main이 data URL로 넘긴다.** 렌더러에 파일시스템 접근을 주지 않고,
  렌더러가 보낸 상대경로는 `safeJoin`으로 경로 탈출을 막는다.

## Phase 6 — 쓰기 테스트 (CRUD) ✅

- [x] **Test Data Agent** (`testdata.ts`) — `AUTO-QA-yyyyMMdd-HHmmss-SEQ` 대장, 소유권 판정
- [x] **폼 분석** (`forms.ts`) — 필드 종류·필수 여부·저장 버튼 인식
- [x] **CRUD Test Agent** (`crud.ts`) — Create → 검증 탐침 → Update → Delete → Cleanup
- [x] **Functional PASS 판정** = 쓰기 요청 발생 + 2xx + 성공 신호 + 목록 재조회 존재
- [x] fixture에 수정·삭제 경로 추가 (없으면 Update/Delete를 검증할 수 없다)

**DoD 결과 — 통과 (테스트 200건 누계)**

| 검증 | 결과 |
|---|---|
| Create PASS/FAIL 정확 판정 | PASS 1 · FAIL 1 |
| **BUG-06 저장 무반응 → FAIL** | `FUNC-NO-RESPONSE` 로 검출 |
| **BUG-05 검증 누락 → 검출** | `FUNC-VALIDATION-MISSING` (담당자 이메일) |
| Update / Delete | 각 PASS, FAIL 0 |
| **cleanup 후 잔여 `AUTO-QA-*`** | **0건** (fixture API로 직접 확인) |
| 정답지 10건 전체 | **10/10 탐지** |

### Phase 6에서 확정된 설계

- **`edit` 경로를 등록 화면으로 착각하면 실데이터가 수정된다.** 실측에서
  `/surveys/:id/edit` 을 Create 대상으로 잡아 **기존 시드 데이터를 수정해 버렸다.**
  경로 패턴에서 `edit` 를 빼고, 그것만으로는 부족하므로 **폼에 이미 값이 들어 있고
  그것이 AUTO-QA 표식이 아니면 건드리지 않는** 2차 방어를 넣었다.
  이름만 등록처럼 보이는 화면이 실제 관리자웹에 있다.
- **필수 필드를 하나씩만 비운다.** 한 번에 여러 개를 비우면 어느 필드의 검증이
  빠졌는지 특정할 수 없다. 폼당 최대 3개까지 탐침한다 — 탐침마다 레코드가 쌓인다.
- **재조회 확인이 없으면 "UI만 성공"을 못 잡는다.** 토스트만 띄우고 저장은 안 되는
  화면이 실제로 흔하다. 목록을 다시 열어 표식을 찾는 단계를 반드시 거친다.
- **삭제 동의가 없으면 정리도 하지 않는다.** 사용자가 삭제를 허용하지 않았는데
  뒷정리를 핑계로 지우면 안 된다. 대신 남은 데이터를 **식별자와 함께** 리포트에 남긴다.
- **Update·Delete 대상은 대장에 있고 화면에서 표식이 확인된 것만.** 목록의
  "첫 번째 행"을 대상으로 삼는 코드는 쓰지 않는다.

## Phase 7 — 패키징 ✅

- [x] electron-builder NSIS (`electron-builder.yml`)
- [x] **Chromium 방침 확정 — 풀 크로미움 동봉**
- [x] 자산 스테이징 (`scripts/stage-resources.mjs`) — 엔진 번들 + playwright + 브라우저
- [x] 무인 설치 후 실제 구동 검증

**DoD 결과 — 통과 (테스트 207건 누계)**

| 항목 | 값 |
|---|---|
| 설치 파일 | **196 MB** (LZMA) |
| 설치 후 크기 | 726 MB (browsers 438 · Electron 180 · engine 18) |
| 설치 소요 | **12초** |
| **설치 후 QA 완료까지** | **42초** (기준 5분) |
| Node.js 필요 | 없음 |
| Playwright 캐시 필요 | 없음 |

### Chromium 방침 — 풀 크로미움만 동봉

실측으로 셋을 비교했다.

| 방식 | 원본 | 헤드풀 | 폐쇄망 |
|---|---|---|---|
| 헤드리스 셸만 | 272MB | ✗ | ✗ |
| **풀 크로미움만** | **428MB** | **✓** | **✓** |
| 둘 다 | 700MB | ✓ | ✓ (낭비) |

**헤드리스 셸을 넣지 않는다.** `channel: "chromium"` 을 지정하면 풀 크로미움 하나로
헤드리스·헤드풀을 모두 처리한다. 셸이 주는 것은 용량과 기동 속도뿐이고,
레이아웃 계측값은 셋 다 동일했다(실측) — 검출 결과가 달라지지 않는다.

**헤드풀이 필요한 이유**는 셋이다.
1. **SSO·2FA·캡차 — 사람이 직접 로그인해야 하는 대상.** 헤드리스로 대체 불가능하다.
   사내 관리자웹은 SSO가 흔하다.
2. 도입 초기의 관찰·신뢰. CLAUDE.md §23이 "초기 버전은 Headed 기본 권장"이라 한 이유다.
3. 탐색이 어긋났을 때의 디버깅.

셸만 넣어 아끼는 156MB의 대가가 "스펙 권장 기본 모드가 설치 직후엔 불가 + SSO 대상은
아예 검사 불가"이고, 그 부족분을 메울 다운로드가 막히는 폐쇄망이 이 도구의 주 타깃이다.

### Phase 7에서 확정된 설계

- **엔진 번들에 `package.json { "type": "commonjs" }` 를 박는다.** CJS 번들인데
  확장자가 `.js` 라, 상위 `apps/desktop/package.json` 의 `"type": "module"` 에 걸려
  `require is not defined in ES module scope` 로 죽었다(실측).
- **`@qa/shared` 를 desktop의 `dependencies` 에서 뺀다.** esbuild가 인라인하므로
  런타임에 필요 없는데, 남겨 두면 electron-builder가 워크스페이스 심볼릭 링크를
  따라가 앱 폴더 밖 파일을 asar에 넣으려다 실패한다.
- **엔진과 브라우저는 asar 밖(`extraResources`)에 둔다.** 자식 프로세스가 실제
  파일 경로로 접근해야 한다.
- **증적은 `userData` 에 쓴다.** 프로그램 폴더는 쓰기 권한이 없을 수 있고
  재설치 때 지워진다. 엔진 spawn 시 작업 디렉터리를 밖에서 정해 준다.
- **검증용 설치본을 `%TEMP%` 에 두지 않는다.** 700MB짜리가 디스크 정리 대상이 되어
  설치 직후 폴더가 통째로 비워진 적이 있다(실측).

### 남은 것

- **코드 서명.** 지금은 서명하지 않아 SmartScreen 경고가 뜬다.
  사내 배포 정책(인증서 보유 여부)이 정해지면 `win.certificateFile` 을 붙인다.
- **아이콘.** 기본 Electron 아이콘을 쓴다.
- **다른 물리 PC에서의 설치 검증.** 이번 검증은 같은 PC에서 Node를 `PATH`에서 제거하고
  `PLAYWRIGHT_BROWSERS_PATH` 를 지운 환경으로 대신했다. 완전한 클린 PC 검증은 아니다.

---

# 2부 — 소스 QA로 확장 (Phase 8 ~ 12)

브라우저 QA와 소스 QA는 **찾는 문제가 다르다.**

| | 잘 찾는 것 | 원리적으로 못 찾는 것 |
|---|---|---|
| 실행 QA (1부) | 실제 화면, CRUD 성패, API 실패, Console, UX | 권한 검사 누락, 예외 삼킴, SQL 조립, 안 불리는 코드 |
| 소스 QA (2부) | 권한·예외·주입·의존성·구조 | 실제로 그 화면이 뜨는지, 그 버튼이 동작하는지 |

1부는 "무엇이 잘못됐나"까지 간다. 2부의 목표는 **"어느 파일 몇 번째 줄을 고쳐야 하나"**다.

## 2부의 전제 — 이미 갖춰진 것

새로 만드는 것은 **후보 생성기 하나**뿐이다. 나머지는 1부의 것을 그대로 쓴다.

```
IssueCandidate[] → judge(dedup·severity·priority) → Issue[] → report.md
        ↑                                                          ↑
   여기만 추가한다                                    이 뒤는 전부 재사용
```

Worker 격리, `EngineEvent` JSON Lines, Pause/Stop, 증적 트리, 리포트 17장 목차도 그대로다.

## Phase 8 — 소스 fixture와 정답지 ✅

- [x] `packages/fixture-src/project` — 의도적 결함 12건 (Spring Boot 3 + React 18)
- [x] `KNOWN_SOURCE_BUGS.md` + `src/known-bugs.ts` — 결함 정답지
- [x] `KNOWN_ENDPOINTS.md` + `src/known-endpoints.ts` — 엔드포인트·호출지점 정답지
- [x] 앵커 방식 — 줄 번호를 손으로 적지 않는다

**DoD 결과 — 통과 (테스트 258건 누계)**

| 검증 | 결과 |
|---|---|
| 결함 12건이 실제 파일의 **정확히 한 줄**로 특정 | 12/12 |
| 엔드포인트 5건 · 호출지점 3건 특정 | 8/8 |
| 실행 QA가 원리적으로 못 찾는 결함이 과반 | **8 / 12** |
| 문서 정답지와 코드 정답지 개수 일치 | 일치 |

### Phase 8에서 확정된 설계

- **정답지에 줄 번호를 손으로 적지 않는다.** 그 줄에만 나타나는 문자열(앵커)로 특정하고
  줄 번호는 읽을 때 찾는다. 앵커가 0줄이거나 2줄 이상이면 테스트가 깨진다.
  손으로 적으면 fixture를 한 줄 고칠 때마다 정답지 전체가 조용히 낡는다.
- **미열람 대상은 정답지에 넣지 않는다.** `secrets.properties` 는 스캐너가 값을
  읽어서는 안 되는 파일이고, 그것이 결함으로 보고되면 **그게 오탐**이다.
  대신 `application-prod.yml` 의 평문 비밀번호(SRC-05)는 **키 이름만으로** 보고할 수 있다 —
  값을 읽을 이유가 없다는 것을 보이는 사례다.
- **주석을 읽고 정답을 맞히는 것은 부정행위다.** fixture 소스에는 `SRC-xx` 주석이 있다.
  검출기가 이를 근거로 삼으면 안 되며, Phase 9에서 확인하는 테스트를 둔다.
- **12건 중 8건이 실행 QA로 원리적으로 못 찾는 것**이어야 모드를 나눈 의미가 있다.
  이 비율 자체를 테스트로 못박았다.

**왜 먼저인가.** 1부에서 `fixture-admin` + `KNOWN_BUGS.md` 가 없었으면 탐지율도
오탐률도 잴 수 없었다. 소스 QA도 똑같다. 정답지 없이 만든 검출기는 채점이 안 되고,
채점이 안 되면 회귀도 없다.

## Phase 9 — Project Scanner + Source QA (정적만, 실행 없음) ✅

- [x] **Project Scanner** (`source/scan.ts`) — 스택 판별, 예산, 산출물 제외
- [x] **시크릿 정책** (`source/secrets.ts`) — presence-only / keys-only / read 3단계
- [x] **Security Analyzer** (`source/endpoints.ts`) — 권한 검사 누락
- [x] 좁고 정밀한 룰 7종 (`source/rules.ts`)
- [x] `mode` · `source` · `codeRefs` 계약 추가, 리포트에 "관련 소스"
- [x] Electron 에 모드 선택 + 폴더 선택

**DoD 결과 — 통과 (테스트 292건 누계)**

| 검증 | 결과 |
|---|---|
| 정답지 탐지 | **11 / 12** (SRC-12 의존성은 범위 밖으로 명시) |
| 오탐 | **0건** |
| 실행 QA 가 못 찾는 결함 | 7/7 전부 탐지 |
| 시크릿 값 유출 | 후보·증적·리포트 전부 0건 |
| 주석을 지워도 같은 결과 | 동일 |

### Phase 9에서 확정된 설계

- **외부 도구를 실행하지 않는다.** 원래 계획은 ESLint·Semgrep 을 오케스트레이션하는
  것이었으나, 그 도구들은 대상 프로젝트의 설정 파일(그 자체가 실행 가능한 코드다)을
  읽어야 돌아간다. §9 의 "동의 없이 실행하지 않는다" 와 정면으로 충돌하므로
  Phase 12 로 옮겼다. 대신 **좁고 정밀한 룰만** 둔다 — 판단 기준은
  "fixture 에서 오탐 0 을 낼 만큼 모양이 분명한가" 하나다.
- **권한 검사 누락은 형제가 보호되어 있을 때만 보고한다.** 아무도 애너테이션을
  쓰지 않는 프로젝트는 필터나 SecurityConfig 로 일괄 처리하는 것이 보통이고,
  그때 전부를 결함으로 올리면 오탐이 쏟아진다. 형제 중 일부만 빠진 것은 **빠뜨린 것**이다.
- **룰은 주석을 지운 텍스트만 본다.** 실측에서 `// res.ok 를 확인하지 않는다` 라는
  주석 때문에 룰이 "이 함수는 res.ok 를 확인한다"고 판단해 결함을 놓쳤다.
  반대로 fixture 주석의 `SRC-02` 를 근거로 정답을 맞히면 채점이 거짓말이 된다.
- **시크릿은 값을 읽지 않는다.** 키 이름과 값의 *모양*(`env-ref` / `literal`)만 본다.
  `readYamlKeyPaths` 의 반환 타입에 값이 없다는 것이 그 보장이며 테스트가 확인한다.
- **시크릿을 담으라고 만든 파일은 결함 대상이 아니다.** `secrets.properties` 에
  값이 있는 것은 그 파일의 목적이다. 문제는 일반 설정 파일에 값이 박히는 것이다.
- **소스 QA 는 브라우저를 띄우지 않는다.** `preflightBrowser()` 를 먼저 부르면
  Chromium 이 없는 환경에서 소스 QA 조차 시작하지 못한다.

**직접 만드는 검출기는 하나뿐이다.** `Optional.get()`, 빈 catch, SQL Injection 은
ESLint·SpotBugs·Semgrep 이 훨씬 잘한다. 정규식으로 흉내 내면 오탐이 쏟아지고,
오탐이 쏟아지면 리포트를 아무도 보지 않는다. Phase 3 의 "오탐 3건 이하" 기준이
그대로 살아 있다.

**권한 검사 누락만 직접 만든다.** 이유가 있다 — **실행 QA는 이것을 원리적으로 못 본다.**
`승인`·`권한변경`·`삭제`가 전부 DANGEROUS 로 차단되기 때문이다
(실측: `권한관리` 16회 발견 / 0회 실행). 관리자웹에서 가장 비싼 결함이고,
소스에서만 볼 수 있다.

## Phase 10 — Change Impact QA (git diff)

- [ ] **Git Change Impact Agent** — 변경 파일 → 영향 엔드포인트 → 영향 화면
- [ ] 탐색 우선순위 조정 (영향 화면부터) 또는 범위 한정
- [ ] 리포트에 "이번 변경이 닿는 영역" 절 추가

**DoD**: 변경된 파일에 대응하는 화면이 탐색 큐 앞쪽에 온다. 대응이 없으면 그 사실을 적는다.

**Integrated 보다 먼저 하는 이유.** 매퍼의 약한 버전을 싼값에 검증할 수 있다.
여기서 매핑이 부정확하면 Phase 11 은 성립하지 않으므로 미리 걸러진다.
그리고 실행 시간이 줄어 실제 통증(실사이트 243초)이 바로 해소된다.

## Phase 11 — API ↔ Source Mapper + 통합 Root Cause

- [ ] **API-Source Mapper Agent** — 엔드포인트 → 컨트롤러 파일·줄
- [ ] **Root Cause Agent** — 실행 증적 + 소스 스니펫을 묶어 AI 에 넘김
- [ ] 리포트 이슈에 "관련 소스" 블록

**DoD**: fixture 에서 화면 오류 1건이 컨트롤러 파일·줄까지 연결된다. 매핑 실패 시 추정임을 명시한다.

**호출 그래프를 만들지 않는다.** 엔드포인트 → 컨트롤러는 어노테이션 문자열 매칭이라
정확하다(`@PostMapping` + 클래스 레벨 prefix, Express `router.post`).
그러나 Controller → Service → Repository 의 정확한 호출 그래프는 컴파일러 없이
만들 수 없다. 컨트롤러 파일과 **그 파일이 import·주입하는 것들**까지만 묶어
AI 에 넘기고, 인과 추론은 AI 가 한다. `codeRefs` 의 `confidence` 로
확정과 추정을 구분한다.

## Phase 12 — 빌드 / 테스트 실행 (동의 기반)

- [ ] **Build/Test Agent** — 프로젝트에서 명령 자동 판별
- [ ] 프로젝트별 명령 동의 저장
- [ ] 실행 결과를 후보로 변환 (실패한 테스트 = 이슈)

**DoD**: 동의 없이는 아무 명령도 실행되지 않는다. 실행할 명령 전문이 동의 화면에 그대로 보인다.

**마지막에 두는 이유.** 위험은 가장 크고 차별점은 가장 작다 — 개발자는 이미
`npm test` 를 돌린다. 그리고 **Windows 에는 진짜 샌드박스가 없다.**
컨테이너 없이 `npm test` 를 돌리면 그 프로젝트의 임의 코드가 사용자 권한으로 실행된다.
`npm install` 은 하지 않는다. 통제 수단은 샌드박스가 아니라
**"실행할 명령 전문을 보여주고 프로젝트별로 동의를 받는 것"** 이며, 이 한계를 숨기지 않는다.

## 2부의 순서를 이렇게 잡은 이유

구상 단계에서는 Build/Test 가 중간에, Integrated 가 Change Impact 보다 앞에 있었다.
바꾼 근거는 위 각 Phase 에 적었다. 요약하면 **채점 가능성(8) → 위험 없는 것(9) →
싸게 검증되는 것(10) → 그 위에 얹는 것(11) → 위험한 것(12)** 순이다.

---

## 운영 규칙

- Phase당 브랜치 1개. **DoD를 테스트로 먼저 작성**한 뒤 구현한다.
- 매 Phase는 fixture 대상 회귀 실행으로 마감. 탐지율/오탐률이 떨어지면 머지 금지.
- 한 번에 한 에이전트씩. 여러 에이전트 동시 구현 금지.
- 실제 관리자웹 접속은 Phase 3 이후, Read-only만.
