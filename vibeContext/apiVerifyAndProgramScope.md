# API 검증 + 프로그램 범위 한정 QA — 요구사항·설계안 (Phase 17~19 제안)

> 이 문서는 `vibeContext/analyResult.md`(업무 분석)가 §0-1·§0-3에서 지적한 두 가지 편차 —
> "부분 검수(특정 프로그램만 검사) 기능이 없다", "API를 독립적으로 검증하지 않고 화면이 유발한
> 요청만 관측한다" — 를 실제로 메우기 위한 요구사항과 설계안이다. **아직 구현되지 않았다.**
> `CLAUDE.md`(정본 스펙)·`ROADMAP.md`(Phase 순서) 반영 여부는 팀 확인 후 진행한다.
>
> 작성 배경: 2026-09-18 요청 — "① API 검증, ② 프로그램 source 목록을 입력하면 연관된 업무
> 프로그램들을 찾아서 검증." 아래 4가지로 방향을 확정했다.
>
> | 결정 사항 | 확정된 방향 |
> |---|---|
> | API 검증 방식 | 화면 조작과 무관하게 엔드포인트를 **직접 호출**하고 **응답 스키마까지 검증** |
> | 프로그램 목록의 입력 형태 | **소스 파일 경로 목록** |
> | 매핑 후 검증 범위 | 연관된 **화면·API만 실행 QA**(브라우저 탐색을 그 범위로 한정) |
> | 이번 단계 산출물 | 요구사항·설계 문서 (구현은 팀 검토 후 별도 착수) |

---

## 0. 왜 이 두 기능인가 — 기존 분석과의 연결

`analyResult.md` §0-3이 정확히 짚었듯, 현재 이 도구가 "API를 검증한다"고 부를 만한 것은 두
갈래뿐이다 — ① 화면 조작이 유발한 요청의 런타임 상태코드 관측(`collector.ts` → `detect.ts`),
② 소스 코드 상의 엔드포인트 정적 검사(`source/endpoints.ts`). **엔드포인트를 독립적으로 호출해
응답 스키마·필드값을 검증하는 기능은 존재하지 않는다.** (`collector.ts:176` — `responseBodySnippet: null`)

또한 §0-1이 명시하듯, **부분 검수(특정 메뉴·프로그램만 검사) 기능도 존재하지 않는다.** `startPath`는
탐색 시작점일 뿐이고, Change Impact(`source/change-impact.ts`)조차 "범위를 줄이지 않고 순서만
바꾸는" 힌트일 뿐이다(`explorer.ts:100` 부근 `takeNextPlan`, `impactScore` 사용처).

두 요청 모두 이미 문서화된 결함(gap)을 메우는 것이라, **새 원칙을 만들기보다 기존 설계 원칙
(§30 "새 파이프라인을 만들지 않는다", §11 "호출 그래프를 만들지 않는다", §9 "동의 없이 실행하지
않는다")을 그대로 계승**하는 방향으로 설계했다.

---

## 1. 기능 A — API 검증 (직접 호출 + 스키마 검증)

### 1.1 목표 / 비목표

**목표**: 화면이 그 API를 호출하는지와 무관하게, 엔드포인트 목록을 능동적으로 호출해
① 상태코드 ② 응답 스키마(필수 필드·타입) ③ 응답 시간을 검증한다. 결과는 기존
`IssueCandidate` → `judge()` → `report.md` 파이프라인에 그대로 합류시킨다(§30 원칙 계승,
새 리포트 포맷을 만들지 않는다).

**비목표**: 부하·성능 테스트가 아니다. 저장소 전체에서 엔드포인트를 자동 발견하는 기능도
아니다(그건 `source/endpoints.ts`의 몫이며 이미 있다) — 이 기능은 **명세 또는 사용자가 준
목록에 있는 엔드포인트만** 호출한다. 저장소 전체를 넘겨받아 "알아서 찾아 호출"하지 않는 이유는
CLAUDE.md §16-1의 "저장소 전체를 넘기는 선택지는 두지 않는다"는 원칙과 같은 결이다 — 여기서는
AI 업로드가 아니라 **실제 HTTP 부작용**이 걸려 있어 훨씬 더 보수적이어야 한다.

### 1.2 입력 모델

```ts
export const ApiTestCase = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),                       // "/api/users/{id}" — :id 는 exampleValues 로 채운다
  headers: z.record(z.string()).default({}),
  queryParams: z.record(z.string()).default({}),
  body: z.unknown().nullable().default(null),
  exampleValues: z.record(z.string()).default({}), // {id: "1"} 처럼 경로 변수 치환값
  expectedStatus: z.array(z.number()).default([]),  // 비우면 스펙의 responses 키에서 유도
  expectedSchemaRef: z.string().nullable().default(null), // OpenAPI 컴포넌트 참조
});

export const ApiVerifyConfig = z.object({
  enabled: z.boolean().default(false),
  specSource: z.enum(["openapi", "manual"]).default("openapi"),
  specPath: z.string().default(""),          // openapi.json/yaml 경로
  manualCases: z.array(ApiTestCase).default([]),
  /** 자동 허용 메서드. 쓰기는 기본적으로 계획만 세우고 실행하지 않는다 (§1.4 참고). */
  allowWriteMethods: z.boolean().default(false),
  authMode: z.enum(["reuse-session", "bearer", "none"]).default("reuse-session"),
  bearerToken: z.string().default(""),
  timeoutMs: z.number().int().positive().default(15_000),
});
```

- **OpenAPI 우선.** 사내 레거시 API처럼 명세가 없는 경우를 위해 `manual` 소스도 지원하되,
  `manual`은 "API 발견"이 아니라 "사용자가 이미 알고 있는 엔드포인트를 하나씩 등록"하는
  용도다 — 저장소를 뒤져 엔드포인트를 추측하지 않는다(§16-1 원칙과 동일한 이유).
- Postman 컬렉션 임포트는 이번 단계의 확정 방향(직접 호출+스키마 검증)과 다른 축이라 **1단계
  범위에서 제외**하고, `ApiTestCase[]`로 변환하는 어댑터만 추가하면 되도록 인터페이스를
  분리해 둔다(향후 확장 여지, §6 참고).

### 1.3 인증 — 세션 재사용이 기본값

`browser.ts:64`의 `launch()`가 만드는 `BrowserSession.context`는 Playwright의
`BrowserContext`이고, 로그인 성공 후에는 이미 세션 쿠키를 들고 있다. Playwright의
`context.request`(APIRequestContext)는 **같은 쿠키 저장소를 공유**하므로, 로그인 이후
`session.context.request.fetch(url, {method, headers, data})`로 직접 호출하면 **추가
인증 로직 없이** 이미 로그인된 사용자 권한으로 API를 두드릴 수 있다.

- `authMode: "reuse-session"` (기본값) — 위 방식. **`config.login.enabled`가 꺼져 있거나
  로그인에 실패하면 이 모드는 쓸 수 없다** — 그 경우 API 검증은 스킵하고 사유를 리포트에 남긴다.
- `authMode: "bearer"` — 로그인 없이 토큰만으로 붙는 대상(내부 API 서버 등)을 위한 대안.
  토큰은 `config.login.password`와 동일하게 `registerSecret()`으로 마스킹 등록해 로그·리포트에
  절대 남지 않게 한다(`cli.ts:277`와 동일 원칙).
- `authMode: "none"` — 인증이 필요 없는 공개 API용.

**실행 시점**: `run.ts`의 로그인 성공 직후, `Explorer` 생성 이전(§업무1 Flow 9~10 사이)에
새 단계로 끼워 넣는다 — 탐색이 세션을 흔들기 전에 깨끗한 상태에서 검증하기 위해서다.

### 1.4 안전 정책 — 쓰기 메서드는 기본적으로 실행하지 않는다

**이 기능에서 가장 위험한 지점이다.** OpenAPI 스펙만 보고 POST/PUT/PATCH/DELETE에 넣을 요청
바디를 자동 생성해서 실제로 쏘면, 실 운영 데이터를 오염시키거나 원치 않는 부작용(메일 발송,
결제 등)을 일으킬 수 있다. §9(Safety Policy)·§10(CRUD 데이터 소유권)이 이미 이 문제를 화면
조작에 대해 풀어냈으므로, API 직접 호출에도 **같은 수준의 방어**를 적용한다.

| HTTP 메서드 | 기본 동작 | 실행 조건 |
|---|---|---|
| GET / HEAD | 자동 허용 (SAFE) | 항상 |
| POST / PUT / PATCH | 기본 **계획만 생성, 실행 안 함** (§9의 CAUTION과 동일 성격) | `apiVerify.allowWriteMethods === true` **그리고** 요청 바디에 `AUTO-QA-` 마커를 주입할 수 있는 필드가 명시된 경우만(§10 CRUD 원칙 재사용) |
| DELETE | 기본 차단 (DANGEROUS) | `allowWriteMethods` + `crud.deleteConsent` 둘 다, 그리고 대상이 `AUTO-QA-` 소유 데이터로 확인될 때만 |

마커를 주입할 필드를 지정할 수 없는 스펙(예: 필수 필드가 스키마상 마커를 넣을 수 없는 enum)은
**쓰기 호출 자체를 시도하지 않고** "미검증(쓰기 API, 안전한 테스트 데이터 생성 불가)"으로
리포트에 남긴다 — 억지로 실행해 사고를 내는 것보다 안 본 것을 정직하게 적는 쪽이 낫다는
기존 원칙(§업무3 "조용히 끝내지 않는다")과 같다.

### 1.5 응답 검증

1. **상태코드**: `expectedStatus`가 있으면 그대로, 없으면 OpenAPI의 `responses` 키(예: `200`,
   `4XX`)에서 유도. 불일치 시 `API-STATUS-MISMATCH`.
2. **스키마**: 선언된 JSON Schema/OpenAPI 컴포넌트로 필수 필드·타입만 검증(ajv 등 사용,
   `additionalProperties`는 기본 허용 — 알 수 없는 필드가 있다고 실패시키면 오탐이 쏟아진다,
   §30 "오탐을 늘리는 자체 검출기 금지"와 같은 원칙). 불일치 시 `API-SCHEMA-INVALID`.
3. **응답 시간**: 기존 §16 `NET-SLOW` 기준(>3000ms)을 그대로 재사용.
4. **마스킹**: 응답 바디에 `Authorization`/토큰/비밀번호류 필드가 있으면 값은 저장 전에
   마스킹한다(`collector.ts::maskHeaders`와 동일 원칙을 바디 필드 단위로 확장). **단, 현재
   원칙(`responseBodySnippet: null`, §16)과 달리 이 기능은 검증이 목적이라 바디 검사가
   불가피하다** — 검증에 성공한 필드는 이름·타입만 로그에 남기고, 실패한 경우에만 마스킹된
   값 일부를 증적으로 남기는 절충안을 제안한다. **이 부분은 팀 확인이 필요하다**(§6-1).
5. **보너스 — 런타임 권한 우회 탐지**: 로그인 세션이 아닌 **비로그인 상태의 request context**로
   같은 엔드포인트를 호출했을 때 401/403이 아니라 200이 나오면, 이는 `source/endpoints.ts`가
   정적으로 찾는 "권한 검사 누락"의 **실행 시점 버전**이다. 스펙에 `security` 요구사항이 명시된
   엔드포인트에 한해 이 교차검증을 추가하면 CRITICAL 등급 결함을 실행 QA에서도 잡을 수 있다 —
   1단계 필수는 아니지만 설계에 반영해 둘 가치가 있다(§6 열린 질문).

### 1.6 리포트/Issue 통합

- 새 `ruleId`: `API-STATUS-MISMATCH`, `API-SCHEMA-INVALID`, `API-TIMEOUT`, `API-UNREACHABLE`,
  `API-AUTH-BYPASS`(§1.5-5).
- `IssueCandidate.apiRef`(이미 있는 필드, `issue.ts:33`)를 그대로 채워서 만든다 — 이러면
  기존 `attachCodeRefs()`(통합 모드, `api-map.ts:128`)가 **아무 수정 없이** 이 결함에도
  소스 위치를 붙여준다. 새 매핑 로직이 필요 없다.
- `report.md`에 새 절 "API 검증 결과" 추가 — 엔드포인트별 PASS/FAIL, 미검증(쓰기 API) 목록.

### 1.7 CLI/Config 확장안

```
--api-verify              apiVerify.enabled
--api-spec <path>         apiVerify.specPath (openapi.json/yaml)
--api-allow-write         apiVerify.allowWriteMethods
--api-auth <mode>         apiVerify.authMode (reuse-session|bearer|none)
--api-token-stdin         bearer 토큰을 stdin으로 (비밀번호와 같은 이유, cli.ts:121 참고)
```

---

## 2. 기능 B — 프로그램 소스 목록 → 연관 업무 프로그램 매핑 → 범위 한정 실행 QA

### 2.1 목표 / 비목표

**목표**: 소스 파일 경로 목록을 입력하면 ① 관련 API 엔드포인트를 추정하고 ② 그 엔드포인트를
실제로 호출하는 화면(URL)을 추정한 뒤 ③ **그 화면들만** 브라우저로 탐색·검증한다. 이것이
곧 `analyResult.md` §0-1이 "분석 대상 자체에 없는 기능"이라 명시한 **부분 검수**다.

**비목표**: 100% 정확한 매핑을 보장하지 않는다. 매핑에 실패한 항목은 확대 해석하지 않고
"미검증"으로 리포트에 남긴다(`api-map.ts:84`의 "못 찾으면 빈 배열을 돌려준다, 비슷한 것을
억지로 붙이지 않는다" 원칙을 그대로 계승).

### 2.2 입력 모델

```ts
export const ProgramScopeConfig = z.object({
  enabled: z.boolean().default(false),
  /** 프로젝트 루트(config.source.rootDir) 기준 상대경로 목록 */
  sourceFiles: z.array(z.string()).default([]),
  /** 한 줄에 한 경로씩 적은 텍스트 파일. sourceFiles와 병합된다 */
  sourceFilesListPath: z.string().default(""),
  /** 이 값 미만의 confidence로 매핑된 화면은 탐색 대상에서 빼고 "미검증"에만 적는다 */
  minConfidence: z.number().min(0).max(1).default(0.5),
});
```

- 입력은 **소스 파일 경로 목록**으로 확정했다(예: 이번 릴리즈에서 변경된 `.java`/`.tsx` 파일
  리스트). 업무 프로그램 ID나 화면명 목록이 아니므로, 사내에서 쓰는 프로그램ID 체계와의
  연결은 이번 범위에 없다 — 필요해지면 "프로그램ID → 소스파일" 매핑 테이블을 한 단계 앞에
  추가하는 방식으로 확장 가능하게만 설계해 둔다.

### 2.3 파일 → 엔드포인트 매핑 — 기존 로직 재사용

`source/change-impact.ts::computeImpact(rootDir, scan, changed: ChangedFiles)`는 이미
"바뀐 파일 → 엔드포인트 → 힌트"를 정확히 이 문제와 같은 모양으로 풀고 있다(§업무11). 입력
`ChangedFiles`가 `{files, comparedWith, error}`라는 순수 데이터 구조라, git에서 왔는지
사용자가 직접 준 목록인지 `computeImpact()` 입장에서는 구분할 이유가 없다.

**제안**: `gitChangedFiles()`와 나란히 새 함수를 추가한다.

```ts
// source/change-impact.ts 에 추가
export function explicitChangedFiles(rootDir: string, files: readonly string[]): ChangedFiles {
  const existing = files.filter((f) => existsSync(join(rootDir, f)));
  const missing = files.filter((f) => !existing.includes(f));
  return {
    files: existing,
    comparedWith: "사용자 지정 프로그램 목록",
    error: missing.length > 0 ? `다음 파일을 찾을 수 없습니다: ${missing.join(", ")}` : null,
  };
}
```

이후 `computeImpact(rootDir, scan, explicitChangedFiles(rootDir, config.programScope.sourceFiles))`
를 그대로 호출하면 엔드포인트·`apiPaths`·`hints`가 **새 매핑 로직 없이** 나온다 — §30 "새
파이프라인을 만들지 않는다" 원칙을 그대로 지킨다.

### 2.4 엔드포인트/힌트 → 실제 화면(URL) — 이번 기능의 진짜 난제

여기가 기존 코드에 없는 **진짜 신규 로직**이 필요한 지점이다. `computeImpact()`가 만드는
`hints`는 지금까지 **탐색 순서**를 바꾸는 데만 쓰였다(`explorer.ts`의 `impactHints` →
`takeNextPlan`, §업무11). 크롤링을 시작하기 전에는 "이 URL이 이 엔드포인트를 호출한다"는
사전 지식이 시스템에 전혀 없다 — 그 관계는 오직 브라우저가 실제로 화면을 방문해 네트워크를
관측했을 때만 드러난다(`discover.ts`/`explorer.ts`).

**안 A (권장) — 캐시된 탐색 그래프 재사용**

1. 과거 전체 탐색 Run의 `graph.json`(`run.ts:596` 부근에서 저장, `StateGraph`: nodes+edges)과
   그 Run의 `evidence.json`/`network/*.json`(각 화면이 실제로 호출한 API 목록)을 로드한다.
   Electron 쪽에는 이미 Run 이력이 SQLite(`qa_runs`)에 있으므로 "최근 성공한 전체 탐색 Run"을
   자동으로 찾을 수 있다.
2. 화면(node) → 그 화면 방문 중 관측된 엔드포인트 목록의 역인덱스를 만든다.
3. §2.3에서 나온 엔드포인트/힌트와 대조해 일치하는 화면 노드만 추린다(`minConfidence` 이상).
4. Explorer가 이미 가지고 있는 "도달 방법"(`explorer.ts`의 `Plan`: `url` + `replay` 클릭 목록,
   §업무3 "큐는 도달 방법을 담는다")을 그대로 시드로 사용해 **그 화면들만** 재방문한다 —
   전체 BFS를 다시 돌지 않는다.

- 장점: 실측 사실 기반이라 안 B보다 정확하다. 기존 자료구조(`Plan`, `StateGraph`)를 그대로
  재사용한다.
- 단점: **최초 1회는 전체 탐색(베이스라인 Run)이 있어야 부분 검수가 가능하다.** 소스가 바뀌어
  화면이 아예 새로 생긴 경우 캐시에 없어 놓칠 수 있다 — 이 경우 "캐시에 없어 판단할 수 없는
  신규 화면 가능성"을 리포트에 경고로 남긴다(§업무3 "조용히 끝내지 않는다"와 같은 원칙).

**안 B — 정적 프런트엔드 라우트 매핑** (비권장, 참고용)

프런트엔드 라우터 설정(React Router 등)을 정적 파싱해 URL↔컴포넌트↔API 호출을 미리 지도로
만든다. 사전 탐색 없이 첫 실행부터 동작하는 장점이 있지만, 라우터 프레임워크마다 별도 파서가
필요하고 동적 라우트·코드분할에서 오탐이 잦다 — §30 "오탐을 늘리는 자체 정적 검출기 추가 금지"
원칙과 충돌 소지가 크다.

**결론**: **안 A를 기본으로 채택**하고, 캐시가 없는 첫 실행에서는 "이번 Run은 전체 탐색으로
대체하고, 이 결과를 다음 부분 검수의 기준(베이스라인)으로 남긴다"고 사용자에게 명시적으로
안내한다.

### 2.5 Explorer 필터 — 신규 파라미터 분리

기존 `impactHints`(`explorer.ts` 생성자 마지막 인자, §업무11)는 **순서만** 바꾸는 비파괴적
힌트다. 이번 기능은 **범위 자체를 제한**해야 하므로 성격이 다르다 — 같은 필드에 얹으면 안 된다.

- 새 생성자 파라미터 `allowedSeeds: Plan[] | null`(§2.4의 결과)을 추가한다.
- `allowedSeeds`가 있으면: 큐를 그 시드들로만 초기화하고, 그 화면 위에서 발견되는 액션(폼·버튼
  등, 같은 화면 안의 CRUD 조작)은 기존과 동일하게 전부 허용하되, 그 화면에서 **새로운 다른
  화면으로 이어지는 링크**는 depth 0으로 제한해 더 이상 확장하지 않는다.
- `allowedSeeds`가 없으면(`programScope.enabled === false`) **기존 동작과 완전히 동일** —
  회귀 없음(§30 원칙).
- 예산(§27-1, `ExploreBudget`)은 그대로 둔다. 범위가 좁아 사실상 소진되지 않을 것이다.

### 2.6 소스 QA와의 결합 (통합 모드)

`config.mode === "integrated" && config.programScope.enabled`일 때는 `scanProject()`에도
필터를 추가해(`onlyFiles?: string[]`), 정적 분석 대상도 목록에 명시된 파일(+§2.3에서 확장된
관련 파일)로 한정한다 — "이 프로그램들만" 이라는 의미가 소스 쪽에서도 일관되게 유지된다.

### 2.7 리포트 확장

기존 §3-1 "이번 변경이 닿는 영역"(Change Impact 전용 절)을 일반화해 "검증 대상 프로그램 범위"
절로 확장한다: 입력 파일 목록 → 매핑된 엔드포인트(확정/추정 구분, §업무11의 confidence 표기
방식 재사용) → 매핑된 화면 → 매핑 실패 항목(미검증) 표. 캐시가 없어 전체 탐색으로 대체된
경우 그 사실도 이 절 맨 위에 명시한다.

### 2.8 CLI/Config 확장안

```
--program-scope                   programScope.enabled
--program-files <a.java,b.tsx>    programScope.sourceFiles (콤마 구분)
--program-file-list <path>        programScope.sourceFilesListPath (한 줄에 한 경로)
--program-min-confidence <0~1>    programScope.minConfidence
```

Electron 쪽은 "폴더 선택"(`dialog:pickFolder`, `apps/desktop/electron/ipc.ts:160`)과 같은
패턴으로 "파일 여러 개 선택" 다이얼로그를 추가하면 된다.

---

## 3. RunConfig 스키마 변경 요약

| 신규 필드 | 위치 | 기본값 | 비고 |
|---|---|---|---|
| `apiVerify: ApiVerifyConfig` | `RunConfig` 최상위 | `{enabled: false}` | §1.2 |
| `programScope: ProgramScopeConfig` | `RunConfig` 최상위 | `{enabled: false}` | §2.2 |

두 필드 모두 기본값이 꺼짐(disabled)이고, 꺼진 상태에서는 기존 파이프라인과 **바이트 단위로
동일하게** 동작해야 한다 — `run-config.test.ts`에 회귀 테스트로 못박을 것을 제안한다(§30
원칙 계승).

---

## 4. ROADMAP 반영 제안 — 4부: API 검증 + 프로그램 범위 QA (Phase 17~19)

기존 ROADMAP의 Phase 15·16은 이미 "3부 — 앱 QA"의 예정 Phase(이상 검출→리포트, 위험 액션
정책과 예산)로 예약돼 있으므로, 이번 두 기능은 **4부**로 이어 붙이는 것을 제안한다.

| Phase | 범위 | DoD(초안) |
|---|---|---|
| 17 | API 검증 엔진 (§1) — spec 파싱, 직접 호출, 스키마 검증, 안전 정책 | fixture-admin(또는 신규 fixture-api)에 OpenAPI 스펙 정답지 추가, GET 계열 N/N 탐지·오탐 0건, 쓰기 메서드 기본 미실행 검증 |
| 18 | 프로그램 소스 매핑 (§2.2~2.4) — `explicitChangedFiles`, 캐시 기반 화면 매핑 | fixture-src에 "파일 목록 → 화면" 정답지 추가, 매핑 정확도/미검증 처리 검증 |
| 19 | 프로그램 범위 한정 Explorer + 통합 리포트 (§2.5~2.7) | 지정한 프로그램만 탐색되고 나머지 화면은 방문하지 않음을 회귀로 확인, `programScope` 꺼졌을 때 기존 동작과 완전 동일 |

기존 원칙(§30, ROADMAP 서문 "정답을 아는 테스트 대상을 먼저") 그대로, 각 Phase 착수 전
채점 정답지(fixture)부터 만든다.

---

## 5. 안전 관련 우려 — 반드시 팀 확인 필요

1. **API 직접 호출 중 쓰기 메서드는 기본적으로 실행하지 않는다**(§1.4). 이것이 과하게
   보수적이라 실용성이 떨어진다고 판단되면, "안전한 테스트 데이터 마커를 주입할 수 있는
   필드가 스펙에 명시된 경우"라는 조건을 어디까지 자동으로 판단할지 팀 논의가 필요하다.
2. **응답 바디를 저장하지 않는다는 기존 원칙(§16)과 이번 기능이 정면으로 충돌한다.** 스키마
   검증이 목적이므로 바디를 보지 않을 수 없다 — §1.5-4의 절충안(성공 시 필드명·타입만 기록,
   실패 시에만 마스킹된 값 일부 기록)을 그대로 채택할지, 더 보수적으로 갈지 결정이 필요하다.
3. **프로그램 범위 매핑(안 A)은 베이스라인 전체 탐색을 전제로 한다.** 이 전제를 시스템이
   강제할지(첫 실행은 자동으로 전체 탐색 후 캐시), 사용자가 수동으로 먼저 돌려야 하는지
   UX 결정이 필요하다.
4. Change Impact(§업무11)와 마찬가지로 이번 기능도 **컨트롤러 → 엔드포인트 매핑은 Spring
   전용**이다(ROADMAP "Express/Next.js 라우트 매핑 남음"과 동일한 기존 한계). 프런트엔드가
   Node/Next.js 백엔드인 경우 1단계 MVP 대상에서 빠진다 — 우선 Spring Boot 대상 프로젝트에
   먼저 적용할지 확인이 필요하다.

---

## 6. 열린 질문 (팀 결정 필요)

1. 사내에서 명세(OpenAPI/Swagger) 없이 운영되는 API가 흔한가? 흔하다면 `manual` 케이스 정의
   방식(Electron UI에서 엔드포인트를 하나씩 등록하는 화면 등)에 더 투자해야 한다.
2. §1.5-5의 "런타임 권한 우회 탐지"(비로그인 상태로 같은 엔드포인트 재호출)를 Phase 17에
   포함할지, 별도 Phase로 미룰지.
3. 쓰기 메서드(POST/PUT/DELETE) 직접 호출 지원을 몇 단계로 나눌지 — 1차는 GET/HEAD만,
   2차에서 안전장치를 더 갖춘 뒤 쓰기까지 확장하는 방안을 제안한다.
4. Postman 컬렉션 연동(이번 확정 방향에서는 제외)을 이후에 추가할 가치가 있는지 — 있다면
   `ApiTestCase[]`로 변환하는 어댑터 한 개만 추가하면 되도록 §1.2의 입력 모델을 설계해 두었다.
5. 프로그램 범위 매핑의 "안 A"(캐시 기반)를 채택할 때, 캐시가 오래된 경우(소스는 바뀌었는데
   탐색 그래프는 예전 것) 이를 어떻게 감지·경고할지 — 예를 들어 캐시 생성 시점 이후의 git
   커밋 수를 리포트에 표시하는 안을 고려할 수 있다.
