import {
  redactRunConfig,
  type ActionResult,
  type CrudResult,
  type Evidence,
  type AiProvider,
  type AiProviderConfig,
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
import { AiGuard, createProvider, enrich, passthrough, type EnrichResult } from "./ai/index.js";
import { NO_CONTROL, type RunControl } from "./control.js";
import { CrudTester } from "./crud.js";

export interface RunOutcome {
  status: RunStatus;
  message: string;
}

export interface RunOptions {
  /**
   * Provider 주입 지점.
   *
   * 없으면 `config.ai.kind`로 만든다. 테스트가 실패하는 Provider를 꽂아
   * "AI가 죽어도 리포트는 나온다"를 검증하는 데 쓰고, Phase 5의 Electron이
   * 자기 Provider를 넘길 수도 있다.
   */
  createProvider?: (config: AiProviderConfig) => AiProvider;
  /** 실행 제어 채널. 없으면 제어 없이 끝까지 돈다. */
  control?: RunControl;
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
    else if (kind === "delete" && !config.crud.deleteConsent)
      out.push("DELETE 테스트 — 별도 삭제 동의가 없어 실행하지 않았습니다.");
  }
  if (config.ai.kind === "none") {
    out.push("AI 분석 (원인 추정·화면 평가·기능 누락 후보) — Provider를 사용하지 않았습니다.");
  }

  return out;
}

/**
 * AI 보강을 시도한다. **어떤 실패도 위로 던지지 않는다.**
 *
 * Provider가 없거나, 헬스체크에서 떨어지거나, 호출이 전부 실패해도
 * 입력으로 받은 룰 기반 Issue를 그대로 돌려준다. 이것이 Phase 4의 존재 이유다.
 */
async function enrichWithAi(input: {
  config: RunConfig;
  issues: Issue[];
  explored: ExploreResult;
  evidences: readonly Evidence[];
  makeProvider: (config: AiProviderConfig) => AiProvider;
}): Promise<EnrichResult> {
  const { config, issues, explored, evidences } = input;
  if (config.ai.kind === "none") return passthrough(issues);

  const provider = input.makeProvider(config.ai);

  const status = await new AiGuard(config.ai.timeoutMs)
    .run("healthCheck", () => provider.healthCheck())
    .catch(() => null);

  if (!status?.available) {
    const detail = status?.detail ?? "Provider 상태를 확인할 수 없습니다.";
    log("warn", `AI Provider를 사용할 수 없습니다: ${detail}`);
    if (status?.remediation) log("warn", `조치: ${status.remediation}`);
    emit({ type: "ai:status", at: new Date().toISOString(), available: false, detail });
    return {
      ...passthrough(issues),
      status: "failed",
      failureReason: status?.remediation ? `${detail} (${status.remediation})` : detail,
    };
  }

  log("info", status.detail);
  emit({ type: "ai:status", at: new Date().toISOString(), available: true, detail: status.detail });

  const pages = explored.graph.nodes.map((n) => ({
    screenName: n.screenName,
    pathTemplate: n.signals.pathTemplate,
    visibleText: n.signals.heading,
    domOutline: n.signals.navLabels.join(", "),
  }));

  // 요약 프롬프트에 넣을 임시 summary. 최종 summary는 보강 결과로 다시 만든다.
  const draftSummary = buildSummary({
    runId: "draft",
    config,
    startedAt: new Date(),
    explored,
    issues,
    ai: null,
  });

  try {
    return await enrich({
      provider,
      config: config.ai,
      status,
      issues,
      summary: draftSummary,
      evidences,
      actionResults: explored.actionResults,
      pages,
    });
  } catch (err) {
    // enrich 내부는 전부 guard를 통과하지만, 만약을 대비해 한 겹 더 둔다.
    const reason = err instanceof Error ? err.message : String(err);
    log("error", `AI 보강이 예기치 않게 실패했습니다. 룰 결과로 진행합니다: ${reason}`);
    return { ...passthrough(issues), status: "failed", failureReason: reason };
  }
}

function buildSummary(input: {
  runId: string;
  config: RunConfig;
  startedAt: Date;
  explored: ExploreResult;
  issues: Issue[];
  ai: EnrichResult | null;
  crud?: CrudResult[];
  leftovers?: string[];
  stopped?: boolean;
}): RunSummary {
  const { runId, config, startedAt, explored, issues } = input;
  const finishedAt = new Date();
  const count = (s: Issue["severity"]) => issues.filter((i) => i.severity === s).length;

  return {
    runId,
    // 중단으로 끝났으면 그렇게 기록한다. 부분 결과를 완주한 것처럼 보이게 하면 안 된다.
    status: input.stopped ? "STOPPED" : "COMPLETED",
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
    crud: input.crud ?? [],
    aiStatus: input.ai?.status ?? "not_used",
    aiFailureReason: input.ai?.failureReason ?? null,
    explorationLimits: explored.limits,
    unverifiedAreas: [
      ...unverifiedAreas(explored.actionResults, config),
      // 정리하지 못한 테스트 데이터는 **식별자와 함께** 반드시 남긴다.
      // 사용자가 직접 지울 수 있어야 한다.
      ...(input.leftovers ?? []).map((l) => `정리되지 않은 테스트 데이터: ${l}`),
    ],
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
export async function runQa(
  config: RunConfig,
  ctx: RunContext,
  options: RunOptions = {},
): Promise<RunOutcome> {
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
    log(result.success ? "info" : "warn", result.reason);
    if (result.warning) log("warn", result.warning);

    ctx.writeJson("actions", "login.json", {
      success: result.success,
      landedUrl: result.landedUrl,
      reason: result.reason,
      signals: result.signals,
      usedSelectors: result.usedSelectors,
      warning: result.warning,
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
    const explorer = new Explorer(session.page, ctx, collector, config, options.control ?? NO_CONTROL);
    const explored = await explorer.explore(makeStartPlan(result.landedUrl));

    ctx.writeJson("actions", "graph.json", explored.graph);

    const executed = explored.actionResults.filter((r) => r.outcome === "EXECUTED").length;
    const skipped = explored.actionResults.length - executed;
    /*
     * 미실행 건수만 적으면 그만큼의 기능을 놓친 것처럼 읽힌다.
     * 실제로는 목록의 행마다 붙은 같은 버튼과, 화면을 다시 열 때마다 다시 세어진 것이
     * 대부분이다(실측: 511건이 기능 35종). 종 수를 같이 적어야 오해가 없다.
     */
    const skippedKinds = new Set(
      explored.actionResults.filter((r) => r.outcome !== "EXECUTED").map((r) => r.action.label.trim()),
    ).size;

    log(
      "info",
      `탐색 완료: 화면 ${explored.graph.nodes.length}개 · 액션 실행 ${executed}건 · ` +
        `미실행 ${skipped}건 (기능 ${skippedKinds}종, 상세는 리포트 §17)`,
    );
    for (const limit of explored.limits) log("warn", `탐색 제한: ${limit}`);

    // ── 쓰기 테스트 ───────────────────────────────────────────────────
    // 탐색이 끝난 뒤에만 돈다. 탐색 중에 데이터를 만들면 화면이 바뀌어
    // 상태 지문이 흔들리고 결정성이 깨진다.
    const crud = new CrudTester(session.page, ctx, collector, config, options.control ?? NO_CONTROL);
    const crudOutcome = await crud.run(explored.graph);

    const leftovers = crudOutcome.ledger.leftovers();
    if (leftovers.length > 0) {
      log("warn", `정리하지 못한 테스트 데이터 ${leftovers.length}건: ${leftovers.map((r) => r.marker).join(", ")}`);
    }

    // ── Issue 확정 (룰) ───────────────────────────────────────────────
    const judged = judge([...explored.candidates, ...crudOutcome.candidates], explored.graph);
    log(
      "info",
      `Issue 확정: 후보 ${judged.mergedFrom}건 → Issue ${judged.issues.length}건`,
    );

    // ── AI 보강 ───────────────────────────────────────────────────────
    // 탐색이 끝난 뒤에만 돈다. 여기서 무슨 일이 나도 위의 judged.issues는 그대로다.
    const enriched = await enrichWithAi({
      config,
      issues: judged.issues,
      explored,
      evidences: ctx.listEvidences(),
      makeProvider: options.createProvider ?? createProvider,
    });

    for (const issue of enriched.issues) {
      emit({ type: "issue:found", at: new Date().toISOString(), issue });
    }

    // ── 리포트 ────────────────────────────────────────────────────────
    const summary = buildSummary({
      runId: ctx.runId,
      config,
      startedAt,
      explored,
      issues: enriched.issues,
      ai: enriched,
      crud: crudOutcome.results,
      leftovers: leftovers.map((r) => `${r.marker} (${r.screen}) — ${r.cleanupError ?? "사유 미상"}`),
      stopped: options.control?.stopped ?? false,
    });

    const reportPath = ctx.writeReport(
      renderReport({
        summary,
        issues: enriched.issues,
        evidences: ctx.listEvidences(),
        aiSummary: enriched.summaryText,
        missingFeatures: enriched.missingFeatures,
        suspectedFalsePositives: enriched.suspectedFalsePositives,
      }),
    );
    const issuesPath = ctx.writeIssues({ schemaVersion: 1, summary, issues: enriched.issues });

    emit({
      type: "run:finished",
      at: new Date().toISOString(),
      summary,
      reportPath,
      issuesPath,
    });

    const c = summary.issueCounts;
    const stopped = options.control?.stopped ?? false;
    return {
      status: stopped ? "STOPPED" : "COMPLETED",
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
