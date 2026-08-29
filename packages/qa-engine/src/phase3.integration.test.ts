import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "@qa/fixture-admin";
import { IssuesFile, RunConfig, type Issue } from "@qa/shared";
import { RunContext, makeRunId } from "./run-context.js";
import { registerSecret } from "./emitter.js";
import { runQa } from "./run.js";

/**
 * Phase 3 DoD.
 *
 *   `KNOWN_BUGS.md`의 Phase 3 검출 대상 8건을 전부 탐지하고, 오탐은 3건 이하.
 *   그리고 **BUG-02는 12개 화면에서 터지지만 Issue 1건 + Evidence N건으로 병합**된다.
 *
 * 이 시점에 AI 없이 제품 가치가 성립해야 한다.
 */

const PASSWORD = "admin123!";

/** KNOWN_BUGS.md 중 읽기 전용 탐색만으로 잡을 수 있는 것들. (BUG-05/06은 Phase 6) */
const EXPECTED_BUGS: Array<{ bug: string; ruleId: string; match: (i: Issue) => boolean }> = [
  { bug: "BUG-01", ruleId: "NET-5XX", match: (i) => i.title.includes("/api/stats/export") },
  { bug: "BUG-02", ruleId: "NET-4XX", match: (i) => i.title.includes("/api/notice/badge") },
  {
    bug: "BUG-03",
    ruleId: "CON-UNCAUGHT",
    match: (i) => /Cannot read properties of undefined/.test(i.description),
  },
  {
    bug: "BUG-04",
    ruleId: "CON-REJECTION",
    match: (i) => i.description.includes("dashboard widget init failed"),
  },
  {
    bug: "BUG-07",
    ruleId: "VIS-OVERFLOW",
    match: (i) => i.screens.some((s) => s.includes("통계")),
  },
  { bug: "BUG-08", ruleId: "VIS-OVERLAP", match: (i) => /user-badge/.test(i.title) },
  {
    bug: "BUG-09",
    ruleId: "VIS-TRUNCATE",
    match: (i) => i.title.includes("설문응답통계관리센터"),
  },
  { bug: "BUG-10", ruleId: "FUNC-INFINITE-LOADING", match: () => true },
];

const MAX_FALSE_POSITIVES = 3;

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let outDir: string;
let ctx: RunContext;
let issuesFile: ReturnType<typeof IssuesFile.parse>;
let issues: Issue[];

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  outDir = join(tmpdir(), `qa-phase3-${Date.now()}`);
  registerSecret(PASSWORD);

  const config = RunConfig.parse({
    projectName: "fixture",
    targetUrl: fixture.url,
    headless: true,
    login: { enabled: true, username: "admin", password: PASSWORD },
    budget: { settleMs: 150, maxDurationMs: 300_000 },
  });

  ctx = new RunContext(makeRunId(), outDir, ".");
  const outcome = await runQa(config, ctx);
  expect(outcome.status, outcome.message).toBe("COMPLETED");

  issuesFile = IssuesFile.parse(JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")));
  issues = issuesFile.issues;
}, 600_000);

afterAll(async () => {
  await fixture.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 3 — 탐지율", () => {
  it.each(EXPECTED_BUGS)("$bug ($ruleId) 을 탐지한다", ({ ruleId, match }) => {
    const found = issues.find((i) => i.ruleId === ruleId && match(i));
    expect(
      found,
      `${ruleId} 미검출. 확정된 Issue: ${issues.map((i) => `${i.ruleId}:${i.title.slice(0, 30)}`).join(" / ")}`,
    ).toBeDefined();
  });

  it(`오탐이 ${MAX_FALSE_POSITIVES}건 이하다`, () => {
    const matched = new Set<string>();
    for (const e of EXPECTED_BUGS) {
      const found = issues.find((i) => i.ruleId === e.ruleId && e.match(i));
      if (found) matched.add(found.id);
    }
    const falsePositives = issues.filter((i) => !matched.has(i.id));
    expect(
      falsePositives.map((i) => `${i.ruleId}: ${i.title}`),
      "정답지에 없는 Issue",
    ).toHaveLength(0);
    expect(falsePositives.length).toBeLessThanOrEqual(MAX_FALSE_POSITIVES);
  });

  /** 모달이 열리면 뒤쪽 버튼이 가려지는 것은 정상이다. 이걸 결함으로 올리면 안 된다. */
  it("모달 뒤에 가려진 버튼을 결함으로 올리지 않는다", () => {
    const hiddenCta = issues.filter((i) => i.ruleId === "VIS-HIDDEN-CTA");
    expect(hiddenCta.map((i) => i.title)).toEqual([]);
  });
});

describe("Phase 3 — 중복 제거", () => {
  /** BUG-02는 방문하는 모든 화면에서 터진다. 12건으로 뱉으면 리포트를 아무도 안 읽는다. */
  it("모든 화면에서 나는 404가 Issue 1건 + Evidence N건으로 합쳐진다", () => {
    const badge = issues.filter((i) => i.title.includes("/api/notice/badge"));
    expect(badge).toHaveLength(1);

    const issue = badge[0]!;
    expect(issue.screens.length).toBeGreaterThanOrEqual(10);
    expect(issue.evidenceIds.length).toBeGreaterThanOrEqual(10);
    expect(issue.occurrenceCount).toBeGreaterThan(issue.screens.length);
  });

  it("후보가 Issue보다 훨씬 많다 (병합이 실제로 일어난다)", () => {
    const candidates = JSON.parse(
      readFileSync(join(ctx.runDir, "actions", "candidates.json"), "utf8"),
    ) as unknown[];
    expect(candidates.length).toBeGreaterThan(issues.length * 10);
  });

  it("모든 Issue가 최소 1개의 증적을 가진다", () => {
    for (const i of issues) {
      expect(i.evidenceIds.length, `${i.id} 에 증적이 없다`).toBeGreaterThan(0);
    }
  });

  it("Issue의 증적이 실제 파일을 가리킨다", () => {
    const index = JSON.parse(readFileSync(join(ctx.runDir, "evidence.json"), "utf8")) as {
      evidences: Array<{ id: string; path: string | null }>;
    };
    const byId = new Map(index.evidences.map((e) => [e.id, e]));
    for (const issue of issues) {
      for (const id of issue.evidenceIds) {
        const ev = byId.get(id);
        expect(ev, `${issue.id} 의 증적 ${id} 가 색인에 없다`).toBeDefined();
        if (ev?.path) {
          expect(() => statSync(join(ctx.runDir, ev.path!)), `깨진 링크: ${ev.path}`).not.toThrow();
        }
      }
    }
  });
});

describe("Phase 3 — 우선순위", () => {
  /**
   * 곱셈식만 쓰면 "넓게 퍼짐"이 "심각함"을 덮는다.
   * 실측에서 화면이 아예 안 열리는 HIGH 결함이 P3, 반복되는 MEDIUM 콘솔 오류가 P0으로 나왔다.
   */
  it("심각도가 우선순위 대역을 정한다", () => {
    for (const i of issues) {
      if (i.severity === "HIGH") expect(["P0", "P1"]).toContain(i.priority);
      if (i.severity === "MEDIUM") expect(["P1", "P2"]).toContain(i.priority);
      if (i.severity === "LOW") expect(["P2", "P3"]).toContain(i.priority);
    }
  });

  it("화면이 아예 열리지 않는 결함이 P1 이상이다", () => {
    const stuck = issues.find((i) => i.ruleId === "FUNC-INFINITE-LOADING");
    expect(stuck).toBeDefined();
    expect(["P0", "P1"]).toContain(stuck!.priority);
  });

  it("리포트 순서가 우선순위 순이다", () => {
    const order = ["P0", "P1", "P2", "P3"];
    const seq = issues.map((i) => order.indexOf(i.priority));
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
  });

  it("ID가 우선순위 순으로 붙는다", () => {
    expect(issues.map((i) => i.id)).toEqual(
      issues.map((_, n) => `QA-${String(n + 1).padStart(4, "0")}`),
    );
  });
});

describe("Phase 3 — 리포트", () => {
  let report: string;

  beforeAll(() => {
    report = readFileSync(join(ctx.runDir, "report.md"), "utf8");
  });

  it("CLAUDE.md §25의 17개 목차가 모두 있다", () => {
    const expected = [
      "1. 실행정보",
      "2. 테스트환경",
      "3. Executive Summary",
      "4. CRUD 결과",
      "5. Critical",
      "6. High",
      "7. Medium",
      "8. Low",
      "9. 화면별 개선점",
      "10. Console 오류",
      "11. Network/API 오류",
      "12. UX/UI 개선",
      "13. 기능 누락 후보",
      "14. 우선순위",
      "15. 권장 수정 순서",
      "16. 탐색 제한",
      "17. 미검증 기능",
    ];
    for (const heading of expected) {
      expect(report, `목차 "${heading}" 누락`).toContain(`## ${heading}`);
    }
  });

  /**
   * 못 본 영역을 안 적으면 사용자는 전부 검증했다고 착각한다.
   * 이 도구의 가장 위험한 실패 모드라 별도 테스트로 막는다.
   */
  it("차단된 위험 액션이 미검증 영역에 남는다", () => {
    const unverified = issuesFile.summary.unverifiedAreas.join("\n");
    for (const label of ["로그아웃", "삭제", "저장", "설정 초기화", "테스트 메일 발송"]) {
      expect(unverified, `"${label}" 이 미검증 영역에 없다`).toContain(label);
    }
    expect(unverified).toContain("CREATE 테스트");
    expect(unverified).toContain("AI 분석");
  });

  it("AI 없이도 리포트가 완성된다", () => {
    expect(issuesFile.summary.aiStatus).toBe("not_used");
    expect(report).toContain("AI 분석은 사용하지 않았습니다");
    expect(report.length).toBeGreaterThan(3000);
  });

  it("모든 Issue가 재현 절차와 권장 조치를 가진다", () => {
    for (const i of issues) {
      expect(i.reproduction.length, `${i.id} 재현 절차 없음`).toBeGreaterThan(0);
      expect(i.recommendation.length, `${i.id} 권장 조치 없음`).toBeGreaterThan(0);
      expect(i.impact.length, `${i.id} 영향 설명 없음`).toBeGreaterThan(0);
    }
  });

  it("리포트에 비밀번호가 남지 않는다", () => {
    expect(report).not.toContain(PASSWORD);
    expect(readFileSync(join(ctx.runDir, "issues.json"), "utf8")).not.toContain(PASSWORD);
    expect(JSON.stringify(issuesFile.summary.config)).toContain("***REDACTED***");
  });

  it("issues.json 이 스키마를 통과한다", () => {
    // beforeAll에서 이미 parse했지만, 실패 시 어느 필드인지 드러나게 한 번 더 본다.
    expect(() =>
      IssuesFile.parse(JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8"))),
    ).not.toThrow();
    expect(issuesFile.schemaVersion).toBe(1);
  });
});
