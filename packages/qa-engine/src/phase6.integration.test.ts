import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "@qa/fixture-admin";
import { IssuesFile, RunConfig, type CrudResult, type Issue } from "@qa/shared";
import { RunContext, makeRunId } from "./run-context.js";
import { registerSecret } from "./emitter.js";
import { runQa } from "./run.js";
import { AUTO_QA_PREFIX, type CreatedRecord } from "./testdata.js";

/**
 * Phase 6 DoD.
 *
 *   fixture에서 **Create PASS/FAIL을 정확히 판정**하고 (BUG-06 저장 무반응 → FAIL),
 *   **cleanup 후 잔여 `AUTO-QA-*` 데이터가 0건**이다.
 *
 * 그리고 그보다 앞서는 원칙: **QA가 만든 데이터만 건드린다.**
 */

const PASSWORD = "admin123!";

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let outDir: string;
let ctx: RunContext;
let issues: Issue[];
let crud: CrudResult[];
let ledger: CreatedRecord[];
let unverified: string[];

function crudOf(kind: CrudResult["kind"]): CrudResult {
  const found = crud.find((c) => c.kind === kind);
  if (!found) throw new Error(`${kind} 결과가 없습니다`);
  return found;
}

/** fixture에 AUTO-QA 데이터가 남아 있는지 API로 직접 확인한다. */
async function leftoverInFixture(): Promise<string[]> {
  const login = await fetch(`${fixture.url}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ loginId: "admin", password: PASSWORD }).toString(),
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const left: string[] = [];

  const surveys = (await (await fetch(`${fixture.url}/api/surveys`, { headers: { cookie } })).json()) as Array<{
    title: string;
    owner: string;
  }>;
  for (const r of surveys) {
    if (r.title.includes(AUTO_QA_PREFIX) || r.owner.includes(AUTO_QA_PREFIX)) left.push(r.title);
  }

  // 모달로 만든 부서도 같이 본다. 화면 종류가 달라도 잔여 데이터는 0이어야 한다.
  const depts = (await (await fetch(`${fixture.url}/api/depts`, { headers: { cookie } })).json()) as Array<{
    name: string;
    owner: string;
  }>;
  for (const r of depts) {
    if (r.name.includes(AUTO_QA_PREFIX) || r.owner.includes(AUTO_QA_PREFIX)) left.push(r.name);
  }

  return left;
}

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  outDir = join(tmpdir(), `qa-phase6-${Date.now()}`);
  registerSecret(PASSWORD);

  const config = RunConfig.parse({
    projectName: "fixture",
    targetUrl: fixture.url,
    headless: true,
    login: { enabled: true, username: "admin", password: PASSWORD },
    crud: { create: true, read: true, update: true, delete: true, deleteConsent: true },
    checks: { formValidation: true },
    budget: { settleMs: 150, maxDurationMs: 500_000 },
  });

  ctx = new RunContext(makeRunId(), outDir, ".");
  const outcome = await runQa(config, ctx);
  expect(outcome.status, outcome.message).toBe("COMPLETED");

  const file = IssuesFile.parse(JSON.parse(readFileSync(join(ctx.runDir, "issues.json"), "utf8")));
  issues = file.issues;
  crud = file.summary.crud;
  unverified = file.summary.unverifiedAreas;
  ledger = JSON.parse(
    readFileSync(join(ctx.runDir, "actions", "testdata.json"), "utf8"),
  ) as CreatedRecord[];
}, 900_000);

afterAll(async () => {
  await fixture?.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 6 — Create 판정", () => {
  it("정상 등록 화면은 PASS로 판정한다", () => {
    expect(crudOf("CREATE").pass).toBeGreaterThan(0);
  });

  /** BUG-06: 저장 버튼에 핸들러가 없어 아무 일도 일어나지 않는다. */
  it("저장 무반응 화면(BUG-06)을 FAIL로 잡는다", () => {
    expect(crudOf("CREATE").fail).toBeGreaterThan(0);
    const found = issues.find((i) => i.ruleId === "FUNC-NO-RESPONSE");
    expect(
      found,
      `FUNC-NO-RESPONSE 미검출. 확정 Issue: ${issues.map((i) => i.ruleId).join(", ")}`,
    ).toBeDefined();
    expect(found!.screens.some((s) => s.includes("사용자 등록"))).toBe(true);
  });

  /** BUG-05: 필수 표시된 이메일에 검증이 없어 빈 값으로 저장된다. */
  it("필수 항목 검증 누락(BUG-05)을 잡는다", () => {
    const found = issues.find((i) => i.ruleId === "FUNC-VALIDATION-MISSING");
    expect(found).toBeDefined();
    expect(found!.title).toContain("이메일");
  });

  it("Create 실패에 원인과 권장 조치가 채워진다", () => {
    for (const issue of issues.filter((i) => i.source === "crud")) {
      expect(issue.impact.length, `${issue.id} 영향 설명 없음`).toBeGreaterThan(0);
      expect(issue.recommendation.length, `${issue.id} 권장 조치 없음`).toBeGreaterThan(0);
      expect(issue.impact).not.toContain("확인이 필요합니다");
    }
  });
});

describe("Phase 6 — Update / Delete", () => {
  it("QA가 만든 데이터를 수정한다", () => {
    expect(crudOf("UPDATE").pass).toBeGreaterThan(0);
    expect(crudOf("UPDATE").fail).toBe(0);
  });

  it("QA가 만든 데이터를 삭제한다", () => {
    expect(crudOf("DELETE").pass).toBeGreaterThan(0);
    expect(crudOf("DELETE").fail).toBe(0);
  });

  /**
   * 실측 회귀. SPA 관리자웹은 등록 화면이 `/new` 주소가 아니라 버튼 뒤의 모달이었고,
   * 그 버튼이 CAUTION 으로 막혀 "등록 화면을 찾지 못했습니다" 로 Create·Update·Delete 가
   * 전부 미실행으로 끝났다. 주소가 아니라 버튼으로도 등록 화면에 닿아야 한다.
   */
  it("주소에 /new 가 없는 모달 등록 화면에도 닿는다", () => {
    const modal = ledger.filter((r) => new URL(r.createUrl).pathname === "/depts");
    expect(modal.length, "모달로 등록한 데이터가 없다").toBeGreaterThan(0);
  });

  it("Read는 탐색한 화면 수만큼 집계된다", () => {
    expect(crudOf("READ").executed).toBe(true);
    expect(crudOf("READ").pass).toBeGreaterThan(5);
  });
});

describe("Phase 6 — 데이터 소유권", () => {
  /**
   * **가장 중요한 검증.** 실측에서 `/surveys/:id/edit` 을 등록 화면으로 착각해
   * 기존 실데이터를 수정한 적이 있다. 그런 일이 다시 생기면 안 된다.
   */
  it("만든 데이터가 전부 AUTO-QA 표식을 가진다", () => {
    expect(ledger.length).toBeGreaterThan(0);
    for (const record of ledger) {
      expect(record.marker.startsWith(AUTO_QA_PREFIX), `${record.marker} 형식 위반`).toBe(true);
    }
  });

  it("수정 화면을 등록 화면으로 착각하지 않는다", () => {
    for (const record of ledger) {
      expect(record.createUrl, `${record.createUrl} 는 수정 화면이다`).not.toMatch(/\/edit(\/|$)/);
    }
  });

  it("대장이 파일로 남아 Run이 죽어도 수동 정리가 가능하다", () => {
    for (const record of ledger) {
      expect(record.id).toBeTruthy();
      expect(record.screen).toBeTruthy();
      expect(record.createdAt).toBeTruthy();
      expect(typeof record.cleaned).toBe("boolean");
    }
  });
});

describe("Phase 6 — Cleanup", () => {
  /** Phase 6의 핵심 DoD. */
  it("정리 후 대상 시스템에 AUTO-QA 데이터가 남지 않는다", async () => {
    const leftovers = await leftoverInFixture();
    expect(leftovers, `남은 데이터: ${leftovers.join(", ")}`).toEqual([]);
  });

  it("대장의 모든 항목이 정리 완료로 표시된다", () => {
    const pending = ledger.filter((r) => !r.cleaned);
    expect(pending.map((r) => `${r.marker}: ${r.cleanupError}`)).toEqual([]);
  });

  it("정리하지 못한 데이터가 있으면 식별자와 함께 리포트에 남는다", () => {
    // 이번 Run은 전부 정리되었으므로 해당 항목이 없어야 한다.
    // (남았다면 반드시 미검증 영역에 식별자가 찍혀야 한다)
    const notes = unverified.filter((u) => u.includes("정리되지 않은 테스트 데이터"));
    const pending = ledger.filter((r) => !r.cleaned);
    expect(notes.length).toBe(pending.length);
  });
});

describe("Phase 6 — 리포트", () => {
  let report: string;

  beforeAll(() => {
    report = readFileSync(join(ctx.runDir, "report.md"), "utf8");
  });

  it("CRUD 결과표에 실제 수치가 들어간다", () => {
    const section = report.slice(report.indexOf("## 4. CRUD 결과"), report.indexOf("## 5."));
    expect(section).toContain("CREATE");
    expect(section).toContain("UPDATE");
    expect(section).toContain("DELETE");
    // 전부 0이면 집계가 연결되지 않은 것이다.
    expect(/\|\s*CREATE\s*\|\s*예\s*\|\s*[1-9]/.test(section)).toBe(true);
  });

  it("테스트 데이터 접두사가 리포트에 노출되지 않는 비밀번호와 무관하다", () => {
    expect(report).not.toContain(PASSWORD);
  });
});
