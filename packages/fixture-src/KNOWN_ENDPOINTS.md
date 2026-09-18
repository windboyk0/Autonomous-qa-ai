# KNOWN_ENDPOINTS — 엔드포인트 ↔ 소스 매핑 정답지

Phase 11(통합 Root Cause)과 Phase 10(Change Impact)의 채점 기준.

실행 QA가 관측하는 것은 `POST /api/users → 500` 뿐이다.
**그것을 어느 파일 몇 번째 줄로 옮길 수 있는가**가 통합 QA의 전부다.

기계가 읽는 판본: `src/known-endpoints.ts`

## 엔드포인트

| method | path | 컨트롤러 | 핸들러 | 권한 검사 |
|---|---|---|---|---|
| GET | `/api/users` | `UserController.java` | `list` | 있음 |
| GET | `/api/users/:id` | `UserController.java` | `detail` | 있음 |
| POST | `/api/users` | `UserController.java` | `create` | 있음 |
| DELETE | `/api/users/:id` | `UserController.java` | `delete` | **없음 (SRC-01)** |
| GET | `/api/depts` | `DeptController.java` | `list` | 있음 |

경로는 **클래스 레벨 `@RequestMapping` + 메서드 레벨 매핑**을 이어 붙여 만든다.
`@RequestMapping("/api/users")` + `@GetMapping` → `/api/users`.
이 접합이 매퍼의 핵심이며, 이것만 정확하면 컨트롤러까지는 확정할 수 있다.

`{id}` 는 실행 QA의 `pathTemplate` 규칙과 맞추기 위해 `:id` 로 정규화한다.

## 호출 지점 (프런트엔드)

| path | 파일 | 쓰는 화면 |
|---|---|---|
| `/api/users` (GET) | `frontend/src/api/userApi.ts` | `UserList.tsx` |
| `/api/users` (POST) | `frontend/src/api/userApi.ts` | `UserForm.tsx` |
| `/api/users/:id` (DELETE) | `frontend/src/api/userApi.ts` | — |

이 표가 **화면 ↔ 소스**를 잇는 다리다. Change Impact QA가
"`UserService.java` 가 바뀌었으니 사용자 목록·등록 화면을 먼저 보자"고 판단하는 근거다.

## 매퍼가 하지 않는 것

**호출 그래프를 만들지 않는다.**

엔드포인트 → 컨트롤러는 어노테이션 문자열 매칭이라 정확하다.
그러나 Controller → Service → Repository의 정확한 호출 그래프는 컴파일러 없이 만들 수 없다.
이름이 같은 메서드, 인터페이스 구현체 선택, 동적 위임에서 모두 틀린다.

그래서 매퍼는 **컨트롤러 파일·줄까지만 확정**하고, 그 파일이 import·주입하는 것들을
같이 묶어 AI에 넘긴다. 인과 추론은 AI가 하고, `codeRefs.confidence` 로
확정(1.0)과 추정(<1.0)을 구분한다.

## 아직 없는 것

- **Express / Next.js 라우트 매핑.** 이 fixture는 Spring만 다룬다.
  Node 백엔드를 지원하려면 별도 fixture가 필요하다. Phase 11에서 범위를 정한다.

## Phase 18 — 프로그램 소스 목록 → 연관 화면 정답지로도 쓰인다

`KNOWN_CALL_SITES`의 `screenFiles`가 그대로 "파일 목록 → 화면" 정답지다.
`UserController.java`를 프로그램 목록으로 주면 `UserList.tsx`·`UserForm.tsx`가
매핑되어야 하고, `DeptController.java`를 주지 않으면 부서 화면은 매핑되면 안 된다
(확대 해석 금지). `/api/users/:id` (DELETE)의 `screenFiles: []`는 "아직 화면이
파악되지 않은 호출"의 실제 사례로, 매핑 실패(미검증) 케이스로 그대로 재사용한다.
채점은 `packages/qa-engine/src/source/program-scope.test.ts`.
