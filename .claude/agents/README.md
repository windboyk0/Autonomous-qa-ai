# .claude/agents — 에이전트 정의 (정본)

각 파일은 Claude Code 서브에이전트 정의다. frontmatter의 `name`으로 호출된다.

바이브코딩 시 순서:
1. 저장소 루트 `CLAUDE.md` (무엇을 만드는가)
2. `ROADMAP.md` (지금 어느 Phase인가)
3. 담당 에이전트 문서 (이 폴더)
4. `packages/shared/src/*.ts` (데이터 계약)

## 목록

| 파일 | name | Phase |
|---|---|---|
| `01-orchestrator.md` | `qa-orchestrator` | 1~6 |
| `02-login.md` | `qa-login` | 1 |
| `03-explorer.md` | `qa-explorer` | 2 |
| `04-action-classifier.md` | `qa-action-classifier` | 2 |
| `05-crud-test.md` | `qa-crud-test` | 6 |
| `06-functional-reviewer.md` | `qa-functional-reviewer` | 3, 6 |
| `07-visual-reviewer.md` | `qa-visual-reviewer` | 3 |
| `08-network-reviewer.md` | `qa-network-reviewer` | 3 |
| `09-console-reviewer.md` | `qa-console-reviewer` | 3 |
| `10-issue-judge.md` | `qa-issue-judge` | 3 |
| `11-report-writer.md` | `qa-report-writer` | 3 |
| `12-ai-provider.md` | `qa-ai-provider` | 4 |
| `13-security-safety.md` | `qa-security-safety` | 1~6 (횡단) |
| `14-evidence.md` | `qa-evidence` | 1 (횡단) |
| `15-test-data.md` | `qa-test-data` | 6 |

## 모든 에이전트에 공통인 규칙

- **한 번에 하나씩.** 여러 에이전트를 동시에 구현하지 않는다.
- 각 문서의 **DoD를 테스트로 먼저 작성**한 뒤 구현한다.
- 데이터 계약을 바꿔야 하면 `packages/shared`를 먼저 고치고 타입 에러를 따라간다.
- 대규모 무계획 리팩터링 금지.
