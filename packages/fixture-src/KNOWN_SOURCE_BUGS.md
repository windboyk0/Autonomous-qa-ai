# KNOWN_SOURCE_BUGS — 소스 QA 정답지

Phase 9 DoD의 채점 기준. `project/` 에 심어 둔 **의도적 결함 12건**이다.

이 문서가 정본이고, `src/known-bugs.ts` 는 테스트가 쓰는 판본이다.
둘의 개수가 어긋나면 `phase8.answerkey.test.ts` 가 깨진다.

**줄 번호를 적지 않는다.** 손으로 적으면 fixture를 한 줄만 고쳐도 정답지 전체가 틀어진다.
대신 그 줄에만 나타나는 문자열(앵커)로 특정하고, 줄 번호는 읽을 때 찾는다.

## 결함 목록

| id | 결함 | 분류 | Severity | 위치 | 실행 QA가 찾을 수 있나 |
|---|---|---|---|---|---|
| SRC-01 | 삭제 엔드포인트에 권한 검사가 없다 | authz | CRITICAL | `UserController.java` | **아니오** |
| SRC-02 | 사용자 입력을 이어 붙여 SQL을 만든다 | injection | CRITICAL | `UserRepositoryImpl.java` | **아니오** |
| SRC-03 | 예외를 삼킨다 (빈 catch) | error-handling | MEDIUM | `UserService.java` | **아니오** |
| SRC-04 | Optional을 확인 없이 꺼낸다 | null-safety | MEDIUM | `UserService.java` | 예 (500만) |
| SRC-05 | 운영 설정에 평문 비밀번호 | secret | HIGH | `application-prod.yml` | **아니오** |
| SRC-06 | 비밀번호를 인코딩 없이 저장 | crypto | CRITICAL | `UserService.java` | **아니오** |
| SRC-07 | 필수 참조가 null인 경우 미처리 | null-safety | HIGH | `UserService.java` | 예 (500만) |
| SRC-08 | fetch 응답 상태를 확인하지 않음 | error-handling | MEDIUM | `userApi.ts` | 예 |
| SRC-09 | 실패를 처리하지 않는 fetch | error-handling | MEDIUM | `userApi.ts` | 예 |
| SRC-10 | 서버 값을 그대로 HTML로 넣음 | xss | HIGH | `UserList.tsx` | **아니오** |
| SRC-11 | API 토큰이 소스에 하드코딩 | secret | CRITICAL | `userApi.ts` | **아니오** |
| SRC-12 | 취약한 버전의 의존성 고정 | dependency | MEDIUM | `frontend/package.json` | **아니오** |

**12건 중 8건은 실행 QA가 원리적으로 찾을 수 없다.** 이것이 모드를 나누는 근거다.

## 특별히 중요한 3건

### SRC-01 — 소스 QA의 존재 이유

```java
@PreAuthorize("hasRole('ADMIN')")   ← list / detail / create 에는 있다
@DeleteMapping("/{id}")             ← 삭제에만 없다
public ResponseEntity<Void> delete(@PathVariable Long id) {
```

실행 QA는 이것을 **원리적으로** 볼 수 없다. 삭제 버튼은 DANGEROUS로 차단하는 것이
정답이기 때문이다. 실측에서도 `🔐권한관리` 16회 발견 / **0회 실행**이었다.
차단은 성공이지만, 그래서 그 영역은 소스로만 볼 수 있다.

**직접 구현하는 유일한 검출기가 이것이다.** 나머지는 ESLint·Semgrep 같은 기존 도구가
더 잘한다 (CLAUDE.md §30, ROADMAP Phase 9).

### SRC-05 / SRC-11 — 시크릿의 경계

둘 다 "비밀이 노출됐다"지만 다루는 방식이 정반대다.

| | SRC-05 | SRC-11 |
|---|---|---|
| 위치 | 설정 파일 (`application-prod.yml`) | 일반 소스 (`userApi.ts`) |
| 스캐너가 값을 읽나 | **읽지 않는다** | 읽는다 |
| 판정 근거 | 파일 이름 + 키 이름 | 코드 안의 리터럴 |

§16-1이 금지하는 것은 **시크릿 파일의 값을 읽는 것**이다. 값을 읽지 않아도
"운영 설정에 평문 비밀번호가 있다"는 보고는 가능하다. 읽을 이유가 없다.
`secrets.properties` 도 같은 대상이며, 정답지에는 넣지 않았다 —
**미열람 대상이 결함으로 보고되면 그게 오탐**이기 때문이다.

### SRC-07 — 통합 QA의 대표 사례

```
화면: 사용자 등록에서 부서 미선택 후 저장
  ↓
POST /api/users → 500
  ↓
UserController.create
  ↓
UserService.createUser
  ↓
departmentRepository.findById(null).get()   ← 여기
```

실행 QA는 `POST /api/users → 500`에서 끝난다.
통합 QA는 이 줄까지 가야 한다. Phase 11의 채점 대상이다.

## 오탐으로 세는 것

아래를 결함으로 보고하면 **오탐**이다. Phase 9 DoD의 "오탐 3건 이하"에 포함된다.

- `secrets.properties`, `application.yml` 의 `${DB_PASSWORD}` — 환경변수 참조는 정상이다
- `docker-compose.yml` 의 `POSTGRES_PASSWORD` — 로컬 개발용 compose는 별개 문제다
- `User.java` 의 getter/setter — 관용적 코드다
- `UserForm.tsx` 의 부서 미선택 허용 — 이것은 SRC-07의 증상이지 별도 결함이 아니다
- fixture 파일의 주석에 적힌 `SRC-xx` 문자열 — **주석을 읽고 정답을 맞히면 부정행위다**

마지막 항목이 중요하다. 검출기는 주석을 근거로 삼아서는 안 된다.
Phase 9에서 이를 확인하는 테스트를 둔다.
