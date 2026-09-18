# KNOWN_API_CASES — API 검증 채점 정답지 (Phase 17)

`openapi.json`이 정답지 본체다. 이 문서는 그것을 사람이 읽는 표로 요약한다.

기계가 읽는 판본은 `openapi.json` 자체 — API 검증(`api-verify.ts`)은 이 파일을 파싱해
케이스를 만들고, `server.ts`가 실제로 응답하는 값과 비교한다.

## GET 케이스 5개

| method | path | 스펙상 기대 | 실제 응답 | 판정 |
|---|---|---|---|---|
| GET | `/api/users` | 200 + 스키마 | 200, 배열 | PASS |
| GET | `/api/surveys` | 200 + 스키마 | 200, 배열 | PASS |
| GET | `/api/depts` | 200 + 스키마 | 200, 배열 | PASS |
| GET | `/api/notice/badge` | 200 | **항상 404** (BUG-02 재사용) | **FAIL — `API-STATUS-MISMATCH`** |
| GET | `/api/stats/export` | 200 | **항상 500** (BUG-01 재사용) | **FAIL — `API-STATUS-MISMATCH`** |

**DoD**: GET 5건 중 알려진 결함 2건(badge·export)을 전부 탐지하고, 나머지 3건은
오탐 0건이어야 한다.

## 쓰기 케이스 (안전 정책)

| method | path | 기본(`allowWriteMethods=false`) | `allowWriteMethods=true` + AUTO-QA 마커 |
|---|---|---|---|
| POST | `/api/surveys` | **계획만 세우고 실행하지 않음** | 실행됨 (실제로 `AUTO-QA-*` 설문이 생성된다) |

DELETE 케이스는 이 스펙에 포함하지 않는다 — fixture-admin의 삭제 API는 시드 데이터를
404로 보호하므로(§10 소유권 판정) `crud.deleteConsent` + AUTO-QA 소유 확인까지 겹치는
경로는 `phase6.integration.test.ts`가 이미 CRUD 경로로 검증하고 있다. API 직접 호출
경로에서의 안전 정책 자체는 `api-verify.test.ts`의 단위 테스트로 따로 본다.

## 인증

`security: [{cookieAuth: []}]`를 모든 GET에 달아 두었다. `authMode: "reuse-session"`이면
로그인 세션 쿠키를 그대로 재사용해 호출한다 — 로그인하지 않은 상태에서는 API 검증을
건너뛴다(§1.3).
