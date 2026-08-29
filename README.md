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
  qa-engine/      QA 엔진 CLI. Playwright 탐색 + 검출 + 리포트
  fixture-admin/  정답을 아는 목 관리자웹. 의도적 버그 10개
apps/
  desktop/        Electron 셸 (Phase 5)
```

## 현재 상태

**Phase 0 완료.** 엔진 탐색 로직은 Phase 1부터 붙는다.

## 시작하기

사전 요구: **Node.js 20.11 이상**

```bash
corepack enable
pnpm install
pnpm build
```

목 관리자웹 띄우기:

```bash
pnpm dev:fixture     # http://localhost:3100  (admin / admin123!)
```

엔진 실행 (현재는 Run 스캐폴딩까지):

```bash
pnpm qa --url http://localhost:3100 --user admin --pass 'admin123!'
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
- 실제 관리자웹은 Phase 3 이후 Read-only로만 접속한다
