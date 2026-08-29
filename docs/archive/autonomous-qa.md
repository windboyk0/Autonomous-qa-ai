2. 테스트 대상

지원 대상:

localhost
127.0.0.1
사내 개발 서버
QA 서버
Staging
HTTPS 개발 URL

주의: 다른 PC에서 프로그램을 실행할 때 localhost는 그 PC 자체를 의미한다. 다른 PC의 로컬 서버를 테스트하려면 해당 서버가 LAN에서 접근 가능해야 한다.

3. 권장 기술스택
Desktop
Electron
React
TypeScript
Vite
Tailwind CSS
Zustand 또는 Redux Toolkit
QA Engine
Playwright Node API
TypeScript
Worker Thread 또는 Child Process
Local DB
SQLite
Packaging
electron-builder
Windows NSIS
4. 전체 아키텍처
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
5. AI Provider Layer

AI Provider는 반드시 추상화한다.

interface AiProvider {
  healthCheck(): Promise<ProviderStatus>;
  analyzePage(input: PageAnalysisInput): Promise<PageAnalysisResult>;
  analyzeFunction(input: FunctionalAnalysisInput): Promise<FunctionalAnalysisResult>;
  analyzeScreenshot(input: VisualAnalysisInput): Promise<VisualAnalysisResult>;
  judgeIssues(input: IssueJudgeInput): Promise<IssueJudgeResult>;
  generateReport(input: ReportInput): Promise<string>;
}

구현체:

ClaudeMaxProvider
OllamaProvider
향후 AnthropicApiProvider
향후 OpenAIProvider

AI Provider가 실패해도 Playwright Evidence 수집은 중단하지 않는다.

6. Claude Max 연결

PoC:

Claude Code CLI claude -p

제품화 권장:

Claude Agent SDK

원칙:

사용자의 Claude 인증을 사용
인증정보 하드코딩 금지
QA 프로그램에서 Claude Max를 공용 API 키처럼 내장하지 않음
7. Ollama 연결

기본 URL:

http://localhost:11434

기능:

Health Check
설치 모델 조회
모델 선택
Structured JSON 분석
모델 변경

UI 예:

AI Provider: Ollama
Ollama URL: http://localhost:11434
Model: qwen3.5:9b
[연결 테스트]
8. 메인 QA 설정 화면

입력 항목:

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
9. Safety Policy
SAFE

자동 허용:

조회
검색
상세보기
탭
정렬
Paging
Modal open
Dropdown
CAUTION

사용자가 기능 테스트를 켠 경우만:

등록
저장
수정
첨부
테스트 데이터 생성
DANGEROUS

기본 차단:

삭제
사용자 차단
권한 변경
승인/반려
게시
메일/SMS/Push 발송
외부 연동 실행
대량처리

Delete는 별도 명시적 동의가 있어야 한다.

10. CRUD 테스트 전략
Read

기본 자동 허용.

검증:

목록
상세
검색
필터
정렬
Paging
Tab
Modal
데이터 렌더링
Create

선택적 실행.

Form 자동 인식:

input
select
textarea
checkbox
radio
date
file

테스트 데이터 Prefix:

AUTO-QA-YYYYMMDD-HHMMSS-SEQ
Update

기본적으로 QA가 생성한 데이터만 수정한다.

Delete

기본 OFF.
가능하면 QA가 생성한 데이터만 삭제한다.

11. Functional PASS 판정

AI 감으로 판정하지 않는다.

예:

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

다음은 FAIL:

HTTP 4xx/5xx
저장 버튼 무반응
Loading 무한
UI 성공인데 데이터 미존재
Validation 누락
JS Error로 기능 중단
12. Autonomous Explorer

단순 Link Crawler 금지.

상태 기반 탐색:

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

State Key:

URL
+ Page Title
+ Main Heading
+ Visible Navigation
+ Dialog State
+ DOM Fingerprint

동일 State 반복 탐색 금지.

13. Action Discovery 대상
a
button
role=button
role=tab
input
select
checkbox
radio
Tree Node
Accordion
Dropdown
Pagination
Modal Trigger

각 Action:

{
  "type": "CLICK",
  "label": "등록",
  "risk": "CAUTION",
  "selector": "...",
  "screen": "설문관리",
  "confidence": 0.96
}
14. Evidence

각 화면마다:

Screenshot
DOM
ARIA
URL
Title
Console
Network
Action History
Form Fields
Visible Text
Before/After
Timing

저장 구조:

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
15. Visual QA

Rule 기반 1차:

viewport overflow
horizontal scroll
element overlap
hidden CTA
비정상 empty area

AI Vision 2차:

주요 화면
이상 후보 화면
사용자 선택 화면

검토:

텍스트 잘림
겹침
여백
정렬
CTA
표
모달
정보밀도
빈 상태
관리자 업무 흐름

Ollama 모델이 Vision 미지원이면 Visual AI 분석은 Skip하고 Rule 결과만 제공한다.

16. Console / Network

Console:

error
uncaught exception
promise rejection
React/Vue runtime error
undefined/null

Network:

400
401
403
404
409
422
500
timeout
CORS
failed request
slow response

민감정보 마스킹:

Authorization
Cookie
JWT
Session ID
Password
17. Severity

CRITICAL:

로그인 불가
권한 우회
개인정보 노출
데이터 손실
시스템 전체 사용 불가

HIGH:

핵심 CRUD 실패
저장 실패
주요 500
핵심 메뉴 접근 불가
업무 진행 차단

MEDIUM:

Validation 문제
일부 기능 오동작
데이터 표시 오류
화면 깨짐
중요한 UX 문제

LOW:

정렬
여백
문구
아이콘
경미 UX
18. Priority

Severity와 분리.

Priority Score =
Severity Weight
× Business Impact
× Frequency
× User Exposure
÷ Fix Effort

결과:

P0
P1
P2
P3
19. Issue Deduplication

같은 Root Cause가 반복되면:

Issue 1개
+
Evidence N개

병합 기준:

API Endpoint
HTTP Status
Error Signature
Stack Message
DOM Selector
Action
Screen
20. SQLite

권장 테이블:

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

Password/Token은 SQLite에 평문 저장 금지.

Electron safeStorage 또는 OS Credential Store 사용.

21. 화면 구성
Dashboard
프로젝트 관리
신규 QA
로그인 설정
AI Provider 설정
CRUD 테스트 설정
Safety Policy
QA Running Monitor
탐색 화면 목록
Issue 목록
Issue 상세
Screenshot Viewer
Evidence Viewer
Network Viewer
Console Viewer
Report Viewer
실행 History
Settings
22. 실행 Monitor
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

현재 Screenshot을 실시간 미리보기로 표시한다.

23. Browser
Headed

PoC 및 사용자 관찰용.

Headless

자동 회귀 테스트용.

초기 버전은 Headed 기본 권장.

24. Worker Isolation
Electron Main
  ├─ QA Worker
  │   ├─ Playwright
  │   └─ Evidence
  ├─ AI Worker
  │   └─ Provider
  └─ Report Worker

Playwright/AI 오류로 Electron UI 전체가 죽으면 안 된다.

25. 최종 report.md

반드시 포함:

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
26. Agent

역할별 문서는 /agents에 둔다.

Orchestrator
Login
Explorer
Action Classifier
CRUD Test
Functional Reviewer
Visual Reviewer
Network Reviewer
Console Reviewer
Issue Judge
Report Writer
AI Provider
Security/Safety
Evidence
Test Data
27. 개발 단계

Phase 1:

Electron Shell
React
SQLite
Project
QA Setup

Phase 2:

URL
Login
Playwright
Screenshot
DOM
Console
Network

Phase 3:

State Graph
Action Discovery
Loop Prevention
Risk Classification

Phase 4:

Read Test
Create
Update
Delete
Test Data

Phase 5:

Claude Max
Ollama
Provider Interface
Functional Analysis
Visual Analysis

Phase 6:

Issue Dedup
Severity/Priority
report.md

Phase 7:

electron-builder
Windows NSIS
Installer Test
28. MVP

1차 MVP:

Electron 설치본
URL/ID/PW 입력
Claude Max/Ollama 선택
Read 테스트
자동 로그인
메뉴/Link/Tab 탐색
Screenshot
DOM
Console
Network
Issue 분석
report.md

2차:

Create
Update
Validation
Search/Filter
Table/Paging
Visual QA

3차:

Delete
Cleanup
Regression
Baseline Screenshot
CI
29. 비기능
설치 후 5분 이내 QA 시작 가능
QA Run Crash 복구
Password 로그 금지
Token Masking
Evidence 삭제 가능
AI Provider 실패 시 Rule QA 유지
Stop/Pause 제공
Run별 완전 분리
30. 바이브코딩 규칙

개발 Agent는 항상:

CLAUDE.md 읽기
담당 agent 문서 읽기
현재 코드 분석
최소 단위 구현
실행
테스트
오류 수정
변경 파일 기록
TODO 갱신

대규모 무계획 리팩터링 금지.

31. 완료 기준

설치 후 사용자가:

URL 입력
ID/PW 입력
AI 선택
CRUD 선택
QA 시작

만 하면 된다.

종료 결과 예:

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

report.md, issues.json, evidence가 자동 생성되어야 한다.
"""

agents = {
"01-orchestrator-agent.md": """# Orchestrator Agent

역할

전체 QA Run을 지휘한다.

책임
설정 검증
Run 생성
Agent 실행 순서
Queue
진행률
Pause/Resume/Stop
실패 재시도
결과 Aggregation
Workflow

Preflight → Login → Explore → CRUD/Functional → Visual → Issue Judge → Report

원칙

AI 장애가 Playwright Evidence 수집을 중단시키면 안 된다.
""",
"02-login-agent.md": """# Login Agent

역할

관리자웹 로그인 자동화.

기능
로그인 페이지 탐지
ID/PW selector 추정
로그인 실행
Redirect/성공 판정
실패 Screenshot
보안

Password를 log, SQLite, report, evidence에 평문 저장 금지.
""",
"03-explorer-agent.md": """# Explorer Agent

역할

Playwright 기반 자율 탐색.

대상

Menu, Link, Tab, Modal, Tree, Accordion, Dropdown, Detail, Pagination.

State

URL + Heading + Navigation + Dialog + DOM fingerprint.

금지

Loop, 외부 Domain 이탈, Logout, 위험 Action 무단 실행.
""",
"04-action-classifier-agent.md": """# Action Classifier Agent

역할

Action을 SAFE / CAUTION / DANGEROUS로 분류.

SAFE

조회, 검색, 상세, 탭, 정렬, Paging.

CAUTION

등록, 저장, 수정, 첨부.

DANGEROUS

삭제, 권한, 승인/반려, 게시, 발송, 대량처리.
사용자의 CRUD 설정과 Safety Policy가 최우선이다.
""",
"05-crud-test-agent.md": """# CRUD Test Agent

역할

Create / Read / Update / Delete 자동 기능 테스트.

Create

Form 분석 → AUTO-QA 테스트데이터 → 저장 → 결과검증.

Read

목록/상세/검색/필터/정렬/Paging.

Update

QA 생성 데이터 우선.

Delete

기본 OFF, QA 생성 데이터 우선.

PASS

Network + UI + 재조회 결과를 조합해 판정.
""",
"06-functional-reviewer-agent.md": """# Functional Reviewer Agent

역할

기능 정상/비정상 판정.

Evidence

Before/After DOM, HTTP, Toast, Navigation, 데이터 재조회, Validation.

원칙

AI 감보다 deterministic rule을 우선한다.
""",
"07-visual-reviewer-agent.md": """# Visual Reviewer Agent

역할

Screenshot 기반 UI/UX 검토.

항목

겹침, 잘림, 여백, 정렬, CTA, Table, Modal, 정보밀도, Empty State, 가독성, 업무흐름.

Provider

Vision 가능한 Claude 또는 Vision 모델 사용.
Vision 미지원 Ollama 모델이면 Rule 기반 결과만 사용.
""",
"08-network-reviewer-agent.md": """# Network Reviewer Agent

역할

Playwright Network 분석.

감지

4xx, 5xx, timeout, CORS, failed request, slow response.

보안

Authorization, Cookie, JWT, Session ID 마스킹.
""",
"09-console-reviewer-agent.md": """# Console Reviewer Agent

역할

Browser Console 오류 분석.

대상

error, uncaught, promise rejection, runtime error, undefined/null.
반복 오류는 signature 기반 병합.
""",
"10-issue-judge-agent.md": """# Issue Judge Agent

역할

Issue Candidate를 최종 Issue로 확정.

기능

중복제거, Root Cause 그룹핑, Severity, Priority, Business Impact, Fix Effort.

원칙

같은 Root Cause는 Issue 1개 + Evidence N개.
""",
"11-report-writer-agent.md": """# Report Writer Agent

역할

최종 report.md 생성.

필수

실행정보, Summary, CRUD 결과, Severity별 Issue, 화면별 개선, Network, Console, UX, Priority, 수정순서, 미검증영역.

Issue 필드

ID, Screen, Severity, Priority, Description, Impact, Evidence, Reproduction, Recommendation.
""",
"12-ai-provider-agent.md": """# AI Provider Agent

역할

Claude Max와 Ollama를 동일 인터페이스로 추상화.

Claude

PoC는 CLI, 제품화는 Agent SDK 권장.

Ollama

Health, Model List, Chat, Structured JSON.

Failover

AI 실패 시 QA Evidence는 유지한다.
""",
"13-security-safety-agent.md": """# Security & Safety Agent

역할

QA가 대상 시스템을 훼손하지 않게 통제.

기본 차단

실데이터 Delete, User Disable, Permission 변경, Approval, Mail/SMS/Push, External Integration, Batch.

Credential

Electron safeStorage 또는 OS Credential Store.
""",
"14-evidence-agent.md": """# Evidence Agent

역할

Screenshot, DOM, ARIA, Console, Network, Action, Before/After, Timing 저장.
모든 최종 Issue는 최소 1개 Evidence를 가져야 한다.
""",
"15-test-data-agent.md": """# Test Data Agent

역할

CRUD 테스트 데이터 생성/추적/Cleanup.

Naming

AUTO-QA-yyyyMMdd-HHmmss-SEQ

원칙

가능하면 QA가 만든 데이터만 수정/삭제.
Cleanup 실패는 Warning 또는 Issue로 기록.
"""
}

(root / "CLAUDE.md").write_text(claude_md, encoding="utf-8")
(root / "README.md").write_text("""# Electron Admin QA Vibe Blueprint

바이브코딩 시작 순서:

CLAUDE.md
agents/*.md
Electron Shell
Playwright Read-only MVP
Claude Max/Ollama Provider
CRUD 확장
Report 자동화
""", encoding="utf-8")

for name, content in agents.items():
(root / "agents" / name).write_text(content, encoding="utf-8")

zip_path = Path("/mnt/data/electron-admin-qa-vibe-blueprint.zip")
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
for p in root.rglob("*"):
if p.is_file():
z.write(p, p.relative_to(root.parent))

print("created:", zip_path)
print("files:", 2 + len(agents))

정리해서 다시 만들었습니다. 이번 버전은 Electron 설치형 관리자웹 자율 QA 시스템을 전제로 잡았습니다.

핵심 요구사항은 다음처럼 반영했습니다.

다른 PC에 Setup.exe 형태로 설치
화면에서 관리자웹 URL/로그인 정보 입력
localhost, 개발서버, QA서버 테스트 가능
Claude Max 또는 Ollama 선택
Create / Read / Update / Delete 기능별 테스트 범위 선택
삭제/승인/발송 등 위험 기능은 별도 Safety Policy
Playwright 기반 자율탐색
Screenshot + DOM + ARIA + Console + Network 증적 수집
화면/UX 육안 검증
CRUD PASS/FAIL 검증
심각도 Critical/High/Medium/Low
개발 우선순위 P0~P3
중복 Issue 병합
최종 report.md, issues.json, Evidence 자동 생성
Electron safeStorage 기반 계정정보 보호
향후 회귀테스트/CI까지 확장 가능


패키지에는 메인인 CLAUDE.md와 아래 15개 Agent 문서가 포함되어 있습니다.

agents/
├─ 01-orchestrator-agent.md
├─ 02-login-agent.md
├─ 03-explorer-agent.md
├─ 04-action-classifier-agent.md
├─ 05-crud-test-agent.md
├─ 06-functional-reviewer-agent.md
├─ 07-visual-reviewer-agent.md
├─ 08-network-reviewer-agent.md
├─ 09-console-reviewer-agent.md
├─ 10-issue-judge-agent.md
├─ 11-report-writer-agent.md
├─ 12-ai-provider-agent.md
├─ 13-security-safety-agent.md
├─ 14-evidence-agent.md
└─ 15-test-data-agent.md

이번 설계에서 특히 중요하게 잡은 부분은 AI가 모든 테스트를 판단하지 않도록 한 것입니다.

예를 들어 저장 테스트는:

등록 버튼
   ↓
Form 자동 입력
   ↓
저장 클릭
   ↓
POST 요청 감지
   ↓
HTTP 2xx
   ↓
Toast 확인
   ↓
목록 재조회
   ↓
생성 데이터 확인
   ↓
PASS

처럼 Playwright가 실제 결과를 검증하고, Claude/Ollama는 원인 분석·화면 평가·개선안·Issue 정리에 사용하게 했습니다.

또 전체 구조는 이렇게 잡았습니다.

                 Electron Desktop
                        │
              URL / ID / PW 입력
                        │
          Claude Max / Ollama 선택
                        │
               CRUD 범위 선택
                        │
                   QA 시작
                        ↓
                QA Orchestrator
                        │
              ┌─────────┴─────────┐
              ↓                   ↓
       Playwright Worker       AI Worker
              │                   │
         자율탐색             Claude Max
         기능테스트               또는
         Screenshot             Ollama
         DOM/ARIA                  │
         Console                   │
         Network                   │
              └─────────┬─────────┘
                        ↓
                   Issue Judge
                        ↓
              Severity / Priority
                        ↓
            ┌───────────┴───────────┐
            ↓                       ↓
        issues.json             report.md

그리고 구현 순서도 CLAUDE.md 안에 7단계 Phase로 넣어두었습니다. 처음부터 등록/수정/삭제까지 전부 구현하기보다 Electron Shell → Playwright Read-only 탐색 → 자율탐색 → CRUD → Claude/Ollama → Report → 설치본 순서로 가는 게 좋습니다.

첫 PoC에서는 특히 Read 기능만 켠 상태로 관리자웹 전체를 안정적으로 탐색하는 것부터 성공시키고, 이후 Create → Update → Delete 순으로 확장하는 것을 권합니다. 이렇게 하면 실제 관리자 데이터가 훼손되는 위험도 크게 줄일 수 있습니다.