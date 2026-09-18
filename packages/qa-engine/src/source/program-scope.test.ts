import { describe, expect, it } from "vitest";
import { ProgramScopeConfig } from "@qa/shared";
import { FIXTURE_SRC_ROOT } from "@qa/fixture-src";
import { scanProject } from "./scan.js";
import { mapProgramScope, type BaselineScreen } from "./program-scope.js";

/**
 * Phase 18 DoD.
 *
 *   소스 파일 목록 → `computeImpact()`(기존 로직 재사용) → 엔드포인트 → 베이스라인에서
 *   관측된 화면으로 매핑한다. 매핑 실패는 확대 해석하지 않고 미검증으로 남긴다.
 *
 * "파일 목록 → 화면" 정답지는 `fixture-src/KNOWN_ENDPOINTS.md`(`KNOWN_ENDPOINTS`,
 * `KNOWN_CALL_SITES`)를 그대로 쓴다 — `UserController.java`가 `/api/users` GET·POST를
 * 만들고, 그것을 부르는 화면은 각각 `UserList.tsx`·`UserForm.tsx`다.
 * `/api/users/:id` DELETE는 그 정답지에서도 `screenFiles: []`(아직 화면이 파악되지
 * 않음)로 비어 있다 — 이 테스트의 "매핑 실패" 케이스로 그대로 재사용한다.
 */

const USER_CONTROLLER = "backend/src/main/java/com/example/groupware/controller/UserController.java";
const DEPT_CONTROLLER = "backend/src/main/java/com/example/groupware/controller/DeptController.java";

const scan = scanProject(FIXTURE_SRC_ROOT, {
  maxFiles: 5_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

/** KNOWN_CALL_SITES가 말하는 "베이스라인" — 과거 전체 탐색이 실제로 관측했을 화면들. */
const BASELINE: BaselineScreen[] = [
  {
    stateKey: "s-user-list",
    screenName: "UserList",
    url: "http://x/users",
    pathTemplate: "/users",
    endpoints: ["GET /api/users"],
  },
  {
    stateKey: "s-user-form",
    screenName: "UserForm",
    url: "http://x/users/new",
    pathTemplate: "/users/new",
    endpoints: ["POST /api/users"],
  },
  {
    stateKey: "s-dept-list",
    screenName: "DeptList",
    url: "http://x/depts",
    pathTemplate: "/depts",
    endpoints: ["GET /api/depts"],
  },
];

function cfg(overrides: Partial<ProgramScopeConfig> = {}): ProgramScopeConfig {
  return ProgramScopeConfig.parse({ enabled: true, sourceFiles: [USER_CONTROLLER], ...overrides });
}

describe("Phase 18 — 프로그램 소스 목록 → 연관 화면 매핑", () => {
  it("UserController.java 목록만 주면 사용자 관련 화면만 매핑되고 부서 화면은 빠진다", () => {
    const result = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg(),
      baseline: BASELINE,
      baselineRunId: "20260101_000000",
    });

    expect(result.baselineFound).toBe(true);
    const names = result.mappedScreens.map((s) => s.screenName).sort();
    expect(names).toEqual(["UserForm", "UserList"]);
    expect(result.seedUrls.sort()).toEqual(["http://x/users", "http://x/users/new"]);
  });

  it("정확히 일치한 엔드포인트는 confidence 1.0이다", () => {
    const result = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg(),
      baseline: BASELINE,
      baselineRunId: "r",
    });
    for (const s of result.mappedScreens) expect(s.confidence).toBe(1);
  });

  it("DELETE /api/users/:id 처럼 베이스라인에 없는 엔드포인트는 미검증(unmatched)으로 남는다", () => {
    const result = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg(),
      baseline: BASELINE,
      baselineRunId: "r",
    });
    // UserController.java 는 GET /api/users, GET /api/users/:id, POST /api/users,
    // DELETE /api/users/:id 4개를 낸다. 그중 베이스라인이 관측한 건 GET·POST 뿐이다.
    expect(result.unmatchedEndpoints.some((u) => u.includes("delete") && u.includes("/api/users/:id"))).toBe(true);
  });

  it("DeptController.java 를 주지 않으면 부서 화면은 매핑되지 않는다 — 확대 해석하지 않는다", () => {
    const result = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg(),
      baseline: BASELINE,
      baselineRunId: "r",
    });
    expect(result.mappedScreens.some((s) => s.screenName === "DeptList")).toBe(false);
  });

  it("DeptController.java 도 목록에 넣으면 부서 화면까지 매핑된다", () => {
    const result = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg({ sourceFiles: [USER_CONTROLLER, DEPT_CONTROLLER] }),
      baseline: BASELINE,
      baselineRunId: "r",
    });
    const names = result.mappedScreens.map((s) => s.screenName).sort();
    expect(names).toEqual(["DeptList", "UserForm", "UserList"]);
  });

  it("베이스라인이 없으면 매핑하지 않고, 전체 탐색으로 대체한다는 사실을 근거로 남긴다", () => {
    const result = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg(),
      baseline: null,
      baselineRunId: null,
    });
    expect(result.baselineFound).toBe(false);
    expect(result.seedUrls).toHaveLength(0);
    expect(result.notes.some((n) => n.includes("전체 탐색"))).toBe(true);
  });

  it("minConfidence를 낮추지 않으면 낱말 힌트만 일치하는 화면(0.5)은 빠진다", () => {
    const hintOnlyBaseline: BaselineScreen[] = [
      ...BASELINE,
      {
        stateKey: "s-user-log",
        screenName: "UserAccessLog",
        url: "http://x/users/log",
        pathTemplate: "/users/log",
        endpoints: [], // 엔드포인트 관측 없음 — 오직 URL의 "user" 낱말 힌트로만 걸린다
      },
    ];
    const strict = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg({ minConfidence: 0.6 }),
      baseline: hintOnlyBaseline,
      baselineRunId: "r",
    });
    expect(strict.mappedScreens.some((s) => s.screenName === "UserAccessLog")).toBe(false);

    const loose = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg({ minConfidence: 0.5 }),
      baseline: hintOnlyBaseline,
      baselineRunId: "r",
    });
    expect(loose.mappedScreens.some((s) => s.screenName === "UserAccessLog")).toBe(true);
  });

  it("존재하지 않는 파일을 주면 근거(notes)에 남기고, 존재하는 파일만으로 진행한다", () => {
    const result = mapProgramScope({
      rootDir: FIXTURE_SRC_ROOT,
      scan,
      cfg: cfg({ sourceFiles: [USER_CONTROLLER, "backend/src/does-not-exist.java"] }),
      baseline: BASELINE,
      baselineRunId: "r",
    });
    expect(result.notes.some((n) => n.includes("찾을 수 없습니다"))).toBe(true);
    expect(result.mappedScreens.map((s) => s.screenName).sort()).toEqual(["UserForm", "UserList"]);
  });
});
