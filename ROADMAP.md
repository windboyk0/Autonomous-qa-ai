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

## Phase 0 — 착지장

- [x] `git init` + `.gitignore`
- [x] 문서 정리 — `CLAUDE.md` 정본화 / `autonomous-qa.md`·zip → `docs/archive/`
- [x] `agents/*.md` → `.claude/agents/` 이전 + frontmatter + 입출력 스키마
- [x] pnpm 모노레포 스캐폴딩
- [x] `packages/shared` 데이터 계약 (zod)
- [x] `packages/fixture-admin` + 의도적 버그 10개 정답지
- [ ] `pnpm install` / `pnpm build` 통과 **(Node.js 설치 필요)**

**DoD** — `pnpm dev:fixture` → `localhost:3100` 목 관리자웹 동작, `pnpm build` 타입 통과,
`packages/fixture-admin/KNOWN_BUGS.md`에 버그 10개 정답지 존재

## Phase 1 — 엔진 CLI: 로그인 + 증적 수집

- `packages/qa-engine` CLI 진입점 (`--url --user --pass --out`)
- **Login Agent** — 로그인 폼 탐지 → selector 추정 → 성공 판정(URL 변화 + 폼 소멸 + 세션쿠키)
- **Evidence Agent** — `runs/<ts>/`에 screenshot·DOM·ARIA·console·network 기록, 민감헤더 마스킹
- 비밀번호가 로그·evidence·에러메시지 어디에도 남지 않음을 **테스트로 강제**

**DoD** — fixture 로그인 성공, `runs/` 트리 생성, `grep -r "<비밀번호>" runs/` 결과 0건

## Phase 2 — 자율 탐색 (Read-only)

- **State fingerprint 확정**: `URL경로 + h1 + 활성탭 + 다이얼로그유무 + 주요영역 태그구조 해시`
  (텍스트 값은 제외 — 데이터가 바뀔 때마다 새 화면으로 오인하는 것을 막는다)
- Action Discovery → Risk Classifier(**SAFE만 실행**) → 실행 → 상태변화 감지 → 큐
- 가드레일: 로그아웃 링크 차단, 외부 도메인 이탈 차단, **예산**(최대 화면 N / 시간 T / 깊이 D)
- 방문 그래프를 `runs/<ts>/graph.json`으로 기록

**DoD** — `KNOWN_SCREENS.md`의 화면을 전부, 중복 없이, 예산 내 탐색.
**2회 연속 실행 결과가 동일**(결정성)

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
