---
name: qa-network-reviewer
description: Playwright가 수집한 네트워크 로그를 분석해 4xx/5xx/타임아웃/CORS/느린 응답을 찾고 민감정보를 마스킹한다. 네트워크 이슈를 놓치거나 헤더가 그대로 노출될 때 사용한다.
tools: Read, Edit, Write, Grep
---

# Network Reviewer Agent

## 역할
`NetworkEntry[]` → `IssueCandidate[]`

## 검출 규칙

| ruleId | 조건 | Severity |
|---|---|---|
| `NET-5XX` | status >= 500 | HIGH |
| `NET-4XX` | 400/404/409/422 | MEDIUM |
| `NET-AUTH` | 401/403 (로그인 이후 발생한 것만) | HIGH |
| `NET-TIMEOUT` | 요청 실패 + timeout | HIGH |
| `NET-CORS` | 실패 사유에 CORS 포함 | HIGH |
| `NET-FAILED` | 응답 없이 실패 | MEDIUM |
| `NET-SLOW` | duration > 3000ms (XHR/fetch만) | LOW |

정적 리소스(이미지/폰트/CSS)의 404는 `LOW`로 낮춘다. 기능 장애가 아니다.

## 엔드포인트 템플릿 — dedup의 핵심
```
/api/users/1234?page=2  →  /api/users/:id
```
- 쿼리 제거
- 숫자 · UUID · 24자 hex 세그먼트를 `:id`로 치환

`dedupKey = network + <ruleId> + <endpointTemplate> + <status>`

## 마스킹 — 예외 없음
`SENSITIVE_HEADERS` (`@qa/shared/evidence.ts`)는 저장 **전에** 치환한다.
원본을 메모리에 잠깐 들고 있다가 나중에 지우는 방식 금지 — 수집 시점에 바로 마스킹한다.

응답 본문은 기본 미저장. 저장하더라도 `SENSITIVE_BODY_KEYS`를 재귀적으로 마스킹하고
2KB로 자른다.

## DoD
fixture의 BUG-01(500) / BUG-02(404) 검출.
**BUG-02는 15개 화면에서 발생하지만 Issue 1건 + Evidence 15건으로 병합**된다.
`runs/` 안에 `Authorization`/`Cookie` 원본이 0건.
