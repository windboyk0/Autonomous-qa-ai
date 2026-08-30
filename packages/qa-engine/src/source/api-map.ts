import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiRef, CodeRef, Issue } from "@qa/shared";
import type { ExtractedEndpoint } from "./endpoints.js";

/**
 * API ↔ Source Mapper.
 *
 * 실행 QA 가 관측하는 것은 `POST /api/users → 500` 뿐이다.
 * **그것을 어느 파일 몇 번째 줄로 옮길 수 있는가**가 통합 QA 의 전부다.
 *
 * 여기서 하지 않는 것이 하는 것만큼 중요하다 — **호출 그래프를 만들지 않는다.**
 * 엔드포인트 → 컨트롤러는 어노테이션 문자열 매칭이라 확정할 수 있지만,
 * Controller → Service → Repository 의 정확한 호출 그래프는 컴파일러 없이
 * 만들 수 없다. 이름이 같은 메서드, 인터페이스 구현체 선택, 동적 위임에서 전부 틀린다.
 * 그래서 컨트롤러는 confidence 1.0 으로 확정하고, 그 컨트롤러가 **주입받는 타입**은
 * 낮은 confidence 의 추정으로만 붙인다.
 */

/** 경로를 비교 가능한 모양으로. `/api/users/12` 와 `/api/users/{id}` 가 같아야 한다. */
function normalizePath(path: string): string {
  let p = path;
  try {
    p = new URL(path, "http://x").pathname;
  } catch {
    /* 상대 경로면 그대로 */
  }
  return p
    .replace(/\{[^}]+\}/g, ":id")
    .replace(/\/:[A-Za-z_][\w]*/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}(?=\/|$)/gi, "/:id")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 컨트롤러가 생성자로 주입받는 타입 이름. `UserService` 같은 것. */
function injectedTypes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bprivate\s+final\s+([A-Z]\w+)\s+\w+\s*;/g)) out.add(m[1]!);
  for (const m of text.matchAll(/@Autowired[\s\S]{0,80}?\b([A-Z]\w+)\s+\w+\s*;/g)) out.add(m[1]!);
  return [...out];
}

export interface ApiSourceIndex {
  /** 정규화된 `METHOD path` → 엔드포인트 */
  byRoute: Map<string, ExtractedEndpoint>;
  /** 파일 경로 → 그 파일이 주입받는 타입들 */
  injected: Map<string, string[]>;
  /** 타입 이름 → 그 타입이 정의된 파일 */
  typeFile: Map<string, string>;
}

export function buildApiIndex(
  rootDir: string,
  endpoints: readonly ExtractedEndpoint[],
  files: ReadonlyArray<{ path: string; lang: string }>,
): ApiSourceIndex {
  const byRoute = new Map<string, ExtractedEndpoint>();
  for (const e of endpoints) {
    byRoute.set(`${e.method} ${normalizePath(e.path)}`, e);
  }

  const injected = new Map<string, string[]>();
  const typeFile = new Map<string, string>();
  for (const f of files) {
    if (f.lang !== "java" && f.lang !== "kotlin") continue;
    const name = f.path.split("/").pop()!.replace(/\.(java|kt)$/, "");
    typeFile.set(name, f.path);
    if (!/controller/i.test(f.path)) continue;
    try {
      injected.set(f.path, injectedTypes(readFileSync(join(rootDir, f.path), "utf8")));
    } catch {
      /* 못 읽으면 넘어간다 */
    }
  }

  return { byRoute, injected, typeFile };
}

/**
 * 요청 하나를 소스 위치로 옮긴다.
 *
 * 못 찾으면 **빈 배열을 돌려준다.** 비슷한 것을 억지로 붙이지 않는다 —
 * 엉뚱한 파일을 열게 만드는 순간 이 리포트의 신뢰가 끝난다.
 */
export function mapApiToSource(api: ApiRef, index: ApiSourceIndex): CodeRef[] {
  const key = `${api.method.toUpperCase()} ${normalizePath(api.endpointTemplate)}`;
  const endpoint = index.byRoute.get(key) ?? index.byRoute.get(`ANY ${normalizePath(api.endpointTemplate)}`);
  if (!endpoint) return [];

  const refs: CodeRef[] = [
    {
      file: endpoint.file,
      line: endpoint.line,
      symbol: endpoint.symbol,
      confidence: 1,
      reason: `${endpoint.method} ${endpoint.path} 핸들러 (어노테이션에서 확정)`,
    },
  ];

  /*
   * 컨트롤러가 주입받는 타입까지만 한 걸음 더 간다.
   * 어느 메서드가 불리는지는 모르므로 **파일만** 가리키고 줄은 비운다.
   * 아는 척하는 줄 번호보다 없는 줄 번호가 낫다.
   */
  for (const type of index.injected.get(endpoint.file) ?? []) {
    const file = index.typeFile.get(type);
    if (!file || file === endpoint.file) continue;
    refs.push({
      file,
      line: null,
      symbol: type,
      confidence: 0.5,
      reason: "핸들러가 주입받는 타입 (호출 지점은 확인하지 않음)",
    });
  }

  return refs;
}

/**
 * 실행 QA 결함에 소스 위치를 붙인다.
 *
 * 통합 모드에서만 부른다. 매핑에 실패한 것은 **그대로 둔다** —
 * 소스 위치가 없다는 것도 정보다.
 */
export function attachCodeRefs(
  issues: readonly Issue[],
  index: ApiSourceIndex,
): { issues: Issue[]; mapped: number; unmapped: string[] } {
  const unmapped: string[] = [];
  let mapped = 0;

  const out = issues.map((issue) => {
    if (!issue.apiRef || issue.codeRefs.length > 0) return issue;
    const refs = mapApiToSource(issue.apiRef, index);
    if (refs.length === 0) {
      unmapped.push(`${issue.apiRef.method} ${issue.apiRef.endpointTemplate}`);
      return issue;
    }
    mapped += 1;
    return { ...issue, codeRefs: refs };
  });

  return { issues: out, mapped, unmapped: [...new Set(unmapped)] };
}
