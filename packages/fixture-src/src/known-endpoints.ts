/**
 * 엔드포인트 ↔ 소스 매핑 정답지 (Phase 11 채점 기준).
 *
 * 실행 QA 가 관측하는 것은 `POST /api/users → 500` 뿐이다.
 * 그것을 어느 파일 몇 번째 줄로 옮길 수 있는지가 통합 QA 의 전부이며,
 * 이 표가 그 채점 기준이다.
 *
 * 줄 번호 대신 앵커를 쓰는 이유는 `known-bugs.ts` 와 같다.
 */

export interface KnownEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 실행 QA 가 관측하는 모양. 경로 변수는 :id 로 정규화한 형태다. */
  path: string;
  framework: "spring";
  /** project/ 기준 상대 경로 */
  file: string;
  /** 핸들러 메서드가 선언된 줄에만 나타나는 문자열 */
  anchor: string;
  /** 이 엔드포인트에 권한 검사가 있는가. SRC-01 의 채점 근거다. */
  authorized: boolean;
}

export const KNOWN_ENDPOINTS: KnownEndpoint[] = [
  {
    method: "GET",
    path: "/api/users",
    framework: "spring",
    file: "backend/src/main/java/com/example/groupware/controller/UserController.java",
    anchor: "public List<User> list(",
    authorized: true,
  },
  {
    method: "GET",
    path: "/api/users/:id",
    framework: "spring",
    file: "backend/src/main/java/com/example/groupware/controller/UserController.java",
    anchor: "public User detail(",
    authorized: true,
  },
  {
    method: "POST",
    path: "/api/users",
    framework: "spring",
    file: "backend/src/main/java/com/example/groupware/controller/UserController.java",
    anchor: "public ResponseEntity<User> create(",
    authorized: true,
  },
  {
    method: "DELETE",
    path: "/api/users/:id",
    framework: "spring",
    file: "backend/src/main/java/com/example/groupware/controller/UserController.java",
    anchor: "public ResponseEntity<Void> delete(",
    authorized: false,
  },
  {
    method: "GET",
    path: "/api/depts",
    framework: "spring",
    file: "backend/src/main/java/com/example/groupware/controller/DeptController.java",
    anchor: "public List<Map<String, Object>> list(",
    authorized: true,
  },
];

/**
 * 프런트엔드가 실제로 부르는 곳. 화면 → API → 컨트롤러를 잇는 중간 고리다.
 * Change Impact QA 가 "이 파일이 바뀌면 어느 화면을 먼저 볼까"를 정할 때 쓴다.
 */
export interface KnownCallSite {
  path: string;
  file: string;
  anchor: string;
  /** 이 호출을 쓰는 화면 컴포넌트 */
  screenFiles: string[];
}

export const KNOWN_CALL_SITES: KnownCallSite[] = [
  {
    path: "/api/users",
    file: "frontend/src/api/userApi.ts",
    anchor: 'fetch("/api/users?keyword="',
    screenFiles: ["frontend/src/pages/UserList.tsx"],
  },
  {
    path: "/api/users",
    file: "frontend/src/api/userApi.ts",
    anchor: 'fetch("/api/users", {',
    screenFiles: ["frontend/src/pages/UserForm.tsx"],
  },
  {
    path: "/api/users/:id",
    file: "frontend/src/api/userApi.ts",
    anchor: 'fetch("/api/users/" + id',
    screenFiles: [],
  },
];
