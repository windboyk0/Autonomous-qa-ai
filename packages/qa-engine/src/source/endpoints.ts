/**
 * 엔드포인트 추출 + 권한 검사 판정.
 *
 * **직접 구현하는 유일한 검출기다** (CLAUDE.md §30, ROADMAP Phase 9).
 * 나머지 정적 결함은 기존 도구가 더 잘하지만, 이것만은 다르다 —
 * 실행 QA 가 **원리적으로** 볼 수 없는 영역이기 때문이다.
 * 삭제·승인·권한변경 버튼은 DANGEROUS 로 차단하는 것이 정답이고,
 * 그래서 "그 버튼을 눌렀을 때 권한을 확인하는가"는 실행으로 확인할 방법이 없다.
 * (실측: `권한관리` 16회 발견 / 0회 실행)
 */

import { NO_SECURITY_RULES, isPubliclyPermitted, type SecurityRules } from "./security-config.js";

export interface ExtractedEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";
  /** 실행 QA 의 pathTemplate 과 맞추기 위해 `{id}` 를 `:id` 로 정규화한 형태 */
  path: string;
  file: string;
  /** 핸들러 메서드가 선언된 줄 */
  line: number;
  symbol: string;
  /** 권한 검사 애너테이션이 붙어 있는가 (클래스 레벨 포함) */
  authorized: boolean;
  /** 클래스 레벨 애너테이션으로 보호되는가. 메서드에는 없어도 된다. */
  authorizedByClass: boolean;
  framework: "spring";
}

const MAPPING = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(\(([^)]*)\))?/;
const AUTHZ = /@(PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b/;

/** 애너테이션 인자에서 경로를 뽑는다. `("/x")` 도 `(value = "/x", method = ...)` 도 받는다. */
function pathFromArgs(args: string | undefined): string {
  if (!args) return "";
  const quoted = /["']([^"']*)["']/.exec(args);
  return quoted ? quoted[1]! : "";
}

function joinPath(base: string, sub: string): string {
  const b = base.replace(/\/+$/, "");
  const s = sub.startsWith("/") ? sub : sub === "" ? "" : `/${sub}`;
  const joined = `${b}${s}`;
  // `{id}` → `:id`. 실행 QA 의 경로 정규화와 같은 모양으로 맞춘다.
  return (joined === "" ? "/" : joined).replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Spring 컨트롤러 하나에서 엔드포인트를 뽑는다.
 *
 * 클래스 레벨 `@RequestMapping` 과 메서드 레벨 매핑을 이어 붙이는 것이 핵심이고,
 * 이것만 정확하면 **컨트롤러 파일·줄까지는 확정**할 수 있다.
 * 그 뒤(Service·Repository)의 호출 그래프는 컴파일러 없이 만들 수 없으므로 하지 않는다.
 */
export function extractSpringEndpoints(file: string, text: string): ExtractedEndpoint[] {
  if (!/@(RestController|Controller)\b/.test(text)) return [];

  const lines = text.split(/\r?\n/);
  const out: ExtractedEndpoint[] = [];

  /*
   * 클래스 레벨 권한.
   *
   * **이것을 놓치면 오탐이 쏟아진다.** 실측에서 `@PreAuthorize` 를 클래스에 한 번
   * 걸어 둔 컨트롤러의 엔드포인트가 전부 "권한 검사 없음" 으로 보고됐다
   * (AdminController·WorkScheduleController·CompanyController 에서 12건).
   * 메서드마다 다시 붙이지 않는 것이 오히려 정상적인 작성법이다.
   */
  let classAuthorized = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!AUTHZ.test(lines[i]!)) continue;
    // 이 애너테이션 아래로 class 선언이 먼저 나오면 클래스 레벨이다.
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const l = lines[j]!.trim();
      if (l === "" || l.startsWith("@") || l.startsWith("//") || l.startsWith("*")) continue;
      if (/\bclass\s+\w+/.test(l)) classAuthorized = true;
      break;
    }
    if (classAuthorized) break;
  }

  // 클래스 레벨 경로. @RestController 위아래의 @RequestMapping 을 찾는다.
  let base = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*@RequestMapping/.test(lines[i]!)) continue;
    // 뒤따르는 줄에 class 선언이 나오면 클래스 레벨이다.
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
      if (/\bclass\s+\w+/.test(lines[j]!)) {
        base = pathFromArgs(/\(([^)]*)\)/.exec(lines[i]!)?.[1]);
        break;
      }
    }
    if (base !== "") break;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const m = MAPPING.exec(lines[i]!);
    if (!m) continue;

    // 클래스 레벨 매핑은 건너뛴다. 아래에 class 선언이 이어지는 경우다.
    let isClassLevel = false;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
      if (/\bclass\s+\w+/.test(lines[j]!)) isClassLevel = true;
      if (/[;{]\s*$/.test(lines[j]!) && !/^\s*@/.test(lines[j]!)) break;
    }
    if (isClassLevel) continue;

    const verb = m[1]!;
    const method =
      verb === "Request" ? "ANY" : (verb.toUpperCase() as ExtractedEndpoint["method"]);
    const sub = pathFromArgs(m[3]);

    // 핸들러 선언 줄을 찾는다. 애너테이션이 여러 줄 붙어 있을 수 있다.
    let declLine = -1;
    let symbol = "";
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
      const d = /\b(?:public|protected|private)\s+[\w<>,\[\]\s.?]+\s+(\w+)\s*\(/.exec(lines[j]!);
      if (d) {
        declLine = j + 1;
        symbol = d[1]!;
        break;
      }
    }
    if (declLine < 0) continue;

    /*
     * 권한 애너테이션은 매핑 애너테이션 **앞뒤 어디에나** 올 수 있다.
     * 핸들러 선언 줄부터 위로 올라가며 애너테이션·주석·빈 줄이 이어지는 동안만 본다.
     * 그 위의 다른 메서드까지 넘어가면 남의 애너테이션을 제 것으로 착각한다.
     */
    let authorized = classAuthorized;
    for (let j = declLine - 2; j >= 0; j -= 1) {
      const l = lines[j]!.trim();
      if (l === "" || l.startsWith("//") || l.startsWith("*") || l.startsWith("/*")) continue;
      if (l.startsWith("@")) {
        if (AUTHZ.test(l)) {
          authorized = true;
          break;
        }
        continue;
      }
      break;
    }

    out.push({
      method,
      path: joinPath(base, sub),
      file,
      line: declLine,
      symbol,
      authorized,
      authorizedByClass: classAuthorized,
      framework: "spring",
    });
    i = declLine - 1;
  }

  return out;
}

/** 권한 검사가 빠졌을 때 그것이 실제로 무엇을 뜻하는가. */
export type AuthzGap =
  /** 인증도 역할도 없다. 아무나 호출할 수 있다. */
  | "open"
  /** 인증은 강제되지만 역할 제한이 없다. 로그인한 사람은 누구나 호출할 수 있다. */
  | "no-role-check";

/**
 * 권한 검사가 빠진 엔드포인트를 고른다.
 *
 * **같은 파일에 보호된 형제가 하나라도 있을 때만** 보고한다.
 * 이 조건이 정밀도의 전부다. 어떤 컨트롤러도 애너테이션을 쓰지 않는 프로젝트에서는
 * 권한을 필터나 SecurityConfig 에서 일괄 처리하는 것이 보통이고,
 * 그때 전부를 결함으로 올리면 오탐이 쏟아진다.
 * 형제 중 일부만 빠진 것은 다르다 — 그것은 **빠뜨린 것**이다.
 */
export function unauthorizedEndpoints(
  endpoints: ExtractedEndpoint[],
  rules: SecurityRules = NO_SECURITY_RULES,
): Array<{ endpoint: ExtractedEndpoint; gap: AuthzGap }> {
  const byFile = new Map<string, ExtractedEndpoint[]>();
  for (const e of endpoints) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }

  const out: Array<{ endpoint: ExtractedEndpoint; gap: AuthzGap }> = [];
  for (const list of byFile.values()) {
    if (!list.some((e) => e.authorized)) continue;
    for (const endpoint of list) {
      if (endpoint.authorized) continue;

      /*
       * 의도적으로 열어 둔 경로는 결함이 아니다.
       * 설계 결정을 버그라고 부르면 리포트 전체의 신뢰가 깎인다.
       * (실측: `GET /api/v1/logo/**` 가 permitAll 인데 CRITICAL 로 올라왔다)
       */
      if (isPubliclyPermitted(endpoint.method, endpoint.path, rules).permitted) continue;

      out.push({
        endpoint,
        // 전역으로 인증이 강제되면 "아무나"가 아니라 "로그인한 누구나"다.
        gap: rules.authenticatedByDefault ? "no-role-check" : "open",
      });
    }
  }
  return out;
}

/** 쓰기 동작인가. 권한 누락의 심각도를 가르는 기준이다. */
export function isMutating(method: ExtractedEndpoint["method"]): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
