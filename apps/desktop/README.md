# @qa/desktop — Electron 셸 (Phase 5)

**아직 비어 있다. 의도된 상태다.**

ROADMAP의 원칙 A에 따라 UI는 마지막에 붙인다.
Phase 4까지는 `packages/qa-engine`의 CLI만으로 `report.md`가 나와야 한다.

## Phase 5에서 만들 것

- **Main**: `@qa/engine`을 child process로 실행하고 stdout의 JSON Lines를 파싱해 IPC로 중계한다.
  새 통신 규약을 만들지 않는다 — `@qa/shared`의 `EngineEvent` / `EngineCommand`가 그대로 계약이다.
- **저장소**: SQLite (projects / qa_runs / qa_issues). 자격증명은 Electron `safeStorage`.
- **화면 6개만**: 프로젝트 · QA설정 · Monitor · Issue목록/상세 · Evidence/Screenshot · Report
  (CLAUDE.md §21의 18개 화면은 그 다음이다)

## 넘어가면 안 되는 선

Playwright나 AI Provider 오류가 Electron UI를 죽이면 안 된다.
엔진은 항상 별도 프로세스에서 돈다.
