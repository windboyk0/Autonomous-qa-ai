import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunConfig, type Issue } from "@qa/shared";
import { FIXTURE_SRC_ROOT, KNOWN_ENDPOINTS, lineOfAnchor } from "@qa/fixture-src";
import { RunContext, makeRunId } from "./run-context.js";
import { runSourceQa, type SourceQaOutcome } from "./source/run-source.js";
import { attachCodeRefs, buildApiIndex, mapApiToSource, type ApiSourceIndex } from "./source/api-map.js";

/**
 * Phase 11 DoD.
 *
 *   화면 오류 1건이 **컨트롤러 파일·줄까지** 연결된다.
 *   매핑에 실패하면 **추정임을 명시**하거나 비워 둔다.
 *
 * 실행 QA 가 본 것은 `POST /api/users → 500` 뿐이다. 그것을 어느 줄로 옮길 수
 * 있는가가 통합 QA 의 전부이며, 이 파일이 그 채점이다.
 */

let outDir: string;
let source: SourceQaOutcome;
let index: ApiSourceIndex;

/** 실행 QA 가 만들어 낼 법한 네트워크 결함 하나. */
function networkIssue(method: string, path: string, status: number): Issue {
  return {
    id: "QA-0001",
    source: "network",
    ruleId: status >= 500 ? "NET-5XX" : "NET-4XX",
    title: `HTTP ${status}: ${method} ${path}`,
    description: `${method} ${path} 요청이 HTTP ${status}를 반환했습니다.`,
    impact: "해당 기능을 사용할 수 없습니다.",
    reproduction: ["1. 로그인"],
    recommendation: "서버 예외 원인을 확인하세요.",
    severity: "HIGH",
    priority: "P1",
    screens: ["사용자 등록"],
    evidenceIds: ["ev-0001"],
    codeRefs: [],
    apiRef: { method, endpointTemplate: path, status },
    occurrenceCount: 1,
    dedupKey: "x",
    priorityFactors: {
      severityWeight: 6,
      businessImpact: 5,
      frequency: 1,
      userExposure: 1,
      fixEffort: 3,
      score: 10,
    },
  };
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "qa-phase11-"));
  const config = RunConfig.parse({
    projectName: "fixture-src",
    mode: "source",
    source: { rootDir: FIXTURE_SRC_ROOT },
    outDir: "runs",
  });
  const ctx = new RunContext(makeRunId(), config.outDir, outDir);
  source = runSourceQa(config, ctx);
  index = buildApiIndex(FIXTURE_SRC_ROOT, source.endpoints, source.scan.files);
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 11 — 요청을 소스로 옮긴다", () => {
  it.each(KNOWN_ENDPOINTS.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s 가 컨트롤러의 정확한 줄로 연결된다",
    (_name, known) => {
      const refs = mapApiToSource(
        { method: known.method, endpointTemplate: known.path, status: 500 },
        index,
      );
      const primary = refs[0];
      expect(primary, `${known.method} ${known.path} 매핑 실패`).toBeDefined();
      expect(primary!.file).toBe(known.file);
      expect(primary!.line).toBe(lineOfAnchor(known.file, known.anchor));
      expect(primary!.confidence).toBe(1);
    },
  );

  /** 실행 QA 는 실제 id 가 든 경로를 본다. 정규화가 맞아야 연결된다. */
  it("실제 id 가 든 경로도 :id 로 정규화해 연결한다", () => {
    const refs = mapApiToSource(
      { method: "DELETE", endpointTemplate: "/api/users/1204", status: 500 },
      index,
    );
    expect(refs[0]?.symbol).toBe("delete");
  });

  /**
   * 컨트롤러 다음은 확정할 수 없다. 파일만 가리키고 줄은 비운다 —
   * 아는 척하는 줄 번호보다 없는 줄 번호가 낫다.
   */
  it("서비스는 추정으로만 붙이고 줄 번호를 지어내지 않는다", () => {
    const refs = mapApiToSource(
      { method: "POST", endpointTemplate: "/api/users", status: 500 },
      index,
    );
    const service = refs.find((r) => r.file.includes("UserService.java"));
    expect(service, "주입받는 서비스가 붙어야 한다").toBeDefined();
    expect(service!.line).toBeNull();
    expect(service!.confidence).toBeLessThan(1);
    expect(service!.reason).toContain("확인하지 않음");
  });

  it("모르는 경로에는 비슷한 것을 억지로 붙이지 않는다", () => {
    expect(mapApiToSource({ method: "GET", endpointTemplate: "/api/unknown", status: 404 }, index)).toEqual(
      [],
    );
    expect(mapApiToSource({ method: "PUT", endpointTemplate: "/api/users", status: 500 }, index)).toEqual(
      [],
    );
  });
});

describe("Phase 11 — 실행 결함에 소스를 붙인다", () => {
  it("500 하나가 컨트롤러 파일·줄까지 이어진다", () => {
    const known = KNOWN_ENDPOINTS.find((e) => e.method === "POST")!;
    const result = attachCodeRefs([networkIssue("POST", "/api/users", 500)], index);

    expect(result.mapped).toBe(1);
    const refs = result.issues[0]!.codeRefs;
    expect(refs[0]!.file).toBe(known.file);
    expect(refs[0]!.line).toBe(lineOfAnchor(known.file, known.anchor));
    expect(refs.some((r) => r.file.includes("UserService.java"))).toBe(true);
  });

  it("못 찾은 요청은 목록으로 남긴다 — 조용히 넘어가지 않는다", () => {
    const result = attachCodeRefs([networkIssue("GET", "/api/nowhere", 404)], index);
    expect(result.mapped).toBe(0);
    expect(result.unmapped).toContain("GET /api/nowhere");
    expect(result.issues[0]!.codeRefs).toEqual([]);
  });

  it("소스에서 온 결함의 위치를 덮어쓰지 않는다", () => {
    const fromSource = source.candidates[0]!;
    const asIssue = {
      ...networkIssue("POST", "/api/users", 500),
      codeRefs: fromSource.codeRefs,
    };
    const result = attachCodeRefs([asIssue], index);
    expect(result.issues[0]!.codeRefs).toEqual(fromSource.codeRefs);
  });
});

/**
 * 통합 모드가 실제로 **하나의 리포트**를 내는가.
 *
 * fixture-admin(실행 대상)과 fixture-src(소스)는 서로 다른 앱이다. 일부러 그렇게 뒀다 —
 * 실무에서도 소스 경로를 잘못 지정하는 일이 흔하고, 그때 도구가 조용히 "연결됨"처럼
 * 굴면 안 된다. 매핑은 실패해야 하고, 실패했다는 사실이 리포트에 남아야 한다.
 */
describe("Phase 11 — 통합 모드", () => {
  it("실행 결함과 소스 결함이 한 리포트에 함께 실린다", async () => {
    const { startFixtureServer } = await import("@qa/fixture-admin");
    const { runQa } = await import("./run.js");
    const { readFileSync } = await import("node:fs");

    const fixture = await startFixtureServer(0);
    const dir = mkdtempSync(join(tmpdir(), "qa-phase11-e2e-"));
    try {
      const config = RunConfig.parse({
        projectName: "integrated",
        mode: "integrated",
        targetUrl: fixture.url,
        headless: true,
        login: { enabled: true, username: "admin", password: "admin123!" },
        source: { rootDir: FIXTURE_SRC_ROOT },
        budget: { maxScreens: 4, maxActions: 25, settleMs: 100, maxDurationMs: 90_000 },
        outDir: "runs",
      });
      const ctx = new RunContext(makeRunId(), config.outDir, dir);
      const outcome = await runQa(config, ctx);
      expect(outcome.status).toBe("COMPLETED");

      const report = readFileSync(join(ctx.runDir, "report.md"), "utf8");
      expect(report).toContain("통합 QA (실행 + 소스)");
      // 실행 쪽 결함
      expect(report).toMatch(/콘솔 오류|HTTP \d{3}/);
      // 소스 쪽 결함이 같은 리포트에 있다
      expect(report).toContain("권한 검사가 없는 엔드포인트");
      expect(report).toContain("**관련 소스**");
      // 대상이 다르므로 매핑은 실패해야 하고, 그 사실이 남아야 한다
      expect(report).toContain("대응하는 핸들러를 찾지 못했습니다");
    } finally {
      await fixture.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
