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

## Phase 3 — 룰 기반 검출 + 리포트 (AI 없음)

- Console / Network / Visual **룰 검출기** → `IssueCandidate`
- Dedup(엔드포인트 + 상태코드 + 에러시그니처 + 셀렉터), Severity 매핑, Priority 점수
- `report.md` + `issues.json` 생성기 (CLAUDE.md §25 목차 그대로)

**DoD** — `KNOWN_BUGS.md` 10개 중 **8개 이상 탐지, 오탐 3개 이하**.
이 시점에 AI 없이 이미 제품 가치가 성립한다.

## Phase 4 — AI Provider 레이어

- `AiProvider` 인터페이스 + 모든 입출력 zod 스키마 (파싱 실패 시 1회 재시도 후 폐기)
- **OllamaProvider 먼저** (로컬·무료·반복 가능) → 그다음 ClaudeProvider
  (`claude -p` PoC, preflight로 Claude Code 설치·로그인 감지)
- 타임아웃 / 동시성 상한 / **실패 시 Phase 3 결과를 그대로 유지**

**DoD** — `--provider ollama|claude` 둘 다 동일 구조의 report 산출.
**Provider를 강제로 실패시켜도 Phase 3 리포트가 손실 없이 나온다.**

## Phase 5 — Electron 셸

- Main: 엔진을 child process로 실행, stdout 이벤트 스트림 → IPC → Renderer
- SQLite(projects / runs / issues), 자격증명은 `safeStorage`
- 화면은 18개 전부가 아니라 **6개만**: 프로젝트 / QA설정 / Monitor / Issue목록·상세 / Evidence·Screenshot / Report

**DoD** — 클릭만으로 Phase 4와 **동일한** `report.md` 생성. 엔진 크래시가 UI를 죽이지 않음

## Phase 6 — 쓰기 테스트 (CRUD)

- Test Data Agent (`AUTO-QA-yyyyMMdd-HHmmss-SEQ`) → Form 분석 → Create
- **Functional PASS 판정** = POST 2xx + Toast + 목록 재조회 존재
- Create 안정화 후 Update, 마지막에 Delete(별도 명시적 동의 + QA 생성 데이터 한정)
- Cleanup, 실패 시 Warning 기록

**DoD** — fixture에서 Create PASS/FAIL 정확 판정(BUG-06 저장 무반응을 FAIL로 검출),
cleanup 후 잔여 `AUTO-QA-*` 데이터 0건

## Phase 7 — 패키징

- electron-builder NSIS
- **Playwright Chromium 처리 방침 확정** — 동봉(설치본 +150MB) vs 최초 실행 시 다운로드.
  여기서 대부분 막히므로 Phase 7 착수 시 이것부터 결정한다.
- 클린 PC 설치 테스트

**DoD** — 다른 PC에서 설치 후 5분 이내 QA 시작 성공

---

## 운영 규칙

- Phase당 브랜치 1개. **DoD를 테스트로 먼저 작성**한 뒤 구현한다.
- 매 Phase는 fixture 대상 회귀 실행으로 마감. 탐지율/오탐률이 떨어지면 머지 금지.
- 한 번에 한 에이전트씩. 여러 에이전트 동시 구현 금지.
- 실제 관리자웹 접속은 Phase 3 이후, Read-only만.
