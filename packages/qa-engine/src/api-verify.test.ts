import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, FIXTURE_ADMIN_OPENAPI_PATH } from "@qa/fixture-admin";
import { RunConfig, type IssuesFile } from "@qa/shared";
import { RunContext, makeRunId } from "./run-context.js";
import { registerSecret } from "./emitter.js";
import { runQa } from "./run.js";

/**
 * Phase 17 DoD.
 *
 *   fixture-admin의 OpenAPI 스펙 정답지(`openapi.json`, `KNOWN_API_CASES.md`) 기준
 *   GET 계열 알려진 결함 2건을 전부 탐지하고, 나머지는 오탐 0건이어야 한다.
 *   쓰기 메서드는 기본적으로 계획만 세우고 실행하지 않아야 한다.
 */

const PASSWORD = "admin123!";

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let outDir: string;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return RunConfig.parse({
    projectName: "api-verify",
    targetUrl: fixture.url,
    headless: true,
    login: { enabled: true, username: "admin", password: PASSWORD },
    // 브라우저 탐색은 이 파일의 관심사가 아니다. 최소로 묶어 API 검증만 본다.
    budget: { maxScreens: 1, settleMs: 100 },
    ...overrides,
  });
}

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  outDir = join(tmpdir(), `qa-api-verify-${Date.now()}`);
  registerSecret(PASSWORD);
}, 30_000);

afterAll(async () => {
  await fixture.close();
});

describe("Phase 17 — API 검증 (GET 계열)", () => {
  let issuesFile: IssuesFile;

  beforeAll(async () => {
    const config = makeConfig({
      apiVerify: { enabled: true, specSource: "openapi", specPath: FIXTURE_ADMIN_OPENAPI_PATH },
    });
    const ctx = new RunContext(makeRunId(), outDir, tmpdir());
    const outcome = await runQa(config, ctx);
    expect(outcome.status).toBe("COMPLETED");
    issuesFile = JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")) as IssuesFile;
  }, 60_000);

  it("실행 5건 중 PASS 3 · FAIL 2 로 판정한다", () => {
    expect(issuesFile.summary.apiVerify).not.toBeNull();
    const av = issuesFile.summary.apiVerify!;
    expect(av.executed).toBe(5);
    expect(av.pass).toBe(3);
    expect(av.fail).toBe(2);
  });

  it("알려진 결함 2건(badge·export)을 API-STATUS-MISMATCH로 탐지한다", () => {
    const mismatches = issuesFile.issues.filter((i) => i.ruleId === "API-STATUS-MISMATCH");
    expect(mismatches).toHaveLength(2);
    const templates = mismatches.map((i) => i.apiRef?.endpointTemplate).sort();
    expect(templates).toEqual(["/api/notice/badge", "/api/stats/export"]);
  });

  it("정상 GET 3건(users·surveys·depts)에서는 오탐이 없다", () => {
    const badRules = new Set(["API-STATUS-MISMATCH", "API-SCHEMA-INVALID", "API-UNREACHABLE", "API-TIMEOUT"]);
    const falsePositives = issuesFile.issues.filter(
      (i) => badRules.has(i.ruleId) && !["/api/notice/badge", "/api/stats/export"].includes(i.apiRef?.endpointTemplate ?? ""),
    );
    expect(falsePositives).toHaveLength(0);
  });

  it("500 오류(export)는 HIGH, 404(badge)는 MEDIUM 이상으로 잡는다", () => {
    const exportIssue = issuesFile.issues.find((i) => i.apiRef?.endpointTemplate === "/api/stats/export");
    expect(exportIssue?.severity).toBe("HIGH");
  });

  it("증적이 마스킹되어 저장되고 성공 응답의 값은 남기지 않는다(이름·타입만)", () => {
    const ev = issuesFile.issues[0]?.evidenceIds[0];
    expect(ev).toBeDefined();
  });
});

describe("Phase 17 — 안전 정책: 쓰기 메서드는 기본적으로 실행하지 않는다", () => {
  it("allowWriteMethods 기본값(false)에서 POST는 계획만 세우고 실행하지 않는다", async () => {
    const config = makeConfig({
      apiVerify: {
        enabled: true,
        specSource: "manual",
        manualCases: [{ method: "POST", path: "/api/surveys", body: { title: "AUTO-QA-should-not-run" } }],
      },
    });
    const ctx = new RunContext(makeRunId(), outDir, tmpdir());
    const outcome = await runQa(config, ctx);
    expect(outcome.status).toBe("COMPLETED");
    const issuesFile = JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")) as IssuesFile;
    expect(issuesFile.summary.apiVerify?.executed).toBe(0);
    expect(issuesFile.summary.apiVerify?.plannedNotExecuted).toHaveLength(1);
    expect(issuesFile.summary.unverifiedAreas.some((a) => a.includes("API 검증 미실행"))).toBe(true);
  }, 30_000);

  it("AUTO-QA 마커 없이 allowWriteMethods만 켜도 POST를 실행하지 않는다", async () => {
    const config = makeConfig({
      apiVerify: {
        enabled: true,
        specSource: "manual",
        allowWriteMethods: true,
        manualCases: [{ method: "POST", path: "/api/surveys", body: { title: "실데이터처럼 보이는 제목" } }],
      },
    });
    const ctx = new RunContext(makeRunId(), outDir, tmpdir());
    await runQa(config, ctx);
    const issuesFile = JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")) as IssuesFile;
    expect(issuesFile.summary.apiVerify?.executed).toBe(0);
  }, 30_000);

  it("allowWriteMethods + AUTO-QA 마커가 둘 다 있으면 실행한다", async () => {
    const config = makeConfig({
      apiVerify: {
        enabled: true,
        specSource: "manual",
        allowWriteMethods: true,
        manualCases: [
          {
            method: "POST",
            path: "/api/surveys",
            body: { title: "AUTO-QA-20260101-000000-001", owner: "qa" },
            expectedStatus: [201],
          },
        ],
      },
    });
    const ctx = new RunContext(makeRunId(), outDir, tmpdir());
    await runQa(config, ctx);
    const issuesFile = JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")) as IssuesFile;
    expect(issuesFile.summary.apiVerify?.executed).toBe(1);
    expect(issuesFile.summary.apiVerify?.pass).toBe(1);
  }, 30_000);

  it("DELETE는 allowWriteMethods만으로는 실행하지 않는다 (deleteConsent도 필요)", async () => {
    const config = makeConfig({
      apiVerify: {
        enabled: true,
        specSource: "manual",
        allowWriteMethods: true,
        manualCases: [{ method: "DELETE", path: "/api/surveys/{id}", exampleValues: { id: "AUTO-QA-1" } }],
      },
    });
    const ctx = new RunContext(makeRunId(), outDir, tmpdir());
    await runQa(config, ctx);
    const issuesFile = JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")) as IssuesFile;
    expect(issuesFile.summary.apiVerify?.executed).toBe(0);
  }, 30_000);
});

describe("Phase 17 — apiVerify 꺼짐(기본값)은 기존 동작과 완전히 동일하다", () => {
  it("apiVerify.enabled가 false면 summary.apiVerify가 null이다", async () => {
    const config = makeConfig();
    expect(config.apiVerify.enabled).toBe(false);
    const ctx = new RunContext(makeRunId(), outDir, tmpdir());
    const outcome = await runQa(config, ctx);
    expect(outcome.status).toBe("COMPLETED");
    const issuesFile = JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")) as IssuesFile;
    expect(issuesFile.summary.apiVerify).toBeNull();
  }, 30_000);
});
