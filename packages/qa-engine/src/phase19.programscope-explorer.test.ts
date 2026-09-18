import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "@qa/fixture-admin";
import { RunConfig } from "@qa/shared";
import { launch } from "./browser.js";
import { Collector } from "./collector.js";
import { Explorer, makeStartPlan, type AllowedScope } from "./explorer.js";
import { login } from "./login.js";
import { RunContext, makeRunId } from "./run-context.js";
import { registerSecret } from "./emitter.js";

/**
 * Phase 19 DoD.
 *
 *   지정한 프로그램만 탐색되고 나머지 화면은 방문하지 않음을 회귀로 확인한다.
 *   allowedScope(programScope)가 꺼져 있으면(null) 기존 동작과 완전히 동일해야
 *   한다 — Phase 2의 결정성·완주 DoD가 그대로 성립해야 한다.
 *
 * 실제 Chromium을 두 번 띄우므로(범위 제한 1회 + 무제한 1회) 느리다. Phase 2와
 * 같은 이유로 beforeAll에 큰 타임아웃을 준다.
 */

const PASSWORD = "admin123!";

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let outDir: string;

async function explore(allowedScope: AllowedScope | null): Promise<{
  screens: string[];
  urls: string[];
  scopedSkips: string[];
  scopedLimits: string[];
}> {
  const config = RunConfig.parse({
    projectName: "fixture",
    targetUrl: fixture.url,
    headless: true,
    login: { enabled: true, username: "admin", password: PASSWORD },
    budget: { settleMs: 120, maxDurationMs: 240_000 },
  });

  const ctx = new RunContext(makeRunId(new Date(Date.now() + Math.random() * 1e6)), outDir, ".");
  const session = await launch(config);
  const collector = new Collector();
  collector.attach(session.page);

  try {
    await session.page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const result = await login(session.page, config.login, config.targetUrl);
    expect(result.success, result.reason).toBe(true);

    const explorer = new Explorer(session.page, ctx, collector, config, undefined, [], allowedScope);
    const explored = await explorer.explore(makeStartPlan(result.landedUrl));
    return {
      screens: explored.graph.nodes.map((n) => n.screenName),
      urls: explored.graph.nodes.map((n) => n.url),
      scopedSkips: explored.actionResults.filter((r) => r.outcome === "SKIPPED_SCOPE").map((r) => r.reason),
      scopedLimits: explored.limits.filter((l) => l.includes("programScope")),
    };
  } finally {
    await session.close();
  }
}

let scoped: Awaited<ReturnType<typeof explore>>;
let unrestricted: Awaited<ReturnType<typeof explore>>;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  outDir = join(tmpdir(), `qa-phase19-${Date.now()}`);
  registerSecret(PASSWORD);

  const deptScope: AllowedScope = {
    seedUrls: [new URL("/depts", fixture.url).toString()],
    allowedPathTemplates: new Set(["/depts"]),
  };
  scoped = await explore(deptScope);
  unrestricted = await explore(null);
}, 600_000);

afterAll(async () => {
  await fixture.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 19 - programScope 켜짐: 매핑된 화면만 탐색한다", () => {
  it("부서관리 화면만 시드로 주면 그 화면과 그 안의 모달만 방문한다", () => {
    expect(scoped.screens).toContain("부서관리");
    // 부서 등록은 URL이 바뀌지 않는 모달이다. 같은 화면 안의 액션은 그대로 허용된다.
    expect(scoped.screens).toContain("부서관리 > 부서 등록");
  });

  it("매핑되지 않은 다른 화면은 방문하지 않는다", () => {
    for (const forbidden of ["사용자관리", "설문관리", "설정 > 일반", "대시보드"]) {
      expect(scoped.screens, `${forbidden} 화면을 방문하면 안 된다`).not.toContain(forbidden);
    }
  });

  it("범위 밖으로 이어지는 링크는 사유와 함께 기록되고 더 탐색하지 않는다", () => {
    // href 기반 링크는 SKIPPED_SCOPE 액션 결과로, data-testid 기반 링크(클릭 후 판정)는
    // limits 메시지로 남는다 — 어느 쪽이든 "왜 안 갔는지"가 반드시 기록되어야 한다.
    expect(scoped.scopedSkips.length + scoped.scopedLimits.length).toBeGreaterThan(0);
  });
});

describe("Phase 19 - programScope 꺼짐: 기존 동작과 완전히 동일하다", () => {
  it("allowedScope가 null이면 전체 화면을 방문한다 (회귀 없음)", () => {
    for (const expected of ["대시보드", "사용자관리", "설문관리", "부서관리", "설정 > 일반"]) {
      expect(unrestricted.screens, `${expected} 화면을 놓쳤다`).toContain(expected);
    }
  });

  it("범위 제한으로 인한 SKIPPED_SCOPE/limits가 발생하지 않는다", () => {
    expect(unrestricted.scopedSkips).toHaveLength(0);
    expect(unrestricted.scopedLimits).toHaveLength(0);
  });
});
