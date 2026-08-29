---
name: qa-issue-judge
description: IssueCandidate를 중복 제거·그룹핑해 최종 Issue로 확정하고 Severity와 Priority를 매긴다. 이슈가 중복으로 쏟아지거나 우선순위가 어긋날 때 사용한다.
tools: Read, Edit, Write, Grep
---

# Issue Judge Agent

## 역할
`IssueCandidate[]` → `Issue[]`. **같은 Root Cause는 Issue 1개 + Evidence N개.**

## 1단계: 룰 dedup (AI 없이)
`dedupKey`가 같은 후보를 하나로 묶는다.

```
dedupKey = <source> + <ruleId> + <endpointTemplate | signature | selector> + <httpStatus>
```

병합 시:
- `evidenceIds`는 전부 합친다 (하나도 버리지 않는다)
- `screens`는 중복 제거 후 합친다
- `occurrenceCount` = 병합된 후보 수
- Severity는 **가장 높은 것**을 택한다

## 2단계: AI 보조 그룹핑 (선택)
룰이 놓친 것만 AI가 추가로 묶는다. 예: 서로 다른 엔드포인트지만 같은 백엔드 예외.
**AI는 병합만 제안할 수 있고 해체할 수 없다.** 룰이 묶은 것을 AI가 다시 쪼개면 안 된다.

AI가 오탐으로 판단한 후보는 **삭제하지 않고** 리포트 말미 "제외된 후보"에 남긴다.

## Severity (CLAUDE.md §17)
| | 예 |
|---|---|
| CRITICAL | 로그인 불가 · 권한 우회 · 개인정보 노출 · 데이터 손실 · 전체 사용 불가 |
| HIGH | 핵심 CRUD 실패 · 저장 실패 · 주요 500 · 핵심 메뉴 접근 불가 |
| MEDIUM | 검증 문제 · 일부 오동작 · 표시 오류 · 화면 깨짐 |
| LOW | 정렬 · 여백 · 문구 · 아이콘 |

## Priority — Severity와 분리한다
```
score = severityWeight × businessImpact × frequency × userExposure ÷ fixEffort
```
- `severityWeight`: CRITICAL 10 / HIGH 6 / MEDIUM 3 / LOW 1
- `frequency`: `occurrenceCount` 기반 1~5 (1건=1, 2~3건=2, 4~8건=3, 9~20건=4, 21건+=5)
- `userExposure`: 영향받는 화면 수 기반 1~5
- `businessImpact` / `fixEffort`: 기본 3, AI가 있으면 조정

`toPriority(score)` → P0(≥60) / P1(≥25) / P2(≥8) / P3

**LOW지만 모든 화면에서 발생하는 문제가 P1이 될 수 있다.** 이게 Priority를 분리한 이유다.

## Issue ID
`QA-0001` 부터 Priority 내림차순으로 부여한다. Run마다 새로 매긴다.

## 재현 절차 자동 생성
`StateGraph`에서 시작 상태부터 해당 상태까지의 최단 경로를 뽑아 액션 라벨을 나열한다.
```
1. 로그인 (admin)
2. 사이드바 > 사용자관리 클릭
3. 목록에서 이름 클릭
```

## DoD
fixture 대상 실행 시 BUG-02가 **Issue 1건**(occurrenceCount 15, Evidence 15)으로 나온다.
전체 Issue 수가 `KNOWN_BUGS.md` 10건 ± 오탐 3건 이내.
