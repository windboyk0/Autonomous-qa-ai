# Electron 관리자웹 자율 QA 시스템

Windows에 설치해서 쓰는 관리자웹 자율 QA 도구.
URL / 로그인정보 / AI Provider / CRUD 범위만 입력하고 `QA 시작`을 누르면
Playwright가 자율 탐색하며 증적을 모으고, `report.md` + `issues.json`을 만든다.

## 문서

| 문서 | 역할 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **무엇을 만드는가** — 요구사항·정책·판정기준 정본 |
| [ROADMAP.md](ROADMAP.md) | **어떤 순서로 만드는가** — Phase별 범위와 DoD |
| [.claude/agents/](.claude/agents/) | 역할별 에이전트 정의 15개 |
| [packages/shared/src/](packages/shared/src/) | 데이터 계약 (zod) — 모든 모듈이 여기 타입으로 대화한다 |

## 구조

```
packages/
  shared/         데이터 계약. RunConfig · PageState · Action · Evidence · Issue · EngineEvent
  qa-engine/      QA 엔진. Playwright 탐색 + 검출 + 리포트
                  cli.ts 인자파싱 · run.ts Run본체
                  login.ts · collector.ts · capture.ts (증적)
                  fingerprint.ts · discover.ts · classify.ts · explorer.ts (탐색)
                  visual.ts · detect.ts · judge.ts · report.ts (검출·리포트)
                  forms.ts · testdata.ts · crud.ts (쓰기 테스트)
                  ai/ (Provider 추상화 · 실패 폴백)
  fixture-admin/  정답을 아는 목 관리자웹. 의도적 버그 10개
apps/
  desktop/        Electron 셸. 엔진을 자식 프로세스로 띄우고 이벤트를 중계한다
```

## 현재 상태

**Phase 7 완료 — 전 단계 완주.** Electron 앱에서 **클릭만으로** 로그인 → 자율 탐색 → 룰 검출 → 쓰기 테스트 → AI 보강 → `report.md` 까지 동작한다.
fixture 대상 14개 화면을 결정적으로 완주하고, **정답지 10건을 전부** 오탐 0건으로 탐지한다.
쓰기 테스트(Create·Update·Delete)와 테스트 데이터 자동 정리까지 동작한다.
AI Provider(Ollama·Claude)를 붙였고, **AI가 죽어도 룰 기반 리포트는 그대로** 나온다.
**Windows 설치본(NSIS)까지 완료.** 설치 파일 196MB, 설치 후 Node.js·인터넷 없이 동작한다.

## 시작하기

사전 요구: **Node.js 20.11 이상**

```bash
corepack enable
pnpm install
pnpm exec playwright install chromium   # 최초 1회
pnpm build
```

목 관리자웹 띄우기:

```bash
pnpm dev:fixture     # http://localhost:3100  (admin / admin123!)
```

엔진 실행:

```powershell
$env:QA_PASSWORD = 'admin123!'
pnpm qa --url http://localhost:3100 --user admin --headless

# 쓰기 테스트까지 (삭제는 별도 동의 필요)
pnpm qa --url http://localhost:3100 --user admin --headless `
        --create --update --delete --delete-consent --form-validation
```

결과는 `runs/<yyyyMMdd_HHmmss>/` 에 쌓인다 — `screenshots/` `dom/` `aria/`
`network/` `console/` `actions/` 와 증적 색인 `evidence.json`.

비밀번호는 `QA_PASSWORD` 환경변수 > `--pass-stdin` > `--pass` 순으로 찾는다.
`--pass`는 셸 히스토리와 프로세스 목록에 평문으로 남아 경고가 나온다.

AI 보강을 켜려면 (선택):

```powershell
# 로컬 Ollama
pnpm qa --url http://localhost:3100 --user admin --headless `
        --provider ollama --model qwen3.5:9b

# Claude Code CLI (설치·로그인 필요)
pnpm qa --url http://localhost:3100 --user admin --headless --provider claude
```

**AI는 덧붙이기만 한다.** Provider가 없거나 죽어도 룰 기반 `report.md`는 그대로 나온다.

## Electron 앱으로 쓰기

```bash
pnpm --filter @qa/desktop start
```

프로젝트 생성 → URL·계정 입력 → `QA 시작` 만 누르면 됩니다. 비밀번호는 OS 자격증명
저장소로 암호화해 보관하고, 실행 중에는 진행 상황과 화면 스크린샷을 실시간으로 봅니다.

기동이 안 되면 [apps/desktop/README.md](apps/desktop/README.md)의
`ELECTRON_RUN_AS_NODE` 항목을 먼저 확인하세요.

테스트:

```bash
pnpm test
```

## 왜 fixture부터인가

탐지율과 오탐률을 **숫자로** 재지 못하면 "잘 되는 것 같다" 이상을 판단할 수 없다.
[KNOWN_BUGS.md](packages/fixture-admin/KNOWN_BUGS.md)가 채점 정답지고,
[KNOWN_SCREENS.md](packages/fixture-admin/KNOWN_SCREENS.md)가 탐색 정답지다.
매 Phase는 이 둘에 대한 회귀 실행으로 마감한다.

## 안전

- 삭제·권한변경·발송·일괄처리는 기본 차단. Delete는 `--delete-consent` 없이 실행되지 않는다
- 수정·삭제 대상은 QA가 만든 `AUTO-QA-*` 데이터로 한정
- 비밀번호·토큰은 로그·증적·리포트 어디에도 남지 않는다
- 실제 관리자웹은 Read-only(기본)로 먼저 접속하고, 쓰기 테스트는 필요할 때만 켠다
- 등록 화면처럼 보여도 **기존 데이터가 들어 있는 폼은 건드리지 않는다**

## 설치본 만들기

```bash
pnpm --filter @qa/desktop package
```

`apps/desktop/release/` 에 NSIS 설치 파일이 생긴다 (약 196MB).
설치 후에는 **Node.js도 인터넷도 필요 없다** — 풀 크로미움을 동봉한다.
자세한 내용은 [apps/desktop/README.md](apps/desktop/README.md).
