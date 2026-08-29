import {
  redactRunConfig,
  type ActionResult,
  type Issue,
  type IssuesFile,
  type RunConfig,
  type RunStatus,
  type RunSummary,
} from "@qa/shared";
import { emit, log } from "./emitter.js";
import { launch, preflightBrowser } from "./browser.js";
import { Collector } from "./collector.js";
import { captureScreen } from "./capture.js";
import { login } from "./login.js";
import type { RunContext } from "./run-context.js";
import { Explorer, makeStartPlan, type ExploreResult } from "./explorer.js";
import { judge } from "./judge.js";
import { renderReport } from "./report.js";

export interface RunOutcome {
  status: RunStatus;
  message: string;
}

/**
 * 미검증 영역을 액션 기록에서 뽑아낸다.
 *
 * 차단은 성공이지만 **숨기면 실패다.** 실행하지 않은 것을 리포트에 적지 않으면
 * 사용자는 전부 검증했다고 착각한다. 이 도구의 가장 위험한 실패 모드다.
 */
function unverifiedAreas(results: ActionResult[], config: RunConfig): string[] {
  const grouped = new Map<string, { screens: Set<string>; reason: string; count: number }>();
  for (const r of results) {
    if (r.outcome === "EXECUTED") continue;
    const key = `${r.action.label}|${r.outcome}`;
    const entry = grouped.get(key) ?? { screens: new Set<string>(), reason: r.reason, count: 0 };
    entry.screens.add(r.action.screenName);
    entry.count += 1;
    grouped.set(key, entry);
  }

  const out = [...grouped.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, v]) => {
      const label = key.split("|")[0];
      return `"${label}" — ${v.count}회 발견, 실행하지 않음 (${v.reason}). 화면: ${[...v.screens].join(", ")}`;
    });

  for (const kind of ["create", "update", "delete"] as const) {
    if (!config.crud[kind]) out.push(`${kind.toUpperCase()} 테스트 — 설정에서 꺼져 있어 실행하지 않았습니다.`);
  }
  if (config.ai.kind === "none") {
    out.push("AI 분석 (원인 추정·화면 평가·기능 누락 후보) — Provider를 사용하지 않았습니다.");
  }

  return out;
}

function buildSummary(input: {
  runId: string;
  config: RunConfig;
  startedAt: Date;
  explored: ExploreResult;
  issues: Issue[];
}): RunSummary {
  const { runId, config, startedAt, explored, issues } = input;
  const finishedAt = new Date();
  const count = (s: Issue["severity"]) => issues.filter((i) => i.severity === s).length;

  return {
    runId,
    status: "COMPLETED",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    // 리포트로 나가는 설정은 반드시 마스킹된 판본이어야 한다.
    config: redactRunConfig(config),
    screensExplored: explored.graph.nodes.length,
    actionsExecuted: explored.actionResults.filter((r) => r.outcome === "EXECUTED").length,
    actionsSkipped: explored.actionResults.filter((r) => r.outcome !== "EXECUTED").length,
    issueCounts: {
      critical: count("CRITICAL"),
      high: count("HIGH"),
      medium: count("MEDIUM"),
      low: count("LOW"),
    },
    crud: (["CREATE", "READ", "UPDATE", "DELETE"] as const).map((kind) => {
      const on = kind === "READ" ? config.crud.read : config.crud[kind.toLowerCase() as "create"];
      return {
        kind,
        executed: kind === "READ",
        pass: 0,
        fail: 0,
        skipped: 0,
        notExecutedReason: on
          ? kind === "READ"
            ? null
            : "쓰기 테스트는 Phase 6에서 구현됩니다."
          : "설정에서 꺼져 있습니다.",
      };
    }),
    aiStatus: config.ai.kind === "none" ? "not_used" : "not_used",
    aiFailureReason: null,
    explorationLimits: explored.limits,
    unverifiedAreas: unverifiedAreas(explored.actionResults, config),
  };
}

/**
 * Run 본체.
 *
 * Preflight → Login → 자율 탐색 → (Phase 3) 검출·리포트.
 *
 * CLI에서 분리해 둔 이유는 통합 테스트가 프로세스를 띄우지 않고
 * 이 함수만 직접 호출할 수 있게 하기 위해서다.
 */
export async function runQa(config: RunConfig, ctx: RunContext): Promise<RunOutcome> {
  const startedAt = new Date();
  const pre = await preflightBrowser();
  if (!pre.ok) {
    log("error", pre.remediation ?? "브라우저를 기동할 수 없습니다.");
    return { status: "FAILED", message: pre.remediation ?? "브라우저 기동 실패" };
  }

  const session = await launch(config);
  const collector = new Collector();
  collector.attach(session.page);

  try {
    const startUrl = new URL(config.startPath, config.targetUrl).toString();
    await session.page.goto(startUrl, { waitUntil: "domcontentloaded" });

    if (!config.login.enabled) {
      log("info", "로그인을 건너뜁니다 (--no-login)");
      await captureScreen(session.page, ctx, collector, {
        stateKey: "entry",
        screenName: "진입",
      });
      return { status: "COMPLETED", message: "로그인 없이 진입 화면 증적을 수집했습니다." };
    }

    // 로그인 화면 증적은 비밀번호를 넣기 **전에** 찍는다.
    await captureScreen(
      session.page,
      ctx,
      collector,
      { stateKey: "login", screenName: "로그인" },
      { clearPasswordFields: true },
    );

    const result = await login(session.page, config.login, config.targetUrl);
    log("info", result.reason);

    ctx.writeJson("actions", "login.json", {
      success: result.success,
      landedUrl: result.landedUrl,
      reason: result.reason,
      signals: result.signals,
      usedSelectors: result.usedSelectors,
    });

    if (!result.success) {
      // 실패 화면을 남기되, 비밀번호가 찍히지 않도록 먼저 비운다.
      await captureScreen(
        session.page,
        ctx,
        collector,
        { stateKey: "login-failed", screenName: "로그인실패" },
        { clearPasswordFields: true },
      );
      return { status: "FAILED", message: result.reason };
    }

    // ── 자율 탐색 ─────────────────────────────────────────────────────
    const explorer = new Explorer(session.page, ctx, collector, config);
    const explored = await explorer.explore(makeStartPlan(result.landedUrl));

    ctx.writeJson("actions", "graph.json", explored.graph);

    const executed = explored.actionResults.filter((r) => r.outcome === "EXECUTED").length;
    const skipped = explored.actionResults.length - executed;

    log(
      "info",
      `탐색 완료: 화면 ${explored.graph.nodes.length}개 · 액션 실행 ${executed}건 · 미실행 ${skipped}건`,
    );
    for (const limit of explored.limits) log("warn", `탐색 제한: ${limit}`);

    // ── Issue 확정 ────────────────────────────────────────────────────
    const judged = judge(explored.candidates, explored.graph);
    log(
      "info",
      `Issue 확정: 후보 ${judged.mergedFrom}건 → Issue ${judged.issues.length}건`,
    );
    for (const issue of judged.issues) {
      emit({ type: "issue:found", at: new Date().toISOString(), issue });
    }

    // ── 리포트 ────────────────────────────────────────────────────────
    const summary = buildSummary({
      runId: ctx.runId,
      config,
      startedAt,
      explored,
      issues: judged.issues,
    });

    const reportPath = ctx.writeReport(
      renderReport({ summary, issues: judged.issues, evidences: ctx.listEvidences() }),
    );
    const issuesPath = ctx.writeIssues({ schemaVersion: 1, summary, issues: judged.issues });

    emit({
      type: "run:finished",
      at: new Date().toISOString(),
      summary,
      reportPath,
      issuesPath,
    });

    const c = summary.issueCounts;
    return {
      status: "COMPLETED",
      message:
        `화면 ${explored.graph.nodes.length}개 탐색 · Issue ${judged.issues.length}건 ` +
        `(Critical ${c.critical} · High ${c.high} · Medium ${c.medium} · Low ${c.low}) · ` +
        `증적 ${ctx.listEvidences().length}건`,
    };
  } finally {
    await session.close();
    // 증적 색인은 Run 출력 계약의 일부다. 중단·실패로 끝나도 반드시 남긴다.
    // (CLI가 아니라 여기서 쓰는 이유: runQa를 직접 호출하는 호출자 — Phase 5의
    //  Electron, 통합 테스트 — 도 똑같이 색인을 받아야 한다)
    ctx.saveEvidenceIndex();
  }
}
