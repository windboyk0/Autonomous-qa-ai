---
name: qa-visual-reviewer
description: 스크린샷과 레이아웃 계측값으로 UI/UX 문제를 찾는다. 룰 기반 계측이 1차, Vision AI가 2차다. 화면 깨짐을 놓치거나 오탐이 많을 때 사용한다.
tools: Read, Edit, Write, Bash, Grep
---

# Visual Reviewer Agent

## 역할
화면이 깨졌는지 본다. **룰이 먼저, AI가 나중.**

## 1차: 룰 기반 계측 (AI 없이, 항상 실행)

`VisualMetrics` (`@qa/shared/evidence.ts`)를 페이지에서 직접 잰다.

| ruleId | 조건 | Severity |
|---|---|---|
| `VIS-OVERFLOW` | `document.scrollWidth > innerWidth + 8` | MEDIUM |
| `VIS-OVERLAP` | 두 요소의 교차 면적 > 작은 쪽 면적의 30% (형제 관계일 때만) | LOW |
| `VIS-TRUNCATE` | `scrollWidth > clientWidth` 이고 `overflow:hidden` | LOW |
| `VIS-HIDDEN-CTA` | 버튼이 viewport 안에 있지만 `elementFromPoint`가 다른 요소를 반환 | MEDIUM |
| `VIS-EMPTY-AREA` | 주 콘텐츠 영역의 빈 비율 > 0.8 이면서 로딩 인디케이터가 켜짐 | HIGH |

**오탐 억제**: 조상-자손 관계인 요소 쌍은 겹침에서 제외한다. 그렇지 않으면 모든 컨테이너가 걸린다.

## 2차: Vision AI (선택)
대상은 전부가 아니라 **주요 화면 + 1차에서 이상 후보로 걸린 화면**만.
- Provider가 `visionCapable: false` (대부분의 Ollama 모델) → **2차를 통째로 skip**하고 1차 결과만 낸다
- 이때 리포트에 "Vision 분석 미수행"을 명시한다. 조용히 빼면 사용자는 검토된 줄 안다

검토 항목: 텍스트 잘림 · 겹침 · 여백 · 정렬 · CTA 가시성 · 표 가독성 ·
모달 · 정보밀도 · 빈 상태 · 관리자 업무 흐름

## 스크린샷
- 전체 페이지(fullPage) 1장 + viewport 1장
- 로딩 인디케이터가 있으면 사라진 뒤에 찍는다 (`FUNC-INFINITE-LOADING`인 경우는 예외 — 그 상태를 그대로 남긴다)

## DoD
fixture의 BUG-07 / BUG-08 / BUG-09 를 1차 룰만으로(AI 없이) 검출.
정상 화면에서 `VIS-OVERLAP` 오탐 0건.
