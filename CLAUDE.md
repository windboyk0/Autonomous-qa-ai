# CLAUDE.md
# Electron 기반 관리자웹 자율 QA 테스트 시스템

## 문서 지도

| 문서 | 역할 |
|---|---|
| `CLAUDE.md` (이 문서) | **무엇을 만드는가.** 요구사항·정책·판정기준의 정본 |
| `ROADMAP.md` | **어떤 순서로 만드는가.** Phase별 범위와 DoD |
| `.claude/agents/*.md` | 역할별 에이전트 정의 (입출력·판정규칙·금지사항) |
| `packages/shared/src/*.ts` | **데이터 계약.** 모든 모듈이 여기 타입으로 대화한다 |
| `packages/fixture-admin/KNOWN_BUGS.md` | 탐지 채점 정답지 |
| `packages/fixture-admin/KNOWN_SCREENS.md` | 탐색 채점 정답지 |
| `docs/archive/` | 참고용 원본 스냅샷. **스펙 아님** |

## 0. 목적

이 프로젝트는 Windows PC에 설치 가능한 Electron 기반 관리자웹 자율 QA 도구를 구현한다.

도구는 **세 가지 모드**로 동작한다 (§2-1).

| 모드 | 입력 | 답하는 질문 |
|---|---|---|
| 실행 QA | URL + 계정 | 화면이 실제로 동작하는가 |
| 소스 QA | 프로젝트 폴더 | 코드에 무엇이 빠져 있는가 |
| 통합 QA | 폴더 + URL + 계정 | **어느 파일 몇 번째 줄을 고쳐야 하는가** |

사용자는 프로그램 화면에서 아래만 입력한다.

- 대상 URL
- 로그인 ID / Password
- AI Provider: Claude Max 또는 Ollama
- 테스트 범위: Create / Read / Update / Delete
- 추가 테스트: 화면/UX, Console, Network/API, Form Validation, Table/Search/Sort/Paging, Screenshot 검토
- Safety Policy

그 후 `QA 시작` 버튼을 누르면 Playwright가 관리자웹을 자율 탐색하고 증적을 수집한 뒤 AI 분석을 거쳐 최종 `report.md`와 `issues.json`을 생성한다.

## 1. 최종 사용자 흐름

```text
프로그램 설치
  ↓
프로젝트 생성
  ↓
URL 입력
  ↓
로그인정보 입력
  ↓
Claude Max / Ollama 선택
  ↓
CRUD 테스트 범위 선택
  ↓
Safety Policy 선택
  ↓
QA 시작
  ↓
Playwright 자율탐색
  ↓
Screenshot/DOM/ARIA/Console/Network 수집
  ↓
기능검증
  ↓
AI 분석
  ↓
Issue 중복제거/심각도/우선순위
  ↓
report.md
```

## 2. 테스트 대상

지원 대상:

- localhost
- 127.0.0.1
- 사내 개발 서버
- QA 서버
- Staging
- HTTPS 개발 URL

주의: 다른 PC에서 프로그램을 실행할 때 `localhost`는 그 PC 자체를 의미한다. 다른 PC의 로컬 서버를 테스트하려면 해당 서버가 LAN에서 접근 가능해야 한다.

## 2-1. QA 모드

브라우저 QA와 소스 QA는 **찾는 문제가 다르다.** 하나로 뭉뚱그리면 둘 다 얕아진다.

```
                     Autonomous QA
                          │
        ┌─────────────────┼─────────────────┐
     실행 QA            소스 QA           통합 QA
   URL + 계정         프로젝트 폴더      폴더 + URL
        │                 │                 │
   Playwright         정적 분석         양쪽 연계
   CRUD / Visual      권한 / 예외       Root Cause
   Console / Network  의존성 / 구조     소스 추적
        └─────────────────┼─────────────────┘
                          │
                   Change Impact QA
                     git diff → 변경 영향 화면 우선
```

### 모드별로 원리적으로 못 찾는 것

이 표가 모드를 나누는 이유의 전부다.

| 모드 | 원리적으로 못 찾는 것 | 이유 |
|---|---|---|
| 실행 QA | 권한 검사 누락, 예외 삼킴, SQL 조립 | 위험 액션은 **차단이 정답**이라 실행되지 않는다 |
| 소스 QA | 화면이 실제로 뜨는지, 버튼이 동작하는지 | 코드가 맞아도 런타임은 틀릴 수 있다 |

실측 근거: 실행 QA에서 `🔐권한관리` 16회 발견 / **0회 실행**, `✅승인함` 16회 발견 /
0회 실행. 차단은 성공이지만, 그래서 그 영역은 소스로만 볼 수 있다.

### Change Impact QA

별도 모드가 아니라 **위 세 모드 위에 얹는 범위 한정기**다.
Git 저장소면 최근 변경 파일 → 영향 엔드포인트 → 영향 화면을 뽑아 탐색 우선순위를 조정한다.

## 3. 권장 기술스택

### Desktop
- Electron
- React
- TypeScript
- Vite
- Tailwind CSS
- Zustand 또는 Redux Toolkit

### QA Engine
- Playwright Node API
- TypeScript
- Worker Thread 또는 Child Process

### Local DB
- SQLite

### Packaging
- electron-builder
- Windows NSIS

## 4. 전체 아키텍처

```text
Electron Renderer
  ├─ Dashboard
  ├─ 프로젝트
  ├─ QA 실행설정
  ├─ 실행 Monitor
  ├─ Issue Viewer
  ├─ Evidence Viewer
  └─ Report Viewer
       │ IPC
       ▼
Electron Main
  ├─ Credential Manager
  ├─ SQLite
  ├─ QA Orchestrator
  ├─ Playwright Manager
  ├─ AI Provider Manager
  └─ Report Manager
       │
       ├─────────────► QA Worker
       │                ├─ Explorer
       │                ├─ CRUD Test
       │                └─ Evidence
       │
       └─────────────► AI Worker
                        ├─ Claude Max
                        └─ Ollama
```

## 5. AI Provider Layer

AI Provider는 반드시 추상화한다.

```ts
interface AiProvider {
  healthCheck(): Promise<ProviderStatus>;
  analyzePage(input: PageAnalysisInput): Promise<PageAnalysisResult>;
  analyzeFunction(input: FunctionalAnalysisInput): Promise<FunctionalAnalysisResult>;
  analyzeScreenshot(input: VisualAnalysisInput): Promise<VisualAnalysisResult>;
  judgeIssues(input: IssueJudgeInput): Promise<IssueJudgeResult>;
  generateReport(input: ReportInput): Promise<string>;
}
```

구현체:

- ClaudeMaxProvider
- OllamaProvider
- 향후 AnthropicApiProvider
- 향후 OpenAIProvider

AI Provider가 실패해도 Playwright Evidence 수집은 중단하지 않는다.

### AI에게 주는 입력의 원칙

**잘못된 입력을 주면 모델은 조용히, 자신 있게 잘못된 답을 낸다.**
실측에서 네트워크 결함에 무관한 화면 이동 액션을 입력으로 넘겼더니 모델이 그
액션에 대한 그럴듯한 분석을 써냈고, 그것이 올바른 룰 문장을 덮어썼다.

- 관련 없는 컨텍스트를 "빈칸을 채우려고" 넣지 않는다. 없으면 null로 넘긴다.
- 결함의 **실제 사실**(룰 id, 제목, 관측 내용, 발생 화면)을 필수로 준다.
- AI 응답의 `confidence < 0.5` 면 룰이 만든 문장을 유지한다.
  검증된 문장을 추측으로 바꾸는 것은 신뢰를 깎는 쪽이다.

### 계약은 엄격하게, 어댑터는 관대하게

작은 로컬 모델은 배열 자리에 문자열 하나를 넣는 등의 버릇이 있고 재시도해도 반복한다.
스키마를 느슨하게 푸는 대신 Provider 어댑터가 모양을 고쳐 넣는다.

## 6. Claude Max 연결

PoC:
- Claude Code CLI `claude -p`

제품화 권장:
- Claude Agent SDK

원칙:
- 사용자의 Claude 인증을 사용
- 인증정보 하드코딩 금지
- QA 프로그램에서 Claude Max를 공용 API 키처럼 내장하지 않음

## 7. Ollama 연결

기본 URL:

```text
http://localhost:11434
```

기능:
- Health Check
- 설치 모델 조회
- 모델 선택
- Structured JSON 분석
- 모델 변경

UI 예:

```text
AI Provider: Ollama
Ollama URL: http://localhost:11434
Model: qwen3.5:9b
[연결 테스트]
```

## 8. 메인 QA 설정 화면

입력 항목:

```text
프로젝트명
Target URL
Start Path
로그인 사용 여부
Username
Password

AI Provider
AI Model

CRUD:
[ ] Create
[x] Read
[ ] Update
[ ] Delete

추가:
[x] Visual QA
[x] Console
[x] Network/API
[x] Form Validation
[x] Search/Filter
[x] Table/Sort
[x] Pagination
[x] Modal
[x] Accessibility
```

## 9. Safety Policy

### SAFE
자동 허용:
- 조회
- 검색
- 상세보기
- 탭
- 정렬
- Paging
- Modal open
- Dropdown

### CAUTION
사용자가 기능 테스트를 켠 경우만:
- 등록
- 저장
- 수정
- 첨부
- 테스트 데이터 생성

### DANGEROUS
기본 차단:
- 삭제
- 사용자 차단
- 권한 변경
- 승인/반려
- 게시
- 메일/SMS/Push 발송
- 외부 연동 실행
- 대량처리

Delete는 별도 명시적 동의가 있어야 한다.

### 소스 QA의 권한 등급

프로젝트 폴더를 받은 즉시 임의 명령을 실행하면 안 된다. `package.json` 의 script 나
build script 는 임의 코드를 실행할 수 있다.

| 동작 | 기본 |
|---|---|
| 소스 읽기 · 정적 분석 | 자동 허용 |
| 빌드 | 사용자 허용 |
| Unit Test | 사용자 허용 |
| 프로젝트 실행 · Docker | 사용자 허용 |
| 의존성 설치(`npm install` 등) | **차단** |
| DB Migration | **차단** |
| 외부 배포 | **차단** |

**Windows에는 진짜 샌드박스가 없다.** 컨테이너 없이 `npm test` 를 돌리면 그 프로젝트의
임의 코드가 사용자 권한으로 실행된다. 그러므로 실제 통제 수단은 격리가 아니라
**"실행할 명령 전문을 그대로 보여주고 프로젝트별로 동의를 받는 것"** 이다.
이 한계를 UI에서 숨기지 않는다.

## 10. CRUD 테스트 전략

### 데이터 소유권 — 경로 이름을 믿지 않는다

**QA가 만든 데이터만 수정·삭제한다.** 판정 근거는 `AUTO-QA-` 접두사 하나뿐이다.

경로에 `new` 가 들어 있다고 등록 화면이라고 단정하면 안 된다. 실측에서
`/surveys/:id/edit` 을 등록 화면으로 착각해 **기존 실데이터를 수정한 사고가 있었다.**
그래서 2중으로 막는다.

1. 경로 패턴에서 `edit` 계열을 제외한다
2. 폼을 열었을 때 **입력칸에 이미 값이 차 있고 그것이 AUTO-QA 표식이 아니면 건드리지 않는다**

2번이 본질적인 방어다. 이름이 무엇이든 화면이 기존 레코드를 담고 있으면 등록 화면이 아니다.

### Read
기본 자동 허용.

검증:
- 목록
- 상세
- 검색
- 필터
- 정렬
- Paging
- Tab
- Modal
- 데이터 렌더링

### Create
선택적 실행.

Form 자동 인식:
- input
- select
- textarea
- checkbox
- radio
- date
- file

테스트 데이터 Prefix:

```text
AUTO-QA-YYYYMMDD-HHMMSS-SEQ
```

### Update
기본적으로 QA가 생성한 데이터만 수정한다.

### Delete
기본 OFF.
가능하면 QA가 생성한 데이터만 삭제한다.

## 11. Functional PASS 판정

AI 감으로 판정하지 않는다.

예:

```text
저장 클릭
  ↓
POST/PUT 발생
  ↓
HTTP 2xx
  ↓
Toast/Message
  ↓
화면 또는 목록 재조회
  ↓
데이터 존재
  ↓
PASS
```

다음은 FAIL:
- HTTP 4xx/5xx
- 저장 버튼 무반응
- Loading 무한
- UI 성공인데 데이터 미존재
- Validation 누락
- JS Error로 기능 중단

## 12. Autonomous Explorer

단순 Link Crawler 금지.

상태 기반 탐색:

```text
PAGE
  ↓
ACTION DISCOVERY
  ↓
RISK CLASSIFICATION
  ↓
EXECUTION
  ↓
STATE CHANGE DETECTION
  ↓
NEW STATE
```

State Key:

```text
URL
+ Page Title
+ Main Heading
+ Visible Navigation
+ Dialog State
+ DOM Fingerprint
```

동일 State 반복 탐색 금지.

## 13. Action Discovery 대상

- a
- button
- role=button
- role=tab
- input
- select
- checkbox
- radio
- Tree Node
- Accordion
- Dropdown
- Pagination
- Modal Trigger

각 Action:

```json
{
  "type": "CLICK",
  "label": "등록",
  "risk": "CAUTION",
  "selector": "...",
  "screen": "설문관리",
  "confidence": 0.96
}
```

## 14. Evidence

각 화면마다:

- Screenshot
- DOM
- ARIA
- URL
- Title
- Console
- Network
- Action History
- Form Fields
- Visible Text
- Before/After
- Timing

저장 구조:

```text
runs/
  20260829_210000/
    screenshots/
    dom/
    aria/
    network/
    console/
    actions/
    issues.json
    report.md
```

## 15. Visual QA

Rule 기반 1차:
- viewport overflow
- horizontal scroll
- element overlap
- hidden CTA
- 비정상 empty area

AI Vision 2차:
- 주요 화면
- 이상 후보 화면
- 사용자 선택 화면

검토:
- 텍스트 잘림
- 겹침
- 여백
- 정렬
- CTA
- 표
- 모달
- 정보밀도
- 빈 상태
- 관리자 업무 흐름

Ollama 모델이 Vision 미지원이면 Visual AI 분석은 Skip하고 Rule 결과만 제공한다.

## 16. Console / Network

Console:
- error
- uncaught exception
- promise rejection
- React/Vue runtime error
- undefined/null

Network:
- 400
- 401
- 403
- 404
- 409
- 422
- 500
- timeout
- CORS
- failed request
- slow response

민감정보 마스킹:
- Authorization
- Cookie
- JWT
- Session ID
- Password

## 16-1. 소스 취급 정책

소스 QA는 이 도구의 성격을 바꾼다. 지금까지는 화면 DOM만 밖으로 나갔지만,
소스 QA는 **회사 코드베이스를 외부 AI로 보내는 도구**가 된다. 다르게 다뤄야 한다.

### 읽지 않는 파일

아래는 **존재 여부와 키 이름만** 보고 값은 읽지 않는다. 증적에도 남기지 않는다.

```
.env, .env.*, *.pem, *.key, *.p12, *.pfx, id_rsa*
application-*.yml / *.properties 중 password·secret·token 키의 값
credentials*, secrets*, *.keystore
```

값을 읽지 않아도 **"프로덕션 설정에 평문 비밀번호가 있다"** 는 결함은 키 이름만으로
보고할 수 있다. 값을 읽을 이유가 없다.

### AI로 나가는 범위

`source.aiUpload` 로 통제한다.

| 값 | 나가는 것 |
|---|---|
| `none` | 아무것도 나가지 않는다. 룰 결과만 리포트에 실린다 |
| `snippets` (기본) | 후보에 걸린 **파일의 해당 구간만** |
| `files` | 후보에 걸린 파일 전체 |

**저장소 전체를 넘기는 선택지는 두지 않는다.** 넘길 수도 없고(컨텍스트), 넘겨서도 안 된다.

실행 전에 **"소스 일부가 <Provider>로 전송됩니다"** 를 명시한다.
Ollama는 로컬이라 나가지 않고, Claude는 나간다 — 이 차이를 화면에 그대로 적는다.

### 소스 추론에 작은 로컬 모델을 쓰지 않는다

실측에서 exaone 2.4B/7.8B는 **잘못된 입력을 주면 그럴듯한 오답을 자신 있게 썼다**
(§5 참고 — 네트워크 결함에 "대시보드 네비게이션" 분석을 써냈다).
소스 인과 추론은 그보다 훨씬 어렵다.

- 소스 분석의 AI 보강은 **Claude 기본**
- Ollama 선택 시에는 룰 결과만 내보내고, **그 사실을 리포트에 적는다**
- 조용히 품질을 낮추지 않는다

## 17. Severity

CRITICAL:
- 로그인 불가
- 권한 우회
- 개인정보 노출
- 데이터 손실
- 시스템 전체 사용 불가

HIGH:
- 핵심 CRUD 실패
- 저장 실패
- 주요 500
- 핵심 메뉴 접근 불가
- 업무 진행 차단

MEDIUM:
- Validation 문제
- 일부 기능 오동작
- 데이터 표시 오류
- 화면 깨짐
- 중요한 UX 문제

LOW:
- 정렬
- 여백
- 문구
- 아이콘
- 경미 UX

## 18. Priority

Severity와 분리한다. 단 **Severity가 대역을 정하고 점수는 그 안에서 순서를 정한다.**

```text
Priority Score =
Severity Weight
× Business Impact
× Frequency
× User Exposure
÷ Fix Effort
```

| Severity | 가능한 Priority |
|---|---|
| CRITICAL | P0 |
| HIGH | P0 ~ P1 |
| MEDIUM | P1 ~ P2 |
| LOW | P2 ~ P3 |

대역이 필요한 이유는 실측에서 드러났다. 곱셈식만 쓰면 **"넓게 퍼짐"이 "심각함"을 덮는다** —
화면이 아예 열리지 않는 HIGH 결함(1개 화면)이 P3으로, 모든 화면에 반복되는 MEDIUM 콘솔
오류가 P0으로 나왔다.

**Frequency는 원시 발생 건수가 아니라 그 결함이 나타나는 화면 수로 센다.**
탐색기는 액션마다 원래 화면으로 되돌아가느라 같은 페이지를 수십 번 다시 연다.
그때마다 같은 오류가 다시 잡히므로 원시 건수는 실사용 빈도가 아니라 크롤러의 이동 횟수를
반영한다(실측: 404 하나가 후보 332건). `occurrenceCount`는 사실이므로 그대로 기록하되
점수 계산에는 쓰지 않는다.

## 19. Issue Deduplication

같은 Root Cause가 반복되면:

```text
Issue 1개
+
Evidence N개
```

병합 기준:
- API Endpoint
- HTTP Status
- Error Signature
- Stack Message
- DOM Selector
- Action
- Screen

## 20. SQLite

권장 테이블:

```text
projects
qa_profiles
qa_runs
qa_run_pages
qa_actions
qa_evidences
qa_issues
qa_issue_evidences
ai_providers
app_settings
```

Password/Token은 SQLite에 평문 저장 금지.

Electron `safeStorage` 또는 OS Credential Store 사용.

## 21. 화면 구성

1. Dashboard
2. 프로젝트 관리
3. 신규 QA
4. 로그인 설정
5. AI Provider 설정
6. CRUD 테스트 설정
7. Safety Policy
8. QA Running Monitor
9. 탐색 화면 목록
10. Issue 목록
11. Issue 상세
12. Screenshot Viewer
13. Evidence Viewer
14. Network Viewer
15. Console Viewer
16. Report Viewer
17. 실행 History
18. Settings

## 22. 실행 Monitor

```text
QA RUNNING

현재 화면:
설문관리 > 설문등록

진행:
42 / 93 screens

현재 작업:
Form Validation

AI:
Claude Max Connected

Issues:
Critical 0
High 2
Medium 8
Low 12

[일시정지] [중단]
```

현재 Screenshot을 실시간 미리보기로 표시한다.

## 23. Browser

### Headed
PoC 및 사용자 관찰용.

### Headless
자동 회귀 테스트용.

초기 버전은 Headed 기본 권장.

## 24. Worker Isolation

```text
Electron Main
  ├─ QA Worker
  │   ├─ Playwright
  │   └─ Evidence
  ├─ AI Worker
  │   └─ Provider
  └─ Report Worker
```

Playwright/AI 오류로 Electron UI 전체가 죽으면 안 된다.

## 25. 최종 report.md

반드시 포함:

```text
실행정보
테스트환경
Executive Summary
CRUD 결과
Critical
High
Medium
Low
화면별 개선점
Console 오류
Network/API 오류
UX/UI 개선
기능 누락 후보
우선순위
권장 수정 순서
탐색 제한
미검증 기능
```

## 26. Agent

역할별 정의는 `.claude/agents/`에 둔다. 각 문서는 frontmatter(`name`)로 호출되는
실행 가능한 에이전트 정의이며, 입력·출력·판정규칙·금지사항·DoD를 포함한다.

| name | 담당 |
|---|---|
| `qa-orchestrator` | Run 생애주기, 순서, 큐, 진행률, Pause/Resume/Stop |
| `qa-login` | 로그인 자동화, 세션 유지·복구 |
| `qa-explorer` | 상태 지문, 자율 탐색, 루프 방지, 예산 |
| `qa-action-classifier` | SAFE / CAUTION / DANGEROUS 분류 |
| `qa-crud-test` | Create / Read / Update / Delete 실행 |
| `qa-functional-reviewer` | PASS / FAIL / INCONCLUSIVE 판정 |
| `qa-visual-reviewer` | 룰 계측 + Vision 검토 |
| `qa-network-reviewer` | 4xx/5xx/timeout/CORS, 민감정보 마스킹 |
| `qa-console-reviewer` | 콘솔 오류, 시그니처 병합 |
| `qa-issue-judge` | 중복제거, Severity, Priority |
| `qa-report-writer` | report.md / issues.json |
| `qa-ai-provider` | Claude·Ollama 추상화, 실패 폴백 |
| `qa-security-safety` | 위험 액션 차단, 자격증명 보호 (횡단) |
| `qa-evidence` | 증적 수집·저장 (횡단) |
| `qa-test-data` | AUTO-QA 데이터 생성·추적·Cleanup |

2부(소스 QA)에서 추가되는 에이전트:

| name | 담당 |
|---|---|
| `qa-project-scanner` | 기술 스택 판별, 스캔 범위 결정, 시크릿 파일 차단 |
| `qa-source-analyzer` | 외부 도구 오케스트레이션, 결과 → IssueCandidate 변환 |
| `qa-security-analyzer` | **권한 검사 누락** (직접 구현하는 유일한 검출기) |
| `qa-api-source-mapper` | 엔드포인트 → 컨트롤러 파일·줄 |
| `qa-root-cause` | 실행 증적 + 소스를 묶어 원인 추정 |
| `qa-change-impact` | git diff → 영향 엔드포인트 → 영향 화면 |
| `qa-build-test` | 빌드·테스트 명령 판별과 동의 기반 실행 |

## 27. 개발 단계

상세 범위와 DoD는 `ROADMAP.md`가 정본이다. 여기에는 순서와 그 이유만 적는다.

**원칙 A — 엔진 우선, UI 최후.** QA 엔진을 CLI로 먼저 완성한 뒤 Electron을 씌운다.
자율탐색은 수백 회 재실행하며 튜닝하는 작업이고, 그 반복이 Electron 창을 거치면
사이클이 느려지며 오류 원인이 UI / IPC / 엔진 중 어디인지 분리되지 않는다.

**원칙 B — 정답을 아는 테스트 대상을 먼저.** `packages/fixture-admin`이 없으면
탐지율·오탐률을 잴 수 없고 회귀도 불가능하다. 실제 관리자웹은 Phase 3 이후 Read-only로만 붙인다.

| Phase | 범위 | 핵심 DoD |
|---|---|---|
| 0 | 모노레포, 데이터 계약, fixture 관리자웹 | fixture 기동 + 타입 통과 |
| 1 | 엔진 CLI, Login, Evidence | 로그인 성공 + 증적 트리, 비밀번호 유출 0건 |
| 2 | 상태 지문, 자율 탐색, 위험 분류 | 15개 상태 완주 + **2회 실행 결과 동일** |
| 3 | 룰 검출, Dedup, Severity/Priority, report.md | **정답지 10건 중 8건 탐지, 오탐 3건 이하** |
| 4 | AiProvider (Ollama → Claude) | AI 실패해도 Phase 3 리포트 손실 없음 |
| 5 | Electron 셸 (화면 6개) | 클릭만으로 Phase 4와 동일 결과 |
| 6 | Create → Update → Delete, Test Data | Create PASS/FAIL 정확 판정, 잔여 데이터 0 |
| 7 | electron-builder NSIS | 다른 PC에서 설치 후 5분 내 QA 시작 |
| 8 | 소스 fixture + 정답지 | 결함이 파일·줄로 특정된 정답지 존재 |
| 9 | Project Scanner + Source QA (정적) | **정답지 80% 탐지, 오탐 3건 이하** |
| 10 | Change Impact (git diff) | 변경 영향 화면이 큐 앞으로 온다 |
| 11 | API↔Source Mapper + Root Cause | 화면 오류가 컨트롤러 파일·줄까지 연결 |
| 12 | 빌드/테스트 실행 | 동의 없이는 어떤 명령도 실행되지 않는다 |

Phase 7 착수 시 **Playwright Chromium 번들링 방침**(동봉 +150MB vs 최초 실행 시 다운로드)을
가장 먼저 결정한다. 여기서 대부분 막힌다.

## 27-1. 탐색 예산 (필수)

예산이 없으면 자율탐색은 끝나지 않는다. `ExploreBudget` 전 항목이 강제 상한이다.

| 항목 | 기본값 |
|---|---|
| maxScreens | 120 |
| maxActions | 600 |
| maxDepth | 8 |
| maxDurationMs | 900,000 (15분) |
| settleMs | 700 |
| navigationTimeoutMs | 15,000 |

예산 소진으로 멈추면 **남은 큐를 `explorationLimits`에 기록**한다. 조용히 끝내지 않는다.

## 27-2. 상태 지문 규칙 (필수)

동일 State 반복 탐색을 막는 지문은 `StateSignals`(`packages/shared/src/state.ts`)를 sha1한 값이다.

**구조는 넣고 데이터는 뺀다.**

```
stateKey = sha1(pathTemplate + heading + activeTab + dialogTitle + navLabels + structureHash)
```

- 경로의 숫자·UUID 세그먼트 → `:id` 로 정규화 (사용자 47명이 47개 상태가 되면 안 된다)
- **쿼리는 지문에 넣지 않는다.** 처음에는 "값은 버리고 키만"으로 설계했으나 실측에서 깨졌다 —
  같은 목록 화면인데 검색 버튼은 `?keyword=`, 정렬 헤더는 `?keyword=&sort=&dir=&page=` 를 만들어
  키 집합이 갈라진다. 정렬·페이징·필터가 **동작했는지**는 상태 수가 아니라 `ActionResult`와
  그 구간의 네트워크 기록으로 검증한다.
- 다이얼로그 개폐는 서로 다른 상태다 (URL이 같아도 모달 안을 놓치면 안 된다)
- 활성 탭은 서로 다른 상태다 (URL이 같아도)
- `structureHash`는 **보이는 요소만** 직렬화하고, 형제 중 결과가 같은 것은 접은 뒤 정렬한다.
  - 안 보이는 요소 제외 → 스피너만 남은 로딩 화면이 정상 화면과 구별된다
  - 형제 접기 → 목록 10행과 3행이 같은 화면이 된다
  - 접은 뒤 정렬 → 페이저의 현재 페이지 표시가 움직여도 같은 화면이다
- 목록 셀 텍스트·행 개수는 지문에 넣지 않는다
- 시각·난수를 절대 섞지 않는다 (결정성이 깨지면 회귀 테스트가 불가능해진다)

## 27-3. 위험도 분류 원칙

라벨만 보고 판정하지 않는다. **하는 일**을 보고 판정한다.

| 우선순위 | 규칙 | 결과 |
|---|---|---|
| 1 | `safety.denyLabelPatterns` 매치 | DANGEROUS (절대적, 어떤 규칙으로도 뚫리지 않음) |
| 2 | class/testid에 `danger`/`delete` 등 | DANGEROUS |
| 3 | `<thead>` 안의 GET 링크 | SAFE (정렬 컨트롤) |
| 4 | 위험 라벨 (삭제·권한·승인·발송…) | DANGEROUS |
| 5 | GET 링크 — href가 파괴적/변경적 경로가 아니면 | SAFE |
| 6 | 쓰기 라벨 (등록·저장·수정…) 버튼 | CAUTION |
| 7 | 분류 불가 | CAUTION, 신뢰도 0.4 (실행 하한 미만) |

3번과 5번이 필요한 이유는 실측에서 드러났다.

- **5번 없이는 등록 화면을 영영 못 본다.** "신규 등록" 링크는 라벨에 `등록`이 있어
  CAUTION으로 막히지만, 하는 일은 빈 폼을 여는 GET 이동이고 아무것도 쓰지 않는다.
  실제로 데이터를 만드는 것은 그 폼 안의 저장 버튼이고 그건 6번에서 걸린다.
- **3번 없이는 컬럼 정렬을 못 한다.** 관리자 테이블에는 `권한` `삭제여부` 같은 컬럼이 흔하다.

실행 게이트는 분류를 신뢰하지 않고 실행 직전에 다시 확인한다:
```
실행 = denylist 미매치 && risk <= safety.maxAutoRisk && confidence >= 0.6
```

## 28. MVP

1차 MVP:
- Electron 설치본
- URL/ID/PW 입력
- Claude Max/Ollama 선택
- Read 테스트
- 자동 로그인
- 메뉴/Link/Tab 탐색
- Screenshot
- DOM
- Console
- Network
- Issue 분석
- report.md

2차:
- Create
- Update
- Validation
- Search/Filter
- Table/Paging
- Visual QA

3차:
- Delete
- Cleanup
- Regression
- Baseline Screenshot
- CI

## 29. 비기능

- 설치 후 5분 이내 QA 시작 가능
- QA Run Crash 복구
- Password 로그 금지
- Token Masking
- Evidence 삭제 가능
- AI Provider 실패 시 Rule QA 유지
- Stop/Pause 제공
- Run별 완전 분리

## 30. 바이브코딩 규칙

개발 Agent는 항상:

1. `CLAUDE.md` 읽기
2. `ROADMAP.md`에서 현재 Phase 확인
3. 담당 `.claude/agents/*.md` 읽기
4. `packages/shared`의 데이터 계약 확인
5. 현재 코드 분석
6. **해당 Phase의 DoD를 테스트로 먼저 작성**
7. 최소 단위 구현
8. 실행 · 테스트 · 오류 수정
9. fixture 대상 회귀 실행
10. 변경 파일 기록 · TODO 갱신

### 지켜야 할 선

- **한 번에 한 에이전트씩.** 여러 에이전트를 동시에 구현하지 않는다.
- **Phase를 건너뛰지 않는다.** 앞 Phase의 DoD가 통과하지 않았으면 다음으로 가지 않는다.
- **데이터 계약을 먼저 고친다.** 타입이 바뀌어야 하면 `packages/shared`를 고치고
  타입 에러를 따라간다. 각 모듈에서 임의로 캐스팅하지 않는다.
- **회귀가 깨지면 머지 금지.** 탐지율·오탐률이 이전보다 나빠지면 되돌린다.
- **실제 관리자웹은 Phase 3 이후, Read-only로만.** 그전에는 fixture만 사용한다.
- 대규모 무계획 리팩터링 금지.

### 엔진 코드에서 금지되는 것

- `console.log` 직접 호출 — stdout은 `EngineEvent` JSON Lines 전용이다.
  사람이 읽을 로그는 `emit({type:"log"})`로 보낸다.
- 비밀번호·토큰이 담길 수 있는 값을 `scrub()` 없이 출력
- 지문 계산에 시각·난수 사용
- 대상 데이터의 소유권(`AUTO-QA-` 접두사) 확인 없이 수정·삭제
- **시크릿 파일의 값을 읽는 것** (§16-1). 키 이름까지만 본다
- **사용자 동의 없이 프로젝트의 명령을 실행하는 것** (§9). `npm install` 은 동의가 있어도 하지 않는다
- 오탐을 늘리는 자체 정적 검출기 추가. 기존 도구(ESLint·Semgrep 등)가 하는 일을 다시 만들지 않는다

## 31. 완료 기준

설치 후 사용자가:

```text
URL 입력
ID/PW 입력
AI 선택
CRUD 선택
QA 시작
```

만 하면 된다.

종료 결과 예:

```text
탐색 84 화면

Critical 1
High 7
Medium 23
Low 18

Create PASS 7 / FAIL 1
Read PASS 52 / FAIL 3
Update PASS 5 / FAIL 2
Delete 미실행

[Report 열기]
```

`report.md`, `issues.json`, `evidence`가 자동 생성되어야 한다.
