/**
 * 소스 QA 채점 정답지 (기계가 읽는 판본).
 *
 * 정본은 `KNOWN_SOURCE_BUGS.md` 이고 이 파일은 그것을 테스트가 쓸 수 있게 옮긴 것이다.
 * 둘의 개수가 어긋나면 테스트가 깨진다.
 *
 * **줄 번호를 적지 않는다.** 줄 번호를 손으로 적으면 fixture를 한 줄만 고쳐도
 * 정답지 전체가 틀어진다. 대신 그 줄에만 나타나는 문자열(`anchor`)을 적고,
 * 줄 번호는 읽을 때 찾는다. 앵커가 0줄이거나 2줄 이상이면 그것도 테스트가 잡는다.
 */

/** 결함이 속한 영역. 검출기를 어디에 둘지와 직결된다. */
export type SourceBugCategory =
  | "authz" // 권한 검사 — 직접 구현하는 유일한 검출기
  | "injection"
  | "secret"
  | "error-handling"
  | "null-safety"
  | "crypto"
  | "xss"
  | "dependency";

export interface KnownSourceBug {
  id: string;
  title: string;
  category: SourceBugCategory;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  /** project/ 기준 상대 경로 */
  file: string;
  /** 그 파일에서 이 줄에만 나타나는 문자열 */
  anchor: string;
  /** 실행 QA 가 같은 결함을 잡을 수 있는가. 모드를 나눈 근거가 여기에 있다. */
  runtimeCanFind: boolean;
  why: string;
}

export const KNOWN_SOURCE_BUGS: KnownSourceBug[] = [
  {
    id: "SRC-01",
    title: "삭제 엔드포인트에 권한 검사가 없다",
    category: "authz",
    severity: "CRITICAL",
    file: "backend/src/main/java/com/example/groupware/controller/UserController.java",
    anchor: '@DeleteMapping("/{id}")',
    runtimeCanFind: false,
    why:
      "같은 컨트롤러의 다른 엔드포인트에는 모두 @PreAuthorize 가 있는데 삭제에만 없다. " +
      "실행 QA 는 삭제 버튼을 DANGEROUS 로 차단하는 것이 정답이므로 이 결함을 원리적으로 볼 수 없다.",
  },
  {
    id: "SRC-02",
    title: "사용자 입력을 이어 붙여 SQL 을 만든다",
    category: "injection",
    severity: "CRITICAL",
    file: "backend/src/main/java/com/example/groupware/repository/UserRepositoryImpl.java",
    anchor: "SELECT * FROM users WHERE name LIKE",
    runtimeCanFind: false,
    why: "검색어가 그대로 쿼리에 들어간다. 화면에서는 검색이 정상 동작하는 것처럼 보인다.",
  },
  {
    id: "SRC-03",
    title: "예외를 삼킨다",
    category: "error-handling",
    severity: "MEDIUM",
    file: "backend/src/main/java/com/example/groupware/service/UserService.java",
    anchor: "// SRC-03",
    runtimeCanFind: false,
    why: "저장이 실패해도 catch 블록이 비어 있어 호출자도 사용자도 알 수 없다.",
  },
  {
    id: "SRC-04",
    title: "Optional 을 확인 없이 꺼낸다",
    category: "null-safety",
    severity: "MEDIUM",
    file: "backend/src/main/java/com/example/groupware/service/UserService.java",
    anchor: "return userRepository.findById(id).get();",
    runtimeCanFind: true,
    why: "없는 id 로 상세를 열면 500 이 된다. 실행 QA 도 500 은 보지만 원인은 못 짚는다.",
  },
  {
    id: "SRC-05",
    title: "운영 설정 파일에 평문 비밀번호가 있다",
    category: "secret",
    severity: "HIGH",
    file: "backend/src/main/resources/application-prod.yml",
    anchor: "password: CHANGE_ME_fixture_only",
    runtimeCanFind: false,
    why:
      "값을 읽지 않아도 키 이름과 파일 이름만으로 보고할 수 있다. " +
      "스캐너는 값을 읽어서는 안 된다(CLAUDE.md §16-1).",
  },
  {
    id: "SRC-06",
    title: "비밀번호를 인코딩 없이 저장한다",
    category: "crypto",
    severity: "CRITICAL",
    file: "backend/src/main/java/com/example/groupware/service/UserService.java",
    anchor: "user.setPassword(request.getPassword());",
    runtimeCanFind: false,
    why: "PasswordEncoder 를 거치지 않는다. 유출 시 전 계정이 즉시 뚫린다.",
  },
  {
    id: "SRC-07",
    title: "필수 참조가 null 인 경우를 처리하지 않는다",
    category: "null-safety",
    severity: "HIGH",
    file: "backend/src/main/java/com/example/groupware/service/UserService.java",
    anchor: "departmentRepository.findById(request.getDepartmentId())",
    runtimeCanFind: true,
    why:
      "부서를 고르지 않고 저장하면 여기서 터진다. 화면에는 500 만 보인다 — " +
      "통합 QA 가 화면 오류를 이 줄까지 연결해야 하는 대표 사례다.",
  },
  {
    id: "SRC-08",
    title: "fetch 응답 상태를 확인하지 않는다",
    category: "error-handling",
    severity: "MEDIUM",
    file: "frontend/src/api/userApi.ts",
    anchor: "return res.json();",
    runtimeCanFind: true,
    why: "500 이 와도 json() 을 시도한다. 화면에는 빈 목록이 정상처럼 보인다.",
  },
  {
    id: "SRC-09",
    title: "실패를 처리하지 않는 fetch",
    category: "error-handling",
    severity: "MEDIUM",
    file: "frontend/src/api/userApi.ts",
    anchor: "// SRC-09",
    runtimeCanFind: true,
    why: "await 도 catch 도 없다. 저장 실패가 조용히 묻힌다.",
  },
  {
    id: "SRC-10",
    title: "서버 값을 그대로 HTML 로 넣는다",
    category: "xss",
    severity: "HIGH",
    file: "frontend/src/pages/UserList.tsx",
    anchor: "dangerouslySetInnerHTML",
    runtimeCanFind: false,
    why: "저장형 XSS 경로. 정상 데이터만 있으면 화면은 멀쩡해 보인다.",
  },
  {
    id: "SRC-11",
    title: "API 토큰이 소스에 하드코딩되어 있다",
    category: "secret",
    severity: "CRITICAL",
    file: "frontend/src/api/userApi.ts",
    anchor: "const API_TOKEN =",
    runtimeCanFind: false,
    why:
      "시크릿 '파일'이 아니라 일반 소스 안의 시크릿이다. " +
      "미열람 대상(§16-1)과 검출 대상을 가르는 경계 사례다.",
  },
  {
    id: "SRC-12",
    title: "알려진 취약점이 있는 의존성을 고정해 쓴다",
    category: "dependency",
    severity: "MEDIUM",
    file: "frontend/package.json",
    anchor: '"lodash": "4.17.11"',
    runtimeCanFind: false,
    why: "lodash 4.17.11 은 프로토타입 오염 취약점이 있는 버전이다.",
  },
];

/** 실행 QA 가 원리적으로 못 찾는 것들. 소스 QA 의 존재 이유다. */
export const SOURCE_ONLY_BUGS = KNOWN_SOURCE_BUGS.filter((b) => !b.runtimeCanFind);
