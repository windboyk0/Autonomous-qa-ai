---
name: qa-console-reviewer
description: 브라우저 콘솔 오류를 분석하고 반복 오류를 시그니처로 병합한다. 콘솔 에러를 놓치거나 같은 오류가 수십 건으로 쏟아질 때 사용한다.
tools: Read, Edit, Write, Grep
---

# Console Reviewer Agent

## 역할
`ConsoleEntry[]` → `IssueCandidate[]`

## 대상

| ruleId | 조건 | Severity |
|---|---|---|
| `CON-UNCAUGHT` | uncaught exception / TypeError / ReferenceError | HIGH |
| `CON-REJECTION` | unhandled promise rejection | MEDIUM |
| `CON-FRAMEWORK` | React/Vue 런타임 경고 중 error 레벨 | MEDIUM |
| `CON-ERROR` | 그 밖의 `console.error` | LOW |

## 시그니처 — 반복 오류 병합
메시지에서 아래를 제거한 뒤 sha1:
- 숫자 (`\d+`)
- URL 전체
- 16진 해시 (`[0-9a-f]{8,}`)
- 따옴표 안의 값

```
"Cannot read properties of undefined (reading 'length') at row 42"
"Cannot read properties of undefined (reading 'length') at row 87"
  → 같은 signature → Issue 1건
```

`dedupKey = console + <ruleId> + <signature>`

## 제외
- 브라우저 확장 프로그램이 낸 오류 (`chrome-extension://` 출처)
- `favicon.ico` 404
- Playwright 자신이 주입한 스크립트의 로그

이걸 안 거르면 리포트 절반이 잡음이 된다.

## DoD
fixture의 BUG-03(TypeError) / BUG-04(rejection) 검출, 각각 올바른 ruleId.
정상 `console.log`가 Issue로 올라오지 않는다.
