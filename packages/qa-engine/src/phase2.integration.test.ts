import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "@qa/fixture-admin";
import { RunConfig, type ActionResult, type StateGraph } from "@qa/shared";
import { launch } from "./browser.js";
import { Collector } from "./collector.js";
import { Explorer, makeStartPlan } from "./explorer.js";
import { login } from "./login.js";
import { RunContext, makeRunId } from "./run-context.js";
import { registerSecret } from "./emitter.js";

/**
 * Phase 2 DoD.
 *
 *   1. fixture의 도달 가능한 화면을 전부, 중복 없이 탐색한다
 *   2. **2회 연속 실행 결과가 완전히 동일하다** (결정성)
 *   3. DANGEROUS 액션이 하나도 실행되지 않는다
 *
 * 실제 Chromium을 두 번 돌리므로 느리다. settleMs를 줄여 시간을 아낀다.
 */

const PASSWORD = "admin123!";

/** SAFE 액션만으로 도달 가능한 화면. KNOWN_SCREENS.md 와 짝을 이룬다. */
const EXPECTED_SCREENS = [
  "대시보드",
  "사용자관리",
  "사용자 등록",
  "테스트사용자1 상세",
  "테스트사용자1 상세 > 접속이력",
  "설문관리",
  "설문 등록",
  "설문 수정",
  "2026년 1차 만족도 조사",
  "설문응답통계관리센터",
  "설정 > 일반",
  "설정 > 알림",
  "설정 > 보안",
];

/** 실행되면 안 되는 액션. 하나라도 실행되면 Phase 2 실패다. */
const MUST_NOT_EXECUTE = [
  "로그아웃",
  "선택 일괄 잠금",
  "권한 변경",
  "삭제",
  "게시",
  "응답자 알림 발송",
  "설정 초기화",
  "테스트 메일 발송",
];

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let outDir: string;

interface RunOutput {
  graph: StateGraph;
  results: ActionResult[];
}

async function explore(): Promise<RunOutput> {
  const config = RunConfig.parse({
    projectName: "fixture",
    targetUrl: fixture.url,
    headless: true,
    login: { enabled: true, username: "admin", password: PASSWORD },
    budget: { settleMs: 150, maxDurationMs: 240_000 },
  });

  const ctx = new RunContext(makeRunId(new Date(Date.now() + Math.random() * 1e6)), outDir, ".");
  const session = await launch(config);
  const collector = new Collector();
  collector.attach(session.page);

  try {
    await session.page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const result = await login(session.page, config.login, config.targetUrl);
    expect(result.success, result.reason).toBe(true);

    const explorer = new Explorer(session.page, ctx, collector, config);
    const explored = await explorer.explore(makeStartPlan(result.landedUrl));
    return { graph: explored.graph, results: explored.actionResults };
  } finally {
    await session.close();
  }
}

let first: RunOutput;
let second: RunOutput;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  outDir = join(tmpdir(), `qa-phase2-${Date.now()}`);
  registerSecret(PASSWORD);
  first = await explore();
  second = await explore();
}, 600_000);

afterAll(async () => {
  await fixture.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("Phase 2 — 탐색 범위", () => {
  it("도달 가능한 화면을 빠짐없이 방문한다", () => {
    const found = first.graph.nodes.map((n) => n.screenName);
    for (const expected of EXPECTED_SCREENS) {
      expect(found, `${expected} 화면을 놓쳤다`).toContain(expected);
    }
  });

  it("같은 상태를 두 번 탐색하지 않는다", () => {
    const keys = first.graph.nodes.map((n) => n.stateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /** 사용자 47명이 47개 상태가 되면 탐색이 끝나지 않는다. */
  it("id만 다른 상세 화면이 상태를 폭발시키지 않는다", () => {
    const detailStates = first.graph.nodes.filter((n) => n.signals.pathTemplate === "/users/:id");
    // 상세 1개 + 모달 1개
    expect(detailStates.length).toBe(2);
  });

  it("URL이 같아도 탭과 모달은 서로 다른 상태다", () => {
    const settings = first.graph.nodes.filter((n) => n.signals.pathTemplate === "/settings");
    expect(settings.length).toBe(3);
    expect(new Set(settings.map((s) => s.signals.activeTab))).toEqual(new Set(["일반", "알림", "보안"]));

    const withDialog = first.graph.nodes.filter((n) => n.signals.dialogTitle !== null);
    expect(withDialog.length).toBe(1);
    expect(withDialog[0]!.signals.dialogTitle).toBe("접속이력");
  });

  /** BUG-10: 보관 필터에서 스피너만 남는 화면. 겉모습이 다르므로 별도 상태여야 한다. */
  it("같은 경로라도 겉모습이 다른 필터 결과는 별도 상태로 잡힌다", () => {
    const surveys = first.graph.nodes.filter((n) => n.signals.pathTemplate === "/surveys");
    expect(surveys.length).toBe(2);
    expect(new Set(surveys.map((s) => s.signals.structureHash)).size).toBe(2);
  });

  it("모든 방문 화면이 그래프 간선으로 연결된다", () => {
    // 시작 화면(대시보드)을 뺀 나머지는 전부 도착 간선을 가져야 한다.
    const arrived = new Set(first.graph.edges.map((e) => e.toStateKey));
    const orphans = first.graph.nodes.slice(1).filter((n) => !arrived.has(n.stateKey));
    expect(orphans.map((o) => o.screenName)).toEqual([]);
  });
});

describe("Phase 2 — 안전", () => {
  it("DANGEROUS 액션이 하나도 실행되지 않는다", () => {
    const executed = first.results.filter((r) => r.outcome === "EXECUTED");
    const risky = executed.filter((r) => r.action.risk !== "SAFE");
    expect(risky.map((r) => `${r.action.label}(${r.action.risk})`)).toEqual([]);
  });

  it("실행 금지 액션이 전부 사유와 함께 기록된다", () => {
    for (const label of MUST_NOT_EXECUTE) {
      const matches = first.results.filter((r) => r.action.label === label);
      expect(matches.length, `${label} 액션을 발견하지 못했다`).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m.outcome, `${label} 이 실행되었다`).not.toBe("EXECUTED");
        expect(m.reason.length, `${label} 미실행 사유가 비었다`).toBeGreaterThan(0);
      }
    }
  });

  it("로그아웃은 발견될 때마다 매번 차단된다", () => {
    const logouts = first.results.filter((r) => r.action.label === "로그아웃");
    expect(logouts.length).toBeGreaterThan(5);
    expect(logouts.every((r) => r.outcome === "SKIPPED_DENYLIST")).toBe(true);
  });

  it("클릭 실패(FAILED)가 없다", () => {
    // 모달이 열린 화면에서 뒤쪽 메뉴를 클릭하려다 전부 타임아웃 나던 문제의 회귀 방지.
    const failed = first.results.filter((r) => r.outcome === "FAILED");
    expect(failed.map((f) => `${f.action.label}: ${f.error}`)).toEqual([]);
  });
});

describe("Phase 2 — 결정성", () => {
  it("두 실행의 상태 집합이 같다", () => {
    const a = first.graph.nodes.map((n) => n.stateKey).sort();
    const b = second.graph.nodes.map((n) => n.stateKey).sort();
    expect(b).toEqual(a);
  });

  it("두 실행의 방문 순서가 같다", () => {
    expect(second.graph.nodes.map((n) => n.screenName)).toEqual(
      first.graph.nodes.map((n) => n.screenName),
    );
  });

  it("두 실행의 간선이 같다", () => {
    const key = (g: StateGraph) =>
      g.edges.map((e) => `${e.fromStateKey}->${e.toStateKey}:${e.actionLabel}`).sort();
    expect(key(second.graph)).toEqual(key(first.graph));
  });

  it("두 실행의 액션 결과가 같다 (시간 제외)", () => {
    const strip = (rs: ActionResult[]) =>
      rs.map((r) => ({
        id: r.action.id,
        label: r.action.label,
        risk: r.action.risk,
        outcome: r.outcome,
        reason: r.reason,
        from: r.fromStateKey,
        to: r.toStateKey,
        changed: r.stateChanged,
      }));
    expect(strip(second.results)).toEqual(strip(first.results));
  });
});
